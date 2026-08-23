import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { StoryEntry } from "@/types/story";
import { Button } from "@/components/ui/button";
import { CustomScrollArea } from "@/components/ui/custom-scroll-area";
import { StoryThumbnail } from "@/components/StoryThumbnail";
import {
  READ_FINISHED_PCT,
  getReadingProgress,
  storyCatalog,
  toReadPercent,
  useOnlineStatus,
  type ReadingProgressEntry,
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

interface StreakInfo {
  currentStreak: number;
  lastReadOn: string; // YYYY-MM-DD
  totalDays: number;
}

function todayKey() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function readStreak(): StreakInfo {
  try {
    const raw = window.localStorage.getItem(STREAK_KEY);
    if (raw) return JSON.parse(raw);
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
    if (a[i].entry.storyId !== b[i].entry.storyId) return false;
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
  /** 读目录本身失败了（IPC 异常 / 数据损坏），和「没装数据」是两码事。 */
  const [loadFailed, setLoadFailed] = useState(false);
  const [streak, setStreak] = useState<StreakInfo>(() => readStreak());
  const online = useOnlineStatus();
  // 聚焦、返回列表、数据同步都会触发刷新，可能叠在一起。用递增序号
  // 保证只有最后一次的结果能写进 state。
  const loadSeqRef = useRef(0);

  const loadHome = useCallback(async () => {
    const seq = (loadSeqRef.current += 1);
    const stale = () => seq !== loadSeqRef.current;
    const hintTimer = window.setTimeout(() => {
      if (!stale()) setRefreshing(true);
    }, REFRESH_HINT_DELAY_MS);

    try {
      const ok = await storyCatalog.isInstalled();
      if (stale()) return;
      setInstalled(ok);
      setLoadFailed(false);
      if (!ok) {
        setRecentStories((prev) => (prev.length === 0 ? prev : []));
        setHighlight(null);
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
      setHighlight((prev) => (prev?.storyId === pick?.storyId ? prev : pick));

      // 2) 最近阅读：progress 的 key 就是 storyTxt，反查成 StoryEntry。
      // 快照和剧情列表的进度徽标同源，两边不可能显示成不一样的百分比。
      const entries = getReadingProgress().recent.slice(0, RECENT_SCAN_LIMIT);
      const byPath = new Map<string, StoryEntry>();
      allMain.forEach((story) => byPath.set(story.storyTxt, story));

      // 主线没覆盖到的才去问活动 / 支线 / 肉鸽 / 密录。新装或只读主线的
      // 用户因此能省掉四次 IPC；命中共享缓存时这里同样是零开销。
      if (entries.some((entry) => !byPath.has(entry.storyPath))) {
        const [acts, sides, rogues, mems] = await Promise.all([
          storyCatalog.grouped("activity").catch(() => []),
          storyCatalog.grouped("sidestory").catch(() => []),
          storyCatalog.grouped("roguelike").catch(() => []),
          storyCatalog.memory().catch(() => []),
        ]);
        if (stale()) return;
        [acts, sides, rogues].forEach((grouped) =>
          grouped.forEach(([, stories]) =>
            stories.forEach((story) => byPath.set(story.storyTxt, story))
          )
        );
        mems.forEach((story) => byPath.set(story.storyTxt, story));
      }

      // 保留完整命中列表：渲染只取前几张，但「最近阅读 N 章」要用真实数量。
      const matched = entries
        .map((item) => {
          const entry = byPath.get(item.storyPath);
          return entry ? { entry, meta: item } : null;
        })
        .filter((x): x is RecentStory => x !== null);
      setRecentStories((prev) => (sameRecentStories(prev, matched) ? prev : matched));
    } catch (err) {
      if (stale()) return;
      console.warn("[Home] load failed", err);
      // 读取失败 ≠ 没装数据。把两者混为一谈会让用户去做一次根本没必要的
      // 同步，所以这里只标记失败，由界面给出「重试 / 去设置」。
      setLoadFailed(true);
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
    const handler = () => {
      void loadHome();
      // 同上：连续阅读天数没变时保持同一个对象，避免整页跟着重渲染。
      setStreak((prev) => {
        const next = readStreak();
        return sameStreak(prev, next) ? prev : next;
      });
    };
    window.addEventListener("focus", handler);
    window.addEventListener("app:home-refresh", handler);
    window.addEventListener("app:data-updated", handler);
    return () => {
      window.removeEventListener("focus", handler);
      window.removeEventListener("app:home-refresh", handler);
      window.removeEventListener("app:data-updated", handler);
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
  const goToSettings = useCallback(() => onGoToTab("settings"), [onGoToTab]);
  const retryLoad = useCallback(() => {
    setLoadFailed(false);
    void loadHome();
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
          <div className="pl-[max(1.25rem,env(safe-area-inset-left,0px))] pr-[max(1.25rem,env(safe-area-inset-right,0px))] pb-32 space-y-6">
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
                  { label: "重试", onClick: retryLoad, icon: RotateCcw, variant: "default" },
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
                    ? "去设置里同步一次（约几十 MB），之后首页会记住你读到哪里，也可以完全离线阅读。"
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

            {installed === true && continueItem ? (
              <ContinueReadingCard
                entry={continueItem.entry}
                percentage={continueItem.meta.percentage}
                onOpen={() => onSelectStory(continueItem.entry)}
              />
            ) : installed === true ? (
              <EmptyContinueCard onBrowse={() => onGoToTab("stories")} />
            ) : null}

            {installed === true && (
              <StreakStrip
                streak={streak}
                favoritesCount={favoriteCount}
                recentCount={recentStories.length}
                onGoToRecent={() => onGoToTab("stories")}
                onGoToFavorites={handleGoToFavorites}
              />
            )}

            {installed === true && otherRecentStories.length > 0 && (
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

            {installed === true && highlight && (
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
              <div className="text-center text-sm text-[hsl(var(--color-muted-foreground))]">
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
    <div className="space-y-4" aria-hidden="true">
      <div className="story-card h-44 w-full motion-safe:animate-pulse bg-[hsl(var(--color-secondary)/0.5)]" />
      <div className="grid grid-cols-3 gap-2">
        {[0, 1, 2].map((i) => (
          <div
            key={i}
            className="h-[86px] rounded-2xl border border-[hsl(var(--color-border))] bg-[hsl(var(--color-secondary)/0.4)] motion-safe:animate-pulse"
          />
        ))}
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {[0, 1].map((i) => (
          <div
            key={i}
            className="h-[88px] rounded-2xl border border-[hsl(var(--color-border))] bg-[hsl(var(--color-secondary)/0.4)] motion-safe:animate-pulse"
          />
        ))}
      </div>
      <div className="sr-only">首页加载中</div>
    </div>
  );
}

interface HomeNoticeAction {
  label: string;
  onClick: () => void;
  icon?: LucideIcon;
  variant?: "default" | "outline";
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
      className="story-card group relative block w-full overflow-hidden text-left transition-transform active:scale-[0.995]"
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
  streak,
  favoritesCount,
  recentCount,
  onGoToRecent,
  onGoToFavorites,
}: {
  streak: StreakInfo;
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
    { icon: Flame, label: "连续阅读", value: `${streak.currentStreak} 天` },
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
            className={`${shared} transition-colors active:scale-[0.98] hover:border-[hsl(var(--color-primary)/0.5)] hover:bg-[hsl(var(--color-accent))]`}
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
  if (current.lastReadOn === t) {
    notifyHomeRefresh();
    return;
  }
  let next: StreakInfo;
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  const y = `${yesterday.getFullYear()}-${String(yesterday.getMonth() + 1).padStart(2, "0")}-${String(yesterday.getDate()).padStart(2, "0")}`;
  if (current.lastReadOn === y) {
    next = {
      currentStreak: current.currentStreak + 1,
      lastReadOn: t,
      totalDays: current.totalDays + 1,
    };
  } else {
    next = { currentStreak: 1, lastReadOn: t, totalDays: current.totalDays + 1 };
  }
  try {
    window.localStorage.setItem(STREAK_KEY, JSON.stringify(next));
  } catch {}
  notifyHomeRefresh();
}
