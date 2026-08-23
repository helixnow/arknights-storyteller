import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "@/services/api";
import type { ParsedStoryContent, StoryEntry } from "@/types/story";
import { Button } from "@/components/ui/button";
import { CustomScrollArea } from "@/components/ui/custom-scroll-area";
import { Input } from "@/components/ui/input";
import { Collapsible } from "@/components/ui/collapsible";
import { ArrowLeft, Loader2, Shuffle } from "lucide-react";
import { cn } from "@/lib/utils";
import { CharacterAvatar } from "@/components/CharacterAvatar";
import { postProcessSegments } from "@/components/StoryReader";

interface CharactersPanelProps {
  active?: boolean;
  onOpenStory: (story: StoryEntry, character: string) => void;
  onOpenStoryJump?: (
    story: StoryEntry,
    jump: { segmentIndex: number; preview?: string },
  ) => void;
}

interface CharacterStatsPerStory {
  story: StoryEntry;
  count: number;
}

interface CharacterAggregate {
  name: string;
  total: number;
  perStory: CharacterStatsPerStory[];
}

interface CharacterQuote {
  text: string;
  storyName: string;
  story: StoryEntry;
  segmentIndex: number;
}

type GroupCategory = "main" | "activity" | "memory" | "other";

// 统计阶段的剧情读取并发。
const STATS_POOL_SIZE = 6;
// 进度条刷新粒度：每 N 篇才 setState 一次，避免几千次无意义 re-render。
const PROGRESS_STEP = 8;

// ── 金句抓取 ───────────────────────────────────────────────
// 博士/凯尔希这类角色的 perStory 有上千条，绝不能 Promise.all 全量拉。
// 只取发言最多的若干篇（金句密度最高），并且限制并发。
const QUOTE_STORY_LIMIT = 36;
const QUOTE_FETCH_CONCURRENCY = 5;
/** 候选池上限；UI 每次从池里随机抽 5 条。 */
const QUOTE_POOL_SIZE = 80;
/** 收集到这么多条就提前收工，后面的剧情不再拉。 */
const QUOTE_HARD_CAP = 400;
const QUOTE_MIN_LEN = 10;
const QUOTE_MAX_LEN = 160;
const QUOTE_DISPLAY_COUNT = 5;

interface GroupInfo {
  category: GroupCategory;
  groupName: string;
  groupOrder: number; // 用于排序章节/活动顺序
  storyOrder: number; // 用于组内排序（同主页）
}

/** Fisher–Yates 洗牌后取前 n 条，不改动传入数组。 */
function pickRandomQuotes(pool: CharacterQuote[], n: number): CharacterQuote[] {
  const shuffled = [...pool];
  for (let i = shuffled.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled.slice(0, n);
}

function countCharactersInStory(content: ParsedStoryContent): Map<string, number> {
  const map = new Map<string, number>();
  content.segments.forEach((seg) => {
    if (seg.type === "dialogue") {
      const key = seg.characterName;
      map.set(key, (map.get(key) ?? 0) + 1);
    }
  });
  return map;
}

export function CharactersPanel({
  active = true,
  onOpenStory,
  onOpenStoryJump,
}: CharactersPanelProps) {
  const [loading, setLoading] = useState(true);
  const [progress, setProgress] = useState({ current: 0, total: 0 });
  const [error, setError] = useState<string | null>(null);
  const [notInstalled, setNotInstalled] = useState(false);
  const [aggregates, setAggregates] = useState<Map<string, CharacterAggregate>>(new Map());
  const [selected, setSelected] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const loadingRef = useRef(false);
  const activeRef = useRef(active);
  const loadedOnceRef = useRef(false);
  const staleRef = useRef(false);
  const [groupInfoByStoryId, setGroupInfoByStoryId] = useState<Map<string, GroupInfo>>(new Map());
  const [groupSearch, setGroupSearch] = useState<Record<string, string>>({});
  const [cacheUsed, setCacheUsed] = useState(false);
  const [cacheBuiltAt, setCacheBuiltAt] = useState<number | null>(null);
  const [version, setVersion] = useState<string | null>(null);
  const [quotes, setQuotes] = useState<CharacterQuote[]>([]);
  const [quoteCandidates, setQuoteCandidates] = useState<CharacterQuote[]>([]);
  const [loadingQuotes, setLoadingQuotes] = useState(false);
  /** 当前 quotes 属于哪位角色；和 selected 不一致就说明还没抓完。 */
  const [quotesFor, setQuotesFor] = useState<string | null>(null);
  const quotesRunRef = useRef(0);

  const CACHE_PREFIX = "arknights-characters-cache";
  // 缓存 key 只取 commit hash 部分（版本字符串前 7 位），忽略时间戳。
  // 这样只要底层数据没变（同一个 commit），缓存就一直有效，不会因为
  // 重启或重新同步（同版本）而失效。
  const getCacheKey = useCallback((v: string) => {
    const commitPart = v.split(" ")[0] || v;
    return `${CACHE_PREFIX}:${commitPart}`;
  }, []);

  const loadAll = useCallback(async (opts?: { forceRefresh?: boolean }) => {
    if (loadingRef.current) return;
    loadingRef.current = true;
    setLoading(true);
    setError(null);
    try {
      // 数据没同步时后端每个命令都会抛错，先问一次省掉一串失败请求。
      const installed = await api.isInstalled();
      if (!installed) {
        setNotInstalled(true);
        setAggregates(new Map());
        setProgress({ current: 0, total: 0 });
        // 不算"已加载"：同步完数据切回来要能自动重试。
        loadedOnceRef.current = false;
        return;
      }
      setNotInstalled(false);

      const ver = await api.getCurrentVersion();
      setVersion(ver);

      // 使用主页同样的分组与排序数据源
      const [mainGrouped, activityGrouped, sidestoryGrouped, roguelikeGrouped, memoryStories] =
        await Promise.all([
          api.getMainStoriesGrouped(),
          api.getActivityStoriesGrouped(),
          api.getSidestoryStoriesGrouped().catch(() => []),
          api.getRoguelikeStoriesGrouped().catch(() => []),
          api.getMemoryStories(),
        ]);

      // 生成 groupInfoByStoryId
      const groupInfo = new Map<string, GroupInfo>();

      mainGrouped.forEach(([chapterName, stories], groupOrder) => {
        stories.forEach((s) => {
          groupInfo.set(s.storyId, {
            category: "main",
            groupName: chapterName,
            groupOrder,
            storyOrder: s.storySort,
          });
        });
      });

      activityGrouped.forEach(([activityName, stories], groupOrder) => {
        stories.forEach((s) => {
          groupInfo.set(s.storyId, {
            category: "activity",
            groupName: activityName,
            groupOrder,
            storyOrder: s.storySort,
          });
        });
      });

      memoryStories.forEach((s, idx) => {
        groupInfo.set(s.storyId, {
          category: "memory",
          groupName: "干员密录",
          groupOrder: idx,
          storyOrder: s.storySort,
        });
      });

      sidestoryGrouped.forEach(([name, stories], groupOrder) => {
        stories.forEach((s) => {
          if (!groupInfo.has(s.storyId)) {
            groupInfo.set(s.storyId, {
              category: "activity",
              groupName: name,
              groupOrder,
              storyOrder: s.storySort,
            });
          }
        });
      });

      roguelikeGrouped.forEach(([name, stories], groupOrder) => {
        stories.forEach((s) => {
          groupInfo.set(s.storyId, {
            category: "other",
            groupName: name,
            groupOrder,
            storyOrder: s.storySort,
          });
        });
      });

      const storiesMap = new Map<string, StoryEntry>();
      mainGrouped.forEach(([, stories]) => stories.forEach((s) => storiesMap.set(s.storyId, s)));
      activityGrouped.forEach(([, stories]) => stories.forEach((s) => storiesMap.set(s.storyId, s)));
      sidestoryGrouped.forEach(([, stories]) => stories.forEach((s) => storiesMap.set(s.storyId, s)));
      roguelikeGrouped.forEach(([, stories]) => stories.forEach((s) => storiesMap.set(s.storyId, s)));
      memoryStories.forEach((s) => storiesMap.set(s.storyId, s));

      const stories = Array.from(storiesMap.values());
      setGroupInfoByStoryId(groupInfo);
      setProgress({ current: 0, total: stories.length });

      const aggMap = new Map<string, CharacterAggregate>();

      // 1) 先尝试命中缓存
      let cacheApplied = false;
      if (!opts?.forceRefresh && ver) {
        try {
          const raw = localStorage.getItem(getCacheKey(ver));
          if (raw) {
            const parsed: {
              builtAt: number;
              data: Record<string, { name: string; total: number; perStory: Array<{ storyId: string; count: number }> }>;
            } = JSON.parse(raw);
            Object.values(parsed.data).forEach((item) => {
              const perStory: CharacterStatsPerStory[] = [];
              item.perStory.forEach((ps) => {
                const story = storiesMap.get(ps.storyId);
                if (story) perStory.push({ story, count: ps.count });
              });
              aggMap.set(item.name, { name: item.name, total: item.total, perStory });
            });
            cacheApplied = true;
            setCacheUsed(true);
            setCacheBuiltAt(parsed.builtAt);
          }
        } catch {
          // 缓存损坏就丢掉重建，不用打扰用户。
          try {
            localStorage.removeItem(getCacheKey(ver));
          } catch {}
        }
      }

      // 顺序加载，避免峰值占用过高；可根据需要增加并发
      if (!cacheApplied) {
        setCacheUsed(false);
        setCacheBuiltAt(null);
        // Concurrency pool: process N stories in parallel so first-start on
        // slow devices doesn't take minutes. Each story's aggregation still
        // runs on a single thread — we just overlap I/O and parse work.
        let cursor = 0;
        let done = 0;
        let failed = 0;
        const applyCounts = (story: StoryEntry, counts: Map<string, number>) => {
          counts.forEach((count, name) => {
            const existing = aggMap.get(name);
            if (existing) {
              existing.total += count;
              existing.perStory.push({ story, count });
            } else {
              aggMap.set(name, {
                name,
                total: count,
                perStory: [{ story, count }],
              });
            }
          });
        };
        const worker = async () => {
          while (true) {
            const i = cursor++;
            if (i >= stories.length) return;
            const story = stories[i];
            try {
              const content = await api.getStoryContent(story.storyTxt);
              // JS 单线程，applyCounts 是同步的，不需要任何锁。
              applyCounts(story, countCharactersInStory(content));
            } catch {
              failed += 1;
            } finally {
              done += 1;
              if (done % PROGRESS_STEP === 0 || done === stories.length) {
                setProgress({ current: done, total: stories.length });
              }
            }
          }
        };
        await Promise.all(
          Array.from({ length: Math.min(STATS_POOL_SIZE, stories.length) }, () => worker())
        );
        if (failed > 0) {
          console.warn(`[CharactersPanel] ${failed}/${stories.length} 篇剧情读取失败，已跳过`);
        }
      }

      // 整理每个角色的 perStory 排序（默认先按章节内排序）
      aggMap.forEach((agg) => {
        agg.perStory.sort((a, b) => {
          const ga = groupInfo.get(a.story.storyId);
          const gb = groupInfo.get(b.story.storyId);
          const gOrder = (ga?.groupOrder ?? 9999) - (gb?.groupOrder ?? 9999);
          if (gOrder !== 0) return gOrder;
          const sOrder = (ga?.storyOrder ?? a.story.storySort) - (gb?.storyOrder ?? b.story.storySort);
          if (sOrder !== 0) return sOrder;
          return a.story.storyName.localeCompare(b.story.storyName, "zh-Hans");
        });
      });

      setAggregates(aggMap);

      // 2) 没用缓存则保存缓存（精简 perStory 为 storyId + count）
      if (!cacheApplied && ver) {
        try {
          const plain: Record<string, { name: string; total: number; perStory: Array<{ storyId: string; count: number }> }> = {};
          aggMap.forEach((agg, name) => {
            plain[name] = {
              name,
              total: agg.total,
              perStory: agg.perStory.map((ps) => ({ storyId: ps.story.storyId, count: ps.count })),
            };
          });
          const builtAt = Date.now();
          localStorage.setItem(
            getCacheKey(ver),
            JSON.stringify({ builtAt, data: plain })
          );
          setCacheBuiltAt(builtAt);
        } catch {
          // localStorage 写满或被禁用：统计仍然可用，只是下次要重算。
        }
      }

      loadedOnceRef.current = true;
    } catch (err) {
      const raw = err instanceof Error ? err.message : String(err);
      loadedOnceRef.current = false;
      if (/NOT_INSTALLED|未安装/i.test(raw)) {
        setNotInstalled(true);
      } else {
        setError(raw || "加载失败");
      }
    } finally {
      setLoading(false);
      loadingRef.current = false;
    }
  }, [getCacheKey]);

  // 只在面板首次可见时统计；之后除非数据变了，切回来不重跑。
  useEffect(() => {
    activeRef.current = active;
    if (!active) return;
    if (loadedOnceRef.current && !staleRef.current) return;
    const force = staleRef.current;
    staleRef.current = false;
    void loadAll(force ? { forceRefresh: true } : undefined);
  }, [active, loadAll]);

  useEffect(() => {
    const handler = () => {
      // 面板不可见时只打个标记，等用户切回来再重算——后台重扫几千篇
      // 剧情会把正在阅读的页面拖卡。
      if (!activeRef.current) {
        staleRef.current = true;
        loadedOnceRef.current = false;
        return;
      }
      void loadAll({ forceRefresh: true });
    };
    window.addEventListener("app:refresh-character-stats", handler);
    window.addEventListener("app:data-updated", handler);
    return () => {
      window.removeEventListener("app:refresh-character-stats", handler);
      window.removeEventListener("app:data-updated", handler);
    };
  }, [loadAll]);

  const allCharacters = useMemo(() => {
    return Array.from(aggregates.values())
      .filter((c) => !!c.name && c.name.trim().length > 0)
      .sort((a, b) => b.total - a.total || a.name.localeCompare(b.name, "zh-Hans"));
  }, [aggregates]);

  const filteredCharacters = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return allCharacters;
    return allCharacters.filter((c) => c.name.toLowerCase().includes(q));
  }, [allCharacters, search]);

  const selectedAgg = useMemo(() => (selected ? aggregates.get(selected) ?? null : null), [aggregates, selected]);

  const groupedByChapter = useMemo(() => {
    if (!selectedAgg) return [] as Array<{ groupName: string; items: CharacterStatsPerStory[]; order: number }>;
    const buckets = new Map<string, { groupName: string; order: number; items: CharacterStatsPerStory[] }>();
    selectedAgg.perStory.forEach((ps) => {
      const info = groupInfoByStoryId.get(ps.story.storyId);
      const key = info ? `${info.category}:${info.groupName}` : `other:其他`;
      const bucket = buckets.get(key);
      if (bucket) {
        bucket.items.push(ps);
      } else {
        buckets.set(key, {
          groupName: info?.groupName ?? "其他",
          order: info?.groupOrder ?? 9999,
          items: [ps],
        });
      }
    });
    return Array.from(buckets.values()).sort((a, b) => a.order - b.order);
  }, [groupInfoByStoryId, selectedAgg]);

  useEffect(() => {
    if (!selected || !selectedAgg) {
      quotesRunRef.current += 1;
      setQuotes([]);
      setQuoteCandidates([]);
      setQuotesFor(null);
      setLoadingQuotes(false);
      return;
    }
    const runId = ++quotesRunRef.current;
    setLoadingQuotes(true);
    setQuotes([]);
    setQuoteCandidates([]);
    setQuotesFor(null);

    // 博士这类角色能有上千篇 perStory。只挑发言最多的几十篇，再用固定
    // 并发去读——既够凑满候选池，又不会一次性打爆 IPC 队列。
    const targets = [...selectedAgg.perStory]
      .sort((a, b) => b.count - a.count)
      .slice(0, QUOTE_STORY_LIMIT);

    const collected: CharacterQuote[] = [];
    const seenText = new Set<string>();
    let cursor = 0;
    let cancelled = false;

    const worker = async () => {
      while (!cancelled && runId === quotesRunRef.current) {
        if (collected.length >= QUOTE_HARD_CAP) return;
        const i = cursor++;
        if (i >= targets.length) return;
        const { story } = targets[i];
        try {
          const content = await api.getStoryContent(story.storyTxt);
          // 必须走 postProcessSegments：阅读器渲染的就是这份下标，
          // 否则点金句跳过去会错位。
          postProcessSegments(content.segments).forEach((seg, segmentIndex) => {
            if (seg.type !== "dialogue" || seg.characterName !== selected) return;
            const text = seg.text.trim();
            if (text.length < QUOTE_MIN_LEN || text.length > QUOTE_MAX_LEN) return;
            if (seenText.has(text)) return;
            seenText.add(text);
            collected.push({ text, storyName: story.storyName, story, segmentIndex });
          });
        } catch {
          // 单篇读不到就跳过，不影响其他金句。
        }
      }
    };

    void Promise.all(
      Array.from({ length: Math.min(QUOTE_FETCH_CONCURRENCY, targets.length) }, () =>
        worker()
      )
    ).then(() => {
      if (cancelled || runId !== quotesRunRef.current) return;
      // 长句更像"金句"，取最长的一批做候选池，再从池里随机抽几条展示。
      collected.sort((a, b) => b.text.length - a.text.length);
      const pool = collected.slice(0, QUOTE_POOL_SIZE);
      // 候选池和展示句一起落地，避免中间出现一帧"暂无金句"。
      setQuoteCandidates(pool);
      setQuotes(pickRandomQuotes(pool, QUOTE_DISPLAY_COUNT));
      setQuotesFor(selected);
      setLoadingQuotes(false);
    });

    return () => {
      cancelled = true;
    };
  }, [selected, selectedAgg]);

  const handleShuffleQuotes = useCallback(() => {
    setQuotes(pickRandomQuotes(quoteCandidates, QUOTE_DISPLAY_COUNT));
  }, [quoteCandidates]);

  const handleGoToSettings = useCallback(() => {
    window.dispatchEvent(new CustomEvent("app:go-tab", { detail: "settings" }));
  }, []);

  // 刚选中角色、effect 还没跑起来的那一帧也算"加载中"，否则会闪一下空态。
  const quotesPending = loadingQuotes || (selected !== null && quotesFor !== selected);

  const handleQuoteClick = useCallback(
    (quote: CharacterQuote) => {
      if (onOpenStoryJump) {
        onOpenStoryJump(quote.story, {
          segmentIndex: quote.segmentIndex,
          preview: quote.text,
        });
      } else {
        onOpenStory(quote.story, selectedAgg?.name ?? "");
      }
    },
    [onOpenStory, onOpenStoryJump, selectedAgg],
  );

  return (
    <div className="h-full flex flex-col">
      <header className="px-4 py-3 border-b border-[hsl(var(--color-border))] flex items-center gap-3">
        {selected && (
          <Button variant="ghost" size="icon" onClick={() => setSelected(null)} aria-label="返回">
            <ArrowLeft className="h-5 w-5" />
          </Button>
        )}
        <h1 className="text-base font-semibold truncate">
          {selected ? `人物：${selected}` : "人物统计"}
        </h1>
        {!selected && (
          <div className="ml-auto min-w-0 flex-1 max-w-[14rem]">
            <Input
              placeholder="搜索人物"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              aria-label="搜索人物"
            />
          </div>
        )}
      </header>

      <CustomScrollArea
        className="flex-1"
        trackOffsetTop="calc(3.25rem + 10px)"
        trackOffsetBottom="calc(4.5rem + env(safe-area-inset-bottom, 0px))"
      >
        <div className="p-4 pb-24 space-y-4">
          {loading && (
            <div className="flex items-center gap-3 text-sm text-[hsl(var(--color-muted-foreground))]">
              <Loader2 className="h-4 w-4 animate-spin" />
              <span>
                {progress.total > 0
                  ? `正在统计人物发言… ${progress.current}/${progress.total}`
                  : "正在准备人物统计…"}
              </span>
            </div>
          )}

          {notInstalled && !loading && (
            <div className="rounded-2xl border border-dashed border-[hsl(var(--color-border))] p-5">
              <div className="text-sm font-medium">还没有剧情数据</div>
              <p className="mt-1.5 text-sm leading-relaxed text-[hsl(var(--color-muted-foreground))]">
                人物统计需要先同步一次剧情文本。到设置页下载或导入 ArknightsGameData
                之后，这里会自动统计每位干员的发言次数、出场章节和金句。
              </p>
              <div className="mt-3 flex flex-wrap gap-2">
                <Button className="min-h-[44px]" onClick={handleGoToSettings}>
                  去设置同步
                </Button>
                <Button
                  variant="ghost"
                  className="min-h-[44px]"
                  onClick={() => void loadAll({ forceRefresh: true })}
                >
                  重新检测
                </Button>
              </div>
            </div>
          )}

          {error && !loading && (
            <div className="rounded-2xl border border-[hsl(var(--color-border))] p-5">
              <div className="text-sm font-medium text-[hsl(var(--color-destructive))]">
                统计失败
              </div>
              <p className="mt-1.5 text-sm leading-relaxed text-[hsl(var(--color-muted-foreground))] break-words">
                {error}
              </p>
              <Button
                className="mt-3 min-h-[44px]"
                onClick={() => void loadAll({ forceRefresh: true })}
              >
                重试
              </Button>
            </div>
          )}

          {!loading && !selected && !notInstalled && !error && (
            <div className="text-xs text-[hsl(var(--color-muted-foreground))]">
              {cacheUsed && cacheBuiltAt
                ? `已使用缓存，构建于 ${new Date(cacheBuiltAt).toLocaleString()}`
                : version
                ? `未使用缓存（版本 ${version}）`
                : null}
            </div>
          )}

          {!selected && !notInstalled && (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
              {filteredCharacters.map((c) => (
                <button
                  key={c.name}
                  className={cn(
                    "character-grid-cell flex items-center gap-3 rounded-lg border border-[hsl(var(--color-border))] bg-[hsl(var(--color-card))] p-3 text-left"
                  )}
                  onClick={() => setSelected(c.name)}
                >
                  <CharacterAvatar name={c.name} size={40} />
                  <div className="font-medium truncate flex-1 min-w-0">{c.name}</div>
                  <div className="text-xs text-[hsl(var(--color-muted-foreground))] shrink-0">{c.total} 次</div>
                </button>
              ))}
              {loading &&
                filteredCharacters.length === 0 &&
                Array.from({ length: 6 }, (_, i) => (
                  <div
                    key={`skeleton-${i}`}
                    className="flex items-center gap-3 rounded-lg border border-[hsl(var(--color-border))] bg-[hsl(var(--color-card))] p-3"
                    aria-hidden="true"
                  >
                    <div className="h-10 w-10 shrink-0 rounded-full bg-[hsl(var(--color-secondary))] animate-pulse" />
                    <div className="h-3 w-24 rounded bg-[hsl(var(--color-secondary))] animate-pulse" />
                  </div>
                ))}
              {!loading && !error && filteredCharacters.length === 0 && (
                <div className="col-span-full text-sm text-[hsl(var(--color-muted-foreground))]">
                  {search.trim() ? `没有匹配“${search.trim()}”的人物` : "还没有统计到人物"}
                </div>
              )}
            </div>
          )}

          {selected && selectedAgg && (
            <div className="space-y-4">
              <div className="flex items-center gap-4">
                <CharacterAvatar name={selected} size={80} tint="none" />
                <div className="min-w-0">
                  <div className="text-lg font-semibold truncate">{selectedAgg.name}</div>
                  <div className="text-sm text-[hsl(var(--color-muted-foreground))]">
                    共计 {selectedAgg.total} 次发言，涉及 {selectedAgg.perStory.length} 个章节/关卡
                  </div>
                </div>
              </div>

              {quotesPending && (
                <div
                  className="rounded-lg border border-[hsl(var(--color-border))] bg-[hsl(var(--color-card))] p-4 space-y-2"
                  style={{ minHeight: 80 }}
                >
                  <div className="h-3 w-24 rounded bg-[hsl(var(--color-secondary))] animate-pulse" />
                  <div className="h-3 w-full rounded bg-[hsl(var(--color-secondary))] animate-pulse" />
                  <div className="h-3 w-3/4 rounded bg-[hsl(var(--color-secondary))] animate-pulse" />
                </div>
              )}

              {!quotesPending && quotes.length > 0 && (
                <div
                  className="rounded-lg border border-[hsl(var(--color-border))] bg-[hsl(var(--color-card))] p-4 space-y-3"
                  style={{ minHeight: 80 }}
                >
                  <div className="flex items-center justify-between">
                    <div className="text-sm font-medium">金句</div>
                    {quoteCandidates.length > quotes.length && (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="-my-1 min-h-[44px] px-3 text-xs text-[hsl(var(--color-muted-foreground))]"
                        onClick={handleShuffleQuotes}
                        aria-label="换一批金句"
                      >
                        <Shuffle className="h-3.5 w-3.5 mr-1" />
                        换一批
                      </Button>
                    )}
                  </div>
                  {quotes.map((quote, i) => (
                    <button
                      key={`${quote.story.storyId}-${quote.segmentIndex}-${i}`}
                      type="button"
                      onClick={() => handleQuoteClick(quote)}
                      className="relative block w-full min-h-[44px] pl-6 pr-2 py-2 text-left text-sm leading-relaxed text-[hsl(var(--color-foreground))] rounded-md transition-colors hover:bg-[hsl(var(--color-secondary))] focus:outline-none focus-visible:ring-2 focus-visible:ring-[hsl(var(--color-ring))]"
                      aria-label={`跳转到 ${quote.storyName} 中的这句话`}
                    >
                      <span
                        aria-hidden="true"
                        className="absolute left-0 top-0 text-2xl leading-none text-[hsl(var(--color-muted-foreground))] select-none"
                      >
                        &ldquo;
                      </span>
                      <div className="whitespace-pre-wrap break-words">{quote.text}</div>
                      <div className="mt-1 text-xs text-[hsl(var(--color-muted-foreground))]">
                        —— {selectedAgg.name} · {quote.storyName}
                      </div>
                    </button>
                  ))}
                </div>
              )}

              {!quotesPending && quotes.length === 0 && (
                <div className="rounded-lg border border-dashed border-[hsl(var(--color-border))] p-4 text-sm text-[hsl(var(--color-muted-foreground))]">
                  这位角色暂时没有合适长度的金句，往下翻可以直接看出场章节。
                </div>
              )}

          {groupedByChapter.map((group, idx) => {
            const key = group.groupName;
            const q = (groupSearch[key] ?? "").trim().toLowerCase();
            const items = q
              ? group.items.filter(({ story }) =>
                  [story.storyName, story.storyCode ?? "", story.storyGroup ?? ""].some((v) =>
                    v.toLowerCase().includes(q)
                  )
                )
              : group.items;
            const totalCount = group.items.reduce((sum, it) => sum + it.count, 0);

            return (
              <Collapsible key={key} title={group.groupName} defaultOpen={idx === 0}>
                <div className="flex items-center justify-between gap-3 px-1">
                  <div className="text-xs text-[hsl(var(--color-muted-foreground))]">
                    共 {group.items.length} 个关卡，合计 {totalCount} 次
                  </div>
                  <div className="min-w-0 flex-1 max-w-[12rem]">
                    <Input
                      placeholder="组内搜索"
                      value={groupSearch[key] ?? ""}
                      onChange={(e) =>
                        setGroupSearch((prev) => ({ ...prev, [key]: e.target.value }))
                      }
                      aria-label={`在 ${group.groupName} 中搜索关卡`}
                    />
                  </div>
                </div>
                <div className="space-y-2 mt-2">
                  {items.length === 0 && (
                    <div className="text-xs text-[hsl(var(--color-muted-foreground))] px-1">无匹配结果</div>
                  )}
                  {items.map(({ story, count }) => (
                    <div
                      key={story.storyId}
                      className="flex items-center justify-between rounded-lg border border-[hsl(var(--color-border))] bg-[hsl(var(--color-card))] p-3 shadow-sm"
                    >
                      <div className="min-w-0">
                        <div className="font-medium truncate">{story.storyName}</div>
                        <div className="text-xs text-[hsl(var(--color-muted-foreground))] truncate">
                          {story.storyCode || story.storyGroup}
                        </div>
                      </div>
                      <div className="flex items-center gap-3 ml-4">
                        <div className="text-xs tabular-nums text-[hsl(var(--color-muted-foreground))]">
                          {count} 次
                        </div>
                        <Button
                          size="sm"
                          className="min-h-[44px] px-4"
                          onClick={() => onOpenStory(story, selectedAgg.name)}
                        >
                          打开
                        </Button>
                      </div>
                    </div>
                  ))}
                </div>
              </Collapsible>
            );
          })}
            </div>
          )}
        </div>
      </CustomScrollArea>
    </div>
  );
}
