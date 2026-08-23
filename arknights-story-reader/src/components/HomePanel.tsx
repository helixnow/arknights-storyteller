import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { StoryEntry } from "@/types/story";
import { Button } from "@/components/ui/button";
import { CustomScrollArea } from "@/components/ui/custom-scroll-area";
import { StoryThumbnail } from "@/components/StoryThumbnail";
import { storyCatalog } from "@/components/StoryList";
import { useFavorites } from "@/hooks/useFavorites";
import { BookOpen, Flame, Sparkles } from "lucide-react";

type Tab = "home" | "stories" | "characters" | "search" | "settings";

interface HomePanelProps {
  onSelectStory: (story: StoryEntry) => void;
  onGoToTab: (tab: Tab) => void;
  /** 可选：直接跳到剧情页的「收藏」分类。不传时走 `app:open-favorites` 事件。 */
  onGoToFavorites?: () => void;
}

interface RecentItem {
  storyPath: string;
  percentage: number;
  updatedAt: number;
}

const STREAK_KEY = "arknights-reading-streak-v1";
const PROGRESS_KEY = "reading-progress";
/** 扫描最近进度的上限：够算「最近阅读 N 章」，又不会把整个 map 都解析成卡片。 */
const RECENT_SCAN_LIMIT = 60;
/** 首页最多渲染几张最近阅读卡片（含「继续阅读」大卡）。 */
const RECENT_RENDER_LIMIT = 5;
/** 刷新超过这个时长才提示「正在刷新」，命中缓存时不闪。 */
const REFRESH_HINT_DELAY_MS = 400;
/** 进度到这个比例就当作读完，和列表里「已读完」的口径一致。 */
const FINISHED_THRESHOLD = 0.99;

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

/** 阅读进度：percentage 是 0~1，脏数据（NaN / 越界）直接夹回区间。 */
function readRecentProgress(): RecentItem[] {
  try {
    const raw = window.localStorage.getItem(PROGRESS_KEY);
    if (!raw) return [];
    const map = JSON.parse(raw) as Record<string, { percentage?: number; updatedAt?: number }>;
    const entries: RecentItem[] = [];
    for (const [path, v] of Object.entries(map)) {
      if (!v || typeof v !== "object") continue;
      const percentage = Number(v.percentage ?? 0);
      const updatedAt = Number(v.updatedAt ?? 0);
      entries.push({
        storyPath: path,
        percentage: Number.isFinite(percentage) ? Math.min(1, Math.max(0, percentage)) : 0,
        updatedAt: Number.isFinite(updatedAt) ? updatedAt : 0,
      });
    }
    entries.sort((a, b) => b.updatedAt - a.updatedAt);
    return entries;
  } catch {
    return [];
  }
}

export function HomePanel({ onSelectStory, onGoToTab, onGoToFavorites }: HomePanelProps) {
  // 与剧情页「收藏」分类同口径：单章收藏 + 收藏分组展开后的去重总数。
  const { favoriteCount } = useFavorites();
  const [recentStories, setRecentStories] = useState<Array<{ entry: StoryEntry; meta: RecentItem }>>([]);
  const [highlight, setHighlight] = useState<StoryEntry | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  // null = 还没问过后端。先渲染骨架，避免闪一下「已安装」再跳回未同步。
  const [installed, setInstalled] = useState<boolean | null>(null);
  const [streak, setStreak] = useState<StreakInfo>(() => readStreak());
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
      if (!ok) {
        setRecentStories([]);
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
      setHighlight(allMain[hash % Math.max(allMain.length, 1)] ?? null);

      // 2) 最近阅读：progress 的 key 就是 storyTxt，反查成 StoryEntry。
      const entries = readRecentProgress().slice(0, RECENT_SCAN_LIMIT);
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
        .filter((x): x is { entry: StoryEntry; meta: RecentItem } => x !== null);
      setRecentStories(matched);
    } catch (err) {
      if (stale()) return;
      console.warn("[Home] load failed", err);
      setInstalled((prev) => prev ?? false);
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
      setStreak(readStreak());
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
      recentStories.find(({ meta }) => meta.percentage < FINISHED_THRESHOLD) ??
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

  const showSkeleton = installed === null;

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
        <h1 className="mt-1 text-2xl font-semibold">欢迎回来，博士</h1>
      </header>

      <main className="flex-1 overflow-hidden">
        <CustomScrollArea
          className="h-full"
          viewportClassName="reader-scroll"
          trackOffsetBottom="calc(5rem + env(safe-area-inset-bottom, 0px))"
        >
          <div className="pl-[max(1.25rem,env(safe-area-inset-left,0px))] pr-[max(1.25rem,env(safe-area-inset-right,0px))] pb-32 space-y-6">
            {showSkeleton && <HomeSkeleton />}

            {installed === false && (
              <div className="rounded-2xl border border-dashed border-[hsl(var(--color-border))] p-5 text-sm text-[hsl(var(--color-muted-foreground))]">
                <div>剧情数据尚未同步，先去设置里同步一次再回来。</div>
                <Button
                  className="mt-3 min-h-[44px]"
                  onClick={() => onGoToTab("settings")}
                >
                  去设置同步
                </Button>
              </div>
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
  const pct = Math.max(0, Math.min(100, Math.round(percentage * 100)));
  return (
    <button
      onClick={onOpen}
      className="story-card group relative block w-full overflow-hidden text-left transition-transform active:scale-[0.995]"
      aria-label={`继续阅读 ${entry.storyName}`}
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
  const pct = Math.max(0, Math.min(100, Math.round((percentage || 0) * 100)));
  const progressText = pct >= 99 ? "已读完" : pct > 0 ? `已读 ${pct}%` : "未开始";
  return (
    <button
      onClick={onOpen}
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
