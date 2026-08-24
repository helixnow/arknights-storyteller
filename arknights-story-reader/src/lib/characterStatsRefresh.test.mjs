import { test } from "node:test";
import assert from "node:assert/strict";

import {
  isCharacterStatsEpochCurrent,
  planCharacterStatsDataUpdate,
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

test("连续更新单调推进 epoch，最早扫描不能跨过任一数据包边界", () => {
  const first = planCharacterStatsDataUpdate(30, true, false);
  const second = planCharacterStatsDataUpdate(first.nextEpoch, true, false);
  assert.equal(second.nextEpoch, 32);
  assert.equal(isCharacterStatsEpochCurrent(30, second.nextEpoch), false);
  assert.equal(isCharacterStatsEpochCurrent(31, second.nextEpoch), false);
  assert.equal(isCharacterStatsEpochCurrent(32, second.nextEpoch), true);
});
