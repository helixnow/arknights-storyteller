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
// 查询串解析（高亮词提取 / 自动搜可发判定）抽到纯模块里，供 node:test 锁行为。
import {
  advanceIndexProgress,
  advanceSearchProgress,
  beginIndexProgress,
  beginSearchProgress,
  highlightTerms,
  isAutoSearchable,
  isSearchIndexTrusted,
  searchEmptyAnnouncement,
  stableVersionOf,
  trimSearchQuery,
} from "@/lib/searchTerms";
import type { IndexProgressCursor, SearchProgressCursor } from "@/lib/searchTerms";
import { useToast } from "@/components/ui/toast";
import {
  acquireDataJob,
  dataJobConflictMessage,
  describeDataJob,
  useActiveDataJob,
} from "@/hooks/useDataSyncManager";
import { useBackHandler } from "@/hooks/useBackHandler";

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
/**
 * 缓存键与后端 `INDEX_VERSION` 同步升级：缓存按数据 commit（stableVersionOf）命中，
 * 但 parser/索引语料变了而 commit 没变时（如 INDEX_VERSION 8→9 修复行尾 `\`
 * 续行拼接、全角标点残渣），旧缓存仍会命中脏结果。此时必须换 key 让旧条目
 * 自然失效（不再读取即被遗弃），否则用户要清站点数据才能看到正确结果。
 */
const CACHE_KEY = "arknights-story-search-cache-v4";
const SEGMENT_CACHE_KEY = "arknights-story-segment-cache-v3";
const DEBUG_STATE_KEY = "arknights-story-search-debug";
const SEARCH_MODE_KEY = "arknights-story-search-mode";

const HISTORY_LIMIT = 10;
const CACHE_LIMIT = 40;

/** 已经有结果、用户在改词：给足停顿时间再发请求。 */
const AUTO_DEBOUNCE_MS = 320;
/** 空面板里敲下的第一个词：延迟压到一眼看不出来的量级，别让首字发木。 */
const AUTO_DEBOUNCE_FIRST_MS = 140;
/** 本地缓存里已经有答案：几乎零成本，跟着输入走就行。 */
const AUTO_DEBOUNCE_CACHED_MS = 60;
/** 后台索引事件超过一分钟无更新，UI 不再把它当作仍在构建。 */
const INDEX_PROGRESS_STALE_MS = 60_000;

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
  // 带 caption 的插画段也在段级索引里（搜 caption 文字就会命中），
  // 不补这条它会在一排中文标签里显示成大写英文 "IMAGE"。
  image: "插画",
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
 * 重建收场广播。事件名复用 useAutoIndex 已有的 `app:story-index-updated`，
 * detail 形状也保持一致，只是 reason 标出成败（rebuilt / rebuild-failed）。
 * 设置页发起的重建（`app:rebuild-story-index` 路径）由设置页拿着 "index"
 * 任务锁：它靠这条广播在重建结束的瞬间放锁，而不是干等 30s 看门狗——
 * 尤其是重建一启动就失败、后端一条 index-progress 都没发的情况。
 */
function dispatchIndexRebuildFinished(succeeded: boolean, status: StoryIndexStatus | null) {
  try {
    window.dispatchEvent(
      new CustomEvent("app:story-index-updated", {
        detail: {
          ready: status?.ready ?? false,
          total: status?.total ?? 0,
          reason: succeeded ? "rebuilt" : "rebuild-failed",
        },
      })
    );
  } catch {
    /* ignore */
  }
}

function optionDomId(index: number): string {
  return `search-result-option-${index}`;
}

// ─────────────────────────────────────────────────────────
// 关键词高亮
// ─────────────────────────────────────────────────────────

type Highlighter = (text: string | null | undefined) => React.ReactNode;

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
      // 旧条目存的是带相对时间的完整版本串，这里归一化成 commit 部分，
      // 让升级前落盘的缓存也能继续命中。
      const entryVersion = stableVersionOf(entry.version);
      // 空版本条目是旧版本在 get_current_version 返回前就落盘的产物：
      // 它会在下个会话同样的空版本窗口期被误判为有效缓存，直接丢弃。
      // stableVersionOf 折叠掉的假身份版本（"manual-"、"unknown"、哨兵
      // 文案，见其注释）也在这里归零被丢：那些条目无法证明对应哪份数据。
      if (!entryVersion) continue;
      out[cacheKey] = { ...entry, version: entryVersion } as T;
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
  /** 不只本面板：同步/导入后的后台重建也会通过 index-progress 点亮。 */
  const [indexProgressActive, setIndexProgressActive] = useState(false);
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
  /** 用户显式取消的查询；错误、空态、进度与取消不能混成同一种“没结果”。 */
  const [cancelledQuery, setCancelledQuery] = useState<string | null>(null);
  /** 软键盘出现时收起非必要头部信息，给结果列表保留真实可视高度。 */
  const [keyboardOpen, setKeyboardOpen] = useState(false);

  const moreMenuRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  // 输入法组合中：Enter 只是确认候选词，不该触发搜索。
  const composingRef = useRef(false);
  // 生成号：每次发起搜索 +1，输入变化 / 清空 / 换数据版本时也 +1。
  // Tauri 的 invoke 没有 abort，只能靠它让迟到的旧结果失去写状态的资格。
  const searchSeqRef = useRef(0);
  /** 全局 search-progress 没有 requestId；用精确起点 + 数据代际做归属门禁。 */
  const searchProgressCursorRef = useRef<SearchProgressCursor | null>(null);
  /**
   * 版本获取的生成号。挂载时和每次 `app:data-updated` 都会各发一次
   * getCurrentVersion，invoke 不保证按序返回：数据更新后若挂载那次（或上
   * 一轮更新的那次）响应迟到，会把旧 commit 写回 version——之后新数据的
   * 搜索结果全按旧版本落缓存，数据一旦再回滚到那个 commit，这批错标条目
   * 就成了脏命中。每次数据更新 +1，写 version 前必须核对生成号；搜索开头
   * 的补取成功落值时也 +1（占住本代），让更早发出、仍在途的同代请求——
   * 尤其挂载那次迟到才失败的 catch——失去写回资格。
   */
  const versionSeqRef = useRef(0);
  /**
   * 索引状态的生成号，堵的是与 versionSeqRef 同一威胁模型（invoke 不保证
   * 按序返回）下的另一半窗口：`app:data-updated` 把 ready 掰成 false 后，
   * 换包前就已在途的 getStoryIndexStatus（挂载 / app:story-index-updated
   * 广播 / index-progress 终态都会触发 refreshIndexStatus）若此刻才返回，
   * 带回的是旧库的 ready=true，会把刚掰下去的 flip 原样撤销——毒化窗口
   * 重新放行自动搜与 indexTrusted，而此时 version 补取拿到的已是新
   * commit，空页/残缺页照样按新版本落缓存。每次数据更新 +1，落
   * indexStatus 前核对；换包后发出的新查询代际相同，照常落值。
   */
  const indexStatusSeqRef = useRef(0);
  /** 搜索从发起到落地期间只要出现过一次索引失信，就禁止写缓存/假空回退。 */
  const indexTrustSeqRef = useRef(0);
  /** 数据每换一次代际 +1；旧包迟到的 index-progress 无权进入新 UI。 */
  const indexProgressEpochRef = useRef(0);
  const indexProgressCursorRef = useRef<IndexProgressCursor | null>(null);
  const indexProgressStaleTimerRef = useRef<number | null>(null);
  const searchingRef = useRef(false);
  /**
   * 在途搜索查的词、模式、是否自动触发、成功后是否写历史：防抖 effect 与
   * 回车去重靠它识别"同一条已经在路上"；索引就绪上升沿的补搜靠它把在途
   * 那条按原语义（尤其是否写历史）重发，而不是错发成更早的 lastQuery。
   */
  const inFlightRef = useRef<{
    mode: SearchMode;
    query: string;
    auto: boolean;
    recordsHistory: boolean;
  } | null>(null);
  /** 上一次落定失败的 `${mode}:${query}`（手动/自动都记），避免防抖 effect 反复重试同一个错误。 */
  const autoFailedRef = useRef<string | null>(null);
  const rowRefs = useRef(new Map<number, HTMLButtonElement>());
  /** 结果列表的滚动视口；换查询/换模式后要把它归顶。 */
  const resultsViewportRef = useRef<HTMLDivElement | null>(null);
  /** 本面板发起/承接的重建在途；state 落地前就要能拦住重复触发。 */
  const buildingIndexRef = useRef(false);

  const toast = useToast();
  const activeDataJob = useActiveDataJob();
  /**
   * 任务锁被本面板之外的任务占着（同步 / 导入 / 自动重建 / 安装更新）：
   * 重建入口要禁用，并且说明现在是谁占着，而不是只把按钮灰掉。
   */
  const indexBusy = buildingIndex || indexProgressActive;
  const indexJobBlockedBy = activeDataJob !== null && !buildingIndex ? activeDataJob : null;

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

  const indexReady = isSearchIndexTrusted(indexStatus, indexBusy);
  /**
   * 索引"还没有"和"搜不到"是两回事，空结果的文案要靠它分流。状态尚未
   * 返回或查询失败同样没有可信索引，不能反过来宣称空页是权威零命中。
   */
  const indexPending = !indexReady;

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
    searchProgressCursorRef.current = null;
    if (!searchingRef.current) return;
    searchingRef.current = false;
    setSearching(false);
    setProgress(null);
  }, []);

  // Load version for cache keying.
  useEffect(() => {
    const token = versionSeqRef.current;
    void api
      .getCurrentVersion()
      .then((v) => {
        if (token === versionSeqRef.current) setVersion(stableVersionOf(v));
      })
      .catch(() => {
        // 失败也要过生成号：迟到的失败不能把 data-updated 刚取到的新值清空。
        if (token === versionSeqRef.current) setVersion("");
      });
  }, []);

  useEffect(() => {
    const onUpdated = () => {
      // 数据整个换了，在途的那次搜索查的还是旧库。不作废的话它回来时会被
      // 当成新版本的结果写进缓存，之后一直拿旧数据糊弄用户。
      invalidateInFlight();
      const token = ++versionSeqRef.current;
      setCache({});
      setSegmentCache({});
      // 旧包的索引进度即使稍后才穿过事件总线，也不能点亮新包的 UI。
      indexProgressEpochRef.current += 1;
      indexProgressCursorRef.current = null;
      if (indexProgressStaleTimerRef.current !== null) {
        window.clearTimeout(indexProgressStaleTimerRef.current);
        indexProgressStaleTimerRef.current = null;
      }
      setIndexProgress(null);
      setIndexProgressActive(false);
      // 索引状态也要立刻掰成未就绪，不能等 useAutoIndex 约 3 秒后的广播：
      // 后端 sync_data / import_zip 在换完数据的同一步就把索引库整个删了
      // （clear_story_index 在命令返回前执行），事件到达时 ready 事实上已是
      // false。残留的 ready=true 会在这个窗口里放行两条明确禁止的路径：
      // 自动搜打在无索引的退化路径上（段落＝空页、整篇＝逐篇扫描），以及
      // indexTrusted 误判可信——此时补取到的 version 已是新 commit，段落
      // 空页按它进缓存就把查询钉死在"零命中改搜整篇"，整篇残缺页还会落盘，
      // 而就绪上升沿只补 lastQuery 一条，窗口里搜过的其他词永久毒化。
      // 置 false 后由重建收场的 app:story-index-updated / index-progress
      // 终态照常把状态刷回来。代际号先 +1：换包前在途的 getStoryIndexStatus
      // 响应描述的是旧库，迟到落地会把这个 flip 原样撤销（见 ref 注释）。
      indexStatusSeqRef.current += 1;
      indexTrustSeqRef.current += 1;
      // 不能保留 null（“尚在确认”）或旧 total：app:data-updated 到达时数据
      // 已经换入、后端也已清掉旧索引，此刻有充分证据明确标成未就绪。
      setIndexStatus({ ready: false, total: 0, lastBuiltAt: null });
      setIndexError(null);
      // version 必须立刻清空，不能等 getCurrentVersion 回来再改：事件到达时
      // 数据已经换成新 commit，等待期间（以及取失败后的无限期）旧 commit 若
      // 继续留在 state 里，此时发起的搜索查的是新库、落缓存却按旧版本记账
      // ——手动搜还会写进 localStorage，数据一旦回滚到旧 commit 就成了跨
      // 会话的脏命中。清空后这段窗口期按"无版本"处理：缓存整体停用，开搜
      // 时自行补取，拿到的必然是换库后的新值。
      setVersion("");
      void api
        .getCurrentVersion()
        .then((v) => {
          if (token === versionSeqRef.current) setVersion(stableVersionOf(v));
        })
        // 失败不用再写状态：version 已在上面清空、缓存已停用，之后每次
        // 搜索开头的补取就是自然重试，成功即恢复。
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
    /** 不写搜索历史：切模式触发的重搜可能带着输入框里打到一半的词。 */
    skipHistory?: boolean;
    /** 防抖自动触发：不写历史、不自动改模式，失败也不弹 toast。 */
    auto?: boolean;
  }): Promise<void> => {
    const raw = trimSearchQuery(opts?.queryOverride ?? query);
    if (!raw) return;
    const activeMode = opts?.modeOverride ?? mode;
    const auto = opts?.auto === true;

    // 同词同模式的搜索已经在路上：重复回车只会作废在途请求、让后端再叠跑
    // 一遍同样的查询（索引未就绪时是好几秒的全量扫描），进度还会被清零。
    // 在途是手动搜（或本次就是自动搜）时直接吞掉；在途是自动搜而本次是
    // 手动才放行重发——写历史、零命中回退这些手动语义自动搜给不了。
    if (
      !opts?.forceRefresh &&
      searchingRef.current &&
      inFlightRef.current?.query === raw &&
      inFlightRef.current.mode === activeMode &&
      (!inFlightRef.current.auto || auto)
    ) {
      return;
    }

    // 自动搜索绝不把用户"打到一半"的词写进历史，也不擅自把模式掰回整篇。
    const allowFallback = !opts?.noFallback && !auto;
    const commitQuery = () => {
      setLastQuery(raw);
      if (!auto && !opts?.skipHistory) saveHistory(raw);
    };
    // 发起这一刻索引是否可信。重建中 / 未建好时后端走的是退化路径（整篇＝
    // 线性扫描、段落＝直接返回空页），这种结果不能按版本写缓存：重建不改
    // 数据版本，一旦落进缓存，索引建好后同一查询仍会永远命中这份残缺结果
    // ——段落模式表现为永远"零命中自动改搜整篇"。
    const indexTrusted = indexReady;
    const indexTrustToken = indexTrustSeqRef.current;
    const indexStillTrusted = () =>
      indexTrusted && indexTrustToken === indexTrustSeqRef.current;

    const seq = ++searchSeqRef.current;
    const isStale = () => seq !== searchSeqRef.current;
    const settle = () => {
      if (isStale()) return;
      searchingRef.current = false;
      inFlightRef.current = null;
      searchProgressCursorRef.current = null;
      setSearching(false);
      setProgress(null);
    };

    // facet 只在真的换了结果集（换词 / 换模式）时清。同一条查询的强制重搜
    // ——索引重建收场的自动补搜、「刷新缓存」、失败重试——是原地换数据，
    // 用户手选的分类筛选必须留着：补搜由后台触发，用户没碰任何东西，正在
    // 浏览的筛选列表不能突然膨胀回全量。新结果若不再含该分类，下面结果
    // 落地处会对账清掉，不会留下看不见的僵尸筛选。
    const sameResultSet = raw === lastQuery && activeMode === mode;
    // 结果落地后按新页的 facets 对账：保留的 facet 若在新结果里已不存在
    // （例如切进调试模式后 facets 恒为空），继续挂着会把列表过滤成空、
    // 而"清除筛选"按钮又只在 facet 区渲染时才有，用户会被困在空列表里。
    const reconcileFacet = (facets: Record<string, number> | undefined) => {
      setActiveFacet((prev) => (prev !== null && (facets?.[prev] ?? 0) > 0 ? prev : null));
    };

    autoFailedRef.current = null;
    inFlightRef.current = {
      mode: activeMode,
      query: raw,
      auto,
      recordsHistory: !auto && !opts?.skipHistory,
    };
    setSearching(true);
    searchingRef.current = true;
    searchProgressCursorRef.current = null;
    setSearchError(null);
    setCancelledQuery(null);
    if (!sameResultSet) setActiveFacet(null);
    setActiveIndex(-1);
    // 还没收到后端进度事件之前保持 total = 0：UI 走不确定态 spinner，
    // 而不是显示一条永远停在 0% 的假进度条。
    setProgress({ phase: "搜索中", current: 0, total: 0, message: "" });

    try {
      // 段级搜索没有调试输出，但调试记录的渲染条件只看 debugLogs 非空、
      // 不看模式：从整篇切到段落时，上一轮整篇搜索的调试记录会挂在段落
      // 结果（乃至请求在途的等待期）上冒充本次日志。必须清在下面版本补取
      // 的 await 之前，而不是进段落分支才清：数据更新会立刻清空 version，
      // 其后的段搜常态化地先等一次 getCurrentVersion 才进分支（补取失败
      // 时还要等到 searchSegments 返回），清晚了旧日志就在这整段等待期里
      // 顶着段搜的加载态照常展示。
      if (activeMode === "segment") {
        setDebugLogs([]);
        setDebugExpanded(false);
      }
      // 挂载时的 getCurrentVersion 可能失败过一次，version 会停在空串，
      // 缓存就整个会话都不可用。真正开搜这一刻补取一次（同样只留稳定的
      // commit 前缀）：成功就把 version 落回 state，本次搜索立刻能用缓存；
      // 仍失败则照旧按无版本处理（不读不写缓存），不阻塞搜索本身。
      let activeVersion = version;
      if (!activeVersion) {
        try {
          activeVersion = stableVersionOf(await api.getCurrentVersion());
        } catch (err) {
          devLog("补取数据版本失败", err);
        }
        // 先验过期再写回 state：等待期间若数据整个换掉（onUpdated 的
        // invalidateInFlight 已把本次作废），这份响应对应的是旧库，写进
        // version 会盖掉刚取到的新值，后续搜索全按旧版本读写缓存。
        if (isStale()) return;
        if (activeVersion) {
          // 落值前占住版本生成号：挂载那次 getCurrentVersion 可能仍在途，
          // token 相同拦不住它——若它之后才失败，catch 会把这里刚补到的
          // 值清回空串，缓存又整段停用。本响应比一切更早发出的同代请求
          // 新鲜，+1 让它们全部失去写回资格（onUpdated 若已发生，上面的
          // isStale 早就拦下本次，不存在反向覆盖新代 token 的可能）。
          versionSeqRef.current += 1;
          setVersion(activeVersion);
        }
      }

      if (activeMode === "segment") {
        // version 还没就绪（getCurrentVersion 未返回或失败）时缓存整体停用：
        // 空串没法证明缓存对应的是当前这份数据。
        const cached = opts?.forceRefresh || !activeVersion ? undefined : segmentCache[raw];
        if (cached && cached.version === activeVersion) {
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

        searchProgressCursorRef.current = beginSearchProgress(
          "segment",
          raw,
          versionSeqRef.current
        );
        const data = await api.searchSegments(raw);
        if (isStale()) return;
        setSegmentPage(data);
        setPage(null);
        setFromCache({ used: false });
        setSearched(true);
        commitQuery();

        // version 没就绪前一律不写缓存：记在空版本下的条目在真实版本落地后
        // 永远不再命中，落盘后还会污染下个会话的空版本窗口期。
        // 索引不可信（重建中 / 未建好）时同样不写：此时后端返回的空页不是
        // "真的没有"，缓存住它等于把这条查询永久钉死在回退路径上。
        if (activeVersion && indexStillTrusted()) {
          const nextCache = prune({
            ...segmentCache,
            [raw]: { page: data, updatedAt: Date.now(), version: activeVersion },
          });
          setSegmentCache(nextCache);
          // 边打边搜的中间结果只进内存：跨会话留着「凯」「凯尔」这种半截查询
          // 没有意义，而每次落盘都要把整张表 stringify 一遍。
          if (!auto) persistSegmentCache(nextCache);
        }
        settle();

        // 回退门槛与写缓存同一把尺（indexTrusted）：索引不可信时这个空页
        // 是退化路径伪造的"零命中"，不是真的没有。拿它触发回退，等于弹一条
        // "段级索引暂无命中"的错话、擅自把用户刚选的段落模式掰回整篇，再
        // 发起一次数秒级的整篇线性扫描——而专为此场景准备的空状态
        // （renderEmptyState 的 indexPending 分支：说明索引没建好 + 建立
        // 入口）反而永远轮不到展示。不回退时索引就绪的上升沿会按原模式把
        // 这条查询补搜完整，真零命中再交给空状态里的"改搜整篇"按钮。
        // 上面缓存命中分支的回退不受此限：能进缓存的零命中都是索引可信时
        // 写下的，是真零命中。
        if (data.hits.length === 0 && allowFallback && indexStillTrusted()) {
          await fallbackToStory(raw);
        }
        return;
      }

      // 同段落模式：version 为空时缓存既不可读也不可写。
      if (!opts?.forceRefresh && !debugMode && activeVersion) {
        const cached = cache[raw];
        if (cached && cached.version === activeVersion) {
          setPage(cached.page);
          setSegmentPage(null);
          reconcileFacet(cached.page.facets);
          setSearched(true);
          setFromCache({ used: true, updatedAt: cached.updatedAt });
          commitQuery();
          if (!auto) writeJson(CACHE_KEY, cache);
          settle();
          return;
        }
      }

      if (debugMode) {
        // 调试命令不发 search-progress，避免上一条普通搜索的迟到事件冒充它。
        searchProgressCursorRef.current = null;
        const data = await api.searchStoriesDebug(raw);
        if (isStale()) return;
        setPage({
          results: data.results,
          totalMatched: data.results.length,
          truncated: false,
          facets: {},
        });
        setSegmentPage(null);
        reconcileFacet({});
        setDebugLogs(data.logs);
        setDebugExpanded(true);
        setFromCache({ used: false });
      } else {
        searchProgressCursorRef.current = beginSearchProgress(
          "story",
          raw,
          versionSeqRef.current
        );
        const data = await api.searchStoriesEx(raw);
        if (isStale()) return;
        setPage(data);
        setSegmentPage(null);
        reconcileFacet(data.facets);
        setDebugLogs([]);
        setDebugExpanded(false);
        // 索引不可信时这是线性扫描的结果（总数不准、可能不完整），只展示
        // 不缓存，等索引建好后重搜才能拿到并缓存完整结果。
        if (activeVersion && indexStillTrusted()) {
          const nextCache = prune({
            ...cache,
            [raw]: { page: data, updatedAt: Date.now(), version: activeVersion },
          });
          setCache(nextCache);
          if (!auto) writeJson(CACHE_KEY, nextCache);
        }
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
      // 调试记录同理：面板不带查询名，上一条查询的匹配日志留在这条查询的
      // 错误卡旁边，会被当成本次失败的过程记录来读。
      setDebugLogs([]);
      setDebugExpanded(false);
      // 手动失败也记同一把钥匙：searchError 可能被别的路径清掉（比如切模式），
      // 这条 ref 是防抖 effect 不再替用户偷偷重发的最后一道闸。
      autoFailedRef.current = `${activeMode}:${raw}`;
      if (!auto) {
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
    // 首次搜索还没落定时 searched 仍是 false：不先记下"在途"标记，切模式会把
    // 用户刚按下的那次搜索静默吞掉（索引未就绪时自动搜也不会兜底），界面直接
    // 安静下来，像是搜索被按钮弄丢了。
    const wasSearching = searchingRef.current;
    // 首次搜索已落定失败时 searched 同样是 false：下面的 setSearchError(null)
    // 会把错误卡片清掉，若不在新模式重发这条查询，点模式按钮的全部效果就是
    // 错误提示凭空消失、面板退回语法说明——失败后换个粒度再试的意图被吞掉。
    const hadFailure = searchError !== null;
    invalidateInFlight();
    setMode(next);
    setActiveFacet(null);
    setActiveIndex(-1);
    setSearchError(null);
    setCancelledQuery(null);
    const pending = trimSearchQuery(query) || lastQuery;
    // 手动切模式时不自动回退，否则刚点"段落"就被弹回"整篇"，像是按钮失灵。
    // 也不写历史：pending 可能是输入框里打到一半、只被自动搜碰过的词，
    // 用户真正回车过的词早在那次手动搜索时就进了历史。
    if ((searched || wasSearching || hadFailure) && pending) {
      void handleSearch({
        queryOverride: pending,
        modeOverride: next,
        noFallback: true,
        skipHistory: true,
      });
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
      // 标题伪命中没有真实 segmentIndex，不能硬跳 0；但也不能绕开
      // jump-to-search。阅读器已把 header 纳入 findFocusSegmentIndex，
      // 用标题 preview 精确定位真实 header，匹配不到才恢复旧阅读进度。
      if (hit.matchTarget === "title") {
        onSelectResult(story, {
          query: lastQuery || query,
          snippet: hit.matchedText || hit.storyName,
        });
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
    setCancelledQuery(null);
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

  const cancelActiveSearch = () => {
    if (!searchingRef.current) return;
    const cancelled = inFlightRef.current?.query ?? trimSearchQuery(query);
    invalidateInFlight();
    setAutoPending(false);
    setCancelledQuery(cancelled || "当前查询");
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

  const refreshIndexStatus = useCallback(async (): Promise<StoryIndexStatus | null> => {
    // 每次请求都占一个新代际：不只防换包，连同一数据代内并发的“终态事件
    // 刷新 / 收场刷新”也必须只让最后发出的那次落地。
    const token = ++indexStatusSeqRef.current;
    try {
      const status = await api.getStoryIndexStatus();
      // 等待期间数据整个换掉：这份状态描述的是旧库，ready=true 落地会把
      // onUpdated 刚掰下去的未就绪 flip 撤销。丢弃写入，换包后的事件链
      // （app:story-index-updated 广播 / index-progress 终态）会以新代际
      // 重查。返回 null 而不是旧状态，免得调用方拿它当现状广播出去。
      if (token !== indexStatusSeqRef.current) return null;
      if (!status.ready) indexTrustSeqRef.current += 1;
      setIndexStatus(status);
      setIndexError(null);
      return status;
    } catch (err) {
      devLog("获取索引状态失败", err);
      // 迟到的失败同样无权写状态：错误横幅描述的必须是当前数据的状态查询。
      if (token !== indexStatusSeqRef.current) return null;
      indexTrustSeqRef.current += 1;
      setIndexError("获取索引状态失败");
      setIndexStatus(null);
      return null;
    }
  }, []);

  /**
   * 重建主体，不负责抢锁：`app:rebuild-story-index` 事件路径的锁由派发方
   * （设置页先 acquireDataJob("index") 再派发）持有，这里再抢一次必然失败；
   * 面板内按钮走下面的 handleBuildIndex，由它抢锁后再进来。
   * 无论成败，收场时都会广播 `app:story-index-updated`（reason 标出成败），
   * 设置页靠它在重建结束的第一时间释放 "index" 任务锁。
   */
  const runBuildIndex = useCallback(async () => {
    // 已经在建（比如设置页刚派发过事件）：重复跑只会让两次写库互相拖慢。
    if (buildingIndexRef.current) return;
    buildingIndexRef.current = true;
    indexTrustSeqRef.current += 1;
    const buildEpoch = indexProgressEpochRef.current;
    indexProgressCursorRef.current = beginIndexProgress(buildEpoch, true);
    setIndexError(null);
    setIndexMessage(null);
    // 同样先给不确定态；真实进度由挂载时注册的 index-progress 监听填。
    setIndexProgress({ phase: "准备", current: 0, total: 0, message: "" });
    setIndexProgressActive(true);
    let succeeded = false;
    let finalStatus: StoryIndexStatus | null = null;
    try {
      setBuildingIndex(true);
      await api.buildStoryIndex();
      finalStatus = await refreshIndexStatus();
      // invoke resolve 只说明后端函数返回了；COUNT/MATCH 失忆探针、换包竞态
      // 或状态 IPC 失败都可能让最终状态仍不可用。未拿到 ready=true 之前
      // 绝不能 toast“建立完成”，也不能给设置页广播成功终态。
      if (!finalStatus?.ready) {
        const message = finalStatus
          ? "索引重建结束，但完整性检查未通过，请重试"
          : "索引重建结束，但无法确认最终状态，请重试";
        setIndexError(message);
        toast.error(message);
        return;
      }
      succeeded = true;
      setIndexMessage("全文索引建立完成");
      toast.success("全文索引建立完成");
    } catch (err) {
      devLog("建立索引失败", err);
      setIndexError("建立索引失败，请重试");
      toast.error("建立索引失败");
    } finally {
      buildingIndexRef.current = false;
      setBuildingIndex(false);
      if (buildEpoch === indexProgressEpochRef.current) {
        indexProgressCursorRef.current = null;
        setIndexProgress(null);
        setIndexProgressActive(false);
      }
      // 失败也要广播：设置页那头正拿着锁等结果，收不到终态就只能吊到
      // 看门狗超时，期间同步 / 导入 / 更新的入口全被白白锁住。
      dispatchIndexRebuildFinished(succeeded, finalStatus);
    }
  }, [refreshIndexStatus, toast]);

  /**
   * 面板内的「重建 / 立即建立 / 刷新索引」入口：必须先抢全局任务锁再动手，
   * 否则重建会和同步 / 导入同时写数据目录。抢不到时说明是谁占着，
   * 用和设置页一致的话术。锁不派发 `app:rebuild-story-index`——那个事件
   * 会被本组件自己的监听器接住变成二次触发；useAutoIndex 那边靠这把锁
   * 和后端 index-progress 就能正确让路，不需要额外通知。
   */
  const handleBuildIndex = useCallback(async () => {
    if (buildingIndexRef.current) return;
    const releaseJob = acquireDataJob("index");
    if (!releaseJob) {
      const message = dataJobConflictMessage("重建索引");
      setIndexError(message);
      toast.warn(message);
      return;
    }
    try {
      await runBuildIndex();
    } finally {
      releaseJob();
    }
  }, [runBuildIndex, toast]);

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
    const raw = trimSearchQuery(query);
    const cancel = () => setAutoPending(false);

    if (composing || debugMode || !indexReady) return cancel();
    if (!isAutoSearchable(raw)) return cancel();
    // 已经就是当前展示的结果，或者刚刚自动搜失败过，都别再发一遍。
    if (raw === lastQuery && searched && !searchError) return cancel();
    if (autoFailedRef.current === `${mode}:${raw}`) return cancel();
    // 当前词已经落定失败（手动回车失败也算）：自动重试只会把失败态冲掉再挂一次。
    // 用户按回车走 handleSearch，开头就清 searchError，手动重试不受影响。
    if (searchError?.query === raw) return cancel();
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

  // 索引就绪的上升沿补搜。用户在重建中 / 索引未建好时回车，拿到的是退化
  // 结果（整篇＝线性扫描残缺页、段落＝空页），且按 indexTrusted 门槛没写
  // 缓存；等索引变 ready 后，上面防抖 effect 的
  // 「raw === lastQuery && searched && !searchError」守卫会认为结果已落定
  // 而跳过重搜，界面就一直停在残缺/空结果。这里用 ref 记住上一拍的
  // indexReady，只在 false→true 的瞬间、且已有落定查询时补发一次：
  // forceRefresh 绕过缓存与在途去重拿新鲜结果，skipHistory 不污染历史
  // ——这不是用户的新搜索，只是把上次那条查询搜完整。
  const prevIndexReadyRef = useRef(indexReady);
  useEffect(() => {
    const rose = !prevIndexReadyRef.current && indexReady;
    prevIndexReadyRef.current = indexReady;
    if (!rose) return;
    // 两条硬规则：
    //   1. 上升沿时若还有在途搜索，它才是用户最新的意图（比如重建期间对
    //      新词回车强搜、线性扫描跑了几秒还没回来）。此时按 lastQuery 补搜
    //      会把在途那条作废，屏幕落回"上一条查询"的结果——输入框和结果
    //      对不上号；不满足自动搜条件的词（如单字）还永远补不回来。所以
    //      改成把在途那条本身 forceRefresh 重发：词、模式、写不写历史都
    //      沿用它自己的语义。
    //   2. 一律 noFallback：这是系统发起的补搜，不是用户回车。让它触发
    //      "段落零命中自动改搜整篇"，等于后台重建一结束就擅自把用户刚选
    //      的模式掰回去——和自动搜"不擅自改模式"的规则保持一致，零命中
    //      交给空状态里的"改搜整篇"按钮。
    const inFlight = searchingRef.current ? inFlightRef.current : null;
    if (inFlight) {
      void handleSearchRef.current({
        queryOverride: inFlight.query,
        modeOverride: inFlight.mode,
        forceRefresh: true,
        skipHistory: !inFlight.recordsHistory,
        noFallback: true,
      });
      return;
    }
    if (!searched || !lastQuery) return;
    void handleSearchRef.current({
      queryOverride: lastQuery,
      forceRefresh: true,
      skipHistory: true,
      noFallback: true,
    });
  }, [indexReady, searched, lastQuery]);

  // 结果集换了就取消选中：行号对应的已经是另一批内容了。
  // 引用表不用在这里清——行卸载时 ref 回调会带着 null 回来自己删。
  useEffect(() => {
    setActiveIndex(-1);
  }, [page, segmentPage, activeFacet, mode]);

  // 换了查询或模式就把结果列表滚回顶部：视口是常驻的，沿用旧结果的滚动
  // 偏移，新列表会直接从半腰、甚至被浏览器夹到的末尾开始看，且没有任何
  // "你不在顶部"的提示（StoryList / CharactersPanel 在同类场景都归顶）。
  // 只按「模式 + 已落定查询」的签名判断：同一条查询的补搜 / 刷新缓存是
  // 原地换数据，签名不变，KeepAlive 保住的阅读位置不动。lastQuery 在结果
  // 落地时才更新，所以归顶发生在新内容渲染之后，不会被旧高度夹住。
  // instant 覆盖视口上的 CSS smooth，免得新结果先渲染再慢慢滚回顶。
  const resultsScrollKey = `${mode}\n${lastQuery}`;
  const prevResultsScrollKeyRef = useRef(resultsScrollKey);
  useEffect(() => {
    if (prevResultsScrollKeyRef.current === resultsScrollKey) return;
    prevResultsScrollKeyRef.current = resultsScrollKey;
    resultsViewportRef.current?.scrollTo({ top: 0, behavior: "instant" });
  }, [resultsScrollKey]);

  // 选中行滚进可视区。`nearest` 只在真的看不见时才动，键盘浏览不会一路乱跳。
  useEffect(() => {
    if (activeIndex < 0) return;
    rowRefs.current.get(activeIndex)?.scrollIntoView({ block: "nearest" });
  }, [activeIndex]);

  // iOS/WKWebView 多数只缩 visualViewport，Android resize 模式则可能连
  // innerHeight 一起缩。两种信号合并判断；键盘出现时只压缩搜索页自己的
  // 非必要头部，不改全局视口/底栏定位，结果列表仍是唯一可滚区域。
  useEffect(() => {
    const viewport = window.visualViewport;
    if (!viewport) return;
    let baselineHeight = viewport.height;
    let frame = 0;
    const update = () => {
      frame = 0;
      const focused = document.activeElement === inputRef.current;
      if (!focused) {
        baselineHeight = viewport.height;
        setKeyboardOpen(false);
        return;
      }
      const occluded = Math.max(0, window.innerHeight - viewport.height - viewport.offsetTop);
      setKeyboardOpen(occluded > 100 || baselineHeight - viewport.height > 100);
    };
    const schedule = () => {
      if (frame) cancelAnimationFrame(frame);
      frame = requestAnimationFrame(update);
    };
    viewport.addEventListener("resize", schedule);
    viewport.addEventListener("scroll", schedule);
    window.addEventListener("focusin", schedule);
    window.addEventListener("focusout", schedule);
    return () => {
      viewport.removeEventListener("resize", schedule);
      viewport.removeEventListener("scroll", schedule);
      window.removeEventListener("focusin", schedule);
      window.removeEventListener("focusout", schedule);
      if (frame) cancelAnimationFrame(frame);
    };
  }, []);

  // 唯一的播报口径：只在搜索落定后说一句话。搜索中交给 aria-busy，
  // 进度条和状态条都不再挂 live 区域，否则每个进度事件都要念一遍。
  useEffect(() => {
    if (searching) return;
    if (cancelledQuery) {
      setAnnouncement(`已取消「${cancelledQuery}」的搜索`);
      return;
    }
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
    } else {
      // `indexPending` 在 status == null 时也为 true，但这只说明尚未确认；
      // 播报必须与可见空态一样先分出“正在确认”，不能暗中宣称索引缺失。
      setAnnouncement(
        indexStatus == null && indexError
          ? `${scope}无法确认索引状态，当前空页不是权威零命中`
          : `${scope}${searchEmptyAnnouncement(indexStatus, indexBusy)}`
      );
    }
  }, [
    searching,
    cancelledQuery,
    searched,
    searchError,
    hitCount,
    lastQuery,
    mode,
    indexStatus,
    indexError,
    indexBusy,
  ]);

  // 搜索进度：挂载时注册一次，卸载时解绑；只在真的在搜的时候写状态，
  // 免得上一次搜索的迟到事件把 spinner 又点亮。
  useEffect(() => {
    let dispose: (() => void) | null = null;
    let cancelled = false;
    void api
      .onSearchProgress((p) => {
        if (cancelled || !searchingRef.current) return;
        const cursor = searchProgressCursorRef.current;
        if (!cursor) return;
        const next = advanceSearchProgress(cursor, p, versionSeqRef.current);
        if (!next) return;
        searchProgressCursorRef.current = next;
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

  // 自动索引 hook 和本面板的重建收场都会派发 `app:story-index-updated`；
  // 这里监听一下把状态条刷成最新，不用再等用户手动切页。
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
        const epoch = indexProgressEpochRef.current;
        const cursor =
          indexProgressCursorRef.current ?? beginIndexProgress(epoch, false);
        const next = advanceIndexProgress(cursor, p, epoch);
        if (!next) return;
        if (!cursor.started && !next.terminal) indexTrustSeqRef.current += 1;
        indexProgressCursorRef.current = next;
        setIndexProgress(p);
        setIndexProgressActive(!next.terminal);
        if (indexProgressStaleTimerRef.current !== null) {
          window.clearTimeout(indexProgressStaleTimerRef.current);
          indexProgressStaleTimerRef.current = null;
        }
        if (next.terminal) {
          void refreshIndexStatus().finally(() => {
            if (
              indexProgressEpochRef.current === epoch &&
              indexProgressCursorRef.current === next &&
              !buildingIndexRef.current
            ) {
              setIndexProgress(null);
            }
          });
        } else {
          // 后端失败没有 index-progress 终态；超过停更窗就退出忙碌态并重查，
          // 不能让“建立中”与禁用按钮挂一整个会话。
          indexProgressStaleTimerRef.current = window.setTimeout(() => {
            if (
              indexProgressEpochRef.current !== epoch ||
              indexProgressCursorRef.current !== next
            ) {
              return;
            }
            indexProgressCursorRef.current = null;
            indexProgressStaleTimerRef.current = null;
            setIndexProgress(null);
            setIndexProgressActive(false);
            void refreshIndexStatus();
          }, INDEX_PROGRESS_STALE_MS);
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
      if (indexProgressStaleTimerRef.current !== null) {
        window.clearTimeout(indexProgressStaleTimerRef.current);
        indexProgressStaleTimerRef.current = null;
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
    try {
      localStorage.setItem(SEARCH_MODE_KEY, mode);
    } catch {
      /* ignore */
    }
  }, [mode]);

  // 设置页派发 `app:rebuild-story-index` 之前已经抢到了 "index" 任务锁
  // （见 Settings 的 handleRebuildIndex），所以这条路径直接进重建主体，
  // 不再抢锁——再抢必然失败，会把用户已确认的重建静默吞掉。
  useEffect(() => {
    const handler = () => {
      void runBuildIndex();
    };
    window.addEventListener("app:rebuild-story-index", handler);
    return () => window.removeEventListener("app:rebuild-story-index", handler);
  }, [runBuildIndex]);

  // 「⋯」菜单要占一层返回栈：Android 硬返回 / 浏览器手势返回本该先关掉
  // 这个浮层，但它是 role="menu" 而非 aria-modal 对话框，useBackHandler
  // 里的 DOM 兜底接不住——不注册的话返回会越过开着的菜单直接落到 App 的
  // tab 兜底，整个 tab 跳回首页；返回键又不产生 mousedown/Escape，
  // moreOpen 还留在 true，切回搜索页时菜单仍挂着。本面板没有 active
  // prop，菜单开着时面板可能被 KeepAlive 藏起来（祖先带 inert），这时
  // 绝不消费返回，否则首页的退出会被一个看不见的菜单吞掉。
  useBackHandler(moreOpen, () => {
    if (moreMenuRef.current?.closest("[inert]")) return false;
    setMoreOpen(false);
    return true;
  });

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
    if (indexBusy) {
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
    if (!indexStatus) {
      return indexError ? (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="text-xs text-[hsl(var(--color-destructive))]">
            无法确认索引状态，空结果暂不作数。
          </span>
          <button
            type="button"
            onClick={() => void refreshIndexStatus()}
            className="inline-flex min-h-[44px] items-center px-2 text-xs underline"
          >
            重试确认
          </button>
        </div>
      ) : (
        <div className="text-xs text-[hsl(var(--color-muted-foreground))]">索引状态获取中...</div>
      );
    }
    if (!indexStatus.ready) {
      return (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="text-xs text-[hsl(var(--color-muted-foreground))]">
            {indexJobBlockedBy === "index"
              ? "全文索引正在后台重建，完成后状态会自动刷新。"
              : indexJobBlockedBy
                ? `正在${describeDataJob(indexJobBlockedBy)}，需等它完成后才能建立全文索引。`
                : "全文索引尚未就绪：整篇搜索会退化成逐篇扫描，段落空页不作权威零命中；按回车仍可强制搜索。"}
          </div>
          <button
            type="button"
            onClick={() => void handleBuildIndex()}
            disabled={indexBusy || indexJobBlockedBy !== null}
            className="inline-flex min-h-[44px] items-center px-2 text-xs text-[hsl(var(--color-foreground))] underline disabled:opacity-50"
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
          {indexJobBlockedBy && ` · 正在${describeDataJob(indexJobBlockedBy)}`}
        </div>
        <button
          type="button"
          onClick={() => void handleBuildIndex()}
          disabled={indexBusy || indexJobBlockedBy !== null}
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
    if (indexStatus == null && indexError && !indexBusy) {
      return (
        <div className="mx-auto flex max-w-md flex-col items-center gap-3 rounded-lg border border-[hsl(var(--color-status-error)/0.5)] bg-[hsl(var(--color-status-error)/0.06)] p-6 text-center">
          <AlertTriangle className="h-6 w-6 text-[hsl(var(--color-status-error))]" aria-hidden="true" />
          <div className="text-sm font-medium">无法确认索引状态</div>
          <p className="text-xs leading-relaxed text-[hsl(var(--color-muted-foreground))]">
            当前空页不是权威零命中。请重新确认状态，或稍后再试。
          </p>
          <Button
            variant="outline"
            className="min-h-[44px]"
            onClick={() => void refreshIndexStatus()}
          >
            重试确认
          </Button>
        </div>
      );
    }
    // 状态还没回来：空页不可信，但不能假装已经确认「没有索引」。
    if (indexStatus == null && !indexBusy) {
      return (
        <div className="mx-auto flex max-w-md flex-col items-center gap-3 rounded-lg border border-dashed border-[hsl(var(--color-border))] p-6 text-center">
          <Loader2 className="h-6 w-6 animate-spin text-[hsl(var(--color-muted-foreground))]" aria-hidden="true" />
          <div className="text-sm font-medium">正在确认索引状态</div>
          <p className="text-xs leading-relaxed text-[hsl(var(--color-muted-foreground))]">
            还不能把空页当成搜不到，也还不能断定索引缺失。状态回来后会自动继续。
          </p>
        </div>
      );
    }
    if (indexPending) {
      return (
        <div className="mx-auto flex max-w-md flex-col items-center gap-3 rounded-lg border border-dashed border-[hsl(var(--color-border))] p-6 text-center">
          <Database className="h-6 w-6 text-[hsl(var(--color-muted-foreground))]" aria-hidden="true" />
          <div className="text-sm font-medium">全文索引还没准备好</div>
          <p className="text-xs leading-relaxed text-[hsl(var(--color-muted-foreground))]">
            {indexBusy
              ? "索引正在后台建立，完成后这条查询会更快、也更准。"
              : indexJobBlockedBy
                ? `正在${describeDataJob(indexJobBlockedBy)}，等它完成后即可建立索引。`
                : "还没有可用的全文索引，当前结果可能不完整。建好之后即可边输入边搜索。"}
          </p>
          <Button
            variant="outline"
            className="min-h-[44px]"
            disabled={indexBusy || indexJobBlockedBy !== null}
            onClick={() => void handleBuildIndex()}
          >
            {indexBusy ? (
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
      {indexPending && indexStatus != null && (
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
        {indexPending && !indexBusy && indexStatus != null && (
          <Button
            variant="outline"
            className="min-h-[44px]"
            disabled={indexJobBlockedBy !== null}
            onClick={() => void handleBuildIndex()}
          >
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
    <div className="h-full min-h-0 flex flex-col overflow-hidden">
      {/* 搜索栏 */}
      <header className="flex-shrink-0 z-10 bg-[hsl(var(--color-background)/0.95)] backdrop-blur border-b motion-safe:animate-in motion-safe:fade-in-0 motion-safe:duration-500">
        <div className={cn("container", keyboardOpen ? "py-2" : "py-4")}>
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
                  setCancelledQuery(null);
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
                className="pr-12 min-h-[44px] text-base pointer-fine:text-sm"
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
              onClick={() => (searching ? cancelActiveSearch() : void handleSearch())}
              disabled={!searching && !trimSearchQuery(query)}
              aria-busy={searching}
              className="min-h-[44px]"
            >
              {searching ? (
                <X className="mr-2 h-4 w-4" aria-hidden="true" />
              ) : (
                <Search className="mr-2 h-4 w-4" aria-hidden="true" />
              )}
              {searching ? "取消" : "搜索"}
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
                    disabled={indexBusy || indexJobBlockedBy !== null}
                    className="w-full min-h-[44px] rounded-sm px-2 py-2 text-left text-sm hover:bg-[hsl(var(--color-accent))] disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    <div>刷新索引</div>
                    <div className="text-[11px] text-[hsl(var(--color-muted-foreground))]">
                      {indexJobBlockedBy
                        ? `正在${describeDataJob(indexJobBlockedBy)}，暂不可用`
                        : indexStatus?.ready
                          ? "重新建立全文索引"
                          : "建立全文索引"}
                    </div>
                  </button>
                </div>
              )}
            </div>
          </div>

          {/* 搜索模式切换：整篇 vs 段落 */}
          <div
            className="mt-3 inline-flex max-w-full overflow-x-auto rounded-full border border-[hsl(var(--color-border))] p-0.5 [scrollbar-width:none]"
            role="group"
            aria-label="搜索粒度"
          >
            <button
              type="button"
              aria-pressed={mode === "story"}
              onClick={() => switchMode("story")}
              className={cn(
                "flex min-h-[44px] flex-shrink-0 items-center gap-1 rounded-full px-4 text-xs transition-colors",
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
                "flex min-h-[44px] flex-shrink-0 items-center gap-1 rounded-full px-4 text-xs transition-colors",
                mode === "segment"
                  ? "bg-[hsl(var(--color-primary))] text-[hsl(var(--color-primary-foreground))]"
                  : "text-[hsl(var(--color-muted-foreground))] hover:text-[hsl(var(--color-foreground))]"
              )}
            >
              <MessageSquare className="h-3.5 w-3.5" />
              段落
            </button>
          </div>

          {!keyboardOpen && history.length > 0 && (
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

          {!keyboardOpen && <div className="mt-3">{renderIndexStatusRow()}</div>}

          {!keyboardOpen && indexBusy && indexProgress && indexProgress.total > 0 && (
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

          {!keyboardOpen && fromCache.used && (
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
          {!keyboardOpen && indexError && indexStatus != null && (
            <div className="mt-2 text-xs text-[hsl(var(--color-destructive))]">{indexError}</div>
          )}
          {!keyboardOpen && indexMessage && (
            <div className="mt-2 text-xs text-[hsl(var(--color-muted-foreground))]">{indexMessage}</div>
          )}

          {!keyboardOpen && debugMode && debugLogs.length > 0 && (
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

          {cancelledQuery && !searching && (
            <div className="mt-3 flex items-center gap-2 text-[11px] text-[hsl(var(--color-muted-foreground))]">
              <X className="h-3.5 w-3.5 flex-shrink-0" aria-hidden="true" />
              <span>已取消「{cancelledQuery}」的搜索</span>
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
      <main className="min-h-0 flex-1 overflow-hidden" aria-busy={searching}>
        <CustomScrollArea
          className="h-full"
          viewportClassName="reader-scroll"
          viewportRef={resultsViewportRef}
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
                    <div
                      className="-mx-1 flex snap-x gap-2 overflow-x-auto px-1 pb-1 [scrollbar-width:none]"
                      role="group"
                      aria-label="按分类筛选"
                    >
                      {facetEntries.map(([name, count]) => {
                        const active = activeFacet === name;
                        return (
                          <button
                            key={name}
                            type="button"
                            aria-pressed={active}
                            onClick={() => setActiveFacet(active ? null : name)}
                            className={cn(
                              "inline-flex min-h-[44px] flex-shrink-0 snap-start items-center rounded-full border px-3 text-xs transition-colors",
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
                          className="inline-flex min-h-[44px] flex-shrink-0 snap-start items-center px-2 text-xs text-[hsl(var(--color-muted-foreground))] underline hover:text-[hsl(var(--color-foreground))]"
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
                      <span className="font-mono text-[hsl(var(--color-foreground))]">NOT</span>
                      <span className="ml-2">与减号等价，排除后面的词，例如 <code>博士 NOT 干员</code></span>
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
