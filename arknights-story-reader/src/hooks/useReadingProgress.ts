import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReaderSettings } from "@/hooks/useReaderSettings";

export interface ReadingProgress {
  storyPath: string;
  percentage: number;
  currentPage?: number;
  scrollTop?: number;
  readingMode: ReaderSettings["readingMode"];
  updatedAt: number;
}

const STORAGE_KEY = "reading-progress";
/** Minimum gap between localStorage writes while the user is actively scrolling. */
const PERSIST_THROTTLE_MS = 500;

type ProgressMap = Record<string, ReadingProgress>;

const isBrowser = typeof window !== "undefined";

function readProgressMap(): ProgressMap {
  if (!isBrowser) return {};
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (!stored) return {};
    return JSON.parse(stored) as ProgressMap;
  } catch {
    return {};
  }
}

function writeProgressMap(map: ProgressMap) {
  if (!isBrowser) return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(map));
  } catch {
    // ignore quota errors
  }
}

export function useReadingProgress(storyPath: string | null) {
  const [progress, setProgress] = useState<ReadingProgress | null>(() => {
    if (!storyPath) return null;
    const map = readProgressMap();
    return map[storyPath] ?? null;
  });

  useEffect(() => {
    if (!storyPath) {
      setProgress(null);
      return;
    }
    const map = readProgressMap();
    setProgress(map[storyPath] ?? null);
  }, [storyPath]);

  // Throttling state: we always keep React in sync immediately (so the
  // progress bar and "已读 N%" header feel instant), but coalesce
  // localStorage writes to at most one every PERSIST_THROTTLE_MS.
  const pendingRef = useRef<ReadingProgress | null>(null);
  const lastWriteRef = useRef<number>(0);
  const writeTimerRef = useRef<number | null>(null);

  const flushPending = useCallback(() => {
    writeTimerRef.current = null;
    const pending = pendingRef.current;
    if (!pending) return;
    pendingRef.current = null;
    const map = readProgressMap();
    map[pending.storyPath] = pending;
    writeProgressMap(map);
    lastWriteRef.current = Date.now();
  }, []);

  const updateProgress = useCallback(
    (partial: Partial<ReadingProgress>) => {
      if (!storyPath) return;
      setProgress((prev) => {
        const merged: ReadingProgress = {
          storyPath,
          percentage: partial.percentage ?? prev?.percentage ?? 0,
          currentPage: partial.currentPage ?? prev?.currentPage,
          scrollTop: partial.scrollTop ?? prev?.scrollTop,
          readingMode: partial.readingMode ?? prev?.readingMode ?? "scroll",
          updatedAt: partial.updatedAt ?? Date.now(),
        };

        // Stage the latest snapshot and schedule a flush. If a flush is
        // already pending nothing to do — it will pick up whatever
        // `pendingRef.current` holds at fire time.
        pendingRef.current = merged;
        if (writeTimerRef.current === null) {
          const elapsed = Date.now() - lastWriteRef.current;
          const delay = Math.max(0, PERSIST_THROTTLE_MS - elapsed);
          if (typeof window !== "undefined") {
            writeTimerRef.current = window.setTimeout(flushPending, delay);
          } else {
            flushPending();
          }
        }
        return merged;
      });
    },
    [storyPath, flushPending]
  );

  // Flush any staged progress on unmount / story switch so we don't lose
  // the last scroll position.
  useEffect(() => {
    return () => {
      if (writeTimerRef.current !== null) {
        if (typeof window !== "undefined") window.clearTimeout(writeTimerRef.current);
        writeTimerRef.current = null;
      }
      flushPending();
    };
  }, [flushPending, storyPath]);

  const clearProgress = useCallback(() => {
    if (!storyPath) return;
    setProgress(null);
    pendingRef.current = null;
    if (writeTimerRef.current !== null && typeof window !== "undefined") {
      window.clearTimeout(writeTimerRef.current);
      writeTimerRef.current = null;
    }
    const map = readProgressMap();
    delete map[storyPath];
    writeProgressMap(map);
  }, [storyPath]);

  return useMemo(
    () => ({
      progress,
      updateProgress,
      clearProgress,
    }),
    [progress, updateProgress, clearProgress]
  );
}
