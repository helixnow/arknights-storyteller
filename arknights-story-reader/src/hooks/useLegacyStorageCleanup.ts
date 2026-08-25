import { useEffect } from "react";
import {
  cleanupVersionFrom,
  pendingCleanupKeys,
  type CleanupStep,
} from "@/lib/appShellLogic";

/**
 * One-shot migration that purges localStorage keys left over from features
 * we've removed (line-of-clues sets, first-time highlight toast, etc.).
 *
 * The "migration ran" bit is a monotonic number, and every step only lists the
 * keys that step introduced, so bumping the version doesn't re-scan history.
 *
 * INVARIANT: every key listed in `CLEANUP_STEPS` must be dead — no live code
 * may read or write it. Grep the codebase before adding a key here. Keys that
 * a live feature still migrates from (e.g. the prefs hook upgrading its own
 * v1 key) belong to that feature, not to this list.
 */
const CLEANUP_SENTINEL_KEY = "arknights-legacy-cleanup-version";

const CLEANUP_STEPS: CleanupStep[] = [
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
  {
    version: 2,
    keys: [
      // 2026-08：INDEX_VERSION 7→8 修复了索引语料（引号内 `]`、单引号说话人、
      // 状态残渣），但缓存按数据 commit 命中、察觉不到 parser 变化，旧缓存会
      // 一直命中脏结果，所以 SearchPanel 把键换成了 v3/v2。旧键自此无人读写，
      // 每条却可能压着最多 40 页搜索结果，白占配额，在这里删掉。
      "arknights-story-search-cache-v2",
      "arknights-story-segment-cache-v1",
    ],
  },
  {
    version: 3,
    keys: [
      // 2026-08：INDEX_VERSION 8→9 修复了索引语料（行尾 `\` 续行拼接、全角
      // 标点残渣），同理数据 commit 不变、旧缓存察觉不到，SearchPanel 把键
      // 换成了 v4/v3。旧键自此无人读写，在这里删掉。
      "arknights-story-search-cache-v3",
      "arknights-story-segment-cache-v2",
    ],
  },
  {
    version: 4,
    keys: [
      // 搜索缓存最早的一代键。换代到 v2 时没有顺手删除，也一直漏在这张表
      // 外面；那一代的写入还没有 LRU 上限，每个搜过的词都整页整页地存，
      // 老用户可能压着几 MB 的死数据。localStorage 配额是整个应用共享的，
      // 白占的这块正是阅读进度「quota 满写不进」故障的直接推手。
      "arknights-story-search-cache-v1",
    ],
  },
  {
    version: 5,
    keys: [
      // 2026-08：INDEX_VERSION 9→10 后缓存键带上 index 后缀
      // （…-v5-index10 / …-v4-index10）。换代时漏删了无后缀的上一代死键，
      // 每条最多压 40 页结果，继续占配额。
      "arknights-story-search-cache-v4",
      "arknights-story-segment-cache-v3",
    ],
  },
];

const CLEANUP_VERSION = CLEANUP_STEPS[CLEANUP_STEPS.length - 1]?.version ?? 0;

type IdleWindow = Window & {
  requestIdleCallback?: (callback: () => void, options?: { timeout: number }) => number;
  cancelIdleCallback?: (handle: number) => void;
};

/**
 * Session-level one-shot latch. The sentinel already makes cleanup one-shot
 * across boots, but when writing it fails (private mode) a hook remount
 * would otherwise re-scan every time; the latch caps it at once per session
 * while the next boot still retries.
 */
let ranThisSession = false;

function runCleanup(): void {
  if (ranThisSession) return;
  ranThisSession = true;
  try {
    const ranVersion = cleanupVersionFrom(
      window.localStorage.getItem(CLEANUP_SENTINEL_KEY)
    );
    if (ranVersion >= CLEANUP_VERSION) return;

    let allRemoved = true;
    for (const key of pendingCleanupKeys(
      ranVersion,
      CLEANUP_STEPS,
      CLEANUP_SENTINEL_KEY
    )) {
      try {
        window.localStorage.removeItem(key);
      } catch {
        // Individual failures are harmless in themselves (the key is dead
        // either way), but they must hold the sentinel back — advancing it
        // anyway would mark the failed step as done and the leftover key
        // would squat on quota forever. Removals are idempotent, so the
        // next boot simply re-runs the whole batch.
        allRemoved = false;
      }
    }
    if (allRemoved) {
      window.localStorage.setItem(CLEANUP_SENTINEL_KEY, String(CLEANUP_VERSION));
    }
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
