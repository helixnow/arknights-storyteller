import { useEffect } from "react";

/**
 * One-shot migration that purges localStorage keys left over from features
 * we've removed (line-of-clues sets, first-time highlight toast, etc.).
 *
 * We key the "migration ran" bit by a monotonic number so it's cheap to
 * extend in the future without re-running the entire cleanup every boot.
 */
const CLEANUP_SENTINEL_KEY = "arknights-legacy-cleanup-version";
const CLEANUP_VERSION = "1";

const LEGACY_KEYS = [
  // Removed 2026-05: "线索集" feature.
  "arknights-clue-sets-v1",
  "arknights-default-clue-set-id",
  // First-run toast that told users about the default clue set — no longer
  // relevant now that highlights stay local only.
  "arknights-highlight-intro-shown",
];

export function useLegacyStorageCleanup() {
  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      if (window.localStorage.getItem(CLEANUP_SENTINEL_KEY) === CLEANUP_VERSION) return;
      for (const key of LEGACY_KEYS) {
        try {
          window.localStorage.removeItem(key);
        } catch {
          // Individual failures are harmless; surface only through devtools.
        }
      }
      window.localStorage.setItem(CLEANUP_SENTINEL_KEY, CLEANUP_VERSION);
    } catch {
      // Private-mode / quota — ignore.
    }
  }, []);
}
