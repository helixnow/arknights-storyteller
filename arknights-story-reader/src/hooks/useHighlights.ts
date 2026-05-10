import { useCallback, useEffect, useMemo, useRef, useState } from "react";

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
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object") {
        return parsed as HighlightStore;
      }
    }
  } catch {
    // ignore corrupted storage
  }
  return {};
}

function normalizeEntry(item: HighlightLike): HighlightEntry | null {
  if (typeof item === "number") {
    if (!Number.isFinite(item) || item < 0) return null;
    return { segmentIndex: Math.trunc(item) };
  }
  if (item && typeof item === "object" && typeof item.segmentIndex === "number") {
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
 *   write, not one per toggle.
 */
export function useHighlights(storyPath: string, segmentDigests?: readonly string[]) {
  const [store, setStore] = useState<HighlightStore>(() => readStorage());

  // Persist on change — but coalesce bursts. `store` updates from toggle /
  // clear land in the same microtask most of the time, so waiting one tick
  // lets us serialise only once per React commit.
  const persistTimerRef = useRef<number | null>(null);
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (persistTimerRef.current !== null) {
      window.clearTimeout(persistTimerRef.current);
    }
    persistTimerRef.current = window.setTimeout(() => {
      try {
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
      } catch {
        // ignore quota errors
      }
      persistTimerRef.current = null;
    }, 0);
    return () => {
      if (persistTimerRef.current !== null) {
        window.clearTimeout(persistTimerRef.current);
        persistTimerRef.current = null;
      }
    };
  }, [store]);

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
   * Effective highlight indices for the current story — remapped via the
   * digest table when available so annotations survive data-version
   * upgrades. Returned as `{ array, set }` so renderers and hot-path
   * lookups don't have to pay the list-scan cost.
   */
  const { highlightList, highlightSet } = useMemo(() => {
    const resolved = new Set<number>();
    for (const entry of entries) {
      let effective = entry.segmentIndex;
      if (digestIndex && entry.digest) {
        const hit = digestIndex.get(entry.digest);
        if (typeof hit === "number") {
          effective = hit;
        }
      }
      if (segmentDigests && (effective < 0 || effective >= segmentDigests.length)) {
        continue;
      }
      resolved.add(effective);
    }
    const sorted = Array.from(resolved).sort((a, b) => a - b);
    return { highlightList: sorted, highlightSet: resolved };
  }, [entries, digestIndex, segmentDigests]);

  const isHighlighted = useCallback(
    (segmentIndex: number) => highlightSet.has(segmentIndex),
    [highlightSet]
  );

  /**
   * Toggle a highlight. When adding, we capture the current digest so
   * future data-version shifts can re-align the annotation to the same
   * content rather than to whatever segment happens to keep this index.
   */
  const toggleHighlight = useCallback(
    (segmentIndex: number) => {
      const digest = segmentDigests?.[segmentIndex];
      setStore((prev) => {
        const rawList = prev[storyPath] ?? [];
        const current: HighlightEntry[] = [];
        for (const item of rawList) {
          const n = normalizeEntry(item);
          if (n) current.push(n);
        }

        // Determine whether `segmentIndex` is currently highlighted under
        // the _effective_ (digest-remapped) index.
        const effectiveIndexOf = (entry: HighlightEntry): number => {
          if (digestIndex && entry.digest) {
            const idx = digestIndex.get(entry.digest);
            if (typeof idx === "number") return idx;
          }
          return entry.segmentIndex;
        };

        let isPresent = false;
        for (const entry of current) {
          if (effectiveIndexOf(entry) === segmentIndex) {
            isPresent = true;
            break;
          }
        }

        const next = isPresent
          ? current.filter((entry) => effectiveIndexOf(entry) !== segmentIndex)
          : [...current, { segmentIndex, digest }];
        next.sort((a, b) => a.segmentIndex - b.segmentIndex);
        return { ...prev, [storyPath]: next };
      });
    },
    [storyPath, segmentDigests, digestIndex]
  );

  const clearHighlights = useCallback(() => {
    setStore((prev) => {
      if (!(storyPath in prev)) {
        return prev;
      }
      const copy = { ...prev };
      delete copy[storyPath];
      return copy;
    });
  }, [storyPath]);

  return {
    highlights: highlightList,
    toggleHighlight,
    isHighlighted,
    clearHighlights,
  };
}
