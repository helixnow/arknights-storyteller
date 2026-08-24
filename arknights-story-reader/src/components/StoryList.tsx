import {
  memo,
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  type RefObject,
} from "react";
import { api } from "@/services/api";
import type { StoryEntry } from "@/types/story";
import { Button } from "@/components/ui/button";
import {
  ArrowDownToLine,
  BookOpen,
  ChevronsDownUp,
  ChevronsUpDown,
  FileText,
  Inbox,
  RefreshCw,
  RotateCcw,
  Search,
  Settings2,
  Star,
  TriangleAlert,
  WifiOff,
  X,
  type LucideIcon,
} from "lucide-react";
import { SyncDialog } from "@/components/SyncDialog";
import { Collapsible } from "@/components/ui/collapsible";
import { CustomScrollArea } from "@/components/ui/custom-scroll-area";
import { Input } from "@/components/ui/input";
import { useFavorites } from "@/hooks/useFavorites";
import type { FavoriteGroupType } from "@/hooks/useFavorites";
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

export type GroupedStories = Array<[string, StoryEntry[]]>;

/** 四个「按分组返回」的剧情分类，数据形状完全一致。 */
type GroupedKey = "main" | "activity" | "sidestory" | "roguelike";
/** 需要向后端拉取的数据块；密录是扁平列表，单独一类。 */
type SectionKey = GroupedKey | "memory";
type Category = SectionKey | "favorites";

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

const SECTION_LABELS: Record<SectionKey, string> = {
  main: "主线剧情",
  activity: "活动剧情",
  sidestory: "支线剧情",
  roguelike: "肉鸽剧情",
  memory: "干员密录",
};

const SECTION_TIMEOUT_MS: Record<SectionKey, number> = {
  main: 8000,
  activity: 8000,
  sidestory: 8000,
  roguelike: 8000,
  // 密录条目多，后端要多扫一层目录，给宽一点。
  memory: 10000,
};

/** 每个分类进入时需要哪些数据块。命中共享缓存时这些都是零 IPC。 */
const CATEGORY_SECTIONS: Record<Category, SectionKey[]> = {
  main: ["main"],
  // 活动要跟支线去重，所以两边都得有数据
  activity: ["activity", "sidestory"],
  sidestory: ["sidestory"],
  roguelike: ["roguelike"],
  memory: ["memory"],
  // 收藏项要靠各分类的映射表还原「所属章节 / 活动」的可读名字
  favorites: ["main", "activity", "sidestory", "roguelike", "memory"],
};

const GROUPED_CATEGORY_META: Record<
  GroupedKey,
  {
    /** 收藏分组 id 前缀。已写进 localStorage，不能改。 */
    idPrefix: string;
    favoriteType: FavoriteGroupType;
    favoriteInactive: string;
    favoriteActive: string;
    emptySearch: string;
    emptyDefault: string;
  }
> = {
  main: {
    idPrefix: "chapter",
    favoriteType: "chapter",
    favoriteInactive: "收藏章节",
    favoriteActive: "取消收藏章节",
    emptySearch: "没有匹配的主线剧情",
    emptyDefault: "暂无主线剧情，可能需要同步。",
  },
  activity: {
    idPrefix: "activity",
    favoriteType: "activity",
    favoriteInactive: "收藏活动",
    favoriteActive: "取消收藏活动",
    emptySearch: "没有匹配的活动剧情",
    emptyDefault: "暂无活动剧情或需要同步",
  },
  sidestory: {
    idPrefix: "sidestory",
    favoriteType: "other",
    favoriteInactive: "收藏支线",
    favoriteActive: "取消收藏支线",
    emptySearch: "没有匹配的支线剧情",
    emptyDefault: "暂无支线剧情或需要同步",
  },
  roguelike: {
    idPrefix: "roguelike",
    favoriteType: "other",
    favoriteInactive: "收藏肉鸽",
    favoriteActive: "取消收藏肉鸽",
    emptySearch: "没有匹配的肉鸽剧情",
    emptyDefault: "暂无肉鸽剧情或需要同步",
  },
};

const PROGRESS_KEY = "reading-progress";

/** 到这个百分比就算读完。首页大卡、列表徽标共用一个口径。 */
export const READ_FINISHED_PCT = 99;

export interface ReadingProgressEntry {
  storyPath: string;
  /** 0~1 */
  percentage: number;
  updatedAt: number;
}

export interface ReadingProgressSnapshot {
  /** storyTxt → 0~1。列表徽标按 key 查表，O(1)。 */
  percent: Record<string, number>;
  /** 按 updatedAt 倒序。首页「最近阅读」直接用这一份。 */
  recent: ReadingProgressEntry[];
}

const EMPTY_PROGRESS: ReadingProgressSnapshot = { percent: {}, recent: [] };

function clampRatio(value: unknown): number {
  const num = Number(value ?? 0);
  if (!Number.isFinite(num)) return 0;
  return Math.min(1, Math.max(0, num));
}

function parseReadingProgress(raw: string | null): ReadingProgressSnapshot {
  if (!raw) return EMPTY_PROGRESS;
  try {
    const parsed = JSON.parse(raw) as Record<
      string,
      { percentage?: number; updatedAt?: number } | null
    >;
    if (!parsed || typeof parsed !== "object") return EMPTY_PROGRESS;

    const percent: Record<string, number> = {};
    const recent: ReadingProgressEntry[] = [];
    for (const [storyPath, value] of Object.entries(parsed)) {
      if (!value || typeof value !== "object") continue;
      const percentage = clampRatio(value.percentage);
      const updatedAt = Number(value.updatedAt ?? 0);
      if (percentage > 0) percent[storyPath] = percentage;
      recent.push({
        storyPath,
        percentage,
        updatedAt: Number.isFinite(updatedAt) ? updatedAt : 0,
      });
    }
    recent.sort((a, b) => b.updatedAt - a.updatedAt);
    return { percent, recent };
  } catch {
    return EMPTY_PROGRESS;
  }
}

let progressRaw: string | null = null;
let progressSnapshot: ReadingProgressSnapshot = EMPTY_PROGRESS;
let progressParsed = false;

/**
 * 阅读进度的共享快照：首页和剧情列表读同一份，口径不可能对不上。
 *
 * 用原始字符串做校验，内容没变就返回同一个对象引用。这一点比省下的
 * `JSON.parse` 更重要：窗口聚焦 / 可见性变化 / 从阅读器返回都会触发刷新，
 * 引用不变时 `setState` 直接被 React bail out，几千行的列表不会因为
 * 「切了一下窗口」整体重渲染一次。
 */
export function getReadingProgress(): ReadingProgressSnapshot {
  if (typeof window === "undefined") return EMPTY_PROGRESS;
  let raw: string | null;
  try {
    raw = window.localStorage.getItem(PROGRESS_KEY);
  } catch {
    return progressSnapshot;
  }
  if (progressParsed && raw === progressRaw) return progressSnapshot;
  progressRaw = raw;
  progressParsed = true;
  progressSnapshot = parseReadingProgress(raw);
  return progressSnapshot;
}

/** 0~1 → 0~100 整数。读过一点点也至少显示 1%，免得看起来像没读。 */
export function toReadPercent(value: number | null | undefined): number {
  if (typeof value !== "number" || !(value > 0)) return 0;
  return Math.min(100, Math.max(1, Math.round(value * 100)));
}

/** 联网状态。同步要连远端，离线时的提示和可用动作完全不一样。 */
export function useOnlineStatus(): boolean {
  const [online, setOnline] = useState(
    () => typeof navigator === "undefined" || navigator.onLine !== false
  );

  useEffect(() => {
    const update = () => setOnline(navigator.onLine !== false);
    update();
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    return () => {
      window.removeEventListener("online", update);
      window.removeEventListener("offline", update);
    };
  }, []);

  return online;
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

/**
 * 剧情目录的进程内共享缓存。
 *
 * 冷启动时首页和剧情列表是同时挂载的：两边都要 `isInstalled`，都要主线分组，
 * 首页还会为了还原「最近阅读」去问活动 / 支线 / 肉鸽 / 密录；随后用户切分类，
 * 剧情列表又要一遍同样的东西。这里统一收口，做三件事：
 *
 * 1. 短 TTL 内存缓存，冷启动阶段的重复请求直接命中；
 * 2. in-flight 去重，并发调用共享同一个 Promise，不会打出两次 IPC；
 * 3. 监听 `app:data-updated`（数据重新同步）整体失效。模块级监听在 import
 *    时就注册，早于任何组件的 effect，所以组件收到同一事件时缓存必定已清空。
 *
 * TTL 只是兜底：首页每次获得焦点都会重新 load 一遍，没有 TTL 的话窗口切换
 * 就会变成一串没必要的 IPC；有了 TTL，这些刷新几乎只是重读 localStorage。
 */
const CATALOG_TTL_MS = 60_000;

interface CatalogHit {
  value: unknown;
  at: number;
}

const catalogValues = new Map<string, CatalogHit>();
const catalogInflight = new Map<string, Promise<unknown>>();
let catalogVersion = 0;

function catalogFetch<T>(key: string, loader: () => Promise<T>, force: boolean): Promise<T> {
  if (force) catalogValues.delete(key);

  const hit = catalogValues.get(key);
  if (hit && Date.now() - hit.at < CATALOG_TTL_MS) {
    return Promise.resolve(hit.value as T);
  }

  const pending = catalogInflight.get(key) as Promise<T> | undefined;
  if (pending) return pending;

  const startedAt = catalogVersion;
  const request = loader().then((value) => {
    // 请求期间数据被重新同步过，这份结果已经过期，不能进缓存。
    if (catalogVersion === startedAt) {
      catalogValues.set(key, { value, at: Date.now() });
    }
    return value;
  });
  const release = () => {
    if (catalogInflight.get(key) === request) catalogInflight.delete(key);
  };
  request.then(release, release);
  catalogInflight.set(key, request);
  return request;
}

const GROUPED_FETCHERS: Record<GroupedKey, () => Promise<GroupedStories>> = {
  main: () => api.getMainStoriesGrouped(),
  activity: () => api.getActivityStoriesGrouped(),
  sidestory: () => api.getSidestoryStoriesGrouped(),
  roguelike: () => api.getRoguelikeStoriesGrouped(),
};

export const storyCatalog = {
  isInstalled: (force = false) =>
    catalogFetch<boolean>("installed", () => api.isInstalled(), force),
  grouped: (key: GroupedKey, force = false) =>
    catalogFetch<GroupedStories>(`grouped:${key}`, GROUPED_FETCHERS[key], force),
  memory: (force = false) =>
    catalogFetch<StoryEntry[]>("memory", () => api.getMemoryStories(), force),
};

/** 剧情数据换了一批：整体失效，下一次请求重新打 IPC。 */
export function invalidateStoryCatalog() {
  catalogVersion += 1;
  catalogValues.clear();
  catalogInflight.clear();
}

if (typeof window !== "undefined") {
  window.addEventListener("app:data-updated", invalidateStoryCatalog);
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

/**
 * 单条简介的最大请求次数（含首次）。失败后行组件的 effect 会因 loading
 * 复位而立刻再触发一次——不设上限的话，持久性失败（文件缺失、数据损坏）
 * 会变成「失败 → 清标记 → 立刻重发」的死循环，IPC 被无限打。上限内的
 * 一次自动重试足以覆盖瞬时失败；重新同步数据时计数整体清零，可以重来。
 */
const SUMMARY_MAX_ATTEMPTS = 2;

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

/**
 * 分批挂载的批量大小。首屏只铺一屏多一点，其余靠滚动追加。
 * 分组头很轻（一行文字 + 两个按钮），可以给得比条目大方一些。
 */
const ROWS_FIRST_CHUNK = 48;
const ROWS_NEXT_CHUNK = 48;
const GROUPS_FIRST_CHUNK = 24;
const GROUPS_NEXT_CHUNK = 24;

interface ProgressiveList {
  /** 当前允许渲染的条数。 */
  visible: number;
  done: boolean;
  remaining: number;
  sentinelRef: RefObject<HTMLDivElement | null>;
  revealAll: () => void;
}

/**
 * 「只增不减」的分批挂载。
 *
 * 这里刻意没有上虚拟滚动：列表里混着可折叠分组、随简介开关变高的卡片，
 * 外层还有 KeepAlive 常驻的滚动容器，虚拟化必须自己接管高度测量和滚动
 * 恢复——任何一处算错，「切回剧情页停在原处」「搜索命中后跳过去」
 * 「从首页跳收藏」这些既有行为就全废了。
 *
 * 分批挂载只在列表尾部追加节点：滚动高度单调增长，已经渲染出来的行永远
 * 不会被回收，所以滚动位置、搜索结果、收藏跳转都不受影响；同时首屏的 DOM
 * 节点数、缩略图 token 的 IPC 数都被压到「一屏」的量级——干员密录那种
 * 上千条的扁平列表，冷启动时不再一次性排队上千次 IPC。
 */
function useProgressiveList(
  total: number,
  options: {
    initial: number;
    step: number;
    /** 变化即从第一批重新开始（换分类、换搜索词）。 */
    resetKey: string;
    rootRef: RefObject<HTMLElement | null>;
  }
): ProgressiveList {
  const { initial, step, resetKey, rootRef } = options;
  const [count, setCount] = useState(initial);
  const sentinelRef = useRef<HTMLDivElement | null>(null);

  const resetKeyRef = useRef(resetKey);
  if (resetKeyRef.current !== resetKey) {
    resetKeyRef.current = resetKey;
    if (count !== initial) setCount(initial);
  }

  const visible = Math.min(count, total);
  const done = visible >= total;

  useEffect(() => {
    if (done) return;
    const node = sentinelRef.current;
    if (!node) return;

    // 没有 IntersectionObserver 的环境直接放完，宁可慢一点也不能少内容。
    if (typeof IntersectionObserver === "undefined") {
      setCount(total);
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setCount((prev) => Math.min(prev + step, total));
        }
      },
      // root 必须是真正的滚动容器：用默认视口的话，rootMargin 会被容器的
      // overflow 裁掉，预取窗口形同虚设。
      { root: rootRef.current, rootMargin: "800px 0px" }
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [done, rootRef, step, total, visible]);

  const revealAll = useCallback(() => setCount(total), [total]);

  return { visible, done, remaining: Math.max(0, total - visible), sentinelRef, revealAll };
}

interface StoryListProps {
  onSelectStory: (story: StoryEntry) => void;
}

function emptyGroups(): Record<GroupedKey, GroupedStories> {
  return { main: [], activity: [], sidestory: [], roguelike: [] };
}

/** 稳定的空分组列表，供「当前分类不是分组类」时占位，避免每次渲染新建数组。 */
const NO_GROUPS: GroupedStories = [];

function initialSectionFlags(value: boolean): Record<SectionKey, boolean> {
  return {
    main: value,
    activity: value,
    sidestory: value,
    roguelike: value,
    memory: value,
  };
}

/** 加载失败的成因。每一种都对应一套不同的文案和可执行动作。 */
type LoadErrorKind = "not-installed" | "timeout" | "unknown";

interface LoadErrorState {
  kind: LoadErrorKind;
  /** 出错的数据块名字，用于「读取活动剧情超时」这类具体标题。 */
  label: string;
  /** 后端原文，只在无法归类时展示，方便用户反馈。 */
  detail?: string;
}

export function StoryList({ onSelectStory }: StoryListProps) {
  const [groups, setGroups] = useState<Record<GroupedKey, GroupedStories>>(emptyGroups);
  const [memoryStories, setMemoryStories] = useState<StoryEntry[]>([]);
  const [sectionLoading, setSectionLoading] = useState<Record<SectionKey, boolean>>(() => ({
    ...initialSectionFlags(false),
    // 主线是默认分类，进来就在加载。
    main: true,
  }));
  const [error, setError] = useState<LoadErrorState | null>(null);
  const [syncDialogOpen, setSyncDialogOpen] = useState(false);
  const [installed, setInstalled] = useState<boolean | null>(null);
  const [activeCategory, setActiveCategory] = useState<Category>("main");
  const [searchTerm, setSearchTerm] = useState("");
  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>({});
  /** 「展开全部 / 收起全部」的批量意图；null 表示按各分组自己的默认值来。 */
  const [bulkOpen, setBulkOpen] = useState<boolean | null>(null);
  const [progress, setProgress] = useState<ReadingProgressSnapshot>(getReadingProgress);
  const { showSummaries, setShowSummaries } = useAppPreferences();
  const [summaryCache, setSummaryCache] = useState<Record<string, string>>({});
  const [summaryLoadingIds, setSummaryLoadingIds] = useState<Record<string, boolean>>({});
  const online = useOnlineStatus();
  /** 分批挂载的 IntersectionObserver 需要真正的滚动容器当 root。 */
  const scrollRootRef = useRef<HTMLDivElement | null>(null);

  // 每块数据是否已加载 / 在途的 Promise。用 ref 保存，这样 loadSection
  // 能保持稳定引用，effect 不会因为 state 变化重复触发。
  const loadedRef = useRef<Record<SectionKey, boolean>>(initialSectionFlags(false));
  const pendingRef = useRef<Partial<Record<SectionKey, Promise<void>>>>({});
  /**
   * 当前分类的镜像，供异步落地的请求判断「这块数据还与用户正看的页面
   * 相关吗」。典型场景：在活动分类等了几秒没等到、切回主线，8 秒后活动
   * 的超时才落地——它没有被 force 顶替（isCurrent 为真），但把「读取
   * 活动剧情超时」立在健康的主线列表上就是把错误写到了别人的页面。
   */
  const activeCategoryRef = useRef<Category>(activeCategory);
  /** 每条简介已发起的请求次数 / 在途标记，配合 SUMMARY_MAX_ATTEMPTS 封顶。 */
  const summaryAttemptsRef = useRef<Map<string, number>>(new Map());
  const summaryInflightRef = useRef<Set<string>>(new Set());

  const {
    favoriteStories,
    favoriteGroups,
    favoriteGroupStoryIds,
    favoriteCount,
    isFavorite,
    toggleFavorite,
    isGroupFavorite,
    toggleFavoriteGroup,
  } = useFavorites();

  /**
   * 把后端的失败原因归类。这里顺手把「数据目录被删/被换掉」的情况回写成
   * `installed = false`：否则界面只会显示一句干巴巴的「加载失败」，而真正
   * 该做的事（同步一次）藏在别处。
   *
   * `silent` 供已经与当前分类无关的过期请求使用：只记日志、不立错误卡。
   * `installed = false` 仍然回写——数据目录没了是全局事实，与分类无关。
   */
  const handleLoadError = useCallback((label: string, err: unknown, silent = false) => {
    const errorMsg = err instanceof Error ? err.message : String(err ?? "");
    console.error(`[StoryList] 加载${label}失败:`, errorMsg, err);

    if (errorMsg === "TIMEOUT") {
      if (!silent) setError({ kind: "timeout", label });
      return;
    }
    if (isNotInstalledError(errorMsg)) {
      if (!silent) setError({ kind: "not-installed", label });
      setInstalled(false);
      return;
    }
    if (!silent) setError({ kind: "unknown", label, detail: errorMsg || undefined });
  }, []);

  const setSectionBusy = useCallback((key: SectionKey, busy: boolean) => {
    setSectionLoading((prev) => (prev[key] === busy ? prev : { ...prev, [key]: busy }));
  }, []);

  /**
   * 加载一块数据。同一块同时只会有一个「有效」任务：非 force 的后来者拿到
   * 同一个 Promise，所以 `await loadSection(...)` 真的等到数据落地（旧实现
   * 是直接 return，调用方会以为已经加载完）。
   *
   * force 是例外：它意味着数据源刚换过（同步完成 / 重试），在途任务拿到的
   * 还是旧数据源的结果，复用它会把旧数据当新数据写进 state、把 loadedRef
   * 标成已加载，同步好的新数据反而永远不会被拉。所以 force 直接另起新任务
   * 顶掉 pendingRef 的归属；旧任务落地时靠归属检查放弃写入。
   */
  const loadSection = useCallback(
    (key: SectionKey, force = false): Promise<void> => {
      if (!force && loadedRef.current[key]) return Promise.resolve();

      const pending = pendingRef.current[key];
      if (pending && !force) return pending;

      const task: Promise<void> = (async () => {
        setSectionBusy(key, true);
        setError(null);
        // 落地时归属可能已经易主（被更新的 force 任务顶替，或被同步事件
        // 整体作废）。不是自己就什么都不写，旧数据不能盖掉新数据。
        const isCurrent = () => pendingRef.current[key] === task;
        try {
          if (key === "memory") {
            const data = await withTimeout(
              storyCatalog.memory(force),
              SECTION_TIMEOUT_MS.memory
            );
            if (!isCurrent()) return;
            setMemoryStories(data);
          } else {
            const data = await withTimeout(
              storyCatalog.grouped(key, force),
              SECTION_TIMEOUT_MS[key]
            );
            if (!isCurrent()) return;
            setGroups((prev) => ({ ...prev, [key]: data }));
          }
          loadedRef.current[key] = true;
        } catch (err) {
          // 被顶替的任务连错误也不该报：数据源已换，这份失败没有意义。
          // 归属还在但用户已切去别的分类时，只记日志不立卡（silent）：
          // 下次进入该分类会重新加载，真失败会在正确的页面上重新报。
          if (isCurrent()) {
            const relevant = CATEGORY_SECTIONS[activeCategoryRef.current].includes(key);
            handleLoadError(SECTION_LABELS[key], err, !relevant);
          }
        } finally {
          if (isCurrent()) {
            pendingRef.current[key] = undefined;
            setSectionBusy(key, false);
          } else if (!pendingRef.current[key]) {
            // 被整体作废且没有后继任务接手：busy 没人清会卡住骨架屏。
            setSectionBusy(key, false);
          }
        }
      })();

      pendingRef.current[key] = task;
      return task;
    },
    [handleLoadError, setSectionBusy]
  );

  /** 分类加载的唯一入口：pill 只负责切 activeCategory，加载由 effect 统一触发。 */
  const loadCategory = useCallback(
    (category: Category, force = false) =>
      Promise.all(
        CATEGORY_SECTIONS[category].map((section) => loadSection(section, force))
      ).then(() => undefined),
    [loadSection]
  );

  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        // 3s 安全超时，防止 isInstalled 因异常挂起
        const ok = await withTimeout(storyCatalog.isInstalled(), 3000);
        if (cancelled) return;
        setInstalled(ok);
        if (!ok) {
          setSyncDialogOpen(true);
          setSectionBusy("main", false);
        }
      } catch (e) {
        if (cancelled) return;
        console.error("[StoryList] isInstalled 失败，回退到同步对话框:", e);
        setInstalled(false);
        setError({ kind: "not-installed", label: "本地数据" });
        setSyncDialogOpen(true);
        setSectionBusy("main", false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [setSectionBusy]);

  // 数据就绪后：当前分类按需加载；主线始终加载（收藏分组名依赖它）。
  useEffect(() => {
    if (installed !== true) return;
    void loadSection("main");
  }, [installed, loadSection]);

  useEffect(() => {
    activeCategoryRef.current = activeCategory;
  }, [activeCategory]);

  // 切分类时清掉上一个分类遗留的错误卡：目标分类若已加载完成，
  // loadSection 会直接短路返回，永远没有时机清 error，健康的列表上方
  // 会一直压着一张与它无关的旧错误（例如活动超时后切回主线）。
  // 新分类真的需要加载且再次失败时，会重新设置一张对应的错误卡。
  const errorClearCategoryRef = useRef(activeCategory);
  useEffect(() => {
    if (errorClearCategoryRef.current === activeCategory) return;
    errorClearCategoryRef.current = activeCategory;
    setError(null);
  }, [activeCategory]);

  useEffect(() => {
    if (installed !== true) return;
    void loadCategory(activeCategory);
  }, [activeCategory, installed, loadCategory]);

  // 剧情数据重新同步：所有分类缓存作废，重新拉当前分类。
  // 共享目录缓存由模块级监听清理，那个监听比这里先注册，所以此处一定拿新数据。
  useEffect(() => {
    const handler = () => {
      loadedRef.current = initialSectionFlags(false);
      // 作废所有在途任务的归属：没被下面强制重载覆盖到的分块（比如之前
      // 逛过的密录）若还在途，落地时会把同步前的旧数据写进 state 并自标
      // 已加载。清掉归属后它们会静默放弃写入，下次进入该分类重新拉取。
      pendingRef.current = {};
      summaryAttemptsRef.current.clear();
      summaryInflightRef.current.clear();
      setSummaryCache({});
      setSummaryLoadingIds({});
      setOpenGroups({});
      setError(null);
      setInstalled(true);
      // 主线不管在哪个分类都要重来一次：收藏分组名依赖它的映射表。
      void loadSection("main", true);
      void loadCategory(activeCategory, true);
    };
    window.addEventListener("app:data-updated", handler);
    return () => window.removeEventListener("app:data-updated", handler);
  }, [activeCategory, loadCategory, loadSection]);

  // 首页统计格 / 其他入口要求直接跳到收藏分类
  useEffect(() => {
    const handler = () => {
      setActiveCategory("favorites");
      // 入口语义是「去看收藏」而不是「回到上次在收藏里停的位置」。分类
      // 真的变化时下面的归顶 effect 也会跑一次；这里显式回顶是为了覆盖
      // 「本来就停在收藏分类、只是滚到了半截」的跳转。
      const viewport = scrollRootRef.current;
      if (viewport) viewport.scrollTop = 0;
    };
    window.addEventListener("app:open-favorites", handler);
    return () => window.removeEventListener("app:open-favorites", handler);
  }, []);

  // 阅读进度刷新时机：窗口重新聚焦、页面重新可见、数据更新，以及
  // `app:home-refresh` —— 打开剧情和从阅读器返回都会广播它，这正是进度
  // 唯一会变的时刻。（列表是 KeepAlive 常驻的，切 tab 不重新挂载，
  // 而 visibility:hidden 仍然占布局，IntersectionObserver 探测不到切换。）
  useEffect(() => {
    // 快照没变时 `getReadingProgress()` 返回同一个引用，setState 直接被
    // React 丢弃——所以这几个高频事件不会引发任何重渲染。
    const refresh = () => setProgress(getReadingProgress());
    refresh();
    window.addEventListener("focus", refresh);
    window.addEventListener("app:home-refresh", refresh);
    window.addEventListener("app:data-updated", refresh);
    document.addEventListener("visibilitychange", refresh);

    return () => {
      window.removeEventListener("focus", refresh);
      window.removeEventListener("app:home-refresh", refresh);
      window.removeEventListener("app:data-updated", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, []);

  const handleRequestSummary = useCallback(async (story: StoryEntry) => {
    const storyInfo = story.storyInfo;
    if (!storyInfo) return;
    // 同一条剧情可能同时出现在收藏和原分类里，两行都会来要简介。
    if (summaryInflightRef.current.has(story.storyId)) return;
    const attempts = summaryAttemptsRef.current.get(story.storyId) ?? 0;
    if (attempts >= SUMMARY_MAX_ATTEMPTS) return;
    summaryAttemptsRef.current.set(story.storyId, attempts + 1);
    summaryInflightRef.current.add(story.storyId);

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
      // 保留计数：行组件的 effect 会自动重试到上限为止，之后由占位文案兜底。
    } finally {
      summaryInflightRef.current.delete(story.storyId);
      setSummaryLoadingIds((prev) => {
        const next = { ...prev };
        delete next[story.storyId];
        return next;
      });
    }
  }, []);

  const favoriteStoryEntries = useMemo(() => Object.values(favoriteStories), [favoriteStories]);
  const favoriteGroupEntries = useMemo(
    () => Object.values(favoriteGroups),
    [favoriteGroups]
  );

  // 过滤放到低优先级渲染里：searchTerm 是 CatalogSearchInput 提交上来的
  // 已确认关键词（合成期间的拼音中间态根本到不了这里），deferred 一侧再去
  // 重算几千行的匹配。输入框永远先跟上手速，摘要/空态文案与过滤结果
  // 取同一个值，不会出现「计数是旧词、列表是新词」的错位。
  const deferredSearchTerm = useDeferredValue(searchTerm);
  const trimmedSearch = deferredSearchTerm.trim();
  const normalizedSearch = trimmedSearch.toLowerCase();
  const hasSearch = normalizedSearch.length > 0;

  // 搜索时默认展开所有命中分组；退出搜索或换分类时把用户的手动展开状态清掉。
  useEffect(() => {
    setOpenGroups({});
    setBulkOpen(null);
  }, [hasSearch, activeCategory]);

  // 切分类 / 改搜索词是「整个列表被换掉」的时刻：旧的滚动偏移只会被浏览器
  // 随机夹在新内容的半截（KeepAlive 常驻挂载，容器从不重建）。统一归顶。
  // 分批挂载保证的是同一列表内追加不动滚动，与这里不冲突。
  const scrollResetKey = `${activeCategory}|${normalizedSearch}`;
  const scrollResetRef = useRef(scrollResetKey);
  useEffect(() => {
    if (scrollResetRef.current === scrollResetKey) return;
    scrollResetRef.current = scrollResetKey;
    const viewport = scrollRootRef.current;
    if (viewport && viewport.scrollTop !== 0) viewport.scrollTop = 0;
  }, [scrollResetKey]);

  const isGroupOpen = useCallback(
    (key: string, fallbackOpen: boolean) => {
      const explicit = openGroups[key];
      if (explicit !== undefined) return explicit;
      if (bulkOpen !== null) return bulkOpen;
      return hasSearch ? true : fallbackOpen;
    },
    [bulkOpen, hasSearch, openGroups]
  );

  const setGroupOpen = useCallback((key: string, open: boolean) => {
    setOpenGroups((prev) => ({ ...prev, [key]: open }));
  }, []);

  /**
   * 「展开全部」按钮的有效状态。搜索中分组默认全部展开（isGroupOpen 的
   * 兜底就是 hasSearch），按钮必须如实反映这一点：否则搜索时明明全都
   * 开着，按钮却写着「展开全部」、aria-pressed 还是 false，第一下点击
   * 毫无反应。
   */
  const bulkExpanded = bulkOpen ?? hasSearch;

  /** 批量展开 / 收起。逐条覆盖也要清掉，否则单独点过的分组不跟随。 */
  const toggleBulkOpen = useCallback(() => {
    setBulkOpen(!bulkExpanded);
    setOpenGroups({});
  }, [bulkExpanded]);

  /**
   * 分组标题的键盘增强。Enter / Space 由 Collapsible 里的原生 `<button>`
   * 负责（这也是不把标题做成 div 的原因），这里补上手风琴常见的方向键：
   * 上下在标题间移动焦点，左右展开 / 收起。活动分类有两百多个分组，
   * 靠 Tab 一格格走过去是不现实的。
   *
   * 只处理焦点落在标题按钮上的事件——条目行冒泡上来的按键不受影响。
   */
  const handleGroupListKeyDown = useCallback((event: ReactKeyboardEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement | null;
    if (!target || target.getAttribute("aria-expanded") === null) return;

    const expanded = target.getAttribute("aria-expanded") === "true";
    if (event.key === "ArrowRight" || event.key === "ArrowLeft") {
      const shouldOpen = event.key === "ArrowRight";
      if (expanded !== shouldOpen) {
        event.preventDefault();
        target.click();
      }
      return;
    }

    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;

    const headers = Array.from(
      event.currentTarget.querySelectorAll<HTMLElement>("[aria-expanded]")
    );
    const index = headers.indexOf(target);
    if (index < 0) return;

    const next =
      event.key === "ArrowDown"
        ? index + 1
        : event.key === "ArrowUp"
        ? index - 1
        : event.key === "Home"
        ? 0
        : headers.length - 1;
    const node = headers[Math.max(0, Math.min(headers.length - 1, next))];
    if (!node || node === target) return;
    event.preventDefault();
    node.focus();
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

  // 支线已经单独成一类；无论是否在搜索，都不要在活动里再出现一遍。
  const activityGroups = useMemo(() => {
    if (groups.sidestory.length === 0) return groups.activity;
    const sidestoryNames = new Set(groups.sidestory.map(([name]) => name));
    return groups.activity.filter(([name]) => !sidestoryNames.has(name));
  }, [groups.activity, groups.sidestory]);

  /** 去重后的四类分组数据，渲染与「整组收藏」都以它为准。 */
  const visibleGroups = useMemo<Record<GroupedKey, GroupedStories>>(
    () => ({
      main: groups.main,
      activity: activityGroups,
      sidestory: groups.sidestory,
      roguelike: groups.roguelike,
    }),
    [activityGroups, groups.main, groups.roguelike, groups.sidestory]
  );

  const groupNameMap = useMemo(() => {
    const map = new Map<string, string>();

    // 后写的覆盖先写的，所以顺序按「名字质量」从低到高排。
    (["roguelike", "sidestory", "activity", "main"] as GroupedKey[]).forEach((key) => {
      visibleGroups[key].forEach(([groupDisplayName, stories]) => {
        stories.forEach((story) => {
          if (story.storyGroup) {
            map.set(story.storyGroup, groupDisplayName);
          }
        });
      });
    });

    memoryStories.forEach((story) => {
      if (story.storyGroup) {
        map.set(story.storyGroup, story.storyGroup);
      }
    });

    return map;
  }, [memoryStories, visibleGroups]);

  /** 分组名 → 该组的完整剧情列表。整组收藏要收全部，不是搜索后的子集。 */
  const fullGroupMaps = useMemo<Record<GroupedKey, Map<string, StoryEntry[]>>>(
    () => ({
      main: new Map(visibleGroups.main),
      activity: new Map(visibleGroups.activity),
      sidestory: new Map(visibleGroups.sidestory),
      roguelike: new Map(visibleGroups.roguelike),
    }),
    [visibleGroups]
  );

  /** 组名命中就整组保留，否则只留命中的条目；空组直接丢掉。 */
  const filterGrouped = useCallback(
    (list: GroupedStories): GroupedStories => {
      if (!hasSearch) return list;
      return list
        .map(([name, stories]) =>
          name.toLowerCase().includes(normalizedSearch)
            ? ([name, stories] as [string, StoryEntry[]])
            : ([name, stories.filter(matchesSearch)] as [string, StoryEntry[]])
        )
        .filter(([, stories]) => stories.length > 0);
    },
    [hasSearch, matchesSearch, normalizedSearch]
  );

  const filteredGroups = useMemo<Record<GroupedKey, GroupedStories>>(
    () => ({
      main: filterGrouped(visibleGroups.main),
      activity: filterGrouped(visibleGroups.activity),
      sidestory: filterGrouped(visibleGroups.sidestory),
      roguelike: filterGrouped(visibleGroups.roguelike),
    }),
    [filterGrouped, visibleGroups]
  );

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

        // 与分组分类的搜索语义对齐：组名命中就整组保留。收藏的往往正是
        // 「整个活动 / 整个章节」，只按条目标题过滤会让用户搜活动名时
        // 得到「没有匹配」，而同一个词在活动分类里却能搜到。
        const nameMatches =
          hasSearch && group.name.toLowerCase().includes(normalizedSearch);
        const visibleStories =
          !hasSearch || nameMatches ? allStories : allStories.filter(matchesSearch);
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
  }, [favoriteGroupEntries, hasSearch, matchesSearch, normalizedSearch]);

  const individualFavoriteStories = useMemo(() => {
    if (favoriteStoryEntries.length === 0) return [];
    return favoriteStoryEntries.filter((story) => !favoriteGroupStoryIds.has(story.storyId));
  }, [favoriteStoryEntries, favoriteGroupStoryIds]);

  const individualFavoriteGroups = useMemo(() => {
    if (individualFavoriteStories.length === 0) return [];

    // 先按完整成员分组、后做搜索过滤：整组操作（「取消收藏该组」）必须
    // 拿到全部成员，只拿搜索命中的子集会把没命中的收藏漏在原地——
    // 清掉搜索词后分组又冒回来，看起来像操作没生效。
    const grouped = new Map<string, StoryEntry[]>();
    individualFavoriteStories.forEach((story) => {
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
        const allStories = [...stories].sort((a, b) => {
          if (a.storySort !== b.storySort) {
            return a.storySort - b.storySort;
          }
          return a.storyName.localeCompare(b.storyName, "zh-Hans");
        });

        const displayName =
          groupKey === "__ungrouped__"
            ? "未分组"
            : groupNameMap.get(groupKey) || groupKey || "未分组";

        // 与分组分类的搜索语义对齐：组名命中就整组保留，否则只留命中条目。
        const nameMatches =
          hasSearch && displayName.toLowerCase().includes(normalizedSearch);
        const visibleStories =
          !hasSearch || nameMatches ? allStories : allStories.filter(matchesSearch);
        if (visibleStories.length === 0) return null;

        return { groupKey, displayName, allStories, visibleStories };
      })
      .filter((item): item is NonNullable<typeof item> => Boolean(item))
      .sort((a, b) => a.displayName.localeCompare(b.displayName, "zh-Hans"));
  }, [groupNameMap, hasSearch, individualFavoriteStories, matchesSearch, normalizedSearch]);

  /** 当前分类在当前筛选条件下真正会渲染出来的条目数。 */
  const visibleStoryCount = useMemo(() => {
    if (activeCategory === "memory") return filteredMemoryStories.length;
    if (activeCategory === "favorites") {
      // 两份列表互斥（individual 会排掉分组内的条目），可以直接相加。
      return (
        favoriteGroupList.reduce((total, group) => total + group.visibleStories.length, 0) +
        individualFavoriteGroups.reduce(
          (total, group) => total + group.visibleStories.length,
          0
        )
      );
    }
    return filteredGroups[activeCategory].reduce(
      (total, [, stories]) => total + stories.length,
      0
    );
  }, [
    activeCategory,
    favoriteGroupList,
    filteredGroups,
    filteredMemoryStories.length,
    individualFavoriteGroups,
  ]);

  const activeSummary = useMemo(() => {
    if (hasSearch) {
      return `搜索“${trimmedSearch}” · 命中 ${visibleStoryCount} 条`;
    }
    if (activeCategory === "favorites" && favoriteCount > 0) {
      return `已收藏 ${favoriteCount} 条剧情`;
    }
    return CATEGORY_DESCRIPTIONS[activeCategory];
  }, [activeCategory, favoriteCount, hasSearch, trimmedSearch, visibleStoryCount]);

  const openSync = useCallback(() => setSyncDialogOpen(true), []);
  const clearSearch = useCallback(() => setSearchTerm(""), []);
  const goToSettings = useCallback(() => {
    window.dispatchEvent(new CustomEvent("app:go-tab", { detail: "settings" }));
  }, []);
  const goToFullTextSearch = useCallback(() => {
    window.dispatchEvent(new CustomEvent("app:go-tab", { detail: "search" }));
  }, []);
  const browseMainStories = useCallback(() => setActiveCategory("main"), []);

  /** 当前分类是否有数据块正在加载；重试按钮据此禁用。 */
  const categoryBusy = CATEGORY_SECTIONS[activeCategory].some(
    (section) => sectionLoading[section]
  );

  const retryActive = useCallback(() => {
    setError(null);
    // 主线要一起重来：收藏分组名依赖它的映射表。
    void loadSection("main", true);
    void loadCategory(activeCategory, true);
  }, [activeCategory, loadCategory, loadSection]);

  const handleSyncSuccess = useCallback(async () => {
    setInstalled(true);
    setError(null);
    // 同步对话框不一定广播 `app:data-updated`，这里自己把共享缓存清掉。
    invalidateStoryCatalog();
    loadedRef.current = initialSectionFlags(false);
    // 同上面 data-updated 的处理：在途任务全部作废，免得旧数据回写。
    pendingRef.current = {};
    summaryAttemptsRef.current.clear();
    summaryInflightRef.current.clear();
    setSummaryCache({});
    setSummaryLoadingIds({});
    // 并发发起：目录层有 in-flight 去重，主线不会打两次 IPC。
    await Promise.all([loadSection("main", true), loadCategory(activeCategory, true)]);
    setSyncDialogOpen(false);
  }, [activeCategory, loadCategory, loadSection]);

  /**
   * 行组件是 `memo` 的，所以传下去的回调必须是稳定引用，否则每次父级
   * 重渲染（换一个字的搜索词、某一条简介回来了）都会把整屏卡片连同
   * 缩略图一起重画。行内需要的 `story` 由行自己回传。
   */
  const handleToggleFavorite = useCallback(
    (story: StoryEntry) => toggleFavorite(story),
    [toggleFavorite]
  );

  const renderStoryItem = useCallback(
    (story: StoryEntry, keyPrefix?: string) => (
      <StoryItem
        key={keyPrefix ? `${keyPrefix}-${story.storyId}` : story.storyId}
        story={story}
        onSelectStory={onSelectStory}
        isFavorite={isFavorite(story.storyId)}
        onToggleFavorite={handleToggleFavorite}
        showSummary={showSummaries}
        summary={summaryCache[story.storyId]}
        summaryLoading={Boolean(summaryLoadingIds[story.storyId])}
        onRequestSummary={handleRequestSummary}
        progress={progress.percent[story.storyTxt]}
      />
    ),
    [
      handleRequestSummary,
      handleToggleFavorite,
      isFavorite,
      onSelectStory,
      progress,
      showSummaries,
      summaryCache,
      summaryLoadingIds,
    ]
  );

  /** 只在「还没有任何数据」时铺骨架，刷新已有列表不闪。 */
  const isSectionPending = useCallback(
    (key: SectionKey) => {
      if (installed === null) return true;
      const empty = key === "memory" ? memoryStories.length === 0 : groups[key].length === 0;
      if (!empty) return false;
      // 加载由 effect 在绘制之后才发起：首次切到一个没加载过的分类，
      // 首帧 busy 仍是 false。若此时按「没有数据」渲染，会先闪一帧
      // 「本地数据里没有 X，多半是数据包版本偏旧」的误导空态，再变成
      // 骨架屏。还没加载过、也没有失败记录的分块一律先按加载中处理，
      // 等请求真正落地再下「确实没有」的结论。失败过的（error 非空）
      // 交给下方错误卡解释，这里不能再罩骨架把它盖住。
      return sectionLoading[key] || (!loadedRef.current[key] && !error);
    },
    [error, groups, installed, memoryStories.length, sectionLoading]
  );

  /** 当前分组分类的列表（密录 / 收藏走各自的分支）。 */
  const activeGroupedList =
    activeCategory === "memory" || activeCategory === "favorites"
      ? NO_GROUPS
      : filteredGroups[activeCategory];

  const groupReveal = useProgressiveList(activeGroupedList.length, {
    initial: GROUPS_FIRST_CHUNK,
    step: GROUPS_NEXT_CHUNK,
    resetKey: `${activeCategory}|${normalizedSearch}`,
    rootRef: scrollRootRef,
  });

  const memoryReveal = useProgressiveList(filteredMemoryStories.length, {
    initial: ROWS_FIRST_CHUNK,
    step: ROWS_NEXT_CHUNK,
    resetKey: `memory|${normalizedSearch}`,
    rootRef: scrollRootRef,
  });

  /** 只有真的存在多个分组时，「展开全部」才有意义。 */
  const showBulkToggle =
    installed === true &&
    (activeCategory === "favorites"
      ? favoriteGroupList.length + individualFavoriteGroups.length > 1
      : activeGroupedList.length > 1);

  /** 数据里根本没有这一类内容时的兜底：区分离线 / 在线给不同的下一步。 */
  const renderMissingDataState = (label: string) => (
    <EmptyState
      icon={Inbox}
      title={`本地数据里没有${label}`}
      description={
        online
          ? "多半是本机数据包版本偏旧，重新同步一次通常就能补齐。"
          : "当前设备离线，无法重新下载。可以导入一份离线 ZIP 数据包。"
      }
      actions={[
        online
          ? { label: "重新同步", onClick: openSync, icon: RefreshCw, variant: "default" }
          : { label: "导入 ZIP", onClick: openSync, icon: ArrowDownToLine, variant: "default" },
        { label: "重新加载", onClick: retryActive, icon: RotateCcw },
      ]}
    />
  );

  /** 搜索没命中：列表只匹配标题/编号，所以要把「去全文搜索」摆出来。 */
  const renderNoSearchMatchState = (label: string) => (
    <EmptyState
      icon={Search}
      title={`没有匹配“${trimmedSearch}”的${label}`}
      description="这里只匹配标题与编号。要按正文内容找，请用底部「搜索」。"
      actions={[
        { label: "清除搜索", onClick: clearSearch, icon: X, variant: "default" },
        { label: "去全文搜索", onClick: goToFullTextSearch, icon: Search },
      ]}
    />
  );

  /** 四类分组的渲染完全同构，只有文案和收藏语义不同。 */
  const renderGroupedCategory = (key: GroupedKey) => {
    // 等齐该分类声明的所有分块再画列表。活动分类的去重依赖支线数据：
    // 只等 activity 自己的话，activity 先落地（常见：首页预取已把它灌进
    // 缓存、支线还在途）会先画出一版混着全部支线分组的列表，支线落地后
    // 这些分组又整块消失——内容闪现即蒸发，期间还能把支线误收藏成
    // 「活动」类型。失败的分块不算 pending（error 非空时 isSectionPending
    // 返回 false），所以坏掉的分块不会把整个分类卡在骨架屏上。
    if (CATEGORY_SECTIONS[key].some((section) => isSectionPending(section))) {
      return <ListSkeleton />;
    }

    const meta = GROUPED_CATEGORY_META[key];
    const list = filteredGroups[key];

    if (list.length === 0) {
      if (hasSearch) return renderNoSearchMatchState(SECTION_LABELS[key]);
      // 加载失败时上面那张错误卡已经解释过了，别再叠一句「没有数据」。
      return error ? null : renderMissingDataState(SECTION_LABELS[key]);
    }

    const shown = groupReveal.done ? list : list.slice(0, groupReveal.visible);

    return (
      <>
        {shown.map(([name, stories], index) => {
          const fullStories = fullGroupMaps[key].get(name) ?? stories;
          const groupId = `${meta.idPrefix}:${fullStories[0]?.storyGroup || name}`;
          const open = isGroupOpen(groupId, index === 0);
          return (
            <Collapsible
              key={groupId}
              title={name}
              count={stories.length}
              open={open}
              onOpenChange={(next) => setGroupOpen(groupId, next)}
              actions={
                <GroupFavoriteButton
                  isFavorite={isGroupFavorite(groupId)}
                  onToggle={() =>
                    toggleFavoriteGroup({
                      id: groupId,
                      name,
                      type: meta.favoriteType,
                      stories: fullStories,
                    })
                  }
                  inactiveText={meta.favoriteInactive}
                  activeText={meta.favoriteActive}
                />
              }
            >
              {/* 折叠时连元素都不构造：活动分类有两百多个分组，光是把
                  几千个 <StoryItem> 元素建出来再扔掉，每次输入一个搜索
                  字符都要白烧一遍。 */}
              {open ? (
                <StoryRows
                  stories={stories}
                  listKey={`${groupId}|${normalizedSearch}`}
                  renderStoryItem={renderStoryItem}
                  rootRef={scrollRootRef}
                />
              ) : null}
            </Collapsible>
          );
        })}
        {!groupReveal.done && (
          <RevealMore
            sentinelRef={groupReveal.sentinelRef}
            remaining={groupReveal.remaining}
            unit="个分组"
            onRevealAll={groupReveal.revealAll}
          />
        )}
      </>
    );
  };

  return (
    <div className="h-full flex flex-col overflow-hidden">
      <main className="flex-1 overflow-hidden">
        <CustomScrollArea
          className="h-full"
          viewportClassName="reader-scroll"
          viewportRef={scrollRootRef}
          trackOffsetTop="calc(3.5rem + 10px)"
          trackOffsetBottom="calc(4.5rem + env(safe-area-inset-bottom, 0px))"
        >
          <div className="container py-6 pb-24 space-y-6 motion-safe:animate-in motion-safe:fade-in-0 motion-safe:duration-700">
            <div className="space-y-3">
              {/* 分类 pill：移动端横向滚动，触控目标 ≥44px。加载中也保持可见。 */}
              <div
                role="group"
                aria-label="剧情分类"
                className="-mx-1 flex gap-2 overflow-x-auto px-1 pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
              >
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
              {/* 顶部行：左侧摘要文本（离线时带状态徽标），右侧是全局开关 */}
              <div className="flex items-center justify-between gap-3">
                <span className="flex min-w-0 items-center gap-2">
                  <span
                    aria-live="polite"
                    className="truncate text-sm text-[hsl(var(--color-muted-foreground))]"
                  >
                    {activeSummary}
                  </span>
                  {!online && (
                    <span
                      title="设备当前离线，已同步的剧情仍可正常阅读"
                      className="inline-flex flex-shrink-0 items-center gap-1 rounded-full border border-[hsl(var(--color-border))] px-2 py-0.5 text-[11px] text-[hsl(var(--color-muted-foreground))]"
                    >
                      <WifiOff className="h-3 w-3" aria-hidden="true" />
                      离线
                    </span>
                  )}
                </span>
                <div className="flex flex-shrink-0 items-center gap-2">
                  {showBulkToggle && (
                    <BulkToggleButton expanded={bulkExpanded} onToggle={toggleBulkOpen} />
                  )}
                  <SummaryToggleButton
                    enabled={showSummaries}
                    onToggle={() => setShowSummaries(!showSummaries)}
                    label="简介"
                  />
                </div>
              </div>
              {/* 第二行：搜索框独占一行 */}
              <div>
                <CatalogSearchInput value={searchTerm} onCommit={setSearchTerm} />
                <p
                  id="story-list-search-hint"
                  className="mt-1.5 text-xs text-[hsl(var(--color-muted-foreground))]"
                >
                  只匹配标题与编号；要搜正文内容请用底部「搜索」。
                </p>
              </div>
            </div>

            {/* 「没装数据」下面那块引导已经把话说全了，这里不再重复报一次警。 */}
            {error && !(installed === false && error.kind === "not-installed") && (
              <LoadErrorCard
                error={error}
                online={online}
                busy={categoryBusy}
                onRetry={retryActive}
                onSync={openSync}
                onOpenSettings={goToSettings}
              />
            )}

            {/* 没有本地数据时，列表区整块换成「怎么把数据装上」的引导：
                这时候再铺一堆空分类的占位文案没有任何意义。 */}
            {installed === false ? (
              <EmptyState
                icon={ArrowDownToLine}
                title="本机还没有剧情数据"
                description={
                  online
                    ? "首次使用需要同步一次剧情数据；装好之后可以完全离线阅读。"
                    : "设备当前离线，无法从远端下载。可以先导入一份离线 ZIP 数据包，联网后再同步。"
                }
                actions={[
                  online
                    ? { label: "立即同步", onClick: openSync, icon: RefreshCw, variant: "default" }
                    : {
                        label: "导入 ZIP",
                        onClick: openSync,
                        icon: ArrowDownToLine,
                        variant: "default",
                      },
                  { label: "打开设置", onClick: goToSettings, icon: Settings2 },
                ]}
              />
            ) : (
            <div className="space-y-4">
              {activeCategory !== "memory" && activeCategory !== "favorites" && (
                <div
                  className="space-y-3"
                  role="group"
                  aria-label={`${CATEGORY_DESCRIPTIONS[activeCategory]}分组`}
                  onKeyDown={handleGroupListKeyDown}
                >
                  {renderGroupedCategory(activeCategory)}
                </div>
              )}

              {activeCategory === "memory" && (
                <div className="space-y-2">
                  {isSectionPending("memory") ? (
                    <ListSkeleton />
                  ) : filteredMemoryStories.length === 0 ? (
                    hasSearch ? (
                      renderNoSearchMatchState("干员密录")
                    ) : error ? null : (
                      renderMissingDataState("干员密录")
                    )
                  ) : (
                    <>
                      {(memoryReveal.done
                        ? filteredMemoryStories
                        : filteredMemoryStories.slice(0, memoryReveal.visible)
                      ).map((story) => renderStoryItem(story))}
                      {!memoryReveal.done && (
                        <RevealMore
                          sentinelRef={memoryReveal.sentinelRef}
                          remaining={memoryReveal.remaining}
                          unit="篇密录"
                          onRevealAll={memoryReveal.revealAll}
                        />
                      )}
                    </>
                  )}
                </div>
              )}

              {activeCategory === "favorites" &&
                (favoriteCount > 0 ? (
                  favoriteGroupList.length > 0 || individualFavoriteGroups.length > 0 ? (
                    <div
                      className="space-y-4"
                      role="group"
                      aria-label="收藏分组"
                      onKeyDown={handleGroupListKeyDown}
                    >
                      {favoriteGroupList.map(
                        ({ groupId, displayName, allStories, visibleStories, type }, index) => {
                          const key = `favorite-group:${groupId}`;
                          const open = isGroupOpen(key, index === 0);
                          return (
                            <Collapsible
                              key={key}
                              title={displayName}
                              count={visibleStories.length}
                              open={open}
                              onOpenChange={(next) => setGroupOpen(key, next)}
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
                              {open ? (
                                <StoryRows
                                  stories={visibleStories}
                                  keyPrefix="favorite-group"
                                  listKey={`${key}|${normalizedSearch}`}
                                  renderStoryItem={renderStoryItem}
                                  rootRef={scrollRootRef}
                                />
                              ) : null}
                            </Collapsible>
                          );
                        }
                      )}

                      {individualFavoriteGroups.map(
                        ({ groupKey, displayName, allStories, visibleStories }, index) => {
                          const key = `favorite-individual:${groupKey}`;
                          const open = isGroupOpen(
                            key,
                            favoriteGroupList.length === 0 && index === 0
                          );
                          return (
                            <Collapsible
                              key={key}
                              title={displayName}
                              count={visibleStories.length}
                              open={open}
                              onOpenChange={(next) => setGroupOpen(key, next)}
                              actions={
                                <GroupFavoriteButton
                                  isFavorite
                                  onToggle={() => {
                                    // 整组取消必须作用于全部成员：搜索过滤
                                    // 后的子集会漏掉没命中的收藏。
                                    allStories.forEach((story) => {
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
                              {open ? (
                                <StoryRows
                                  stories={visibleStories}
                                  keyPrefix="favorite-individual"
                                  listKey={`${key}|${normalizedSearch}`}
                                  renderStoryItem={renderStoryItem}
                                  rootRef={scrollRootRef}
                                />
                              ) : null}
                            </Collapsible>
                          );
                        }
                      )}
                    </div>
                  ) : hasSearch ? (
                    renderNoSearchMatchState("收藏")
                  ) : (
                    <EmptyState
                      icon={Star}
                      title="收藏记录读不出来了"
                      description="本机记录里还留着收藏计数，但内容已经对不上。重新收藏一次即可修复。"
                      actions={[
                        { label: "去看主线剧情", onClick: browseMainStories, icon: BookOpen },
                      ]}
                    />
                  )
                ) : (
                  <EmptyState
                    icon={Star}
                    title="还没有收藏任何剧情"
                    description="条目右侧的星标可以单独收藏一章；分组标题右侧的星标能把整个章节或活动一次收进来。收藏会一直留在本机。"
                    actions={[
                      {
                        label: "去看主线剧情",
                        onClick: browseMainStories,
                        icon: BookOpen,
                        variant: "default",
                      },
                    ]}
                  />
                ))}
            </div>
            )}
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

/**
 * 目录搜索框（输入法安全版）。与 CharactersPanel 的 FilterInput、
 * SearchPanel 的搜索框同一思路：
 *
 * 拼音/日文输入法在选词上屏前会一路触发 change（「z」「zh」「zhong」…），
 * 直接拿这些中间态去过滤，几千行的目录每敲一键就整体重算一遍，还会在
 * 用户没打完字时闪出「无匹配」。所以合成期间只更新本组件自己的草稿，
 * 等 compositionend 才把最终文本提交给父级；父级再用 useDeferredValue
 * 把过滤压到低优先级渲染。草稿留在这里也意味着合成中的每次按键只
 * 重渲染这个输入框，不会波及整棵列表树。
 */
function CatalogSearchInput({
  value,
  onCommit,
}: {
  /** 父级已提交的关键词。外部改动（空态里的「清除搜索」）要同步回草稿。 */
  value: string;
  onCommit: (value: string) => void;
}) {
  const [draft, setDraft] = useState(value);
  const composingRef = useRef(false);

  // 已提交值在外部被改掉时把草稿对齐（渲染期 setState 是 React 认可的
  // 派生 state 写法，本组件会立刻带新值重渲染）。合成中不动草稿，
  // 免得把用户正拼到一半的词冲掉。
  const lastValueRef = useRef(value);
  if (lastValueRef.current !== value) {
    lastValueRef.current = value;
    if (!composingRef.current && draft !== value) setDraft(value);
  }

  return (
    <Input
      type="search"
      value={draft}
      onChange={(event) => {
        const next = event.target.value;
        setDraft(next);
        if (!composingRef.current) onCommit(next);
      }}
      onCompositionStart={() => {
        composingRef.current = true;
      }}
      onCompositionEnd={(event) => {
        composingRef.current = false;
        // Safari/WKWebView 的 compositionend 排在 input 之前，部分安卓
        // 输入法又把 change 排在 compositionend 之后——不猜顺序，直接
        // 以事件里的最终文本为准提交一次。
        const next = event.currentTarget.value;
        setDraft(next);
        onCommit(next);
      }}
      placeholder="搜索剧情标题或编号"
      aria-label="搜索剧情标题或编号"
      aria-describedby="story-list-search-hint"
      autoComplete="off"
      autoCorrect="off"
      spellCheck={false}
      enterKeyHint="search"
      className="w-full sm:w-80 md:w-96"
    />
  );
}

/**
 * 一个分组内部的条目列表。分组通常只有十几条，超大分组（某些活动一口气
 * 几十上百条）才会分批放出来——阈值以内连哨兵都不会渲染。
 */
function StoryRows({
  stories,
  keyPrefix,
  listKey,
  renderStoryItem,
  rootRef,
}: {
  stories: StoryEntry[];
  keyPrefix?: string;
  /** 换搜索词 / 换分组时重新从第一批开始。 */
  listKey: string;
  renderStoryItem: (story: StoryEntry, keyPrefix?: string) => ReactNode;
  rootRef: RefObject<HTMLElement | null>;
}) {
  const reveal = useProgressiveList(stories.length, {
    initial: ROWS_FIRST_CHUNK,
    step: ROWS_NEXT_CHUNK,
    resetKey: listKey,
    rootRef,
  });

  const shown = reveal.done ? stories : stories.slice(0, reveal.visible);

  return (
    <>
      {shown.map((story) => renderStoryItem(story, keyPrefix))}
      {!reveal.done && (
        <RevealMore
          sentinelRef={reveal.sentinelRef}
          remaining={reveal.remaining}
          unit="篇"
          onRevealAll={reveal.revealAll}
        />
      )}
    </>
  );
}

/**
 * 分批加载的哨兵。它同时是三样东西：滚动到附近就自动放出下一批的
 * IntersectionObserver 目标、键盘用户可以直接按下的「全部展开」按钮、
 * 以及「下面还有多少」的明确提示——列表不会假装自己已经到底了。
 */
function RevealMore({
  sentinelRef,
  remaining,
  unit,
  onRevealAll,
}: {
  sentinelRef: RefObject<HTMLDivElement | null>;
  remaining: number;
  unit: string;
  onRevealAll: () => void;
}) {
  return (
    <div ref={sentinelRef}>
      <button
        type="button"
        onClick={(event) => {
          /* 展开后本按钮随即卸载。键盘用户（Enter/Space 触发的 click 其
             detail 为 0）的焦点会掉回 body、Tab 序列被打回文档开头，所以把
             焦点交给顶替这个位置的第一条新内容——它正好就在原视口位置，
             用户从原地继续。鼠标用户不动焦点，避免凭空亮出一圈 focus ring。 */
          const fromKeyboard = event.detail === 0;
          const wrapper = event.currentTarget.parentElement;
          const parent = wrapper?.parentElement ?? null;
          const index =
            parent && wrapper
              ? Array.prototype.indexOf.call(parent.children, wrapper)
              : -1;
          onRevealAll();
          if (!fromKeyboard || !parent || index < 0) return;
          // click 引发的 setState 在事件结束时同步 flush，rAF 时 DOM 已就绪。
          requestAnimationFrame(() => {
            const node = parent.children[index];
            if (!(node instanceof HTMLElement)) return;
            // 条目行自身可聚焦（tabindex）；分组则聚焦标题按钮。
            const target = node.matches("[tabindex], button")
              ? node
              : node.querySelector<HTMLElement>("[aria-expanded], [tabindex], button");
            target?.focus();
          });
        }}
        className="flex min-h-[44px] w-full items-center justify-center gap-2 rounded-2xl border border-dashed border-[hsl(var(--color-border))] px-3 text-xs text-[hsl(var(--color-muted-foreground))] transition-colors hover:border-[hsl(var(--color-primary)/0.5)] hover:text-[hsl(var(--color-foreground))] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-[hsl(var(--color-primary))]"
      >
        <ChevronsUpDown className="h-3.5 w-3.5" aria-hidden="true" />
        <span>
          还有 {remaining} {unit} · 继续滚动自动加载，或点此全部展开
        </span>
      </button>
    </div>
  );
}

function BulkToggleButton({
  expanded,
  onToggle,
}: {
  expanded: boolean;
  onToggle: () => void;
}) {
  const label = expanded ? "收起全部分组" : "展开全部分组";
  const Icon = expanded ? ChevronsDownUp : ChevronsUpDown;
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-pressed={expanded}
      aria-label={label}
      className="inline-flex min-h-[44px] flex-shrink-0 items-center gap-1.5 rounded-full border border-[hsl(var(--color-border))] px-3 py-1 text-xs text-[hsl(var(--color-muted-foreground))] transition-colors hover:bg-[hsl(var(--color-accent))] hover:text-[hsl(var(--color-foreground))]"
    >
      <Icon className="h-3.5 w-3.5" aria-hidden="true" />
      <span className="whitespace-nowrap">{expanded ? "收起全部" : "展开全部"}</span>
    </button>
  );
}

/** 每种失败都有自己的说法和下一步，不再统一显示「加载失败」。 */
function LoadErrorCard({
  error,
  online,
  busy,
  onRetry,
  onSync,
  onOpenSettings,
}: {
  error: LoadErrorState;
  online: boolean;
  busy: boolean;
  onRetry: () => void;
  onSync: () => void;
  onOpenSettings: () => void;
}) {
  const copy =
    error.kind === "timeout"
      ? {
          title: `读取${error.label}超时`,
          description:
            "后端还在扫描本地数据目录——刚同步完、正在重建索引时最容易碰上。等几秒再重试通常就好了。",
        }
      : error.kind === "not-installed"
      ? {
          title: "读不到本地剧情数据",
          description: online
            ? "数据目录不存在或已被清空，需要重新同步一次。"
            : "数据目录不存在或已被清空。设备当前离线，可以先导入离线 ZIP 数据包。",
        }
      : {
          title: `加载${error.label}失败`,
          description: "本地数据可能不完整。先重试一次，仍然失败就重新同步一遍数据。",
        };

  return (
    <div
      role="alert"
      className="space-y-3 rounded-2xl border border-[hsl(var(--color-destructive)/0.4)] bg-[hsl(var(--color-destructive)/0.06)] p-4"
    >
      <div className="flex items-start gap-3">
        <TriangleAlert
          className="mt-0.5 h-5 w-5 flex-shrink-0 text-[hsl(var(--color-destructive))]"
          aria-hidden="true"
        />
        <div className="min-w-0 space-y-1">
          <div className="text-sm font-medium text-[hsl(var(--color-destructive))]">
            {copy.title}
          </div>
          <p className="text-sm text-[hsl(var(--color-muted-foreground))]">{copy.description}</p>
          {error.detail && (
            <p className="break-all text-xs text-[hsl(var(--color-muted-foreground)/0.8)]">
              {error.detail}
            </p>
          )}
        </div>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button className="min-h-[44px]" onClick={onRetry} disabled={busy}>
          <RotateCcw className={`mr-2 h-4 w-4 ${busy ? "motion-safe:animate-spin" : ""}`} />
          {busy ? "重试中…" : "重试"}
        </Button>
        <Button variant="outline" className="min-h-[44px]" onClick={onSync}>
          {online ? (
            <RefreshCw className="mr-2 h-4 w-4" />
          ) : (
            <ArrowDownToLine className="mr-2 h-4 w-4" />
          )}
          {online ? "同步数据" : "导入 ZIP"}
        </Button>
        <Button variant="outline" className="min-h-[44px]" onClick={onOpenSettings}>
          <Settings2 className="mr-2 h-4 w-4" />
          打开设置
        </Button>
      </div>
    </div>
  );
}

function ListSkeleton({ rows = 4 }: { rows?: number }) {
  return (
    <div className="space-y-3">
      {Array.from({ length: rows }).map((_, index) => (
        <div
          key={index}
          aria-hidden="true"
          className="h-[88px] rounded-2xl border border-[hsl(var(--color-border))] bg-[hsl(var(--color-secondary)/0.4)] motion-safe:animate-pulse"
        />
      ))}
      {/* 骨架行逐个 aria-hidden；这句提示绝不能一起藏掉，否则给读屏用户
          准备的「加载中」恰好只有读屏听不到。role=status 让它出现即被播报。 */}
      <p role="status" className="sr-only">
        加载中
      </p>
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

interface StoryItemProps {
  story: StoryEntry;
  onSelectStory: (story: StoryEntry) => void;
  isFavorite: boolean;
  onToggleFavorite: (story: StoryEntry) => void;
  showSummary?: boolean;
  summary?: string | null;
  summaryLoading?: boolean;
  onRequestSummary?: (story: StoryEntry) => void;
  /** 阅读进度 0~1，来自共享的 `reading-progress` 快照。 */
  progress?: number;
}

/**
 * 列表行。`memo` 在这里是硬性要求，不是锦上添花：
 *
 * 一行要挂两个 `<StoryThumbnail>`（背景 + 缩略图），每个都带自己的
 * token 解析与图片候选链。父级会因为搜索输入、某一条简介回来、收藏变化
 * 而频繁重渲染，没有 `memo` 的话每次都要把整屏卡片连图片一起重画。
 * 所有 props 要么是原语，要么是稳定引用，浅比较就足够。
 */
const StoryItem = memo(function StoryItem({
  story,
  onSelectStory,
  isFavorite,
  onToggleFavorite,
  showSummary = false,
  summary,
  summaryLoading = false,
  onRequestSummary,
  progress,
}: StoryItemProps) {
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

  const progressPct = toReadPercent(progress);
  const finished = progressPct >= READ_FINISHED_PCT;

  return (
    <div
      role="button"
      tabIndex={0}
      aria-label={[
        story.storyCode,
        story.storyName,
        progressPct > 0 ? (finished ? "已读完" : `已读 ${progressPct}%`) : null,
      ]
        .filter(Boolean)
        .join(" · ")}
      onClick={() => onSelectStory(story)}
      onKeyDown={(event) => {
        // 只响应焦点在卡片自身时的按键：卡片里的收藏星标也是可聚焦按钮，
        // 它冒泡上来的 Enter/Space 若被这里 preventDefault 掐掉原生激活，
        // 就变成「按星标却打开了阅读器、收藏没切」，键盘用户无法收藏。
        if (event.target !== event.currentTarget) return;
        // Space 必须 preventDefault，否则会连带把滚动容器翻一页。
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onSelectStory(story);
        }
      }}
      /* `content-visibility` 让滚出视口的行跳过样式/布局/绘制，长列表里
         省下的主线程时间比什么都实在；`auto` 的固有尺寸会记住上一次的
         真实高度，所以滚动条不会来回跳。不支持的引擎直接忽略这两条。 */
      style={{ contentVisibility: "auto", containIntrinsicSize: "auto 88px" }}
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
              onToggleFavorite(story);
            }}
            aria-pressed={isFavorite}
            aria-label={`${isFavorite ? "取消收藏" : "收藏"} ${story.storyName}`}
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
          /* 进度已经写进卡片自身的 aria-label；这一行对读屏是第二、第三遍
             重复，而且 role=progressbar 嵌在 role=button 里会被当成按钮内部
             的独立控件播报。整行 aria-hidden，视觉不变。 */
          <div className="mt-1.5 flex items-center gap-2" aria-hidden="true">
            <div className="h-1 flex-1 rounded-full bg-[hsl(var(--color-secondary))]">
              <div
                className="h-full rounded-full bg-[hsl(var(--color-primary)/0.8)]"
                style={{ width: `${progressPct}%` }}
              />
            </div>
            <span className="flex-shrink-0 text-[10px] tabular-nums text-[hsl(var(--color-muted-foreground))]">
              {finished ? "已读完" : `${progressPct}%`}
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
});

interface EmptyStateAction {
  label: string;
  onClick: () => void;
  icon?: LucideIcon;
  variant?: "default" | "outline";
}

/**
 * 空状态一律要说清三件事：现在是什么情况、为什么会这样、下一步点哪儿。
 * 「暂无数据」这种话对用户没有任何帮助。
 */
function EmptyState({
  icon: Icon = Inbox,
  title,
  description,
  actions = [],
}: {
  icon?: LucideIcon;
  title: string;
  description?: string;
  actions?: EmptyStateAction[];
}) {
  return (
    <div className="space-y-4 rounded-2xl border border-dashed border-[hsl(var(--color-border))] p-5 motion-safe:animate-in motion-safe:fade-in-0 motion-safe:duration-300">
      <div className="flex items-start gap-3">
        <Icon
          className="mt-0.5 h-5 w-5 flex-shrink-0 text-[hsl(var(--color-muted-foreground))]"
          aria-hidden="true"
        />
        <div className="min-w-0 space-y-1">
          <div className="text-sm font-medium text-[hsl(var(--color-foreground))]">{title}</div>
          {description && (
            <p className="text-sm text-[hsl(var(--color-muted-foreground))]">{description}</p>
          )}
        </div>
      </div>
      {actions.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {actions.map((action) => {
            const ActionIcon = action.icon;
            return (
              <Button
                key={action.label}
                variant={action.variant ?? "outline"}
                className="min-h-[44px]"
                onClick={action.onClick}
              >
                {ActionIcon && <ActionIcon className="mr-2 h-4 w-4" />}
                {action.label}
              </Button>
            );
          })}
        </div>
      )}
    </div>
  );
}
