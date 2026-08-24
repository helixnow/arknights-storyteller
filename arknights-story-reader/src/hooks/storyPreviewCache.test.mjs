import assert from "node:assert/strict";
import test from "node:test";

import {
  PREVIEW_FAILURE_TTL_MS,
  PreviewLruCache,
  isPreviewCacheEntryExpired,
  isPreviewTaskCurrent,
  parsePreviewCacheEntry,
  previewCacheKey,
  previewCachePrefix,
  previewRequestKey,
  readPreviewStorageEntry,
} from "./storyPreviewCache.ts";

function memoryStorage(initial) {
  const values = new Map(Object.entries(initial));
  const removed = [];
  return {
    values,
    removed,
    storage: {
      getItem: (key) => values.get(key) ?? null,
      removeItem: (key) => {
        removed.push(key);
        values.delete(key);
      },
    },
  };
}

test("preview 持久缓存键绑定 schema、数据版本和完整剧情路径", () => {
  assert.equal(previewCachePrefix(7), "sp:v2:7:");
  assert.equal(
    previewCacheKey(7, "activities/act9d0/level_act9d0_01"),
    "sp:v2:7:activities/act9d0/level_act9d0_01"
  );
  assert.notEqual(previewCacheKey(7, "same"), previewCacheKey(8, "same"));
  assert.equal(previewRequestKey(8, "obt/main/a"), "8:obt/main/a");
});

test("MEMO 命中会续到 MRU，扩容时淘汰真正最久未使用项", () => {
  const memo = new PreviewLruCache(3, 1);
  memo.set("a", 1);
  memo.set("b", 2);
  memo.set("c", 3);
  assert.equal(memo.get("a"), 1);
  assert.deepEqual(memo.keys(), ["b", "c", "a"]);

  memo.set("d", 4);
  assert.equal(memo.get("b"), undefined);
  assert.deepEqual(memo.keys(), ["c", "a", "d"]);
});

test("MEMO 批量淘汰只移除 LRU 端，热命中与覆写都续期", () => {
  const memo = new PreviewLruCache(4, 2);
  memo.set("a", 1);
  memo.set("b", 2);
  memo.set("c", 3);
  memo.set("d", 4);
  memo.get("a");
  memo.set("d", 40);
  assert.deepEqual(memo.keys(), ["b", "c", "a", "d"]);

  memo.set("e", 5);
  assert.deepEqual(memo.keys(), ["a", "d", "e"]);
  assert.equal(memo.get("b"), undefined);
  assert.equal(memo.get("c"), undefined);
});

test("后端明确无图是永久缓存，不受失败 TTL 影响", () => {
  const entry = parsePreviewCacheEntry({ token: null });
  assert.deepEqual(entry, { token: null });
  assert.equal(isPreviewCacheEntryExpired(entry, Number.MAX_SAFE_INTEGER), false);
});

test("token 请求失败只在短 TTL 内命中", () => {
  const entry = parsePreviewCacheEntry({ token: null, failed: true, ts: 10_000 });
  assert.equal(isPreviewCacheEntryExpired(entry, 10_000), false);
  assert.equal(
    isPreviewCacheEntryExpired(entry, 10_000 + PREVIEW_FAILURE_TTL_MS - 1),
    false
  );
  assert.equal(
    isPreviewCacheEntryExpired(entry, 10_000 + PREVIEW_FAILURE_TTL_MS),
    true
  );
});

test("墙钟回拨立即让失败 preview 过期", () => {
  const entry = { token: null, failed: true, ts: 20_000 };
  assert.equal(isPreviewCacheEntryExpired(entry, 19_999), true);
});

test("读取过期 failed 持久缓存时立即删除", () => {
  const key = "sp:v2:1:story";
  const store = memoryStorage({
    [key]: JSON.stringify({ token: null, failed: true, ts: 10_000 }),
  });
  assert.equal(
    readPreviewStorageEntry(
      store.storage,
      key,
      10_000 + PREVIEW_FAILURE_TTL_MS
    ),
    null
  );
  assert.deepEqual(store.removed, [key]);
  assert.equal(store.values.has(key), false);
});

test("墙钟回拨导致过期时同样清掉持久 failed 条目", () => {
  const key = "sp:v2:1:rollback";
  const store = memoryStorage({
    [key]: JSON.stringify({ token: null, failed: true, ts: 20_000 }),
  });
  assert.equal(readPreviewStorageEntry(store.storage, key, 19_999), null);
  assert.deepEqual(store.removed, [key]);
});

test("有效 token 与明确无图命中不会误删", () => {
  const tokenKey = "sp:v2:1:token";
  const emptyKey = "sp:v2:1:empty";
  const store = memoryStorage({
    [tokenKey]: JSON.stringify({ token: { kind: "image", token: "avg_1" } }),
    [emptyKey]: JSON.stringify({ token: null }),
  });
  assert.deepEqual(readPreviewStorageEntry(store.storage, tokenKey, 999_999), {
    token: { kind: "image", token: "avg_1" },
  });
  assert.deepEqual(readPreviewStorageEntry(store.storage, emptyKey, 999_999), {
    token: null,
  });
  assert.deepEqual(store.removed, []);
});

test("损坏的持久 preview 条目被读取时顺手删除", () => {
  const key = "sp:v2:1:broken";
  const store = memoryStorage({ [key]: "{not-json" });
  assert.equal(readPreviewStorageEntry(store.storage, key, 30_000), null);
  assert.deepEqual(store.removed, [key]);
});

test("坏失败时间戳不会退化成永久空图", () => {
  for (const ts of [undefined, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.equal(
      isPreviewCacheEntryExpired({ token: null, failed: true, ts }, 30_000),
      true
    );
  }
});

test("持久 token 只接受 image/background 和非空 token", () => {
  assert.deepEqual(
    parsePreviewCacheEntry({ token: { kind: "image", token: "  avg_1  " } }),
    { token: { kind: "image", token: "avg_1" } }
  );
  assert.deepEqual(
    parsePreviewCacheEntry({ token: { kind: "background", token: "$bg_1" } }),
    { token: { kind: "background", token: "$bg_1" } }
  );
  assert.equal(parsePreviewCacheEntry({ token: { kind: "avatar", token: "char_1" } }), null);
  assert.equal(parsePreviewCacheEntry({ token: { kind: "image", token: " " } }), null);
});

test("无图条目不会被脏 failed 字段误判为失败", () => {
  assert.deepEqual(
    parsePreviewCacheEntry({ token: null, failed: "false", ts: "not-a-time" }),
    { token: null }
  );
});

test("换包后旧 preview 在途结果失去写缓存资格", () => {
  assert.equal(isPreviewTaskCurrent(4, 4), true);
  assert.equal(isPreviewTaskCurrent(4, 5), false);
});
