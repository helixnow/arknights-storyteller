import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReaderSettings } from "@/hooks/useReaderSettings";

export interface ReadingProgress {
  storyPath: string;
  percentage: number;
  currentPage?: number;
  scrollTop?: number;
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

function readProgressMap(): ProgressMap {
  if (!isBrowser) return {};
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (!stored) return {};
    if (parsedCache && parsedCache.raw === stored) return parsedCache.map;
    const parsed = JSON.parse(stored) as ProgressMap;
    if (!parsed || typeof parsed !== "object") return {};
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

function writeProgressMap(map: ProgressMap) {
  if (!isBrowser) return;
  try {
    const pruned = prune(map);
    const raw = JSON.stringify(pruned);
    window.localStorage.setItem(STORAGE_KEY, raw);
    parsedCache = { raw, map: pruned };
  } catch {
    // ignore quota errors
  }
}

/**
 * 是否值得再写一次盘。连续滚动会以每帧一次的频率调用 `updateProgress`，
 * 但把「差半行」的位移也写进 localStorage 毫无意义。
 */
function isWorthPersisting(next: ReadingProgress, last: ReadingProgress | null): boolean {
  if (!last || last.storyPath !== next.storyPath) return true;
  if (last.readingMode !== next.readingMode) return true;
  if (last.currentPage !== next.currentPage) return true;
  if (last.storyName !== next.storyName || last.storyCode !== next.storyCode) return true;
  // 读到结尾 / 回到开头是有意义的状态跃迁，必须记下来。
  if ((next.percentage >= 0.999) !== (last.percentage >= 0.999)) return true;
  if ((next.percentage <= 0.001) !== (last.percentage <= 0.001)) return true;
  if (Math.abs(next.percentage - last.percentage) >= MIN_PERCENTAGE_DELTA) return true;
  return Math.abs((next.scrollTop ?? 0) - (last.scrollTop ?? 0)) >= MIN_SCROLL_DELTA_PX;
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
export function useReadingProgress(storyPath: string | null) {
  const [progress, setProgress] = useState<ReadingProgress | null>(() => {
    if (!storyPath) return null;
    return readProgressMap()[storyPath] ?? null;
  });

  /** 最新的合并结果（含尚未落盘的部分），也是下一次合并的基准。 */
  const latestRef = useRef<ReadingProgress | null>(progress);
  const pendingRef = useRef<ReadingProgress | null>(null);
  const lastPersistedRef = useRef<ReadingProgress | null>(progress);
  const lastWriteRef = useRef(0);
  const writeTimerRef = useRef<number | null>(null);

  useEffect(() => {
    if (!storyPath) {
      latestRef.current = null;
      lastPersistedRef.current = null;
      setProgress(null);
      return;
    }
    const stored = readProgressMap()[storyPath] ?? null;
    latestRef.current = stored;
    lastPersistedRef.current = stored;
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
      if (!pending) return;
      if (!force && !isWorthPersisting(pending, lastPersistedRef.current)) {
        // 留着 pending：真正离开页面时还会以 force 冲刷一次。
        return;
      }
      pendingRef.current = null;
      lastPersistedRef.current = pending;
      lastWriteRef.current = Date.now();
      const map = readProgressMap();
      writeProgressMap({ ...map, [pending.storyPath]: pending });
      setProgress(pending);
    },
    [clearTimer]
  );

  const updateProgress = useCallback(
    (partial: Partial<ReadingProgress>) => {
      if (!storyPath) return;
      const prev =
        latestRef.current && latestRef.current.storyPath === storyPath ? latestRef.current : null;
      const merged: ReadingProgress = {
        storyPath,
        percentage: partial.percentage ?? prev?.percentage ?? 0,
        currentPage: partial.currentPage ?? prev?.currentPage,
        scrollTop: partial.scrollTop ?? prev?.scrollTop,
        readingMode: partial.readingMode ?? prev?.readingMode ?? "scroll",
        updatedAt: partial.updatedAt ?? Date.now(),
        storyName: partial.storyName ?? prev?.storyName,
        storyCode: partial.storyCode ?? prev?.storyCode,
      };

      latestRef.current = merged;
      pendingRef.current = merged;

      if (writeTimerRef.current !== null) return;
      const delay = Math.max(0, PERSIST_THROTTLE_MS - (Date.now() - lastWriteRef.current));
      if (!isBrowser) {
        flushPending();
        return;
      }
      writeTimerRef.current = window.setTimeout(() => flushPending(), delay);
    },
    [storyPath, flushPending]
  );

  // 切到后台 / 关标签页时强制落盘：移动端多数情况下根本不会触发 unmount。
  useEffect(() => {
    if (!isBrowser) return;
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
  }, [flushPending]);

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
    return readProgressMap()[storyPath] ?? null;
  }, [storyPath]);

  const clearProgress = useCallback(() => {
    if (!storyPath) return;
    clearTimer();
    pendingRef.current = null;
    latestRef.current = null;
    lastPersistedRef.current = null;
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
    }),
    [progress, updateProgress, clearProgress, getProgress]
  );
}
