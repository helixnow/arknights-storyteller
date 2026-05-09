import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "@/services/api";
import type {
  SearchResult,
  SearchResultsPage,
  StoryEntry,
  StoryIndexStatus,
} from "@/types/story";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Search, X, Filter } from "lucide-react";
import { CustomScrollArea } from "@/components/ui/custom-scroll-area";
import { cn } from "@/lib/utils";
import { useToast } from "@/components/ui/toast";

interface SearchPanelProps {
  onSelectResult: (story: StoryEntry, focus: { query: string; snippet?: string | null }) => void;
}

interface CachedPage {
  page: SearchResultsPage;
  updatedAt: number;
  version: string;
}

const HISTORY_KEY = "arknights-story-search-history";
const CACHE_KEY = "arknights-story-search-cache-v2";
const DEBUG_STATE_KEY = "arknights-story-search-debug";

/** Wrap matched terms in the text with <mark> for visible highlight. */
function highlightMatches(text: string, query: string): React.ReactNode {
  if (!text || !query.trim()) return text;
  const terms = query
    .trim()
    .split(/\s+/)
    .flatMap((t) => {
      const stripped = t.replace(/^-/, "").replace(/^or$/i, "");
      if (!stripped) return [];
      // For pure-CJK short terms, also highlight each single character so the
      // user can see which characters matched when searching phrases like
      // "凯尔希" (bigram-expanded on the backend).
      const isAllCjk = /^[\u4e00-\u9fff\u3400-\u4dbf]+$/.test(stripped);
      if (isAllCjk && stripped.length >= 4) {
        return [stripped, ...stripped.split("")];
      }
      return [stripped];
    })
    .filter(Boolean);
  if (terms.length === 0) return text;
  const escaped = terms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const pattern = new RegExp(`(${escaped.join("|")})`, "gi");
  const parts = text.split(pattern);
  return parts.map((part, i) =>
    pattern.test(part) ? (
      <mark
        key={i}
        className="bg-[hsl(var(--color-primary)/0.25)] text-[hsl(var(--color-foreground))] rounded-sm px-0.5"
      >
        {part}
      </mark>
    ) : (
      <span key={i}>{part}</span>
    )
  );
}

export function SearchPanel({ onSelectResult }: SearchPanelProps) {
  const [query, setQuery] = useState("");
  const [page, setPage] = useState<SearchResultsPage | null>(null);
  const [searching, setSearching] = useState(false);
  const [searched, setSearched] = useState(false);
  const [indexStatus, setIndexStatus] = useState<StoryIndexStatus | null>(null);
  const [buildingIndex, setBuildingIndex] = useState(false);
  const [indexError, setIndexError] = useState<string | null>(null);
  const [indexMessage, setIndexMessage] = useState<string | null>(null);
  const [debugMode, setDebugMode] = useState<boolean>(() => {
    try {
      return localStorage.getItem(DEBUG_STATE_KEY) === "1";
    } catch {
      return false;
    }
  });
  const [debugLogs, setDebugLogs] = useState<string[]>([]);
  const [debugExpanded, setDebugExpanded] = useState(false);
  const [openingStoryId, setOpeningStoryId] = useState<string | null>(null);
  const [progress, setProgress] = useState<{
    phase: string;
    current: number;
    total: number;
    message: string;
  } | null>(null);
  const [indexProgress, setIndexProgress] = useState<{
    phase: string;
    current: number;
    total: number;
    message: string;
  } | null>(null);
  const progressUnlistenRef = useRef<null | (() => void)>(null);
  const indexProgressUnlistenRef = useRef<null | (() => void)>(null);
  const [history, setHistory] = useState<string[]>([]);
  const [cache, setCache] = useState<Record<string, CachedPage>>({});
  const [fromCache, setFromCache] = useState<{ used: boolean; updatedAt?: number }>({
    used: false,
  });
  const [activeFacet, setActiveFacet] = useState<string | null>(null);
  const [version, setVersion] = useState<string>("");
  const toast = useToast();

  // Load version for cache keying.
  useEffect(() => {
    void api
      .getCurrentVersion()
      .then((v) => setVersion(v))
      .catch(() => setVersion(""));
  }, []);

  const saveHistory = useCallback((q: string) => {
    const prevRaw = localStorage.getItem(HISTORY_KEY);
    const prev: string[] = prevRaw ? JSON.parse(prevRaw) : [];
    const next = [q, ...prev.filter((s) => s !== q)].slice(0, 10);
    localStorage.setItem(HISTORY_KEY, JSON.stringify(next));
    setHistory(next);
  }, []);

  const removeHistory = useCallback((q: string) => {
    const next = history.filter((s) => s !== q);
    setHistory(next);
    localStorage.setItem(HISTORY_KEY, JSON.stringify(next));
  }, [history]);

  const handleSearch = async (opts?: { forceRefresh?: boolean; queryOverride?: string }) => {
    const raw = (opts?.queryOverride ?? query).trim();
    if (!raw) return;

    try {
      setSearching(true);
      setProgress({ phase: "准备", current: 0, total: 1, message: "" });
      if (!progressUnlistenRef.current) {
        const unlisten = await api.onSearchProgress((p) => setProgress(p));
        progressUnlistenRef.current = () => {
          (unlisten as unknown as () => void)();
        };
      }

      if (!opts?.forceRefresh && !debugMode) {
        const cached = cache[raw];
        if (cached && cached.version === version) {
          setPage(cached.page);
          setSearched(true);
          setFromCache({ used: true, updatedAt: cached.updatedAt });
          setSearching(false);
          setProgress(null);
          setActiveFacet(null);
          saveHistory(raw);
          return;
        }
      }

      if (debugMode) {
        const data = await api.searchStoriesDebug(raw);
        setPage({
          results: data.results,
          totalMatched: data.results.length,
          truncated: false,
          facets: {},
        });
        setDebugLogs(data.logs);
        setDebugExpanded(true);
      } else {
        const data = await api.searchStoriesEx(raw);
        setPage(data);
        setDebugLogs([]);
        setDebugExpanded(false);
        const updatedAt = Date.now();
        const nextCache = { ...cache, [raw]: { page: data, updatedAt, version } };
        setCache(nextCache);
        try {
          localStorage.setItem(CACHE_KEY, JSON.stringify(nextCache));
        } catch {
          // storage quota — ignore
        }
        setFromCache({ used: false });
      }
      setSearched(true);
      setActiveFacet(null);
      saveHistory(raw);
    } catch (err) {
      console.error("Search failed:", err);
      toast.error("搜索失败，请重试");
    } finally {
      setSearching(false);
      setTimeout(() => setProgress(null), 400);
    }
  };

  const openResult = async (result: SearchResult) => {
    try {
      setOpeningStoryId(result.storyId);
      const story = await api.getStoryEntry(result.storyId);
      onSelectResult(story, { query, snippet: result.matchedText });
    } catch (err) {
      console.error("Open story failed:", err);
      toast.error("打开剧情失败");
    } finally {
      setOpeningStoryId(null);
    }
  };

  const handleKeyPress = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      handleSearch();
    }
  };

  const clearSearch = () => {
    setQuery("");
    setPage(null);
    setSearched(false);
    setDebugLogs([]);
    setDebugExpanded(false);
    setOpeningStoryId(null);
    setActiveFacet(null);
  };

  const refreshIndexStatus = useCallback(async () => {
    try {
      const status = await api.getStoryIndexStatus();
      setIndexStatus(status);
      setIndexError(null);
    } catch (err) {
      console.error("Failed to fetch index status:", err);
      setIndexError("获取索引状态失败");
    }
  }, []);

  const handleBuildIndex = useCallback(async () => {
    setIndexError(null);
    setIndexMessage(null);
    setIndexProgress({ phase: "准备", current: 0, total: 1, message: "" });
    try {
      if (!indexProgressUnlistenRef.current) {
        const unlisten = await api.onIndexProgress((p) => setIndexProgress(p));
        indexProgressUnlistenRef.current = () => (unlisten as unknown as () => void)();
      }
      setBuildingIndex(true);
      await api.buildStoryIndex();
      await refreshIndexStatus();
      setIndexMessage("全文索引建立完成");
      toast.success("全文索引建立完成");
    } catch (err) {
      console.error("Build index failed:", err);
      setIndexError("建立索引失败，请重试");
      toast.error("建立索引失败");
    } finally {
      setBuildingIndex(false);
      setTimeout(() => setIndexProgress(null), 500);
    }
  }, [refreshIndexStatus, toast]);

  useEffect(() => {
    void refreshIndexStatus();
    try {
      const raw = localStorage.getItem(HISTORY_KEY);
      setHistory(raw ? JSON.parse(raw) : []);
      const cacheRaw = localStorage.getItem(CACHE_KEY);
      setCache(cacheRaw ? JSON.parse(cacheRaw) : {});
    } catch {
      /* ignore */
    }
    return () => {
      if (progressUnlistenRef.current) {
        progressUnlistenRef.current();
        progressUnlistenRef.current = null;
      }
      if (indexProgressUnlistenRef.current) {
        indexProgressUnlistenRef.current();
        indexProgressUnlistenRef.current = null;
      }
    };
  }, [refreshIndexStatus]);

  useEffect(() => {
    try {
      localStorage.setItem(DEBUG_STATE_KEY, debugMode ? "1" : "0");
    } catch {
      /* ignore */
    }
  }, [debugMode]);

  useEffect(() => {
    const handler = () => {
      void handleBuildIndex();
    };
    window.addEventListener("app:rebuild-story-index", handler);
    return () => window.removeEventListener("app:rebuild-story-index", handler);
  }, [handleBuildIndex]);

  const visibleResults = useMemo(() => {
    if (!page) return [] as SearchResult[];
    if (!activeFacet) return page.results;
    return page.results.filter((r) => r.category === activeFacet);
  }, [page, activeFacet]);

  const renderIndexStatusText = () => {
    if (!indexStatus) return "索引状态获取中...";
    if (!indexStatus.ready) {
      return "全文索引尚未建立，当前使用逐条扫描，建议先建立索引以提升搜索速度。";
    }
    let extra = "";
    if (indexStatus.lastBuiltAt) {
      const date = new Date(indexStatus.lastBuiltAt * 1000);
      extra = `，更新于 ${date.toLocaleString()}`;
    }
    return `全文索引已建立，共 ${indexStatus.total} 篇${extra}`;
  };

  return (
    <div className="h-full flex flex-col overflow-hidden">
      {/* 搜索栏 */}
      <header className="flex-shrink-0 z-10 bg-[hsl(var(--color-background)/0.95)] backdrop-blur border-b motion-safe:animate-in motion-safe:fade-in-0 motion-safe:duration-500">
        <div className="container py-4">
          <div className="flex items-center gap-2">
            <div className="relative flex-1">
              <Input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyPress={handleKeyPress}
                placeholder="搜索剧情名称或内容..."
                className="pr-8"
                aria-label="搜索剧情"
              />
              {query && (
                <button
                  onClick={clearSearch}
                  aria-label="清空搜索"
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-[hsl(var(--color-muted-foreground))] hover:text-[hsl(var(--color-foreground))]"
                >
                  <X className="h-4 w-4" />
                </button>
              )}
            </div>
            <Button onClick={() => handleSearch()} disabled={searching || !query.trim()}>
              <Search className="mr-2 h-4 w-4" />
              搜索
            </Button>
          </div>

          {history.length > 0 && !searched && (
            <div className="mt-3 space-y-2">
              <div className="text-xs text-[hsl(var(--color-muted-foreground))]">历史搜索</div>
              <div className="flex flex-wrap items-center gap-2">
                {history.slice(0, 10).map((h) => (
                  <div
                    key={h}
                    className="flex items-center gap-1 border rounded-full pl-3 pr-1 py-0.5"
                  >
                    <button
                      className="text-xs text-[hsl(var(--color-foreground))]"
                      onClick={() => {
                        setQuery(h);
                        setTimeout(() => handleSearch({ queryOverride: h }), 0);
                      }}
                    >
                      {h}
                    </button>
                    <button
                      className="inline-flex h-5 w-5 items-center justify-center rounded-full text-[hsl(var(--color-muted-foreground))] hover:bg-[hsl(var(--color-accent))]"
                      onClick={() => removeHistory(h)}
                      aria-label={`删除历史记录：${h}`}
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </div>
                ))}
                <button
                  className="ml-1 text-xs text-[hsl(var(--color-muted-foreground))] underline hover:text-[hsl(var(--color-foreground))]"
                  onClick={() => {
                    localStorage.removeItem(HISTORY_KEY);
                    setHistory([]);
                  }}
                >
                  清空历史
                </button>
              </div>
            </div>
          )}

          <div className="mt-3 flex flex-wrap items-start gap-3">
            <div className="text-xs text-[hsl(var(--color-muted-foreground))] flex-1 min-w-[12rem]">
              {buildingIndex
                ? indexProgress
                  ? `${indexProgress.phase} ${indexProgress.current}/${indexProgress.total}${indexProgress.message ? ` · ${indexProgress.message}` : ""}`
                  : "索引建立中，请稍候…"
                : renderIndexStatusText()}
            </div>
            <div className="flex items-center gap-2">
              <Button
                variant={debugMode ? "default" : "outline"}
                size="sm"
                onClick={() => {
                  setDebugMode((prev) => !prev);
                  setDebugLogs([]);
                  setDebugExpanded(false);
                }}
              >
                调试日志
              </Button>
            </div>
          </div>

          {buildingIndex && indexProgress && indexProgress.total > 0 && (
            <div className="mt-2 h-1 w-full overflow-hidden rounded-full bg-[hsl(var(--color-secondary))]">
              <div
                className="h-full bg-[hsl(var(--color-primary))] transition-all duration-200"
                style={{
                  width: `${Math.min((indexProgress.current / indexProgress.total) * 100, 100)}%`,
                }}
              />
            </div>
          )}

          {fromCache.used && (
            <div className="mt-2 text-xs text-[hsl(var(--color-muted-foreground))]">
              已从缓存恢复，更新于{" "}
              {fromCache.updatedAt ? new Date(fromCache.updatedAt).toLocaleString() : "-"}
              <button
                className="ml-2 underline hover:text-[hsl(var(--color-foreground))]"
                onClick={() => handleSearch({ forceRefresh: true })}
              >
                刷新缓存
              </button>
            </div>
          )}
          {indexError && (
            <div className="mt-2 text-xs text-[hsl(var(--color-destructive))]">{indexError}</div>
          )}
          {indexMessage && (
            <div className="mt-2 text-xs text-[hsl(var(--color-muted-foreground))]">{indexMessage}</div>
          )}

          {debugMode && debugLogs.length > 0 && (
            <div className="mt-3 border rounded-lg bg-[hsl(var(--color-muted)/0.1)]">
              <button
                onClick={() => setDebugExpanded((prev) => !prev)}
                className="w-full px-3 py-2 text-xs text-left font-medium flex items-center justify-between"
              >
                <span>调试记录（{debugLogs.length} 条）</span>
                <span>{debugExpanded ? "收起" : "展开"}</span>
              </button>
              {debugExpanded && (
                <div className="max-h-48 overflow-auto border-t text-[11px] leading-relaxed font-mono px-3 py-2 space-y-1">
                  {debugLogs.map((log, index) => (
                    <div key={index}>{log}</div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* 搜索中实时进度条 */}
          {searching && progress && (
            <div className="mt-3 space-y-1">
              <div className="flex items-center justify-between text-[11px] text-[hsl(var(--color-muted-foreground))]">
                <span>{progress.phase}</span>
                <span className="font-mono">
                  {progress.current}/{progress.total}
                </span>
              </div>
              <div className="h-1 w-full overflow-hidden rounded-full bg-[hsl(var(--color-secondary))]">
                <div
                  className="h-full bg-[hsl(var(--color-primary))] transition-all duration-200"
                  style={{
                    width:
                      progress.total > 0
                        ? `${Math.min((progress.current / progress.total) * 100, 100)}%`
                        : "25%",
                  }}
                />
              </div>
            </div>
          )}

          {/* 分类 facet 过滤 */}
          {page && page.results.length > 0 && Object.keys(page.facets).length > 1 && (
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <Filter className="h-3.5 w-3.5 text-[hsl(var(--color-muted-foreground))]" />
              <button
                onClick={() => setActiveFacet(null)}
                className={cn(
                  "rounded-full border px-3 py-0.5 text-xs transition-colors",
                  activeFacet === null
                    ? "bg-[hsl(var(--color-primary))] text-[hsl(var(--color-primary-foreground))] border-transparent"
                    : "border-[hsl(var(--color-border))] text-[hsl(var(--color-muted-foreground))]"
                )}
              >
                全部 {page.results.length}
              </button>
              {Object.entries(page.facets)
                .sort((a, b) => b[1] - a[1])
                .map(([facet, count]) => (
                  <button
                    key={facet}
                    onClick={() => setActiveFacet(facet === activeFacet ? null : facet)}
                    className={cn(
                      "rounded-full border px-3 py-0.5 text-xs transition-colors",
                      facet === activeFacet
                        ? "bg-[hsl(var(--color-primary))] text-[hsl(var(--color-primary-foreground))] border-transparent"
                        : "border-[hsl(var(--color-border))] text-[hsl(var(--color-muted-foreground))]"
                    )}
                  >
                    {facet.split(" | ")[0]} {count}
                  </button>
                ))}
            </div>
          )}
        </div>
      </header>

      {/* 搜索结果 */}
      <main className="flex-1 overflow-hidden">
        <CustomScrollArea
          className="h-full"
          viewportClassName="reader-scroll"
          trackOffsetTop="calc(3.5rem + 10px)"
          trackOffsetBottom="calc(4.5rem + env(safe-area-inset-bottom, 0px))"
        >
          <div className="container py-6 pb-24 motion-safe:animate-in motion-safe:fade-in-0 motion-safe:duration-700">
            {searching && !page && (
              <div className="text-center text-[hsl(var(--color-muted-foreground))]">
                {progress ? `${progress.phase} ${progress.current}/${progress.total}` : "搜索中..."}
              </div>
            )}

            {!searching && searched && page && page.results.length === 0 && (
              <div className="text-center text-[hsl(var(--color-muted-foreground))]">
                未找到相关剧情
              </div>
            )}

            {!searching && page && page.results.length > 0 && (
              <div className="space-y-3">
                <div className="flex items-center justify-between text-sm text-[hsl(var(--color-muted-foreground))]">
                  <span>
                    {activeFacet
                      ? `「${activeFacet.split(" | ")[0]}」 ${visibleResults.length} 条`
                      : `共 ${page.totalMatched} 条匹配`}
                  </span>
                  {page.truncated && (
                    <span className="text-xs">
                      已显示 {page.results.length} / {page.totalMatched}，缩小关键词可获得更精确结果
                    </span>
                  )}
                </div>
                {visibleResults.map((result, index) => (
                  <button
                    key={`${result.storyId}-${index}`}
                    onClick={() => openResult(result)}
                    disabled={openingStoryId === result.storyId}
                    className="w-full p-4 rounded-lg border border-[hsl(var(--color-border))] hover:bg-[hsl(var(--color-accent))] transition-all duration-200 text-left hover:-translate-y-0.5 motion-safe:animate-in motion-safe:fade-in-0 disabled:opacity-60 disabled:cursor-wait"
                    style={{ animationDelay: `${Math.min(index, 10) * 40}ms` }}
                  >
                    <div className="font-medium mb-1">
                      {highlightMatches(result.storyName, query)}
                      {openingStoryId === result.storyId && (
                        <span className="ml-2 text-xs text-[hsl(var(--color-muted-foreground))]">
                          打开中...
                        </span>
                      )}
                    </div>
                    <div className="text-xs text-[hsl(var(--color-muted-foreground))] mb-2">
                      {result.category}
                    </div>
                    {result.matchedText && (
                      <div className="text-sm text-[hsl(var(--color-muted-foreground))] line-clamp-2">
                        {highlightMatches(result.matchedText, query)}
                      </div>
                    )}
                  </button>
                ))}
              </div>
            )}

            {!searching && !searched && (
              <div className="text-center text-[hsl(var(--color-muted-foreground))]">
                输入关键词搜索剧情，支持空格 AND、`OR`、`-排除词`、引号短语
              </div>
            )}
          </div>
        </CustomScrollArea>
      </main>
    </div>
  );
}
