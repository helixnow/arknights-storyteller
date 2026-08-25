/**
 * Application-shell regression tests (node:test, no DOM shim required).
 *
 * The browser-facing components delegate their race-prone decisions to
 * appShellLogic.ts; these tests cover corrupt storage/migration, cross-window
 * hydration semantics, urgent toast queueing, transform-free nav geometry,
 * history-sentinel races, and monotonic cleanup planning.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_APP_PREFS,
  INITIAL_HISTORY_GUARD_STATE,
  calculateBottomNavInset,
  cleanupVersionFrom,
  collectOverflowScrollSnapshots,
  enqueueToast,
  hasPreservableOverflow,
  hydrateAppPrefs,
  keepAliveContentVisibility,
  normalizeAppPrefs,
  parseAppPrefs,
  parseLegacyAppPrefs,
  pendingCleanupKeys,
  reduceHistoryGuard,
  restoreOverflowScrollSnapshots,
  applyInstantScroll,
} from "./appShellLogic.ts";

const CURRENT_KEY = "prefs-v2";
const LEGACY_KEY = "prefs-v1";
const URGENT = new Set(["warning", "error"]);

class MemoryStorage {
  constructor(entries = {}) {
    this.map = new Map(Object.entries(entries));
    this.getFailures = new Set();
    this.setFailures = new Set();
    this.removeFailures = new Set();
    this.operations = [];
  }

  getItem(key) {
    this.operations.push(["get", key]);
    if (this.getFailures.has(key)) throw new Error(`get ${key}`);
    return this.map.get(key) ?? null;
  }

  setItem(key, value) {
    this.operations.push(["set", key, value]);
    if (this.setFailures.has(key)) throw new Error(`set ${key}`);
    this.map.set(key, value);
  }

  removeItem(key) {
    this.operations.push(["remove", key]);
    if (this.removeFailures.has(key)) throw new Error(`remove ${key}`);
    this.map.delete(key);
  }
}

function prefs(overrides = {}) {
  return { ...DEFAULT_APP_PREFS, ...overrides };
}

function transition(state, event, expectedEffects) {
  const next = reduceHistoryGuard(state, event);
  assert.deepEqual(next.effects, expectedEffects);
  return next.state;
}

// ─────────────────────────────────────────────────────────────
// Preference decoding and migration
// ─────────────────────────────────────────────────────────────

test("normalizeAppPrefs：空值回落到完整默认值", () => {
  assert.deepEqual(normalizeAppPrefs(null), prefs());
  assert.deepEqual(normalizeAppPrefs(undefined), prefs());
});

test("normalizeAppPrefs：只接受真正的 boolean，不把字符串/数字当开关", () => {
  assert.deepEqual(
    normalizeAppPrefs({
      showSummaries: "true",
      minimalMode: 1,
      inlineImages: false,
    }),
    prefs({ inlineImages: false })
  );
});

test("normalizeAppPrefs：数组不是合法 preference record", () => {
  assert.deepEqual(normalizeAppPrefs([true, true, false]), prefs());
});

test("parseAppPrefs：null 明确表示 key 不存在", () => {
  assert.deepEqual(parseAppPrefs(null), { status: "missing" });
});

test("parseAppPrefs：坏 JSON 与非对象 JSON 都判 invalid", () => {
  assert.deepEqual(parseAppPrefs("{oops"), { status: "invalid" });
  assert.deepEqual(parseAppPrefs("true"), { status: "invalid" });
  assert.deepEqual(parseAppPrefs("[]"), { status: "invalid" });
});

test("parseAppPrefs：部分对象补默认字段", () => {
  assert.deepEqual(parseAppPrefs('{"minimalMode":true}'), {
    status: "valid",
    prefs: prefs({ minimalMode: true }),
  });
});

test("parseLegacyAppPrefs：只迁移 v1 的 showSummaries", () => {
  assert.deepEqual(parseLegacyAppPrefs('{"showSummaries":true,"ignored":1}'), {
    status: "valid",
    prefs: prefs({ showSummaries: true }),
  });
});

test("parseLegacyAppPrefs：缺字段、错类型与坏 JSON 不冒充可迁移数据", () => {
  assert.deepEqual(parseLegacyAppPrefs("{}"), { status: "invalid" });
  assert.deepEqual(parseLegacyAppPrefs('{"showSummaries":"true"}'), { status: "invalid" });
  assert.deepEqual(parseLegacyAppPrefs("{"), { status: "invalid" });
});

test("hydrateAppPrefs：有效 v2 权威，且清掉不会再用的旧 v1", () => {
  const storage = new MemoryStorage({
    [CURRENT_KEY]: JSON.stringify(prefs({ minimalMode: true })),
    [LEGACY_KEY]: JSON.stringify({ showSummaries: true }),
  });
  const result = hydrateAppPrefs(storage, CURRENT_KEY, LEGACY_KEY);
  assert.equal(result.readable, true);
  assert.equal(result.source, "current");
  assert.deepEqual(result.prefs, prefs({ minimalMode: true }));
  assert.equal(storage.map.has(LEGACY_KEY), false);
});

test("hydrateAppPrefs：v2 脏字段按字段修复，不整份丢弃", () => {
  const storage = new MemoryStorage({
    [CURRENT_KEY]: '{"showSummaries":true,"minimalMode":"bad","inlineImages":false}',
  });
  const result = hydrateAppPrefs(storage, CURRENT_KEY, LEGACY_KEY);
  assert.deepEqual(
    result.prefs,
    prefs({ showSummaries: true, minimalMode: false, inlineImages: false })
  );
});

test("hydrateAppPrefs：两个 key 都缺失时返回默认但不擅自写盘", () => {
  const storage = new MemoryStorage();
  const result = hydrateAppPrefs(storage, CURRENT_KEY, LEGACY_KEY);
  assert.equal(result.source, "default");
  assert.deepEqual(result.prefs, prefs());
  assert.equal(storage.operations.some(([op]) => op === "set"), false);
});

test("hydrateAppPrefs：坏 v2 能从有效 v1 恢复并原子升级", () => {
  const storage = new MemoryStorage({
    [CURRENT_KEY]: "{broken",
    [LEGACY_KEY]: '{"showSummaries":true}',
  });
  const result = hydrateAppPrefs(storage, CURRENT_KEY, LEGACY_KEY);
  assert.equal(result.source, "legacy");
  assert.equal(result.currentCorrupt, true);
  assert.deepEqual(result.prefs, prefs({ showSummaries: true }));
  assert.deepEqual(JSON.parse(storage.map.get(CURRENT_KEY)), prefs({ showSummaries: true }));
  assert.equal(storage.map.has(LEGACY_KEY), false);
});

test("hydrateAppPrefs：缺 v2 时升级 v1 并补齐新增字段", () => {
  const storage = new MemoryStorage({
    [LEGACY_KEY]: '{"showSummaries":false}',
  });
  const result = hydrateAppPrefs(storage, CURRENT_KEY, LEGACY_KEY);
  assert.equal(result.source, "legacy");
  assert.deepEqual(JSON.parse(storage.map.get(CURRENT_KEY)), prefs());
});

test("hydrateAppPrefs：v2 回写失败时绝不删除唯一的 v1 好副本", () => {
  const storage = new MemoryStorage({
    [LEGACY_KEY]: '{"showSummaries":true}',
  });
  storage.setFailures.add(CURRENT_KEY);
  const result = hydrateAppPrefs(storage, CURRENT_KEY, LEGACY_KEY);
  assert.equal(result.source, "legacy");
  assert.equal(storage.map.has(LEGACY_KEY), true);
  assert.deepEqual(result.prefs, prefs({ showSummaries: true }));
});

test("hydrateAppPrefs：v2 已写成后即使删 v1 失败也不丢迁移值", () => {
  const storage = new MemoryStorage({
    [LEGACY_KEY]: '{"showSummaries":true}',
  });
  storage.removeFailures.add(LEGACY_KEY);
  const result = hydrateAppPrefs(storage, CURRENT_KEY, LEGACY_KEY);
  assert.equal(result.source, "legacy");
  assert.deepEqual(JSON.parse(storage.map.get(CURRENT_KEY)), prefs({ showSummaries: true }));
  assert.equal(storage.map.has(LEGACY_KEY), true);
});

test("hydrateAppPrefs：当前 key 读取失败会标记 unreadable，供跨窗口保留现状", () => {
  const storage = new MemoryStorage();
  storage.getFailures.add(CURRENT_KEY);
  const result = hydrateAppPrefs(storage, CURRENT_KEY, LEGACY_KEY);
  assert.equal(result.readable, false);
  assert.equal(result.source, "default");
});

test("hydrateAppPrefs：v2 无效且 v1 读取失败同样不可假装用户清空", () => {
  const storage = new MemoryStorage({ [CURRENT_KEY]: "{bad" });
  storage.getFailures.add(LEGACY_KEY);
  const result = hydrateAppPrefs(storage, CURRENT_KEY, LEGACY_KEY);
  assert.equal(result.readable, false);
  assert.equal(result.currentCorrupt, true);
});

test("hydrateAppPrefs：坏 v2 又无备份时保留原文，不用默认值覆盖恢复现场", () => {
  const storage = new MemoryStorage({ [CURRENT_KEY]: "{bad" });
  const result = hydrateAppPrefs(storage, CURRENT_KEY, LEGACY_KEY);
  assert.equal(result.source, "default");
  assert.equal(result.currentCorrupt, true);
  assert.equal(storage.map.get(CURRENT_KEY), "{bad");
  assert.equal(storage.operations.some(([op]) => op === "set"), false);
});

test("hydrateAppPrefs：有效 v2 下清理 v1 失败不影响读取结果", () => {
  const storage = new MemoryStorage({
    [CURRENT_KEY]: JSON.stringify(prefs({ inlineImages: false })),
    [LEGACY_KEY]: '{"showSummaries":true}',
  });
  storage.removeFailures.add(LEGACY_KEY);
  const result = hydrateAppPrefs(storage, CURRENT_KEY, LEGACY_KEY);
  assert.equal(result.readable, true);
  assert.deepEqual(result.prefs, prefs({ inlineImages: false }));
});

// ─────────────────────────────────────────────────────────────
// Toast queue admission
// ─────────────────────────────────────────────────────────────

test("enqueueToast：有空位时按 FIFO 追加且不修改原数组", () => {
  const original = [{ id: 1, kind: "default" }];
  const next = enqueueToast(original, { id: 2, kind: "success" }, 3, URGENT);
  assert.deepEqual(next.map((item) => item.id), [1, 2]);
  assert.deepEqual(original.map((item) => item.id), [1]);
});

test("enqueueToast：可见位满时丢弃新的普通提示，不制造迟到消息", () => {
  const queue = [
    { id: 1, kind: "default" },
    { id: 2, kind: "success" },
    { id: 3, kind: "error" },
  ];
  assert.deepEqual(
    enqueueToast(queue, { id: 4, kind: "default" }, 3, URGENT),
    queue
  );
});

test("enqueueToast：新错误只挤最老的可见普通提示", () => {
  const queue = [
    { id: 1, kind: "default" },
    { id: 2, kind: "success" },
    { id: 3, kind: "error" },
  ];
  const next = enqueueToast(queue, { id: 4, kind: "error" }, 3, URGENT);
  assert.deepEqual(next.map((item) => item.id), [2, 3, 4]);
});

test("enqueueToast：搜索淘汰位只看可见窗口，不删除队尾未读错误", () => {
  const queue = [
    { id: 1, kind: "default" },
    { id: 2, kind: "error" },
    { id: 3, kind: "error" },
    { id: 4, kind: "error" },
  ];
  const next = enqueueToast(queue, { id: 5, kind: "warning" }, 3, URGENT);
  assert.deepEqual(next.map((item) => item.id), [2, 3, 4, 5]);
});

test("enqueueToast：三个可见紧急提示占满时，新错误排队不挤未读", () => {
  const queue = [
    { id: 1, kind: "error" },
    { id: 2, kind: "warning" },
    { id: 3, kind: "error" },
  ];
  const next = enqueueToast(queue, { id: 4, kind: "error" }, 3, URGENT);
  assert.deepEqual(next.map((item) => item.id), [1, 2, 3, 4]);
});

test("enqueueToast：已有排队错误保持在新错误前面", () => {
  const queue = [
    { id: 1, kind: "error" },
    { id: 2, kind: "warning" },
    { id: 3, kind: "error" },
    { id: 4, kind: "warning" },
  ];
  const next = enqueueToast(queue, { id: 5, kind: "error" }, 3, URGENT);
  assert.deepEqual(next.map((item) => item.id), [1, 2, 3, 4, 5]);
});

test("enqueueToast：warning 与 error 使用同一紧急队列规则", () => {
  const queue = [
    { id: 1, kind: "success" },
    { id: 2, kind: "error" },
    { id: 3, kind: "warning" },
  ];
  const next = enqueueToast(queue, { id: 4, kind: "warning" }, 3, URGENT);
  assert.deepEqual(next.map((item) => item.id), [2, 3, 4]);
});

test("enqueueToast：零/负可见容量不积累永远展示不了的队列", () => {
  assert.deepEqual(enqueueToast([], { id: 1, kind: "error" }, 0, URGENT), []);
  assert.deepEqual(enqueueToast([], { id: 1, kind: "error" }, -3, URGENT), []);
});

test("enqueueToast：小数容量向下取整，行为保持确定", () => {
  const next = enqueueToast(
    [{ id: 1, kind: "error" }, { id: 2, kind: "warning" }],
    { id: 3, kind: "error" },
    2.9,
    URGENT
  );
  assert.deepEqual(next.map((item) => item.id), [1, 2, 3]);
});

// ─────────────────────────────────────────────────────────────
// Bottom-nav layout geometry
// ─────────────────────────────────────────────────────────────

test("calculateBottomNavInset：只合计布局高度与 computed bottom", () => {
  assert.equal(calculateBottomNavInset(64, 8), 72);
});

test("calculateBottomNavInset：高 DPI 小数向上取整，绝不低报遮挡", () => {
  assert.equal(calculateBottomNavInset(63.2, 8.1), 72);
});

test("calculateBottomNavInset：无效 computed 值安全回落到 0", () => {
  assert.equal(calculateBottomNavInset(64, Number.NaN), 64);
  assert.equal(calculateBottomNavInset(Number.POSITIVE_INFINITY, 8), 8);
});

test("calculateBottomNavInset：异常负总量钳到 0", () => {
  assert.equal(calculateBottomNavInset(4, -8), 0);
});

// ─────────────────────────────────────────────────────────────
// Browser history sentinel state machine
// ─────────────────────────────────────────────────────────────

test("history guard：第一个处理器出现才 push 哨兵", () => {
  const state = transition(
    { ...INITIAL_HISTORY_GUARD_STATE },
    { type: "handlers-changed", hasHandlers: true },
    ["push-guard"]
  );
  assert.equal(state.phase, "armed");
});

test("history guard：首页无处理器保持 idle，不污染历史", () => {
  const state = transition(
    { ...INITIAL_HISTORY_GUARD_STATE },
    { type: "handlers-changed", hasHandlers: false },
    []
  );
  assert.equal(state.phase, "idle");
});

test("history guard：最后一个处理器消失时主动 back 弹哨兵", () => {
  const state = transition(
    { phase: "armed", rearmAfterNavigation: false },
    { type: "handlers-changed", hasHandlers: false },
    ["history-back"]
  );
  assert.equal(state.phase, "disarming");
});

test("history guard：disarm 回声无新处理器时落回纯净首页", () => {
  const state = transition(
    { phase: "disarming", rearmAfterNavigation: false },
    { type: "popstate", hasHandlers: false },
    []
  );
  assert.equal(state.phase, "idle");
});

test("history guard：React 同提交零处理器窗口会记住随后注册的 tab handler", () => {
  const state = transition(
    { phase: "disarming", rearmAfterNavigation: false },
    { type: "handlers-changed", hasHandlers: true },
    []
  );
  assert.equal(state.phase, "disarming");
  assert.equal(state.rearmAfterNavigation, true);
  const rearmed = transition(state, { type: "popstate", hasHandlers: true }, ["push-guard"]);
  assert.equal(rearmed.phase, "armed");
});

test("history guard：用户弹哨兵时只产生一次应用返回派发", () => {
  const state = transition(
    { phase: "armed", rearmAfterNavigation: false },
    { type: "popstate", hasHandlers: true },
    ["dispatch-back"]
  );
  assert.equal(state.phase, "idle");
});

test("history guard：应用消费返回后有下层 handler 才重新布防", () => {
  const state = transition(
    { phase: "idle", rearmAfterNavigation: false },
    { type: "back-dispatched", consumed: true, hasHandlers: true },
    ["push-guard"]
  );
  assert.equal(state.phase, "armed");
});

test("history guard：消费后已回首页则不补哨兵", () => {
  const state = transition(
    { phase: "idle", rearmAfterNavigation: false },
    { type: "back-dispatched", consumed: true, hasHandlers: false },
    []
  );
  assert.equal(state.phase, "idle");
});

test("history guard：handler 返回 false/抛错后继续原 history.back，不吞退出", () => {
  const state = transition(
    { phase: "idle", rearmAfterNavigation: false },
    { type: "back-dispatched", consumed: false, hasHandlers: true },
    ["history-back"]
  );
  assert.equal(state.phase, "continuing");
});

test("history guard：continuation 自己的 popstate 不会再关一层 UI", () => {
  const state = transition(
    { phase: "continuing", rearmAfterNavigation: false },
    { type: "popstate", hasHandlers: false },
    []
  );
  assert.equal(state.phase, "idle");
});

test("history guard：同文档 continuation 后仍有 handler 时重新布防", () => {
  const state = transition(
    { phase: "continuing", rearmAfterNavigation: true },
    { type: "popstate", hasHandlers: true },
    ["push-guard"]
  );
  assert.equal(state.phase, "armed");
});

test("history guard：pushState 失败回 idle，交还浏览器默认行为", () => {
  const state = transition(
    { phase: "armed", rearmAfterNavigation: false },
    { type: "push-failed" },
    []
  );
  assert.equal(state.phase, "idle");
});

test("history guard：主动 disarm 的 history.back 失败时仍承认哨兵存在", () => {
  const state = transition(
    { phase: "disarming", rearmAfterNavigation: false },
    { type: "history-back-failed" },
    []
  );
  assert.equal(state.phase, "armed");
});

test("history guard：默认导航 back 失败时不凭空声称有哨兵", () => {
  const state = transition(
    { phase: "continuing", rearmAfterNavigation: true },
    { type: "history-back-failed" },
    []
  );
  assert.equal(state.phase, "idle");
});

test("history guard：阅读器→非首页 tab 的 effect 交接保持单层哨兵", () => {
  let state = transition(
    { ...INITIAL_HISTORY_GUARD_STATE },
    { type: "handlers-changed", hasHandlers: true },
    ["push-guard"]
  );
  state = transition(state, { type: "popstate", hasHandlers: true }, ["dispatch-back"]);
  state = transition(
    state,
    { type: "back-dispatched", consumed: true, hasHandlers: true },
    ["push-guard"]
  );
  state = transition(state, { type: "handlers-changed", hasHandlers: false }, ["history-back"]);
  state = transition(state, { type: "handlers-changed", hasHandlers: true }, []);
  state = transition(state, { type: "popstate", hasHandlers: true }, ["push-guard"]);
  assert.equal(state.phase, "armed");
  assert.equal(state.rearmAfterNavigation, false);
});

test("history guard：非首页 tab→首页 完成后没有退出哨兵", () => {
  let state = transition(
    { phase: "armed", rearmAfterNavigation: false },
    { type: "popstate", hasHandlers: true },
    ["dispatch-back"]
  );
  state = transition(
    state,
    { type: "back-dispatched", consumed: true, hasHandlers: true },
    ["push-guard"]
  );
  state = transition(state, { type: "handlers-changed", hasHandlers: false }, ["history-back"]);
  state = transition(state, { type: "popstate", hasHandlers: false }, []);
  assert.equal(state.phase, "idle");
});

// ─────────────────────────────────────────────────────────────
// Legacy cleanup planning
// ─────────────────────────────────────────────────────────────

test("cleanupVersionFrom：合法正整数保留", () => {
  assert.equal(cleanupVersionFrom("4"), 4);
  assert.equal(cleanupVersionFrom("0007"), 7);
});

test("cleanupVersionFrom：坏值、负数、小数前缀和溢出安全回 0", () => {
  assert.equal(cleanupVersionFrom(null), 0);
  assert.equal(cleanupVersionFrom("NaN"), 0);
  assert.equal(cleanupVersionFrom("-2"), 0);
  assert.equal(cleanupVersionFrom("1.5"), 0);
  assert.equal(cleanupVersionFrom("4junk"), 0);
  assert.equal(cleanupVersionFrom("9007199254740992"), 0);
});

test("pendingCleanupKeys：只列出尚未执行的升级步骤", () => {
  const steps = [
    { version: 1, keys: ["old-a"] },
    { version: 2, keys: ["old-b"] },
    { version: 3, keys: ["old-c"] },
  ];
  assert.deepEqual(pendingCleanupKeys(1, steps, "sentinel"), ["old-b", "old-c"]);
  assert.deepEqual(pendingCleanupKeys(3, steps, "sentinel"), []);
});

test("pendingCleanupKeys：永不删除 sentinel 自己", () => {
  const steps = [{ version: 1, keys: ["sentinel", "old-a"] }];
  assert.deepEqual(pendingCleanupKeys(0, steps, "sentinel"), ["old-a"]);
});

test("pendingCleanupKeys：跨步骤重复 key 只删一次且保持首次出现顺序", () => {
  const steps = [
    { version: 1, keys: ["a", "b"] },
    { version: 2, keys: ["b", "c", "a"] },
  ];
  assert.deepEqual(pendingCleanupKeys(0, steps, "sentinel"), ["a", "b", "c"]);
});

test("pendingCleanupKeys：未来版本 sentinel 不会被旧应用倒退重跑", () => {
  const steps = [
    { version: 1, keys: ["a"] },
    { version: 4, keys: ["d"] },
  ];
  assert.deepEqual(pendingCleanupKeys(99, steps, "sentinel"), []);
});

// ─────────────────────────────────────────────────────────────
// KeepAlive hidden-layer isolation
// ─────────────────────────────────────────────────────────────

test("keepAliveContentVisibility：后台面板必须 hidden，前台才 visible", () => {
  assert.equal(keepAliveContentVisibility(true), "visible");
  assert.equal(keepAliveContentVisibility(false), "hidden");
});

function scroller(values) {
  return {
    scrollTop: 0,
    scrollLeft: 0,
    scrollHeight: 100,
    scrollWidth: 100,
    clientHeight: 100,
    clientWidth: 100,
    ...values,
  };
}

test("hasPreservableOverflow：无溢出且未滚动的盒子可以跳过", () => {
  assert.equal(hasPreservableOverflow(scroller()), false);
});

test("hasPreservableOverflow：已滚动或可滚动的盒子都要记下来", () => {
  assert.equal(hasPreservableOverflow(scroller({ scrollTop: 40 })), true);
  assert.equal(hasPreservableOverflow(scroller({ scrollLeft: 12 })), true);
  assert.equal(hasPreservableOverflow(scroller({ scrollHeight: 400, clientHeight: 80 })), true);
});

test("collectOverflowScrollSnapshots：只收集真正有溢出的节点", () => {
  const idle = scroller();
  const moved = scroller({ scrollTop: 88, scrollHeight: 400, clientHeight: 80 });
  const snapshots = collectOverflowScrollSnapshots([idle, moved]);
  assert.equal(snapshots.length, 1);
  assert.equal(snapshots[0].el, moved);
  assert.equal(snapshots[0].top, 88);
});

test("restoreOverflowScrollSnapshots：跳过已卸载节点，其余原样灌回", () => {
  const live = scroller({ scrollTop: 0, scrollHeight: 400, clientHeight: 80 });
  const dead = scroller({ scrollTop: 0, scrollHeight: 400, clientHeight: 80 });
  restoreOverflowScrollSnapshots(
    [
      { el: live, top: 120, left: 6 },
      { el: dead, top: 50, left: 0 },
    ],
    (el) => el === live
  );
  assert.equal(live.scrollTop, 120);
  assert.equal(live.scrollLeft, 6);
  assert.equal(dead.scrollTop, 0);
});

test("applyInstantScroll：有 scrollTo 时用 auto，并暂时关掉 CSS smooth", () => {
  const calls = [];
  const el = {
    scrollTop: 10,
    scrollLeft: 2,
    style: { scrollBehavior: "smooth" },
    scrollTo(options) {
      calls.push({ ...options });
      this.scrollLeft = options.left;
      this.scrollTop = options.top;
    },
  };
  applyInstantScroll(el, 4, 80);
  assert.deepEqual(calls, [{ left: 4, top: 80, behavior: "auto" }]);
  assert.equal(el.scrollTop, 80);
  assert.equal(el.scrollLeft, 4);
  assert.equal(el.style.scrollBehavior, "smooth");
});

test("applyInstantScroll：没有 scrollTo 时直接写偏移，并恢复原 scroll-behavior", () => {
  const el = {
    scrollTop: 40,
    scrollLeft: 8,
    style: { scrollBehavior: "" },
  };
  applyInstantScroll(el, 1, 0);
  assert.equal(el.scrollTop, 0);
  assert.equal(el.scrollLeft, 1);
  assert.equal(el.style.scrollBehavior, "");
});
