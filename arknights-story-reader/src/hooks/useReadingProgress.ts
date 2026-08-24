import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useToast } from "@/components/ui/toast";
import type { ReaderSettings } from "@/hooks/useReaderSettings";

export interface ReadingProgress {
  storyPath: string;
  percentage: number;
  currentPage?: number;
  scrollTop?: number;
  /** 连续滚动恢复的稳定锚点；旧记录没有时仍按 scrollTop / percentage 恢复。 */
  anchorIndex?: number;
  anchorOffset?: number;
  readingMode: ReaderSettings["readingMode"];
  updatedAt: number;
  /**
   * 冗余的展示用元数据。首页 / 列表页读同一份 map 渲染「继续阅读」，有了
   * 这两个字段就不必先等索引加载完才能显示标题。旧记录没有这两个字段，
   * 读取方全部按可选处理，所以补写是向后兼容的。
   */
  storyName?: string;
  storyCode?: string | null;
}

const STORAGE_KEY = "reading-progress";
/** 活跃滚动时两次 localStorage 写入之间的最小间隔。 */
const PERSIST_THROTTLE_MS = 1200;
/** 小于这些幅度的变化不值得再写一次盘（离开页面时仍会强制落盘）。 */
const MIN_PERCENTAGE_DELTA = 0.005;
const MIN_SCROLL_DELTA_PX = 24;
/** map 里最多保留多少条记录，按 `updatedAt` 淘汰最旧的。 */
const MAX_ENTRIES = 300;

type ProgressMap = Record<string, ReadingProgress>;

const isBrowser = typeof window !== "undefined";

/**
 * 已解析的 map 缓存。滚动时每次落盘都要「读 → 改 → 写」整张表，重复
 * `JSON.parse` 是纯浪费；用原始字符串做校验，其它页面（或其它标签页）改过
 * 之后仍然会重新解析。
 */
let parsedCache: { raw: string; map: ProgressMap } | null = null;

/** 把任意持久化值收敛成不会污染恢复位置 / 排序的进度记录。 */
export function sanitizeReadingProgress(
  value: unknown,
  storyPath: string
): ReadingProgress | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const source = value as Partial<ReadingProgress>;
  const percentage =
    typeof source.percentage === "number" && Number.isFinite(source.percentage)
      ? Math.max(0, Math.min(1, source.percentage))
      : 0;
  const updatedAt =
    typeof source.updatedAt === "number" && Number.isFinite(source.updatedAt)
      ? source.updatedAt
      : 0;
  const currentPage =
    typeof source.currentPage === "number" && Number.isFinite(source.currentPage)
      ? Math.max(0, Math.trunc(source.currentPage))
      : undefined;
  const scrollTop =
    typeof source.scrollTop === "number" && Number.isFinite(source.scrollTop)
      ? Math.max(0, source.scrollTop)
      : undefined;
  const anchorIndex =
    typeof source.anchorIndex === "number" && Number.isFinite(source.anchorIndex)
      ? Math.max(0, Math.trunc(source.anchorIndex))
      : undefined;
  const anchorOffset =
    typeof source.anchorOffset === "number" && Number.isFinite(source.anchorOffset)
      ? source.anchorOffset
      : undefined;
  return {
    // map 的 key 才是记录归属；损坏数据里的内嵌 storyPath 不能把 A 篇恢复
    // 到 B 篇，更不能让后续 flush 写错 key。
    storyPath,
    percentage,
    currentPage,
    scrollTop,
    anchorIndex,
    anchorOffset,
    readingMode: source.readingMode === "paged" ? "paged" : "scroll",
    updatedAt,
    storyName:
      typeof source.storyName === "string" && source.storyName.trim()
        ? source.storyName
        : undefined,
    storyCode:
      source.storyCode === null || typeof source.storyCode === "string"
        ? source.storyCode
        : undefined,
  };
}

/** 解析整张进度表；坏条目逐条丢弃，而不是让一个 NaN 拖垮全部恢复。 */
export function deserializeProgressMap(raw: string | null): ProgressMap {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const result: ProgressMap = {};
    for (const [path, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (!path) continue;
      const entry = sanitizeReadingProgress(value, path);
      if (entry) result[path] = entry;
    }
    return result;
  } catch {
    return {};
  }
}

function readProgressMap(): ProgressMap {
  if (!isBrowser) return {};
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (!stored) return {};
    if (parsedCache && parsedCache.raw === stored) return parsedCache.map;
    const parsed = deserializeProgressMap(stored);
    parsedCache = { raw: stored, map: parsed };
    return parsed;
  } catch {
    return {};
  }
}

function prune(map: ProgressMap): ProgressMap {
  const keys = Object.keys(map);
  if (keys.length <= MAX_ENTRIES) return map;
  const kept = keys
    .sort((a, b) => (map[b]?.updatedAt ?? 0) - (map[a]?.updatedAt ?? 0))
    .slice(0, MAX_ENTRIES);
  const next: ProgressMap = {};
  for (const key of kept) next[key] = map[key];
  return next;
}

/** 失败提示的会话级闩锁：滚动落盘可达每 1.2s 一次，同一轮失败只提醒一次。 */
let persistFailureNotified = false;

/**
 * quota 满时没写进盘的进度，按 storyPath 暂存。pending 是实例级 ref，而
 * 换篇 effect 会无条件把它重置——失败后滞留重试的那份进度以前就死在这一步，
 * 「将自动重试」的提示成了空话。折进模块级暂存后，之后任何一次成功落盘都
 * 会把它们带上并清空。每份暂存同时保留写失败前读到的盘上基线；若其它窗口
 * 已改过该记录，重试必须丢弃暂存，不能靠可能回拨的墙钟猜新旧。
 */
interface FailedProgressWrite {
  entry: ReadingProgress;
  baseline: ReadingProgress | null;
}

const failedProgressWrites = new Map<string, FailedProgressWrite>();

/** 比较“盘上基线是否仍未改变”；不依赖可能回拨或碰撞的 updatedAt。 */
export function sameProgressSnapshot(
  left: ReadingProgress | null,
  right: ReadingProgress | null
): boolean {
  if (left === right) return true;
  if (!left || !right) return false;
  return (
    left.storyPath === right.storyPath &&
    left.percentage === right.percentage &&
    left.currentPage === right.currentPage &&
    left.scrollTop === right.scrollTop &&
    left.anchorIndex === right.anchorIndex &&
    left.anchorOffset === right.anchorOffset &&
    left.readingMode === right.readingMode &&
    left.updatedAt === right.updatedAt &&
    left.storyName === right.storyName &&
    left.storyCode === right.storyCode
  );
}

export function shouldRetryFailedProgress(
  baseline: ReadingProgress | null,
  currentDisk: ReadingProgress | null
): boolean {
  return sameProgressSnapshot(baseline, currentDisk);
}

/** 仅当盘上仍等于失败时基线，才把暂存重试叠到整表上。 */
function overlayFailedWrites(map: ProgressMap): ProgressMap {
  if (failedProgressWrites.size === 0) return map;
  const next = { ...map };
  for (const [key, failed] of failedProgressWrites) {
    const disk = map[key] ?? null;
    if (!shouldRetryFailedProgress(failed.baseline, disk)) {
      failedProgressWrites.delete(key);
      continue;
    }
    next[key] = failed.entry;
  }
  return next;
}

/** 读某篇的最新已知进度；盘上偏离失败基线时以跨窗口更新为准。 */
function readLatestKnown(path: string): ReadingProgress | null {
  const disk = readProgressMap()[path] ?? null;
  const stashed = failedProgressWrites.get(path);
  if (stashed) {
    if (shouldRetryFailedProgress(stashed.baseline, disk)) return stashed.entry;
    failedProgressWrites.delete(path);
  }
  return disk;
}

/** @returns 是否真的写进了 localStorage（quota 满等失败时返回 false）。 */
function writeProgressMap(map: ProgressMap): boolean {
  if (!isBrowser) return true;
  try {
    const pruned = prune(map);
    const raw = JSON.stringify(pruned);
    window.localStorage.setItem(STORAGE_KEY, raw);
    parsedCache = { raw, map: pruned };
    return true;
  } catch {
    // setItem 失败是原子的：盘上还是旧数据。让调用方决定要不要留着重试。
    return false;
  }
}

/**
 * 是否值得再写一次盘。连续滚动会以每帧一次的频率调用 `updateProgress`，
 * 但把「差半行」的位移也写进 localStorage 毫无意义。
 */
export function isWorthPersisting(
  next: ReadingProgress,
  last: ReadingProgress | null
): boolean {
  if (!last || last.storyPath !== next.storyPath) return true;
  if (last.readingMode !== next.readingMode) return true;
  if (last.currentPage !== next.currentPage) return true;
  if (last.anchorIndex !== next.anchorIndex) return true;
  if (last.storyName !== next.storyName || last.storyCode !== next.storyCode) return true;
  // 读到结尾 / 回到开头是有意义的状态跃迁，必须记下来。
  if ((next.percentage >= 0.999) !== (last.percentage >= 0.999)) return true;
  if ((next.percentage <= 0.001) !== (last.percentage <= 0.001)) return true;
  if (Math.abs(next.percentage - last.percentage) >= MIN_PERCENTAGE_DELTA) return true;
  return Math.abs((next.scrollTop ?? 0) - (last.scrollTop ?? 0)) >= MIN_SCROLL_DELTA_PX;
}

/** 墙钟回拨时最多再等一个节流窗口，绝不排出数小时甚至数年的定时器。 */
export function progressPersistDelay(
  now: number,
  lastWrite: number,
  throttleMs = PERSIST_THROTTLE_MS
): number {
  if (!Number.isFinite(now) || !Number.isFinite(lastWrite) || !Number.isFinite(throttleMs)) {
    return 0;
  }
  const windowMs = Math.max(0, throttleMs);
  return Math.min(windowMs, Math.max(0, windowMs - (now - lastWrite)));
}

/**
 * 把 0~1 的“已读比例”换成分页下标。进度记录的分页比例是
 * `(currentPage + 1) / totalPages`，所以逆变换应是 ceil 后减一；旧的
 * `round(percentage * lastPage)` 在偶数页中段会系统性多跳一页。
 */
export function pageIndexFromPercentage(percentage: number, totalPages: number): number {
  const pages = Math.max(1, Math.trunc(totalPages));
  const ratio = Number.isFinite(percentage) ? Math.max(0, Math.min(1, percentage)) : 0;
  return Math.max(0, Math.min(pages - 1, Math.ceil(ratio * pages) - 1));
}

/**
 * 所有活跃 hook 实例的强制冲刷入口。
 *
 * 阅读器由 KeepAlive 常驻挂载，返回列表时不会卸载，卸载冲刷永远不跑；而
 * 关闭方（App.closeReader）是同步派发 `app:home-refresh` 的——监听方会在
 * 本组件收到 `active=false` 之前就回读 localStorage。所以只能由关闭方在
 * 广播之前调这里，把还压在节流窗口里的进度先落盘。
 */
const activeFlushers = new Set<() => void>();

/** 立即把所有实例待写的阅读进度强制落盘（没有待写时是 no-op）。 */
export function flushReadingProgressWrites(): void {
  activeFlushers.forEach((flush) => flush());
}

export interface UseReadingProgressOptions {
  /**
   * 是否让 `progress` 跟着每次落盘更新。
   *
   * 默认 `true`（列表 / 卡片这类要跟着进度重画的地方需要）。阅读器只在挂载
   * 时读一次初始值、之后一律走 `getProgress()`，把它关掉就能省掉「滚动中
   * 每 1.2s 冲刷一次 → 整棵阅读器重渲染一次」的开销。
   */
  trackState?: boolean;
  /** KeepAlive 阅读器退到后台时关闭定时器、全局冲刷监听和后续更新。 */
  active?: boolean;
}

/**
 * 每篇剧情的阅读进度。
 *
 * 写入治理：`updateProgress` 可以按帧调用，内部只把最新快照暂存在 ref 里，
 * 落盘按 `PERSIST_THROTTLE_MS` 节流并跳过无意义的微小位移；切篇 / 卸载 /
 * 切到后台时强制冲刷，保证不丢最后一次位置。返回的 `progress` 同样只在
 * 冲刷时同步——阅读器只在「换篇 / 换模式」时读它，按帧更新 state 只会让
 * 上千段的正文跟着重渲染。
 */
export function useReadingProgress(
  storyPath: string | null,
  options?: UseReadingProgressOptions
) {
  const [progress, setProgress] = useState<ReadingProgress | null>(() => {
    if (!storyPath) return null;
    return readLatestKnown(storyPath);
  });

  /** 最新的合并结果（含尚未落盘的部分），也是下一次合并的基准。 */
  const latestRef = useRef<ReadingProgress | null>(progress);
  const pendingRef = useRef<ReadingProgress | null>(null);
  const lastPersistedRef = useRef<ReadingProgress | null>(progress);
  const lastWriteRef = useRef(0);
  const writeTimerRef = useRef<number | null>(null);
  // 用 ref 兜住：调用方可以在渲染中途改主意，但落盘回调不该因此换身份。
  const trackStateRef = useRef(options?.trackState ?? true);
  trackStateRef.current = options?.trackState ?? true;
  const activeRef = useRef(options?.active ?? true);
  activeRef.current = options?.active ?? true;

  // 冲刷跑在 setTimeout / pagehide / 模块级冲刷入口里，通过 ref 取最新 toast 句柄。
  const toast = useToast();
  const toastRef = useRef(toast);
  useEffect(() => {
    toastRef.current = toast;
  }, [toast]);

  useEffect(() => {
    if (!storyPath) {
      latestRef.current = null;
      lastPersistedRef.current = null;
      setProgress(null);
      return;
    }
    // 回到 quota 失败过的篇目时，暂存里那份比盘上新——不读它的话恢复位置
    // 会跳回旧进度，后续合并也从过期基准出发。
    const stored = readLatestKnown(storyPath);
    latestRef.current = stored;
    lastPersistedRef.current = stored;
    // 换篇前的 cleanup 已经 force 冲刷过：成功则 pending 本来就空，失败则
    // 那份进度已折进 failedProgressWrites，这里重置不会弄丢它。
    pendingRef.current = null;
    setProgress(stored);
  }, [storyPath]);

  const clearTimer = useCallback(() => {
    if (writeTimerRef.current !== null) {
      if (isBrowser) window.clearTimeout(writeTimerRef.current);
      writeTimerRef.current = null;
    }
  }, []);

  const flushPending = useCallback(
    (force = false) => {
      clearTimer();
      const pending = pendingRef.current;
      if (!pending) {
        // 没有新进度、只剩 quota 失败后滞留的重试：趁强制冲刷（换篇 /
        // 切后台 / 关阅读器）的时机再试一次，不用等下一次滚动。
        if (force && failedProgressWrites.size > 0) {
          if (writeProgressMap(overlayFailedWrites(readProgressMap()))) {
            failedProgressWrites.clear();
            persistFailureNotified = false;
          }
        }
        return;
      }
      if (!force && !isWorthPersisting(pending, lastPersistedRef.current)) {
        // 留着 pending：真正离开页面时还会以 force 冲刷一次。
        return;
      }
      // 成败都推进节流窗口：quota 满时不能退化成「每次滚动都重写整张表」。
      lastWriteRef.current = Date.now();
      const diskMap = readProgressMap();
      const map = overlayFailedWrites(diskMap);
      if (!writeProgressMap({ ...map, [pending.storyPath]: pending })) {
        // 写失败（quota 满 / 隐私模式）时不能把
        // lastPersistedRef 推进到一个从没上过盘的值——否则这份进度就被
        // 无声丢弃：closeReader / pagehide / 切篇的强制冲刷全都会 no-op，
        // 哪怕之后配额被清理腾出来（启动期就会清历史搜索缓存）也救不回。
        // 静默失败还等于骗用户「进度已记住」：阅读照常、重启后却回到旧
        // 位置。收藏 / 划线 / 阅读设置的同类失败都会提示，这里补齐。
        // 折进模块级暂存：pending 是实例级的，换篇 effect 会把它重置、
        // 卸载会把它连实例一起回收，暂存才是「自动重试」真正的载体。
        const previousFailure = failedProgressWrites.get(pending.storyPath);
        failedProgressWrites.set(pending.storyPath, {
          entry: pending,
          baseline: previousFailure?.baseline ?? diskMap[pending.storyPath] ?? null,
        });
        // 模块级 stash 已经接管重试。若继续把同一快照留在 pending，别的窗口
        // 改盘后即使 overlay 丢掉 stash，下面这份 pending 仍会把旧位置写回去。
        pendingRef.current = null;
        if (!persistFailureNotified) {
          persistFailureNotified = true;
          toastRef.current.warn("阅读进度未能保存到本地存储（空间可能已满），将自动重试");
        }
        return;
      }
      // 这次成功的写入已把暂存的重试一并带上盘，清空以免下次再叠旧数据。
      persistFailureNotified = false;
      failedProgressWrites.clear();
      pendingRef.current = null;
      lastPersistedRef.current = pending;
      if (trackStateRef.current) setProgress(pending);
    },
    [clearTimer]
  );

  const updateProgress = useCallback(
    (partial: Partial<ReadingProgress>) => {
      if (!storyPath || !activeRef.current) return;
      let prev =
        latestRef.current && latestRef.current.storyPath === storyPath ? latestRef.current : null;
      const failed = failedProgressWrites.get(storyPath);
      if (failed) {
        const disk = readProgressMap()[storyPath] ?? null;
        if (!shouldRetryFailedProgress(failed.baseline, disk)) {
          // 失败以后别的窗口推进过这篇：先采用外部基线，再叠加本次真实交互。
          // 这样用户继续翻页可以获胜，但单纯的旧 stash 重试绝不会回滚外部进度。
          failedProgressWrites.delete(storyPath);
          prev = disk;
          latestRef.current = disk;
          lastPersistedRef.current = disk;
        }
      }
      const merged: ReadingProgress = {
        storyPath,
        percentage: partial.percentage ?? prev?.percentage ?? 0,
        currentPage: partial.currentPage ?? prev?.currentPage,
        scrollTop: partial.scrollTop ?? prev?.scrollTop,
        anchorIndex: partial.anchorIndex ?? prev?.anchorIndex,
        anchorOffset: partial.anchorOffset ?? prev?.anchorOffset,
        readingMode: partial.readingMode ?? prev?.readingMode ?? "scroll",
        updatedAt: partial.updatedAt ?? Date.now(),
        storyName: partial.storyName ?? prev?.storyName,
        // null 是有意义的清除值：数据更新后同一篇剧情可能不再带关卡号。
        // 用 `??` 会把调用方明确传入的 null 当成缺省，旧 storyCode 因而
        // 永久残留在「继续阅读」卡片里。
        storyCode: partial.storyCode !== undefined ? partial.storyCode : prev?.storyCode,
      };

      latestRef.current = merged;
      pendingRef.current = merged;

      if (writeTimerRef.current !== null) return;
      // Date.now() 是墙钟，NTP 校时 / 手动改时间会往回跳：elapsed 为负时
      // 「窗口 - elapsed」会算出远超一个节流窗口的延时，而定时器一旦挂上，
      // 后续 updateProgress 都在上面提前返回、不会重排——周期性落盘就此
      // 停摆，只剩强制冲刷兜底，进程被杀就丢掉回拨后的全部进度。把延时
      // 钳回一个节流窗口；时钟单调时 elapsed ≥ 0，这个钳位恒为 no-op。
      const delay = progressPersistDelay(Date.now(), lastWriteRef.current);
      if (!isBrowser) {
        flushPending();
        return;
      }
      writeTimerRef.current = window.setTimeout(() => flushPending(), delay);
    },
    [storyPath, flushPending]
  );

  // 注册到模块级冲刷入口，供关闭阅读器的一方在广播 home-refresh 前调用。
  useEffect(() => {
    if (!(options?.active ?? true)) {
      flushPending(true);
      return;
    }
    const flush = () => flushPending(true);
    activeFlushers.add(flush);
    return () => {
      activeFlushers.delete(flush);
    };
  }, [flushPending, options?.active]);

  // 切到后台 / 关标签页时强制落盘：移动端多数情况下根本不会触发 unmount。
  useEffect(() => {
    if (!isBrowser || !(options?.active ?? true)) return;
    const handleHide = () => {
      if (document.visibilityState === "hidden") flushPending(true);
    };
    const handlePageHide = () => flushPending(true);
    document.addEventListener("visibilitychange", handleHide);
    window.addEventListener("pagehide", handlePageHide);
    return () => {
      document.removeEventListener("visibilitychange", handleHide);
      window.removeEventListener("pagehide", handlePageHide);
    };
  }, [flushPending, options?.active]);

  // 卸载 / 换篇时冲刷，避免丢掉最后一次滚动位置。
  useEffect(() => {
    return () => {
      flushPending(true);
    };
  }, [flushPending, storyPath]);

  /**
   * 同步读取最新进度（含尚未落盘的部分）。恢复阅读位置是在 layout effect 里
   * 做的，那时候 `progress` state 可能还停在上一篇；这个函数按 `storyPath`
   * 自己对账，读不到就回落到 localStorage。
   */
  const getProgress = useCallback((): ReadingProgress | null => {
    if (!storyPath) return null;
    const latest = latestRef.current;
    if (latest && latest.storyPath === storyPath) return latest;
    return readLatestKnown(storyPath);
  }, [storyPath]);

  /**
   * 强制冲刷本实例待写的进度（无待写时是 no-op）。阅读器在 `active` 翻
   * false 时调用：KeepAlive 不卸载它，不冲的话最后 ≤1.2s 的节流写入要等
   * 下一次 focus 才会被首页 / 列表读到。
   */
  const flushProgress = useCallback(() => {
    flushPending(true);
  }, [flushPending]);

  const clearProgress = useCallback(() => {
    if (!storyPath) return;
    clearTimer();
    pendingRef.current = null;
    latestRef.current = null;
    lastPersistedRef.current = null;
    // 暂存里若还压着这篇的失败重试，也一并清掉——不然下一次成功冲刷会把
    // 刚清除的进度又复活回来。
    failedProgressWrites.delete(storyPath);
    setProgress(null);
    const map = readProgressMap();
    if (storyPath in map) {
      const next = { ...map };
      delete next[storyPath];
      writeProgressMap(next);
    }
  }, [storyPath, clearTimer]);

  return useMemo(
    () => ({
      progress,
      updateProgress,
      clearProgress,
      getProgress,
      flushProgress,
    }),
    [progress, updateProgress, clearProgress, getProgress, flushProgress]
  );
}
