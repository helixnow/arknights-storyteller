import { test } from "node:test";
import assert from "node:assert/strict";

import {
  getAssetHealthVersion,
  getAssetRecoveryAction,
  hasRecoverableCandidate,
  isAssetUrlDead,
  isStaleOfflineAssetError,
  markAssetUrlAlive,
  markAssetUrlDead,
  pickLiveCandidate,
  subscribeAssetHealth,
} from "./assetUrls.ts";

test("stale offline detection requires the same URL and an untrustworthy network epoch", () => {
  const url = "https://stale-a.invalid/a.png";
  assert.equal(isStaleOfflineAssetError({ url, version: 1, offline: true }, url, 1), true);
  assert.equal(isStaleOfflineAssetError({ url, version: 1, offline: false }, url, 2), true);
  assert.equal(isStaleOfflineAssetError({ url, version: 2, offline: false }, url, 2), false);
  assert.equal(
    isStaleOfflineAssetError(
      { url: "https://stale-a.invalid/other.png", version: 1, offline: true },
      url,
      2
    ),
    false
  );
  assert.equal(isStaleOfflineAssetError(null, url, 2), false);
});

test("recovery action keeps an event pending until the whole chain is stuck", () => {
  for (const stuck of [false, true]) {
    for (const pending of [false, true]) {
      assert.equal(getAssetRecoveryAction(7, 7, stuck, pending), "none");
    }
  }
  assert.equal(getAssetRecoveryAction(7, 8, false, false), "observe");
  assert.equal(getAssetRecoveryAction(7, 8, true, false), "observe");
  assert.equal(getAssetRecoveryAction(7, 8, false, true), "defer");
  assert.equal(getAssetRecoveryAction(7, 8, true, true), "retry");
});

test("a duplicate URL failure counts only once toward the host fuse", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: Date.now() });
  const host = "https://dedupe-fuse.invalid";
  const duplicate = `${host}/same.png`;
  for (let i = 0; i < 20; i += 1) markAssetUrlDead(duplicate);
  for (let i = 0; i < 6; i += 1) markAssetUrlDead(`${host}/${i}.png`);
  assert.equal(isAssetUrlDead(`${host}/fresh.png`), false, "只有 7 条唯一失败");
  markAssetUrlDead(`${host}/6.png`);
  assert.equal(isAssetUrlDead(`${host}/fresh.png`), true, "第 8 条唯一失败才熔断");
  // 每个用例消费掉自己创建的共享闹钟，避免模块级 fuse 状态污染后续断言。
  t.mock.timers.tick(30_051);
});

test("recovery scans the entire chain when a blocked candidate sits before the cursor", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: Date.now() });
  const blockedHost = "https://chain-head.invalid";
  for (let i = 0; i < 8; i += 1) markAssetUrlDead(`${blockedHost}/strike-${i}.png`);
  const blockedAtHead = `${blockedHost}/not-requested.png`;
  const permanentlyDeadTail = "/chain-tail/dead.png";
  markAssetUrlDead(permanentlyDeadTail);
  const chain = [blockedAtHead, permanentlyDeadTail];

  assert.equal(pickLiveCandidate(chain, chain.length), null);
  assert.equal(
    hasRecoverableCandidate(chain, chain.length),
    false,
    "末尾游标本身看不到链首"
  );
  assert.equal(
    hasRecoverableCandidate(chain),
    true,
    "stuck 后从链首检查才能留下 host 到期恢复机会"
  );
  t.mock.timers.tick(30_051);
});

test("first alive purges suspect URL failures and broadcasts exactly once", () => {
  const host = "https://first-alive.invalid";
  const suspectA = `${host}/a.png`;
  const suspectB = `${host}/b.png`;
  markAssetUrlDead(suspectA);
  markAssetUrlDead(suspectB);
  const before = getAssetHealthVersion();
  let notices = 0;
  const unsubscribe = subscribeAssetHealth(() => {
    notices += 1;
  });

  markAssetUrlAlive(`${host}/proof.png`);
  assert.equal(getAssetHealthVersion(), before + 1);
  assert.equal(notices, 1);
  assert.equal(isAssetUrlDead(suspectA), false);
  assert.equal(isAssetUrlDead(suspectB), false);

  markAssetUrlAlive(`${host}/another-proof.png`);
  assert.equal(getAssetHealthVersion(), before + 1);
  assert.equal(notices, 1);
  unsubscribe();
});

test("first alive only purges failures from its own host", () => {
  const hostA = "https://purge-a.invalid";
  const hostB = "https://purge-b.invalid";
  markAssetUrlDead(`${hostA}/missing.png`);
  markAssetUrlDead(`${hostB}/missing.png`);
  markAssetUrlAlive(`${hostA}/ok.png`);
  assert.equal(isAssetUrlDead(`${hostA}/missing.png`), false);
  assert.equal(isAssetUrlDead(`${hostB}/missing.png`), true);
});

test("first alive cancels the obsolete fuse-expiry wakeup", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: Date.now() });
  const host = "https://cancel-wake.invalid";
  let notices = 0;
  const unsubscribe = subscribeAssetHealth(() => {
    notices += 1;
  });
  for (let i = 0; i < 8; i += 1) markAssetUrlDead(`${host}/${i}.png`);
  assert.equal(isAssetUrlDead(`${host}/fresh.png`), true);

  markAssetUrlAlive(`${host}/proof.png`);
  assert.equal(notices, 1, "首次成功立即广播");
  assert.equal(isAssetUrlDead(`${host}/fresh.png`), false);
  t.mock.timers.tick(30_051);
  assert.equal(notices, 1, "已证明可达的 host 不应在旧到期点重复广播");
  unsubscribe();
});

test("in-flight failures during an open fuse do not extend its host backoff", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: Date.now() });
  const host = "https://inflight-fuse.invalid";
  const fresh = `${host}/fresh.png`;
  for (let i = 0; i < 8; i += 1) markAssetUrlDead(`${host}/strike-${i}.png`);
  t.mock.timers.tick(100);
  for (let i = 0; i < 24; i += 1) markAssetUrlDead(`${host}/inflight-${i}.png`);
  t.mock.timers.tick(29_951);
  assert.equal(isAssetUrlDead(fresh), false, "首次 30 秒窗口到点即解封");
});

test("a proven host records individual 404s but never fuses", () => {
  const host = "https://proven-host.invalid";
  markAssetUrlAlive(`${host}/proof.png`);
  for (let i = 0; i < 20; i += 1) markAssetUrlDead(`${host}/missing-${i}.png`);
  assert.equal(isAssetUrlDead(`${host}/missing-0.png`), true);
  assert.equal(isAssetUrlDead(`${host}/fresh.png`), false);
  assert.deepEqual(pickLiveCandidate([`${host}/missing-0.png`, `${host}/fresh.png`]), {
    url: `${host}/fresh.png`,
    index: 1,
  });
});

test("one throwing health subscriber cannot starve the remaining subscribers", () => {
  const host = "https://subscriber-isolation.invalid";
  let observed = 0;
  const offThrowing = subscribeAssetHealth(() => {
    throw new Error("subscriber failed");
  });
  const offHealthy = subscribeAssetHealth(() => {
    observed += 1;
  });
  markAssetUrlAlive(`${host}/proof.png`);
  assert.equal(observed, 1);
  offThrowing();
  offHealthy();
});

test("dead URL capacity evicts old entries and retains the newest batch", () => {
  // 本文件前面的用例也留下了少量 URL 级记录，不能假设本测试从 size=0
  // 开始。多跨过一个淘汰周期后只断言真正的契约：最老消失、最新保留。
  for (let i = 0; i <= 10_000; i += 1) markAssetUrlDead(`/recovery-evict/${i}.png`);
  assert.equal(isAssetUrlDead("/recovery-evict/0.png"), false);
  assert.equal(isAssetUrlDead("/recovery-evict/10000.png"), true);
});
