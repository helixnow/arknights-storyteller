import { test } from "node:test";
import assert from "node:assert/strict";

import {
  HISTORY_BACK_WATCHDOG_MS,
  INITIAL_HISTORY_GUARD_STATE,
  READER_RETENTION_MS,
  createBackDispatcher,
  createHistoryBackWatchdog,
  reduceHistoryGuard,
} from "../lib/appShellLogic.ts";

const OVERLAY = 30;

function backEntry(name, priority, seq, handler, calls) {
  return {
    priority,
    seq,
    consumed: false,
    handler: () => {
      calls.push(name);
      return handler();
    },
  };
}

function dispatcher(entries, options = {}) {
  return createBackDispatcher({
    getEntries: () => entries,
    overlayPriority: OVERLAY,
    dismissFallback: options.dismissFallback,
    onError: options.onError,
  });
}

test("useBackHandler：按 overlay > view > tab 优先级询问", () => {
  const calls = [];
  const entries = [
    backEntry("tab", 10, 3, () => true, calls),
    backEntry("view", 20, 2, () => true, calls),
    backEntry("overlay", 30, 1, () => true, calls),
  ];
  assert.equal(dispatcher(entries)(), true);
  assert.deepEqual(calls, ["overlay"]);
});

test("useBackHandler：同优先级按注册序 LIFO", () => {
  const calls = [];
  const entries = [
    backEntry("older", OVERLAY, 1, () => true, calls),
    backEntry("newer", OVERLAY, 2, () => true, calls),
  ];
  assert.equal(dispatcher(entries)(), true);
  assert.deepEqual(calls, ["newer"]);
});

test("useBackHandler：未注册 modal fallback 位于 overlay 与 view 之间", () => {
  const calls = [];
  const entries = [
    backEntry("overlay", OVERLAY, 1, () => false, calls),
    backEntry("view", 20, 2, () => true, calls),
  ];
  const request = dispatcher(entries, {
    dismissFallback: () => {
      calls.push("fallback");
      return true;
    },
  });
  assert.equal(request(), true);
  assert.deepEqual(calls, ["overlay", "fallback"]);
});

test("useBackHandler：minPriority 不询问更低层也不误触 fallback", () => {
  const calls = [];
  const entries = [
    backEntry("overlay", OVERLAY, 1, () => true, calls),
    backEntry("view", 20, 2, () => true, calls),
  ];
  const request = dispatcher(entries, {
    dismissFallback: () => {
      calls.push("fallback");
      return true;
    },
  });
  assert.equal(request(OVERLAY + 1), false);
  assert.deepEqual(calls, []);
});

test("useBackHandler：消费项同步退休，连按依次落到下一层而非被旧 overlay 吞掉", () => {
  const calls = [];
  const entries = [
    backEntry("view", 20, 1, () => true, calls),
    backEntry("overlay", OVERLAY, 2, () => true, calls),
  ];
  const request = dispatcher(entries);

  assert.equal(request(), true);
  assert.equal(entries[1].consumed, true);
  // 模拟 React passive effect 尚未注销 overlay 的第二次硬件返回。
  assert.equal(request(), true);
  assert.equal(entries[0].consumed, true);
  assert.equal(request(), false);
  assert.deepEqual(calls, ["overlay", "view"]);
});

test("useBackHandler：快照后被同步注销的 entry 不再执行", () => {
  const calls = [];
  const entries = [];
  const lower = backEntry("lower", 20, 1, () => true, calls);
  const overlay = backEntry(
    "overlay",
    OVERLAY,
    2,
    () => {
      entries.splice(entries.indexOf(lower), 1);
      return false;
    },
    calls
  );
  entries.push(lower, overlay);

  assert.equal(dispatcher(entries)(), false);
  assert.deepEqual(calls, ["overlay"]);
});

test("useBackHandler：handler 抛错后继续下一层且不会卡住 dispatching", () => {
  const calls = [];
  const errors = [];
  const entries = [
    backEntry("view", 20, 1, () => true, calls),
    backEntry(
      "overlay",
      OVERLAY,
      2,
      () => {
        throw new Error("boom");
      },
      calls
    ),
  ];
  const request = dispatcher(entries, { onError: (error) => errors.push(error) });

  assert.equal(request(), true);
  assert.deepEqual(calls, ["overlay", "view"]);
  assert.equal(errors.length, 1);
  // view 已退休、overlay 仍可被问；再次抛错后 dispatcher 必须正常返回。
  assert.equal(request(), false);
  assert.equal(errors.length, 2);
});

test("useBackHandler：dispatching 期间重入立即返回 false，不连锁关闭下一层", () => {
  const calls = [];
  const nestedResults = [];
  const entries = [];
  let request;
  entries.push(
    backEntry(
      "overlay",
      OVERLAY,
      1,
      () => {
        nestedResults.push(request());
        return true;
      },
      calls
    )
  );
  request = dispatcher(entries);

  assert.equal(request(), true);
  assert.deepEqual(nestedResults, [false]);
  assert.deepEqual(calls, ["overlay"]);
});

test("useBackHandler：返回 false 的 handler 不退休，后续返回仍可重试", () => {
  const calls = [];
  const entries = [backEntry("busy-overlay", OVERLAY, 1, () => false, calls)];
  const request = dispatcher(entries);
  assert.equal(request(), false);
  assert.equal(request(), false);
  assert.equal(entries[0].consumed, false);
  assert.deepEqual(calls, ["busy-overlay", "busy-overlay"]);
});

test("useBackHandler：最后一层消费后哨兵不重装，首页下一次返回可退出", () => {
  const armed = reduceHistoryGuard(
    { ...INITIAL_HISTORY_GUARD_STATE },
    { type: "handlers-changed", hasHandlers: true }
  );
  assert.deepEqual(armed.effects, ["push-guard"]);
  const popped = reduceHistoryGuard(armed.state, {
    type: "popstate",
    hasHandlers: true,
  });
  assert.deepEqual(popped.effects, ["dispatch-back"]);
  const finished = reduceHistoryGuard(popped.state, {
    type: "back-dispatched",
    consumed: true,
    hasHandlers: false,
  });
  assert.equal(finished.state.phase, "idle");
  assert.deepEqual(finished.effects, []);
});

test("useBackHandler：history.back 无 popstate 时 250ms watchdog 释放 continuing", () => {
  const timers = new Map();
  let nextTimer = 1;
  let state = { phase: "continuing", rearmAfterNavigation: true };
  const watchdog = createHistoryBackWatchdog({
    setTimer: (callback, delay) => {
      assert.equal(delay, HISTORY_BACK_WATCHDOG_MS);
      const id = nextTimer++;
      timers.set(id, callback);
      return id;
    },
    clearTimer: (id) => timers.delete(id),
    onTimeout: () => {
      state = reduceHistoryGuard(state, { type: "history-back-failed" }).state;
    },
  });

  watchdog.arm();
  assert.equal(watchdog.isArmed(), true);
  assert.equal(timers.size, 1);
  const callback = timers.values().next().value;
  callback();
  assert.equal(watchdog.isArmed(), false);
  assert.equal(state.phase, "idle");
});

test("useBackHandler：popstate 及时取消 history.back watchdog", () => {
  const timers = new Map();
  let timedOut = 0;
  const watchdog = createHistoryBackWatchdog({
    setTimer: (callback) => {
      timers.set(1, callback);
      return 1;
    },
    clearTimer: (id) => timers.delete(id),
    onTimeout: () => {
      timedOut += 1;
    },
  });

  watchdog.arm();
  watchdog.cancel(); // popstate listener 的行为
  assert.equal(watchdog.isArmed(), false);
  assert.equal(timers.size, 0);
  assert.equal(timedOut, 0);
});

test("App reader retention：隐藏实例 TTL 与五分钟预取窗口一致", () => {
  assert.equal(READER_RETENTION_MS, 300_000);
});
