import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useToast } from "@/components/ui/toast";

/**
 * Shape of each persisted highlight. `segmentIndex` is the index at the time
 * of annotation; `digest` is a content fingerprint (NFKC-normalised FNV-1a
 * 64 hex, see `segmentDigest()`) so we can re-align after the indices shift
 * across data updates.
 *
 * Older builds stored `number[]` — the hook transparently upgrades those on
 * load via the `HighlightLike` union below.
 */
export interface HighlightEntry {
  segmentIndex: number;
  digest?: string;
}

export type HighlightLike = number | HighlightEntry;

type HighlightStore = Record<string, HighlightLike[]>;

const STORAGE_KEY = "reader-highlights";

function readStorage(): HighlightStore {
  if (typeof window === "undefined") {
    return {};
  }

  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed: unknown = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        // Keep only array values. A hand-edited / corrupted store must not
        // be able to crash the `.map` over `store[storyPath]` downstream;
        // per-element junk is filtered later by `normalizeEntry`.
        const sanitized: HighlightStore = {};
        for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
          if (Array.isArray(value)) sanitized[key] = value as HighlightLike[];
        }
        return sanitized;
      }
    }
  } catch {
    // ignore corrupted storage
  }
  return {};
}

/** 失败提示的会话级闩锁：同一轮连续失败只打扰用户一次，写成功后复位。 */
let persistFailureNotified = false;

/**
 * quota 满时没能落盘的划线改动（key → 划线列表；null 表示该 key 已删除）。
 * pending / dirtyKeys 都是实例级 ref，而阅读器按 storyId 重挂——换章时旧
 * 实例的卸载冲刷再次失败的话，滞留的改动会随实例一起被回收，「将自动重试」
 * 的承诺就落空了。折进模块级暂存后，任何实例的下一次冲刷都会带上它重试，
 * 真正写成功（或发现盘上已一致）才清空。
 */
interface HighlightChange {
  /** 这轮本地编辑开始时看到的列表。 */
  base: HighlightLike[] | null;
  /** 本地最终想要的列表；null 表示删除该 story key。 */
  desired: HighlightLike[] | null;
}

const failedHighlightWrites = new Map<string, HighlightChange>();

function highlightEntryKey(item: HighlightLike): string | null {
  const normalized = normalizeHighlightEntry(item);
  if (!normalized) return null;
  // digest 相同的重复台词仍可分别收藏，下标是身份的一部分。
  return `${normalized.digest ?? ""}\u0000${normalized.segmentIndex}`;
}

/**
 * 同一篇剧情的三方合并：只把 base → desired 之间真正发生的本地增删应用到
 * external。这样 A 窗口新增第 10 段、B 窗口同时新增第 20 段时，两边不会再
 * 用整列表互相覆盖；本地没碰过的条目始终以外部最新值为准。
 */
export function mergeHighlightLists(
  base: HighlightLike[] | null | undefined,
  desired: HighlightLike[] | null | undefined,
  external: HighlightLike[] | null | undefined
): HighlightEntry[] | null {
  const toMap = (items: HighlightLike[] | null | undefined) => {
    const map = new Map<string, HighlightEntry>();
    for (const item of items ?? []) {
      const normalized = normalizeHighlightEntry(item);
      const key = normalized ? highlightEntryKey(normalized) : null;
      if (normalized && key) map.set(key, normalized);
    }
    return map;
  };
  const baseMap = toMap(base);
  const desiredMap = toMap(desired);
  const result = toMap(external);
  const touched = new Set([...baseMap.keys(), ...desiredMap.keys()]);
  for (const key of touched) {
    const before = baseMap.get(key);
    const after = desiredMap.get(key);
    if (Boolean(before) === Boolean(after)) continue;
    if (after) result.set(key, after);
    else result.delete(key);
  }
  if (result.size === 0) return null;
  return Array.from(result.values()).sort((a, b) => a.segmentIndex - b.segmentIndex);
}

/**
 * 把本地尚未落盘的改动叠到 `base`（刚读出的盘上整表）上：先叠上一批实例
 * 遗留的失败重试，再叠本实例的脏键——后者一定更新，压轴生效。
 * `stash` 默认取实时的模块级暂存；storage 事件的更新器要传事件时刻的
 * 快照（见监听器里的说明）。
 */
function overlayLocalChanges(
  base: HighlightStore,
  pending: HighlightStore | null,
  dirtyKeys?: ReadonlySet<string>,
  dirtyBases?: ReadonlyMap<string, HighlightLike[] | null>,
  stash: ReadonlyMap<string, HighlightChange> = failedHighlightWrites
): HighlightStore {
  const merged: HighlightStore = { ...base };
  for (const [key, change] of stash) {
    const value = mergeHighlightLists(change.base, change.desired, merged[key]);
    if (value === null) delete merged[key];
    else merged[key] = value;
  }
  if (pending !== null && dirtyKeys && dirtyBases) {
    for (const key of dirtyKeys) {
      const value = mergeHighlightLists(
        dirtyBases.get(key),
        key in pending ? pending[key] : null,
        merged[key]
      );
      if (value === null) delete merged[key];
      else merged[key] = value;
    }
  }
  return merged;
}

export function normalizeHighlightEntry(item: HighlightLike): HighlightEntry | null {
  if (typeof item === "number") {
    if (!Number.isFinite(item) || item < 0) return null;
    return { segmentIndex: Math.trunc(item) };
  }
  if (item && typeof item === "object" && typeof item.segmentIndex === "number") {
    if (!Number.isFinite(item.segmentIndex)) return null;
    const segmentIndex = Math.trunc(item.segmentIndex);
    if (segmentIndex < 0) return null;
    return {
      segmentIndex,
      digest: typeof item.digest === "string" && item.digest.length > 0 ? item.digest : undefined,
    };
  }
  return null;
}

/**
 * 划线预览的首尾标点不应占 70 字预算，也不该出现“句号 + 省略号”的双尾巴。
 * 只修首尾，正文内部标点原样保留。
 */
export function trimHighlightPreview(text: string, maxLength = 70): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) return "";
  if (normalized.length <= maxLength) return normalized;
  const head = normalized
    .slice(0, Math.max(0, maxLength))
    .replace(/[\p{P}\p{S}\s]+$/gu, "");
  return head ? `${head}…` : "";
}

/** 数据换包后按 digest 找回原段；内容已消失时返回 -1，绝不绑到同下标的新句子。 */
export function resolveHighlightEntryIndex(
  entry: HighlightEntry,
  segmentDigests?: readonly string[],
  digestIndex?: ReadonlyMap<string, number> | null
): number {
  if (!entry.digest || !segmentDigests || segmentDigests.length === 0) {
    return entry.segmentIndex;
  }
  if (segmentDigests[entry.segmentIndex] === entry.digest) return entry.segmentIndex;
  const shifted = digestIndex?.get(entry.digest) ?? segmentDigests.indexOf(entry.digest);
  return shifted >= 0 ? shifted : -1;
}

/**
 * Hook for per-story segment highlights.
 *
 * `segmentDigests` is the list of content digests for every segment in the
 * currently-loaded story, same order as `processedSegments` in the reader.
 * When omitted, the hook behaves exactly like the legacy index-only version;
 * when provided, it re-aligns persisted highlights to the nearest digest
 * match so users don't lose their annotations after a data sync shifts
 * segment numbers around.
 *
 * Performance notes:
 *
 * - `highlights` is kept as both an ordered array (exposed for rendering)
 *   and a `Set<number>` (used inside `isHighlighted`) so per-paragraph
 *   lookups stay O(1) on stories with thousands of segments.
 * - The digest → current-index map is memoised at the top level rather
 *   than rebuilt inside every `toggleHighlight` call, which was the
 *   hottest path on rapid annotate / un-annotate.
 * - `setStore` persistence is debounced through a microtask so a burst of
 *   toggles (e.g. Ctrl-click on many rows) triggers one localStorage
 *   write, not one per toggle. A still-pending write is flushed on
 *   unmount so navigating away right after a toggle never drops it.
 */
export function useHighlights(
  storyPath: string,
  segmentDigests?: readonly string[],
  active = true
) {
  // 初始状态也要叠上遗留的失败重试：quota 失败后换章重挂，新实例只读盘的
  // 话，用户刚画的线会先「消失」再随重试成功回来——直接从合并结果起步。
  const [store, setStore] = useState<HighlightStore>(() => overlayLocalChanges(readStorage(), null));

  // Persist on change — but coalesce bursts. `store` updates from toggle /
  // clear land in the same microtask most of the time, so waiting one tick
  // lets us serialise only once per React commit.
  const persistTimerRef = useRef<number | null>(null);
  // Latest store snapshot awaiting the debounced write; null when clean.
  const pendingStoreRef = useRef<HighlightStore | null>(null);
  // 「盘上当前内容」的序列化串：最后一次成功写入、或最后一次收到的外部
  // storage 事件值。用来抑制回声写入（跟随外部状态之后不必再写一遍），
  // 也用来识别 storage 事件是不是本窗口自己的写入触发的。
  const lastRawRef = useRef<string | null>(null);
  // 本实例真正改过的 story key。冲刷时只把这些 key 并到盘上最新状态里，
  // 其余 key 一律以盘为准——见 flushPendingStore 里的换章竞态说明。
  const dirtyKeysRef = useRef<Set<string>>(new Set());
  // 每个 key 第一次本地编辑时看到的基线。冲刷 / storage 事件用它做三方
  // 合并，而不是让本窗口的整列表覆盖另一个窗口刚加的划线。
  const dirtyBasesRef = useRef<Map<string, HighlightLike[] | null>>(new Map());
  const activeRef = useRef(active);
  activeRef.current = active;

  // 冲刷跑在 setTimeout 回调和卸载清理里，通过 ref 取最新的 toast 句柄。
  const toast = useToast();
  const toastRef = useRef(toast);
  useEffect(() => {
    toastRef.current = toast;
  }, [toast]);

  /**
   * 把待写快照冲刷进 localStorage。写失败（quota 满 / 隐私模式）以前是
   * 静默吞掉的——书签照常点亮、导览面板照常列出，用户以为收藏成功，
   * 重启后却全没了。改为明确提示一次；且失败时保留 pending（与阅读进度
   * hook 的 flushPending 一致），后续改动 / 卸载冲刷会带着它重试，配额
   * 腾出来后还能救回。只有真正写成功才清空 pending。
   */
  const flushPendingStore = useCallback(() => {
    const pending = pendingStoreRef.current;
    // 没有本实例的新改动、也没有遗留的失败重试时才是 no-op；只剩遗留重试
    //（上一个实例 quota 失败后被回收）也要趁冲刷时机再试一次。
    if (pending === null && failedHighlightWrites.size === 0) return;
    // 不能把内存里的整表直接覆写上盘。阅读器按 storyId 重挂，换章时新实例
    // 的 useState 初始化在 render 阶段就读了盘，而旧实例的卸载冲刷要到
    // commit 的 passive 清理阶段才落盘——新实例的整表快照因此天然落后一笔
    //（quota 失败后 pending 长期滞留重试时，落后的窗口更是无限大）。之后
    // 新实例任何一次整表覆写都会把旧实例刚救回来的划线无声抹掉。这里改成
    // 和阅读进度 hook 同一口径：写盘时现读最新整表，只把本地真正改过的
    // key（遗留重试 + 本实例脏键）并进去，别的 key（上一章的划线、别的
    // 窗口的写入）以盘为准。
    const disk = readStorage();
    const merged = overlayLocalChanges(
      disk,
      pending,
      dirtyKeysRef.current,
      dirtyBasesRef.current
    );
    const raw = JSON.stringify(merged);
    if (raw === lastRawRef.current) {
      // 内容与盘上完全一致（典型场景：跟随 storage 事件之后的回写），
      // 再写一遍只会在别的窗口触发一轮多余的事件。
      // 脏键只在其对应的 pending 真被并进 merged 时才算清账。物化改到
      // layout effect、clearHighlights 又不再对不存在的 key 记脏键之后，
      // 任何任务边界上「脏键非空 ⇒ pending 非空」应当成立；这里仍按
      // pending 是否在场防御：只带遗留重试的冲刷绝不顺手抹掉脏键。
      if (pending !== null) {
        pendingStoreRef.current = null;
        dirtyKeysRef.current.clear();
        dirtyBasesRef.current.clear();
      }
      failedHighlightWrites.clear();
      return;
    }
    try {
      window.localStorage.setItem(STORAGE_KEY, raw);
      lastRawRef.current = raw;
      persistFailureNotified = false;
      if (pending !== null) {
        pendingStoreRef.current = null;
        dirtyKeysRef.current.clear();
        dirtyBasesRef.current.clear();
      }
      failedHighlightWrites.clear();
      return;
    } catch {
      // Quota / private mode: the write fails atomically, the previously
      // stored value stays intact. Never write partial data.
    }
    // 失败时把本实例的脏键改动折进模块级暂存：实例还活着就继续靠 pending
    // 重试；实例被换章回收后，新实例的冲刷也会带上这批改动。
    if (pending !== null) {
      for (const key of dirtyKeysRef.current) {
        // 以本次实际读到的盘为新基线，把本实例与更早失败重试合成后的最终
        // 结果存成一轮变更。之后即使另一个窗口继续改同篇，也还能再三方合并。
        failedHighlightWrites.set(key, {
          base: disk[key] ?? null,
          desired: key in merged ? merged[key] : null,
        });
      }
    }
    if (!persistFailureNotified) {
      persistFailureNotified = true;
      toastRef.current.error("划线未能保存到本地存储（空间可能已满），将自动重试");
    }
  }, []);
  // 首帧的 store 就是刚从 localStorage 读出来的，回写没有意义；更糟的是：
  // 如果读取因数据损坏回落到了 {}，这次回写会立刻用空对象覆盖掉原始数据，
  // 连恢复的机会都不留。守卫不能用「跳过第一次 effect」的布尔标记：
  // StrictMode 开发模式下挂载期 effect 连跑两次、ref 不会重置，第二次就把
  // 初始状态写回去了（收藏 hook 踩过同一个坑）。改为与初始 state 做引用
  // 比较——任何真实改动都会产生新对象，自然落盘。
  //
  // 物化 pending 必须用 layout effect（与 commit 同任务同步执行），不能等
  // passive：toggle 是「同步记脏键 → setStore → 本任务内 commit」，而
  // passive effect 要到 paint 之后的调度任务才跑。中间隔着的任务边界上：
  //   - pagehide / visibilitychange 的兜底冲刷看到的 pending 还是 null，
  //     直接 no-op——「点完书签立刻锁屏 / 关 app」时刚点的划线救不回来；
  //   - 上一次 commit 布下的 setTimeout(0) 冲刷更糟：它会按脏键把旧
  //     pending 快照并盘并清空全部脏键，新 toggle 的值既没上盘、重试凭据
  //     （脏键）也没了；随后新 pending 物化时脏键已空，一个键都并不进去，
  //     合并结果与盘一致又被回声抑制清账——UI 亮着、重启后划线消失。
  // 改成 layout effect 后：任何任务边界上 pending 一定覆盖了所有已记脏的
  // 改动，旧定时器也在新 commit 的同一任务里被 cleanup 拆掉，冲刷永远拿
  // 不到过期快照。
  const initialStoreRef = useRef(store);
  // 最近一次已提交 store 的镜像。事件回调可能持有旧渲染的闭包（清空按钮
  // 走异步确认对话框，等用户点「确定」时闭包里的 store 早已过期），要判断
  // 「某个 key 现在还存不存在」只能读 ref。在 layout effect 里与 commit
  // 同任务更新，事件处理器运行时（commit 之后）一定是新值。
  const storeRef = useRef(store);
  useLayoutEffect(() => {
    storeRef.current = store;
    if (typeof window === "undefined" || !active) return;
    if (store === initialStoreRef.current) {
      return;
    }
    pendingStoreRef.current = store;
    if (persistTimerRef.current !== null) {
      window.clearTimeout(persistTimerRef.current);
    }
    persistTimerRef.current = window.setTimeout(() => {
      persistTimerRef.current = null;
      flushPendingStore();
    }, 0);
    return () => {
      // Deps-change cleanup only disarms the timer — the next effect run
      // re-arms it with the newer snapshot, so bursts still coalesce.
      if (persistTimerRef.current !== null) {
        window.clearTimeout(persistTimerRef.current);
        persistTimerRef.current = null;
      }
    };
  }, [active, store, flushPendingStore]);

  // Unmount flush: if a debounced write is still pending when the reader
  // unmounts (toggle a highlight, immediately navigate back), write it now
  // instead of silently dropping the annotation.
  useEffect(() => () => flushPendingStore(), [flushPendingStore]);

  // KeepAlive 隐藏时冲刷并停掉定时器；重新激活时现读盘，把隐藏期间其它
  // 窗口的改动与仍未落盘的本地 dirty 三方合并后再恢复监听。
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!active) {
      if (persistTimerRef.current !== null) {
        window.clearTimeout(persistTimerRef.current);
        persistTimerRef.current = null;
      }
      flushPendingStore();
      return;
    }
    flushPendingStore();
    const disk = readStorage();
    const hasLocalChanges =
      dirtyKeysRef.current.size > 0 || failedHighlightWrites.size > 0;
    const next = hasLocalChanges
      ? overlayLocalChanges(
          disk,
          pendingStoreRef.current ?? storeRef.current,
          dirtyKeysRef.current,
          dirtyBasesRef.current
        )
      : disk;
    initialStoreRef.current = next;
    storeRef.current = next;
    setStore(next);
  }, [active, flushPendingStore]);

  // 切后台 / 关标签页冲刷：移动端杀掉 app、桌面端直接关窗口都不会走
  // unmount（阅读器被 KeepAlive 常驻挂载）。划线的防抖只有一个宏任务，
  // 但「点完书签立刻锁屏 / 关 app」仍可能抢在 setTimeout(0) 之前；quota
  // 失败后留着重试的 pending 更是只能靠这里兜底落盘。与阅读进度 hook 的
  // 同名兜底对齐。
  useEffect(() => {
    if (typeof window === "undefined" || !active) return;
    const handleHide = () => {
      if (document.visibilityState === "hidden") flushPendingStore();
    };
    const handlePageHide = () => flushPendingStore();
    document.addEventListener("visibilitychange", handleHide);
    window.addEventListener("pagehide", handlePageHide);
    return () => {
      document.removeEventListener("visibilitychange", handleHide);
      window.removeEventListener("pagehide", handlePageHide);
    };
  }, [active, flushPendingStore]);

  // 多窗口（桌面端可以开多个）时跟随其它窗口的修改。划线和收藏一样是
  // 「整表读进内存 → 任意改动整表回写」，不跟随的话：A 窗口刚画的线会在
  // B 窗口的下一次回写里被 B 的旧内存快照整体覆盖，无声丢失（收藏 hook
  // 修过同一个坑）。
  useEffect(() => {
    if (typeof window === "undefined" || !active) return;
    const onStorage = (event: StorageEvent) => {
      // key 为 null 表示外部 storage.clear()，也要跟随。
      if (event.key !== null && event.key !== STORAGE_KEY) return;
      const raw = event.key === STORAGE_KEY ? event.newValue : null;
      if (event.key === STORAGE_KEY && raw === lastRawRef.current) return;
      lastRawRef.current = raw;
      const disk = readStorage();
      // 本地改动的判据以脏键（而不是 pending 是否已物化）为准：pending
      // 非空也可能只是跟随上一次外部状态的回声快照，不代表有本地改动；
      // 反过来物化在 layout effect（与 commit 同任务）里做，脏键非空时
      // pending 在任何任务边界上都已就位。按「无本地改动」处理会清脏键 +
      // 整表跟盘，把还没上盘的改动从 UI 和持久化管线里同时抹掉。
      const hasLocalChanges = dirtyKeysRef.current.size > 0 || failedHighlightWrites.size > 0;
      if (!hasLocalChanges) {
        // 脏键此刻必为空；pending 若非空也只是跟随上一次外部状态的回声
        // 快照，直接作废、整表跟盘。
        pendingStoreRef.current = null;
        dirtyBasesRef.current.clear();
        initialStoreRef.current = disk;
        storeRef.current = disk;
        setStore(disk);
        return;
      }
      // 以前这里直接作废 pending 和脏键——那是整表覆写时代的自保。冲刷早已
      // 改成「现读盘、只并本地改动」，外部写入本就不会被我们盖掉；继续作废
      // 等于把还压在防抖里的划线、以及 quota 失败后承诺「将自动重试」的滞留
      // 改动无声丢掉，UI 还会跟着 setStore 缩回去。改为把本地改动重放到外部
      // 新状态上：两边都不丢，随后的防抖冲刷把合并结果落盘（若合并后与盘上
      // 一致，冲刷里的回声抑制会直接清账，不产生多余写入）。
      // 脏键的值从函数式更新的 prev 里取而不是 pending：prev 一定含有刚
      // 提交还没物化进 pending 的 toggle，只新不旧；非脏键仍以盘为准。
      // 脏键集和遗留暂存必须在此刻拍快照，不能让更新器读实时引用：更新器
      // 要等 React 调度的渲染任务才执行，防抖 / pagehide 冲刷完全可能抢在
      // 中间成功落盘并把两者清空。那时实时引用已空，更新器会退化成整表跟
      // `disk`——而 `disk` 是冲刷前的旧盘快照，刚落盘的划线就从 UI 里被
      // 无声抹掉（盘上其实是对的），要等下一次外部事件或重挂才恢复。快照
      // 与 `disk` 同一时刻取，视图自洽；随后的冲刷仍对实时状态收敛落盘。
      const dirtyAtEvent = new Set(dirtyKeysRef.current);
      const basesAtEvent = new Map(dirtyBasesRef.current);
      const stashAtEvent = new Map(failedHighlightWrites);
      const next = overlayLocalChanges(
        disk,
        storeRef.current,
        dirtyAtEvent,
        basesAtEvent,
        stashAtEvent
      );
      initialStoreRef.current = next;
      storeRef.current = next;
      setStore(next);
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [active]);

  // The raw entries as persisted. Always an array of (upgraded) objects.
  const entries = useMemo<HighlightEntry[]>(
    () =>
      (store[storyPath] ?? [])
        .map(normalizeHighlightEntry)
        .filter((e): e is HighlightEntry => e !== null),
    [store, storyPath]
  );

  // Single shared digest → current-index map. Built once per story load
  // (the `segmentDigests` array reference changes only when the reader
  // swaps stories). `toggleHighlight` borrows this instead of rebuilding
  // its own, saving an O(N) pass on every annotation.
  const digestIndex = useMemo<Map<string, number> | null>(() => {
    if (!segmentDigests || segmentDigests.length === 0) return null;
    const map = new Map<string, number>();
    for (let i = 0; i < segmentDigests.length; i += 1) {
      const d = segmentDigests[i];
      if (d && !map.has(d)) map.set(d, i);
    }
    return map;
  }, [segmentDigests]);

  /**
   * Map a persisted entry to its index in the currently-loaded story.
   *
   * Stay-in-place first: if the segment at the stored index still carries
   * the same digest, keep it. Only when the content moved away do we fall
   * back to the digest table (which maps to the first occurrence) — this
   * keeps two highlights on identical paragraphs from collapsing onto one.
   * 内容已经消失的条目保留在持久化层等待未来数据版本恢复，但当前视图返回
   * -1，不得把划线错误套到新包里恰好占同一下标的另一句话上。
   */
  const resolveEntryIndex = useCallback(
    (entry: HighlightEntry): number => {
      return resolveHighlightEntryIndex(entry, segmentDigests, digestIndex);
    },
    [segmentDigests, digestIndex]
  );

  /**
   * Effective highlight indices for the current story — remapped via the
   * digest table when available so annotations survive data-version
   * upgrades. Returned as `{ array, set }` so renderers and hot-path
   * lookups don't have to pay the list-scan cost.
   */
  const { highlightList, highlightSet } = useMemo(() => {
    const resolved = new Set<number>();
    for (const entry of entries) {
      const effective = resolveEntryIndex(entry);
      if (segmentDigests && (effective < 0 || effective >= segmentDigests.length)) {
        continue;
      }
      resolved.add(effective);
    }
    const sorted = Array.from(resolved).sort((a, b) => a - b);
    return { highlightList: sorted, highlightSet: resolved };
  }, [entries, resolveEntryIndex, segmentDigests]);

  const isHighlighted = useCallback(
    (segmentIndex: number) => highlightSet.has(segmentIndex),
    [highlightSet]
  );

  /**
   * Conservative self-healing applied whenever a story's list gets
   * rewritten anyway (i.e. on toggle): fold a digest-confirmed shift into
   * the stored index so a later update that drops this content still falls
   * back to the last-seen position, and backfill the digest on legacy
   * index-only entries (fingerprinting exactly the segment currently shown
   * as highlighted). Entries whose digest matches nothing are left
   * untouched — rebinding them to whatever now sits at their index would
   * silently change what the user annotated.
   */
  const realignEntry = useCallback(
    (entry: HighlightEntry): HighlightEntry => {
      if (!segmentDigests || segmentDigests.length === 0) return entry;
      if (entry.digest) {
        if (segmentDigests[entry.segmentIndex] === entry.digest) return entry;
        const shifted = digestIndex?.get(entry.digest);
        if (typeof shifted === "number") return { segmentIndex: shifted, digest: entry.digest };
        return entry;
      }
      const digest = segmentDigests[entry.segmentIndex];
      return digest ? { segmentIndex: entry.segmentIndex, digest } : entry;
    },
    [segmentDigests, digestIndex]
  );

  /**
   * Toggle a highlight. When adding, we capture the current digest so
   * future data-version shifts can re-align the annotation to the same
   * content rather than to whatever segment happens to keep this index.
   */
  const toggleHighlight = useCallback(
    (segmentIndex: number) => {
      if (!activeRef.current || !Number.isFinite(segmentIndex) || segmentIndex < 0) return;
      // `segmentDigestMap` uses "" for unrecognised segment types — never
      // persist that as a fingerprint.
      const digest = segmentDigests?.[segmentIndex] || undefined;
      if (!dirtyKeysRef.current.has(storyPath)) {
        dirtyBasesRef.current.set(storyPath, storeRef.current[storyPath] ?? null);
      }
      dirtyKeysRef.current.add(storyPath);
      setStore((prev) => {
        const rawList = prev[storyPath] ?? [];
        const current: HighlightEntry[] = [];
        for (const item of rawList) {
          const n = normalizeHighlightEntry(item);
          if (n) current.push(realignEntry(n));
        }

        // Determine whether `segmentIndex` is currently highlighted under
        // the _effective_ (digest-remapped) index.
        let isPresent = false;
        for (const entry of current) {
          if (resolveEntryIndex(entry) === segmentIndex) {
            isPresent = true;
            break;
          }
        }

        const next = isPresent
          ? current.filter((entry) => resolveEntryIndex(entry) !== segmentIndex)
          : [...current, { segmentIndex, digest }];
        // Removing the last highlight drops the key entirely (same as
        // `clearHighlights`) instead of leaving empty arrays behind.
        if (next.length === 0) {
          const copy = { ...prev };
          delete copy[storyPath];
          return copy;
        }
        next.sort((a, b) => a.segmentIndex - b.segmentIndex);
        return { ...prev, [storyPath]: next };
      });
    },
    [storyPath, segmentDigests, realignEntry, resolveEntryIndex]
  );

  const clearHighlights = useCallback(() => {
    if (!activeRef.current) return;
    // 对不存在的 key 不能先记脏键再靠 setStore 原样 bail-out 兜底：bail-out
    // 后 layout effect 不跑、冲刷不会被调度，这个脏键会一直挂着没人消费。
    // 之后任何一次外部 storage 事件都会把它重放成「本地要删掉这个 key」
    //（overlayLocalChanges 对不在 pending 里的脏键执行 delete）并随防抖
    // 落盘——别的窗口在那之后新画的划线会被这份早已过期的清空意图无声
    // 删掉。清空确认对话框是异步的，等待期间另一窗口先清空同一篇就会走
    // 到这里；闭包里的 store 也早已过期，所以存在性只能查镜像 ref。
    // 镜像里没有这个 key 就说明清空是 no-op，什么都不记。
    if (!(storyPath in storeRef.current)) return;
    if (!dirtyKeysRef.current.has(storyPath)) {
      dirtyBasesRef.current.set(storyPath, storeRef.current[storyPath] ?? null);
    }
    dirtyKeysRef.current.add(storyPath);
    setStore((prev) => {
      if (!(storyPath in prev)) {
        return prev;
      }
      const copy = { ...prev };
      delete copy[storyPath];
      return copy;
    });
  }, [storyPath]);

  return useMemo(
    () => ({
      highlights: highlightList,
      toggleHighlight,
      isHighlighted,
      clearHighlights,
    }),
    [highlightList, toggleHighlight, isHighlighted, clearHighlights]
  );
}
