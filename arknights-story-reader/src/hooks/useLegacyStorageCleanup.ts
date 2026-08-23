import { useEffect } from "react";

/**
 * One-shot migration that purges localStorage keys left over from features
 * we've removed (line-of-clues sets, first-time highlight toast, etc.).
 *
 * The "migration ran" bit is a monotonic number, and every step only lists the
 * keys that step introduced, so bumping the version doesn't re-scan history.
 */
const CLEANUP_SENTINEL_KEY = "arknights-legacy-cleanup-version";

const CLEANUP_STEPS: Array<{ version: number; keys: string[] }> = [
  {
    version: 1,
    keys: [
      // Removed 2026-05: "线索集" feature.
      "arknights-clue-sets-v1",
      "arknights-default-clue-set-id",
      // First-run toast that told users about the default clue set — no longer
      // relevant now that highlights stay local only.
      "arknights-highlight-intro-shown",
    ],
  },
];

const CLEANUP_VERSION = CLEANUP_STEPS[CLEANUP_STEPS.length - 1]?.version ?? 0;

type IdleWindow = Window & {
  requestIdleCallback?: (callback: () => void, options?: { timeout: number }) => number;
  cancelIdleCallback?: (handle: number) => void;
};

function runCleanup(): void {
  try {
    const stored = Number.parseInt(window.localStorage.getItem(CLEANUP_SENTINEL_KEY) ?? "", 10);
    const ranVersion = Number.isFinite(stored) ? stored : 0;
    if (ranVersion >= CLEANUP_VERSION) return;

    for (const step of CLEANUP_STEPS) {
      if (step.version <= ranVersion) continue;
      for (const key of step.keys) {
        try {
          window.localStorage.removeItem(key);
        } catch {
          // Individual failures are harmless; the next boot retries.
        }
      }
    }
    window.localStorage.setItem(CLEANUP_SENTINEL_KEY, String(CLEANUP_VERSION));
  } catch {
    // Private-mode / quota — ignore.
  }
}

export function useLegacyStorageCleanup() {
  useEffect(() => {
    if (typeof window === "undefined") return;

    // Nothing here is urgent, so stay off the first-paint critical path.
    const idleWindow = window as IdleWindow;
    if (typeof idleWindow.requestIdleCallback === "function") {
      const handle = idleWindow.requestIdleCallback(runCleanup, { timeout: 3000 });
      return () => idleWindow.cancelIdleCallback?.(handle);
    }

    const timer = window.setTimeout(runCleanup, 1200);
    return () => window.clearTimeout(timer);
  }, []);
}
