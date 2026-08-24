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
import {
  EMPTY_FAVORITES,
  collectFavoriteGroupStoryIds,
  parseFavoritesStorage,
  reconcileFavoritesState,
  serializeFavoritesState,
  type CatalogGroupSnapshot,
  type FavoriteGroup,
  type FavoriteGroupPayload,
  type FavoriteStoryMap,
  type FavoritesState,
} from "@/hooks/favoritesUtils";

export type {
  CatalogGroupSnapshot,
  FavoriteGroup,
  FavoriteGroupPayload,
  FavoriteGroupType,
} from "@/hooks/favoritesUtils";

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

const FavoritesContext = createContext<FavoritesContextValue | null>(null);

function readFromStorage(): FavoritesState {
  if (typeof window === "undefined") {
    return EMPTY_FAVORITES;
  }

  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    return parseFavoritesStorage(stored);
  } catch (error) {
    console.warn("[Favorites] 读取本地收藏失败:", error);
    return EMPTY_FAVORITES;
  }
}

/** 失败提示的会话级闩锁：同一轮连续失败只打扰用户一次，写成功后复位。 */
let persistFailureNotified = false;
/**
 * quota/隐私模式写失败后的会话级接力。Provider 可能因路由或错误边界重挂载；
 * 只把失败标记放 ref 里会连同尚未落盘的收藏一起丢掉。
 */
let failedFavoritesWrite: { state: FavoritesState; raw: string } | null = null;

export function FavoritesProvider({ children }: { children: ReactNode }) {
  const inheritedFailedWriteRef = useRef(failedFavoritesWrite !== null);
  const [favorites, setFavorites] = useState<FavoritesState>(
    () => failedFavoritesWrite?.state ?? readFromStorage()
  );

  /**
   * 收藏口径：单章收藏 ∪ 收藏分组展开后的所有章节。
   * 首页统计格、剧情页「收藏」分类、列表里的星标都必须用同一套判断，
   * 否则会出现「分组已收藏、组里每一条却是空心星」这种自相矛盾的状态。
   */
  const groupedStoryIds = useMemo(
    () => collectFavoriteGroupStoryIds(favorites.groups),
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
  const persistFailedRef = useRef(inheritedFailedWriteRef.current);

  const persistFavorites = useCallback(() => {
    try {
      const raw = serializeFavoritesState(favoritesRef.current);
      if (raw === lastRawRef.current) {
        persistFailedRef.current = false;
        failedFavoritesWrite = null;
        return;
      }
      window.localStorage.setItem(STORAGE_KEY, raw);
      lastRawRef.current = raw;
      persistFailedRef.current = false;
      failedFavoritesWrite = null;
      persistFailureNotified = false;
    } catch (error) {
      // setItem 失败（quota 满 / 隐私模式）是原子的：旧数据原样保留。
      // 星标在界面上已经点亮，静默失败等于骗用户「已收藏」，重启后收藏
      // 全没了——提示一次，并留待重试（划线 / 阅读设置 / 进度同款处理）。
      persistFailedRef.current = true;
      const state = favoritesRef.current;
      failedFavoritesWrite = { state, raw: serializeFavoritesState(state) };
      console.warn("[Favorites] 写入本地收藏失败:", error);
      if (!persistFailureNotified) {
        persistFailureNotified = true;
        toastRef.current.error(
          "收藏未能保存到本地存储（空间可能已满），将自动重试",
          15_000
        );
      }
    }
  }, []);

  useEffect(() => {
    if (favorites === initialFavoritesRef.current) {
      // 重挂载接手的是上一个 Provider 没写进去的快照；它不是普通首帧，
      // 必须立刻再试一次，且失败后继续由 pagehide/后续改动重试。
      if (inheritedFailedWriteRef.current) persistFavorites();
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
      failedFavoritesWrite = null;
      persistFailureNotified = false;
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
        // 重新点亮一个曾被从整组收藏里显式摘掉的章节：回到原来的组里，并把
        // excludedStoryIds 里的标记清掉。用户这一下已经推翻了当初的「手动
        // 取消」，标记再留着就永远清不掉——目录校正会一直把这一章挡在组外，
        // 整组收藏从此永远缺这一章；而若把它塞进单章收藏，收藏页还会冒出
        // 一个与已收藏分组同名的「散章」分组，两处同名列表互相打架。
        let rejoined = false;
        const nextGroups: Record<string, FavoriteGroup> = {};
        for (const [groupId, group] of Object.entries(prev.groups)) {
          if (!group.excludedStoryIds?.includes(story.storyId)) {
            nextGroups[groupId] = group;
            continue;
          }
          rejoined = true;
          const excludedStoryIds = group.excludedStoryIds.filter(
            (id) => id !== story.storyId
          );
          const { excludedStoryIds: _cleared, ...rest } = group;
          nextGroups[groupId] = {
            ...rest,
            // 先补在成员末尾即可：下一次目录校正会按目录顺序重排。
            storyIds: [...group.storyIds, story.storyId],
            stories: { ...group.stories, [story.storyId]: story },
            ...(excludedStoryIds.length > 0 ? { excludedStoryIds } : {}),
          };
        }
        if (rejoined) {
          return { ...prev, groups: nextGroups };
        }
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
            // 刻意不带 excludedStoryIds：重新收藏整组是「这组我全都要」的
            // 显式表态。取消收藏时整组对象连同排除名单一起删掉了，这里从
            // 零建组，保证上一轮摘掉过的章节不会被继承成新组的排除项。
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
      setFavorites((previous) => reconcileFavoritesState(previous, catalog));
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
