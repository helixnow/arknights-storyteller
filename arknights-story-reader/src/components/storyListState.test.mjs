import assert from "node:assert/strict";
import test from "node:test";

import {
  createVersionedRequestCache,
  isMissingStoryCatalogError,
  storySummaryKey,
} from "./storyListState.ts";

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((ok, fail) => {
    resolve = ok;
    reject = fail;
  });
  return { promise, resolve, reject };
}

test("目录缺失判定不把超时或普通 IPC 错误当成未安装", () => {
  assert.equal(isMissingStoryCatalogError("NOT_INSTALLED"), true);
  assert.equal(isMissingStoryCatalogError("No such file or directory"), true);
  assert.equal(isMissingStoryCatalogError("TIMEOUT"), false);
  assert.equal(isMissingStoryCatalogError("invoke channel closed"), false);
});

test("简介缓存键同时绑定 storyId 与 storyInfo 路径", () => {
  assert.equal(storySummaryKey({ storyId: "s1", storyInfo: "info/old" }), "s1|info/old");
  assert.equal(storySummaryKey({ storyId: "s1", storyInfo: "info/new" }), "s1|info/new");
  assert.equal(storySummaryKey({ storyId: "s1", storyInfo: null }), "s1|");
});

test("目录缓存合并同 key 的并发请求", async () => {
  const cache = createVersionedRequestCache(1000);
  const gate = deferred();
  let calls = 0;
  const load = () => {
    calls += 1;
    return gate.promise;
  };
  const first = cache.fetch("main", load);
  const second = cache.fetch("main", load);
  await Promise.resolve();
  assert.equal(calls, 1);
  gate.resolve("catalog");
  assert.equal(await first, "catalog");
  assert.equal(await second, "catalog");
});

test("目录缓存只在 TTL 内复用成功值", async () => {
  let now = 1000;
  const cache = createVersionedRequestCache(100, () => now);
  let calls = 0;
  const load = async () => `v${++calls}`;
  assert.equal(await cache.fetch("main", load), "v1");
  now = 1099;
  assert.equal(await cache.fetch("main", load), "v1");
  now = 1100;
  assert.equal(await cache.fetch("main", load), "v2");
});

test("墙钟回拨会让目录缓存失效", async () => {
  let now = 1000;
  const cache = createVersionedRequestCache(60_000, () => now);
  let calls = 0;
  const load = async () => ++calls;
  assert.equal(await cache.fetch("main", load), 1);
  now = 900;
  assert.equal(await cache.fetch("main", load), 2);
});

test("force 真正另起请求且旧请求迟到不能覆盖新缓存", async () => {
  const cache = createVersionedRequestCache(60_000);
  const oldGate = deferred();
  const newGate = deferred();
  let calls = 0;
  const load = () => (++calls === 1 ? oldGate.promise : newGate.promise);

  const oldRequest = cache.fetch("main", load);
  await Promise.resolve();
  const newRequest = cache.fetch("main", load, true);
  await Promise.resolve();
  assert.equal(calls, 2);

  newGate.resolve("new");
  assert.equal(await newRequest, "new");
  oldGate.resolve("old");
  assert.equal(await oldRequest, "old");

  assert.equal(
    await cache.fetch("main", async () => {
      throw new Error("不应重读");
    }),
    "new"
  );
});

test("换包 invalidate 后丢弃旧在途结果的缓存资格", async () => {
  const cache = createVersionedRequestCache(60_000);
  const oldGate = deferred();
  const oldRequest = cache.fetch("main", () => oldGate.promise);
  await Promise.resolve();
  cache.invalidate();
  oldGate.resolve("old-pack");
  assert.equal(await oldRequest, "old-pack");

  let freshCalls = 0;
  assert.equal(
    await cache.fetch("main", async () => {
      freshCalls += 1;
      return "new-pack";
    }),
    "new-pack"
  );
  assert.equal(freshCalls, 1);
});

test("失败请求释放在途归属，下一次可以自动重试", async () => {
  const cache = createVersionedRequestCache(60_000);
  let calls = 0;
  await assert.rejects(
    cache.fetch("memory", async () => {
      calls += 1;
      throw new Error("temporary");
    }),
    /temporary/
  );
  assert.equal(
    await cache.fetch("memory", async () => {
      calls += 1;
      return "recovered";
    }),
    "recovered"
  );
  assert.equal(calls, 2);
});
