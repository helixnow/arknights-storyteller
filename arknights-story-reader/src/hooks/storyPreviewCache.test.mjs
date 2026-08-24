import assert from "node:assert/strict";
import test from "node:test";

import {
  PREVIEW_FAILURE_TTL_MS,
  isPreviewCacheEntryExpired,
  isPreviewTaskCurrent,
  parsePreviewCacheEntry,
  previewCacheKey,
  previewCachePrefix,
  previewRequestKey,
} from "./storyPreviewCache.ts";

test("preview 持久缓存键绑定 schema、数据版本和完整剧情路径", () => {
  assert.equal(previewCachePrefix(7), "sp:v2:7:");
  assert.equal(
    previewCacheKey(7, "activities/act9d0/level_act9d0_01"),
    "sp:v2:7:activities/act9d0/level_act9d0_01"
  );
  assert.notEqual(previewCacheKey(7, "same"), previewCacheKey(8, "same"));
  assert.equal(previewRequestKey(8, "obt/main/a"), "8:obt/main/a");
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
