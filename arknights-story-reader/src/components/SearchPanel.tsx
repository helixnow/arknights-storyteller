import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
import {
  Search,
  X,
  BookOpen,
  MessageSquare,
  MoreHorizontal,
  Loader2,
} from "lucide-react";
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

/** 后端进度事件。`total <= 0` 表示还没有真实进度，UI 走不确定态。 */
interface ProgressState {
  phase: string;
  current: number;
  total: number;
  message: string;
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

const HISTORY_LIMIT = 10;
const CACHE_LIMIT = 40;
const MAX_HIGHLIGHT_TERMS = 12;

const SEGMENT_TYPE_LABEL: Record<SegmentHit["segmentType"], string> = {
  dialogue: "对话",
  narration: "旁白",
  system: "系统",
  subtitle: "字幕",
  sticker: "标语",
  header: "标题",
  decision: "抉择",
};

/** 只有开发构建才打日志；线上失败一律走 toast，不再往控制台灌噪音。 */
function devLog(scope: string, err: unknown) {
  if (import.meta.env.DEV) {
    console.warn(`[SearchPanel] ${scope}`, err);
  }
}

// ─────────────────────────────────────────────────────────
// 关键词高亮
// ─────────────────────────────────────────────────────────

type Highlighter = (text: string | null | undefined) => React.ReactNode;

/**
 * 把查询串拆成用于高亮的词：
 *   - `-排除词` 不该被高亮（它压根不该出现在结果里）；
 *   - `OR` / `AND` 是连接符不是词；
 *   - `"短语"` 去掉引号整体高亮；
 *   - 纯中文长词后端按二元组匹配，顺带把单字也标出来，让用户看得出命中原因。
 */
function highlightTerms(query: string): string[] {
  const trimmed = query.trim();
  if (!trimmed) return [];
  const tokens = trimmed.match(/"[^"]*"|\S+/g) ?? [];
  const terms: string[] = [];
  for (const token of tokens) {
    if (token.startsWith("-")) continue;
    const stripped = token.replace(/^["']+|["']+$/g, "").trim();
    if (!stripped || /^(or|and|not)$/i.test(stripped)) continue;
    terms.push(stripped);
    if (stripped.length >= 4 && /^[\u4e00-\u9fff\u3400-\u4dbf]+$/.test(stripped)) {
      terms.push(...stripped.split(""));
    }
  }
  // 长词优先，保证「凯尔希」整体先于单字命中；去重后限量，避免超长正则。
  return Array.from(new Set(terms))
    .sort((a, b) => b.length - a.length)
    .slice(0, MAX_HIGHLIGHT_TERMS);
}

/** 按查询串编译一次正则，返回可复用的高亮函数。 */
function createHighlighter(query: string): Highlighter {
  const terms = highlightTerms(query);
  if (terms.length === 0) return (text) => text ?? null;
  const escaped = terms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const pattern = new RegExp(`(${escaped.join("|")})`, "gi");
  return (text) => {
    if (!text) return text ?? null;
    // `split` 带捕获组时奇数下标必定是命中片段，直接按下标判定。
    // 用带 g 的正则再 `test` 一次会因为 lastIndex 残留而漏掉一半高亮。
    const parts = text.split(pattern);
    if (parts.length === 1) return text;
    return parts.map((part, i) => {
      if (!part) return null;
      return i % 2 === 1 ? (
        <mark
          key={i}
          className="bg-[hsl(var(--color-primary)/0.25)] text-[hsl(var(--color-foreground))] rounded-sm px-0.5"
        >
          {part}
        </mark>
      ) : (
        <span key={i}>{part}</span>
      );
    });
  };
}

// ─────────────────────────────────────────────────────────
// 本地缓存读写
// ─────────────────────────────────────────────────────────

/** facet 的 key 是 `category` 里 ` | ` 之前的类型前缀（见后端 build facets）。 */
function facetKeyOf(category: string): string {
  return category.split(" | ")[0]?.trim() ?? category;
}

function prune<T extends { updatedAt: number }>(map: Record<string, T>): Record<string, T> {
  const entries = Object.entries(map);
  if (entries.length <= CACHE_LIMIT) return map;
  entries.sort((a, b) => b[1].updatedAt - a[1].updatedAt);
  return Object.fromEntries(entries.slice(0, CACHE_LIMIT));
}

/** 读缓存时逐条校验形状，避免旧版本 / 手改过的 localStorage 直接把面板搞崩。 */
function loadCacheMap<T extends { page: unknown; updatedAt: number; version: string }>(
  key: string,
  hasPayload: (page: unknown) => boolean
): Record<string, T> {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return {};
    const out: Record<string, T> = {};
    for (const [cacheKey, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (!value || typeof value !== "object") continue;
      const entry = value as Partial<T>;
      if (typeof entry.updatedAt !== "number" || typeof entry.version !== "string") continue;
      if (!hasPayload(entry.page)) continue;
      out[cacheKey] = entry as T;
    }
    return out;
  } catch {
    return {};
  }
}

function writeJson(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch (err) {
    // 配额满 / 隐私模式：缓存只是加速手段，丢了不影响功能。
    devLog(`写入缓存 ${key} 失败`, err);
  }
}

export function SearchPanel({ onSelectResult, onSelectSegment }: SearchPanelProps) {
  const [query, setQuery] = useState("");
  const [mode, setMode] = useState<SearchMode>(() => {
    try {
      return localStorage.getItem(SEARCH_MODE_KEY) === "segment" ? "segment" : "story";
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
  const [progress, setProgress] = useState<ProgressState | null>(null);
  const [indexProgress, setIndexProgress] = useState<ProgressState | null>(null);
  const [history, setHistory] = useState<string[]>([]);
  const [cache, setCache] = useState<Record<string, CachedPage>>({});
  const [segmentCache, setSegmentCache] = useState<Record<string, CachedSegmentPage>>({});
  const [fromCache, setFromCache] = useState<{ used: boolean; updatedAt?: number }>({
    used: false,
  });
  const [version, setVersion] = useState<string>("");
  const [lastQuery, setLastQuery] = useState("");
  const [activeFacet, setActiveFacet] = useState<string | null>(null);
  const [moreOpen, setMoreOpen] = useState(false);

  const moreMenuRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  // 输入法组合中：Enter 只是确认候选词，不该触发搜索。
  const composingRef = useRef(false);
  // 请求序号：只有最后一次搜索有资格写状态，避免连点导致结果错位。
  const searchSeqRef = useRef(0);
  const searchingRef = useRef(false);

  const toast = useToast();

  // 高亮跟着"真正搜过的词"走：用户改了输入框但还没回车时，
  // 结果卡片不该突然高亮一个没搜过的词。
  const highlight = useMemo(() => createHighlighter(lastQuery || query), [lastQuery, query]);

  const visibleResults = useMemo(() => {
    if (!page) return [] as SearchResult[];
    if (!activeFacet) return page.results;
    return page.results.filter((r) => facetKeyOf(r.category) === activeFacet);
  }, [page, activeFacet]);

  const facetEntries = useMemo(
    () => (page?.facets ? Object.entries(page.facets) : []),
    [page]
  );

  // Load version for cache keying.
  useEffect(() => {
    void api
      .getCurrentVersion()
      .then((v) => setVersion(v))
      .catch(() => setVersion(""));
  }, []);

  useEffect(() => {
    const onUpdated = () => {
      setCache({});
      setSegmentCache({});
      void api
        .getCurrentVersion()
        .then((v) => setVersion(v))
        .catch(() => undefined);
    };
    window.addEventListener("app:data-updated", onUpdated);
    return () => window.removeEventListener("app:data-updated", onUpdated);
  }, []);

  const saveHistory = useCallback((q: string) => {
    setHistory((prev) => {
      const next = [q, ...prev.filter((s) => s !== q)].slice(0, HISTORY_LIMIT);
      writeJson(HISTORY_KEY, next);
      return next;
    });
  }, []);

  const removeHistory = useCallback((q: string) => {
    setHistory((prev) => {
      const next = prev.filter((s) => s !== q);
      writeJson(HISTORY_KEY, next);
      return next;
    });
  }, []);

  /** 段级搜索零命中时自动改搜整篇，避免用户卡在空结果页。 */
  const fallbackToStory = async (raw: string) => {
    toast.warn("段级索引暂无命中，已自动改搜整篇", 2500);
    setMode("story");
    await handleSearch({ queryOverride: raw, modeOverride: "story", noFallback: true });
  };

  const handleSearch = async (opts?: {
    forceRefresh?: boolean;
    queryOverride?: string;
    modeOverride?: SearchMode;
    /** 明确禁用"段落零命中自动改搜整篇"，用于回退自身与手动切模式。 */
    noFallback?: boolean;
  }): Promise<void> => {
    const raw = (opts?.queryOverride ?? query).trim();
    if (!raw) return;
    const activeMode = opts?.modeOverride ?? mode;

    const seq = ++searchSeqRef.current;
    const isStale = () => seq !== searchSeqRef.current;
    const settle = () => {
      if (isStale()) return;
      searchingRef.current = false;
      setSearching(false);
      setProgress(null);
    };

    setSearching(true);
    searchingRef.current = true;
    setActiveFacet(null);
    // 还没收到后端进度事件之前保持 total = 0：UI 走不确定态 spinner，
    // 而不是显示一条永远停在 0% 的假进度条。
    setProgress({ phase: "搜索中", current: 0, total: 0, message: "" });

    try {
      if (activeMode === "segment") {
        const cached = opts?.forceRefresh ? undefined : segmentCache[raw];
        if (cached && cached.version === version) {
          setSegmentPage(cached.page);
          setPage(null);
          setSearched(true);
          setFromCache({ used: true, updatedAt: cached.updatedAt });
          setLastQuery(raw);
          saveHistory(raw);
          settle();
          // 旧版本可能把"零命中"写进了 localStorage；命中缓存也要照样回退，
          // 否则这条查询会永远停在空结果。
          if (cached.page.hits.length === 0 && !opts?.noFallback) {
            await fallbackToStory(raw);
          }
          return;
        }

        const data = await api.searchSegments(raw);
        if (isStale()) return;
        setSegmentPage(data);
        setPage(null);
        setFromCache({ used: false });
        setSearched(true);
        setLastQuery(raw);
        saveHistory(raw);

        const nextCache = prune({
          ...segmentCache,
          [raw]: { page: data, updatedAt: Date.now(), version },
        });
        setSegmentCache(nextCache);
        // 零命中只留在内存里。写进持久缓存会让下次搜索直接命中空结果，
        // 从而永久绕开自动回退。
        writeJson(
          SEGMENT_CACHE_KEY,
          Object.fromEntries(
            Object.entries(nextCache).filter(([, entry]) => entry.page.hits.length > 0)
          )
        );
        settle();

        if (data.hits.length === 0 && !opts?.noFallback) {
          await fallbackToStory(raw);
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
          setLastQuery(raw);
          saveHistory(raw);
          settle();
          return;
        }
      }

      if (debugMode) {
        const data = await api.searchStoriesDebug(raw);
        if (isStale()) return;
        setPage({
          results: data.results,
          totalMatched: data.results.length,
          truncated: false,
          facets: {},
        });
        setSegmentPage(null);
        setDebugLogs(data.logs);
        setDebugExpanded(true);
        setFromCache({ used: false });
      } else {
        const data = await api.searchStoriesEx(raw);
        if (isStale()) return;
        setPage(data);
        setSegmentPage(null);
        setDebugLogs([]);
        setDebugExpanded(false);
        const nextCache = prune({
          ...cache,
          [raw]: { page: data, updatedAt: Date.now(), version },
        });
        setCache(nextCache);
        writeJson(CACHE_KEY, nextCache);
        setFromCache({ used: false });
      }
      setSearched(true);
      setLastQuery(raw);
      saveHistory(raw);
    } catch (err) {
      if (isStale()) return;
      devLog("搜索失败", err);
      toast.error("搜索失败，请重试");
    } finally {
      settle();
    }
  };

  const switchMode = (next: SearchMode) => {
    if (next === mode) return;
    setMode(next);
    setActiveFacet(null);
    const pending = query.trim() || lastQuery;
    // 手动切模式时不自动回退，否则刚点"段落"就被弹回"整篇"，像是按钮失灵。
    if (searched && pending) {
      void handleSearch({ queryOverride: pending, modeOverride: next, noFallback: true });
    }
  };

  const openResult = async (result: SearchResult) => {
    try {
      setOpeningStoryId(result.storyId);
      const story = await api.getStoryEntry(result.storyId);
      onSelectResult(story, { query: lastQuery || query, snippet: result.matchedText });
    } catch (err) {
      devLog("打开剧情失败", err);
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
          query: lastQuery || query,
        });
      }
    } catch (err) {
      devLog("打开段落失败", err);
      toast.error("打开剧情失败");
    } finally {
      setOpeningStoryId(null);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Escape") {
      if (query) {
        e.preventDefault();
        clearSearch();
      }
      return;
    }
    if (e.key !== "Enter") return;
    // 三重保险：compositionstart/end 自己记的状态、标准 isComposing、
    // 以及部分安卓输入法只给的 keyCode 229。
    if (composingRef.current || e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229) {
      return;
    }
    e.preventDefault();
    void handleSearch();
  };

  const clearSearch = () => {
    searchSeqRef.current += 1;
    searchingRef.current = false;
    setQuery("");
    setPage(null);
    setSegmentPage(null);
    setSearched(false);
    setSearching(false);
    setProgress(null);
    setDebugLogs([]);
    setDebugExpanded(false);
    setOpeningStoryId(null);
    setFromCache({ used: false });
    setActiveFacet(null);
    setLastQuery("");
    inputRef.current?.focus();
  };

  const refreshIndexStatus = useCallback(async () => {
    try {
      const status = await api.getStoryIndexStatus();
      setIndexStatus(status);
      setIndexError(null);
    } catch (err) {
      devLog("获取索引状态失败", err);
      setIndexError("获取索引状态失败");
    }
  }, []);

  const handleBuildIndex = useCallback(async () => {
    setIndexError(null);
    setIndexMessage(null);
    // 同样先给不确定态；真实进度由挂载时注册的 index-progress 监听填。
    setIndexProgress({ phase: "准备", current: 0, total: 0, message: "" });
    try {
      setBuildingIndex(true);
      await api.buildStoryIndex();
      await refreshIndexStatus();
      setIndexMessage("全文索引建立完成");
      toast.success("全文索引建立完成");
    } catch (err) {
      devLog("建立索引失败", err);
      setIndexError("建立索引失败，请重试");
      toast.error("建立索引失败");
    } finally {
      setBuildingIndex(false);
      setIndexProgress(null);
    }
  }, [refreshIndexStatus, toast]);

  useEffect(() => {
    void refreshIndexStatus();
    try {
      const raw = localStorage.getItem(HISTORY_KEY);
      const parsed: unknown = raw ? JSON.parse(raw) : [];
      setHistory(
        Array.isArray(parsed)
          ? parsed.filter((s): s is string => typeof s === "string").slice(0, HISTORY_LIMIT)
          : []
      );
    } catch {
      setHistory([]);
    }
    setCache(
      loadCacheMap<CachedPage>(CACHE_KEY, (p) =>
        Array.isArray((p as SearchResultsPage | null)?.results)
      )
    );
    setSegmentCache(
      loadCacheMap<CachedSegmentPage>(SEGMENT_CACHE_KEY, (p) =>
        Array.isArray((p as SegmentSearchPage | null)?.hits)
      )
    );
  }, [refreshIndexStatus]);

  // 搜索进度：挂载时注册一次，卸载时解绑；只在真的在搜的时候写状态，
  // 免得上一次搜索的迟到事件把 spinner 又点亮。
  useEffect(() => {
    let dispose: (() => void) | null = null;
    let cancelled = false;
    void api
      .onSearchProgress((p) => {
        if (cancelled || !searchingRef.current) return;
        setProgress(p);
      })
      .then((unlisten) => {
        if (cancelled) {
          (unlisten as unknown as () => void)();
          return;
        }
        dispose = () => (unlisten as unknown as () => void)();
      })
      .catch((err) => devLog("监听搜索进度失败", err));
    return () => {
      cancelled = true;
      if (dispose) dispose();
    };
  }, []);

  // 自动索引 hook 重建完成后会派发 `app:story-index-updated`；这里监听
  // 一下把状态条刷成"已就绪"，不用再等用户手动切页。
  useEffect(() => {
    const handler = () => {
      void refreshIndexStatus();
    };
    window.addEventListener("app:story-index-updated", handler);
    return () => window.removeEventListener("app:story-index-updated", handler);
  }, [refreshIndexStatus]);

  // 后端的 index-progress 是唯一的索引进度来源：sync_data / import_zip 完成
  // 后后端会自行在线程里重建索引并 emit 进度。这里统一注册一次（手动"重建"
  // 也复用它），收到"完成"阶段时顺带刷新状态条。
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
      })
      .catch((err) => devLog("监听索引进度失败", err));
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
      const determinate = indexProgress && indexProgress.total > 0;
      return (
        <div
          className="flex items-center gap-2 text-xs text-[hsl(var(--color-muted-foreground))]"
          role="status"
          aria-live="polite"
        >
          <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
          <span className="truncate">
            {determinate && indexProgress
              ? `${indexProgress.phase} ${indexProgress.current}/${indexProgress.total}${indexProgress.message ? ` · ${indexProgress.message}` : ""}`
              : "索引建立中，请稍候…"}
          </span>
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
          className="inline-flex min-h-[44px] items-center px-2 text-xs text-[hsl(var(--color-muted-foreground))] underline hover:text-[hsl(var(--color-foreground))] disabled:opacity-50"
        >
          重建
        </button>
      </div>
    );
  };

  const emptyHint =
    mode === "segment" ? (
      <div className="flex flex-col items-center gap-3 text-center">
        <div className="text-[hsl(var(--color-muted-foreground))]">未找到包含该关键词的段落</div>
        <Button
          variant="outline"
          className="min-h-[44px]"
          onClick={() => switchMode("story")}
        >
          <BookOpen className="mr-2 h-4 w-4" />
          改搜整篇
        </Button>
      </div>
    ) : (
      <div className="flex flex-col items-center gap-3 text-center">
        <div className="text-[hsl(var(--color-muted-foreground))]">未找到相关剧情</div>
        <Button
          variant="outline"
          className="min-h-[44px]"
          onClick={() => switchMode("segment")}
        >
          <MessageSquare className="mr-2 h-4 w-4" />
          改搜段落
        </Button>
      </div>
    );

  return (
    <div className="h-full flex flex-col overflow-hidden">
      {/* 搜索栏 */}
      <header className="flex-shrink-0 z-10 bg-[hsl(var(--color-background)/0.95)] backdrop-blur border-b motion-safe:animate-in motion-safe:fade-in-0 motion-safe:duration-500">
        <div className="container py-4">
          <div className="flex items-center gap-2">
            <div className="relative flex-1">
              <Input
                ref={inputRef}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={handleKeyDown}
                onCompositionStart={() => {
                  composingRef.current = true;
                }}
                onCompositionEnd={() => {
                  composingRef.current = false;
                }}
                placeholder="搜索剧情名称或内容..."
                className="pr-12 min-h-[44px]"
                aria-label="搜索剧情"
                enterKeyHint="search"
                autoComplete="off"
                autoCorrect="off"
                spellCheck={false}
              />
              {query && (
                <button
                  type="button"
                  onClick={clearSearch}
                  aria-label="清空搜索"
                  className="absolute right-0.5 top-1/2 -translate-y-1/2 h-11 w-11 inline-flex items-center justify-center text-[hsl(var(--color-muted-foreground))] hover:text-[hsl(var(--color-foreground))]"
                >
                  <X className="h-4 w-4" />
                </button>
              )}
            </div>
            <Button
              onClick={() => void handleSearch()}
              disabled={searching || !query.trim()}
              aria-busy={searching}
              className="min-h-[44px]"
            >
              {searching ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />
              ) : (
                <Search className="mr-2 h-4 w-4" aria-hidden="true" />
              )}
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
                  <label className="flex min-h-[44px] items-center justify-between gap-3 rounded-sm px-2 py-2 text-sm cursor-pointer hover:bg-[hsl(var(--color-accent))]">
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
                    className="w-full min-h-[44px] rounded-sm px-2 py-2 text-left text-sm hover:bg-[hsl(var(--color-accent))] disabled:opacity-50 disabled:cursor-not-allowed"
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
          <div
            className="mt-3 inline-flex rounded-full border border-[hsl(var(--color-border))] p-0.5"
            role="group"
            aria-label="搜索粒度"
          >
            <button
              type="button"
              aria-pressed={mode === "story"}
              onClick={() => switchMode("story")}
              className={cn(
                "flex min-h-[44px] items-center gap-1 rounded-full px-4 text-xs transition-colors",
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
              onClick={() => switchMode("segment")}
              className={cn(
                "flex min-h-[44px] items-center gap-1 rounded-full px-4 text-xs transition-colors",
                mode === "segment"
                  ? "bg-[hsl(var(--color-primary))] text-[hsl(var(--color-primary-foreground))]"
                  : "text-[hsl(var(--color-muted-foreground))] hover:text-[hsl(var(--color-foreground))]"
              )}
            >
              <MessageSquare className="h-3.5 w-3.5" />
              段落
            </button>
          </div>

          {history.length > 0 && (
            <div className="mt-3 space-y-2">
              <div className="text-xs text-[hsl(var(--color-muted-foreground))]">历史搜索</div>
              <div className="flex flex-wrap items-center gap-2">
                {history.slice(0, HISTORY_LIMIT).map((h) => (
                  <div key={h} className="flex items-center border rounded-full pl-3 pr-0.5">
                    <button
                      type="button"
                      className="min-h-[44px] text-xs text-[hsl(var(--color-foreground))]"
                      onClick={() => {
                        setQuery(h);
                        void handleSearch({ queryOverride: h });
                      }}
                    >
                      {h}
                    </button>
                    {/* 删除的命中区撑到 44×44，图标仍是 12px 的小 ×。 */}
                    <button
                      type="button"
                      className="inline-flex h-11 w-11 items-center justify-center rounded-full text-[hsl(var(--color-muted-foreground))] hover:bg-[hsl(var(--color-accent))]"
                      onClick={() => removeHistory(h)}
                      aria-label={`删除历史记录：${h}`}
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </div>
                ))}
                <button
                  type="button"
                  className="ml-1 inline-flex min-h-[44px] items-center px-2 text-xs text-[hsl(var(--color-muted-foreground))] underline hover:text-[hsl(var(--color-foreground))]"
                  onClick={() => {
                    try {
                      localStorage.removeItem(HISTORY_KEY);
                    } catch {
                      /* ignore */
                    }
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
            <div
              className="mt-2 h-1 w-full overflow-hidden rounded-full bg-[hsl(var(--color-secondary))]"
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={indexProgress.total}
              aria-valuenow={Math.min(indexProgress.current, indexProgress.total)}
            >
              <div
                className="h-full bg-[hsl(var(--color-primary))] transition-all duration-200"
                style={{
                  width: `${Math.min((indexProgress.current / indexProgress.total) * 100, 100)}%`,
                }}
              />
            </div>
          )}

          {fromCache.used && (
            <div className="mt-2 flex flex-wrap items-center gap-1 text-xs text-[hsl(var(--color-muted-foreground))]">
              <span>
                已从缓存恢复，更新于{" "}
                {fromCache.updatedAt ? new Date(fromCache.updatedAt).toLocaleString() : "-"}
              </span>
              <button
                type="button"
                className="inline-flex min-h-[44px] items-center px-2 underline hover:text-[hsl(var(--color-foreground))]"
                onClick={() => void handleSearch({ forceRefresh: true })}
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
                type="button"
                onClick={() => setDebugExpanded((prev) => !prev)}
                className="w-full min-h-[44px] px-3 py-2 text-xs text-left font-medium flex items-center justify-between"
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

          {/* 搜索中：有真实进度就画百分比，没有就只转 spinner，不编 0%。 */}
          {searching && (
            <div className="mt-3 space-y-1" aria-live="polite">
              {progress && progress.total > 0 ? (
                <>
                  <div className="flex items-center justify-between gap-2 text-[11px] text-[hsl(var(--color-muted-foreground))] font-mono">
                    <span className="truncate">{progress.message || progress.phase}</span>
                    <span className="flex-shrink-0">
                      {progress.current}/{progress.total}
                    </span>
                  </div>
                  <div
                    className="h-1 w-full overflow-hidden rounded-full bg-[hsl(var(--color-secondary))]"
                    role="progressbar"
                    aria-valuemin={0}
                    aria-valuemax={progress.total}
                    aria-valuenow={Math.min(progress.current, progress.total)}
                  >
                    <div
                      className="h-full bg-[hsl(var(--color-primary))] transition-all duration-200"
                      style={{
                        width: `${Math.min((progress.current / progress.total) * 100, 100)}%`,
                      }}
                    />
                  </div>
                </>
              ) : (
                <div className="flex items-center gap-2 text-[11px] text-[hsl(var(--color-muted-foreground))]">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                  <span>{progress?.phase || "搜索中"}…</span>
                </div>
              )}
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
              <div
                className="flex items-center justify-center gap-2 text-[hsl(var(--color-muted-foreground))]"
                role="status"
                aria-live="polite"
              >
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                <span>
                  {progress && progress.total > 0
                    ? `${progress.phase} ${progress.current}/${progress.total}`
                    : "搜索中…"}
                </span>
              </div>
            )}

            {/* 段落模式结果 */}
            {!searching &&
              mode === "segment" &&
              segmentPage &&
              segmentPage.hits.length === 0 &&
              searched &&
              emptyHint}
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
                      <div className="font-medium truncate">{highlight(hit.storyName)}</div>
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
                          {speakerOnly ? hit.characterName : highlight(hit.characterName)}
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
                        {highlight(hit.matchedText)}
                      </div>
                    )}
                  </button>
                  );
                })}
              </div>
            )}

            {/* 整篇模式结果 */}
            {!searching && mode === "story" && searched && page && page.results.length === 0 && emptyHint}

            {!searching && mode === "story" && page && page.results.length > 0 && (
              <div className="space-y-3">
                {facetEntries.length > 0 && (
                  <div className="flex flex-wrap gap-2" role="group" aria-label="按分类筛选">
                    {facetEntries.map(([name, count]) => {
                      const active = activeFacet === name;
                      return (
                        <button
                          key={name}
                          type="button"
                          aria-pressed={active}
                          onClick={() => setActiveFacet(active ? null : name)}
                          className={cn(
                            "inline-flex min-h-[44px] items-center rounded-full border px-3 text-xs transition-colors",
                            active
                              ? "border-[hsl(var(--color-primary))] bg-[hsl(var(--color-primary)/0.12)] text-[hsl(var(--color-foreground))]"
                              : "border-[hsl(var(--color-border))] text-[hsl(var(--color-muted-foreground))] hover:text-[hsl(var(--color-foreground))]"
                          )}
                        >
                          {name} {count}
                        </button>
                      );
                    })}
                    {activeFacet && (
                      <button
                        type="button"
                        onClick={() => setActiveFacet(null)}
                        className="inline-flex min-h-[44px] items-center px-2 text-xs text-[hsl(var(--color-muted-foreground))] underline hover:text-[hsl(var(--color-foreground))]"
                      >
                        清除筛选
                      </button>
                    )}
                  </div>
                )}
                <div
                  className="flex items-center justify-between text-sm text-[hsl(var(--color-muted-foreground))]"
                  aria-live="polite"
                >
                  <span>
                    共 {page.totalMatched} 条匹配
                    {activeFacet ? ` · ${activeFacet} ${visibleResults.length} 条` : ""}
                  </span>
                  {page.truncated && (
                    <span className="text-xs">
                      已显示 {page.results.length} / {page.totalMatched}，缩小关键词可获得更精确结果
                    </span>
                  )}
                </div>
                {visibleResults.length === 0 ? (
                  <div className="text-center text-sm text-[hsl(var(--color-muted-foreground))]">
                    该分类下没有结果，换一个分类或清除筛选试试。
                  </div>
                ) : (
                  visibleResults.map((result, index) => (
                    <button
                      key={`${result.storyId}-${index}`}
                      onClick={() => openResult(result)}
                      disabled={openingStoryId === result.storyId}
                      className="w-full p-4 rounded-lg border border-[hsl(var(--color-border))] hover:bg-[hsl(var(--color-accent))] transition-all duration-200 text-left hover:-translate-y-0.5 motion-safe:animate-in motion-safe:fade-in-0 disabled:opacity-60 disabled:cursor-wait"
                      style={{ animationDelay: `${Math.min(index, 10) * 40}ms` }}
                    >
                      <div className="font-medium mb-1">
                        {highlight(result.storyName)}
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
                          {highlight(result.matchedText)}
                        </div>
                      )}
                    </button>
                  ))
                )}
              </div>
            )}

            {!searching && !searched && (
              <div className="mx-auto max-w-md">
                <details className="group rounded-lg border border-[hsl(var(--color-border))] bg-[hsl(var(--color-muted)/0.1)]">
                  <summary className="flex min-h-[44px] cursor-pointer list-none items-center justify-between px-4 py-3 text-sm text-[hsl(var(--color-foreground))]">
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
                      <span className="ml-2">用英文引号匹配精确短语。中文默认按单字 AND，搜「凯尔希」请写成 <code>"凯尔希"</code></span>
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
