import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "@/services/api";
import type { StoryEntry } from "@/types/story";
import { Button } from "@/components/ui/button";
import { RefreshCw, Star, FileText } from "lucide-react";
import { SyncDialog } from "@/components/SyncDialog";
import { Collapsible } from "@/components/ui/collapsible";
import { CustomScrollArea } from "@/components/ui/custom-scroll-area";
import { Input } from "@/components/ui/input";
import { useFavorites } from "@/hooks/useFavorites";
import { useAppPreferences } from "@/hooks/useAppPreferences";
import { StoryThumbnail } from "@/components/StoryThumbnail";
import { AssetImage } from "@/components/AssetImage";
import { CharacterAvatar } from "@/components/CharacterAvatar";

/**
 * 从干员密录类 storyTxt 路径里抠出 charId 候选。
 *
 * 历史格式是 `obt/memory/char_002_amiya/*`，直接能拿到 charId。
 * 当前主流格式是 `obt/memory/story_{alias}_N_M`，其中 `{alias}` 就是
 * charId 尾段（如 `kroos`、`amgoat`、`yuki`）。这里返回 alias；由
 * `CharacterAvatar` 内部的 resolver 兜底转成完整 charId。
 */
function extractCharTokenFromStoryTxt(storyTxt: string | null | undefined): string | null {
  if (!storyTxt) return null;
  const direct = storyTxt.match(/obt\/memory\/(char_[^/]+)/i);
  if (direct) return direct[1];
  const storied = storyTxt.match(/obt\/memory\/story_([a-z0-9]+)_/i);
  if (storied) return storied[1].toLowerCase();
  return null;
}

type Category = "favorites" | "main" | "activity" | "sidestory" | "roguelike" | "memory";

const CATEGORY_TABS: Array<{ id: Category; label: string }> = [
  { id: "favorites", label: "收藏" },
  { id: "main", label: "主线剧情" },
  { id: "activity", label: "活动剧情" },
  { id: "sidestory", label: "支线" },
  { id: "roguelike", label: "肉鸽" },
  { id: "memory", label: "干员密录" },
];

const CATEGORY_DESCRIPTIONS: Record<Category, string> = {
  favorites: "收藏喜爱的章节或关卡",
  main: "主线章节",
  activity: "活动剧情列表",
  sidestory: "支线故事",
  roguelike: "肉鸽模式剧情",
  memory: "干员密录故事",
};

const PROGRESS_KEY = "reading-progress";

/** 阅读进度：storyTxt -> 0~1。列表项用它渲染细进度条。 */
function readProgressPercentMap(): Record<string, number> {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(PROGRESS_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, { percentage?: number }>;
    const out: Record<string, number> = {};
    for (const [path, value] of Object.entries(parsed)) {
      if (!value || typeof value !== "object") continue;
      const pct = Number(value.percentage ?? 0);
      if (!Number.isFinite(pct) || pct <= 0) continue;
      out[path] = Math.min(1, Math.max(0, pct));
    }
    return out;
  } catch {
    return {};
  }
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("TIMEOUT")), ms);
    p.then((v) => {
      clearTimeout(timer);
      resolve(v);
    }).catch((e) => {
      clearTimeout(timer);
      reject(e);
    });
  });
}

function isNotInstalledError(message: string) {
  return (
    message.includes("NOT_INSTALLED") ||
    message.includes("No such file") ||
    message === "TIMEOUT"
  );
}

/**
 * 简介（storyInfo）请求队列。一屏可能有 20+ 条目同时要简介，
 * 全部灌进 IPC 会把缩略图/正文请求挤到后面，所以限流到 4 条并发。
 */
const SUMMARY_MAX_INFLIGHT = 4;
const summaryQueue: Array<() => void> = [];
let summaryInflight = 0;

function runSummaryQueue() {
  while (summaryInflight < SUMMARY_MAX_INFLIGHT && summaryQueue.length > 0) {
    const task = summaryQueue.shift();
    if (task) task();
  }
}

function scheduleSummary<T>(task: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    summaryQueue.push(() => {
      summaryInflight += 1;
      task()
        .then(resolve, reject)
        .finally(() => {
          summaryInflight -= 1;
          runSummaryQueue();
        });
    });
    runSummaryQueue();
  });
}

interface StoryListProps {
  onSelectStory: (story: StoryEntry) => void;
}

export function StoryList({ onSelectStory }: StoryListProps) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [mainGrouped, setMainGrouped] = useState<Array<[string, StoryEntry[]]>>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [syncDialogOpen, setSyncDialogOpen] = useState(false);
  const [installed, setInstalled] = useState<boolean | null>(null);
  const [activeCategory, setActiveCategory] = useState<Category>("main");
  const [activityGrouped, setActivityGrouped] = useState<Array<[string, StoryEntry[]]>>([]);
  const [activityLoading, setActivityLoading] = useState(false);
  const [sidestoryGrouped, setSidestoryGrouped] = useState<Array<[string, StoryEntry[]]>>([]);
  const [sidestoryLoading, setSidestoryLoading] = useState(false);
  const [roguelikeGrouped, setRoguelikeGrouped] = useState<Array<[string, StoryEntry[]]>>([]);
  const [roguelikeLoading, setRoguelikeLoading] = useState(false);
  const [memoryStories, setMemoryStories] = useState<StoryEntry[]>([]);
  const [memoryLoading, setMemoryLoading] = useState(false);
  const [searchTerm, setSearchTerm] = useState("");
  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>({});
  const [progressMap, setProgressMap] = useState<Record<string, number>>(() =>
    readProgressPercentMap()
  );
  const { showSummaries, setShowSummaries } = useAppPreferences();
  const [summaryCache, setSummaryCache] = useState<Record<string, string>>({});
  const [summaryLoadingIds, setSummaryLoadingIds] = useState<Record<string, boolean>>({});
  // memorySummaryVisible 改为全局控制
  const memorySummaryVisible = showSummaries;

  // 每个分类是否已加载 / 是否正在加载。用 ref 保存，
  // 这样 loadXxx 能保持稳定引用，effect 不会因为 state 变化重复触发。
  const loadedRef = useRef<Record<Category, boolean>>({
    favorites: true,
    main: false,
    activity: false,
    sidestory: false,
    roguelike: false,
    memory: false,
  });
  const inflightRef = useRef<Partial<Record<Category, boolean>>>({});
  const summaryRequestedRef = useRef<Set<string>>(new Set());

  const {
    favoriteStories,
    favoriteGroups,
    isFavorite,
    toggleFavorite,
    isGroupFavorite,
    toggleFavoriteGroup,
  } = useFavorites();

  const handleLoadError = useCallback((label: string, err: unknown) => {
    const errorMsg = err instanceof Error ? err.message : "加载失败";
    console.error(`[StoryList] 加载${label}失败:`, errorMsg, err);
    if (isNotInstalledError(errorMsg)) {
      setError("未安装或网络缓慢，请先同步数据");
    } else {
      setError("加载失败");
    }
  }, []);

  const loadMainStories = useCallback(
    async (force = false) => {
      if (!force && loadedRef.current.main) return;
      if (inflightRef.current.main) return;
      inflightRef.current.main = true;
      setLoading(true);
      setError(null);
      try {
        const grouped = await withTimeout(api.getMainStoriesGrouped(), 8000);
        console.log("[StoryList] 主线章节数:", grouped.length);
        setMainGrouped(grouped);
        loadedRef.current.main = true;
      } catch (err) {
        handleLoadError("主线剧情", err);
      } finally {
        inflightRef.current.main = false;
        setLoading(false);
      }
    },
    [handleLoadError]
  );

  const loadActivities = useCallback(
    async (force = false) => {
      if (!force && loadedRef.current.activity) return;
      if (inflightRef.current.activity) return;
      inflightRef.current.activity = true;
      setActivityLoading(true);
      setError(null);
      try {
        const grouped = await withTimeout(api.getActivityStoriesGrouped(), 8000);
        console.log("[StoryList] 活动数:", grouped.length);
        setActivityGrouped(grouped);
        loadedRef.current.activity = true;
      } catch (err) {
        handleLoadError("活动剧情", err);
      } finally {
        inflightRef.current.activity = false;
        setActivityLoading(false);
      }
    },
    [handleLoadError]
  );

  const loadSidestories = useCallback(
    async (force = false) => {
      if (!force && loadedRef.current.sidestory) return;
      if (inflightRef.current.sidestory) return;
      inflightRef.current.sidestory = true;
      setSidestoryLoading(true);
      setError(null);
      try {
        const grouped = await withTimeout(api.getSidestoryStoriesGrouped(), 8000);
        console.log("[StoryList] 支线项目数:", grouped.length);
        setSidestoryGrouped(grouped);
        loadedRef.current.sidestory = true;
      } catch (err) {
        handleLoadError("支线剧情", err);
      } finally {
        inflightRef.current.sidestory = false;
        setSidestoryLoading(false);
      }
    },
    [handleLoadError]
  );

  const loadRoguelike = useCallback(
    async (force = false) => {
      if (!force && loadedRef.current.roguelike) return;
      if (inflightRef.current.roguelike) return;
      inflightRef.current.roguelike = true;
      setRoguelikeLoading(true);
      setError(null);
      try {
        const grouped = await withTimeout(api.getRoguelikeStoriesGrouped(), 8000);
        console.log("[StoryList] 肉鸽项目数:", grouped.length);
        setRoguelikeGrouped(grouped);
        loadedRef.current.roguelike = true;
      } catch (err) {
        handleLoadError("肉鸽剧情", err);
      } finally {
        inflightRef.current.roguelike = false;
        setRoguelikeLoading(false);
      }
    },
    [handleLoadError]
  );

  const loadMemories = useCallback(
    async (force = false) => {
      if (!force && loadedRef.current.memory) return;
      if (inflightRef.current.memory) return;
      inflightRef.current.memory = true;
      setMemoryLoading(true);
      setError(null);
      try {
        const data = await withTimeout(api.getMemoryStories(), 10000);
        console.log("[StoryList] 干员密录加载成功，数量:", data.length);
        setMemoryStories(data);
        loadedRef.current.memory = true;
      } catch (err) {
        handleLoadError("干员密录", err);
      } finally {
        inflightRef.current.memory = false;
        setMemoryLoading(false);
      }
    },
    [handleLoadError]
  );

  /** 分类加载的唯一入口：pill 只负责切 activeCategory，加载由 effect 统一触发。 */
  const loadCategory = useCallback(
    async (category: Category, force = false) => {
      switch (category) {
        case "main":
          await loadMainStories(force);
          break;
        case "activity":
          // 活动要跟支线去重，所以两边都得有数据
          await Promise.all([loadActivities(force), loadSidestories(force)]);
          break;
        case "sidestory":
          await loadSidestories(force);
          break;
        case "roguelike":
          await loadRoguelike(force);
          break;
        case "memory":
          await loadMemories(force);
          break;
        case "favorites":
          // 收藏分组要靠主线映射表还原章节名
          await loadMainStories(force);
          break;
      }
    },
    [loadActivities, loadMainStories, loadMemories, loadRoguelike, loadSidestories]
  );

  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        // 3s 安全超时，防止 isInstalled 因异常挂起
        const ok = await withTimeout(api.isInstalled(), 3000);
        if (cancelled) return;
        setInstalled(ok);
        if (!ok) {
          console.log("[StoryList] 未安装，打开同步对话框");
          setSyncDialogOpen(true);
          setLoading(false);
        }
      } catch (e) {
        if (cancelled) return;
        console.error("[StoryList] isInstalled 失败，回退到同步对话框:", e);
        setInstalled(false);
        setError("未安装或网络缓慢，请先同步数据");
        setSyncDialogOpen(true);
        setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  // 数据就绪后：当前分类按需加载；主线始终加载（收藏分组名依赖它）。
  useEffect(() => {
    if (installed !== true) return;
    void loadMainStories();
  }, [installed, loadMainStories]);

  useEffect(() => {
    if (installed !== true) return;
    void loadCategory(activeCategory);
  }, [activeCategory, installed, loadCategory]);

  // 剧情数据重新同步：所有分类缓存作废，重新拉当前分类。
  useEffect(() => {
    const handler = () => {
      console.log("[StoryList] 收到 app:data-updated，重置分类缓存");
      loadedRef.current = {
        favorites: true,
        main: false,
        activity: false,
        sidestory: false,
        roguelike: false,
        memory: false,
      };
      summaryRequestedRef.current.clear();
      setSummaryCache({});
      setSummaryLoadingIds({});
      setOpenGroups({});
      setError(null);
      setInstalled(true);
      void loadMainStories(true);
      void loadCategory(activeCategory, true);
    };
    window.addEventListener("app:data-updated", handler);
    return () => window.removeEventListener("app:data-updated", handler);
  }, [activeCategory, loadCategory, loadMainStories]);

  // 首页统计格 / 其他入口要求直接跳到收藏分类
  useEffect(() => {
    const handler = () => setActiveCategory("favorites");
    window.addEventListener("app:open-favorites", handler);
    return () => window.removeEventListener("app:open-favorites", handler);
  }, []);

  // 阅读进度：回到列表（KeepAlive 重新 display）、窗口聚焦、数据更新时刷新。
  useEffect(() => {
    const refresh = () => setProgressMap(readProgressPercentMap());
    refresh();
    window.addEventListener("focus", refresh);
    window.addEventListener("app:home-refresh", refresh);
    window.addEventListener("app:data-updated", refresh);
    document.addEventListener("visibilitychange", refresh);

    let observer: IntersectionObserver | null = null;
    const node = rootRef.current;
    if (node && typeof IntersectionObserver !== "undefined") {
      observer = new IntersectionObserver((entries) => {
        if (entries.some((entry) => entry.isIntersecting)) refresh();
      });
      observer.observe(node);
    }

    return () => {
      window.removeEventListener("focus", refresh);
      window.removeEventListener("app:home-refresh", refresh);
      window.removeEventListener("app:data-updated", refresh);
      document.removeEventListener("visibilitychange", refresh);
      observer?.disconnect();
    };
  }, []);

  const handleRequestSummary = useCallback(async (story: StoryEntry) => {
    const storyInfo = story.storyInfo;
    if (!storyInfo) return;
    if (summaryRequestedRef.current.has(story.storyId)) return;
    summaryRequestedRef.current.add(story.storyId);

    setSummaryLoadingIds((prev) => ({ ...prev, [story.storyId]: true }));
    try {
      const raw = await scheduleSummary(() => api.getStoryInfo(storyInfo));
      const normalized = raw.replace(/\r\n/g, "\n").trim();
      setSummaryCache((prev) => ({
        ...prev,
        [story.storyId]: normalized.length > 0 ? normalized : "",
      }));
    } catch (err) {
      console.warn("[StoryList] 加载简介失败:", story.storyId, err);
      // 允许下次重试
      summaryRequestedRef.current.delete(story.storyId);
    } finally {
      setSummaryLoadingIds((prev) => {
        const next = { ...prev };
        delete next[story.storyId];
        return next;
      });
    }
  }, []);

  const ensureSummariesForStories = useCallback(
    (stories: StoryEntry[]) => {
      stories.forEach((story) => {
        if (!story.storyInfo) return;
        void handleRequestSummary(story);
      });
    },
    [handleRequestSummary]
  );

  const favoriteStoryEntries = useMemo(() => Object.values(favoriteStories), [favoriteStories]);
  const favoriteGroupEntries = useMemo(
    () => Object.values(favoriteGroups),
    [favoriteGroups]
  );

  const trimmedSearch = searchTerm.trim();
  const normalizedSearch = trimmedSearch.toLowerCase();
  const hasSearch = normalizedSearch.length > 0;

  // 搜索时默认展开所有命中分组；退出搜索或换分类时把用户的手动展开状态清掉。
  useEffect(() => {
    setOpenGroups({});
  }, [hasSearch, activeCategory]);

  const isGroupOpen = useCallback(
    (key: string, fallbackOpen: boolean) => {
      const explicit = openGroups[key];
      if (explicit !== undefined) return explicit;
      return hasSearch ? true : fallbackOpen;
    },
    [hasSearch, openGroups]
  );

  const setGroupOpen = useCallback((key: string, open: boolean) => {
    setOpenGroups((prev) => ({ ...prev, [key]: open }));
  }, []);

  const matchesSearch = useCallback(
    (story: StoryEntry) => {
      if (!hasSearch) return true;
      const fields = [
        story.storyName,
        story.storyCode ?? "",
        story.storyGroup ?? "",
      ];
      return fields.some((value) =>
        value.toLowerCase().includes(normalizedSearch)
      );
    },
    [hasSearch, normalizedSearch]
  );

  const groupNameMap = useMemo(() => {
    const map = new Map<string, string>();

    mainGrouped.forEach(([chapterName, stories]) => {
      stories.forEach((story) => {
        if (story.storyGroup) {
          map.set(story.storyGroup, chapterName);
        }
      });
    });

    activityGrouped.forEach(([activityName, stories]) => {
      stories.forEach((story) => {
        if (story.storyGroup) {
          map.set(story.storyGroup, activityName);
        }
      });
    });

    memoryStories.forEach((story) => {
      if (story.storyGroup) {
        map.set(story.storyGroup, story.storyGroup);
      }
    });

    return map;
  }, [mainGrouped, activityGrouped, memoryStories]);

  const mainChapterMap = useMemo(() => new Map(mainGrouped), [mainGrouped]);
  const activityMap = useMemo(() => new Map(activityGrouped), [activityGrouped]);
  const sidestoryMap = useMemo(() => new Map(sidestoryGrouped), [sidestoryGrouped]);
  const roguelikeMap = useMemo(() => new Map(roguelikeGrouped), [roguelikeGrouped]);

  const filteredMainGrouped = useMemo(() => {
    if (!hasSearch) return mainGrouped;
    return mainGrouped
      .map(([chapterName, stories]) => {
        const chapterMatches = chapterName.toLowerCase().includes(normalizedSearch);
        if (chapterMatches) {
          return [chapterName, stories] as [string, StoryEntry[]];
        }
        const filteredStories = stories.filter(matchesSearch);
        return [chapterName, filteredStories] as [string, StoryEntry[]];
      })
      .filter(([, stories]) => stories.length > 0);
  }, [hasSearch, mainGrouped, matchesSearch, normalizedSearch]);

  const filteredActivityGrouped = useMemo(() => {
    // 支线已经单独成一类；无论是否在搜索，都不要在活动里再出现一遍。
    const sidestoryNames = new Set(sidestoryGrouped.map(([name]) => name));
    return activityGrouped
      .filter(([activityName]) => !sidestoryNames.has(activityName))
      .map(([activityName, stories]) => {
        const activityMatches = activityName.toLowerCase().includes(normalizedSearch);
        if (activityMatches || !hasSearch) {
          return [activityName, stories] as [string, StoryEntry[]];
        }
        const filteredStories = stories.filter(matchesSearch);
        return [activityName, filteredStories] as [string, StoryEntry[]];
      })
      .filter(([, stories]) => stories.length > 0);
  }, [activityGrouped, hasSearch, matchesSearch, normalizedSearch, sidestoryGrouped]);

  const filteredSidestoryGrouped = useMemo(() => {
    if (!hasSearch) return sidestoryGrouped;
    return sidestoryGrouped
      .map(([name, stories]) => {
        const nameMatches = name.toLowerCase().includes(normalizedSearch);
        if (nameMatches) return [name, stories] as [string, StoryEntry[]];
        const filteredStories = stories.filter(matchesSearch);
        return [name, filteredStories] as [string, StoryEntry[]];
      })
      .filter(([, stories]) => stories.length > 0);
  }, [sidestoryGrouped, hasSearch, matchesSearch, normalizedSearch]);

  const filteredRoguelikeGrouped = useMemo(() => {
    if (!hasSearch) return roguelikeGrouped;
    return roguelikeGrouped
      .map(([name, stories]) => {
        const nameMatches = name.toLowerCase().includes(normalizedSearch);
        if (nameMatches) return [name, stories] as [string, StoryEntry[]];
        const filteredStories = stories.filter(matchesSearch);
        return [name, filteredStories] as [string, StoryEntry[]];
      })
      .filter(([, stories]) => stories.length > 0);
  }, [roguelikeGrouped, hasSearch, matchesSearch, normalizedSearch]);

  const filteredMemoryStories = useMemo(() => {
    if (!hasSearch) return memoryStories;
    return memoryStories.filter(matchesSearch);
  }, [hasSearch, matchesSearch, memoryStories]);

  const favoriteGroupList = useMemo(() => {
    if (favoriteGroupEntries.length === 0) return [];

    return favoriteGroupEntries
      .map((group) => {
        const allStories = Object.values(group.stories).sort((a, b) => {
          if (a.storySort !== b.storySort) {
            return a.storySort - b.storySort;
          }
          return a.storyName.localeCompare(b.storyName, "zh-Hans");
        });

        const visibleStories = hasSearch ? allStories.filter(matchesSearch) : allStories;
        if (visibleStories.length === 0 && hasSearch) {
          return null;
        }

        return {
          groupId: group.id,
          displayName: group.name,
          allStories,
          visibleStories,
          type: group.type,
        };
      })
      .filter((item): item is NonNullable<typeof item> => Boolean(item))
      .sort((a, b) => a.displayName.localeCompare(b.displayName, "zh-Hans"));
  }, [favoriteGroupEntries, hasSearch, matchesSearch]);

  const favoriteGroupStoryIds = useMemo(() => {
    const ids = new Set<string>();
    favoriteGroupEntries.forEach((group) => {
      group.storyIds.forEach((id) => ids.add(id));
    });
    return ids;
  }, [favoriteGroupEntries]);

  const individualFavoriteStories = useMemo(() => {
    if (favoriteStoryEntries.length === 0) return [];
    return favoriteStoryEntries.filter((story) => !favoriteGroupStoryIds.has(story.storyId));
  }, [favoriteStoryEntries, favoriteGroupStoryIds]);

  const individualFavoriteGroups = useMemo(() => {
    if (individualFavoriteStories.length === 0) return [];

    const grouped = new Map<string, StoryEntry[]>();
    individualFavoriteStories.forEach((story) => {
      if (!matchesSearch(story)) return;
      const key = story.storyGroup || "__ungrouped__";
      const list = grouped.get(key);
      if (list) {
        list.push(story);
      } else {
        grouped.set(key, [story]);
      }
    });

    return Array.from(grouped.entries())
      .map(([groupKey, stories]) => {
        const sorted = [...stories].sort((a, b) => {
          if (a.storySort !== b.storySort) {
            return a.storySort - b.storySort;
          }
          return a.storyName.localeCompare(b.storyName, "zh-Hans");
        });

        const displayName =
          groupKey === "__ungrouped__"
            ? "未分组"
            : groupNameMap.get(groupKey) || groupKey || "未分组";

        return { groupKey, displayName, stories: sorted };
      })
      .sort((a, b) => a.displayName.localeCompare(b.displayName, "zh-Hans"));
  }, [groupNameMap, individualFavoriteStories, matchesSearch]);

  const favoriteCount = useMemo(() => {
    const uniqueIds = new Set<string>();
    favoriteStoryEntries.forEach((story) => uniqueIds.add(story.storyId));
    favoriteGroupEntries.forEach((group) => {
      group.storyIds.forEach((id) => uniqueIds.add(id));
    });
    return uniqueIds.size;
  }, [favoriteGroupEntries, favoriteStoryEntries]);

  const activeSummary = useMemo(() => {
    if (hasSearch) {
      return `搜索关键字：“${trimmedSearch}”`;
    }
    if (activeCategory === "favorites" && favoriteCount > 0) {
      return `已收藏 ${favoriteCount} 条剧情`;
    }
    return CATEGORY_DESCRIPTIONS[activeCategory];
  }, [activeCategory, favoriteCount, hasSearch, trimmedSearch]);

  const openSync = useCallback(() => setSyncDialogOpen(true), []);

  const handleSyncSuccess = useCallback(async () => {
    console.log("[StoryList] 同步成功回调触发");
    setInstalled(true);
    setError(null);
    loadedRef.current = {
      favorites: true,
      main: false,
      activity: false,
      sidestory: false,
      roguelike: false,
      memory: false,
    };
    summaryRequestedRef.current.clear();
    setSummaryCache({});
    await loadMainStories(true);
    await loadCategory(activeCategory, true);
    console.log("[StoryList] 关闭同步对话框");
    setSyncDialogOpen(false);
  }, [activeCategory, loadCategory, loadMainStories]);

  useEffect(() => {
    if (showSummaries && memoryStories.length > 0) {
      ensureSummariesForStories(memoryStories);
    }
  }, [showSummaries, memoryStories, ensureSummariesForStories]);

  const renderStoryItem = useCallback(
    (story: StoryEntry, keyPrefix?: string) => (
      <StoryItem
        key={keyPrefix ? `${keyPrefix}-${story.storyId}` : story.storyId}
        story={story}
        onSelectStory={onSelectStory}
        isFavorite={isFavorite(story.storyId)}
        onToggleFavorite={() => toggleFavorite(story)}
        showSummary={showSummaries}
        summary={summaryCache[story.storyId]}
        summaryLoading={Boolean(summaryLoadingIds[story.storyId])}
        onRequestSummary={handleRequestSummary}
        progress={progressMap[story.storyTxt]}
      />
    ),
    [
      handleRequestSummary,
      isFavorite,
      onSelectStory,
      progressMap,
      showSummaries,
      summaryCache,
      summaryLoadingIds,
      toggleFavorite,
    ]
  );

  const mainPending = installed === null || (loading && mainGrouped.length === 0);

  return (
    <div ref={rootRef} className="h-full flex flex-col overflow-hidden">
      <main className="flex-1 overflow-hidden">
        <CustomScrollArea
          className="h-full"
          viewportClassName="reader-scroll"
          trackOffsetTop="calc(3.5rem + 10px)"
          trackOffsetBottom="calc(4.5rem + env(safe-area-inset-bottom, 0px))"
        >
          <div className="container py-6 pb-24 space-y-6 motion-safe:animate-in motion-safe:fade-in-0 motion-safe:duration-700">
            <div className="space-y-3">
              {/* 分类 pill：移动端横向滚动，触控目标 ≥44px。加载中也保持可见。 */}
              <div className="-mx-1 flex gap-2 overflow-x-auto px-1 pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
                {CATEGORY_TABS.map((tab) => (
                  <Button
                    key={tab.id}
                    variant={activeCategory === tab.id ? "default" : "outline"}
                    size="sm"
                    aria-pressed={activeCategory === tab.id}
                    className="min-h-[44px] flex-shrink-0 rounded-full px-4"
                    onClick={() => setActiveCategory(tab.id)}
                  >
                    {tab.label}
                  </Button>
                ))}
              </div>
              {/* 顶部行：左侧摘要文本，右侧全局简介开关 */}
              <div className="flex items-center justify-between gap-3">
                <span className="text-sm text-[hsl(var(--color-muted-foreground))]">
                  {activeSummary}
                </span>
                <SummaryToggleButton
                  enabled={showSummaries}
                  onToggle={() => setShowSummaries(!showSummaries)}
                  label="简介"
                />
              </div>
              {/* 第二行：搜索框独占一行 */}
              <div>
                <Input
                  type="search"
                  value={searchTerm}
                  onChange={(event) => setSearchTerm(event.target.value)}
                  placeholder="搜索剧情标题或编号"
                  aria-label="搜索剧情标题或编号"
                  aria-describedby="story-list-search-hint"
                  className="w-full sm:w-80 md:w-96"
                />
                <p
                  id="story-list-search-hint"
                  className="mt-1.5 text-xs text-[hsl(var(--color-muted-foreground))]"
                >
                  只匹配标题与编号；要搜正文内容请用底部「搜索」。
                </p>
              </div>
            </div>

            {error && (
              <div className="flex flex-col items-start gap-3 rounded-2xl border border-[hsl(var(--color-destructive)/0.4)] bg-[hsl(var(--color-destructive)/0.06)] p-4">
                <div className="text-sm text-[hsl(var(--color-destructive))]">{error}</div>
                <Button className="min-h-[44px]" onClick={openSync}>
                  <RefreshCw className="mr-2 h-4 w-4" />
                  同步数据
                </Button>
              </div>
            )}

            <div className="space-y-4">
              {activeCategory === "main" &&
                (mainPending ? (
                  <ListSkeleton />
                ) : filteredMainGrouped.length > 0 ? (
                  filteredMainGrouped.map(([chapterName, stories], index) => {
                    const fullStories = mainChapterMap.get(chapterName) ?? stories;
                    const groupKey = fullStories[0]?.storyGroup || chapterName;
                    const groupId = `chapter:${groupKey}`;
                    const chapterFavorite = isGroupFavorite(groupId);
                    return (
                      <Collapsible
                        key={groupId}
                        title={chapterName}
                        open={isGroupOpen(groupId, index === 0)}
                        onOpenChange={(open) => setGroupOpen(groupId, open)}
                        actions={
                          <GroupFavoriteButton
                            isFavorite={chapterFavorite}
                            onToggle={() =>
                              toggleFavoriteGroup({
                                id: groupId,
                                name: chapterName,
                                type: "chapter",
                                stories: fullStories,
                              })
                            }
                            inactiveText="收藏章节"
                            activeText="取消收藏章节"
                          />
                        }
                      >
                        {stories.map((story) => renderStoryItem(story))}
                      </Collapsible>
                    );
                  })
                ) : (
                  <EmptyState
                    message={hasSearch ? "没有匹配的主线剧情" : "暂无主线剧情，可能需要同步。"}
                    actionLabel={hasSearch ? undefined : "去同步数据"}
                    onAction={hasSearch ? undefined : openSync}
                  />
                ))}

              {activeCategory === "activity" && (
                <div className="space-y-3">
                  {activityLoading && <ListSkeleton />}
                  {!activityLoading && filteredActivityGrouped.length === 0 && (
                    <EmptyState
                      message={hasSearch ? "没有匹配的活动剧情" : "暂无活动剧情或需要同步"}
                      actionLabel={hasSearch ? undefined : "去同步数据"}
                      onAction={hasSearch ? undefined : openSync}
                    />
                  )}
                  {!activityLoading &&
                    filteredActivityGrouped.map(([activityName, stories], index) => {
                      const fullStories = activityMap.get(activityName) ?? stories;
                      const groupKey = fullStories[0]?.storyGroup || activityName;
                      const groupId = `activity:${groupKey}`;
                      const activityFavorite = isGroupFavorite(groupId);
                      return (
                        <Collapsible
                          key={groupId}
                          title={activityName}
                          open={isGroupOpen(groupId, index === 0)}
                          onOpenChange={(open) => setGroupOpen(groupId, open)}
                          actions={
                            <GroupFavoriteButton
                              isFavorite={activityFavorite}
                              onToggle={() =>
                                toggleFavoriteGroup({
                                  id: groupId,
                                  name: activityName,
                                  type: "activity",
                                  stories: fullStories,
                                })
                              }
                              inactiveText="收藏活动"
                              activeText="取消收藏活动"
                            />
                          }
                        >
                          {stories.map((story) => renderStoryItem(story))}
                        </Collapsible>
                      );
                    })}
                </div>
              )}

              {activeCategory === "sidestory" && (
                <div className="space-y-3">
                  {sidestoryLoading && <ListSkeleton />}
                  {!sidestoryLoading && filteredSidestoryGrouped.length === 0 && (
                    <EmptyState
                      message={hasSearch ? "没有匹配的支线剧情" : "暂无支线剧情或需要同步"}
                      actionLabel={hasSearch ? undefined : "去同步数据"}
                      onAction={hasSearch ? undefined : openSync}
                    />
                  )}
                  {!sidestoryLoading &&
                    filteredSidestoryGrouped.map(([name, stories], index) => {
                      const fullStories = sidestoryMap.get(name) ?? stories;
                      const groupKey = fullStories[0]?.storyGroup || name;
                      const groupId = `sidestory:${groupKey}`;
                      const fav = isGroupFavorite(groupId);
                      return (
                        <Collapsible
                          key={groupId}
                          title={name}
                          open={isGroupOpen(groupId, index === 0)}
                          onOpenChange={(open) => setGroupOpen(groupId, open)}
                          actions={
                            <GroupFavoriteButton
                              isFavorite={fav}
                              onToggle={() =>
                                toggleFavoriteGroup({ id: groupId, name, type: "other", stories: fullStories })
                              }
                              inactiveText="收藏支线"
                              activeText="取消收藏支线"
                            />
                          }
                        >
                          {stories.map((story) => renderStoryItem(story))}
                        </Collapsible>
                      );
                    })}
                </div>
              )}

              {activeCategory === "roguelike" && (
                <div className="space-y-3">
                  {roguelikeLoading && <ListSkeleton />}
                  {!roguelikeLoading && filteredRoguelikeGrouped.length === 0 && (
                    <EmptyState
                      message={hasSearch ? "没有匹配的肉鸽剧情" : "暂无肉鸽剧情或需要同步"}
                      actionLabel={hasSearch ? undefined : "去同步数据"}
                      onAction={hasSearch ? undefined : openSync}
                    />
                  )}
                  {!roguelikeLoading &&
                    filteredRoguelikeGrouped.map(([name, stories], index) => {
                      const fullStories = roguelikeMap.get(name) ?? stories;
                      const groupKey = fullStories[0]?.storyGroup || name;
                      const groupId = `roguelike:${groupKey}`;
                      const fav = isGroupFavorite(groupId);
                      return (
                        <Collapsible
                          key={groupId}
                          title={name}
                          open={isGroupOpen(groupId, index === 0)}
                          onOpenChange={(open) => setGroupOpen(groupId, open)}
                          actions={
                            <GroupFavoriteButton
                              isFavorite={fav}
                              onToggle={() =>
                                toggleFavoriteGroup({ id: groupId, name, type: "other", stories: fullStories })
                              }
                              inactiveText="收藏肉鸽"
                              activeText="取消收藏肉鸽"
                            />
                          }
                        >
                          {stories.map((story) => renderStoryItem(story))}
                        </Collapsible>
                      );
                    })}
                </div>
              )}

              {activeCategory === "memory" && (
                <div className="space-y-2">
                  {memoryLoading && <ListSkeleton />}
                  {!memoryLoading && filteredMemoryStories.length === 0 && (
                    <EmptyState
                      message={hasSearch ? "没有匹配的密录剧情" : "暂无干员密录或需要同步"}
                      actionLabel={hasSearch ? undefined : "去同步数据"}
                      onAction={hasSearch ? undefined : openSync}
                    />
                  )}
                  {!memoryLoading &&
                    filteredMemoryStories.map((story) => (
                      <StoryItem
                        key={story.storyId}
                        story={story}
                        onSelectStory={onSelectStory}
                        isFavorite={isFavorite(story.storyId)}
                        onToggleFavorite={() => toggleFavorite(story)}
                        showSummary={memorySummaryVisible}
                        summary={summaryCache[story.storyId]}
                        summaryLoading={Boolean(summaryLoadingIds[story.storyId])}
                        onRequestSummary={handleRequestSummary}
                        progress={progressMap[story.storyTxt]}
                      />
                    ))}
                </div>
              )}

              {activeCategory === "favorites" &&
                (favoriteCount > 0 ? (
                  favoriteGroupList.length > 0 || individualFavoriteGroups.length > 0 ? (
                    <>
                      {favoriteGroupList.map(
                        ({ groupId, displayName, allStories, visibleStories, type }, index) => {
                          const key = `favorite-group:${groupId}`;
                          return (
                            <Collapsible
                              key={key}
                              title={displayName}
                              open={isGroupOpen(key, index === 0)}
                              onOpenChange={(open) => setGroupOpen(key, open)}
                              actions={
                                <GroupFavoriteButton
                                  isFavorite
                                  onToggle={() =>
                                    toggleFavoriteGroup({
                                      id: groupId,
                                      name: displayName,
                                      type,
                                      stories: allStories,
                                    })
                                  }
                                  inactiveText="收藏该组"
                                  activeText="取消收藏该组"
                                />
                              }
                            >
                              {visibleStories.map((story) =>
                                renderStoryItem(story, "favorite-group")
                              )}
                            </Collapsible>
                          );
                        }
                      )}

                      {individualFavoriteGroups.map(({ groupKey, displayName, stories }, index) => {
                        const key = `favorite-individual:${groupKey}`;
                        return (
                          <Collapsible
                            key={key}
                            title={displayName}
                            open={isGroupOpen(
                              key,
                              favoriteGroupList.length === 0 && index === 0
                            )}
                            onOpenChange={(open) => setGroupOpen(key, open)}
                            actions={
                              <GroupFavoriteButton
                                isFavorite
                                onToggle={() => {
                                  stories.forEach((story) => {
                                    if (isFavorite(story.storyId)) {
                                      toggleFavorite(story);
                                    }
                                  });
                                }}
                                inactiveText="收藏该组"
                                activeText="取消收藏该组"
                              />
                            }
                          >
                            {stories.map((story) => renderStoryItem(story, "favorite-individual"))}
                          </Collapsible>
                        );
                      })}
                    </>
                  ) : (
                    <EmptyState message={hasSearch ? "没有匹配的收藏" : "暂无收藏的剧情"} />
                  )
                ) : (
                  <EmptyState message="暂无收藏的剧情，去剧情列表点星标就能收藏。" />
                ))}
            </div>
          </div>
        </CustomScrollArea>
      </main>

      {/* 同步对话框 */}
      <SyncDialog
        open={syncDialogOpen}
        onClose={() => setSyncDialogOpen(false)}
        onSuccess={handleSyncSuccess}
      />
    </div>
  );
}

function ListSkeleton({ rows = 4 }: { rows?: number }) {
  return (
    <div className="space-y-3" aria-hidden="true">
      {Array.from({ length: rows }).map((_, index) => (
        <div
          key={index}
          className="h-[88px] rounded-2xl border border-[hsl(var(--color-border))] bg-[hsl(var(--color-secondary)/0.4)] motion-safe:animate-pulse"
        />
      ))}
      <div className="sr-only">加载中</div>
    </div>
  );
}

function SummaryToggleButton({
  enabled,
  onToggle,
  label = "简介",
}: {
  enabled: boolean;
  onToggle: () => void;
  label?: string;
}) {
  return (
    <button
      type="button"
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        onToggle();
      }}
      aria-pressed={enabled}
      aria-label={enabled ? `隐藏${label}` : `显示${label}`}
      className={`inline-flex min-h-[44px] flex-shrink-0 items-center gap-1.5 rounded-full border px-3 py-1 text-xs transition-colors ${
        enabled
          ? "text-[hsl(var(--color-primary))] border-[hsl(var(--color-primary)/0.4)] bg-[hsl(var(--color-primary)/0.1)]"
          : "text-[hsl(var(--color-muted-foreground))] border-[hsl(var(--color-border))] bg-transparent hover:bg-[hsl(var(--color-accent))] hover:text-[hsl(var(--color-foreground))]"
      }`}
    >
      <FileText className="h-3.5 w-3.5" />
      <span className="whitespace-nowrap">{label}</span>
      <span
        className={`text-[0.6rem] tracking-[0.2em] uppercase ${
          enabled ? "text-[hsl(var(--color-primary))]" : "text-[hsl(var(--color-muted-foreground))]"
        }`}
      >
        {enabled ? "ON" : "OFF"}
      </span>
    </button>
  );
}

function GroupFavoriteButton({
  isFavorite,
  onToggle,
  inactiveText,
  activeText,
}: {
  isFavorite: boolean;
  onToggle: () => void;
  inactiveText: string;
  activeText: string;
}) {
  const label = isFavorite ? activeText : inactiveText;

  return (
    <button
      type="button"
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        onToggle();
      }}
      aria-pressed={isFavorite}
      aria-label={label}
      className={`inline-flex min-h-[44px] items-center gap-2 rounded-full border px-3 py-1 text-xs transition-colors ${
        isFavorite
          ? "text-[hsl(var(--color-primary))] border-[hsl(var(--color-primary)/0.4)] bg-[hsl(var(--color-primary)/0.08)]"
          : "text-[hsl(var(--color-muted-foreground))] border-[hsl(var(--color-border))] bg-transparent hover:bg-[hsl(var(--color-accent))] hover:text-[hsl(var(--color-foreground))]"
      }`}
    >
      <Star
        className="h-3.5 w-3.5"
        fill={isFavorite ? "currentColor" : "transparent"}
        strokeWidth={isFavorite ? 0 : 2}
      />
      <span className="whitespace-nowrap">{label}</span>
    </button>
  );
}

function StoryItem({
  story,
  onSelectStory,
  isFavorite,
  onToggleFavorite,
  showSummary = false,
  summary,
  summaryLoading = false,
  onRequestSummary,
  progress,
}: {
  story: StoryEntry;
  onSelectStory: (story: StoryEntry) => void;
  isFavorite: boolean;
  onToggleFavorite: () => void;
  showSummary?: boolean;
  summary?: string | null;
  summaryLoading?: boolean;
  onRequestSummary?: (story: StoryEntry) => void;
  /** 阅读进度 0~1，来自 localStorage `reading-progress`。 */
  progress?: number;
}) {
  useEffect(() => {
    if (!showSummary) return;
    if (!story.storyInfo) return;
    if ((summary === undefined || summary === null) && !summaryLoading) {
      onRequestSummary?.(story);
    }
  }, [showSummary, story.storyId, story.storyInfo, summary, summaryLoading, onRequestSummary]);

  const normalizedSummary = summary ? summary.trim() : "";
  let summaryContent: string;
  let summaryState: "ready" | "loading" | "empty" | "missing" = "ready";
  if (!showSummary) {
    summaryState = "ready";
    summaryContent = "";
  } else if (normalizedSummary) {
    summaryState = "ready";
    summaryContent = normalizedSummary;
  } else if (summaryLoading) {
    summaryState = "loading";
    summaryContent = "简介加载中…";
  } else if (story.storyInfo) {
    summaryState = "empty";
    summaryContent = "暂无简介内容";
  } else {
    summaryState = "missing";
    summaryContent = "该剧情未提供简介";
  }
  const summaryLines =
    showSummary && summaryState === "ready" ? summaryContent.split("\n") : [];

  const storyTxt = story.storyTxt ?? "";
  // 仅用 storyTxt 路径前缀判断素材类别。`storyReviewType === "NONE"` 是
  // 一个坏信号——主线的序章、开场 guide 也是 NONE，若据此走 memory 头像分支
  // 会把章节卡渲染成角色 monogram。
  const isMemoryStory = storyTxt.startsWith("obt/memory/");
  const charId = isMemoryStory ? extractCharTokenFromStoryTxt(storyTxt) : null;
  const charName = isMemoryStory
    ? story.storyName.split("·")[0]?.trim() || null
    : null;

  const progressPct =
    typeof progress === "number" && progress > 0
      ? Math.min(100, Math.max(1, Math.round(progress * 100)))
      : 0;

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => onSelectStory(story)}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onSelectStory(story);
        }
      }}
      className="story-card relative flex w-full gap-3 p-3 items-center text-left cursor-pointer overflow-hidden transition-all duration-200 ease-out hover:-translate-y-0.5 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-[hsl(var(--color-primary))] motion-safe:animate-in motion-safe:fade-in-0"
    >
      {/* 卡片底层模糊背景：密录用干员立绘，其他类别复用 StoryThumbnail
          的多级兜底链（插画 → 章节封面 → 活动 KV）。背景交给 CSS 做
          blur + overlay，AssetImage 本身不带 tint，避免图片处理两次。 */}
      <div
        className="story-card-memory-bg pointer-events-none absolute inset-0 -z-0"
        aria-hidden="true"
      >
        {isMemoryStory && charId ? (
          <AssetImage
            kind="portrait"
            token={charId}
            alt=""
            className="h-full w-full"
            tint="none"
            lazy
          />
        ) : (
          <StoryThumbnail story={story} alt="" tint="none" />
        )}
      </div>
      <div
        className="story-card-memory-overlay pointer-events-none absolute inset-0 -z-0"
        aria-hidden="true"
      />

      <div className="relative z-10 w-16 h-16 flex-shrink-0 flex items-center justify-center">
        {isMemoryStory ? (
          <CharacterAvatar
            charId={charId}
            name={charName}
            size={56}
          />
        ) : (
          <div className="relative w-24 h-14 rounded-md overflow-hidden bg-[hsl(var(--color-secondary)/0.4)]">
            <StoryThumbnail story={story} alt={story.storyName} />
          </div>
        )}
      </div>
      <div className="flex-1 min-w-0 relative z-10">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0 flex-1 flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
            {story.storyCode && (
              <span className="story-card-code flex-shrink-0">{story.storyCode}</span>
            )}
            <span className="font-medium truncate">{story.storyName}</span>
          </div>
          <button
            type="button"
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              onToggleFavorite();
            }}
            aria-pressed={isFavorite}
            aria-label={isFavorite ? "取消收藏" : "收藏"}
            /* 命中区固定 44×44（-my-2 抵消额外高度，避免撑开卡片行高），
               视觉上仍是那颗小星星——外层只负责触控，内层负责外观。 */
            className="-my-2 -mr-1 flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-full"
          >
            <span
              aria-hidden="true"
              className={`inline-flex h-6 w-6 items-center justify-center rounded-full border transition-colors ${
                isFavorite
                  ? "text-[hsl(var(--color-primary))] border-[hsl(var(--color-primary)/0.4)] bg-[hsl(var(--color-primary)/0.08)]"
                  : "text-[hsl(var(--color-muted-foreground))] border-transparent hover:text-[hsl(var(--color-foreground))]"
              }`}
            >
              <Star
                className="h-4 w-4"
                fill={isFavorite ? "currentColor" : "transparent"}
                strokeWidth={isFavorite ? 0 : 2}
              />
            </span>
          </button>
        </div>
        {story.avgTag && (
          <div className="text-xs text-[hsl(var(--color-muted-foreground))] mt-0.5 truncate">{story.avgTag}</div>
        )}
        {progressPct > 0 && (
          <div className="mt-1.5 flex items-center gap-2">
            <div
              className="h-1 flex-1 rounded-full bg-[hsl(var(--color-secondary))]"
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={progressPct}
              aria-label={`阅读进度 ${progressPct}%`}
            >
              <div
                className="h-full rounded-full bg-[hsl(var(--color-primary)/0.8)]"
                style={{ width: `${progressPct}%` }}
              />
            </div>
            <span className="flex-shrink-0 text-[10px] tabular-nums text-[hsl(var(--color-muted-foreground))]">
              {progressPct >= 99 ? "已读完" : `${progressPct}%`}
            </span>
          </div>
        )}
        {showSummary && (
          <div
            className={`story-item-summary ${
              summaryState === "ready"
                ? ""
                : summaryState === "loading"
                ? "story-item-summary--loading"
                : "story-item-summary--placeholder"
            }`}
          >
            {summaryState === "ready" ? (
              summaryLines.map((line, index) => (
                <span key={index}>
                  {line}
                  {index < summaryLines.length - 1 ? <br /> : null}
                </span>
              ))
            ) : (
              summaryContent
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function EmptyState({
  message,
  actionLabel,
  onAction,
}: {
  message: string;
  actionLabel?: string;
  onAction?: () => void;
}) {
  return (
    <div className="space-y-3 text-[hsl(var(--color-muted-foreground))] motion-safe:animate-in motion-safe:fade-in-0 motion-safe:duration-300">
      <div>{message}</div>
      {actionLabel && onAction && (
        <Button variant="outline" className="min-h-[44px]" onClick={onAction}>
          <RefreshCw className="mr-2 h-4 w-4" />
          {actionLabel}
        </Button>
      )}
    </div>
  );
}
