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
import { useToast } from "@/components/ui/toast";

export type FavoriteGroupType = "chapter" | "activity" | "memory" | "other";

export interface FavoriteGroup {
  id: string;
  name: string;
  type: FavoriteGroupType;
  storyIds: string[];
  stories: Record<string, StoryEntry>;
  /**
   * 用户从整组收藏里单独摘掉的成员。目录校正（reconcileCatalog）按目录
   * 全量补齐成员时要跳过这些 id——否则「收藏了整个活动、又取消了其中
   * 一章」的用户，下一次目录刷新就会看到那一章被偷偷收藏回来。
   */
  excludedStoryIds?: string[];
}

export interface FavoriteGroupPayload {
  id: string;
  name: string;
  type?: FavoriteGroupType;
  stories: StoryEntry[];
}

/** 目录侧的一个分组快照，供 `reconcileCatalog` 校正整组收藏用。 */
export interface CatalogGroupSnapshot {
  id: string;
  name: string;
  type: FavoriteGroupType;
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
  /**
   * 目录加载后调用：把收藏里存的旧 StoryEntry 快照换成当前目录的版本，
   * 整组收藏的成员也以目录为准补齐/校正。收藏是「收藏那一刻的对象快照」
   * 落在 localStorage 里的，不校正的话换包后收藏页会一直显示旧书名、
   * 点开走的还是旧 txt 路径，新补的章节也永远进不了已收藏的组。
   */
  reconcileCatalog: (catalog: {
    entries: StoryEntry[];
    groups: CatalogGroupSnapshot[];
  }) => void;
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

    const excludedStoryIds = Array.isArray(raw.excludedStoryIds)
      ? Array.from(
          new Set(raw.excludedStoryIds.filter((id): id is string => typeof id === "string"))
        )
      : [];

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
      ...(excludedStoryIds.length > 0 ? { excludedStoryIds } : {}),
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

/** 失败提示的会话级闩锁：同一轮连续失败只打扰用户一次，写成功后复位。 */
let persistFailureNotified = false;

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

  // 写失败提示跑在事件回调里，通过 ref 取最新的 toast 句柄。
  const toast = useToast();
  const toastRef = useRef(toast);
  useEffect(() => {
    toastRef.current = toast;
  }, [toast]);

  // 首帧的值就是刚从 localStorage 读出来的，回写没有意义；更糟的是：如果
  // 读取因数据损坏回落到了空状态，这次回写会立刻用 `{}` 覆盖掉原始数据，
  // 连恢复的机会都不留。守卫不能用「跳过第一次 effect」计数：StrictMode
  // 开发模式下挂载期 effect 会连跑两次，第二次就把初始状态写回去了。改为
  // 与初始 state 做引用比较——用户任何真实改动都会产生新对象，自然落盘。
  const initialFavoritesRef = useRef(favorites);
  // 「当前 state 对应的存储串」。storage 事件把别的窗口写的状态灌进来时，
  // 存储里已经是这份内容了，据此跳过回写，免得两个窗口互相触发写入。
  const lastRawRef = useRef<string | null>(null);
  // 最新状态的 ref 快照，供 pagehide / 切后台等事件回调里的兜底重试读取。
  const favoritesRef = useRef(favorites);
  favoritesRef.current = favorites;
  // 上一次写入失败后置位：等下一次改动或切后台 / 关页面时带最新状态重试。
  const persistFailedRef = useRef(false);

  const persistFavorites = useCallback(() => {
    try {
      const raw = JSON.stringify(favoritesRef.current);
      if (raw === lastRawRef.current) {
        persistFailedRef.current = false;
        return;
      }
      window.localStorage.setItem(STORAGE_KEY, raw);
      lastRawRef.current = raw;
      persistFailedRef.current = false;
      persistFailureNotified = false;
    } catch (error) {
      // setItem 失败（quota 满 / 隐私模式）是原子的：旧数据原样保留。
      // 星标在界面上已经点亮，静默失败等于骗用户「已收藏」，重启后收藏
      // 全没了——提示一次，并留待重试（划线 / 阅读设置 / 进度同款处理）。
      persistFailedRef.current = true;
      console.warn("[Favorites] 写入本地收藏失败:", error);
      if (!persistFailureNotified) {
        persistFailureNotified = true;
        toastRef.current.error("收藏未能保存到本地存储（空间可能已满），将自动重试");
      }
    }
  }, []);

  useEffect(() => {
    if (favorites === initialFavoritesRef.current) {
      return;
    }
    persistFavorites();
  }, [favorites, persistFavorites]);

  // 写失败后的兜底重试：下一次任何收藏改动都会带全量状态重跑上面的
  // effect；若用户不再改动，就在切后台 / 关页面前再试一次——那时配额
  // 可能已被其它清理（如启动期清历史缓存）腾出来。
  useEffect(() => {
    if (typeof window === "undefined") return;
    const retry = () => {
      if (persistFailedRef.current) persistFavorites();
    };
    const onVisibility = () => {
      if (document.visibilityState === "hidden") retry();
    };
    window.addEventListener("pagehide", retry);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("pagehide", retry);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [persistFavorites]);

  // 多窗口（桌面端可以开多个）时跟随其它窗口的修改。收藏是「整表读进
  // 内存 → 任意改动整表回写」，不同步的话：A 窗口刚收藏的条目会在 B 窗口
  // 的下一次回写里被 B 的旧内存状态整体覆盖，星标无声丢失（偏好 hook 已
  // 有同样的监听，这里是同一个坑）。
  useEffect(() => {
    if (typeof window === "undefined") return;
    const onStorage = (event: StorageEvent) => {
      // 只认 localStorage：sessionStorage.clear() 也会派发 key 为 null 的
      // storage 事件，不区分来源会把收藏整表白白重读一遍，还顺手把
      // lastRawRef 的去重基准清掉。
      if (event.storageArea && event.storageArea !== window.localStorage) return;
      // key 为 null 表示外部 storage.clear()，也要跟随。
      if (event.key !== null && event.key !== STORAGE_KEY) return;
      const raw = event.key === STORAGE_KEY ? event.newValue : null;
      if (event.key === STORAGE_KEY && raw === lastRawRef.current) return;
      lastRawRef.current = raw;
      // 外部写入以后到为准：本窗口没写进去的旧状态即将被整体替换，
      // 失败重试标记一并清掉，免得兜底重试把对方刚写的内容盖掉。
      persistFailedRef.current = false;
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
        // 记下「这是用户显式摘掉的」：目录校正按全量补齐成员时要跳过它，
        // 不然下一次目录刷新就会把这一章偷偷收藏回来。
        const excludedStoryIds = Array.from(
          new Set([...(group.excludedStoryIds ?? []), story.storyId])
        );
        nextGroups[groupId] = { ...group, storyIds, stories: restStories, excludedStoryIds };
      }

      return { stories: nextStories, groups: nextGroups };
    });
  }, []);

  const isGroupFavorite = useCallback(
    (groupId: string) => Boolean(favorites.groups[groupId]),
    [favorites.groups]
  );

  const toggleFavoriteGroup = useCallback((group: FavoriteGroupPayload) => {
    // 去重顺便挡脏值：payload 里若混进 null / 缺 storyId 的条目（收藏页把
    // localStorage 里的旧快照原样传回来），原先的 findIndex 会在 null 上取
    // storyId 直接抛错，整个「收藏该组」点击就崩掉。
    const seen = new Set<string>();
    const uniqueStories: StoryEntry[] = [];
    for (const story of group.stories) {
      if (!story || typeof story !== "object" || typeof story.storyId !== "string") continue;
      if (seen.has(story.storyId)) continue;
      seen.add(story.storyId);
      uniqueStories.push(story);
    }

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

  /**
   * 用目录里的最新版本校正收藏。只「更新」，绝不新增或删除收藏本身：
   * - 单章收藏与分组成员的 StoryEntry 换成目录里的同 id 新对象（书名、
   *   编号、txt 路径跟着数据包走）；
   * - 整组收藏若还在目录里，成员名单以目录为准（换包补了章节就跟着补，
   *   改名/换类型也同步）；
   * - 组不在传入目录里（对应分类还没加载、或数据包移除了它）时不动名单，
   *   只刷新已存成员的内容。
   *
   * 变化判定是内容级（JSON 比较）而不是引用级：目录缓存过期后每次重取
   * 都是新对象，按引用比会把「内容没变」也当成变化，每次聚焦都空写一遍
   * localStorage。真没变化时原样返回 prev，state 与存储都零扰动。
   */
  const reconcileCatalog = useCallback(
    (catalog: { entries: StoryEntry[]; groups: CatalogGroupSnapshot[] }) => {
      const freshById = new Map<string, StoryEntry>();
      for (const entry of catalog.entries) {
        if (entry && typeof entry === "object" && typeof entry.storyId === "string") {
          freshById.set(entry.storyId, entry);
        }
      }
      if (freshById.size === 0) return;

      const freshGroups = new Map<string, CatalogGroupSnapshot>();
      for (const group of catalog.groups) {
        if (group && typeof group.id === "string" && group.stories.length > 0) {
          freshGroups.set(group.id, group);
        }
      }

      const sameEntry = (a: StoryEntry, b: StoryEntry) =>
        a === b || JSON.stringify(a) === JSON.stringify(b);

      setFavorites((prev) => {
        let changed = false;

        /** 内容有变才返回新 map，否则返回 null 表示原样保留。 */
        const refreshMap = (stored: FavoriteStoryMap): FavoriteStoryMap | null => {
          let mapChanged = false;
          const next: FavoriteStoryMap = {};
          for (const [id, story] of Object.entries(stored)) {
            const fresh = freshById.get(id);
            if (fresh && !sameEntry(fresh, story)) {
              next[id] = fresh;
              mapChanged = true;
            } else {
              next[id] = story;
            }
          }
          return mapChanged ? next : null;
        };

        const refreshedStories = refreshMap(prev.stories);
        if (refreshedStories) changed = true;

        let groupsChanged = false;
        const nextGroups: Record<string, FavoriteGroup> = {};
        for (const [groupId, group] of Object.entries(prev.groups)) {
          const catalogGroup = freshGroups.get(groupId);
          if (!catalogGroup) {
            const refreshed = refreshMap(group.stories);
            if (refreshed) {
              nextGroups[groupId] = { ...group, stories: refreshed };
              groupsChanged = true;
            } else {
              nextGroups[groupId] = group;
            }
            continue;
          }

          // 成员以目录为准补齐，但跳过用户显式摘掉的那些（excludedStoryIds）：
          // 补齐是为了跟上新数据包，不是为了推翻用户的手动取消。
          const excluded = new Set(group.excludedStoryIds ?? []);
          const stories: FavoriteStoryMap = {};
          const storyIds: string[] = [];
          for (const story of catalogGroup.stories) {
            if (!story || typeof story.storyId !== "string") continue;
            if (excluded.has(story.storyId)) continue;
            if (stories[story.storyId]) continue;
            stories[story.storyId] = story;
            storyIds.push(story.storyId);
          }
          if (storyIds.length === 0) {
            nextGroups[groupId] = group;
            continue;
          }

          const sameMembers =
            storyIds.length === group.storyIds.length &&
            storyIds.every((id, index) => id === group.storyIds[index]) &&
            storyIds.every(
              (id) => Boolean(group.stories[id]) && sameEntry(stories[id], group.stories[id])
            );
          if (sameMembers && catalogGroup.name === group.name && catalogGroup.type === group.type) {
            nextGroups[groupId] = group;
          } else {
            nextGroups[groupId] = {
              id: group.id,
              name: catalogGroup.name,
              type: catalogGroup.type,
              storyIds,
              stories,
              ...(group.excludedStoryIds && group.excludedStoryIds.length > 0
                ? { excludedStoryIds: group.excludedStoryIds }
                : {}),
            };
            groupsChanged = true;
          }
        }
        if (groupsChanged) changed = true;

        if (!changed) return prev;
        return {
          stories: refreshedStories ?? prev.stories,
          groups: groupsChanged ? nextGroups : prev.groups,
        };
      });
    },
    []
  );

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
      reconcileCatalog,
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
      reconcileCatalog,
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
