import {
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { api } from "@/services/api";
import type { ParsedStoryContent, StorySegment } from "@/types/story";
import { Button } from "@/components/ui/button";
import {
  ArrowLeft,
  BookmarkCheck,
  BookmarkPlus,
  CheckSquare,
  ChevronLeft,
  ChevronRight,
  ListTree,
  MoreHorizontal,
  RefreshCw,
  Settings as SettingsIcon,
  Share2,
  Star,
} from "lucide-react";
import { useReaderSettings } from "@/hooks/useReaderSettings";
import { ReaderSettingsPanel } from "@/components/ReaderSettings";
import { StoryInsightsPanel } from "@/components/StoryInsightsPanel";
import { useReadingProgress, type ReadingProgress } from "@/hooks/useReadingProgress";
import { useFavorites } from "@/hooks/useFavorites";
import { useHighlights } from "@/hooks/useHighlights";
import { useBackHandler } from "@/hooks/useBackHandler";
import { useEdgeSwipeBack } from "@/hooks/useEdgeSwipeBack";
import { cn } from "@/lib/utils";
import { segmentDigest } from "@/lib/segmentDigest";
import { CustomScrollArea } from "@/components/ui/custom-scroll-area";
import { useAppPreferences } from "@/hooks/useAppPreferences";
import type { StoryEntry, StoryNeighbors } from "@/types/story";
import { ShareImageDialog } from "@/components/ShareImageDialog";
import { AssetImage } from "@/components/AssetImage";
import { useAssetHealthNonce } from "@/hooks/useAsset";
import { CharacterAvatar } from "@/components/CharacterAvatar";
import { bumpReadingStreak } from "@/components/HomePanel";

interface ReaderSearchFocus {
  storyId: string;
  query: string;
  snippet?: string | null;
  issuedAt?: number;
}

interface StoryReaderProps {
  storyId: string;
  storyPath: string;
  storyName: string;
  /**
   * 阅读器是否正处于前台。阅读器在返回列表后仍以 `KeepAlive` 挂载着（为了
   * 保留滚动位置），所以所有会外溢到全局的能力——键盘快捷键、返回栈、
   * 左缘返回手势——都必须按这个开关关掉，否则列表页按空格会翻不可见的页、
   * 系统返回键会被隐藏阅读器的选段/抽屉 handler 吃掉。
   */
  active?: boolean;
  onBack: () => void;
  initialFocus?: ReaderSearchFocus | null;
  initialCharacter?: string;
  initialJump?: { storyId: string; segmentIndex: number; preview?: string; issuedAt?: number } | null;
  /** 阅读器内点击 prev/next 时由父级切换到另一篇剧情。 */
  onNavigateStory?: (next: StoryEntry) => void;
}

interface RenderableSegment {
  segment: StorySegment;
  index: number;
}

/** 只影响单个段落的渲染状态。见 `renderSegment` / `ReaderSegmentRow`。 */
interface SegmentRowState {
  highlighted: boolean;
  searchHighlighted: boolean;
  searchPulseActive: boolean;
  characterHighlighted: boolean;
  selected: boolean;
}

type SegmentRenderer = (
  item: RenderableSegment,
  isLast: boolean,
  state: SegmentRowState
) => React.ReactNode;

const BASE_MAX_WIDTH = 768; // px
const TARGET_CHARS_PER_PAGE = 900; // approximate characters we aim to fit per page

/**
 * 预取缓存。
 *
 * 阅读器在 App 里是以 `storyId` 作 key 挂载的，点「下一话」会把整个阅读器
 * 重挂一遍，组件内的任何 state 都留不下来——所以缓存必须放模块级。带 TTL
 * 是为了别让重新同步数据之后的旧正文一直粘着；容量上正文只留最近几篇
 * （单篇解析结果不小），元数据都是索引里的小对象，可以多留一些。
 */
const PREFETCH_TTL_MS = 5 * 60 * 1000;

interface CacheEntry<T> {
  value: T;
  storedAt: number;
}

function createLruCache<T>(limit: number) {
  const entries = new Map<string, CacheEntry<T>>();
  return {
    get(key: string): T | null {
      const hit = entries.get(key);
      if (!hit) return null;
      if (Date.now() - hit.storedAt > PREFETCH_TTL_MS) {
        entries.delete(key);
        return null;
      }
      // 命中后挪到队尾：淘汰时先丢最久没被读到的那条。
      entries.delete(key);
      entries.set(key, hit);
      return hit.value;
    },
    set(key: string, value: T) {
      entries.delete(key);
      entries.set(key, { value, storedAt: Date.now() });
      while (entries.size > limit) {
        const oldest = entries.keys().next();
        if (oldest.done) break;
        entries.delete(oldest.value);
      }
    },
  };
}

/** 「上一话 / 当前 / 下一话」再多留一格，够覆盖来回翻的场景。 */
const storyContentCache = createLruCache<ParsedStoryContent>(4);
const storyNeighborsCache = createLruCache<StoryNeighbors>(16);
const storyEntryCache = createLruCache<StoryEntry>(16);

type IdleHandle = { kind: "idle"; id: number } | { kind: "timeout"; id: number };

/**
 * 预取只在浏览器空闲时做：正文首屏、恢复阅读位置这些事优先。移动端 WebView
 * 未必有 `requestIdleCallback`，退回一个短延时即可。
 */
function scheduleIdle(task: () => void): IdleHandle | null {
  if (typeof window === "undefined") return null;
  if (typeof window.requestIdleCallback === "function") {
    return { kind: "idle", id: window.requestIdleCallback(task, { timeout: 2000 }) };
  }
  return { kind: "timeout", id: window.setTimeout(task, 500) };
}

function cancelIdle(handle: IdleHandle | null) {
  if (!handle || typeof window === "undefined") return;
  if (handle.kind === "idle") {
    window.cancelIdleCallback?.(handle.id);
  } else {
    window.clearTimeout(handle.id);
  }
}

function isSegmentHighlightable(segment: StorySegment): boolean {
  switch (segment.type) {
    case "dialogue":
    case "narration":
    case "system":
    case "subtitle":
    case "sticker":
      return true;
    default:
      return false;
  }
}

/**
 * 阅读器使用的段落后处理：丢弃 music 段、规整空白、合并连续同角色对话。
 *
 * 导出为纯函数，是为了让其它面板（例如人物金句列表）能用同一套下标口径
 * 计算 `segmentIndex`——直接对 `content.segments` 取下标会和阅读器里的
 * 段号错位。
 */
export function postProcessSegments(segments: readonly StorySegment[]): StorySegment[] {
  const cleaned = segments.flatMap<StorySegment>((segment) => {
    // Drop music segments here — inline music UI is out of scope (BGM
    // playback will be opt-in later).
    if (segment.type === "music") return [];

    if (segment.type === "dialogue" || segment.type === "narration") {
      const normalizedText = segment.text
        .replace(/\r\n/g, "\n")
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
        .join("\n");
      if (!normalizedText) {
        return [];
      }
      if (normalizedText === segment.text) {
        return [segment];
      }
      return [{ ...segment, text: normalizedText }];
    }

    if (segment.type === "decision") {
      const options = segment.options.map((option) => option.trim()).filter(Boolean);
      if (options.length === 0) {
        return [];
      }
      if (options.length === segment.options.length) {
        return [segment];
      }
      return [{ ...segment, options }];
    }

    return [segment];
  });

  const merged: StorySegment[] = [];
  cleaned.forEach((segment) => {
    // De-dup consecutive Image segments with the same token (common in
    // scripts that set the same background twice in a row).
    if (segment.type === "image") {
      const last = merged[merged.length - 1];
      if (last && last.type === "image" && last.token === segment.token) {
        return;
      }
    }
    if (segment.type === "dialogue") {
      const last = merged[merged.length - 1];
      if (last && last.type === "dialogue" && last.characterName === segment.characterName) {
        merged[merged.length - 1] = {
          ...last,
          text: `${last.text}\n${segment.text}`.replace(/\n{2,}/g, "\n"),
        };
        return;
      }
    }
    merged.push(segment);
  });

  return merged;
}

/**
 * 把带换行的正文拆成 `<span>` + `<br />`。定义在模块级：它不依赖任何组件
 * 状态，放在组件里只会让每次渲染都产出一个新引用，白白破坏 memo。
 */
function renderLines(text: string) {
  const parts = text.split("\n");
  return parts.map((line, index) => (
    <span key={index}>
      {line}
      {index < parts.length - 1 ? <br /> : null}
    </span>
  ));
}

/**
 * 找到滚动容器顶部当前贴着的段落，并记下它相对容器顶的偏移。
 *
 * 命中测试是 O(1)，比遍历上千个段落节点便宜得多；拿不到结果时调用方会退回
 * 按百分比恢复。
 */
function captureTopAnchor(
  container: HTMLElement | null
): { index: number; offset: number } | null {
  if (!container || typeof document === "undefined") return null;
  const rect = container.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return null;
  const x = rect.left + rect.width / 2;
  const y = rect.top + 4;
  const hit = document.elementFromPoint(x, y) as HTMLElement | null;
  const node = hit?.closest?.("[data-segment-index]") as HTMLElement | null;
  if (!node || !container.contains(node)) return null;
  const index = Number(node.dataset.segmentIndex);
  if (!Number.isFinite(index)) return null;
  return { index, offset: node.getBoundingClientRect().top - rect.top };
}

interface ProgressStore {
  subscribe: (listener: () => void) => () => void;
  getSnapshot: () => number;
  /** 写入 0~1 的阅读比例；小于 0.05% 的变化直接吞掉。 */
  set: (ratio: number) => void;
}

/**
 * 阅读进度的极小外部 store。
 *
 * 连续滚动时百分比每帧都在动。如果它是阅读器的一个 state，顶栏、页脚、
 * 上一话/下一话栏、三个抽屉就得跟着每帧走一遍 diff——正文靠 memo 拦住了，
 * 外壳没有。改成 store 之后只有真正显示百分比的那一小块会重渲染。
 */
function useProgressStore(): ProgressStore {
  const valueRef = useRef(0);
  const listenersRef = useRef<Set<() => void>>(new Set());
  return useMemo(
    () => ({
      subscribe: (listener: () => void) => {
        listenersRef.current.add(listener);
        return () => {
          listenersRef.current.delete(listener);
        };
      },
      getSnapshot: () => valueRef.current,
      set: (ratio: number) => {
        const clamped = Number.isFinite(ratio) ? Math.min(1, Math.max(0, ratio)) : 0;
        // 进度条只精确到 0.1%，比这更细的变化没必要惊动 React。
        if (Math.abs(clamped - valueRef.current) < 0.0005) return;
        valueRef.current = clamped;
        listenersRef.current.forEach((listener) => listener());
      },
    }),
    []
  );
}

/** 0~1 的比例转成保留一位小数的百分比。 */
function toPercentage(ratio: number): number {
  const clamped = Math.max(0, Math.min(1, ratio));
  return Math.round(clamped * 1000) / 10;
}

function approximateSegmentLength(segment: StorySegment): number {
  switch (segment.type) {
    case "dialogue":
      return segment.characterName.length + segment.text.length + 2;
    case "narration":
    case "system":
    case "subtitle":
    case "sticker":
      return segment.text.length;
    case "decision":
      return segment.options.reduce((acc, opt) => acc + opt.length + 2, 0);
    case "header":
      return segment.title.length + 8;
    case "image":
      // Rendered as 16:9 block; roughly equivalent to ~2 long paragraphs.
      return 360;
    case "music":
      return 0;
    default:
      return 0;
  }
}

export function StoryReader({ storyId, storyPath, storyName, active = true, onBack, initialFocus, initialCharacter, initialJump, onNavigateStory }: StoryReaderProps) {
  // 命中预取缓存时直接带着正文挂载：从「下一话」进来时连骨架屏都不闪一下。
  const [content, setContent] = useState<ParsedStoryContent | null>(() =>
    storyContentCache.get(storyPath)
  );
  const [loading, setLoading] = useState(() => storyContentCache.get(storyPath) === null);
  const [error, setError] = useState<string | null>(null);
  const [currentPage, setCurrentPage] = useState(0);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [insightsOpen, setInsightsOpen] = useState(false);
  const [highlightSegmentIndex, setHighlightSegmentIndex] = useState<number | null>(null);
  // Monotonic token used to trigger the one-shot search-highlight pulse
  // animation. Bumped each time the reader jumps to a new hit; cleared
  // after the pulse keyframes finish so the data attribute auto-removes.
  const [searchPulseToken, setSearchPulseToken] = useState(0);
  // 跳转目标段「本应已在文档里却查不到」时 bump 一次（见 jumpToSegment），
  // 用来触发下面的 30 帧兜底重试链。pending 本体是 ref（多处需要同步读写、
  // 也不想让每次跳转都重渲染整棵正文），代价是兜底 layout effect 的依赖里
  // 没有任何东西会因这类 miss 而变化——不显式踢一脚它就永远不跑。
  const [pendingScrollTick, setPendingScrollTick] = useState(0);
  const [activeCharacter, setActiveCharacter] = useState<string | null>(null);
  const [storyEntry, setStoryEntry] = useState<StoryEntry | null>(() =>
    storyEntryCache.get(storyId)
  );
  const [storyInfoText, setStoryInfoText] = useState<string | null>(null);
  // 沉浸阅读：连续滚动模式下向下滚动收起顶栏，向上滚动/回到顶部再展开。
  const [headerHidden, setHeaderHidden] = useState(false);
  const [headerHeight, setHeaderHeight] = useState(56);

  const progressStore = useProgressStore();

  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
  const readerRootRef = useRef<HTMLDivElement | null>(null);
  const headerRef = useRef<HTMLElement | null>(null);
  const loadTokenRef = useRef(0);
  const focusAppliedRef = useRef<number | null>(null);
  const characterAppliedRef = useRef<string | null>(null);
  const pendingScrollIndexRef = useRef<number | null>(null);
  const jumpAppliedRef = useRef<number | null>(null);
  // 「搜索 / 跳转落点」挂起期间被跳过的进度快照。restore 逻辑让位给落点时
  // 先把当时未被污染的进度存在这里：落点若最终应用失败（正文里命中不到、
  // 目标段渲染不出来），用它把读者送回原位——否则读者被留在开头，随后的
  // 进度落盘还会把 ~0% 写回存储。落点成功应用时清空。
  const pendingLandingFallbackRef = useRef<ReadingProgress | null>(null);
  const lastScrollTopRef = useRef(0);
  // 已恢复过阅读进度的 `storyPath::readingMode`，避免"滚动→写进度→再恢复"回路。
  const restoredKeyRef = useRef<string | null>(null);
  // 连续滚动模式下贴着容器顶部的段落。字号/行距一变正文整体重排，靠它把
  // 读者钉回原来那一段，而不是让百分比把人甩到别处。
  const topAnchorRef = useRef<{ index: number; offset: number } | null>(null);
  const scrollRatioRef = useRef(0);
  // 当前正文的镜像，供 loadStory 判断缓存命中时内容是否真的换了。
  const contentRef = useRef(content);
  contentRef.current = content;

  const { settings, updateSettings, resetSettings } = useReaderSettings();
  const { showSummaries, minimalMode, inlineImages } = useAppPreferences();
  // `trackState: false`：阅读器只在挂载时要一次初始值，之后一律走
  // `getProgress()`。让每 1.2s 一次的落盘去驱动 state，只会白白把整棵
  // 阅读器重渲染一遍。
  const { progress, updateProgress, getProgress, flushProgress } = useReadingProgress(storyPath, {
    trackState: false,
  });
  const { isFavorite, toggleFavorite } = useFavorites();
  const [neighbors, setNeighbors] = useState<StoryNeighbors>(
    () => storyNeighborsCache.get(storyId) ?? { prev: null, next: null }
  );
  const [categoryName, setCategoryName] = useState<string | null>(null);

  // Multi-select state for "分享为图片". Keeps indices in insertion order so
  // the exported image preserves the user's chosen emphasis; sorting happens
  // at render time so the output is always read top-to-bottom.
  const [selectedSegments, setSelectedSegments] = useState<number[]>([]);
  const [selectMode, setSelectMode] = useState(false);
  const [shareDialogOpen, setShareDialogOpen] = useState(false);
  const [moreMenuOpen, setMoreMenuOpen] = useState(false);
  const moreMenuRef = useRef<HTMLDivElement | null>(null);
  const moreMenuTriggerRef = useRef<HTMLButtonElement | null>(null);
  const moreMenuPanelRef = useRef<HTMLDivElement | null>(null);

  // 抽屉 / 选段工具栏是否占据了界面。滚动监听里用 ref 读取，避免因为这些
  // 状态变化而反复重建 scroll listener。
  const overlayOpenRef = useRef(false);
  overlayOpenRef.current =
    settingsOpen || insightsOpen || shareDialogOpen || selectMode || moreMenuOpen;

  // 正文是否被真正的遮罩盖住（抽屉 / 分享对话框 / 浮层菜单会挡住命中测试）。
  // 选段模式不算：它只换了底部工具栏，正文完全可见，顶部锚点必须照常刷新
  // ——否则在选段里翻了几屏再退出，重排锚定会按进选段前的旧锚点把读者拽
  // 回去。
  const textObscuredRef = useRef(false);
  textObscuredRef.current = settingsOpen || insightsOpen || shareDialogOpen || moreMenuOpen;

  // 最近一次持久化的阅读进度。恢复逻辑只在换篇 / 换模式时读取它，所以用
  // ref 兜住，避免把持续变化的 `progress` 写进 effect 依赖。
  const progressRef = useRef(progress);
  progressRef.current = progress;

  // Back-button stack. `useBackHandler` is LIFO — the most recently mounted
  // handler that returns `true` wins, so the effective priority is "最近
  // 打开的先关"（Android 硬返回键 / 浏览器 popstate）。Registering order
  // doesn't determine priority; each hook simply adds to the stack when
  // its guard flips to `true`. The fallthrough case (no handler consumes
  // the event) lets the outer App handler close the reader.
  //
  // 每个 guard 都要与 `active` 相与：阅读器隐藏后仍然挂载，残留的选段 /
  // 抽屉状态不应该继续占着返回栈。
  useBackHandler(active && shareDialogOpen, () => {
    setShareDialogOpen(false);
    return true;
  });
  useBackHandler(active && insightsOpen, () => {
    setInsightsOpen(false);
    return true;
  });
  useBackHandler(active && settingsOpen, () => {
    setSettingsOpen(false);
    return true;
  });
  useBackHandler(active && selectMode, () => {
    setSelectMode(false);
    setSelectedSegments([]);
    return true;
  });
  useBackHandler(active && moreMenuOpen, () => {
    setMoreMenuOpen(false);
    return true;
  });

  // 点击外部 / Esc / Tab 移出都关闭更多菜单，并接管焦点：打开时把焦点送进
  // 菜单，关闭时还给触发它的按钮——否则键盘和读屏用户点开菜单后焦点还留在
  // 原按钮上，菜单里的项根本走不到。
  useEffect(() => {
    if (!active || !moreMenuOpen) return;
    const panel = moreMenuPanelRef.current;
    const firstItem = panel?.querySelector<HTMLElement>("[role='menuitem']:not([disabled])");
    (firstItem ?? panel)?.focus({ preventScroll: true });

    const handlePointer = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (target && moreMenuRef.current?.contains(target)) return;
      setMoreMenuOpen(false);
    };
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setMoreMenuOpen(false);
        return;
      }
      // 菜单只有寥寥几项，不做环形 Tab；按原生 menu 的惯例，Tab 出去就
      // 顺势关掉（不拦默认行为，焦点照常往下走）。
      if (event.key === "Tab") setMoreMenuOpen(false);
    };
    window.addEventListener("pointerdown", handlePointer);
    window.addEventListener("keydown", handleKey);
    return () => {
      window.removeEventListener("pointerdown", handlePointer);
      window.removeEventListener("keydown", handleKey);
      // 焦点已经被别处接走（例如 Tab 出去了）就别抢回来。
      const activeElement = document.activeElement;
      const focusStranded =
        !activeElement || activeElement === document.body || Boolean(panel?.contains(activeElement));
      if (focusStranded) moreMenuTriggerRef.current?.focus({ preventScroll: true });
    };
  }, [active, moreMenuOpen]);

  // 阅读器退到后台（列表页盖在上面）时收掉浮层菜单：它挂着全局 pointerdown /
  // keydown，状态留着不但会占返回栈，回到阅读器时还会看到一张过期的菜单。
  useEffect(() => {
    if (active) return;
    setMoreMenuOpen(false);
    // 角色意图的「已应用」记号一并清掉：同一个角色字符串没有 issuedAt 可
    // 判重，只能把「退到后台再回来」当作一次新意图的边界——用户再次从
    // 人物面板点「在剧情中查看」时才能重新定位到该角色。
    characterAppliedRef.current = null;
  }, [active]);

  // iOS-style edge swipe back — close the reader when the user swipes from
  // the left edge. Only active when none of the inner modals are open so the
  // gesture doesn't accidentally fight the in-modal close animation.
  useEdgeSwipeBack(readerRootRef, {
    // Disable edge-swipe while any drawer or the multi-select toolbar is
    // open — otherwise a stray swipe could tear down a half-captured
    // selection / share preview.
    // 浮层菜单同理：返回栈里它是最上层（硬返回键先关菜单再关阅读器），
    // 边缘手势模拟的是同一个「返回」，不该越过菜单直接把整个阅读器关掉。
    enabled:
      active && !settingsOpen && !insightsOpen && !shareDialogOpen && !selectMode && !moreMenuOpen,
    onBack,
  });

  const processedSegments = useMemo<StorySegment[]>(
    () => (content ? postProcessSegments(content.segments) : []),
    [content]
  );

  /**
   * Content fingerprint for every segment. Fed to `useHighlights` so stored
   * annotations realign to the same paragraph after a data sync shifts
   * segment indices. Kept as part of the reader (not the hook) because it
   * depends on the reader's own `processedSegments` post-processing — the
   * hook would otherwise need to duplicate that work.
   */
  const segmentDigestMap = useMemo<string[]>(() => {
    if (!processedSegments.length) return [];
    return processedSegments.map((segment) => {
      switch (segment.type) {
        case "dialogue":
          return segmentDigest(`${segment.characterName}\u0001${segment.text}`);
        case "narration":
        case "subtitle":
        case "sticker":
          return segmentDigest(segment.text);
        case "system":
          return segmentDigest(`${segment.speaker ?? ""}\u0001${segment.text}`);
        case "decision":
          return segmentDigest(segment.options.join("\u0001"));
        case "header":
          return segmentDigest(segment.title);
        case "image":
          return segmentDigest(`image\u0001${segment.token}`);
        case "music":
          return segmentDigest(`music\u0001${segment.key}`);
        default:
          return "";
      }
    });
  }, [processedSegments]);

  const { highlights, toggleHighlight, isHighlighted, clearHighlights } = useHighlights(
    storyPath,
    segmentDigestMap
  );

  const highlightEntries = useMemo(
    () =>
      highlights
        .map((segmentIndex) => {
          const segment = processedSegments[segmentIndex];
          if (!segment) return null;

          let preview = "";
          switch (segment.type) {
            case "dialogue": {
              const primary = segment.text.split("\n")[0] ?? "";
              preview = `${segment.characterName}: ${primary}`;
              break;
            }
            case "narration":
            case "system":
            case "subtitle":
            case "sticker":
              preview = segment.text.split("\n")[0] ?? "";
              break;
            default:
              return null;
          }

          const normalized = preview.replace(/\s+/g, " ").trim();
          if (!normalized) {
            return null;
          }
          const label = normalized.length > 70 ? `${normalized.slice(0, 70)}…` : normalized;
          return { index: segmentIndex, label };
        })
        .filter((entry): entry is { index: number; label: string } => entry !== null),
    [highlights, processedSegments]
  );

  /**
   * Compute dynamic page boundaries for paged reading mode based on an
   * approximate character budget (scaled by font size so bigger type gives
   * fewer segments per page). Returns the starting segment index for each
   * page. Bug fix: replaces the hardcoded SEGMENTS_PER_PAGE = 12 which made
   * pages wildly unbalanced at extreme font sizes.
   */
  const pageBoundaries = useMemo<number[]>(() => {
    if (!processedSegments.length) return [0];
    // Scale budget inversely by font size: at 18px we want ~900 chars/page;
    // at 28px we scale down proportionally so the visual page size stays similar.
    const scaleFactor = 18 / Math.max(settings.fontSize, 14);
    const budget = Math.max(200, Math.round(TARGET_CHARS_PER_PAGE * scaleFactor));

    // 插画被全局隐藏（关闭插画 / 极简模式）时按 0 长度计：这些段渲染为
    // null，仍按 ~360 字符记账会让每页普遍偏空，连续几个插画段甚至会拼出
    // 一整页什么都不渲染的空白页。
    const imagesVisible = inlineImages && !minimalMode;
    const lengthOf = (seg: StorySegment) =>
      seg.type === "image" && !imagesVisible ? 0 : approximateSegmentLength(seg);
    // 最后一个会真正渲染出内容的段。预算断点不越过它：尾部只剩隐藏插画段
    // 时，在它们前面开新页会多出一页完全空白的「最后一页」。
    let lastRenderableIndex = -1;
    for (let i = processedSegments.length - 1; i >= 0; i -= 1) {
      const seg = processedSegments[i];
      if (seg.type === "image" && !imagesVisible) continue;
      lastRenderableIndex = i;
      break;
    }

    const boundaries: number[] = [0];
    let acc = 0;
    // 当前页里是否已有会渲染出内容的段。预算断点开页时 acc ≥ budget，页里
    // 必然有可渲染段；唯独 header 断点是无条件开页——若它面前这一页全是
    // 隐藏插画（长对话触发预算断点 → 背景图 → 章节标题的常见结构），直接
    // 把上一个边界推进到 header 处并成一页，否则中间会夹一页空白页。
    let pageHasRenderable = false;
    processedSegments.forEach((seg, idx) => {
      const len = lengthOf(seg);
      // Always break before a Header — chapters/sections open a new page.
      const isHeader = seg.type === "header";
      if (idx > 0 && isHeader && boundaries[boundaries.length - 1] !== idx) {
        if (pageHasRenderable) {
          boundaries.push(idx);
        } else {
          boundaries[boundaries.length - 1] = idx;
        }
        acc = 0;
        pageHasRenderable = false;
      }
      if (!(seg.type === "image" && !imagesVisible)) pageHasRenderable = true;
      acc += len;
      if (acc >= budget && idx + 1 <= lastRenderableIndex) {
        boundaries.push(idx + 1);
        acc = 0;
        pageHasRenderable = false;
      }
    });
    return boundaries;
  }, [processedSegments, settings.fontSize, inlineImages, minimalMode]);

  const totalPages = useMemo(() => {
    if (!processedSegments.length) return 0;
    return Math.max(1, pageBoundaries.length);
  }, [pageBoundaries, processedSegments]);

  // 分页模式的百分比完全由页码决定，直接算就好——不必再绕一圈进度 state，
  // 也就顺带修掉了「翻页后百分比慢一帧」的老毛病。
  const pagedPercentage =
    totalPages > 0 ? toPercentage(totalPages <= 1 ? 1 : (currentPage + 1) / totalPages) : 0;

  const readerContentStyles = useMemo(() => {
    const maxWidthPx = Math.round((settings.pageWidth / 100) * BASE_MAX_WIDTH);
    const style: CSSProperties = {
      fontFamily: settings.fontFamily === "system" ? undefined : settings.fontFamily,
      fontSize: `${settings.fontSize}px`,
      lineHeight: settings.lineHeight,
      letterSpacing: `${settings.letterSpacing}px`,
      textAlign: settings.textAlign,
      // Drive max-width via CSS var so it composes with the stylesheet
      // default instead of double-clipping to 48rem. (bug: double max-width)
      ["--reader-max-width" as unknown as string]: `${maxWidthPx}px`,
      width: "100%",
      ...(settings.paragraphIndent
        ? { textIndent: "2em" }
        : {}),
    } as CSSProperties;
    return style;
  }, [
    settings.fontFamily,
    settings.fontSize,
    settings.letterSpacing,
    settings.lineHeight,
    settings.pageWidth,
    settings.paragraphSpacing,
    settings.textAlign,
    settings.paragraphIndent,
  ]);

  const readerSpacing = useMemo(
    // 下限必须与滑杆 / sanitize 的区间下限（0.3）一致。早前这里钳到 0.5：
    // 滑杆 0.3、0.4 两档能选、标签也如实显示，段距却纹丝不动——和行距
    // 1.2/1.4 区间错位是同一类「界面与生效值脱节」的病。0.3 只是防御，
    // sanitizeSettings 已保证不会更小。
    () => `${Math.max(settings.paragraphSpacing, 0.3)}rem`,
    [settings.paragraphSpacing]
  );

  const getSegmentSearchText = useCallback((segment: StorySegment) => {
    switch (segment.type) {
      case "dialogue":
        return `${segment.characterName} ${segment.text}`;
      case "narration":
      case "subtitle":
      case "sticker":
        return segment.text;
      case "system":
        return segment.speaker ? `${segment.speaker} ${segment.text}` : segment.text;
      case "decision":
        return segment.options.join(" ");
      case "image":
        return segment.caption ?? "";
      case "music":
        return "";
      default:
        return "";
    }
  }, []);

  const findFocusSegmentIndex = useCallback(
    (focus: ReaderSearchFocus): number | null => {
      const normalizedQuery = focus.query.trim().toLowerCase();
      const normalizedSnippet = focus.snippet
        ?.replace(/…/g, " ")
        .replace(/\.{3}/g, " ")
        .trim()
        .toLowerCase();
      const queryNoSpaces = normalizedQuery.replace(/\s+/g, "");
      const snippetNoSpaces = normalizedSnippet?.replace(/\s+/g, "");

      // 更强健的匹配：移除标点/符号后再匹配一次
      const stripSymbols = (s: string) =>
        s
          .normalize("NFKC")
          .toLowerCase()
          // 移除所有标点、符号以及空白
          .replace(/[\p{P}\p{S}\s]+/gu, "");
      const queryStripped = normalizedQuery ? stripSymbols(normalizedQuery) : "";
      const snippetStripped = normalizedSnippet ? stripSymbols(normalizedSnippet) : "";

      if (!normalizedQuery && !normalizedSnippet) {
        return null;
      }

      for (let i = 0; i < processedSegments.length; i += 1) {
        const segment = processedSegments[i];
        const text = getSegmentSearchText(segment);
        if (!text) continue;
        const normalizedText = text.replace(/\s+/g, " ").toLowerCase();
        const collapsedText = normalizedText.replace(/\s+/g, "");
        const strippedText = stripSymbols(text);

        if (normalizedSnippet && (normalizedText.includes(normalizedSnippet) || collapsedText.includes(snippetNoSpaces ?? ""))) {
          return i;
        }

        if (normalizedQuery && (normalizedText.includes(normalizedQuery) || collapsedText.includes(queryNoSpaces))) {
          return i;
        }

        if ((snippetStripped && strippedText.includes(snippetStripped)) || (queryStripped && strippedText.includes(queryStripped))) {
          return i;
        }
      }

      return null;
    },
    [getSegmentSearchText, processedSegments]
  );

  const scrollToSegment = useCallback(
    (segmentIndex: number, behavior: ScrollBehavior = "smooth") => {
      const container = scrollContainerRef.current;
      if (!container) return;
      const element = container.querySelector<HTMLElement>(
        `[data-segment-index="${segmentIndex}"]`
      );
      if (!element) return;

      const doScroll = (top: number) => container.scrollTo({ top: Math.max(top, 0), behavior });

      // 路径1：几何位置（大多数布局准确）
      try {
        const cRect = container.getBoundingClientRect();
        const eRect = element.getBoundingClientRect();
        const targetTop = container.scrollTop + (eRect.top - cRect.top) - 32;
        if (Number.isFinite(targetTop)) {
          doScroll(targetTop);
          return;
        }
      } catch {}

      // 路径2：累计 offsetTop（兜底）
      try {
        let top = 0;
        let node: HTMLElement | null = element;
        while (node && node !== container) {
          top += node.offsetTop;
          node = node.offsetParent as HTMLElement | null;
        }
        doScroll(top - 32);
        return;
      } catch {}

      // 路径3：scrollIntoView 兜底
      try {
        element.scrollIntoView({ behavior, block: "start" });
      } catch {}
    },
    []
  );

  const renderableSegments = useMemo<RenderableSegment[]>(() => {
    if (!processedSegments.length) return [];
    if (settings.readingMode === "paged") {
      const safePage = Math.max(0, Math.min(currentPage, pageBoundaries.length - 1));
      const start = pageBoundaries[safePage] ?? 0;
      const end =
        safePage + 1 < pageBoundaries.length
          ? pageBoundaries[safePage + 1]
          : processedSegments.length;
      return processedSegments.slice(start, end).map((segment, offset) => ({
        segment,
        index: start + offset,
      }));
    }
    return processedSegments.map((segment, index) => ({ segment, index }));
  }, [processedSegments, currentPage, settings.readingMode, pageBoundaries]);

  const insights = useMemo(() => {
    if (!processedSegments.length) {
      return {
        characters: [] as Array<{ name: string; count: number; firstIndex: number }>,
        decisions: [] as Array<{ index: number; options: string[]; values?: string[] }>,
        headers: [] as Array<{ index: number; title: string }>,
      };
    }

    const characterMap = new Map<string, { count: number; firstIndex: number }>();
    const decisions: Array<{ index: number; options: string[]; values?: string[] }> = [];
    const headers: Array<{ index: number; title: string }> = [];

    processedSegments.forEach((segment, index) => {
      if (segment.type === "dialogue") {
        const entry = characterMap.get(segment.characterName);
        if (entry) {
          entry.count += 1;
        } else {
          characterMap.set(segment.characterName, { count: 1, firstIndex: index });
        }
      } else if (segment.type === "decision") {
        decisions.push({
          index,
          options: segment.options,
          values: segment.values && segment.values.length > 0 ? segment.values : undefined,
        });
      } else if (segment.type === "header") {
        headers.push({ index, title: segment.title });
      }
    });

    const characters = Array.from(characterMap.entries())
      .map(([name, meta]) => ({ name, ...meta }))
      .sort((a, b) => b.count - a.count);

    return { characters, decisions, headers };
  }, [processedSegments]);

  const loadStory = useCallback(async () => {
    // 换篇 / 重试时作废上一次请求：后端解析慢的时候，旧结果曾经会盖掉新的一话。
    const token = (loadTokenRef.current += 1);

    const cached = storyContentCache.get(storyPath);
    if (cached) {
      // 命中预取缓存时 useState 初始化已经带上了同一份正文，且进度恢复的
      // layout effect 先于本 effect 执行、已把分页页码恢复到存储页。此时
      // 再无条件 setCurrentPage(0) 会把刚恢复的页码打回第 0 页，随后的
      // 进度落盘还会把第 0 页写回存储——真实的阅读进度就此丢失。只有
      // 内容真的变化（错误/空态重试后命中新缓存）才需要重置页码。
      if (contentRef.current !== cached) {
        setContent(cached);
        setCurrentPage(0);
      }
      setError(null);
      setLoading(false);
      try {
        bumpReadingStreak();
      } catch {}
      return;
    }

    try {
      setLoading(true);
      setError(null);
      const data = await api.getStoryContent(storyPath);
      if (token !== loadTokenRef.current) return;
      // 空结果不进缓存，否则「重新加载」永远只会拿回同一份空正文。
      if (data.segments.length > 0) storyContentCache.set(storyPath, data);
      setContent(data);
      setCurrentPage(0);
      // Bump reading streak when user actually opens a story.
      try {
        bumpReadingStreak();
      } catch {}
    } catch (err) {
      if (token !== loadTokenRef.current) return;
      setError(err instanceof Error ? err.message : "加载失败");
    } finally {
      if (token === loadTokenRef.current) setLoading(false);
    }
  }, [storyPath]);

  useEffect(() => {
    loadStory();
  }, [loadStory]);

  // 加载完整的 StoryEntry 用于收藏
  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        const entry = await api.getStoryEntry(storyId);
        if (!mounted) return;
        storyEntryCache.set(storyId, entry);
        setStoryEntry((prev) => (prev?.storyId === entry.storyId ? prev : entry));
      } catch {
        // ignore
      }
    })();
    return () => { mounted = false; };
  }, [storyId]);

  // 加载 prev/next（预取过就先用缓存里的，底部导航栏不用先闪一遍「—」）
  useEffect(() => {
    let mounted = true;
    setNeighbors(storyNeighborsCache.get(storyId) ?? { prev: null, next: null });
    (async () => {
      try {
        const n = await api.getStoryNeighbors(storyId);
        if (!mounted) return;
        storyNeighborsCache.set(storyId, n);
        setNeighbors((prev) =>
          prev.prev?.storyId === n.prev?.storyId && prev.next?.storyId === n.next?.storyId
            ? prev
            : n
        );
      } catch {
        // ignore
      }
    })();
    return () => {
      mounted = false;
    };
  }, [storyId]);

  /**
   * 预取上一话 / 下一话的正文与元数据。
   *
   * 一话读到底再点「下一话」是最常见的动线，预取之后那一跳基本没有骨架屏。
   * 只在阅读器处于前台、当前这一话已经就绪、且浏览器空闲时才做；换篇、
   * 卸载、退到后台都会立刻取消（`cancelled` 拦住已经在飞的请求写缓存之外
   * 的任何后续动作，剩下的一次 invoke 顶多白跑一趟）。
   */
  useEffect(() => {
    if (!active || loading || error) return;
    // 顺序有讲究：先下一话——往后读的人远多于往回翻的人。
    const targets = [neighbors.next, neighbors.prev].filter(
      (entry): entry is StoryEntry => Boolean(entry?.storyTxt)
    );
    if (targets.length === 0) return;

    let cancelled = false;
    const prefetch = async () => {
      for (const entry of targets) {
        if (cancelled) return;
        // 邻居的 StoryEntry 本身就来自索引，直接落缓存，省掉下一次挂载的那次查询。
        storyEntryCache.set(entry.storyId, entry);

        if (!storyContentCache.get(entry.storyTxt)) {
          try {
            const data = await api.getStoryContent(entry.storyTxt);
            if (cancelled) return;
            if (data.segments.length > 0) storyContentCache.set(entry.storyTxt, data);
          } catch {
            // 预取失败无所谓，真正点进去时会正常走一次加载。
          }
        }

        if (cancelled) return;
        if (!storyNeighborsCache.get(entry.storyId)) {
          try {
            const n = await api.getStoryNeighbors(entry.storyId);
            if (cancelled) return;
            storyNeighborsCache.set(entry.storyId, n);
          } catch {
            // 同上
          }
        }
      }
    };

    const handle = scheduleIdle(() => {
      if (!cancelled) void prefetch();
    });
    return () => {
      cancelled = true;
      cancelIdle(handle);
    };
  }, [active, loading, error, neighbors.prev, neighbors.next]);

  // 加载章节/活动名，供分享图与顶栏使用
  useEffect(() => {
    let mounted = true;
    setCategoryName(null);
    (async () => {
      try {
        const name = await api.getStoryCategoryName(storyId);
        if (mounted) setCategoryName(name ?? null);
      } catch {
        // ignore
      }
    })();
    return () => {
      mounted = false;
    };
  }, [storyId]);

  useEffect(() => {
    let cancelled = false;
    setStoryInfoText(null);
    const infoPath = storyEntry?.storyInfo?.trim();
    if (!infoPath) {
      return () => {
        cancelled = true;
      };
    }

    (async () => {
      try {
        const raw = await api.getStoryInfo(infoPath);
        if (cancelled) return;
        const normalized = raw.replace(/\r\n/g, "\n").trim();
        setStoryInfoText(normalized.length > 0 ? normalized : null);
      } catch (err) {
        // 概述缺失是常态（社区镜像并不是每关都有），只在开发期提示。
        if (import.meta.env.DEV) {
          console.warn("[StoryReader] Failed to load story summary:", err);
        }
        if (!cancelled) {
          setStoryInfoText(null);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [storyEntry?.storyInfo]);

  useEffect(() => {
    setHighlightSegmentIndex(null);
    focusAppliedRef.current = null;
    setActiveCharacter(null);
  }, [storyId, storyPath]);

  /**
   * 把一份进度记录应用到当前视图（分页翻到存储页 / 连续滚动滚到存储位置）。
   *
   * 抽成独立函数：除了下面的恢复 effect，搜索 / 跳转落点应用失败的兜底
   * 路径也要用它把读者送回原位。
   *
   * @returns 是否应用成功（滚动容器还没挂上时返回 false，调用方可稍后重试）。
   */
  const applyStoredProgress = useCallback(
    (stored: ReadingProgress | null): boolean => {
      // 上次是另一种阅读模式时，用百分比近似换算，别一路弹回开头。
      const storedPercentage =
        typeof stored?.percentage === "number" && Number.isFinite(stored.percentage)
          ? Math.max(0, Math.min(1, stored.percentage))
          : 0;

      if (settings.readingMode === "paged") {
        const lastPage = Math.max(totalPages - 1, 0);
        const storedPage =
          stored?.readingMode === "paged" && typeof stored.currentPage === "number"
            ? Math.max(0, Math.min(stored.currentPage, lastPage))
            : Math.round(storedPercentage * lastPage);
        setCurrentPage(storedPage);
        progressStore.set(totalPages <= 1 ? 1 : (storedPage + 1) / totalPages);
        return true;
      }

      const container = scrollContainerRef.current;
      if (!container) return false;
      const maxTop = Math.max(container.scrollHeight - container.clientHeight, 0);
      let storedTop =
        stored?.readingMode === "scroll" && typeof stored.scrollTop === "number"
          ? stored.scrollTop
          : storedPercentage * maxTop;
      // 布局比记录进度时矮（旋转 / 缩放视口、插画被隐藏）会让绝对 scrollTop
      // 失真：直接 scrollTo 会被夹到文末，按 storedTop 反推的 ratio 还会算出
      // >1、把进度直接标成 100%。此时退回按百分比换算。
      if (storedTop > maxTop) storedTop = storedPercentage * maxTop;
      storedTop = Math.max(0, storedTop);
      // 视口的 `.reader-scroll` 挂着 `scroll-behavior: smooth`，不显式指定
      // behavior 的话恢复位置会从顶部一路平滑飘过去；动画途中滚动监听读到的
      // 还是起点附近的位置，会先把一份 ~0% 的进度落盘，短暂盖掉真实记录。
      container.scrollTo({ top: storedTop, behavior: "instant" });
      lastScrollTopRef.current = storedTop;
      // 视口已被程序化挪到新位置，此前捕获的顶部锚点随之过期。不清掉的话，
      // 「切到分页读了很久 → 切回滚动（此时设置抽屉还开着，滚动监听因
      // textObscuredRef 不会刷新锚点）→ 顺手调字号」这条动线会让排版重排
      // 效果按旧锚点把读者拽回上一次滚动会话的段落，随后进度落盘再把错误
      // 位置写成真实进度。清空后重排走 scrollRatioRef 的百分比兜底，位置
      // 与本次恢复一致；用户一旦真正滚动，锚点会照常重新捕获。
      topAnchorRef.current = null;
      const ratio = maxTop <= 0 ? 1 : storedTop / maxTop;
      const clamped = Number.isFinite(ratio) ? Math.max(0, Math.min(1, ratio)) : 0;
      scrollRatioRef.current = clamped;
      progressStore.set(clamped);
      return true;
    },
    [settings.readingMode, totalPages, progressStore]
  );

  /**
   * 恢复上次阅读位置。
   *
   * 只在"换一篇剧情"或"切换阅读模式"时执行一次（用 `restoredKeyRef` 记住
   * 已恢复过的 key）。之前这个 effect 依赖 `progress`，而滚动时又会不断写
   * 进度，于是形成 滚动 → 写进度 → 重新恢复 的回路，表现为滚动被拽回去。
   */
  useLayoutEffect(() => {
    if (!processedSegments.length) return;

    const restoreKey = `${storyPath}::${settings.readingMode}`;
    if (restoredKeyRef.current === restoreKey) return;

    // 若正在处理搜索跳转或初始定位，避免恢复旧的阅读进度，以免覆盖滚动。
    // 必须以「跳转是否已应用（token 已记账）」为准：initialFocus/initialJump
    // 这两个 prop 在整个阅读会话里都不会消失，只看 prop 是否存在的话，
    // 搜索进来的读者之后每次切换阅读模式都会被跳过恢复、直接甩回开头，
    // 随后的进度落盘还会把 ~0% 写回存储，真实进度就此丢失。
    // issuedAt 缺失时的判重必须与应用侧的记账口径一致：应用 effect 记的是
    // `issuedAt ?? Date.now()`，这里若仍与 null 比较，「已应用」会被永远当成
    // 挂起——之后每次切换阅读模式都跳过恢复，读者被留在原地、进度再被
    // ~0% 覆盖。App 目前总是带 issuedAt，此处是对齐两侧口径的加固：缺失
    // 时只在「从未应用过任何意图」时才算挂起。
    const focusPending =
      initialFocus &&
      initialFocus.storyId === storyId &&
      (initialFocus.issuedAt != null
        ? focusAppliedRef.current !== initialFocus.issuedAt
        : focusAppliedRef.current === null);
    const jumpPending =
      initialJump &&
      initialJump.storyId === storyId &&
      (initialJump.issuedAt != null
        ? jumpAppliedRef.current !== initialJump.issuedAt
        : jumpAppliedRef.current === null);
    const shouldSkipRestore =
      pendingScrollIndexRef.current !== null || focusPending || jumpPending;
    if (shouldSkipRestore) {
      // 让位给落点前先快照当前进度。此刻它还没被本次会话的进度 effect
      // 污染（本 effect 是 layout effect，先于它们执行）；落点应用失败时
      // 兜底路径会用这份快照把读者送回原位。
      if (focusPending || jumpPending) {
        pendingLandingFallbackRef.current = getProgress() ?? progressRef.current;
      }
      restoredKeyRef.current = restoreKey;
      return;
    }

    // 优先读 hook 里的实时值：state 可能还没跟上刚刚的滚动，也可能还停在上一篇。
    const stored = getProgress() ?? progressRef.current;
    if (!applyStoredProgress(stored)) return;

    restoredKeyRef.current = restoreKey;
  }, [
    processedSegments,
    settings.readingMode,
    storyPath,
    initialFocus,
    initialJump,
    storyId,
    getProgress,
    applyStoredProgress,
  ]);

  // 阅读器退到后台时连滚动监听一起摘掉：`KeepAlive` 只是把它藏起来，容器
  // 还在文档里，惯性滚动 / 程序化滚动都还能把这条链子跑起来。
  useEffect(() => {
    if (!active || !processedSegments.length || settings.readingMode !== "scroll") return;
    const container = scrollContainerRef.current;
    if (!container) return;

    let frame = 0;
    const handleScroll = () => {
      if (frame) cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        // 跳转落点还挂起时既不记进度也不抓锚点：此刻的 scrollTop 是过渡态。
        // 典型动线是搜索进篇——restore 让位后视口停在 0，本监听挂上时的
        // 首帧回调若照常记账，pending 里就压着一份 ~0%；用户点进来发现不是
        // 想要的那篇、立刻返回，closeReader 的强制冲刷会把这份 0% 写成真实
        // 进度，真实位置就此丢失。落点成功（jumpToSegment 同步清 pending，
        // 平滑滚动的后续 scroll 事件照常记账）或放弃（兜底快照把视口摆正、
        // 滚动事件随之恢复记账）之后，这里自然解除。
        if (pendingScrollIndexRef.current !== null) return;
        const { scrollTop, scrollHeight, clientHeight } = container;
        // 容器还没量出高度（隐藏 / 尚未布局）时别算：denominator<=0 会被
        // 当成「读完了」，把进度直接写成 100%。
        if (clientHeight <= 0) return;
        const denominator = scrollHeight - clientHeight;
        const ratio = denominator <= 0 ? 1 : scrollTop / denominator;
        const clamped = Number.isFinite(ratio) ? Math.max(0, Math.min(1, ratio)) : 0;
        scrollRatioRef.current = clamped;
        progressStore.set(clamped);
        updateProgress({
          readingMode: "scroll",
          scrollTop,
          percentage: clamped,
          updatedAt: Date.now(),
        });

        // 抽屉盖住正文时命中测试会打在遮罩上，这时保留上一次的锚点。
        if (!textObscuredRef.current) {
          const anchor = captureTopAnchor(container);
          if (anchor) topAnchorRef.current = anchor;
        }

        // 沉浸阅读：向下滚动收起顶栏腾出屏幕，向上滚动或靠近顶部时复原。
        // 抽屉/选段工具栏打开时保持顶栏可见，避免操作路径消失。
        const delta = scrollTop - lastScrollTopRef.current;
        if (Math.abs(delta) >= 6) {
          lastScrollTopRef.current = scrollTop;
          if (!overlayOpenRef.current) {
            setHeaderHidden(delta > 0 && scrollTop > 96);
          }
        }
        if (scrollTop <= 24) {
          setHeaderHidden(false);
        }
      });
    };

    container.addEventListener("scroll", handleScroll, { passive: true });
    handleScroll();

    return () => {
      container.removeEventListener("scroll", handleScroll);
      if (frame) cancelAnimationFrame(frame);
    };
  }, [active, processedSegments, settings.readingMode, updateProgress, progressStore]);

  useEffect(() => {
    if (!processedSegments.length || settings.readingMode !== "paged" || totalPages === 0) return;
    const ratio = totalPages <= 1 ? 1 : (currentPage + 1) / totalPages;
    const clamped = Number.isFinite(ratio) ? Math.max(0, Math.min(1, ratio)) : 0;
    progressStore.set(clamped);
    updateProgress({
      readingMode: "paged",
      currentPage,
      percentage: clamped,
      updatedAt: Date.now(),
    });
  }, [
    processedSegments,
    currentPage,
    settings.readingMode,
    totalPages,
    updateProgress,
    progressStore,
  ]);

  // 把标题 / 关卡号一并写进进度记录，首页的「继续阅读」卡片就不用等索引
  // 加载完才知道自己在显示哪一话。旧记录没有这两个字段，读取方按可选处理。
  useEffect(() => {
    if (!processedSegments.length) return;
    updateProgress({ storyName, storyCode: storyEntry?.storyCode ?? null });
  }, [processedSegments, storyName, storyEntry?.storyCode, updateProgress]);

  // 退到后台（KeepAlive 只隐藏、不卸载，卸载冲刷不会跑）时把节流窗口里的
  // 进度强制落盘。关闭动线上 closeReader 在广播 home-refresh 前已经同步冲
  // 刷过一次，这里兜住其余让 `active` 翻 false 的路径。
  useEffect(() => {
    if (active) return;
    flushProgress();
  }, [active, flushProgress]);

  /**
   * 字号 / 行距 / 页宽一变，分页边界会整体重算。这里用「当前页的首段」当锚点，
   * 在新的边界表里找回它所在的页，避免调大一号字就被弹回第 1 页。
   */
  const currentPageRef = useRef(currentPage);
  currentPageRef.current = currentPage;
  const pagedAnchorRef = useRef<{ key: string; boundaries: number[] } | null>(null);
  useLayoutEffect(() => {
    const previous = pagedAnchorRef.current;
    pagedAnchorRef.current = { key: storyPath, boundaries: pageBoundaries };
    if (!previous || previous.key !== storyPath || previous.boundaries === pageBoundaries) return;
    if (settings.readingMode !== "paged") return;

    const prevBoundaries = previous.boundaries;
    const page = Math.min(Math.max(currentPageRef.current, 0), prevBoundaries.length - 1);
    const anchorSegment = prevBoundaries[page] ?? 0;
    let target = 0;
    for (let i = pageBoundaries.length - 1; i >= 0; i -= 1) {
      if (anchorSegment >= pageBoundaries[i]) {
        target = i;
        break;
      }
    }
    setCurrentPage((prev) => (prev === target ? prev : target));
  }, [pageBoundaries, settings.readingMode, storyPath]);

  /**
   * 连续滚动模式下的同类问题：正文重排后滚动位置会漂。优先把顶部那一段钉
   * 回原位，拿不到锚点时退回按百分比恢复。
   */
  const typographySignature = [
    settings.fontFamily,
    settings.fontSize,
    settings.lineHeight,
    settings.letterSpacing,
    settings.paragraphSpacing,
    settings.pageWidth,
    settings.textAlign,
    settings.paragraphIndent ? 1 : 0,
    // 进出选段模式会隐藏/恢复对话头像并同步收放 3rem 左内边距，全部对话段
    // 重新换行，和调字号是同一类整体重排——不锚定的话，读者正想选的那一段
    // 会随重排漂出视口。
    selectMode ? 1 : 0,
    // 插画显隐 / 极简模式（隐藏头像与插画）同样是全文级重排，且能在阅读
    // 中途变化：useAppPreferences 会跟随其它窗口的 storage 事件实时翻转。
    // 概述块则是异步加载完才插进正文顶部的——恢复完阅读位置它才出现，
    // 正文整体被压下去一截。这三者以前都不在签名里，重排后没人把读者
    // 钉回原段。（阅读器隐藏时容器量不出高度，锚定 effect 会自行跳过，
    // 不会在后台乱滚。）
    inlineImages ? 1 : 0,
    minimalMode ? 1 : 0,
    showSummaries && storyInfoText ? 1 : 0,
  ].join("|");
  const typographyRef = useRef<string | null>(null);
  useLayoutEffect(() => {
    const previous = typographyRef.current;
    typographyRef.current = typographySignature;
    if (previous === null || previous === typographySignature) return;
    if (settings.readingMode !== "scroll") return;

    const container = scrollContainerRef.current;
    if (!container) return;
    const maxTop = Math.max(container.scrollHeight - container.clientHeight, 0);
    if (maxTop <= 0) return;

    let nextTop: number | null = null;
    const anchor = topAnchorRef.current;
    if (anchor) {
      const element = container.querySelector<HTMLElement>(
        `[data-segment-index="${anchor.index}"]`
      );
      if (element) {
        const delta = element.getBoundingClientRect().top - container.getBoundingClientRect().top;
        nextTop = container.scrollTop + delta - anchor.offset;
      }
    }
    if (nextTop === null) nextTop = scrollRatioRef.current * maxTop;

    const clampedTop = Math.max(0, Math.min(nextTop, maxTop));
    // 排版重排是瞬时的，锚点校正也必须瞬时（instant 覆盖视口上的 CSS
    // smooth），否则正文先跳一下再缓缓滚回去，看起来像坏了。
    container.scrollTo({ top: clampedTop, behavior: "instant" });
    lastScrollTopRef.current = clampedTop;
    scrollRatioRef.current = clampedTop / maxTop;
  }, [typographySignature, settings.readingMode]);

  /**
   * 分页模式翻页后把视口滚回页首。单页允许高于一屏（分页只保证 min-height），
   * 沿用上一页的 scrollTop 会让新页直接从中腰甚至页尾开始读；从连续滚动切到
   * 分页时残留的滚动位置同理。有挂起的段落跳转时让位——那次翻页就是为了滚
   * 到指定段落，落点由跳转兜底逻辑决定。
   */
  const pagedViewKeyRef = useRef<string | null>(null);
  useLayoutEffect(() => {
    const key = settings.readingMode === "paged" ? String(currentPage) : null;
    const previous = pagedViewKeyRef.current;
    pagedViewKeyRef.current = key;
    if (key === null || previous === key) return;
    if (pendingScrollIndexRef.current !== null) return;
    // 显式 instant：翻页不该带滚动动画（视口 CSS 是 smooth）。
    scrollContainerRef.current?.scrollTo({ top: 0, behavior: "instant" });
  }, [currentPage, settings.readingMode]);

  // 顶栏实际高度（带关卡编号/标签时会比 3.5rem 高），收起时按这个值上移。
  useLayoutEffect(() => {
    const element = headerRef.current;
    if (!element) return;
    const measure = () => setHeaderHeight(element.offsetHeight || 56);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [content, storyEntry]);

  // 任一抽屉/选段工具栏打开、切到分页模式或换篇时，顶栏一律复位为可见。
  useEffect(() => {
    if (
      settings.readingMode !== "scroll" ||
      settingsOpen ||
      insightsOpen ||
      shareDialogOpen ||
      selectMode ||
      moreMenuOpen
    ) {
      setHeaderHidden(false);
    }
  }, [
    settings.readingMode,
    settingsOpen,
    insightsOpen,
    shareDialogOpen,
    selectMode,
    moreMenuOpen,
  ]);

  useEffect(() => {
    setHeaderHidden(false);
    lastScrollTopRef.current = 0;
  }, [storyPath]);

  const goToPrevPage = useCallback(() => {
    setCurrentPage((prev) => Math.max(0, prev - 1));
  }, []);

  const goToNextPage = useCallback(() => {
    setCurrentPage((prev) => Math.min(Math.max(totalPages - 1, 0), prev + 1));
  }, [totalPages]);

  // 分页模式的触控翻页：点正文左侧 20% 上一页、右侧 20% 下一页。
  // 选段模式和任何抽屉打开时都关掉，避免抢走点击。
  const pageTapEnabled =
    settings.readingMode === "paged" &&
    !selectMode &&
    !settingsOpen &&
    !insightsOpen &&
    !shareDialogOpen &&
    !moreMenuOpen;

  // 「上一话 / 下一话」栏在底部时是最下面的一层，安全区内边距只由它来吃；
  // 否则进度条 / 分页页脚会再叠一份，底部凭空多出一条空白。
  const showNeighborBar =
    !selectMode &&
    !settingsOpen &&
    !insightsOpen &&
    !shareDialogOpen &&
    Boolean(neighbors.prev || neighbors.next);
  const bottomSafeArea = showNeighborBar ? "0px" : "env(safe-area-inset-bottom, 0px)";

  const handleReaderTap = useCallback(
    (event: ReactMouseEvent<HTMLElement>) => {
      if (!pageTapEnabled) return;

      // 书签按钮、上一话/下一话、插图里的链接以及滚动条本身优先。
      const target = event.target as HTMLElement | null;
      if (
        target?.closest(
          "button, a, input, textarea, select, [role='button'], [contenteditable='true'], .scroll-area__track"
        )
      ) {
        return;
      }

      // 正在划词选择文本时不翻页。
      const selection = typeof window !== "undefined" ? window.getSelection() : null;
      if (selection && !selection.isCollapsed && selection.toString().trim()) return;

      const rect = event.currentTarget.getBoundingClientRect();
      if (rect.width <= 0) return;
      const ratio = (event.clientX - rect.left) / rect.width;
      if (ratio <= 0.2) {
        goToPrevPage();
      } else if (ratio >= 0.8) {
        goToNextPage();
      }
    },
    [pageTapEnabled, goToPrevPage, goToNextPage]
  );

  useEffect(() => {
    // 阅读器不在前台时完全不注册，避免列表页按空格翻到看不见的页面。
    if (!active) return;

    const handleKey = (event: KeyboardEvent) => {
      // 段落自己已经消费掉的按键（选段模式的空格/回车）不再重复处理。
      if (event.defaultPrevented) return;
      const target = event.target as HTMLElement | null;
      if (target?.tagName && ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName)) {
        return;
      }
      if (target?.isContentEditable) return;
      // 带系统 / 浏览器级修饰键的组合不属于阅读器：Alt+← 是历史后退、
      // Cmd/Ctrl+方向键是系统快捷键，之前会被当成普通方向键拦下来翻页，
      // 用户的后退手势就此失效。Shift 不在此列，下面单独按键位放行。
      if (event.altKey || event.ctrlKey || event.metaKey) return;
      // 抽屉 / 浮层菜单打开时把按键留给它们自己（Esc 关闭等）。
      if (settingsOpen || insightsOpen || shareDialogOpen || moreMenuOpen) return;

      // 选段工具栏同样是一层浮层：Esc 退出选段，和抽屉的 Esc 行为对齐。
      if (event.key === "Escape" && selectMode) {
        event.preventDefault();
        setSelectMode(false);
        setSelectedSegments([]);
        return;
      }

      const isSpace = event.key === " " || event.key === "Spacebar";
      // Shift 的豁免只给 Shift+Space（往回翻）：Shift+方向键 / PageUp/
      // PageDown / Home / End 是「扩展文本选区」的浏览器手势——划词分享时
      // 按到会被当成翻页，选区随页面一换就没了（handleReaderTap 对划词
      // 已有同样的让位，键盘路径不该更粗暴）。
      if (event.shiftKey && !isSpace) return;
      // 焦点落在按钮/链接上时空格属于该控件本身，别把"打开设置"变成翻页；
      // 方向键仍然可以翻页，避免点过一次"下一页"后键盘就失灵。
      if (isSpace && target?.closest("button, a, [role='menuitem']")) return;

      if (settings.readingMode === "paged") {
        if (event.key === "ArrowLeft" || event.key === "PageUp" || (isSpace && event.shiftKey)) {
          event.preventDefault();
          goToPrevPage();
        } else if (event.key === "ArrowRight" || event.key === "PageDown" || isSpace) {
          event.preventDefault();
          goToNextPage();
        } else if (event.key === "Home") {
          event.preventDefault();
          setCurrentPage(0);
        } else if (event.key === "End") {
          event.preventDefault();
          setCurrentPage(Math.max(totalPages - 1, 0));
        }
        return;
      }

      const container = scrollContainerRef.current;
      if (!container) return;
      // 翻屏留一点重叠行，避免正好把一行切在屏幕边界上。
      const step = Math.max(container.clientHeight - 64, 120);

      if (event.key === "PageDown" || (isSpace && !event.shiftKey)) {
        event.preventDefault();
        container.scrollBy({ top: step, behavior: "smooth" });
      } else if (event.key === "PageUp" || (isSpace && event.shiftKey)) {
        event.preventDefault();
        container.scrollBy({ top: -step, behavior: "smooth" });
      } else if (event.key === "Home") {
        event.preventDefault();
        container.scrollTo({ top: 0, behavior: "smooth" });
      } else if (event.key === "End") {
        event.preventDefault();
        container.scrollTo({ top: container.scrollHeight, behavior: "smooth" });
      }
    };

    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [
    active,
    settings.readingMode,
    totalPages,
    settingsOpen,
    insightsOpen,
    shareDialogOpen,
    moreMenuOpen,
    selectMode,
    goToPrevPage,
    goToNextPage,
  ]);

  const jumpToSegment = useCallback(
    (index: number, options?: { highlightSearch?: boolean }) => {
      if (!processedSegments.length) return;

      if (options?.highlightSearch) {
        setHighlightSegmentIndex(index);
        // Trigger the pulse animation — bumping the token forces React to
        // re-render the `data-search-pulse` attribute even if the same
        // segment is re-selected.
        setSearchPulseToken((prev) => prev + 1);
      } else if (options?.highlightSearch === false) {
        setHighlightSegmentIndex(null);
      }

      // 落点兜底快照：restore 的让位路径只覆盖「搜索 / 跳转进篇」那一次。
      // 会话中途的跳转（导览章节 / 划线 / 二次搜索同一篇）若最终落空——
      // 目标是被隐藏 / 加载失败的插画段，30 帧重试后放弃——分页模式的页码
      // 此刻已经切过去了，读者会被扔在错误页的页首，随后的进度落盘还把它
      // 写成真实进度。这里在没有更早快照（进篇让位记的那份优先，它才是
      // 未被本次会话污染的进度）时补记当前位置，give-up 路径统一用它送回。
      // 跳转成功的路径会立刻清空快照，不会残留。
      if (pendingLandingFallbackRef.current === null) {
        pendingLandingFallbackRef.current = getProgress();
      }

      pendingScrollIndexRef.current = index;
      if (settings.readingMode !== "scroll") {
        // Binary search the dynamic page boundaries to land on the right page.
        let targetPage = 0;
        for (let i = pageBoundaries.length - 1; i >= 0; i -= 1) {
          if (index >= pageBoundaries[i]) {
            targetPage = i;
            break;
          }
        }
        setCurrentPage(Math.min(targetPage, totalPages - 1));
      }

      // 目标段已经在文档里就立刻滚：连续滚动模式必然如此；分页模式命中当前页
      // 时也一样——那时 setCurrentPage 是 no-op，不会有新渲染去触发兜底的
      // layout effect，之前这种跳转根本不滚。滚完必须清掉 pending：这个残留值
      // 会在下一次正文重排（例如调字号引起 renderableSegments 变化）时被兜底
      // 逻辑捡起来，把读者从字号锚点又拽回旧的跳转目标。元素未渲染（分页模式
      // 跳到别的页）则保留 pending，交给 layout effect 在新页渲染后兜底。
      const container = scrollContainerRef.current;
      const element = container?.querySelector<HTMLElement>(
        `[data-segment-index="${index}"]`
      );
      if (element) {
        scrollToSegment(index);
        pendingScrollIndexRef.current = null;
        // 落点已成功应用，进篇兜底快照不再需要。
        pendingLandingFallbackRef.current = null;
      } else {
        // 查不到目标元素。分页模式跳到别的页时 setCurrentPage 会带来新渲染、
        // renderableSegments 一变兜底重试链自然会跑；但连续滚动模式（全量
        // 渲染）以及分页模式命中当前页时，目标查不到意味着它渲染成了 null
        // ——被隐藏 / 加载失败的插画段（搜索是索引 caption 的，能把读者带到
        // 这里）。此时没有任何新渲染会去触发兜底 effect，pending 就永远挂着：
        // 读者停在原地、搜索进篇被跳过的进度恢复不再有人兜底，随后的进度
        // 落盘还会把 ~0% 写成真实进度，残留的 pending 还会在下一次正文重排
        // 时把读者拽向不存在的段。显式 bump 让重试链跑起来，30 帧后由它
        // 统一执行放弃与进度回退。目标真的稍后出现（页面切换、失败插画被
        // 健康事件复活）时，同一条链会照常完成滚动。
        setPendingScrollTick((prev) => prev + 1);
      }
    },
    [processedSegments, scrollToSegment, settings.readingMode, totalPages, pageBoundaries, getProgress]
  );

  // 优先处理初始段落跳转（搜索结果点击、人物面板等）
  useEffect(() => {
    if (!initialJump || !processedSegments.length) return;
    const token = initialJump.issuedAt ?? Date.now();
    if (jumpAppliedRef.current === token) return;

    let target = initialJump.segmentIndex;
    const preview = initialJump.preview?.trim();

    // 只要带了预览文本就以文本匹配为准：调用方（人物金句列表等）拿到的
    // 段号可能是基于原始 `content.segments` 的下标，和阅读器后处理过的
    // 段号并不是同一套；数据同步后整体偏移也会跳错位置。文本匹配失败时
    // 再退回原段号。
    if (preview) {
      const idx = findFocusSegmentIndex({ storyId, query: "", snippet: preview });
      if (idx !== null) target = idx;
    }

    if (target >= 0 && target < processedSegments.length) {
      setActiveCharacter(null);
      jumpToSegment(target, { highlightSearch: true });
    } else {
      // 段号越界且预览文本也匹配不到（数据同步后正文变了）：跳转落空。
      // 恢复被让位跳过的阅读进度，别把读者留在开头、再让进度落盘写回 ~0%。
      const fallback = pendingLandingFallbackRef.current;
      pendingLandingFallbackRef.current = null;
      if (fallback) applyStoredProgress(fallback);
    }
    jumpAppliedRef.current = token;
  }, [
    initialJump,
    processedSegments,
    findFocusSegmentIndex,
    jumpToSegment,
    applyStoredProgress,
    storyId,
  ]);

  // 初始角色高亮与定位（人物面板点击"在剧情中查看"）。使用 jumpToSegment，
  // 这样分页模式也会翻到该角色首次出场的那一页，而不是只在当前页滚动。
  useEffect(() => {
    if (!active || !processedSegments.length) return;
    if (!initialCharacter) return;
    // 每个意图只应用一次。旧 guard 还要求 activeCharacter 仍等于
    // initialCharacter，导致用户在导览里清除高亮 / 改选别的角色时，
    // activeCharacter 一变这里就把初始角色重新套回去、还跳回其首次
    // 出场段——角色焦点根本清不掉。角色意图没有 issuedAt 可判重，
    // ref 在阅读器退到后台时清空，再次从人物面板进来仍会重新定位。
    if (characterAppliedRef.current === initialCharacter) return;

    // 查找该角色的第一条对话段落
    let firstIndex: number | null = null;
    for (let i = 0; i < processedSegments.length; i += 1) {
      const seg = processedSegments[i];
      if (seg.type === "dialogue" && seg.characterName === initialCharacter) {
        firstIndex = i;
        break;
      }
    }
    setActiveCharacter(initialCharacter);
    characterAppliedRef.current = initialCharacter;
    if (firstIndex !== null) {
      jumpToSegment(firstIndex, { highlightSearch: false });
    }
  }, [active, processedSegments, initialCharacter, jumpToSegment]);

  // 当页面或段落渲染完成后，执行挂起的滚动请求（最多尝试几次）
  useLayoutEffect(() => {
    if (pendingScrollIndexRef.current === null) return;
    let tries = 0;
    let cancelled = false;
    let frame = 0;
    const tick = () => {
      if (cancelled) return;
      const index = pendingScrollIndexRef.current;
      if (index === null) return;
      const container = scrollContainerRef.current;
      if (container) {
        const element = container.querySelector<HTMLElement>(`[data-segment-index="${index}"]`);
        if (element) {
          // 找到了目标元素，执行滚动
          scrollToSegment(index);
          pendingScrollIndexRef.current = null;
          pendingLandingFallbackRef.current = null;
          return;
        }
      }
      if (tries < 30) {
        tries += 1;
        frame = requestAnimationFrame(tick);
      } else {
        // 30 帧后还找不到目标段（例如指向已因加载失败被移除的插画段），
        // 放弃并清掉 pending，免得之后每次正文重排都重新挂一条重试链、
        // 且换阅读模式时恢复逻辑一直被这个死目标挡住。
        pendingScrollIndexRef.current = null;
        if (settings.readingMode === "paged") {
          // 这次翻页本是为了滚到目标段；目标没出现时至少把视口复位到页首，
          // 否则新页会沿用跳转前残留的滚动偏移、从半腰开始读。
          scrollContainerRef.current?.scrollTo({ top: 0, behavior: "instant" });
        }
        // 放弃的是「搜索 / 跳转进篇」的落点时，读者此刻停在开头、且进篇
        // 恢复已被跳过——用让位时的快照把人送回原来的阅读位置，别让接下来
        // 的进度落盘把 ~0% 写成真实进度。
        const fallback = pendingLandingFallbackRef.current;
        if (fallback) {
          pendingLandingFallbackRef.current = null;
          applyStoredProgress(fallback);
        }
      }
    };
    frame = requestAnimationFrame(tick);
    // 不取消的话，重渲染会不断叠加新的重试链，卸载后还在跑。
    return () => {
      cancelled = true;
      cancelAnimationFrame(frame);
    };
    // pendingScrollTick 只是触发器：目标段本应在文档里却查不到时（隐藏 /
    // 失败的插画段），jumpToSegment 靠它启动这条重试链，其余依赖都不会变。
  }, [
    renderableSegments,
    currentPage,
    settings.readingMode,
    scrollToSegment,
    applyStoredProgress,
    pendingScrollTick,
  ]);

  useEffect(() => {
    if (!initialFocus || !processedSegments.length) return;
    const token = initialFocus.issuedAt ?? Date.now();
    // 只按 token 判重。曾经这里还要求 highlightSegmentIndex 非空才算“已应用”，
    // 结果高亮一被清掉（导览里跳章节、清除人物高亮都会把它置回 null），
    // 这个 effect 就重新触发，把读者拽回搜索命中段、盖掉用户刚刚的跳转。
    if (focusAppliedRef.current === token) return;

    const targetIndex = findFocusSegmentIndex(initialFocus);
    if (targetIndex === null) {
      focusAppliedRef.current = token;
      setHighlightSegmentIndex(null);
      // 搜索命中在当前正文里找不到（数据版本漂移）：落点落空。恢复被让位
      // 跳过的阅读进度，别把读者留在开头、再让进度落盘写回 ~0%。
      const fallback = pendingLandingFallbackRef.current;
      pendingLandingFallbackRef.current = null;
      if (fallback) applyStoredProgress(fallback);
      return;
    }

    setActiveCharacter(null);
    jumpToSegment(targetIndex, { highlightSearch: true });
    focusAppliedRef.current = token;
  }, [initialFocus, processedSegments, findFocusSegmentIndex, jumpToSegment, applyStoredProgress]);

  const handleCharacterHighlight = useCallback(
    (name: string, firstIndex: number) => {
      if (activeCharacter === name) {
        setActiveCharacter(null);
        setHighlightSegmentIndex(null);
        return;
      }

      setActiveCharacter(name);
      jumpToSegment(firstIndex, { highlightSearch: false });
      setInsightsOpen(false);
    },
    [activeCharacter, jumpToSegment]
  );

  // 段落渲染时按 O(1) 判断是否选中；`selectedSegments` 本身保留数组，
  // 因为分享图要按用户点选的先后顺序排版。
  const selectedSegmentSet = useMemo(() => new Set(selectedSegments), [selectedSegments]);

  // Toggle multi-select entry for an index. Kept separate from the
  // highlight store so "分享为图片" can compose an ad-hoc selection without
  // polluting the user's persistent highlights.
  const toggleSegmentSelection = useCallback((index: number) => {
    setSelectedSegments((prev) =>
      prev.includes(index) ? prev.filter((i) => i !== index) : [...prev, index]
    );
  }, []);

  const clearSelection = useCallback(() => {
    setSelectedSegments([]);
  }, []);

  // Flip to select mode: preserves any existing selection so the user can
  // turn the page in paged-mode and keep accumulating picks across pages.
  // The explicit "清空" / "取消" controls still reset the selection.
  const enterSelectMode = useCallback(() => {
    setSelectMode(true);
    setInsightsOpen(false);
  }, []);

  const exitSelectMode = useCallback(() => {
    setSelectMode(false);
    setSelectedSegments([]);
  }, []);

  const handleToggleHighlightUnified = useCallback((index: number) => {
    toggleHighlight(index);
  }, [toggleHighlight]);

  const clearCharacterHighlight = useCallback(() => {
    setActiveCharacter(null);
    setHighlightSegmentIndex(null);
  }, []);

  const handleClearHighlightsUnified = useCallback(() => {
    clearHighlights();
  }, [clearHighlights]);

  const handleJumpToSegment = useCallback(
    (index: number) => {
      jumpToSegment(index, { highlightSearch: false });
      setInsightsOpen(false);
    },
    [jumpToSegment]
  );

  // 稳定的关闭回调：设置面板是 memo 组件，每次渲染都换一个新的箭头函数会让
  // memo 形同虚设。
  const closeSettings = useCallback(() => setSettingsOpen(false), []);

  // Auto-clear the pulse token shortly after it fires so the CSS animation
  // attribute detaches. The underlying ring remains (static highlight)
  // until the user navigates to a new hit or closes the search focus.
  useEffect(() => {
    if (searchPulseToken === 0) return;
    const id = window.setTimeout(() => setSearchPulseToken(0), 1800);
    return () => window.clearTimeout(id);
  }, [searchPulseToken]);

  /**
   * Lazily assemble the payload passed to `<ShareImageDialog />`. Kept as a
   * memo so the dialog reactively re-renders whenever the user toggles a
   * segment, but we avoid the work unless the dialog is actually open.
   */
  const selectedShareSegments = useMemo(
    () =>
      selectedSegments
        .map((idx) => ({ index: idx, segment: processedSegments[idx] }))
        .filter((entry): entry is { index: number; segment: StorySegment } => Boolean(entry.segment)),
    [selectedSegments, processedSegments]
  );

  // 当前选中段落的收藏状态：如果全部已收藏则点击为"取消收藏"，
  // 否则为"加入收藏"（把未收藏的补上，保持已收藏的不变）。
  const selectionBookmarkState = useMemo(() => {
    const highlightable = selectedSegments.filter((idx) => {
      const seg = processedSegments[idx];
      return Boolean(seg && isSegmentHighlightable(seg));
    });
    if (highlightable.length === 0) return { mode: "none" as const, count: 0 };
    const allHighlighted = highlightable.every((idx) => isHighlighted(idx));
    return {
      mode: allHighlighted ? ("remove" as const) : ("add" as const),
      count: highlightable.length,
    };
  }, [selectedSegments, processedSegments, isHighlighted]);

  const handleBookmarkSelection = useCallback(() => {
    const highlightable = selectedSegments.filter((idx) => {
      const seg = processedSegments[idx];
      return Boolean(seg && isSegmentHighlightable(seg));
    });
    if (highlightable.length === 0) return;
    const allHighlighted = highlightable.every((idx) => isHighlighted(idx));
    if (allHighlighted) {
      // 全部已收藏 → 统一取消
      highlightable.forEach((idx) => toggleHighlight(idx));
    } else {
      // 混合或全部未收藏 → 把未收藏的补上
      highlightable.forEach((idx) => {
        if (!isHighlighted(idx)) toggleHighlight(idx);
      });
    }
  }, [selectedSegments, processedSegments, isHighlighted, toggleHighlight]);

  /**
   * 渲染单个段落。
   *
   * 所有「只影响某一段」的状态（是否收藏 / 是否命中搜索 / 是否被选中）都通过
   * `state` 传进来，而不是从闭包里读——这样这个函数的身份只跟排版级设置有关，
   * `ReaderSegmentRow` 的 `memo` 才拦得住上千段的无谓重渲染。
   */
  const renderSegment = useCallback(
    ({ segment, index }: RenderableSegment, isLast: boolean, state: SegmentRowState) => {
      const spacing = isLast ? "0" : readerSpacing;
      const highlightable = isSegmentHighlightable(segment);
      const annotationHighlight = highlightable && state.highlighted;
      const searchHighlighted = state.searchHighlighted;
      // When true, the segment is the freshly-navigated-to search hit —
      // attach `data-search-pulse` so the CSS keyframe runs once.
      const searchPulseActive = state.searchPulseActive;
      const characterHighlighted = highlightable && state.characterHighlighted;
      const isSelected = state.selected;
      const selectable = selectMode && segment.type !== "decision"; // selecting a decision block is awkward; skip

      const segmentStyle: CSSProperties = { marginBottom: spacing };
      // 给右上角的收藏按钮留位，否则长句会被角标压住。
      segmentStyle.paddingRight = "clamp(2.75rem, 6vw, 3.25rem)";

      const handleSegmentClick = (event: ReactMouseEvent<HTMLDivElement>) => {
        if (!selectable) return;
        // Don't swallow clicks that originate from interactive children
        // (e.g. decision options, embedded buttons).
        const target = event.target as HTMLElement;
        if (target.closest("button")) return;
        event.preventDefault();
        toggleSegmentSelection(index);
      };

      const handleSegmentKey = (event: React.KeyboardEvent<HTMLDivElement>) => {
        if (!selectable) return;
        // Space / Enter toggle selection. Arrow keys / Esc are intentionally
        // left to bubble so the reader's own shortcuts still work.
        if (event.key === " " || event.key === "Enter") {
          event.preventDefault();
          toggleSegmentSelection(index);
        }
      };

      // Props shared across every segment variant below. `role`/`tabIndex`
      // are only populated when the paragraph is actually selectable so
      // Tab navigation outside of select mode stays on real buttons.
      const segmentA11yProps: React.HTMLAttributes<HTMLDivElement> = selectable
        ? {
            role: "button",
            tabIndex: 0,
            "aria-pressed": isSelected,
            "aria-label": isSelected ? "取消选中此段" : "选中此段用于分享",
            onKeyDown: handleSegmentKey,
          }
        : {};

      const selectionClass = selectable
        ? cn(
            "reader-segment-selectable cursor-pointer rounded-md transition-shadow",
            isSelected && "ring-2 ring-[var(--reader-accent)] ring-offset-2 ring-offset-transparent"
          )
        : "";

      // 右上角的收藏开关：阅读时既能一眼看到这一段是否已收藏，也能直接点
      // 一下切换划线，不必先进选段模式。触控区固定 44×44，视觉上仍是那颗
      // 小圆角标（内层 span 负责外观，外层按钮只负责命中区域）。
      // 选段模式下隐藏，避免和选中态 ring 打架、也避免抢走选段点击。
      const highlightButton =
        highlightable && !selectMode ? (
          <button
            type="button"
            className="reader-highlight-toggle"
            aria-pressed={annotationHighlight}
            aria-label={annotationHighlight ? "取消收藏此段" : "收藏此段"}
            title={annotationHighlight ? "取消收藏此段" : "收藏此段"}
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              toggleHighlight(index);
            }}
            style={{
              top: "0.15rem",
              right: "0.15rem",
              width: "2.75rem",
              height: "2.75rem",
              padding: 0,
              border: "none",
              background: "transparent",
              boxShadow: "none",
              opacity: annotationHighlight ? 1 : 0.45,
              touchAction: "manipulation",
              cursor: "pointer",
            }}
          >
            <span
              aria-hidden="true"
              style={{
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                width: "1.75rem",
                height: "1.75rem",
                borderRadius: "9999px",
                border: `1px solid ${
                  annotationHighlight
                    ? "color-mix(in srgb, var(--reader-accent) 45%, transparent)"
                    : "color-mix(in srgb, var(--reader-fg) 22%, transparent)"
                }`,
                background: annotationHighlight
                  ? "color-mix(in srgb, var(--reader-accent) 18%, var(--reader-bg))"
                  : "color-mix(in srgb, var(--reader-fg) 6%, var(--reader-bg))",
                color: annotationHighlight
                  ? "var(--reader-accent)"
                  : "color-mix(in srgb, var(--reader-fg) 62%, transparent)",
              }}
            >
              {annotationHighlight ? (
                <BookmarkCheck className="h-4 w-4" />
              ) : (
                <BookmarkPlus className="h-4 w-4" />
              )}
            </span>
          </button>
        ) : null;

      if (segment.type === "dialogue") {
        const showAvatar = !minimalMode && !selectMode;
        return (
          <div
            key={index}
            data-segment-index={index}
          className={cn(
            "reader-paragraph reader-dialogue reader-segment pr-10",
            annotationHighlight && "reader-highlighted",
            searchHighlighted && "reader-search-highlight",
            characterHighlighted && "reader-character-highlight",
            selectionClass
          )}
          onClick={handleSegmentClick}
          {...segmentA11yProps}
          data-search-pulse={searchPulseActive ? "true" : undefined}
          style={{
            ...segmentStyle,
            // 头像被隐藏（选段模式 / 极简模式）时同步收掉给头像预留的左内边距，
            // 否则对话段左侧会空出一条明显的空档。
            ...(showAvatar ? null : { paddingLeft: 0 }),
            textAlign: segment.position === "right" ? ("right" as CSSProperties["textAlign"]) : undefined,
          }}
        >
          {highlightButton}
          {showAvatar && (
            <CharacterAvatar
              charId={segment.characterId ?? undefined}
              name={segment.characterName}
              size={36}
              className="reader-dialogue-avatar"
            />
          )}
          <div className="reader-character-name">{segment.characterName}</div>
          <div className="reader-text">{renderLines(segment.text)}</div>
        </div>
      );
      }

      if (segment.type === "narration") {
        return (
          <div
            key={index}
            data-segment-index={index}
            className={cn(
              "reader-narration reader-segment pr-10",
              annotationHighlight && "reader-highlighted",
              searchHighlighted && "reader-search-highlight",
              selectionClass
            )}
            onClick={handleSegmentClick}
            {...segmentA11yProps}
            data-search-pulse={searchPulseActive ? "true" : undefined}
            style={segmentStyle}
          >
            {highlightButton}
            {renderLines(segment.text)}
          </div>
        );
      }

      if (segment.type === "decision") {
        const values = segment.values ?? [];
        return (
          <div
            key={index}
            data-segment-index={index}
            className={cn(
              "reader-decision",
              searchHighlighted && "reader-search-highlight"
            )}
            data-search-pulse={searchPulseActive ? "true" : undefined}
            style={{ marginBottom: spacing }}
          >
            {/* 抉择块内的字号一律用 em，跟随阅读器字号一起缩放。 */}
            <div className="reader-decision-title" style={{ fontSize: "0.85em" }}>
              选择：
            </div>
            {segment.options.map((option, optionIndex) => {
              const tag = values[optionIndex];
              return (
                <div
                  key={optionIndex}
                  className="reader-decision-option"
                  style={{ animationDelay: `${optionIndex * 60}ms` }}
                >
                  <span
                    className="reader-decision-bullet"
                    style={{ width: "1.6em", height: "1.6em", fontSize: "0.78em" }}
                  >
                    {optionIndex + 1}
                  </span>
                  <span className="flex-1">{option}</span>
                  {tag ? (
                    <span
                      className="uppercase tracking-wider text-[hsl(var(--color-muted-foreground))]"
                      style={{ fontSize: "0.62em" }}
                    >
                      {tag}
                    </span>
                  ) : null}
                </div>
              );
            })}
          </div>
        );
      }

      if (segment.type === "system") {
        return (
          <div
            key={index}
            data-segment-index={index}
            className={cn(
              "reader-system reader-segment pr-10",
              annotationHighlight && "reader-highlighted",
              searchHighlighted && "reader-search-highlight",
              selectionClass
            )}
            onClick={handleSegmentClick}
            {...segmentA11yProps}
            data-search-pulse={searchPulseActive ? "true" : undefined}
            style={segmentStyle}
          >
            {highlightButton}
            {segment.speaker ? (
              <div className="reader-system-speaker" style={{ fontSize: "0.8em" }}>
                {segment.speaker}
              </div>
            ) : null}
            <div className="reader-text">{renderLines(segment.text)}</div>
          </div>
        );
      }

      if (segment.type === "subtitle") {
        const normalizedAlignment = segment.alignment?.toLowerCase();
        const alignment =
          normalizedAlignment && ["left", "center", "right"].includes(normalizedAlignment)
            ? (normalizedAlignment as CSSProperties["textAlign"])
            : undefined;

        return (
          <div
            key={index}
            data-segment-index={index}
            className={cn(
              "reader-subtitle reader-segment pr-10",
              annotationHighlight && "reader-highlighted",
              searchHighlighted && "reader-search-highlight",
              selectionClass
            )}
            onClick={handleSegmentClick}
            {...segmentA11yProps}
            data-search-pulse={searchPulseActive ? "true" : undefined}
            style={{ ...segmentStyle, textAlign: alignment }}
          >
            {highlightButton}
            {renderLines(segment.text)}
          </div>
        );
      }

      if (segment.type === "sticker") {
        const normalizedAlignment = segment.alignment?.toLowerCase();
        const alignment =
          normalizedAlignment && ["left", "center", "right"].includes(normalizedAlignment)
            ? (normalizedAlignment as CSSProperties["textAlign"])
            : undefined;

        return (
          <div
            key={index}
            data-segment-index={index}
            className={cn(
              "reader-sticker reader-segment pr-10",
              annotationHighlight && "reader-highlighted",
              searchHighlighted && "reader-search-highlight",
              selectionClass
            )}
            onClick={handleSegmentClick}
            {...segmentA11yProps}
            data-search-pulse={searchPulseActive ? "true" : undefined}
            style={{ ...segmentStyle, textAlign: alignment }}
          >
            {highlightButton}
            {renderLines(segment.text)}
          </div>
        );
      }

      if (segment.type === "header") {
        return (
          <div
            key={index}
            data-segment-index={index}
            className={cn(
              "reader-header",
              searchHighlighted && "reader-search-highlight",
              selectionClass
            )}
            onClick={handleSegmentClick}
            {...segmentA11yProps}
            data-search-pulse={searchPulseActive ? "true" : undefined}
            style={{ marginBottom: spacing, fontSize: "1.35em" }}
          >
            {segment.title}
          </div>
        );
      }

      if (segment.type === "image") {
        if (!inlineImages || minimalMode) return null;
        return (
          <ReaderImageSegment
            key={index}
            index={index}
            segment={segment}
            spacing={spacing}
            searchHighlighted={searchHighlighted}
            searchPulseActive={searchPulseActive}
            selectionClass={selectionClass}
          />
        );
      }

      if (segment.type === "music") {
        return null;
      }

      return null;
    },
    [
      inlineImages,
      minimalMode,
      readerSpacing,
      selectMode,
      toggleHighlight,
      toggleSegmentSelection,
    ]
  );

  if (loading) {
    return (
      <div
        className="h-full flex flex-col overflow-hidden reader-surface"
        data-reader-theme={settings.theme}
        aria-busy="true"
        aria-live="polite"
      >
        <header className="flex-shrink-0 z-20 bg-[hsl(var(--color-background)/0.95)] backdrop-blur border-b">
          <div className="container flex items-center gap-2 h-14">
            <Button variant="ghost" size="icon" onClick={onBack} aria-label="返回剧情列表">
              <ArrowLeft className="h-5 w-5" />
            </Button>
            <h1 className="flex-1 min-w-0 text-base font-semibold truncate">{storyName}</h1>
          </div>
        </header>
        <div className="flex-1 overflow-hidden">
          <div className="container py-8">
            <ReaderSkeleton />
          </div>
        </div>
        <span className="sr-only">正在加载剧情内容</span>
      </div>
    );
  }

  if (error) {
    return (
      <ReaderStatusScreen
        theme={settings.theme}
        storyName={storyName}
        onBack={onBack}
        tone="error"
        title="加载失败"
        description={error}
        hint="剧情数据可能还没同步完，或者这一话在当前数据版本里缺失。"
        actionLabel="重试"
        onAction={() => void loadStory()}
      />
    );
  }

  if (!content || processedSegments.length === 0) {
    return (
      <ReaderStatusScreen
        theme={settings.theme}
        storyName={storyName}
        onBack={onBack}
        tone="empty"
        title="暂无内容"
        description="这一话解析后没有可显示的段落。"
        hint="换一话看看，或在设置里重新同步剧情数据后再试。"
        actionLabel="重新加载"
        onAction={() => void loadStory()}
      />
    );
  }

  return (
    <div
      ref={readerRootRef}
      className="h-full flex flex-col overflow-hidden reader-surface"
      data-reader-theme={settings.theme}
    >
      <header
        ref={headerRef}
        className="flex-shrink-0 z-20 bg-[hsl(var(--color-background)/0.95)] backdrop-blur border-b motion-safe:transition-[margin-top,opacity] motion-safe:duration-200"
        style={{
          marginTop: headerHidden ? `-${headerHeight}px` : 0,
          opacity: headerHidden ? 0 : 1,
          pointerEvents: headerHidden ? "none" : undefined,
        }}
        // 光有 aria-hidden 会留下一排「看不见但仍能 Tab 到」的按钮，
        // 键盘焦点会凭空消失在收起的顶栏里；inert 把它整块摘干净。
        aria-hidden={headerHidden}
        inert={headerHidden}
      >
        <div className="container flex items-center gap-2 h-14">
          <Button variant="ghost" size="icon" onClick={onBack} aria-label="返回剧情列表">
            <ArrowLeft className="h-5 w-5" />
          </Button>
          <div className="flex-1 min-w-0">
            <h1 className="text-base font-semibold truncate">{storyName}</h1>
            {storyEntry && (storyEntry.storyCode || storyEntry.avgTag) && (
              <div className="mt-0.5 flex flex-wrap items-center gap-2 text-[11px] text-[hsl(var(--color-muted-foreground))]">
                {storyEntry.storyCode && (
                  <span className="px-1.5 py-0.5 rounded bg-[hsl(var(--color-accent))]">{storyEntry.storyCode}</span>
                )}
                {storyEntry.avgTag && (
                  <span className="px-1.5 py-0.5 rounded bg-[hsl(var(--color-accent))]">{storyEntry.avgTag}</span>
                )}
              </div>
            )}
          </div>
          <div className="flex items-center gap-1">
            <Button
              variant="ghost"
              size="icon"
              onClick={() => setInsightsOpen((prev) => !prev)}
              aria-label="剧情导览"
            >
              <ListTree className="h-5 w-5" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              onClick={() => (selectMode ? exitSelectMode() : enterSelectMode())}
              aria-label={selectMode ? "退出选段" : "选段"}
              title={selectMode ? "退出选段" : "选段（收藏 / 生成图片）"}
              aria-pressed={selectMode}
              className={cn(selectMode && "text-[hsl(var(--color-primary))]")}
            >
              <CheckSquare className="h-5 w-5" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              onClick={() => setSettingsOpen(true)}
              aria-label="打开阅读设置"
            >
              <SettingsIcon className="h-5 w-5" />
            </Button>
            <div className="relative" ref={moreMenuRef}>
              <Button
                ref={moreMenuTriggerRef}
                variant="ghost"
                size="icon"
                onClick={() => setMoreMenuOpen((prev) => !prev)}
                aria-label="更多操作"
                aria-haspopup="menu"
                aria-expanded={moreMenuOpen}
                className={cn(isFavorite(storyId) && "text-[hsl(var(--color-primary))]")}
              >
                <MoreHorizontal className="h-5 w-5" />
              </Button>
              {moreMenuOpen && (
                <div
                  ref={moreMenuPanelRef}
                  role="menu"
                  aria-label="更多操作"
                  aria-orientation="vertical"
                  tabIndex={-1}
                  className="absolute right-0 top-full mt-1 w-44 rounded-md border border-[hsl(var(--color-border))] bg-[hsl(var(--color-popover,var(--color-background)))] shadow-lg overflow-hidden z-30"
                >
                  <button
                    type="button"
                    role="menuitem"
                    disabled={!storyEntry}
                    onClick={() => {
                      if (storyEntry) toggleFavorite(storyEntry);
                      setMoreMenuOpen(false);
                    }}
                    className="flex w-full items-center gap-2 px-3 py-2 text-sm hover:bg-[hsl(var(--color-accent))] disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    <Star
                      className="h-4 w-4"
                      fill={isFavorite(storyId) ? "currentColor" : "transparent"}
                      strokeWidth={isFavorite(storyId) ? 0 : 2}
                    />
                    <span>{isFavorite(storyId) ? "取消收藏整关" : "收藏本关卡"}</span>
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>
      </header>

      <main className="relative flex-1 overflow-hidden" onClick={handleReaderTap}>
        {pageTapEnabled && (
          <>
            {currentPage > 0 && (
              <div
                aria-hidden="true"
                className="pointer-events-none absolute left-0.5 top-1/2 z-10 -translate-y-1/2 opacity-20 text-[hsl(var(--color-foreground))]"
              >
                <ChevronLeft className="h-6 w-6" />
              </div>
            )}
            {currentPage < totalPages - 1 && (
              <div
                aria-hidden="true"
                className="pointer-events-none absolute right-0.5 top-1/2 z-10 -translate-y-1/2 opacity-20 text-[hsl(var(--color-foreground))]"
              >
                <ChevronRight className="h-6 w-6" />
              </div>
            )}
          </>
        )}
        <CustomScrollArea
          className="h-full"
          viewportClassName={cn(
            "touch-action-pan-y reader-scroll",
            settings.readingMode === "paged" && "reader-scroll--paged"
          )}
          viewportRef={scrollContainerRef}
          trackOffsetTop="calc(3.5rem + 10px)"
          trackOffsetBottom={
            settings.readingMode === "paged"
              ? "5.5rem"
              : "calc(2.5rem + env(safe-area-inset-bottom, 0px))"
          }
        >
          <div className="container py-8 pb-24 motion-safe:animate-in motion-safe:fade-in-0 motion-safe:duration-700">
            <div className="reader-content motion-safe:animate-in motion-safe:fade-in-0 motion-safe:duration-700" style={readerContentStyles}>
              {showSummaries && storyInfoText && (
                <div className="reader-summary motion-safe:animate-in motion-safe:fade-in-0 motion-safe:duration-700">
                  {/* 概述块的字号同样用 em，随阅读器字号一起缩放。 */}
                  <div className="reader-summary-label" style={{ fontSize: "0.75em" }}>
                    剧情概述
                  </div>
                  <div className="reader-summary-body" style={{ fontSize: "0.95em" }}>
                    {renderLines(storyInfoText)}
                  </div>
                </div>
              )}
              <ReaderSegmentList
                segments={renderableSegments}
                render={renderSegment}
                isHighlighted={isHighlighted}
                selectedSet={selectedSegmentSet}
                searchIndex={highlightSegmentIndex}
                searchPulseActive={searchPulseToken > 0}
                activeCharacter={activeCharacter}
              />
            </div>
          </div>
        </CustomScrollArea>
      </main>

      {settings.readingMode === "scroll" && !selectMode && (
        <ReaderScrollProgress store={progressStore} bottomSafeArea={bottomSafeArea} />
      )}

      {settings.readingMode === "paged" && !selectMode && (
        <footer
          className="flex-shrink-0 bg-[hsl(var(--color-background)/0.95)] backdrop-blur border-t px-4 pt-4 pb-4"
          style={{ paddingBottom: `calc(${bottomSafeArea} + 1rem)` }}
        >
          <div className="container flex items-center justify-between gap-3" role="group" aria-label="翻页">
            <Button
              variant="outline"
              onClick={goToPrevPage}
              disabled={currentPage === 0}
              className="flex-1 min-h-[44px]"
              aria-label="上一页"
            >
              <ChevronLeft className="mr-2 h-4 w-4" />
              上一页
            </Button>
            {/* 「3 / 12」读起来是「三斜杠十二」，另配一句完整的播报文案；
                翻页后由 live region 播出来，视觉那份则对读屏隐藏。 */}
            <div
              className="text-xs tabular-nums text-[hsl(var(--color-muted-foreground))] min-w-[5.5rem] text-center"
              aria-live="polite"
              aria-atomic="true"
            >
              <span aria-hidden="true">
                {currentPage + 1} / {totalPages}
              </span>
              <span className="sr-only">
                第 {currentPage + 1} 页，共 {totalPages} 页，已读 {pagedPercentage}%
              </span>
              <span className="block text-[10px] opacity-75" aria-hidden="true">
                {pagedPercentage}%
              </span>
            </div>
            <Button
              variant="outline"
              onClick={goToNextPage}
              disabled={currentPage >= totalPages - 1}
              className="flex-1 min-h-[44px]"
              aria-label="下一页"
            >
              下一页
              <ChevronRight className="ml-2 h-4 w-4" />
            </Button>
          </div>
        </footer>
      )}

      {/* 上/下一话导航 —— 基于 storyGroup + storySort 推导（仅在阅读且无选段/无抽屉时展示）。 */}
      {showNeighborBar && (
        <div
          className="flex-shrink-0 border-t border-[hsl(var(--color-border))] bg-[hsl(var(--color-background)/0.92)] backdrop-blur px-4 py-2"
          style={{ paddingBottom: "calc(env(safe-area-inset-bottom, 0px) + 0.5rem)" }}
        >
          <div className="container grid grid-cols-2 gap-2" role="group" aria-label="话数导航">
            <button
              type="button"
              disabled={!neighbors.prev}
              onClick={() => neighbors.prev && onNavigateStory?.(neighbors.prev)}
              className="flex items-center gap-2 rounded-lg px-3 py-2 text-left text-xs transition-colors hover:bg-[hsl(var(--color-accent))] disabled:opacity-40 disabled:cursor-not-allowed"
              aria-label={neighbors.prev ? `上一话：${neighbors.prev.storyName}` : "已经是第一话"}
            >
              <ChevronLeft className="h-4 w-4 flex-shrink-0 text-[hsl(var(--color-muted-foreground))]" />
              <div className="min-w-0">
                <div className="text-[10px] uppercase tracking-widest text-[hsl(var(--color-muted-foreground))]">上一话</div>
                <div className="truncate text-sm font-medium text-[hsl(var(--color-foreground))]">
                  {neighbors.prev?.storyName ?? "—"}
                </div>
              </div>
            </button>
            <button
              type="button"
              disabled={!neighbors.next}
              onClick={() => neighbors.next && onNavigateStory?.(neighbors.next)}
              className="flex items-center justify-end gap-2 rounded-lg px-3 py-2 text-right text-xs transition-colors hover:bg-[hsl(var(--color-accent))] disabled:opacity-40 disabled:cursor-not-allowed"
              aria-label={neighbors.next ? `下一话：${neighbors.next.storyName}` : "已经是最后一话"}
            >
              <div className="min-w-0">
                <div className="text-[10px] uppercase tracking-widest text-[hsl(var(--color-muted-foreground))]">下一话</div>
                <div className="truncate text-sm font-medium text-[hsl(var(--color-foreground))]">
                  {neighbors.next?.storyName ?? "—"}
                </div>
              </div>
              <ChevronRight className="h-4 w-4 flex-shrink-0 text-[hsl(var(--color-muted-foreground))]" />
            </button>
          </div>
        </div>
      )}

      {selectMode && (
        <footer
          className="flex-shrink-0 bg-[hsl(var(--color-background)/0.95)] backdrop-blur border-t px-4 py-3 space-y-2"
          style={{ paddingBottom: "calc(env(safe-area-inset-bottom, 0px) + 0.75rem)" }}
        >
          {/* Paged mode needs the page controls inside the select footer;
              otherwise the user is stuck on one page while picking segments. */}
          {settings.readingMode === "paged" && (
            <div
              className="container flex items-center justify-between gap-2"
              role="group"
              aria-label="翻页"
            >
              <Button
                variant="outline"
                size="sm"
                onClick={goToPrevPage}
                disabled={currentPage === 0}
                className="flex-1 min-h-[44px]"
                aria-label="上一页"
              >
                <ChevronLeft className="mr-2 h-4 w-4" />
                上一页
              </Button>
              <div
                className="text-xs tabular-nums text-[hsl(var(--color-muted-foreground))] min-w-[4.5rem] text-center"
                aria-live="polite"
                aria-atomic="true"
              >
                <span aria-hidden="true">
                  {currentPage + 1} / {totalPages}
                </span>
                <span className="sr-only">
                  第 {currentPage + 1} 页，共 {totalPages} 页
                </span>
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={goToNextPage}
                disabled={currentPage >= totalPages - 1}
                className="flex-1 min-h-[44px]"
                aria-label="下一页"
              >
                下一页
                <ChevronRight className="ml-2 h-4 w-4" />
              </Button>
            </div>
          )}
          <div className="container flex items-center gap-2">
            <div className="flex-1 min-w-0 text-sm">
              <div className="font-medium">选段</div>
              <div className="text-xs text-[hsl(var(--color-muted-foreground))]">
                已选 {selectedSegments.length} 段 · 点击段落切换选中
              </div>
            </div>
            <Button
              variant="ghost"
              size="sm"
              className="min-h-[44px]"
              onClick={clearSelection}
              disabled={selectedSegments.length === 0}
            >
              清空
            </Button>
            <Button variant="outline" size="sm" className="min-h-[44px]" onClick={exitSelectMode}>
              取消
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="min-h-[44px]"
              onClick={handleBookmarkSelection}
              disabled={selectionBookmarkState.mode === "none"}
              title={
                selectionBookmarkState.mode === "remove"
                  ? "取消收藏选中段落"
                  : "把选中段落加入收藏"
              }
            >
              {selectionBookmarkState.mode === "remove" ? (
                <BookmarkCheck className="mr-2 h-4 w-4" />
              ) : (
                <BookmarkPlus className="mr-2 h-4 w-4" />
              )}
              {selectionBookmarkState.mode === "remove" ? "取消收藏" : "加入收藏"}
            </Button>
            <Button
              size="sm"
              className="min-h-[44px]"
              onClick={() => setShareDialogOpen(true)}
              disabled={selectedSegments.length === 0}
            >
              <Share2 className="mr-2 h-4 w-4" />
              生成图片
            </Button>
          </div>
        </footer>
      )}

      {/* 抽屉的 open 同样与 `active` 相与：它们各自会挂一个全局 Esc 监听并
          锁 body 滚动，阅读器退到后台时这些副作用不该继续生效。状态本身
          保留，回到阅读器时抽屉会照原样恢复。 */}
      <StoryInsightsPanel
        open={active && insightsOpen}
        insights={insights}
        highlightEntries={highlightEntries}
        activeCharacter={activeCharacter}
        onClose={() => setInsightsOpen(false)}
        onJumpToSegment={handleJumpToSegment}
        onClearHighlights={handleClearHighlightsUnified}
        onRemoveHighlight={handleToggleHighlightUnified}
        onCharacterSelect={handleCharacterHighlight}
        onClearCharacter={clearCharacterHighlight}
      />

      <ReaderSettingsPanel
        open={active && settingsOpen}
        settings={settings}
        onClose={closeSettings}
        onUpdateSettings={updateSettings}
        onReset={resetSettings}
      />

      <ShareImageDialog
        open={active && shareDialogOpen}
        onClose={() => setShareDialogOpen(false)}
        storyName={storyName}
        categoryName={categoryName}
        storyCode={storyEntry?.storyCode ?? null}
        segments={selectedShareSegments}
      />
    </div>
  );
}


interface ReaderScrollProgressProps {
  store: ProgressStore;
  bottomSafeArea: string;
}

/**
 * 连续滚动模式的底部进度条。
 *
 * 单独拆出来订阅外部 store：百分比是全屏里唯一每帧都在变的东西，留在阅读器
 * 里就会拖着顶栏、页脚、抽屉一起走 diff。现在滚动时重渲染的只有这一条。
 */
const ReaderScrollProgress = memo(function ReaderScrollProgress({
  store,
  bottomSafeArea,
}: ReaderScrollProgressProps) {
  const ratio = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  const percentage = toPercentage(ratio);
  return (
    <div
      className="flex-shrink-0 bg-[hsl(var(--color-background)/0.92)] backdrop-blur border-t border-[hsl(var(--color-border))]"
      style={{ paddingBottom: bottomSafeArea }}
    >
      <div
        className="progress-track"
        role="progressbar"
        aria-label="阅读进度"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percentage}
        aria-valuetext={`已读 ${percentage}%`}
      >
        <div className="progress-thumb" style={{ width: `${percentage}%` }} aria-hidden="true" />
      </div>
      {/* 数字只是进度条的视觉复述，交给上面的 progressbar 播报即可。 */}
      <div
        className="container flex items-center justify-end px-4 py-1 text-[11px] uppercase tracking-wider text-[hsl(var(--color-muted-foreground))]"
        aria-hidden="true"
      >
        已读 {percentage}%
      </div>
    </div>
  );
});

interface ReaderStatusScreenProps {
  theme: string;
  storyName: string;
  onBack: () => void;
  tone: "error" | "empty";
  title: string;
  description: string;
  hint: string;
  actionLabel: string;
  onAction: () => void;
}

/**
 * 失败 / 空内容时的整屏状态页。
 *
 * 沿用加载态的顶栏结构（返回键 + 标题），这样从骨架屏切到错误页时版式不会
 * 整个塌一次；返回入口也始终在同一个位置，不必靠正中间那颗按钮找路。
 */
function ReaderStatusScreen({
  theme,
  storyName,
  onBack,
  tone,
  title,
  description,
  hint,
  actionLabel,
  onAction,
}: ReaderStatusScreenProps) {
  return (
    <div
      className="h-full flex flex-col overflow-hidden reader-surface"
      data-reader-theme={theme}
    >
      <header className="flex-shrink-0 z-20 bg-[hsl(var(--color-background)/0.95)] backdrop-blur border-b">
        <div className="container flex items-center gap-2 h-14">
          <Button variant="ghost" size="icon" onClick={onBack} aria-label="返回剧情列表">
            <ArrowLeft className="h-5 w-5" />
          </Button>
          <h1 className="flex-1 min-w-0 text-base font-semibold truncate">{storyName}</h1>
        </div>
      </header>
      <div
        className="flex-1 flex flex-col items-center justify-center gap-3 px-6 text-center"
        role={tone === "error" ? "alert" : undefined}
        aria-live="polite"
      >
        <div
          className={cn(
            "text-base font-medium",
            tone === "error"
              ? "text-[hsl(var(--color-destructive))]"
              : "text-[hsl(var(--color-foreground))]"
          )}
        >
          {title}
        </div>
        <p className="max-w-[28rem] text-sm text-[hsl(var(--color-muted-foreground))] break-words">
          {description}
        </p>
        <p className="max-w-[28rem] text-xs text-[hsl(var(--color-muted-foreground))]">{hint}</p>
        <div className="mt-2 flex flex-wrap items-center justify-center gap-2">
          <Button onClick={onAction} className="min-h-[44px]">
            <RefreshCw className="mr-2 h-4 w-4" />
            {actionLabel}
          </Button>
          <Button onClick={onBack} variant="outline" className="min-h-[44px]">
            <ArrowLeft className="mr-2 h-4 w-4" />
            返回列表
          </Button>
        </div>
      </div>
    </div>
  );
}

interface ReaderSegmentRowProps extends SegmentRowState {
  item: RenderableSegment;
  isLast: boolean;
  render: SegmentRenderer;
}

/**
 * 单个段落的记忆化外壳。
 *
 * 一篇主线剧情动辄上千段，任何一次「收藏某段 / 选中某段 / 跳到搜索命中」
 * 都会让父组件重渲染；如果每段都跟着重建 DOM，手机上一眼就能看出卡顿。
 * 这里把每段的渲染结果按上面那几个布尔值缓存住，只有真正变化的那一段
 * 会重新渲染。
 */
const ReaderSegmentRow = memo(function ReaderSegmentRow({
  item,
  isLast,
  render,
  highlighted,
  searchHighlighted,
  searchPulseActive,
  characterHighlighted,
  selected,
}: ReaderSegmentRowProps) {
  return (
    <>
      {render(item, isLast, {
        highlighted,
        searchHighlighted,
        searchPulseActive,
        characterHighlighted,
        selected,
      })}
    </>
  );
});

interface ReaderSegmentListProps {
  segments: RenderableSegment[];
  render: SegmentRenderer;
  isHighlighted: (index: number) => boolean;
  selectedSet: ReadonlySet<number>;
  searchIndex: number | null;
  searchPulseActive: boolean;
  activeCharacter: string | null;
}

/**
 * 正文列表。整体再包一层 `memo`：滚动进度、顶栏收起、上一话/下一话加载完成
 * 这些只影响外壳的状态，不该让正文重新走一遍 diff。
 */
const ReaderSegmentList = memo(function ReaderSegmentList({
  segments,
  render,
  isHighlighted,
  selectedSet,
  searchIndex,
  searchPulseActive,
  activeCharacter,
}: ReaderSegmentListProps) {
  const lastIndex = segments.length - 1;
  return (
    <>
      {segments.map((item, position) => {
        const { segment, index } = item;
        const searchHit = searchIndex === index;
        return (
          <ReaderSegmentRow
            key={index}
            item={item}
            isLast={position === lastIndex}
            render={render}
            highlighted={isHighlighted(index)}
            searchHighlighted={searchHit}
            searchPulseActive={searchHit && searchPulseActive}
            characterHighlighted={
              segment.type === "dialogue" && activeCharacter === segment.characterName
            }
            selected={selectedSet.has(index)}
          />
        );
      })}
    </>
  );
});

/**
 * 加载态骨架屏：用几条灰条模拟"头像 + 角色名 + 正文"的节奏，比一行
 * "加载中..." 更接近最终版式，切换时不会整屏跳动。
 */
function ReaderSkeleton() {
  const rows = [
    { width: "38%", lines: 2 },
    { width: "46%", lines: 3 },
    { width: "32%", lines: 2 },
    { width: "42%", lines: 3 },
  ];
  return (
    <div className="mx-auto w-full max-w-[48rem] px-6 space-y-7 motion-safe:animate-pulse">
      {rows.map((row, rowIndex) => (
        <div key={rowIndex} className="flex gap-3">
          <div className="h-9 w-9 flex-shrink-0 rounded-full bg-[hsl(var(--color-muted)/0.45)]" />
          <div className="flex-1 space-y-2">
            <div
              className="h-3.5 rounded bg-[hsl(var(--color-muted)/0.55)]"
              style={{ width: row.width }}
            />
            {Array.from({ length: row.lines }).map((_, lineIndex) => (
              <div
                key={lineIndex}
                className="h-3 rounded bg-[hsl(var(--color-muted)/0.32)]"
                style={{ width: lineIndex === row.lines - 1 ? "72%" : "100%" }}
              />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

interface ReaderImageSegmentProps {
  index: number;
  segment: { type: "image"; token: string; caption?: string | null };
  spacing: string;
  searchHighlighted: boolean;
  searchPulseActive: boolean;
  selectionClass: string;
}

/**
 * 阅读器内的插画段。独立组件，因为需要一个本地 `failed` 状态：当素材加载
 * 失败时把整个段落从文档中移除，避免 16:9 的灰色块打断正文（这是 v1.11
 * 第一次迭代中最明显的视觉污染来源——字段 `bg_xxx` / `avg_xxx` 在社区
 * 镜像里的命中率并不是 100%）。
 */
function ReaderImageSegment({
  index,
  segment,
  spacing,
  searchHighlighted,
  searchPulseActive,
  selectionClass,
}: ReaderImageSegmentProps) {
  const [failed, setFailed] = useState(false);
  // exhausted 不一定是「素材真没了」：断网/源被墙时，一段插画只有 3 条
  // 候选，会在主机熔断阈值（8 次）攒够之前就逐条 onerror，AssetImage 只能
  // 上报 exhausted。此时若把段落永久删掉，等网络恢复（markAssetUrlAlive
  // 撤销那批不可靠的失败记录）插画也回不来了——AssetImage 已被卸载，谁都
  // 收不到健康事件。所以隐藏期间订阅健康度：事件到来（源首次被证明可达 /
  // 熔断窗口到期）时撤销 failed、重挂 AssetImage 再试一次；真正 404 的
  // 段落会立刻再次 exhausted，照旧隐藏。
  const healthNonce = useAssetHealthNonce(failed);
  const seenHealthNonceRef = useRef(healthNonce);
  if (seenHealthNonceRef.current !== healthNonce) {
    seenHealthNonceRef.current = healthNonce;
    if (failed) setFailed(false);
  }
  if (failed) return null;
  return (
    <div
      data-segment-index={index}
      className={cn(
        "reader-segment-image reader-segment",
        searchHighlighted && "reader-search-highlight",
        selectionClass
      )}
      data-search-pulse={searchPulseActive ? "true" : undefined}
      style={{ marginBottom: spacing }}
    >
      <AssetImage
        kind="image"
        token={segment.token}
        alt={segment.caption ?? "剧情插画"}
        tint="none"
        fit="natural"
        onExhausted={() => setFailed(true)}
      />
      {segment.caption ? (
        <div className="reader-segment-image-caption">{segment.caption}</div>
      ) : null}
    </div>
  );
}
