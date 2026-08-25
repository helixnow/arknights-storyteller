import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { StoryEntry } from "@/types/story";
import { Button } from "@/components/ui/button";
import { CustomScrollArea } from "@/components/ui/custom-scroll-area";
import { StoryThumbnail } from "@/components/StoryThumbnail";
import {
  READ_FINISHED_PCT,
  getReadingProgress,
  isNotInstalledError,
  storyCatalog,
  toReadPercent,
  useOnlineStatus,
  type ReadingProgressEntry,
  type ReadingProgressSnapshot,
} from "@/components/StoryList";
import { useFavorites } from "@/hooks/useFavorites";
import {
  ArrowDownToLine,
  BookOpen,
  Flame,
  RotateCcw,
  Settings2,
  Sparkles,
  TriangleAlert,
  WifiOff,
  type LucideIcon,
} from "lucide-react";
import {
  effectiveStreakDays,
  localDayKey,
  nextReadingStreak,
  normalizeStreakInfo,
  type ReadingStreakInfo,
} from "@/components/homeState";

type Tab = "home" | "stories" | "characters" | "search" | "settings";

interface HomePanelProps {
  onSelectStory: (story: StoryEntry) => void;
  onGoToTab: (tab: Tab) => void;
  /** 可选：直接跳到剧情页的「收藏」分类。不传时走 `app:open-favorites` 事件。 */
  onGoToFavorites?: () => void;
}

/** 首页用到的最近阅读记录，形状与剧情列表共享的进度快照一致。 */
type RecentItem = ReadingProgressEntry;

interface RecentStory {
  entry: StoryEntry;
  meta: RecentItem;
}

const STREAK_KEY = "arknights-reading-streak-v1";
/** 扫描最近进度的上限：够算「最近阅读 N 章」，又不会把整个 map 都解析成卡片。 */
const RECENT_SCAN_LIMIT = 60;
/** 首页最多渲染几张最近阅读卡片（含「继续阅读」大卡）。 */
const RECENT_RENDER_LIMIT = 5;
/** 刷新超过这个时长才提示「正在刷新」，命中缓存时不闪。 */
const REFRESH_HINT_DELAY_MS = 400;
/**
 * 次级目录（活动 / 支线 / 肉鸽 / 密录）读失败被吞成空结果（partial）后，
 * 自动重试的间隔与次数上限。这种失败多半是刚同步完、索引还在重建的短暂
 * 状态；只靠「下一次聚焦再试」的话，焦点一直停在首页的用户（手机端尤其
 * 常见）等不来任何聚焦/可见性事件，缺掉的「最近阅读」会挂整个会话。
 * 设上限是防持久性失败退化成每两秒打一轮 IPC 的死循环——超限后仍有聚焦 /
 * 可见性 / 数据同步刷新兜底；完整加载成功或强制刷新时额度重新给满。
 */
const PARTIAL_RETRY_DELAY_MS = 2500;
const PARTIAL_RETRY_MAX = 2;

type StreakInfo = ReadingStreakInfo;

function todayKey() {
  return localDayKey(new Date());
}

function readStreak(): StreakInfo {
  try {
    const raw = window.localStorage.getItem(STREAK_KEY);
    if (raw) {
      return normalizeStreakInfo(JSON.parse(raw));
    }
  } catch {}
  return { currentStreak: 0, lastReadOn: "", totalDays: 0 };
}

function sameStreak(a: StreakInfo, b: StreakInfo): boolean {
  return (
    a.currentStreak === b.currentStreak &&
    a.lastReadOn === b.lastReadOn &&
    a.totalDays === b.totalDays
  );
}

/**
 * 首页每次获得焦点都会重跑一遍 `loadHome`，绝大多数时候结果和上一次一模
 * 一样。这里逐条比一遍，内容没变就沿用旧数组——否则每次切窗口都会把所有
 * 卡片连同封面重新渲染一次。
 */
function sameRecentStories(a: RecentStory[], b: RecentStory[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    // entry 按引用比较而不是 storyId：storyCatalog 缓存命中时返回同一批对象，
    // 常规刷新照样零重渲染；而数据重新同步后会解析出新对象（书名/编号/txt
    // 路径都可能变了），只比 id 会让首页一直拿旧目录的条目去渲染和打开。
    if (a[i].entry !== b[i].entry) return false;
    if (a[i].meta.percentage !== b[i].meta.percentage) return false;
    if (a[i].meta.updatedAt !== b[i].meta.updatedAt) return false;
  }
  return true;
}

export function HomePanel({ onSelectStory, onGoToTab, onGoToFavorites }: HomePanelProps) {
  // 与剧情页「收藏」分类同口径：单章收藏 + 收藏分组展开后的去重总数。
  const { favoriteCount } = useFavorites();
  const [recentStories, setRecentStories] = useState<RecentStory[]>([]);
  const [highlight, setHighlight] = useState<StoryEntry | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  // null = 还没问过后端。先渲染骨架，避免闪一下「已安装」再跳回未同步。
  const [installed, setInstalled] = useState<boolean | null>(null);
  /**
   * 内容区（继续阅读 / 统计条 / 最近阅读 / 今日推荐）是否来自一次成功加载。
   * 不能只看 installed：失败路径会把 isInstalled 的答案落进 installed 供
   * 错误卡选文案，若内容区也拿它当门槛，冷启动目录读失败时 recentStories
   * 还是空的，错误卡下面会凭空亮出「打开任意一章剧情」的空状态和
   * 「最近阅读 0 章」——对有阅读记录、只是这轮没读出来的用户就是在撒谎。
   * 之前成功加载过的内容则继续保留，瞬时失败只叠加错误卡、不闪没页面。
   */
  const [contentReady, setContentReady] = useState(false);
  /** 读目录本身失败了（IPC 异常 / 数据损坏），和「没装数据」是两码事。 */
  const [loadFailed, setLoadFailed] = useState(false);
  const [streak, setStreak] = useState<StreakInfo>(() => readStreak());
  /** 当前本地日期。跨零点由定时器/聚焦刷新推进，连签展示随之重算。 */
  const [today, setToday] = useState<string>(() => todayKey());
  const online = useOnlineStatus();
  // 聚焦、返回列表、数据同步都会触发刷新，可能叠在一起。用递增序号
  // 保证只有最后一次的结果能写进 state。
  const loadSeqRef = useRef(0);
  /** 上一次成功渲染所依据的进度快照，用来判断这次刷新有没有必要。 */
  const loadedFromRef = useRef<ReadingProgressSnapshot | null>(null);
  /** 上一次成功加载对应的日期。「今日推荐」按天挑选，跨天后哪怕进度快照
   *  没变也不能跳过刷新，否则挂机过夜的用户会一直看到昨天的「每日随机一章」。 */
  const loadedDayRef = useRef<string | null>(null);
  /** partial（次级目录读失败）后已自动重试的次数；完整加载或强制刷新归零。 */
  const partialRetryCountRef = useRef(0);
  /** partial 自动重试的定时器。新一轮加载启动或组件卸载时作废。 */
  const partialRetryTimerRef = useRef(0);

  const loadHome = useCallback(async (options?: { force?: boolean }) => {
    // 首页的内容由三样东西决定：剧情目录、阅读进度快照、当天日期（今日
    // 推荐）。目录换了会走 `app:data-updated`（force），所以快照和日期都
    // 没变时这次刷新一定得不到新结果——直接跳过，桌面端反复切窗口就不会
    // 一路打 IPC 出去。
    const snapshot = getReadingProgress();
    if (
      !options?.force &&
      loadedFromRef.current === snapshot &&
      loadedDayRef.current === todayKey()
    )
      return;

    const seq = (loadSeqRef.current += 1);
    const stale = () => seq !== loadSeqRef.current;
    // 这一轮会得出自己的结论，上一轮 partial 挂着的自动重试作废；强制刷新
    // （数据同步 / 错误卡重试）意味着换了代际，自动重试的额度也重新给满。
    window.clearTimeout(partialRetryTimerRef.current);
    if (options?.force) partialRetryCountRef.current = 0;
    const hintTimer = window.setTimeout(() => {
      if (!stale()) setRefreshing(true);
    }, REFRESH_HINT_DELAY_MS);

    // isInstalled 的结果先记在局部变量而不是立刻写 state：成功路径要等
    // 内容全齐后一批亮相（见下），catch 里也要靠它把错误文案选对。
    let installedNow: boolean | null = null;
    try {
      try {
        installedNow = await storyCatalog.isInstalled();
      } catch (probeErr) {
        // isInstalled 抛错 ≠ 数据没装：IPC 抖动、后端忙都会走到这里。
        // 与剧情列表同一策略：不急着报错，乐观地继续往下读目录——读得
        // 出来就是装了（成功路径会把 installed 翻成 true），真读不出来
        // 会落进外层 catch 再分诊。否则同一次抖动会变成：剧情页照常列出
        // 目录、首页却挂着「读不出来」的错误卡，两个页面自相矛盾。
        console.warn("[Home] isInstalled 失败，改为直接读目录判定:", probeErr);
        installedNow = null;
      }
      if (stale()) return;
      if (installedNow === false) {
        setInstalled(false);
        setContentReady(false);
        setLoadFailed(false);
        setRecentStories((prev) => (prev.length === 0 ? prev : []));
        setHighlight(null);
        loadedFromRef.current = snapshot;
        loadedDayRef.current = todayKey();
        return;
      }

      // 1) 主线：既是「今日推荐」的池子，也能覆盖大部分最近阅读记录。
      const main = await storyCatalog.grouped("main");
      if (stale()) return;
      const allMain: StoryEntry[] = main.flatMap(([, stories]) => stories);

      // 按天确定性地挑一章，同一天进来看到的推荐是同一条。
      const t = todayKey();
      let hash = 0;
      for (let i = 0; i < t.length; i += 1) hash = (hash * 31 + t.charCodeAt(i)) >>> 0;
      const pick = allMain[hash % Math.max(allMain.length, 1)] ?? null;

      // 2) 最近阅读：progress 的 key 就是 storyTxt，反查成 StoryEntry。
      // 快照和剧情列表的进度徽标同源，两边不可能显示成不一样的百分比。
      const entries = snapshot.recent.slice(0, RECENT_SCAN_LIMIT);
      const byPath = new Map<string, StoryEntry>();
      allMain.forEach((story) => byPath.set(story.storyTxt, story));

      // 主线没覆盖到的才去问活动 / 支线 / 肉鸽 / 密录。新装或只读主线的
      // 用户因此能省掉四次 IPC；命中共享缓存时这里同样是零开销。
      // 某一类读失败（多半是刚同步完、索引还在重建）就先用空结果顶上，
      // 页面照常渲染；但要记下「这轮不完整」，见下面写 loadedFromRef 处。
      let partial = false;
      const orEmpty = <T,>(promise: Promise<T[]>): Promise<T[]> =>
        promise.catch(() => {
          partial = true;
          return [];
        });
      if (entries.some((entry) => !byPath.has(entry.storyPath))) {
        const [acts, sides, rogues, mems] = await Promise.all([
          orEmpty(storyCatalog.grouped("activity")),
          orEmpty(storyCatalog.grouped("sidestory")),
          orEmpty(storyCatalog.grouped("roguelike")),
          orEmpty(storyCatalog.memory()),
        ]);
        if (stale()) return;
        [acts, sides, rogues].forEach((grouped) =>
          grouped.forEach(([, stories]) =>
            stories.forEach((story) => byPath.set(story.storyTxt, story))
          )
        );
        mems.forEach((story) => byPath.set(story.storyTxt, story));
      }

      // 到这里已无 await，下面这批 setState 会合并成一次渲染、一次亮相。
      // 以前 isInstalled 一返回就把 installed 翻成 true：骨架屏提前退场，
      // 冷启动（目录 IPC 要几十到几百毫秒才回来）会先闪出「打开任意一章
      // 剧情」的空占位卡和「最近阅读 0 章」，目录到了才换成真实内容。
      setInstalled(true);
      setContentReady(true);
      setLoadFailed(false);
      // highlight 直接 set：缓存命中时 pick 与上一次是同一个对象，React
      // 自动 bail out；数据重新同步后是新对象，才应该重渲染。以前按 storyId
      // 相同就保留旧对象，同步后推荐卡会一直显示旧目录里的书名，点开走的
      // 也是旧路径。
      setHighlight(pick);
      setRecentStories((prev) => {
        // 次级目录这轮读失败（partial）时，byPath 缺的路径先拿上一轮已经
        // 解析出的 StoryEntry 顶住，进度数字仍用最新快照——否则只读活动 /
        // 支线的用户会在索引重建的几秒里看到「最近阅读」整段消失、大卡退
        // 化成「打开任意一章剧情」的空状态（loadFailed 那段注释说过：对有
        // 阅读记录的用户这就是在撒谎，partial 路径同理）。完整加载时不走
        // 回退：目录里真不存在的条目（换包被移除）就该消失。
        const prevByPath = partial
          ? new Map(prev.map((item) => [item.meta.storyPath, item]))
          : null;
        // 保留完整命中列表：渲染只取前几张，但「最近阅读 N 章」要用真实数量。
        const matched = entries
          .map((item) => {
            const entry =
              byPath.get(item.storyPath) ?? prevByPath?.get(item.storyPath)?.entry;
            return entry ? { entry, meta: item } : null;
          })
          .filter((x): x is RecentStory => x !== null);
        return sameRecentStories(prev, matched) ? prev : matched;
      });
      // 有次级目录读失败时结果不完整，不能记成「已按此快照加载」——否则
      // 进度快照没变的话，后续聚焦刷新全被顶部跳过逻辑拦下，瞬时失败里
      // 缺掉的「最近阅读」卡片要等到用户再读点什么才会回来。留空让下一次
      // 聚焦/可见性刷新重试（失败的请求不会进共享缓存，重试是真重试）。
      loadedFromRef.current = partial ? null : snapshot;
      // 用挑推荐时的 `t` 而不是现在的 todayKey()：加载恰好跨过零点时两者
      // 会不同，记 `t` 能让下一次刷新发现日期变了、重挑今天的推荐。
      loadedDayRef.current = t;
      if (!partial) {
        partialRetryCountRef.current = 0;
      } else if (partialRetryCountRef.current < PARTIAL_RETRY_MAX) {
        // 焦点一直停在首页时不会再有聚焦/可见性事件，缺掉的「最近阅读」
        // 只能靠这里自动补试。走 app:home-refresh 事件而不是直接递归调
        // loadHome：组件已卸载时事件自然无人接收，不会往卸载后的组件上灌
        // setState。失败的请求不进共享缓存，这次重试是真重试。
        partialRetryCountRef.current += 1;
        partialRetryTimerRef.current = window.setTimeout(
          notifyHomeRefresh,
          PARTIAL_RETRY_DELAY_MS
        );
      }
    } catch (err) {
      if (stale()) return;
      console.warn("[Home] load failed", err);
      const errorMsg = err instanceof Error ? err.message : String(err ?? "");
      // isInstalled 没给出答案、目录读取又以「目录不存在」这类错误收场：
      // 结论与剧情列表对同一状况的结论一致——就是没装数据，走「还没有
      // 同步」的引导而不是错误卡。只在探测失败时才这么归因；isInstalled
      // 明确说装了的话，「读不出来」就是读不出来，按失败报，别把用户支
      // 去做一次没必要的同步。
      if (installedNow === null && isNotInstalledError(errorMsg)) {
        setInstalled(false);
        setContentReady(false);
        setLoadFailed(false);
        setRecentStories((prev) => (prev.length === 0 ? prev : []));
        setHighlight(null);
        // 不记「已按此快照加载」：这是从失败推出的结论，留给下一次聚焦 /
        // 可见性刷新复核（失败的请求不进共享缓存，重试是真重试）。
        loadedFromRef.current = null;
        return;
      }
      // 读取失败 ≠ 没装数据。把两者混为一谈会让用户去做一次根本没必要的
      // 同步，所以这里只标记失败，由界面给出「重试 / 去设置」。isInstalled
      // 已经有答案的话要落下去：错误卡的文案靠它区分「数据在但这次没读
      // 出来」和「目录可能损坏」。
      if (installedNow !== null) setInstalled(installedNow);
      setLoadFailed(true);
      // 这一轮没产出结果，得把「已按此快照加载」的标记作废。不然强制刷新
      // （如同步后重建索引时）恰好失败、而进度快照又没变时，后续聚焦刷新
      // 全被顶部的跳过逻辑拦下，本该转瞬即逝的错误卡会一直挂着。
      loadedFromRef.current = null;
    } finally {
      window.clearTimeout(hintTimer);
      if (!stale()) setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void loadHome();
  }, [loadHome]);

  useEffect(() => {
    // 首页需要在这些时机重新读一遍：从阅读器返回（app:home-refresh）、
    // 剧情数据刚同步完（app:data-updated）、窗口重新获得焦点。
    const refresh = (force: boolean) => {
      void loadHome({ force });
      // 同上：连续阅读天数没变时保持同一个对象，避免整页跟着重渲染。
      setStreak((prev) => {
        const next = readStreak();
        return sameStreak(prev, next) ? prev : next;
      });
      // 同一天内是 no-op（同字符串 setState 直接 bail out）；跨天后推动
      // 连签展示用新日期重算。
      setToday(todayKey());
    };
    // 数据同步换了整个目录，进度快照没变也必须重来一遍。
    const onDataUpdated = () => refresh(true);
    const onRefresh = () => refresh(false);
    // Android WebView 从后台回前台常常只发 visibilitychange 不发 focus，得靠它兜住跨天刷新。
    const onVisibility = () => {
      if (document.visibilityState === "visible") refresh(false);
    };

    // 窗口一直保持焦点、也从不切后台的场景（桌面端挂机过夜）不会触发
    // 上面任何一个事件：零点之后「今日推荐」还是昨天那条、连签也停在
    // 昨天的口径。补一个对准下一个本地零点的定时器，跨天即刷新并顺延。
    let dayTimer = 0;
    const scheduleDayRollover = () => {
      const now = new Date();
      const nextMidnight = new Date(
        now.getFullYear(),
        now.getMonth(),
        now.getDate() + 1,
        0,
        0,
        1
      );
      dayTimer = window.setTimeout(() => {
        refresh(false);
        scheduleDayRollover();
      }, Math.max(nextMidnight.getTime() - now.getTime(), 1000));
    };
    scheduleDayRollover();

    window.addEventListener("focus", onRefresh);
    window.addEventListener("app:home-refresh", onRefresh);
    window.addEventListener("app:data-updated", onDataUpdated);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.clearTimeout(dayTimer);
      // partial 自动重试的定时器也在这里作废：卸载后即使有在途加载晚一步
      // 又排了一个，事件派发出去也没有监听者，不会造成任何可见影响。
      window.clearTimeout(partialRetryTimerRef.current);
      window.removeEventListener("focus", onRefresh);
      window.removeEventListener("app:home-refresh", onRefresh);
      window.removeEventListener("app:data-updated", onDataUpdated);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [loadHome]);

  // 「继续阅读」优先挑最近一条还没读完的：刚读完一章就回首页时，
  // 再把这章推回来没有意义。全都读完了才退回最近一条。
  const continueItem = useMemo(
    () =>
      recentStories.find(({ meta }) => toReadPercent(meta.percentage) < READ_FINISHED_PCT) ??
      recentStories[0] ??
      null,
    [recentStories]
  );

  /** 「最近阅读」列表要排掉已经占了大卡的那条，避免同一章出现两次。 */
  const otherRecentStories = useMemo(
    () =>
      recentStories
        .filter((item) => item !== continueItem)
        .slice(0, RECENT_RENDER_LIMIT - 1),
    [continueItem, recentStories]
  );

  const showSkeleton = installed === null && !loadFailed;
  /** 内容板块的统一门槛：数据已装 && 手上的内容确实来自成功加载。 */
  const contentVisible = installed === true && contentReady;
  const goToSettings = useCallback(() => onGoToTab("settings"), [onGoToTab]);
  const retryLoad = useCallback(() => {
    // 不预先清 loadFailed：冷启动就失败的场景里 contentReady 还是 false，
    // 错误卡是页面上唯一的内容——先清标记会让它立刻卸载，重试期间整页
    // 只剩标题一片空白，失败后又闪回来。成功 / 未安装路径自会把标记翻掉，
    // 重试期间卡片上的按钮转为「重试中…」并禁用（见下）。
    void loadHome({ force: true });
  }, [loadHome]);

  const handleGoToFavorites = useCallback(() => {
    if (onGoToFavorites) {
      onGoToFavorites();
      return;
    }
    window.dispatchEvent(new Event("app:open-favorites"));
    onGoToTab("stories");
  }, [onGoToFavorites, onGoToTab]);

  return (
    <div className="h-full flex flex-col overflow-hidden">
      <header className="flex-shrink-0 pl-[max(1.25rem,env(safe-area-inset-left,0px))] pr-[max(1.25rem,env(safe-area-inset-right,0px))] pt-6 pb-2 motion-safe:animate-in motion-safe:fade-in-0">
        <div className="text-[11px] uppercase tracking-[0.18em] text-[hsl(var(--color-muted-foreground))]">
          Welcome, Doctor
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-2">
          <h1 className="text-2xl font-semibold">欢迎回来，博士</h1>
          {!online && (
            <span
              title="设备当前离线，已同步的剧情仍可正常阅读"
              className="inline-flex items-center gap-1 rounded-full border border-[hsl(var(--color-border))] px-2 py-0.5 text-[11px] text-[hsl(var(--color-muted-foreground))]"
            >
              <WifiOff className="h-3 w-3" aria-hidden="true" />
              离线
            </span>
          )}
        </div>
      </header>

      <main className="flex-1 overflow-hidden">
        <CustomScrollArea
          className="h-full"
          viewportClassName="reader-scroll"
          trackOffsetBottom="calc(5rem + env(safe-area-inset-bottom, 0px))"
        >
          <div className="pl-[max(1.25rem,env(safe-area-inset-left,0px))] pr-[max(1.25rem,env(safe-area-inset-right,0px))] pb-[calc(8rem+var(--bottom-nav-inset))] space-y-6">
            {showSkeleton && <HomeSkeleton />}

            {/* 读取失败：明确说是「读不出来」而不是「没同步」，并且第一动作
                是重试——绝大多数是刚同步完索引还没建好的短暂状态。 */}
            {loadFailed && (
              <HomeNotice
                tone="error"
                icon={TriangleAlert}
                title="读不出本机的剧情目录"
                description={
                  installed === true
                    ? "本地数据在，但这次没读出来。刚同步完、正在重建索引时最常见，重试一次通常就好。"
                    : "可能是数据目录被移动或损坏了。先重试，仍然失败就去设置里重新同步或导入 ZIP。"
                }
                actions={[
                  {
                    label: refreshing ? "重试中…" : "重试",
                    onClick: retryLoad,
                    icon: RotateCcw,
                    variant: "default",
                    disabled: refreshing,
                  },
                  { label: "打开设置", onClick: goToSettings, icon: Settings2 },
                ]}
              />
            )}

            {installed === false && !loadFailed && (
              <HomeNotice
                icon={ArrowDownToLine}
                title="还没有同步剧情数据"
                description={
                  online
                    ? "去设置里同步一次（完整数据包通常几百 MB，建议连 Wi-Fi），之后首页会记住你读到哪里，也可以完全离线阅读。"
                    : "设备当前离线，无法从远端下载。可以在设置里导入一份离线 ZIP 数据包。"
                }
                actions={[
                  {
                    label: online ? "去设置同步" : "去设置导入 ZIP",
                    onClick: goToSettings,
                    icon: online ? Settings2 : ArrowDownToLine,
                    variant: "default",
                  },
                ]}
              />
            )}

            {contentVisible && continueItem ? (
              <ContinueReadingCard
                entry={continueItem.entry}
                percentage={continueItem.meta.percentage}
                onOpen={() => onSelectStory(continueItem.entry)}
              />
            ) : contentVisible ? (
              <EmptyContinueCard onBrowse={() => onGoToTab("stories")} />
            ) : null}

            {contentVisible && (
              <StreakStrip
                streakDays={effectiveStreakDays(streak, today)}
                favoritesCount={favoriteCount}
                recentCount={recentStories.length}
                onGoToRecent={() => onGoToTab("stories")}
                onGoToFavorites={handleGoToFavorites}
              />
            )}

            {contentVisible && otherRecentStories.length > 0 && (
              <section className="space-y-3">
                <SectionTitle icon={BookOpen} title="最近阅读" />
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  {otherRecentStories.map(({ entry, meta }) => (
                    <RecentCard
                      key={entry.storyId}
                      entry={entry}
                      percentage={meta.percentage}
                      onOpen={() => onSelectStory(entry)}
                    />
                  ))}
                </div>
              </section>
            )}

            {contentVisible && highlight && (
              <section className="space-y-3">
                <SectionTitle icon={Sparkles} title="今日推荐" />
                <RecentCard
                  entry={highlight}
                  percentage={0}
                  onOpen={() => onSelectStory(highlight)}
                  tag="每日随机一章"
                />
              </section>
            )}

            {!showSkeleton && refreshing && (
              <div
                role="status"
                className="text-center text-sm text-[hsl(var(--color-muted-foreground))]"
              >
                正在刷新…
              </div>
            )}
          </div>
        </CustomScrollArea>
      </main>
    </div>
  );
}

function HomeSkeleton() {
  return (
    <div className="space-y-4">
      <div
        aria-hidden="true"
        className="story-card story-card--hero h-44 w-full motion-safe:animate-pulse bg-[hsl(var(--color-secondary)/0.5)]"
      />
      <div aria-hidden="true" className="grid grid-cols-3 gap-2">
        {[0, 1, 2].map((i) => (
          <div
            key={i}
            className="h-[86px] rounded-2xl border border-[hsl(var(--color-border))] bg-[hsl(var(--color-secondary)/0.4)] motion-safe:animate-pulse"
          />
        ))}
      </div>
      <div aria-hidden="true" className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {[0, 1].map((i) => (
          <div
            key={i}
            className="h-[88px] rounded-2xl border border-[hsl(var(--color-border))] bg-[hsl(var(--color-secondary)/0.4)] motion-safe:animate-pulse"
          />
        ))}
      </div>
      {/* 装饰性骨架分块 aria-hidden；这句提示不能一起藏掉，否则给读屏用户
          准备的「首页加载中」恰好只有读屏听不到。role=status 出现即被播报。 */}
      <p role="status" className="sr-only">
        首页加载中
      </p>
    </div>
  );
}

interface HomeNoticeAction {
  label: string;
  onClick: () => void;
  icon?: LucideIcon;
  variant?: "default" | "outline";
  /** 动作正在执行（如重试请求在途）时禁用，防止连点打出一串重复请求。 */
  disabled?: boolean;
}

/**
 * 首页的状态卡。和剧情列表一样的原则：说清现状、说清原因、给出下一步，
 * 而不是丢一句「数据未同步」让用户自己猜该点哪里。
 */
function HomeNotice({
  icon: Icon,
  title,
  description,
  actions,
  tone = "muted",
}: {
  icon: LucideIcon;
  title: string;
  description: string;
  actions: HomeNoticeAction[];
  tone?: "muted" | "error";
}) {
  const isError = tone === "error";
  return (
    <div
      role={isError ? "alert" : undefined}
      className={`space-y-4 rounded-2xl border p-5 ${
        isError
          ? "border-[hsl(var(--color-destructive)/0.4)] bg-[hsl(var(--color-destructive)/0.06)]"
          : "border-dashed border-[hsl(var(--color-border))]"
      }`}
    >
      <div className="flex items-start gap-3">
        <Icon
          className={`mt-0.5 h-5 w-5 flex-shrink-0 ${
            isError
              ? "text-[hsl(var(--color-destructive))]"
              : "text-[hsl(var(--color-muted-foreground))]"
          }`}
          aria-hidden="true"
        />
        <div className="min-w-0 space-y-1">
          <div
            className={`text-sm font-medium ${
              isError
                ? "text-[hsl(var(--color-destructive))]"
                : "text-[hsl(var(--color-foreground))]"
            }`}
          >
            {title}
          </div>
          <p className="text-sm text-[hsl(var(--color-muted-foreground))]">{description}</p>
        </div>
      </div>
      <div className="flex flex-wrap gap-2">
        {actions.map((action, index) => {
          const ActionIcon = action.icon;
          return (
            <Button
              // 不用 label 当 key：重试按钮的文案会在「重试 / 重试中…」之间
              // 切换，key 跟着变会让按钮整个重挂载。动作列表按位置稳定。
              key={index}
              variant={action.variant ?? "outline"}
              className="min-h-[44px]"
              onClick={action.onClick}
              disabled={action.disabled}
            >
              {ActionIcon && <ActionIcon className="mr-2 h-4 w-4" />}
              {action.label}
            </Button>
          );
        })}
      </div>
    </div>
  );
}

function SectionTitle({ icon: Icon, title }: { icon: typeof BookOpen; title: string }) {
  return (
    <div className="flex items-center gap-2 px-1 text-sm font-semibold text-[hsl(var(--color-foreground))]">
      <Icon className="h-4 w-4 text-[hsl(var(--color-primary))]" />
      <span>{title}</span>
    </div>
  );
}

function ContinueReadingCard({
  entry,
  percentage,
  onOpen,
}: {
  entry: StoryEntry;
  percentage: number;
  onOpen: () => void;
}) {
  // 与列表徽标同一个换算，两处不会出现 0% 和 1% 的差异。
  const pct = toReadPercent(percentage);
  return (
    <button
      onClick={onOpen}
      className="story-card story-card--hero group relative block w-full overflow-hidden text-left transition-transform active:scale-[0.995]"
      aria-label={`继续阅读 ${entry.storyName}，已读 ${pct}%`}
    >
      <div className="story-card-cover aspect-[16/9]">
        <StoryThumbnail story={entry} alt={entry.storyName} lazy={false} tint="soft" />
        <div className="absolute bottom-4 left-5 right-5 z-10 space-y-1.5">
          <div className="text-[10px] uppercase tracking-[0.22em] text-[hsl(var(--color-primary))]">
            Continue Reading
          </div>
          <div className="text-lg font-semibold text-[hsl(var(--color-foreground))]">
            {entry.storyName}
          </div>
          {entry.storyCode && (
            <span className="story-card-code">{entry.storyCode}</span>
          )}
        </div>
      </div>
      <div className="story-card-body flex items-center justify-between gap-3">
        <div className="flex-1">
          <div className="text-xs text-[hsl(var(--color-muted-foreground))]">
            已读 {pct}%
          </div>
          <div className="mt-1 h-1 rounded-full bg-[hsl(var(--color-secondary))]">
            <div
              className="h-full rounded-full bg-[hsl(var(--color-primary))]"
              style={{ width: `${pct}%` }}
            />
          </div>
        </div>
        <div className="rounded-full bg-[hsl(var(--color-primary)/0.12)] px-3 py-1.5 text-xs font-semibold text-[hsl(var(--color-primary))]">
          继续 ›
        </div>
      </div>
    </button>
  );
}

function EmptyContinueCard({ onBrowse }: { onBrowse: () => void }) {
  return (
    <div className="story-card p-5">
      <div className="text-sm text-[hsl(var(--color-muted-foreground))]">
        欢迎回到罗德岛。打开任意一章剧情，这里会记住你读到哪里。
      </div>
      <div className="mt-3">
        <Button className="min-h-[44px]" onClick={onBrowse}>
          浏览剧情
        </Button>
      </div>
    </div>
  );
}

function StreakStrip({
  streakDays,
  favoritesCount,
  recentCount,
  onGoToRecent,
  onGoToFavorites,
}: {
  /** 已经按 lastReadOn 校验过的有效连续天数（断签即为 0）。 */
  streakDays: number;
  favoritesCount: number;
  recentCount: number;
  onGoToRecent: () => void;
  onGoToFavorites: () => void;
}) {
  const items: Array<{
    icon: typeof BookOpen;
    label: string;
    value: string;
    onClick?: () => void;
    hint?: string;
  }> = [
    { icon: Flame, label: "连续阅读", value: `${streakDays} 天` },
    {
      icon: BookOpen,
      label: "最近阅读",
      value: `${recentCount} 章`,
      onClick: onGoToRecent,
      hint: "查看剧情列表",
    },
    {
      icon: Sparkles,
      label: "收藏剧情",
      value: `${favoritesCount}`,
      onClick: onGoToFavorites,
      hint: "查看收藏",
    },
  ];
  return (
    <div className="grid grid-cols-3 gap-2">
      {items.map(({ icon: Icon, label, value, onClick, hint }) => {
        const content = (
          <>
            <Icon className="h-4 w-4 text-[hsl(var(--color-primary))]" />
            <div className="text-[11px] text-[hsl(var(--color-muted-foreground))]">{label}</div>
            <div className="text-sm font-semibold tabular-nums">{value}</div>
          </>
        );
        const shared =
          "flex min-h-[76px] flex-col items-center justify-center gap-1 rounded-2xl border border-[hsl(var(--color-border))] bg-[hsl(var(--color-card))] px-3 py-3 text-center";

        if (!onClick) {
          return (
            <div key={label} className={shared}>
              {content}
            </div>
          );
        }

        return (
          <button
            key={label}
            type="button"
            onClick={onClick}
            aria-label={`${label} ${value}，${hint ?? ""}`}
            className={`${shared} transition-colors active:scale-[0.98] [@media(hover:hover)_and_(pointer:fine)]:hover:border-[hsl(var(--color-primary)/0.5)] [@media(hover:hover)_and_(pointer:fine)]:hover:bg-[hsl(var(--color-accent))]`}
          >
            {content}
          </button>
        );
      })}
    </div>
  );
}

function RecentCard({
  entry,
  percentage,
  onOpen,
  tag,
}: {
  entry: StoryEntry;
  percentage: number;
  onOpen: () => void;
  tag?: string;
}) {
  const pct = toReadPercent(percentage);
  const progressText =
    pct >= READ_FINISHED_PCT ? "已读完" : pct > 0 ? `已读 ${pct}%` : "未开始";
  return (
    <button
      onClick={onOpen}
      aria-label={`${entry.storyName}，${tag ?? progressText}`}
      className="story-card flex w-full items-stretch gap-3 p-3 text-left transition-transform active:scale-[0.99]"
    >
      <div className="relative h-16 w-24 flex-shrink-0 overflow-hidden rounded-lg">
        <StoryThumbnail story={entry} alt={entry.storyName} />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline justify-between gap-2">
          <div className="truncate text-sm font-semibold">{entry.storyName}</div>
          {entry.storyCode && (
            <span className="text-[10px] text-[hsl(var(--color-muted-foreground))]">
              {entry.storyCode}
            </span>
          )}
        </div>
        <div className="mt-0.5 text-[11px] text-[hsl(var(--color-muted-foreground))] truncate">
          {tag ?? progressText}
        </div>
        {pct > 0 && (
          <div className="mt-1.5 h-1 rounded-full bg-[hsl(var(--color-secondary))]">
            <div
              className="h-full rounded-full bg-[hsl(var(--color-primary)/0.75)]"
              style={{ width: `${pct}%` }}
            />
          </div>
        )}
      </div>
    </button>
  );
}

/** 通知首页重新拉取数据（阅读器返回、进度变化等场景）。 */
export function notifyHomeRefresh() {
  try {
    window.dispatchEvent(new Event("app:home-refresh"));
  } catch {}
}

/**
 * 供阅读器在打开剧情时调用，更新 streak。
 *
 * 无论 streak 本身有没有变化都要广播刷新：当天第二次阅读不会改 streak，
 * 但阅读进度变了，首页仍然需要重新读一遍。
 */
export function bumpReadingStreak() {
  const t = todayKey();
  const current = readStreak();
  const next = nextReadingStreak(current, t);
  if (sameStreak(current, next)) {
    notifyHomeRefresh();
    return;
  }
  try {
    window.localStorage.setItem(STREAK_KEY, JSON.stringify(next));
  } catch {}
  notifyHomeRefresh();
}
