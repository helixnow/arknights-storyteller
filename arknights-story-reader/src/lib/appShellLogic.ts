/**
 * Pure state helpers shared by the application shell.
 *
 * Keeping storage decoding, toast admission, history-guard transitions, and
 * layout arithmetic free of React/DOM dependencies makes the failure-prone
 * edge cases deterministic and cheap to exercise with node:test.
 */

export interface AppPrefsSnapshot {
  showSummaries: boolean;
  minimalMode: boolean;
  inlineImages: boolean;
}

export const DEFAULT_APP_PREFS: Readonly<AppPrefsSnapshot> = Object.freeze({
  showSummaries: false,
  minimalMode: false,
  inlineImages: true,
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function booleanOr(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

export function normalizeAppPrefs(value: unknown): AppPrefsSnapshot {
  const source = isRecord(value) ? value : {};
  return {
    showSummaries: booleanOr(source.showSummaries, DEFAULT_APP_PREFS.showSummaries),
    minimalMode: booleanOr(source.minimalMode, DEFAULT_APP_PREFS.minimalMode),
    inlineImages: booleanOr(source.inlineImages, DEFAULT_APP_PREFS.inlineImages),
  };
}

export type ParsedPrefs =
  | { status: "missing" }
  | { status: "invalid" }
  | { status: "valid"; prefs: AppPrefsSnapshot };

export function parseAppPrefs(raw: string | null): ParsedPrefs {
  if (raw === null) return { status: "missing" };
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed)) return { status: "invalid" };
    return { status: "valid", prefs: normalizeAppPrefs(parsed) };
  } catch {
    return { status: "invalid" };
  }
}

export function parseLegacyAppPrefs(raw: string | null): ParsedPrefs {
  if (raw === null) return { status: "missing" };
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed) || typeof parsed.showSummaries !== "boolean") {
      return { status: "invalid" };
    }
    return {
      status: "valid",
      prefs: normalizeAppPrefs({
        ...DEFAULT_APP_PREFS,
        showSummaries: parsed.showSummaries,
      }),
    };
  } catch {
    return { status: "invalid" };
  }
}

export interface PreferenceStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface HydratedAppPrefs {
  /** False means storage could not be read reliably; storage events must be ignored. */
  readable: boolean;
  prefs: AppPrefsSnapshot;
  source: "current" | "legacy" | "default";
  currentCorrupt: boolean;
  serialized: string;
}

/**
 * Read and, when safe, migrate app preferences without deleting the only good
 * copy. A malformed v2 record may fall back to v1; v1 is removed only after a
 * complete v2 write succeeds.
 */
export function hydrateAppPrefs(
  storage: PreferenceStorage,
  currentKey: string,
  legacyKey: string
): HydratedAppPrefs {
  let currentRaw: string | null;
  try {
    currentRaw = storage.getItem(currentKey);
  } catch {
    const prefs = { ...DEFAULT_APP_PREFS };
    return {
      readable: false,
      prefs,
      source: "default",
      currentCorrupt: false,
      serialized: JSON.stringify(prefs),
    };
  }

  const current = parseAppPrefs(currentRaw);
  if (current.status === "valid") {
    // A valid v2 value is authoritative. Best-effort removal prevents a later
    // explicit v2 deletion from resurrecting a stale v1 preference.
    try {
      storage.removeItem(legacyKey);
    } catch {
      // The current value remains complete, so a cleanup failure is harmless.
    }
    return {
      readable: true,
      prefs: current.prefs,
      source: "current",
      currentCorrupt: false,
      serialized: JSON.stringify(current.prefs),
    };
  }

  let legacyRaw: string | null;
  try {
    legacyRaw = storage.getItem(legacyKey);
  } catch {
    const prefs = { ...DEFAULT_APP_PREFS };
    return {
      readable: false,
      prefs,
      source: "default",
      currentCorrupt: current.status === "invalid",
      serialized: JSON.stringify(prefs),
    };
  }

  const legacy = parseLegacyAppPrefs(legacyRaw);
  if (legacy.status === "valid") {
    const serialized = JSON.stringify(legacy.prefs);
    let wroteCurrent = false;
    try {
      storage.setItem(currentKey, serialized);
      wroteCurrent = true;
    } catch {
      // Keep the legacy key: it is still the only durable good copy.
    }
    if (wroteCurrent) {
      try {
        storage.removeItem(legacyKey);
      } catch {
        // v2 is durable already; leaving a redundant v1 copy loses no data.
      }
    }
    return {
      readable: true,
      prefs: legacy.prefs,
      source: "legacy",
      currentCorrupt: current.status === "invalid",
      serialized,
    };
  }

  const prefs = { ...DEFAULT_APP_PREFS };
  return {
    readable: true,
    prefs,
    source: "default",
    currentCorrupt: current.status === "invalid",
    serialized: JSON.stringify(prefs),
  };
}

export interface ToastQueueItem {
  kind: string;
}

/**
 * Admit a toast without ever evicting an unread urgent item.
 *
 * Urgent items queue behind the visible window. If a visible non-urgent item
 * can make room, the oldest one is discarded and already-queued urgent items
 * retain FIFO order. Non-urgent items are dropped while the viewport is full.
 */
export function enqueueToast<T extends ToastQueueItem>(
  queue: readonly T[],
  payload: T,
  maxVisible: number,
  urgentKinds: ReadonlySet<T["kind"]>
): T[] {
  const limit = Math.max(0, Math.floor(maxVisible));
  if (limit === 0) return [];
  if (queue.length < limit) return [...queue, payload];
  if (!urgentKinds.has(payload.kind)) return [...queue];

  const evict = queue
    .slice(0, limit)
    .findIndex((item) => !urgentKinds.has(item.kind));
  if (evict === -1) return [...queue, payload];
  return [...queue.slice(0, evict), ...queue.slice(evict + 1), payload];
}

/**
 * KeepAlive 隐藏策略：后台面板与前台叠在同一视口盒上。
 * 只用 visibility:hidden 挡不住绘制——子树里的 content-visibility:auto
 * 仍按「在视口内」继续布局/合成，切换 tab 后几页会叠在一起抢渲染。
 * 后台必须跳过整棵子树的内容绘制。
 */
export function keepAliveContentVisibility(
  active: boolean
): "visible" | "hidden" {
  return active ? "visible" : "hidden";
}

export interface OverflowScroller {
  scrollTop: number;
  scrollLeft: number;
  scrollHeight: number;
  scrollWidth: number;
  clientHeight: number;
  clientWidth: number;
}

export interface OverflowScrollSnapshot<T extends OverflowScroller = OverflowScroller> {
  el: T;
  top: number;
  left: number;
}

export function hasPreservableOverflow(el: OverflowScroller): boolean {
  return (
    el.scrollTop !== 0 ||
    el.scrollLeft !== 0 ||
    el.scrollHeight > el.clientHeight ||
    el.scrollWidth > el.clientWidth
  );
}

export function collectOverflowScrollSnapshots<T extends OverflowScroller>(
  elements: Iterable<T>
): Array<OverflowScrollSnapshot<T>> {
  const snapshots: Array<OverflowScrollSnapshot<T>> = [];
  for (const el of elements) {
    if (!hasPreservableOverflow(el)) continue;
    snapshots.push({ el, top: el.scrollTop, left: el.scrollLeft });
  }
  return snapshots;
}

export interface InstantScrollTarget {
  scrollTop: number;
  scrollLeft: number;
  style?: { scrollBehavior: string };
  scrollTo?: (options: { left: number; top: number; behavior?: ScrollBehavior }) => void;
}

/**
 * 程序化归位必须绕开 `.reader-scroll { scroll-behavior: smooth }`。
 * 直接写 scrollTop / 默认 scrollTo 会从顶部飞过去，KeepAlive 恢复进度
 * 时还会把阅读器顶栏收起来。
 */
export function applyInstantScroll(
  el: InstantScrollTarget,
  left: number,
  top: number
): void {
  const style = el.style;
  const previous = style?.scrollBehavior;
  if (style) style.scrollBehavior = "auto";
  try {
    if (typeof el.scrollTo === "function") {
      el.scrollTo({ left, top, behavior: "auto" });
    } else {
      el.scrollLeft = left;
      el.scrollTop = top;
    }
  } finally {
    if (style) style.scrollBehavior = previous ?? "";
  }
}

export function restoreOverflowScrollSnapshots<T extends OverflowScroller>(
  snapshots: ReadonlyArray<OverflowScrollSnapshot<T>>,
  isConnected: (el: T) => boolean = () => true
): void {
  for (const { el, top, left } of snapshots) {
    if (!isConnected(el)) continue;
    applyInstantScroll(el, left, top);
  }
}

/** Layout-only bottom inset; transformed entrance rectangles never participate. */
export function calculateBottomNavInset(offsetHeight: number, computedBottom: number): number {
  const height = Number.isFinite(offsetHeight) ? offsetHeight : 0;
  const bottom = Number.isFinite(computedBottom) ? computedBottom : 0;
  // Ceil rather than round: under-reporting even a fraction of a pixel lets a
  // toast edge overlap the glass navigation on high-DPI screens.
  return Math.ceil(Math.max(0, height + bottom));
}

/**
 * iOS / WKWebView 软键盘只压缩 visualViewport，不改 layout viewport。
 * toast 是 `position: fixed`，必须按 visualViewport 与 innerHeight 的差值
 * 再抬一次，否则会整块留在键盘后面。
 */
export function calculateKeyboardInset(
  innerHeight: number,
  visualHeight: number,
  visualOffsetTop: number
): number {
  const inner = Number.isFinite(innerHeight) && innerHeight > 0 ? innerHeight : 0;
  const height = Number.isFinite(visualHeight) && visualHeight > 0 ? visualHeight : inner;
  const offsetTop = Number.isFinite(visualOffsetTop) ? Math.max(0, visualOffsetTop) : 0;
  return Math.max(0, Math.ceil(inner - height - offsetTop));
}

/** 有呈现中的 `aria-modal` 时 toast 降到模态之下、底栏之上，避免挡住按钮。 */
export function toastViewportZIndex(hasPresentedModal: boolean): number {
  return hasPresentedModal ? 45 : 100;
}

/** Hidden readers retain warm state for the same five-minute window as prefetch data. */
export const READER_RETENTION_MS = 5 * 60 * 1000;

export interface BackDispatchEntry {
  handler: () => boolean;
  priority: number;
  seq: number;
  /**
   * A successful handler is retired synchronously, before React's passive
   * effect cleanup runs. This keeps a second hardware-back event from asking
   * an already-closed overlay to consume the next navigation step.
   */
  consumed: boolean;
}

interface BackDispatcherOptions<T extends BackDispatchEntry> {
  getEntries: () => readonly T[];
  overlayPriority: number;
  dismissFallback?: () => boolean;
  onError?: (error: unknown) => void;
}

/**
 * Build the priority/LIFO back dispatcher used by useBackHandler.
 *
 * The closure owns the reentrancy guard, while each entry owns its consumed
 * bit. Entries remain retired until their hook unregisters and a future open
 * state creates a fresh registration.
 */
export function createBackDispatcher<T extends BackDispatchEntry>({
  getEntries,
  overlayPriority,
  dismissFallback = () => false,
  onError = () => undefined,
}: BackDispatcherOptions<T>): (minPriority?: number) => boolean {
  let dispatching = false;

  return (minPriority = 0): boolean => {
    if (dispatching) return false;
    dispatching = true;
    try {
      const ordered = getEntries()
        .filter((entry) => !entry.consumed && entry.priority >= minPriority)
        .slice()
        .sort((a, b) => b.priority - a.priority || b.seq - a.seq);

      const ask = (entry: T): boolean => {
        // An earlier handler may synchronously unregister another entry after
        // the snapshot was taken.
        if (entry.consumed || !getEntries().includes(entry)) return false;
        try {
          if (!entry.handler()) return false;
          entry.consumed = true;
          return true;
        } catch (error) {
          onError(error);
          return false;
        }
      };

      for (const entry of ordered) {
        if (entry.priority < overlayPriority) break;
        if (ask(entry)) return true;
      }

      if (minPriority <= overlayPriority) {
        try {
          if (dismissFallback()) return true;
        } catch (error) {
          onError(error);
        }
      }

      for (const entry of ordered) {
        if (entry.priority >= overlayPriority) continue;
        if (ask(entry)) return true;
      }
      return false;
    } finally {
      dispatching = false;
    }
  };
}

export const HISTORY_BACK_WATCHDOG_MS = 250;

export interface HistoryBackWatchdog {
  arm: () => void;
  cancel: () => void;
  isArmed: () => boolean;
}

/**
 * history.back() has no completion callback and silently does nothing at the
 * root entry. This watchdog lets popstate cancel the expected navigation; if
 * no event arrives, the caller can feed history-back-failed to the reducer.
 */
export function createHistoryBackWatchdog<Handle>({
  setTimer,
  clearTimer,
  onTimeout,
  delay = HISTORY_BACK_WATCHDOG_MS,
}: {
  setTimer: (callback: () => void, delay: number) => Handle;
  clearTimer: (handle: Handle) => void;
  onTimeout: () => void;
  delay?: number;
}): HistoryBackWatchdog {
  let handle: Handle | undefined;

  const cancel = () => {
    if (handle === undefined) return;
    clearTimer(handle);
    handle = undefined;
  };

  return {
    arm: () => {
      cancel();
      handle = setTimer(() => {
        handle = undefined;
        onTimeout();
      }, delay);
    },
    cancel,
    isArmed: () => handle !== undefined,
  };
}

export type HistoryGuardPhase = "idle" | "armed" | "disarming" | "continuing";

export interface HistoryGuardState {
  phase: HistoryGuardPhase;
  rearmAfterNavigation: boolean;
}

export const INITIAL_HISTORY_GUARD_STATE: Readonly<HistoryGuardState> = Object.freeze({
  phase: "idle",
  rearmAfterNavigation: false,
});

export type HistoryGuardEffect = "push-guard" | "history-back" | "dispatch-back";

export type HistoryGuardEvent =
  | { type: "handlers-changed"; hasHandlers: boolean }
  | { type: "popstate"; hasHandlers: boolean }
  | { type: "back-dispatched"; consumed: boolean; hasHandlers: boolean }
  | { type: "push-failed" }
  | { type: "history-back-failed" };

export interface HistoryGuardTransition {
  state: HistoryGuardState;
  effects: HistoryGuardEffect[];
}

/**
 * State machine for the browser-history sentinel.
 *
 * `disarming` pops a stale sentinel when the last handler disappears.
 * `continuing` performs the navigation that an unconsumed sentinel pop would
 * otherwise swallow. Both phases suppress their own follow-up popstate.
 */
export function reduceHistoryGuard(
  state: HistoryGuardState,
  event: HistoryGuardEvent
): HistoryGuardTransition {
  switch (event.type) {
    case "handlers-changed": {
      if (state.phase === "idle" && event.hasHandlers) {
        return {
          state: { phase: "armed", rearmAfterNavigation: false },
          effects: ["push-guard"],
        };
      }
      if (state.phase === "armed" && !event.hasHandlers) {
        return {
          state: { phase: "disarming", rearmAfterNavigation: false },
          effects: ["history-back"],
        };
      }
      if (state.phase === "disarming" || state.phase === "continuing") {
        return {
          state: { ...state, rearmAfterNavigation: event.hasHandlers },
          effects: [],
        };
      }
      return { state, effects: [] };
    }

    case "popstate": {
      if (state.phase === "armed") {
        return {
          state: { phase: "idle", rearmAfterNavigation: false },
          effects: ["dispatch-back"],
        };
      }
      if (state.phase === "disarming" || state.phase === "continuing") {
        const shouldRearm = state.rearmAfterNavigation || event.hasHandlers;
        return shouldRearm
          ? {
              state: { phase: "armed", rearmAfterNavigation: false },
              effects: ["push-guard"],
            }
          : {
              state: { phase: "idle", rearmAfterNavigation: false },
              effects: [],
            };
      }
      if (state.phase === "idle" && event.hasHandlers) {
        return {
          state: { phase: "idle", rearmAfterNavigation: false },
          effects: ["dispatch-back"],
        };
      }
      return { state, effects: [] };
    }

    case "back-dispatched": {
      if (event.consumed) {
        return event.hasHandlers
          ? {
              state: { phase: "armed", rearmAfterNavigation: false },
              effects: ["push-guard"],
            }
          : {
              state: { phase: "idle", rearmAfterNavigation: false },
              effects: [],
            };
      }
      return {
        state: { phase: "continuing", rearmAfterNavigation: event.hasHandlers },
        effects: ["history-back"],
      };
    }

    case "push-failed":
      return {
        state: { phase: "idle", rearmAfterNavigation: false },
        effects: [],
      };

    case "history-back-failed":
      return {
        // A failed disarm means the sentinel is still current. A failed
        // continuation started from the unguarded root, so there is no guard.
        state:
          state.phase === "disarming"
            ? { phase: "armed", rearmAfterNavigation: false }
            : { phase: "idle", rearmAfterNavigation: false },
        effects: [],
      };
  }
}

export interface CleanupStep {
  version: number;
  keys: readonly string[];
}

export function cleanupVersionFrom(raw: string | null): number {
  const parsed = Number(raw ?? "");
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 0;
}

export function pendingCleanupKeys(
  completedVersion: number,
  steps: readonly CleanupStep[],
  sentinelKey: string
): string[] {
  const keys: string[] = [];
  const seen = new Set<string>();
  for (const step of steps) {
    if (step.version <= completedVersion) continue;
    for (const key of step.keys) {
      if (key === sentinelKey || seen.has(key)) continue;
      seen.add(key);
      keys.push(key);
    }
  }
  return keys;
}
