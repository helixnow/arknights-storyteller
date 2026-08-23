import {
  type ReactNode,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { StoryEntry } from "@/types/story";

export type FavoriteGroupType = "chapter" | "activity" | "memory" | "other";

export interface FavoriteGroup {
  id: string;
  name: string;
  type: FavoriteGroupType;
  storyIds: string[];
  stories: Record<string, StoryEntry>;
}

export interface FavoriteGroupPayload {
  id: string;
  name: string;
  type?: FavoriteGroupType;
  stories: StoryEntry[];
}

type FavoriteStoryMap = Record<string, StoryEntry>;

interface FavoritesState {
  stories: FavoriteStoryMap;
  groups: Record<string, FavoriteGroup>;
}

interface FavoritesContextValue {
  favoriteStories: FavoriteStoryMap;
  favoriteGroups: Record<string, FavoriteGroup>;
  /** 收藏分组展开后包含的所有 storyId。 */
  favoriteGroupStoryIds: ReadonlySet<string>;
  /** 收藏总数：单章 ∪ 分组，去重后的唯一口径。 */
  favoriteCount: number;
  isFavorite: (storyId: string) => boolean;
  toggleFavorite: (story: StoryEntry) => void;
  isGroupFavorite: (groupId: string) => boolean;
  toggleFavoriteGroup: (group: FavoriteGroupPayload) => void;
}

const STORAGE_KEY = "arknights-story-favorites";
const INITIAL_STATE: FavoritesState = { stories: {}, groups: {} };

const FavoritesContext = createContext<FavoritesContextValue | null>(null);

function sanitizeStoryMap(input: unknown): FavoriteStoryMap {
  if (!input || typeof input !== "object") return {};

  const entries = Object.entries(input as Record<string, StoryEntry>);
  const sanitized: FavoriteStoryMap = {};

  for (const [storyId, story] of entries) {
    if (
      story &&
      typeof story === "object" &&
      typeof (story as StoryEntry).storyId === "string"
    ) {
      sanitized[storyId] = story;
    }
  }

  return sanitized;
}

function sanitizeGroupMap(input: unknown): Record<string, FavoriteGroup> {
  if (!input || typeof input !== "object") return {};

  const groups: Record<string, FavoriteGroup> = {};

  for (const [groupId, value] of Object.entries(input as Record<string, unknown>)) {
    if (!value || typeof value !== "object") continue;
    const raw = value as Partial<FavoriteGroup>;
    const stories = sanitizeStoryMap(raw.stories);
    const storyIds = Array.isArray(raw.storyIds)
      ? raw.storyIds.filter((id): id is string => typeof id === "string")
      : Object.keys(stories);

    if (storyIds.length === 0) continue;

    // 逐字段收敛：id/name 必须是非空字符串，type 必须落在已知枚举内。
    // localStorage 可能被旧版本或手改写入任意形状，脏值一律回落到安全默认。
    groups[groupId] = {
      id: typeof raw.id === "string" && raw.id ? raw.id : groupId,
      name: typeof raw.name === "string" && raw.name ? raw.name : groupId,
      type:
        raw.type === "chapter" || raw.type === "activity" || raw.type === "memory"
          ? raw.type
          : "other",
      storyIds: Array.from(new Set(storyIds)),
      stories,
    };
  }

  return groups;
}

function readFromStorage(): FavoritesState {
  if (typeof window === "undefined") {
    return INITIAL_STATE;
  }

  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (!stored) return INITIAL_STATE;
    const parsed = JSON.parse(stored) as unknown;

    if (parsed && typeof parsed === "object") {
      const asState = parsed as Partial<FavoritesState>;

      if ("stories" in asState || "groups" in asState) {
        return {
          stories: sanitizeStoryMap(asState.stories),
          groups: sanitizeGroupMap(asState.groups),
        };
      }

      // 向后兼容旧版本（仅保存关卡收藏）
      return {
        stories: sanitizeStoryMap(parsed),
        groups: {},
      };
    }

    return INITIAL_STATE;
  } catch (error) {
    console.warn("[Favorites] 读取本地收藏失败:", error);
    return INITIAL_STATE;
  }
}

function collectGroupStoryIds(groups: Record<string, FavoriteGroup>): Set<string> {
  const ids = new Set<string>();
  for (const group of Object.values(groups)) {
    group.storyIds.forEach((id) => ids.add(id));
  }
  return ids;
}

export function FavoritesProvider({ children }: { children: ReactNode }) {
  const [favorites, setFavorites] = useState<FavoritesState>(() => readFromStorage());

  /**
   * 收藏口径：单章收藏 ∪ 收藏分组展开后的所有章节。
   * 首页统计格、剧情页「收藏」分类、列表里的星标都必须用同一套判断，
   * 否则会出现「分组已收藏、组里每一条却是空心星」这种自相矛盾的状态。
   */
  const groupedStoryIds = useMemo(
    () => collectGroupStoryIds(favorites.groups),
    [favorites.groups]
  );

  const favoriteCount = useMemo(() => {
    const ids = new Set(groupedStoryIds);
    Object.keys(favorites.stories).forEach((id) => ids.add(id));
    return ids.size;
  }, [favorites.stories, groupedStoryIds]);

  // 首帧的值就是刚从 localStorage 读出来的，回写没有意义；更糟的是：如果
  // 读取因数据损坏回落到了空状态，这次回写会立刻用 `{}` 覆盖掉原始数据，
  // 连恢复的机会都不留。守卫不能用「跳过第一次 effect」计数：StrictMode
  // 开发模式下挂载期 effect 会连跑两次，第二次就把初始状态写回去了。改为
  // 与初始 state 做引用比较——用户任何真实改动都会产生新对象，自然落盘。
  const initialFavoritesRef = useRef(favorites);
  // 「当前 state 对应的存储串」。storage 事件把别的窗口写的状态灌进来时，
  // 存储里已经是这份内容了，据此跳过回写，免得两个窗口互相触发写入。
  const lastRawRef = useRef<string | null>(null);
  useEffect(() => {
    if (favorites === initialFavoritesRef.current) {
      return;
    }
    try {
      const raw = JSON.stringify(favorites);
      if (raw === lastRawRef.current) {
        return;
      }
      window.localStorage.setItem(STORAGE_KEY, raw);
      lastRawRef.current = raw;
    } catch (error) {
      // setItem 失败是原子的：旧数据原样保留，本次改动只在会话内生效。
      console.warn("[Favorites] 写入本地收藏失败:", error);
    }
  }, [favorites]);

  // 多窗口（桌面端可以开多个）时跟随其它窗口的修改。收藏是「整表读进
  // 内存 → 任意改动整表回写」，不同步的话：A 窗口刚收藏的条目会在 B 窗口
  // 的下一次回写里被 B 的旧内存状态整体覆盖，星标无声丢失（偏好 hook 已
  // 有同样的监听，这里是同一个坑）。
  useEffect(() => {
    if (typeof window === "undefined") return;
    const onStorage = (event: StorageEvent) => {
      // key 为 null 表示外部 storage.clear()，也要跟随。
      if (event.key !== null && event.key !== STORAGE_KEY) return;
      const raw = event.key === STORAGE_KEY ? event.newValue : null;
      if (event.key === STORAGE_KEY && raw === lastRawRef.current) return;
      lastRawRef.current = raw;
      setFavorites(readFromStorage());
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  const isFavorite = useCallback(
    (storyId: string) => Boolean(favorites.stories[storyId]) || groupedStoryIds.has(storyId),
    [favorites.stories, groupedStoryIds]
  );

  /**
   * 取消收藏时也要把这一条从所在的收藏分组里摘掉，否则星标点了没反应
   * （分组仍然把它算成收藏）。分组被摘空就整组移除。
   */
  const toggleFavorite = useCallback((story: StoryEntry) => {
    setFavorites((prev) => {
      const inStories = Boolean(prev.stories[story.storyId]);
      const owningGroups = Object.values(prev.groups).filter((group) =>
        group.storyIds.includes(story.storyId)
      );

      if (!inStories && owningGroups.length === 0) {
        return { ...prev, stories: { ...prev.stories, [story.storyId]: story } };
      }

      const nextStories = { ...prev.stories };
      delete nextStories[story.storyId];

      if (owningGroups.length === 0) {
        return { ...prev, stories: nextStories };
      }

      const nextGroups: Record<string, FavoriteGroup> = {};
      for (const [groupId, group] of Object.entries(prev.groups)) {
        if (!group.storyIds.includes(story.storyId)) {
          nextGroups[groupId] = group;
          continue;
        }
        const storyIds = group.storyIds.filter((id) => id !== story.storyId);
        if (storyIds.length === 0) continue;
        const { [story.storyId]: _removed, ...restStories } = group.stories;
        nextGroups[groupId] = { ...group, storyIds, stories: restStories };
      }

      return { stories: nextStories, groups: nextGroups };
    });
  }, []);

  const isGroupFavorite = useCallback(
    (groupId: string) => Boolean(favorites.groups[groupId]),
    [favorites.groups]
  );

  const toggleFavoriteGroup = useCallback((group: FavoriteGroupPayload) => {
    const uniqueStories = group.stories.filter(
      (story, index, self) =>
        story && typeof story === "object" && self.findIndex((item) => item.storyId === story.storyId) === index
    );

    setFavorites((prev) => {
      if (prev.groups[group.id]) {
        const { [group.id]: _removed, ...rest } = prev.groups;
        return { ...prev, groups: rest };
      }

      if (uniqueStories.length === 0) {
        return prev;
      }

      const storyMap: FavoriteStoryMap = {};
      uniqueStories.forEach((story) => {
        storyMap[story.storyId] = story;
      });

      return {
        ...prev,
        groups: {
          ...prev.groups,
          [group.id]: {
            id: group.id,
            name: group.name,
            type: group.type ?? "other",
            storyIds: uniqueStories.map((story) => story.storyId),
            stories: storyMap,
          },
        },
      };
    });
  }, []);

  const value = useMemo<FavoritesContextValue>(
    () => ({
      favoriteStories: favorites.stories,
      favoriteGroups: favorites.groups,
      favoriteGroupStoryIds: groupedStoryIds,
      favoriteCount,
      isFavorite,
      toggleFavorite,
      isGroupFavorite,
      toggleFavoriteGroup,
    }),
    [
      favorites.groups,
      favorites.stories,
      favoriteCount,
      groupedStoryIds,
      isFavorite,
      toggleFavorite,
      isGroupFavorite,
      toggleFavoriteGroup,
    ]
  );

  return <FavoritesContext.Provider value={value}>{children}</FavoritesContext.Provider>;
}

export function useFavorites() {
  const context = useContext(FavoritesContext);
  if (!context) {
    throw new Error("useFavorites must be used within a FavoritesProvider");
  }
  return context;
}
