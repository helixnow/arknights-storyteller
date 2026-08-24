import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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

type HighlightLike = number | HighlightEntry;

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
const failedHighlightWrites = new Map<string, HighlightLike[] | null>();

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
  stash: ReadonlyMap<string, HighlightLike[] | null> = failedHighlightWrites
): HighlightStore {
  const merged: HighlightStore = { ...base };
  for (const [key, value] of stash) {
    if (value === null) delete merged[key];
    else merged[key] = value;
  }
  if (pending !== null && dirtyKeys) {
    for (const key of dirtyKeys) {
      if (key in pending) merged[key] = pending[key];
      else delete merged[key];
    }
  }
  return merged;
}

function normalizeEntry(item: HighlightLike): HighlightEntry | null {
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
export function useHighlights(storyPath: string, segmentDigests?: readonly string[]) {
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
    const merged = overlayLocalChanges(readStorage(), pending, dirtyKeysRef.current);
    const raw = JSON.stringify(merged);
    if (raw === lastRawRef.current) {
      // 内容与盘上完全一致（典型场景：跟随 storage 事件之后的回写），
      // 再写一遍只会在别的窗口触发一轮多余的事件。
      // 脏键只在其对应的 pending 真被并进 merged 时才算清账：toggle 是先
      // 同步记脏键、等 persist effect 才物化 pending 的，中间若插进一次
      // 只带遗留重试的冲刷，不能把还没消费过的脏键顺手抹掉。
      if (pending !== null) {
        pendingStoreRef.current = null;
        dirtyKeysRef.current.clear();
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
        failedHighlightWrites.set(key, key in pending ? pending[key] : null);
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
  const initialStoreRef = useRef(store);
  useEffect(() => {
    if (typeof window === "undefined") return;
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
  }, [store, flushPendingStore]);

  // Unmount flush: if a debounced write is still pending when the reader
  // unmounts (toggle a highlight, immediately navigate back), write it now
  // instead of silently dropping the annotation.
  useEffect(() => () => flushPendingStore(), [flushPendingStore]);

  // 切后台 / 关标签页冲刷：移动端杀掉 app、桌面端直接关窗口都不会走
  // unmount（阅读器被 KeepAlive 常驻挂载）。划线的防抖只有一个宏任务，
  // 但「点完书签立刻锁屏 / 关 app」仍可能抢在 setTimeout(0) 之前；quota
  // 失败后留着重试的 pending 更是只能靠这里兜底落盘。与阅读进度 hook 的
  // 同名兜底对齐。
  useEffect(() => {
    if (typeof window === "undefined") return;
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
  }, [flushPendingStore]);

  // 多窗口（桌面端可以开多个）时跟随其它窗口的修改。划线和收藏一样是
  // 「整表读进内存 → 任意改动整表回写」，不跟随的话：A 窗口刚画的线会在
  // B 窗口的下一次回写里被 B 的旧内存快照整体覆盖，无声丢失（收藏 hook
  // 修过同一个坑）。
  useEffect(() => {
    if (typeof window === "undefined") return;
    const onStorage = (event: StorageEvent) => {
      // key 为 null 表示外部 storage.clear()，也要跟随。
      if (event.key !== null && event.key !== STORAGE_KEY) return;
      const raw = event.key === STORAGE_KEY ? event.newValue : null;
      if (event.key === STORAGE_KEY && raw === lastRawRef.current) return;
      lastRawRef.current = raw;
      const disk = readStorage();
      // 本地改动的判据不能要求 pending 已物化：toggle 是先同步记脏键、等
      // persist effect（passive 宏任务）才把 store 快照写进 pending 的，而
      // 这个监听器是原生事件，完全可能插在两者之间。那一刻若按「无本地改
      // 动」处理，清脏键 + 整表跟盘会把用户刚点的划线从 UI 和持久化管线里
      // 同时抹掉——冲刷里的回声路径为同一中间态特意保过脏键，这里对齐。
      const hasLocalChanges = dirtyKeysRef.current.size > 0 || failedHighlightWrites.size > 0;
      if (!hasLocalChanges) {
        // 脏键此刻必为空；pending 若非空也只是跟随上一次外部状态的回声
        // 快照，直接作废、整表跟盘。
        pendingStoreRef.current = null;
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
      const stashAtEvent = new Map(failedHighlightWrites);
      setStore((prev) => overlayLocalChanges(disk, prev, dirtyAtEvent, stashAtEvent));
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  // The raw entries as persisted. Always an array of (upgraded) objects.
  const entries = useMemo<HighlightEntry[]>(
    () =>
      (store[storyPath] ?? [])
        .map(normalizeEntry)
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
   * Entries whose content vanished keep their stored index as-is.
   */
  const resolveEntryIndex = useCallback(
    (entry: HighlightEntry): number => {
      if (entry.digest && segmentDigests && segmentDigests.length > 0) {
        if (segmentDigests[entry.segmentIndex] === entry.digest) return entry.segmentIndex;
        const shifted = digestIndex?.get(entry.digest);
        if (typeof shifted === "number") return shifted;
      }
      return entry.segmentIndex;
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
      // `segmentDigestMap` uses "" for unrecognised segment types — never
      // persist that as a fingerprint.
      const digest = segmentDigests?.[segmentIndex] || undefined;
      dirtyKeysRef.current.add(storyPath);
      setStore((prev) => {
        const rawList = prev[storyPath] ?? [];
        const current: HighlightEntry[] = [];
        for (const item of rawList) {
          const n = normalizeEntry(item);
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
