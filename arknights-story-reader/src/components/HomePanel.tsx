import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "@/services/api";
import type { StoryEntry } from "@/types/story";
import { Button } from "@/components/ui/button";
import { CustomScrollArea } from "@/components/ui/custom-scroll-area";
import { AssetImage } from "@/components/AssetImage";
import { useFavorites } from "@/hooks/useFavorites";
import { BookOpen, Flame, Sparkles } from "lucide-react";

type Tab = "home" | "stories" | "characters" | "search" | "settings";

interface HomePanelProps {
  onSelectStory: (story: StoryEntry) => void;
  onGoToTab: (tab: Tab) => void;
}

interface RecentItem {
  storyPath: string;
  percentage: number;
  updatedAt: number;
}

const STREAK_KEY = "arknights-reading-streak-v1";
const PROGRESS_KEY = "reading-progress";

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

function readRecentProgress(): RecentItem[] {
  try {
    const raw = window.localStorage.getItem(PROGRESS_KEY);
    if (!raw) return [];
    const map = JSON.parse(raw) as Record<string, { percentage?: number; updatedAt?: number; storyPath?: string }>;
    const entries: RecentItem[] = [];
    for (const [path, v] of Object.entries(map)) {
      if (!v || typeof v !== "object") continue;
      entries.push({
        storyPath: path,
        percentage: Number(v.percentage ?? 0),
        updatedAt: Number(v.updatedAt ?? 0),
      });
    }
    entries.sort((a, b) => b.updatedAt - a.updatedAt);
    return entries;
  } catch {
    return [];
  }
}

export function HomePanel({ onSelectStory, onGoToTab }: HomePanelProps) {
  const { favoriteStories } = useFavorites();
  const [recentStories, setRecentStories] = useState<Array<{ entry: StoryEntry; meta: RecentItem }>>([]);
  const [highlight, setHighlight] = useState<StoryEntry | null>(null);
  const [loading, setLoading] = useState(true);
  const [installed, setInstalled] = useState(true);
  const [streak, setStreak] = useState<StreakInfo>(() => readStreak());

  const loadHome = useCallback(async () => {
    try {
      setLoading(true);
      const ok = await api.isInstalled();
      setInstalled(ok);
      if (!ok) {
        setLoading(false);
        return;
      }
      // 1) 最近阅读 (从 localStorage 读 progress，storyPath 就是 storyTxt)
      const entries = readRecentProgress().slice(0, 12);
      // 2) 主线随机一章作为"今日推荐"
      const main = await api.getMainStoriesGrouped();
      const allMain: StoryEntry[] = main.flatMap(([, stories]) => stories);
      // Deterministic per-day pick: hash of today string -> index
      const t = todayKey();
      let hash = 0;
      for (let i = 0; i < t.length; i += 1) hash = (hash * 31 + t.charCodeAt(i)) >>> 0;
      const pick = allMain[hash % Math.max(allMain.length, 1)] ?? null;
      setHighlight(pick);

      // 3) 把 progress 条目中能查到的 StoryEntry 加载出来
      const byPath = new Map<string, StoryEntry>();
      allMain.forEach((s) => byPath.set(s.storyTxt, s));
      // 也加载活动/支线/肉鸽/密录以尽量命中
      const [acts, sides, rogues, mems] = await Promise.all([
        api.getActivityStoriesGrouped().catch(() => []),
        api.getSidestoryStoriesGrouped().catch(() => []),
        api.getRoguelikeStoriesGrouped().catch(() => []),
        api.getMemoryStories().catch(() => []),
      ]);
      (acts as Array<[string, StoryEntry[]]>).forEach(([, ss]) => ss.forEach((s) => byPath.set(s.storyTxt, s)));
      (sides as Array<[string, StoryEntry[]]>).forEach(([, ss]) => ss.forEach((s) => byPath.set(s.storyTxt, s)));
      (rogues as Array<[string, StoryEntry[]]>).forEach(([, ss]) => ss.forEach((s) => byPath.set(s.storyTxt, s)));
      (mems as StoryEntry[]).forEach((s) => byPath.set(s.storyTxt, s));

      const matched = entries
        .map((e) => {
          const entry = byPath.get(e.storyPath);
          return entry ? { entry, meta: e } : null;
        })
        .filter((x): x is { entry: StoryEntry; meta: RecentItem } => x !== null)
        .slice(0, 5);
      setRecentStories(matched);
    } catch (err) {
      console.warn("[Home] load failed", err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadHome();
  }, [loadHome]);

  useEffect(() => {
    // Refresh when user returns from reader (approx via visibility or listen
    // to custom event from reader). We'll refetch each time tab becomes home.
    const handler = () => {
      void loadHome();
      setStreak(readStreak());
    };
    window.addEventListener("focus", handler);
    window.addEventListener("app:home-refresh", handler);
    return () => {
      window.removeEventListener("focus", handler);
      window.removeEventListener("app:home-refresh", handler);
    };
  }, [loadHome]);

  const favoritesCount = useMemo(() => Object.keys(favoriteStories).length, [favoriteStories]);
  const continueItem = recentStories[0] ?? null;
  const coverKind = continueItem
    ? continueItem.entry.storyTxt.startsWith("activities/")
      ? "activity_kv"
      : "chapter_cover"
    : "chapter_cover";
  const coverToken = continueItem?.entry.storyGroup ?? null;

  return (
    <div className="h-full flex flex-col overflow-hidden">
      <header className="flex-shrink-0 px-5 pt-6 pb-2 motion-safe:animate-in motion-safe:fade-in-0">
        <div className="text-[11px] uppercase tracking-[0.18em] text-[hsl(var(--color-muted-foreground))]">
          Welcome, Doctor
        </div>
        <h1 className="mt-1 text-2xl font-semibold">阅读你的罗德岛</h1>
      </header>

      <main className="flex-1 overflow-hidden">
        <CustomScrollArea
          className="h-full"
          viewportClassName="reader-scroll"
          trackOffsetBottom="calc(5rem + env(safe-area-inset-bottom, 0px))"
        >
          <div className="px-5 pb-32 space-y-6">
            {!installed && (
              <div className="rounded-2xl border border-dashed border-[hsl(var(--color-border))] p-5 text-sm text-[hsl(var(--color-muted-foreground))]">
                剧情数据尚未同步。请先去
                <button
                  className="mx-1 underline text-[hsl(var(--color-primary))]"
                  onClick={() => onGoToTab("settings")}
                >
                  设置
                </button>
                同步数据。
              </div>
            )}

            {installed && continueItem ? (
              <ContinueReadingCard
                entry={continueItem.entry}
                percentage={continueItem.meta.percentage}
                coverKind={coverKind as "activity_kv" | "chapter_cover"}
                coverToken={coverToken}
                onOpen={() => onSelectStory(continueItem.entry)}
              />
            ) : installed ? (
              <EmptyContinueCard onBrowse={() => onGoToTab("stories")} />
            ) : null}

            {installed && (
              <StreakStrip streak={streak} favoritesCount={favoritesCount} recentCount={recentStories.length} />
            )}

            {installed && recentStories.length > 1 && (
              <section className="space-y-3">
                <SectionTitle icon={BookOpen} title="最近阅读" />
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  {recentStories.slice(1, 5).map(({ entry, meta }) => (
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

            {installed && highlight && (
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

            {loading && (
              <div className="text-center text-sm text-[hsl(var(--color-muted-foreground))]">
                正在准备首页…
              </div>
            )}
          </div>
        </CustomScrollArea>
      </main>
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
  coverKind,
  coverToken,
  onOpen,
}: {
  entry: StoryEntry;
  percentage: number;
  coverKind: "activity_kv" | "chapter_cover";
  coverToken: string | null;
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
        <AssetImage kind={coverKind} token={coverToken} tint="tint" alt={entry.storyName} />
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
        <Button size="sm" onClick={onBrowse}>
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
}: {
  streak: StreakInfo;
  favoritesCount: number;
  recentCount: number;
}) {
  const items = [
    { icon: Flame, label: "连续阅读", value: `${streak.currentStreak} 天` },
    { icon: BookOpen, label: "最近阅读", value: `${recentCount} 章` },
    { icon: Sparkles, label: "收藏剧情", value: `${favoritesCount}` },
  ];
  return (
    <div className="grid grid-cols-3 gap-2">
      {items.map(({ icon: Icon, label, value }) => (
        <div
          key={label}
          className="flex flex-col items-center gap-1 rounded-2xl border border-[hsl(var(--color-border))] bg-[hsl(var(--color-card))] px-3 py-3 text-center"
        >
          <Icon className="h-4 w-4 text-[hsl(var(--color-primary))]" />
          <div className="text-[11px] text-[hsl(var(--color-muted-foreground))]">{label}</div>
          <div className="text-sm font-semibold tabular-nums">{value}</div>
        </div>
      ))}
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
  return (
    <button
      onClick={onOpen}
      className="story-card flex w-full items-stretch gap-3 p-3 text-left transition-transform active:scale-[0.99]"
    >
      <div className="relative h-16 w-24 flex-shrink-0 overflow-hidden rounded-lg">
        <AssetImage kind="chapter_cover" token={entry.storyGroup} alt={entry.storyName} />
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
          {tag ?? (pct > 0 ? `已读 ${pct}%` : "未开始")}
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

/**
 * 供阅读器在打开剧情时调用，更新 streak。
 */
export function bumpReadingStreak() {
  const t = todayKey();
  const current = readStreak();
  if (current.lastReadOn === t) return;
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
    window.dispatchEvent(new Event("app:home-refresh"));
  } catch {}
}