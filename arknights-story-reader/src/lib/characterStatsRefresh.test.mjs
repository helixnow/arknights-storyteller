import { test } from "node:test";
import assert from "node:assert/strict";

import {
  characterStatsIpcShouldYield,
  isCharacterStatsEpochCurrent,
  planCharacterStatsDataUpdate,
  waitWhileCharacterStatsYields,
} from "./characterStatsRefresh.ts";

test("不可见 + 在途：更新必须同时推进 epoch、排 force、延迟到可见", () => {
  assert.deepEqual(planCharacterStatsDataUpdate(12, true, false), {
    nextEpoch: 13,
    queueForcedRefresh: true,
    deferUntilVisible: true,
  });
});

test("不可见 + 空闲：仍推进 epoch，但不制造重复扫描", () => {
  assert.deepEqual(planCharacterStatsDataUpdate(4, false, false), {
    nextEpoch: 5,
    queueForcedRefresh: false,
    deferUntilVisible: true,
  });
});

test("可见 + 在途：同样排 force，不因 active 分支丢更新", () => {
  assert.deepEqual(planCharacterStatsDataUpdate(8, true, true), {
    nextEpoch: 9,
    queueForcedRefresh: true,
    deferUntilVisible: false,
  });
});

test("旧扫描在数据更新推进 epoch 后失去发布和落盘资格", () => {
  const runEpoch = 21;
  const refresh = planCharacterStatsDataUpdate(runEpoch, true, false);
  assert.equal(isCharacterStatsEpochCurrent(runEpoch, runEpoch), true);
  assert.equal(isCharacterStatsEpochCurrent(runEpoch, refresh.nextEpoch), false);
});

test("人物扫描：面板不可见且代际仍有效时必须让出 IPC", () => {
  assert.equal(characterStatsIpcShouldYield(false, true), true);
  assert.equal(characterStatsIpcShouldYield(true, true), false);
  assert.equal(characterStatsIpcShouldYield(false, false), false);
});

test("人物扫描：让出期间不推进任务，切回或代际失效后结束等待", async () => {
  let active = false;
  let current = true;
  const waits = [];
  const pending = waitWhileCharacterStatsYields({
    isActive: () => active,
    isCurrent: () => current,
    intervalMs: 10,
    sleep: (ms) => {
      waits.push(ms);
      active = waits.length >= 2;
      return Promise.resolve();
    },
  });
  assert.equal(await pending, true);
  assert.equal(waits.length >= 2, true);

  current = false;
  active = false;
  assert.equal(
    await waitWhileCharacterStatsYields({
      isActive: () => active,
      isCurrent: () => current,
      sleep: () => Promise.resolve(),
    }),
    false
  );
});

test("连续更新单调推进 epoch，最早扫描不能跨过任一数据包边界", () => {
  const first = planCharacterStatsDataUpdate(30, true, false);
  const second = planCharacterStatsDataUpdate(first.nextEpoch, true, false);
  assert.equal(second.nextEpoch, 32);
  assert.equal(isCharacterStatsEpochCurrent(30, second.nextEpoch), false);
  assert.equal(isCharacterStatsEpochCurrent(31, second.nextEpoch), false);
  assert.equal(isCharacterStatsEpochCurrent(32, second.nextEpoch), true);
});
