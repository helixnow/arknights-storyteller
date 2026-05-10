import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/services/api";
import type {
  SearchResult,
  SearchResultsPage,
  SegmentHit,
  SegmentSearchPage,
  StoryEntry,
  StoryIndexStatus,
} from "@/types/story";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Search, X, BookOpen, MessageSquare, MoreHorizontal } from "lucide-react";
import { CustomScrollArea } from "@/components/ui/custom-scroll-area";
import { cn } from "@/lib/utils";
import { useToast } from "@/components/ui/toast";

type SearchMode = "story" | "segment";

interface SearchPanelProps {
  onSelectResult: (story: StoryEntry, focus: { query: string; snippet?: string | null }) => void;
  onSelectSegment: (
    story: StoryEntry,
    jump: { segmentIndex: number; preview?: string; query: string }
  ) => void;
}

interface CachedPage {
  page: SearchResultsPage;
  updatedAt: number;
  version: string;
}

interface CachedSegmentPage {
  page: SegmentSearchPage;
  updatedAt: number;
  version: string;
}

const HISTORY_KEY = "arknights-story-search-history";
const CACHE_KEY = "arknights-story-search-cache-v2";
const SEGMENT_CACHE_KEY = "arknights-story-segment-cache-v1";
const DEBUG_STATE_KEY = "arknights-story-search-debug";
const SEARCH_MODE_KEY = "arknights-story-search-mode";

const SEGMENT_TYPE_LABEL: Record<SegmentHit["segmentType"], string> = {
  dialogue: "对话",
  narration: "旁白",
  system: "系统",
  subtitle: "字幕",
  sticker: "标语",
  header: "标题",
  decision: "抉择",
};

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

export function SearchPanel({ onSelectResult, onSelectSegment }: SearchPanelProps) {
  const [query, setQuery] = useState("");
  const [mode, setMode] = useState<SearchMode>(() => {
    try {
      const stored = localStorage.getItem(SEARCH_MODE_KEY);
      return stored === "segment" ? "segment" : "story";
    } catch {
      return "story";
    }
  });
  const [page, setPage] = useState<SearchResultsPage | null>(null);
  const [segmentPage, setSegmentPage] = useState<SegmentSearchPage | null>(null);
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
  const [segmentCache, setSegmentCache] = useState<Record<string, CachedSegmentPage>>({});
  const [fromCache, setFromCache] = useState<{ used: boolean; updatedAt?: number }>({
    used: false,
  });
  const [version, setVersion] = useState<string>("");
  const [moreOpen, setMoreOpen] = useState(false);
  const moreMenuRef = useRef<HTMLDivElement | null>(null);
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

      if (mode === "segment") {
        if (!opts?.forceRefresh) {
          const cached = segmentCache[raw];
          if (cached && cached.version === version) {
            setSegmentPage(cached.page);
            setPage(null);
            setSearched(true);
            setFromCache({ used: true, updatedAt: cached.updatedAt });
            setSearching(false);
            setProgress(null);
            saveHistory(raw);
            return;
          }
        }
        const data = await api.searchSegments(raw);
        setSegmentPage(data);
        setPage(null);
        const updatedAt = Date.now();
        const nextCache = { ...segmentCache, [raw]: { page: data, updatedAt, version } };
        setSegmentCache(nextCache);
        try {
          localStorage.setItem(SEGMENT_CACHE_KEY, JSON.stringify(nextCache));
        } catch {
          /* ignore */
        }
        setFromCache({ used: false });
        setSearched(true);
        saveHistory(raw);
        if (data.hits.length === 0 && indexStatus?.ready) {
          toast.warn("段级索引暂无命中，已自动落回整篇搜索", 2500);
          setMode("story");
        }
        return;
      }

      if (!opts?.forceRefresh && !debugMode) {
        const cached = cache[raw];
        if (cached && cached.version === version) {
          setPage(cached.page);
          setSegmentPage(null);
          setSearched(true);
          setFromCache({ used: true, updatedAt: cached.updatedAt });
          setSearching(false);
          setProgress(null);
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
        setSegmentPage(null);
        setDebugLogs(data.logs);
        setDebugExpanded(true);
      } else {
        const data = await api.searchStoriesEx(raw);
        setPage(data);
        setSegmentPage(null);
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

  const openSegment = async (hit: SegmentHit) => {
    try {
      setOpeningStoryId(hit.storyId);
      const story = await api.getStoryEntry(hit.storyId);
      // Title-level hits synthesised from the story-name index shouldn't
      // pulse-highlight a fake first paragraph — the match isn't actually
      // at that segment. Open the story plainly instead, letting the
      // reader restore the user's last reading progress. Pass empty
      // query/snippet so the reader skips focus search too — otherwise
      // searching a story title might accidentally highlight some
      // unrelated body segment that happens to contain the same word.
      if (hit.matchTarget === "title") {
        onSelectResult(story, { query: "", snippet: null });
      } else {
        onSelectSegment(story, {
          segmentIndex: hit.segmentIndex,
          preview: hit.matchedText,
          query,
        });
      }
    } catch (err) {
      console.error("Open segment failed:", err);
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
    setSegmentPage(null);
    setSearched(false);
    setDebugLogs([]);
    setDebugExpanded(false);
    setOpeningStoryId(null);
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
      const segCacheRaw = localStorage.getItem(SEGMENT_CACHE_KEY);
      setSegmentCache(segCacheRaw ? JSON.parse(segCacheRaw) : {});
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

  // 自动索引 hook 重建完成后会派发 `app:story-index-updated`；这里监听
  // 一下把状态条刷成"已就绪"，不用再等用户手动切页。
  useEffect(() => {
    const handler = () => {
      void refreshIndexStatus();
    };
    window.addEventListener("app:story-index-updated", handler);
    return () => window.removeEventListener("app:story-index-updated", handler);
  }, [refreshIndexStatus]);

  // 同时监听后端的 index-progress 事件：sync_data / import_zip 完成后
  // 后端会自行在线程里重建索引并 emit 进度，这里收到"完成"阶段时顺带
  // 刷新一下状态条，保持和自动索引逻辑一致。
  useEffect(() => {
    let dispose: (() => void) | null = null;
    let cancelled = false;
    void api
      .onIndexProgress((p) => {
        if (cancelled) return;
        setIndexProgress(p);
        if (p.total > 0 && p.current >= p.total) {
          void refreshIndexStatus();
        }
      })
      .then((unlisten) => {
        if (cancelled) {
          (unlisten as unknown as () => void)();
          return;
        }
        dispose = () => (unlisten as unknown as () => void)();
      });
    return () => {
      cancelled = true;
      if (dispose) dispose();
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
    try {
      localStorage.setItem(SEARCH_MODE_KEY, mode);
    } catch {
      /* ignore */
    }
  }, [mode]);

  useEffect(() => {
    const handler = () => {
      void handleBuildIndex();
    };
    window.addEventListener("app:rebuild-story-index", handler);
    return () => window.removeEventListener("app:rebuild-story-index", handler);
  }, [handleBuildIndex]);

  // Close the ⋯ popover on outside click or Escape.
  useEffect(() => {
    if (!moreOpen) return;
    const onDocClick = (e: MouseEvent) => {
      if (!moreMenuRef.current) return;
      if (!moreMenuRef.current.contains(e.target as Node)) {
        setMoreOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMoreOpen(false);
    };
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [moreOpen]);

  const renderIndexStatusRow = () => {
    if (!indexStatus) {
      return (
        <div className="text-xs text-[hsl(var(--color-muted-foreground))]">索引状态获取中...</div>
      );
    }
    if (buildingIndex) {
      return (
        <div className="text-xs text-[hsl(var(--color-muted-foreground))]">
          {indexProgress
            ? `${indexProgress.phase} ${indexProgress.current}/${indexProgress.total}${indexProgress.message ? ` · ${indexProgress.message}` : ""}`
            : "索引建立中，请稍候…"}
        </div>
      );
    }
    if (!indexStatus.ready) {
      return (
        <div className="text-xs text-[hsl(var(--color-muted-foreground))]">
          全文索引正在后台准备中，首次进入或更新数据后可能稍慢，稍候片刻即可使用高速搜索。
        </div>
      );
    }
    return (
      <div className="flex items-center justify-between gap-2">
        <div className="text-xs text-[hsl(var(--color-muted-foreground))]">
          索引已就绪 · {indexStatus.total} 篇
        </div>
        <button
          type="button"
          onClick={() => void handleBuildIndex()}
          disabled={buildingIndex}
          className="text-xs text-[hsl(var(--color-muted-foreground))] underline hover:text-[hsl(var(--color-foreground))] disabled:opacity-50"
        >
          重建
        </button>
      </div>
    );
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
            <div className="relative" ref={moreMenuRef}>
              <Button
                variant="outline"
                size="icon"
                aria-label="更多"
                aria-haspopup="menu"
                aria-expanded={moreOpen}
                onClick={() => setMoreOpen((prev) => !prev)}
              >
                <MoreHorizontal className="h-4 w-4" />
              </Button>
              {moreOpen && (
                <div
                  role="menu"
                  className="absolute right-0 top-full z-20 mt-1 w-56 rounded-md border border-[hsl(var(--color-border))] bg-[hsl(var(--color-background))] shadow-lg p-1 motion-safe:animate-in motion-safe:fade-in-0 motion-safe:zoom-in-95 motion-safe:duration-150"
                >
                  <label className="flex items-center justify-between gap-3 rounded-sm px-2 py-2 text-sm cursor-pointer hover:bg-[hsl(var(--color-accent))]">
                    <span className="flex flex-col">
                      <span>调试日志</span>
                      <span className="text-[11px] text-[hsl(var(--color-muted-foreground))]">
                        显示匹配过程记录
                      </span>
                    </span>
                    <input
                      type="checkbox"
                      checked={debugMode}
                      onChange={() => {
                        setDebugMode((prev) => !prev);
                        setDebugLogs([]);
                        setDebugExpanded(false);
                      }}
                      className="h-4 w-4 accent-[hsl(var(--color-primary))]"
                    />
                  </label>
                  <div className="my-1 h-px bg-[hsl(var(--color-border))]" />
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setMoreOpen(false);
                      void handleBuildIndex();
                    }}
                    disabled={buildingIndex}
                    className="w-full rounded-sm px-2 py-2 text-left text-sm hover:bg-[hsl(var(--color-accent))] disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    <div>刷新索引</div>
                    <div className="text-[11px] text-[hsl(var(--color-muted-foreground))]">
                      {indexStatus?.ready ? "重新建立全文索引" : "建立全文索引"}
                    </div>
                  </button>
                </div>
              )}
            </div>
          </div>

          {/* 搜索模式切换：整篇 vs 段落 */}
          <div className="mt-3 inline-flex rounded-full border border-[hsl(var(--color-border))] p-0.5">
            <button
              type="button"
              aria-pressed={mode === "story"}
              onClick={() => setMode("story")}
              className={cn(
                "flex items-center gap-1 rounded-full px-3 py-1 text-xs transition-colors",
                mode === "story"
                  ? "bg-[hsl(var(--color-primary))] text-[hsl(var(--color-primary-foreground))]"
                  : "text-[hsl(var(--color-muted-foreground))] hover:text-[hsl(var(--color-foreground))]"
              )}
            >
              <BookOpen className="h-3.5 w-3.5" />
              整篇
            </button>
            <button
              type="button"
              aria-pressed={mode === "segment"}
              onClick={() => setMode("segment")}
              className={cn(
                "flex items-center gap-1 rounded-full px-3 py-1 text-xs transition-colors",
                mode === "segment"
                  ? "bg-[hsl(var(--color-primary))] text-[hsl(var(--color-primary-foreground))]"
                  : "text-[hsl(var(--color-muted-foreground))] hover:text-[hsl(var(--color-foreground))]"
              )}
            >
              <MessageSquare className="h-3.5 w-3.5" />
              段落
            </button>
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

          <div className="mt-3">{renderIndexStatusRow()}</div>

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
              <div className="text-right text-[11px] text-[hsl(var(--color-muted-foreground))] font-mono">
                {progress.phase} {progress.current}/{progress.total}
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
            {searching && !page && !segmentPage && (
              <div className="text-center text-[hsl(var(--color-muted-foreground))]">
                {progress ? `${progress.phase} ${progress.current}/${progress.total}` : "搜索中..."}
              </div>
            )}

            {/* 段落模式结果 */}
            {!searching && mode === "segment" && segmentPage && segmentPage.hits.length === 0 && searched && (
              <div className="text-center text-[hsl(var(--color-muted-foreground))]">
                未找到包含该关键词的段落
              </div>
            )}
            {!searching && mode === "segment" && segmentPage && segmentPage.hits.length > 0 && (
              <div className="space-y-3">
                <div className="flex items-center justify-between text-sm text-[hsl(var(--color-muted-foreground))]">
                  <span>共 {segmentPage.totalMatched} 段命中</span>
                  {segmentPage.truncated && (
                    <span className="text-xs">
                      已显示 {segmentPage.hits.length} / {segmentPage.totalMatched}，缩小关键词可获得更精确结果
                    </span>
                  )}
                </div>
                {segmentPage.hits.map((hit, index) => {
                  const speakerOnly = hit.matchTarget === "speaker";
                  const titleOnly = hit.matchTarget === "title";
                  return (
                  <button
                    key={`${hit.storyId}-${hit.segmentIndex}-${index}`}
                    onClick={() => openSegment(hit)}
                    disabled={openingStoryId === hit.storyId}
                    className="w-full p-4 rounded-lg border border-[hsl(var(--color-border))] hover:bg-[hsl(var(--color-accent))] transition-all duration-200 text-left hover:-translate-y-0.5 motion-safe:animate-in motion-safe:fade-in-0 disabled:opacity-60 disabled:cursor-wait"
                    style={{ animationDelay: `${Math.min(index, 10) * 40}ms` }}
                  >
                    <div className="flex items-baseline justify-between gap-2 mb-1">
                      <div className="font-medium truncate">
                        {highlightMatches(hit.storyName, query)}
                      </div>
                      <span className="flex-shrink-0 text-[10px] uppercase tracking-widest text-[hsl(var(--color-muted-foreground))]">
                        {SEGMENT_TYPE_LABEL[hit.segmentType] ?? hit.segmentType}
                        {" · #"}
                        {hit.segmentIndex}
                      </span>
                    </div>
                    <div className="flex flex-wrap items-center gap-2 text-xs text-[hsl(var(--color-muted-foreground))] mb-2">
                      <span className="truncate">{hit.category}</span>
                      {hit.characterName && (
                        <span
                          className={cn(
                            "inline-flex items-center rounded-full border px-2 py-0.5 text-[11px]",
                            speakerOnly
                              ? "border-[hsl(var(--color-primary)/0.5)] bg-[hsl(var(--color-primary)/0.1)] text-[hsl(var(--color-foreground))]"
                              : "border-[hsl(var(--color-border))]"
                          )}
                        >
                          {/* When the badge itself already calls out the
                              speaker as the reason the row matched, skip
                              the term highlight inside the chip — a double
                              visual accent muddies the card. */}
                          {speakerOnly ? hit.characterName : highlightMatches(hit.characterName, query)}
                        </span>
                      )}
                      {speakerOnly && (
                        <span className="inline-flex items-center rounded-full bg-[hsl(var(--color-primary)/0.12)] px-2 py-0.5 text-[10px] text-[hsl(var(--color-primary))]">
                          按说话人命中
                        </span>
                      )}
                      {titleOnly && (
                        <span className="inline-flex items-center rounded-full bg-[hsl(var(--color-primary)/0.12)] px-2 py-0.5 text-[10px] text-[hsl(var(--color-primary))]">
                          按剧情标题命中
                        </span>
                      )}
                    </div>
                    {hit.matchedText && (
                      <div className="text-sm text-[hsl(var(--color-foreground))] whitespace-pre-wrap leading-relaxed">
                        {highlightMatches(hit.matchedText, query)}
                      </div>
                    )}
                  </button>
                  );
                })}
              </div>
            )}

            {/* 整篇模式结果 */}
            {!searching && mode === "story" && searched && page && page.results.length === 0 && (
              <div className="text-center text-[hsl(var(--color-muted-foreground))]">
                未找到相关剧情
              </div>
            )}

            {!searching && mode === "story" && page && page.results.length > 0 && (
              <div className="space-y-3">
                <div className="flex items-center justify-between text-sm text-[hsl(var(--color-muted-foreground))]">
                  <span>共 {page.totalMatched} 条匹配</span>
                  {page.truncated && (
                    <span className="text-xs">
                      已显示 {page.results.length} / {page.totalMatched}，缩小关键词可获得更精确结果
                    </span>
                  )}
                </div>
                {page.results.map((result, index) => (
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
              <div className="mx-auto max-w-md">
                <details className="group rounded-lg border border-[hsl(var(--color-border))] bg-[hsl(var(--color-muted)/0.1)]">
                  <summary className="flex cursor-pointer list-none items-center justify-between px-4 py-3 text-sm text-[hsl(var(--color-foreground))]">
                    <span>搜索语法说明</span>
                    <span className="text-xs text-[hsl(var(--color-muted-foreground))] transition-transform group-open:rotate-180">
                      ▾
                    </span>
                  </summary>
                  <div className="border-t border-[hsl(var(--color-border))] px-4 py-3 text-xs text-[hsl(var(--color-muted-foreground))] space-y-1.5">
                    <div>
                      <span className="font-mono text-[hsl(var(--color-foreground))]">空格</span>
                      <span className="ml-2">多词默认 AND 关系，都要匹配</span>
                    </div>
                    <div>
                      <span className="font-mono text-[hsl(var(--color-foreground))]">OR</span>
                      <span className="ml-2">任一命中即可，例如 <code>凯尔希 OR 博士</code></span>
                    </div>
                    <div>
                      <span className="font-mono text-[hsl(var(--color-foreground))]">-排除词</span>
                      <span className="ml-2">在词前加减号排除，例如 <code>博士 -干员</code></span>
                    </div>
                    <div>
                      <span className="font-mono text-[hsl(var(--color-foreground))]">"短语"</span>
                      <span className="ml-2">用英文引号匹配精确短语</span>
                    </div>
                  </div>
                </details>
              </div>
            )}
          </div>
        </CustomScrollArea>
      </main>
    </div>
  );
}
