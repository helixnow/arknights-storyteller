import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
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
  SearchX,
  X,
  BookOpen,
  MessageSquare,
  MoreHorizontal,
  Loader2,
  AlertTriangle,
  Database,
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

/** 少于两个字符不自动搜：中文单字命中面太大，等于把整库拉一遍。 */
const AUTO_SEARCH_MIN_LEN = 2;
/** 已经有结果、用户在改词：给足停顿时间再发请求。 */
const AUTO_DEBOUNCE_MS = 320;
/** 空面板里敲下的第一个词：延迟压到一眼看不出来的量级，别让首字发木。 */
const AUTO_DEBOUNCE_FIRST_MS = 140;
/** 本地缓存里已经有答案：几乎零成本，跟着输入走就行。 */
const AUTO_DEBOUNCE_CACHED_MS = 60;

const RESULT_LISTBOX_ID = "search-result-listbox";

/** 空数组常量：给 memo 化的行提供稳定引用，避免每帧新建。 */
const NO_RESULTS: SearchResult[] = [];
const NO_HITS: SegmentHit[] = [];

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

/** Tauri 的 invoke 失败时抛出来的可能是字符串、Error，也可能是后端序列化的对象。 */
function describeSearchError(err: unknown): string {
  const raw =
    typeof err === "string"
      ? err
      : err instanceof Error
        ? err.message
        : err && typeof err === "object" && typeof (err as { message?: unknown }).message === "string"
          ? (err as { message: string }).message
          : "";
  const text = raw.trim();
  if (!text) return "后端未返回错误信息";
  return text.length > 160 ? `${text.slice(0, 160)}…` : text;
}

/**
 * 半截的查询串先别发出去：引号还没配对、或者停在 `-` / `OR` 上时，
 * 后端只会返回一堆噪音，用户每敲一个符号就闪一次"没有结果"。
 */
function isAutoSearchable(raw: string): boolean {
  if (raw.length < AUTO_SEARCH_MIN_LEN) return false;
  if ((raw.match(/"/g)?.length ?? 0) % 2 === 1) return false;
  if (/-$/.test(raw)) return false;
  if (/\b(or|and|not)$/i.test(raw)) return false;
  return true;
}

function optionDomId(index: number): string {
  return `search-result-option-${index}`;
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

/**
 * 段级缓存落盘。零命中的条目一律不写：下次搜索会直接命中空结果，
 * 从而永久绕开"段落搜不到就自动改搜整篇"的兜底。
 */
function persistSegmentCache(map: Record<string, CachedSegmentPage>) {
  writeJson(
    SEGMENT_CACHE_KEY,
    Object.fromEntries(Object.entries(map).filter(([, entry]) => entry.page.hits.length > 0))
  );
}

// ─────────────────────────────────────────────────────────
// 结果行
// ─────────────────────────────────────────────────────────

const ROW_BASE_CLASS =
  "w-full p-4 rounded-lg border text-left transition-all duration-200 motion-safe:animate-in motion-safe:fade-in-0 disabled:opacity-60 disabled:cursor-wait";
/** 键盘选中的那一行必须自己看得见，不能只靠鼠标 hover 的背景色。 */
const ROW_ACTIVE_CLASS =
  "border-[hsl(var(--color-primary))] bg-[hsl(var(--color-accent))] ring-2 ring-[hsl(var(--color-ring))]";
const ROW_IDLE_CLASS =
  "border-[hsl(var(--color-border))] hover:bg-[hsl(var(--color-accent))] hover:-translate-y-0.5";

interface StoryRowProps {
  result: SearchResult;
  index: number;
  active: boolean;
  opening: boolean;
  highlight: Highlighter;
  onOpen: (result: SearchResult) => void;
  registerRow: (index: number, el: HTMLButtonElement | null) => void;
}

/**
 * 结果行单独 memo：输入框是受控的，用户每敲一个字整个面板就重渲染一轮，
 * 而一次搜索能出上百行。行的 props 里只有 `active` / `opening` 会变，
 * 其余（高亮函数、回调）都在父层用 ref 稳住了引用。
 */
const StoryResultRow = memo(function StoryResultRow({
  result,
  index,
  active,
  opening,
  highlight,
  onOpen,
  registerRow,
}: StoryRowProps) {
  return (
    <button
      type="button"
      id={optionDomId(index)}
      role="option"
      aria-selected={active}
      // 焦点始终留在输入框，由 aria-activedescendant 指路，
      // 所以行本身不进 Tab 序列，免得几百个按钮把 Tab 键淹了。
      tabIndex={-1}
      ref={(el) => {
        registerRow(index, el);
      }}
      onClick={() => onOpen(result)}
      disabled={opening}
      className={cn(ROW_BASE_CLASS, active ? ROW_ACTIVE_CLASS : ROW_IDLE_CLASS)}
      style={{ animationDelay: `${Math.min(index, 10) * 40}ms` }}
    >
      <div className="font-medium mb-1">
        {highlight(result.storyName)}
        {opening && (
          <span className="ml-2 text-xs text-[hsl(var(--color-muted-foreground))]">打开中...</span>
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
  );
});

interface SegmentRowProps {
  hit: SegmentHit;
  index: number;
  active: boolean;
  opening: boolean;
  highlight: Highlighter;
  onOpen: (hit: SegmentHit) => void;
  registerRow: (index: number, el: HTMLButtonElement | null) => void;
}

/** 段落行：结构比整篇行重（角色 chip、命中来源徽标），更值得 memo。 */
const SegmentResultRow = memo(function SegmentResultRow({
  hit,
  index,
  active,
  opening,
  highlight,
  onOpen,
  registerRow,
}: SegmentRowProps) {
  const speakerOnly = hit.matchTarget === "speaker";
  const titleOnly = hit.matchTarget === "title";
  return (
    <button
      type="button"
      id={optionDomId(index)}
      role="option"
      aria-selected={active}
      tabIndex={-1}
      ref={(el) => {
        registerRow(index, el);
      }}
      onClick={() => onOpen(hit)}
      disabled={opening}
      className={cn(ROW_BASE_CLASS, active ? ROW_ACTIVE_CLASS : ROW_IDLE_CLASS)}
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
            {/* When the badge itself already calls out the speaker as the
                reason the row matched, skip the term highlight inside the
                chip — a double visual accent muddies the card. */}
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
        {opening && <span className="text-[11px]">打开中...</span>}
      </div>
      {hit.matchedText && (
        <div className="text-sm text-[hsl(var(--color-foreground))] whitespace-pre-wrap leading-relaxed">
          {highlight(hit.matchedText)}
        </div>
      )}
    </button>
  );
});

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
  /** 出错的那次搜索：连查询串一起记下来，重试才不会重试成上一条成功的词。 */
  const [searchError, setSearchError] = useState<{ query: string; message: string } | null>(null);
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
  // 输入法组合态同时存 state 和 ref：ref 给同步的按键判断用，
  // state 让防抖 effect 能在组合开始/结束时重新决策。
  const [composing, setComposing] = useState(false);
  /** 防抖计时器已排上但还没发请求——用来立刻给一点"收到了"的反馈。 */
  const [autoPending, setAutoPending] = useState(false);
  /** 键盘上下键选中的行号，-1 表示焦点还停在输入框上。 */
  const [activeIndex, setActiveIndex] = useState(-1);
  /** 单一播报口径：只在结果落定时更新，避免进度事件把屏幕阅读器刷屏。 */
  const [announcement, setAnnouncement] = useState("");

  const moreMenuRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  // 输入法组合中：Enter 只是确认候选词，不该触发搜索。
  const composingRef = useRef(false);
  // 生成号：每次发起搜索 +1，输入变化 / 清空 / 换数据版本时也 +1。
  // Tauri 的 invoke 没有 abort，只能靠它让迟到的旧结果失去写状态的资格。
  const searchSeqRef = useRef(0);
  const searchingRef = useRef(false);
  /** 在途搜索查的词和模式：防抖 effect 靠它识别"同一条已经在路上"。 */
  const inFlightRef = useRef<{ mode: SearchMode; query: string } | null>(null);
  /** 自动搜索失败过的 `${mode}:${query}`，避免 effect 反复重试同一个错误。 */
  const autoFailedRef = useRef<string | null>(null);
  const rowRefs = useRef(new Map<number, HTMLButtonElement>());

  const toast = useToast();

  // 高亮跟着"真正搜过的词"走：用户改了输入框但还没触发搜索时，
  // 结果卡片不该突然高亮一个没搜过的词。
  // 注意这里先收敛成字符串再 memo——直接把 query 放进依赖会让高亮函数
  // 每敲一个字就换一次引用，下面所有 memo 化的结果行会跟着全量重渲染。
  const highlightSource = lastQuery || query;
  const highlight = useMemo(() => createHighlighter(highlightSource), [highlightSource]);

  const visibleResults = useMemo(() => {
    if (!page) return NO_RESULTS;
    if (!activeFacet) return page.results;
    return page.results.filter((r) => facetKeyOf(r.category) === activeFacet);
  }, [page, activeFacet]);

  const segmentHits = segmentPage?.hits ?? NO_HITS;

  const facetEntries = useMemo(
    () => (page?.facets ? Object.entries(page.facets) : []),
    [page]
  );

  const indexReady = Boolean(indexStatus?.ready) && !buildingIndex;
  /** 索引"还没有"和"搜不到"是两回事，空结果的文案要靠它分流。 */
  const indexPending = buildingIndex || (indexStatus != null && !indexStatus.ready);

  const hitCount = mode === "segment" ? segmentHits.length : page?.results.length ?? 0;
  // 边打边搜时旧结果留在原地（只压暗），不然每敲一个字整页都要闪一次白。
  const listRendered = !searchError && hitCount > 0;
  const navRows = mode === "segment" ? segmentHits : visibleResults;
  const navCount = listRendered ? navRows.length : 0;

  /**
   * 作废所有在途搜索。生成号一涨，正在路上的请求回来时就会被判定为过期
   * 而丢弃；同时把 spinner 收掉，否则那个请求永远不会再走到 settle()。
   */
  const invalidateInFlight = useCallback(() => {
    searchSeqRef.current += 1;
    inFlightRef.current = null;
    if (!searchingRef.current) return;
    searchingRef.current = false;
    setSearching(false);
    setProgress(null);
  }, []);

  // Load version for cache keying.
  useEffect(() => {
    void api
      .getCurrentVersion()
      .then((v) => setVersion(v))
      .catch(() => setVersion(""));
  }, []);

  useEffect(() => {
    const onUpdated = () => {
      // 数据整个换了，在途的那次搜索查的还是旧库。不作废的话它回来时会被
      // 当成新版本的结果写进缓存，之后一直拿旧数据糊弄用户。
      invalidateInFlight();
      setCache({});
      setSegmentCache({});
      void api
        .getCurrentVersion()
        .then((v) => setVersion(v))
        .catch(() => undefined);
    };
    window.addEventListener("app:data-updated", onUpdated);
    return () => window.removeEventListener("app:data-updated", onUpdated);
  }, [invalidateInFlight]);

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
    /** 防抖自动触发：不写历史、不自动改模式，失败也不弹 toast。 */
    auto?: boolean;
  }): Promise<void> => {
    const raw = (opts?.queryOverride ?? query).trim();
    if (!raw) return;
    const activeMode = opts?.modeOverride ?? mode;
    const auto = opts?.auto === true;
    // 自动搜索绝不把用户"打到一半"的词写进历史，也不擅自把模式掰回整篇。
    const allowFallback = !opts?.noFallback && !auto;
    const commitQuery = () => {
      setLastQuery(raw);
      if (!auto) saveHistory(raw);
    };

    const seq = ++searchSeqRef.current;
    const isStale = () => seq !== searchSeqRef.current;
    const settle = () => {
      if (isStale()) return;
      searchingRef.current = false;
      inFlightRef.current = null;
      setSearching(false);
      setProgress(null);
    };

    autoFailedRef.current = null;
    inFlightRef.current = { mode: activeMode, query: raw };
    setSearching(true);
    searchingRef.current = true;
    setSearchError(null);
    setActiveFacet(null);
    setActiveIndex(-1);
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
          commitQuery();
          // 命中的可能是边打边搜留在内存里的那一条；用户这次是明确要搜，
          // 顺手补一次落盘，下个会话才能直接秒开。
          if (!auto) persistSegmentCache(segmentCache);
          settle();
          // 旧版本可能把"零命中"写进了 localStorage；命中缓存也要照样回退，
          // 否则这条查询会永远停在空结果。
          if (cached.page.hits.length === 0 && allowFallback) {
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
        commitQuery();

        const nextCache = prune({
          ...segmentCache,
          [raw]: { page: data, updatedAt: Date.now(), version },
        });
        setSegmentCache(nextCache);
        // 边打边搜的中间结果只进内存：跨会话留着「凯」「凯尔」这种半截查询
        // 没有意义，而每次落盘都要把整张表 stringify 一遍。
        if (!auto) persistSegmentCache(nextCache);
        settle();

        if (data.hits.length === 0 && allowFallback) {
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
          commitQuery();
          if (!auto) writeJson(CACHE_KEY, cache);
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
        if (!auto) writeJson(CACHE_KEY, nextCache);
        setFromCache({ used: false });
      }
      setSearched(true);
      commitQuery();
    } catch (err) {
      if (isStale()) return;
      devLog("搜索失败", err);
      const detail = describeSearchError(err);
      // 失败要留在界面上：只弹一条会自己消失的 toast，用户回头就不知道
      // 到底是"搜不到"还是"搜挂了"。
      setSearchError({ query: raw, message: detail });
      setPage(null);
      setSegmentPage(null);
      // 结果已经清掉了，上一次成功留下的"已从缓存恢复"横幅不能继续挂着撒谎。
      setFromCache({ used: false });
      if (auto) {
        autoFailedRef.current = `${activeMode}:${raw}`;
      } else {
        toast.error("搜索失败，请重试");
      }
    } finally {
      settle();
    }
  };

  // handleSearch 依赖了一大票 state（cache / version / mode / debugMode…），
  // 直接进 effect 依赖会让防抖计时器每敲一个字就重建。这里只把最新实现挂到
  // ref 上，计时器就只依赖真正的触发条件。
  const handleSearchRef = useRef(handleSearch);
  const openResultRef = useRef<(result: SearchResult) => void>(() => {});
  const openSegmentRef = useRef<(hit: SegmentHit) => void>(() => {});

  const switchMode = (next: SearchMode) => {
    if (next === mode) return;
    invalidateInFlight();
    setMode(next);
    setActiveFacet(null);
    setActiveIndex(-1);
    setSearchError(null);
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

  useEffect(() => {
    handleSearchRef.current = handleSearch;
    openResultRef.current = (result) => void openResult(result);
    openSegmentRef.current = (hit) => void openSegment(hit);
  });

  // 传给 memo 化行的回调必须是常量引用，所以统一走上面的 latest ref。
  const handleOpenResult = useCallback((result: SearchResult) => {
    openResultRef.current(result);
  }, []);
  const handleOpenSegment = useCallback((hit: SegmentHit) => {
    openSegmentRef.current(hit);
  }, []);
  const registerRow = useCallback((index: number, el: HTMLButtonElement | null) => {
    if (el) rowRefs.current.set(index, el);
    else rowRefs.current.delete(index);
  }, []);

  const clearSearch = () => {
    invalidateInFlight();
    setQuery("");
    setPage(null);
    setSegmentPage(null);
    setSearched(false);
    setSearchError(null);
    setAutoPending(false);
    setDebugLogs([]);
    setDebugExpanded(false);
    setOpeningStoryId(null);
    setFromCache({ used: false });
    setActiveFacet(null);
    setActiveIndex(-1);
    setLastQuery("");
    autoFailedRef.current = null;
    inputRef.current?.focus();
  };

  const moveActive = (delta: number) => {
    setActiveIndex((prev) => {
      if (navCount === 0) return -1;
      if (prev < 0) return delta > 0 ? 0 : navCount - 1;
      const next = prev + delta;
      // 从第一行再往上就回到输入框：不做环绕，免得用户以为列表跳到了底。
      if (next < 0) return -1;
      return Math.min(next, navCount - 1);
    });
  };

  const openActiveRow = () => {
    if (activeIndex < 0) return false;
    if (mode === "segment") {
      const hit = segmentHits[activeIndex];
      if (!hit) return false;
      handleOpenSegment(hit);
      return true;
    }
    const result = visibleResults[activeIndex];
    if (!result) return false;
    handleOpenResult(result);
    return true;
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    // 三重保险：compositionstart/end 自己记的状态、标准 isComposing、
    // 以及部分安卓输入法只给的 keyCode 229。组合期间方向键在选候选词，
    // 回车在上屏，一个都不能被我们截走。
    const composingNow =
      composingRef.current || e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229;

    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      if (composingNow || navCount === 0) return;
      e.preventDefault();
      moveActive(e.key === "ArrowDown" ? 1 : -1);
      return;
    }
    if (e.key === "Escape") {
      if (composingNow) return;
      // 先退出列表选择，再退出搜索：一次 Esc 只做一件事。
      if (activeIndex >= 0) {
        e.preventDefault();
        setActiveIndex(-1);
        return;
      }
      if (query) {
        e.preventDefault();
        clearSearch();
      }
      return;
    }
    if (e.key !== "Enter") return;
    if (composingNow) return;
    e.preventDefault();
    if (openActiveRow()) return;
    void handleSearch();
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

  // 输入防抖自动搜索。几条硬性前提：
  //   - 输入法组合中一个字都不发，半截拼音（"nihao" / "凯尔x"）搜出来全是噪音；
  //   - 索引没就绪时不自动搜，那条路径是全量扫盘，边打边搜会把机器拖死，
  //     用户仍然可以按回车强搜；
  //   - 调试模式不自动搜，每次都要拉一大坨日志并展开面板。
  useEffect(() => {
    const raw = query.trim();
    const cancel = () => setAutoPending(false);

    if (composing || debugMode || !indexReady) return cancel();
    if (!isAutoSearchable(raw)) return cancel();
    // 已经就是当前展示的结果，或者刚刚自动搜失败过，都别再发一遍。
    if (raw === lastQuery && searched && !searchError) return cancel();
    if (autoFailedRef.current === `${mode}:${raw}`) return cancel();
    // 同一个词的搜索已经在路上（回车 / 历史词条 / 切模式触发的手动搜）：
    // 再排一个计时器只会把它作废重发——手动搜的写历史、段落零命中回退
    // 全都会跟着丢，后端还要白挨一次同样的查询。
    // `searching` 在依赖里，手动搜一启动 cleanup 就会拆掉已排上的旧计时器。
    if (searching && inFlightRef.current?.query === raw && inFlightRef.current.mode === mode)
      return cancel();

    const cached =
      mode === "segment"
        ? segmentCache[raw]?.version === version
        : cache[raw]?.version === version;
    // 首字不能发木：空面板里的第一次几乎立刻走，改词时才给足停顿。
    const delay = cached
      ? AUTO_DEBOUNCE_CACHED_MS
      : searched
        ? AUTO_DEBOUNCE_MS
        : AUTO_DEBOUNCE_FIRST_MS;

    setAutoPending(true);
    const timer = window.setTimeout(() => {
      setAutoPending(false);
      void handleSearchRef.current({ queryOverride: raw, auto: true });
    }, delay);
    return () => window.clearTimeout(timer);
  }, [
    query,
    composing,
    debugMode,
    indexReady,
    lastQuery,
    searched,
    searchError,
    searching,
    mode,
    cache,
    segmentCache,
    version,
  ]);

  // 结果集换了就取消选中：行号对应的已经是另一批内容了。
  // 引用表不用在这里清——行卸载时 ref 回调会带着 null 回来自己删。
  useEffect(() => {
    setActiveIndex(-1);
  }, [page, segmentPage, activeFacet, mode]);

  // 选中行滚进可视区。`nearest` 只在真的看不见时才动，键盘浏览不会一路乱跳。
  useEffect(() => {
    if (activeIndex < 0) return;
    rowRefs.current.get(activeIndex)?.scrollIntoView({ block: "nearest" });
  }, [activeIndex]);

  // 唯一的播报口径：只在搜索落定后说一句话。搜索中交给 aria-busy，
  // 进度条和状态条都不再挂 live 区域，否则每个进度事件都要念一遍。
  useEffect(() => {
    if (searching) return;
    if (searchError) {
      setAnnouncement(`搜索出错：${searchError.message}`);
      return;
    }
    if (!searched) {
      setAnnouncement("");
      return;
    }
    const scope = lastQuery ? `「${lastQuery}」` : "";
    if (hitCount > 0) {
      const unit = mode === "segment" ? "段" : "条";
      setAnnouncement(`${scope}找到 ${hitCount} ${unit}结果，可用上下方向键浏览，回车打开`);
    } else if (indexPending) {
      setAnnouncement(`${scope}暂时没有结果：全文索引还没建好`);
    } else {
      setAnnouncement(`${scope}没有找到匹配结果`);
    }
  }, [searching, searched, searchError, hitCount, lastQuery, mode, indexPending]);

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
        <div className="flex items-center gap-2 text-xs text-[hsl(var(--color-muted-foreground))]">
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
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="text-xs text-[hsl(var(--color-muted-foreground))]">
            全文索引尚未就绪：现在搜索会退化成逐篇扫描，也不会边打边搜，按回车仍可强制搜索。
          </div>
          <button
            type="button"
            onClick={() => void handleBuildIndex()}
            className="inline-flex min-h-[44px] items-center px-2 text-xs text-[hsl(var(--color-foreground))] underline"
          >
            立即建立
          </button>
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

  /**
   * 空结果分三种，文案和出口都不一样：
   *   1. 索引还没建好 —— 不是"搜不到"，是"还搜不了"，给建立索引的入口；
   *   2. 真的零命中 —— 给换一种粒度再搜的入口；
   *   3. 出错 —— 单独由错误卡片处理（见下方 renderSearchError）。
   */
  const renderEmptyState = () => {
    if (indexPending) {
      return (
        <div className="mx-auto flex max-w-md flex-col items-center gap-3 rounded-lg border border-dashed border-[hsl(var(--color-border))] p-6 text-center">
          <Database className="h-6 w-6 text-[hsl(var(--color-muted-foreground))]" aria-hidden="true" />
          <div className="text-sm font-medium">全文索引还没准备好</div>
          <p className="text-xs leading-relaxed text-[hsl(var(--color-muted-foreground))]">
            {buildingIndex
              ? "索引正在后台建立，完成后这条查询会更快、也更准。"
              : "还没有可用的全文索引，当前结果可能不完整。建好之后即可边输入边搜索。"}
          </p>
          <Button
            variant="outline"
            className="min-h-[44px]"
            disabled={buildingIndex}
            onClick={() => void handleBuildIndex()}
          >
            {buildingIndex ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />
                建立中…
              </>
            ) : (
              <>
                <Database className="mr-2 h-4 w-4" aria-hidden="true" />
                建立索引
              </>
            )}
          </Button>
        </div>
      );
    }
    return (
      <div className="mx-auto flex max-w-md flex-col items-center gap-3 rounded-lg border border-dashed border-[hsl(var(--color-border))] p-6 text-center">
        <SearchX className="h-6 w-6 text-[hsl(var(--color-muted-foreground))]" aria-hidden="true" />
        <div className="text-sm font-medium">
          {mode === "segment" ? "未找到包含该关键词的段落" : "未找到相关剧情"}
        </div>
        <p className="text-xs leading-relaxed text-[hsl(var(--color-muted-foreground))]">
          索引是完整的，确实没有匹配项。可以换个说法，或者改用另一种搜索粒度。
        </p>
        {mode === "segment" ? (
          <Button variant="outline" className="min-h-[44px]" onClick={() => switchMode("story")}>
            <BookOpen className="mr-2 h-4 w-4" aria-hidden="true" />
            改搜整篇
          </Button>
        ) : (
          <Button variant="outline" className="min-h-[44px]" onClick={() => switchMode("segment")}>
            <MessageSquare className="mr-2 h-4 w-4" aria-hidden="true" />
            改搜段落
          </Button>
        )}
      </div>
    );
  };

  const renderSearchError = (failure: { query: string; message: string }) => (
    <div className="mx-auto flex max-w-md flex-col items-center gap-3 rounded-lg border border-[hsl(var(--color-status-error)/0.5)] bg-[hsl(var(--color-status-error)/0.06)] p-6 text-center">
      <AlertTriangle className="h-6 w-6 text-[hsl(var(--color-status-error))]" aria-hidden="true" />
      <div className="text-sm font-medium">「{failure.query}」没能搜完</div>
      <p className="break-words text-xs leading-relaxed text-[hsl(var(--color-muted-foreground))]">
        {failure.message}
      </p>
      {indexPending && (
        <p className="text-xs text-[hsl(var(--color-muted-foreground))]">
          全文索引尚未就绪，很可能就是原因所在。
        </p>
      )}
      <div className="flex flex-wrap items-center justify-center gap-2">
        <Button
          variant="outline"
          className="min-h-[44px]"
          onClick={() => void handleSearch({ queryOverride: failure.query, forceRefresh: true })}
        >
          <Search className="mr-2 h-4 w-4" aria-hidden="true" />
          重试
        </Button>
        {indexPending && !buildingIndex && (
          <Button variant="outline" className="min-h-[44px]" onClick={() => void handleBuildIndex()}>
            <Database className="mr-2 h-4 w-4" aria-hidden="true" />
            建立索引
          </Button>
        )}
      </div>
    </div>
  );

  // 连 JSX 数组一起缓存：引用没变时 React 直接跳过整棵子树，
  // 一次搜索出几百行的情况下，敲字的重渲染成本才真正压到接近零。
  const storyRowNodes = useMemo(
    () =>
      visibleResults.map((result, index) => (
        <StoryResultRow
          key={`${result.storyId}-${index}`}
          result={result}
          index={index}
          active={activeIndex === index}
          opening={openingStoryId === result.storyId}
          highlight={highlight}
          onOpen={handleOpenResult}
          registerRow={registerRow}
        />
      )),
    [visibleResults, activeIndex, openingStoryId, highlight, handleOpenResult, registerRow]
  );

  const segmentRowNodes = useMemo(
    () =>
      segmentHits.map((hit, index) => (
        <SegmentResultRow
          key={`${hit.storyId}-${hit.segmentIndex}-${index}`}
          hit={hit}
          index={index}
          active={activeIndex === index}
          opening={openingStoryId === hit.storyId}
          highlight={highlight}
          onOpen={handleOpenSegment}
          registerRow={registerRow}
        />
      )),
    [segmentHits, activeIndex, openingStoryId, highlight, handleOpenSegment, registerRow]
  );

  const keyboardHint = navCount > 0 && (
    <span className="hidden flex-shrink-0 text-[11px] text-[hsl(var(--color-muted-foreground))] md:inline">
      ↑↓ 选择 · Enter 打开
    </span>
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
                onChange={(e) => {
                  // 词一变，在途的那次搜索就没有意义了：先作废，
                  // 免得慢半拍的结果回来覆盖掉新词的结果。
                  if (searchingRef.current) invalidateInFlight();
                  // 同时松开列表选中：否则用户选了一行又接着改词，
                  // 这时的回车会去开那一行，而不是搜新词。
                  setActiveIndex(-1);
                  setQuery(e.target.value);
                }}
                onKeyDown={handleKeyDown}
                onCompositionStart={() => {
                  composingRef.current = true;
                  setComposing(true);
                }}
                onCompositionEnd={(e) => {
                  composingRef.current = false;
                  setComposing(false);
                  // Safari/WKWebView 的 compositionend 在 input 之前触发，
                  // 光靠 onChange 会漏掉上屏的最后一段，这里补一次。
                  setQuery(e.currentTarget.value);
                }}
                placeholder="搜索剧情名称或内容..."
                className="pr-12 min-h-[44px]"
                aria-label="搜索剧情"
                aria-controls={navCount > 0 ? RESULT_LISTBOX_ID : undefined}
                aria-activedescendant={activeIndex >= 0 ? optionDomId(activeIndex) : undefined}
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
                        显示匹配过程记录（关闭边打边搜）
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
                // 刷新的必须是横幅指向的那次搜索（lastQuery），而不是输入框里
                // 可能已经改到一半的词。
                onClick={() => void handleSearch({ queryOverride: lastQuery, forceRefresh: true })}
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

          {/* 计时器已排上但请求还没发：先给一个"收到了"的反馈，
              这样第一个字打下去不会像卡住。 */}
          {autoPending && !searching && (
            <div className="mt-3 flex items-center gap-2 text-[11px] text-[hsl(var(--color-muted-foreground))]">
              <span
                className="h-1.5 w-1.5 flex-shrink-0 rounded-full bg-[hsl(var(--color-primary))] motion-safe:animate-pulse"
                aria-hidden="true"
              />
              <span>停下就搜，按回车立即搜索</span>
            </div>
          )}

          {/* 搜索中：有真实进度就画百分比，没有就只转 spinner，不编 0%。
              这块不挂 aria-live——播报统一交给下方那个 sr-only 区域。 */}
          {searching && (
            <div className="mt-3 space-y-1">
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
      <main className="flex-1 overflow-hidden" aria-busy={searching}>
        <CustomScrollArea
          className="h-full"
          viewportClassName="reader-scroll"
          trackOffsetTop="calc(3.5rem + 10px)"
          trackOffsetBottom="calc(4.5rem + env(safe-area-inset-bottom, 0px))"
        >
          <div className="container py-6 pb-24 motion-safe:animate-in motion-safe:fade-in-0 motion-safe:duration-700">
            {/* 结果落定后只说一句，polite 排队，不打断用户正在听的内容。 */}
            <div className="sr-only" role="status" aria-live="polite" aria-atomic="true">
              {announcement}
            </div>

            {searching && hitCount === 0 && (
              <div className="flex items-center justify-center gap-2 text-[hsl(var(--color-muted-foreground))]">
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                <span>
                  {progress && progress.total > 0
                    ? `${progress.phase} ${progress.current}/${progress.total}`
                    : "搜索中…"}
                </span>
              </div>
            )}

            {!searching && searchError && renderSearchError(searchError)}

            {/* 段落模式结果 */}
            {!searchError && mode === "segment" && segmentPage && (
              segmentHits.length === 0 ? (
                !searching && searched && renderEmptyState()
              ) : (
                <div className={cn("space-y-3", searching && "opacity-60 transition-opacity")}>
                  <div className="flex items-center justify-between gap-2 text-sm text-[hsl(var(--color-muted-foreground))]">
                    <span>共 {segmentPage.totalMatched} 段命中</span>
                    {segmentPage.truncated ? (
                      <span className="text-xs">
                        已显示 {segmentHits.length} / {segmentPage.totalMatched}，缩小关键词可获得更精确结果
                      </span>
                    ) : (
                      keyboardHint
                    )}
                  </div>
                  <div
                    id={RESULT_LISTBOX_ID}
                    role="listbox"
                    aria-label="段落搜索结果"
                    className="space-y-3"
                  >
                    {segmentRowNodes}
                  </div>
                </div>
              )
            )}

            {/* 整篇模式结果 */}
            {!searchError && mode === "story" && page && (
              page.results.length === 0 ? (
                !searching && searched && renderEmptyState()
              ) : (
                <div className={cn("space-y-3", searching && "opacity-60 transition-opacity")}>
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
                  <div className="flex items-center justify-between gap-2 text-sm text-[hsl(var(--color-muted-foreground))]">
                    <span>
                      共 {page.totalMatched} 条匹配
                      {activeFacet ? ` · ${activeFacet} ${visibleResults.length} 条` : ""}
                    </span>
                    {page.truncated ? (
                      <span className="text-xs">
                        已显示 {page.results.length} / {page.totalMatched}，缩小关键词可获得更精确结果
                      </span>
                    ) : (
                      keyboardHint
                    )}
                  </div>
                  {visibleResults.length === 0 ? (
                    <div className="text-center text-sm text-[hsl(var(--color-muted-foreground))]">
                      该分类下没有结果，换一个分类或清除筛选试试。
                    </div>
                  ) : (
                    <div
                      id={RESULT_LISTBOX_ID}
                      role="listbox"
                      aria-label="剧情搜索结果"
                      className="space-y-3"
                    >
                      {storyRowNodes}
                    </div>
                  )}
                </div>
              )
            )}

            {!searching && !searchError && !searched && (
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
                    <div>
                      <span className="font-mono text-[hsl(var(--color-foreground))]">↑ ↓ Enter</span>
                      <span className="ml-2">出结果后可直接用方向键选中、回车打开</span>
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
