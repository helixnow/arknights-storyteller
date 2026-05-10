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

interface CharactersPanelProps {
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

interface GroupInfo {
  category: GroupCategory;
  groupName: string;
  groupOrder: number; // 用于排序章节/活动顺序
  storyOrder: number; // 用于组内排序（同主页）
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

export function CharactersPanel({ onOpenStory, onOpenStoryJump }: CharactersPanelProps) {
  const [loading, setLoading] = useState(true);
  const [progress, setProgress] = useState({ current: 0, total: 0 });
  const [error, setError] = useState<string | null>(null);
  const [aggregates, setAggregates] = useState<Map<string, CharacterAggregate>>(new Map());
  const [selected, setSelected] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const loadingRef = useRef(false);
  const [groupInfoByStoryId, setGroupInfoByStoryId] = useState<Map<string, GroupInfo>>(new Map());
  const [groupSearch, setGroupSearch] = useState<Record<string, string>>({});
  const [cacheUsed, setCacheUsed] = useState(false);
  const [cacheBuiltAt, setCacheBuiltAt] = useState<number | null>(null);
  const [version, setVersion] = useState<string | null>(null);
  const [quotes, setQuotes] = useState<CharacterQuote[]>([]);
  const [quoteCandidates, setQuoteCandidates] = useState<CharacterQuote[]>([]);
  const [loadingQuotes, setLoadingQuotes] = useState(false);
  const [quoteShuffleSeed, setQuoteShuffleSeed] = useState(0);
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
      const ver = await api.getCurrentVersion();
      setVersion(ver);

      // 使用主页同样的分组与排序数据源
      const [mainGrouped, activityGrouped, memoryStories] = await Promise.all([
        api.getMainStoriesGrouped(),
        api.getActivityStoriesGrouped(),
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
          groupOrder: idx, // 干员密录整体作为一组，这里顺序意义不大
          storyOrder: s.storySort,
        });
      });

      // 收集所有剧情条目并去重
      const storiesMap = new Map<string, StoryEntry>();
      mainGrouped.forEach(([, stories]) => stories.forEach((s) => storiesMap.set(s.storyId, s)));
      activityGrouped.forEach(([, stories]) => stories.forEach((s) => storiesMap.set(s.storyId, s)));
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
        } catch (e) {
          // ignore cache parsing errors
          console.warn("[CharactersPanel] 缓存读取失败，将重新构建", e);
        }
      }

      // 顺序加载，避免峰值占用过高；可根据需要增加并发
      if (!cacheApplied) {
        setCacheUsed(false);
        setCacheBuiltAt(null);
        // Concurrency pool: process N stories in parallel so first-start on
        // slow devices doesn't take minutes. Each story's aggregation still
        // runs on a single thread — we just overlap I/O and parse work.
        const POOL_SIZE = 6;
        let cursor = 0;
        let done = 0;
        const aggLock = { busy: false };
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
              const localCounts = countCharactersInStory(content);
              // Simple spin-lock via async boolean — aggregation is cheap.
              while (aggLock.busy) {
                await new Promise((r) => setTimeout(r, 0));
              }
              aggLock.busy = true;
              applyCounts(story, localCounts);
              aggLock.busy = false;
            } catch (e) {
              console.warn("[CharactersPanel] 读取剧情失败:", story.storyName, e);
            } finally {
              done += 1;
              setProgress({ current: done, total: stories.length });
            }
          }
        };
        await Promise.all(
          Array.from({ length: Math.min(POOL_SIZE, stories.length) }, () => worker())
        );
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
        } catch (e) {
          console.warn("[CharactersPanel] 写入缓存失败", e);
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "加载失败");
    } finally {
      setLoading(false);
      loadingRef.current = false;
    }
  }, [getCacheKey]);

  useEffect(() => {
    loadAll();
  }, [loadAll]);

  useEffect(() => {
    const handler = () => {
      loadAll({ forceRefresh: true }).catch((error) =>
        console.warn("[CharactersPanel] 刷新统计失败", error)
      );
    };
    window.addEventListener("app:refresh-character-stats", handler);
    return () => window.removeEventListener("app:refresh-character-stats", handler);
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
      setLoadingQuotes(false);
      return;
    }
    const runId = ++quotesRunRef.current;
    setLoadingQuotes(true);
    setQuotes([]);
    setQuoteCandidates([]);

    const perStory = selectedAgg.perStory;
    Promise.all(
      perStory.map(async ({ story }) => {
        try {
          const content = await api.getStoryContent(story.storyTxt);
          const hits: CharacterQuote[] = [];
          content.segments.forEach((seg, segmentIndex) => {
            if (seg.type === "dialogue" && seg.characterName === selected) {
              const text = seg.text.trim();
              // 过滤过短（通常无信息量）与过长（不适合当金句展示）的句子
              if (text.length >= 10 && text.length <= 160) {
                hits.push({ text, storyName: story.storyName, story, segmentIndex });
              }
            }
          });
          return hits;
        } catch {
          return [] as CharacterQuote[];
        }
      })
    )
      .then((all) => {
        if (runId !== quotesRunRef.current) return;
        const flat = all.flat();
        // 依长度降序取较大的候选池（最多 60 条），再在 UI 层随机抽 5 条
        flat.sort((a, b) => b.text.length - a.text.length);
        const pool = flat.slice(0, 60);
        setQuoteCandidates(pool);
        setQuoteShuffleSeed((s) => s + 1);
        setLoadingQuotes(false);
      })
      .catch(() => {
        if (runId !== quotesRunRef.current) return;
        setLoadingQuotes(false);
      });
  }, [selected, selectedAgg]);

  // 根据候选池与 shuffle 种子随机挑选 5 条作为展示金句
  useEffect(() => {
    if (quoteCandidates.length === 0) {
      setQuotes([]);
      return;
    }
    const pool = [...quoteCandidates];
    // Fisher–Yates 洗牌
    for (let i = pool.length - 1; i > 0; i -= 1) {
      const j = Math.floor(Math.random() * (i + 1));
      [pool[i], pool[j]] = [pool[j], pool[i]];
    }
    setQuotes(pool.slice(0, 5));
  }, [quoteCandidates, quoteShuffleSeed]);

  const handleShuffleQuotes = useCallback(() => {
    setQuoteShuffleSeed((s) => s + 1);
  }, []);

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
        <h1 className="text-base font-semibold">
          {selected ? `人物：${selected}` : "人物统计"}
        </h1>
        {!selected && (
          <>
            <div className="ml-auto w-56">
              <Input placeholder="搜索人物" value={search} onChange={(e) => setSearch(e.target.value)} />
            </div>
          </>
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
                正在统计人物发言… {progress.current}/{progress.total}
              </span>
            </div>
          )}
          {error && (
            <div className="text-sm text-[hsl(var(--color-destructive))]">{error}</div>
          )}

          {!loading && !selected && (
            <div className="text-xs text-[hsl(var(--color-muted-foreground))]">
              {cacheUsed && cacheBuiltAt
                ? `已使用缓存，构建于 ${new Date(cacheBuiltAt).toLocaleString()}`
                : version
                ? `未使用缓存（版本 ${version}）`
                : null}
            </div>
          )}

          {!selected && (
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
              {!loading && filteredCharacters.length === 0 && (
                <div className="col-span-full text-sm text-[hsl(var(--color-muted-foreground))]">
                  未找到匹配人物
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

              {loadingQuotes && (
                <div
                  className="rounded-lg border border-[hsl(var(--color-border))] bg-[hsl(var(--color-card))] p-4 space-y-2"
                  style={{ minHeight: 80 }}
                >
                  <div className="h-3 w-24 rounded bg-[hsl(var(--color-secondary))] animate-pulse" />
                  <div className="h-3 w-full rounded bg-[hsl(var(--color-secondary))] animate-pulse" />
                  <div className="h-3 w-3/4 rounded bg-[hsl(var(--color-secondary))] animate-pulse" />
                </div>
              )}

              {!loadingQuotes && quotes.length > 0 && (
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
                        className="h-7 px-2 text-xs text-[hsl(var(--color-muted-foreground))]"
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
                      className="relative block w-full pl-6 pr-2 py-1 text-left text-sm leading-relaxed text-[hsl(var(--color-foreground))] rounded-md transition-colors hover:bg-[hsl(var(--color-secondary))] focus:outline-none focus-visible:ring-2 focus-visible:ring-[hsl(var(--color-ring))]"
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
                  <div className="w-48">
                    <Input
                      placeholder="组内搜索"
                      value={groupSearch[key] ?? ""}
                      onChange={(e) =>
                        setGroupSearch((prev) => ({ ...prev, [key]: e.target.value }))
                      }
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
                        <div className="text-xs text-[hsl(var(--color-muted-foreground))]">{count} 次</div>
                        <Button size="sm" onClick={() => onOpenStory(story, selectedAgg.name)}>
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
