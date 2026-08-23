import {
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
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
import { useReadingProgress } from "@/hooks/useReadingProgress";
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

const BASE_MAX_WIDTH = 768; // px
const TARGET_CHARS_PER_PAGE = 900; // approximate characters we aim to fit per page

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

export function StoryReader({ storyId, storyPath, storyName, onBack, initialFocus, initialCharacter, initialJump, onNavigateStory }: StoryReaderProps) {
  const [content, setContent] = useState<ParsedStoryContent | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [currentPage, setCurrentPage] = useState(0);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [insightsOpen, setInsightsOpen] = useState(false);
  const [progressValue, setProgressValue] = useState(0);
  const [highlightSegmentIndex, setHighlightSegmentIndex] = useState<number | null>(null);
  // Monotonic token used to trigger the one-shot search-highlight pulse
  // animation. Bumped each time the reader jumps to a new hit; cleared
  // after the pulse keyframes finish so the data attribute auto-removes.
  const [searchPulseToken, setSearchPulseToken] = useState(0);
  const [activeCharacter, setActiveCharacter] = useState<string | null>(null);
  const [storyEntry, setStoryEntry] = useState<StoryEntry | null>(null);
  const [storyInfoText, setStoryInfoText] = useState<string | null>(null);
  // 沉浸阅读：连续滚动模式下向下滚动收起顶栏，向上滚动/回到顶部再展开。
  const [headerHidden, setHeaderHidden] = useState(false);
  const [headerHeight, setHeaderHeight] = useState(56);

  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
  const readerRootRef = useRef<HTMLDivElement | null>(null);
  const headerRef = useRef<HTMLElement | null>(null);
  const focusAppliedRef = useRef<number | null>(null);
  const characterAppliedRef = useRef<string | null>(null);
  const pendingScrollIndexRef = useRef<number | null>(null);
  const jumpAppliedRef = useRef<number | null>(null);
  const lastScrollTopRef = useRef(0);
  // 已恢复过阅读进度的 `storyPath::readingMode`，避免"滚动→写进度→再恢复"回路。
  const restoredKeyRef = useRef<string | null>(null);

  const { settings, updateSettings, resetSettings } = useReaderSettings();
  const { showSummaries, minimalMode, inlineImages } = useAppPreferences();
  const { progress, updateProgress } = useReadingProgress(storyPath);
  const { isFavorite, toggleFavorite } = useFavorites();
  const [neighbors, setNeighbors] = useState<StoryNeighbors>({ prev: null, next: null });
  const [categoryName, setCategoryName] = useState<string | null>(null);

  // Multi-select state for "分享为图片". Keeps indices in insertion order so
  // the exported image preserves the user's chosen emphasis; sorting happens
  // at render time so the output is always read top-to-bottom.
  const [selectedSegments, setSelectedSegments] = useState<number[]>([]);
  const [selectMode, setSelectMode] = useState(false);
  const [shareDialogOpen, setShareDialogOpen] = useState(false);
  const [moreMenuOpen, setMoreMenuOpen] = useState(false);
  const moreMenuRef = useRef<HTMLDivElement | null>(null);

  // 抽屉 / 选段工具栏是否占据了界面。滚动监听里用 ref 读取，避免因为这些
  // 状态变化而反复重建 scroll listener。
  const overlayOpenRef = useRef(false);
  overlayOpenRef.current =
    settingsOpen || insightsOpen || shareDialogOpen || selectMode || moreMenuOpen;

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
  useBackHandler(shareDialogOpen, () => {
    setShareDialogOpen(false);
    return true;
  });
  useBackHandler(insightsOpen, () => {
    setInsightsOpen(false);
    return true;
  });
  useBackHandler(settingsOpen, () => {
    setSettingsOpen(false);
    return true;
  });
  useBackHandler(selectMode, () => {
    setSelectMode(false);
    setSelectedSegments([]);
    return true;
  });
  useBackHandler(moreMenuOpen, () => {
    setMoreMenuOpen(false);
    return true;
  });

  // 点击外部关闭更多菜单
  useEffect(() => {
    if (!moreMenuOpen) return;
    const handlePointer = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (target && moreMenuRef.current?.contains(target)) return;
      setMoreMenuOpen(false);
    };
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMoreMenuOpen(false);
    };
    window.addEventListener("pointerdown", handlePointer);
    window.addEventListener("keydown", handleKey);
    return () => {
      window.removeEventListener("pointerdown", handlePointer);
      window.removeEventListener("keydown", handleKey);
    };
  }, [moreMenuOpen]);

  // iOS-style edge swipe back — close the reader when the user swipes from
  // the left edge. Only active when none of the inner modals are open so the
  // gesture doesn't accidentally fight the in-modal close animation.
  useEdgeSwipeBack(readerRootRef, {
    // Disable edge-swipe while any drawer or the multi-select toolbar is
    // open — otherwise a stray swipe could tear down a half-captured
    // selection / share preview.
    enabled: !settingsOpen && !insightsOpen && !shareDialogOpen && !selectMode,
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

    const boundaries: number[] = [0];
    let acc = 0;
    processedSegments.forEach((seg, idx) => {
      const len = approximateSegmentLength(seg);
      // Always break before a Header — chapters/sections open a new page.
      const isHeader = seg.type === "header";
      if (idx > 0 && isHeader && boundaries[boundaries.length - 1] !== idx) {
        boundaries.push(idx);
        acc = 0;
      }
      acc += len;
      if (acc >= budget && idx + 1 < processedSegments.length) {
        boundaries.push(idx + 1);
        acc = 0;
      }
    });
    return boundaries;
  }, [processedSegments, settings.fontSize]);

  const totalPages = useMemo(() => {
    if (!processedSegments.length) return 0;
    return Math.max(1, pageBoundaries.length);
  }, [pageBoundaries, processedSegments]);

  const progressPercentage = useMemo(() => {
    const clamped = Math.max(0, Math.min(1, progressValue));
    return Math.round(clamped * 1000) / 10; // keep one decimal precision
  }, [progressValue]);

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
    () => `${Math.max(settings.paragraphSpacing, 0.5)}rem`,
    [settings.paragraphSpacing]
  );

  const renderLines = useCallback((text: string) => {
    const parts = text.split("\n");
    return parts.map((line, index) => (
      <span key={index}>
        {line}
        {index < parts.length - 1 ? <br /> : null}
      </span>
    ));
  }, []);

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
    [settings.readingMode]
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
    try {
      setLoading(true);
      setError(null);
      const data = await api.getStoryContent(storyPath);
      setContent(data);
      setCurrentPage(0);
      // Bump reading streak when user actually opens a story.
      try {
        bumpReadingStreak();
      } catch {}
    } catch (err) {
      setError(err instanceof Error ? err.message : "加载失败");
    } finally {
      setLoading(false);
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
        if (mounted) setStoryEntry(entry);
      } catch {
        // ignore
      }
    })();
    return () => { mounted = false; };
  }, [storyId]);

  // 加载 prev/next
  useEffect(() => {
    let mounted = true;
    setNeighbors({ prev: null, next: null });
    (async () => {
      try {
        const n = await api.getStoryNeighbors(storyId);
        if (mounted) setNeighbors(n);
      } catch {
        // ignore
      }
    })();
    return () => {
      mounted = false;
    };
  }, [storyId]);

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
        console.warn("[StoryReader] Failed to load story summary:", err);
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

    // 若正在处理搜索跳转或初始定位，避免恢复旧的阅读进度，以免覆盖滚动
    const shouldSkipRestore =
      pendingScrollIndexRef.current !== null ||
      (initialFocus && initialFocus.storyId === storyId) ||
      (initialJump && initialJump.storyId === storyId);
    if (shouldSkipRestore) {
      restoredKeyRef.current = restoreKey;
      return;
    }

    const stored = progressRef.current;

    // 上次是另一种阅读模式时，用百分比近似换算，别一路弹回开头。
    const storedPercentage =
      typeof stored?.percentage === "number" && Number.isFinite(stored.percentage)
        ? Math.max(0, Math.min(1, stored.percentage))
        : 0;

    if (settings.readingMode === "paged") {
      const lastPage = Math.max(totalPages - 1, 0);
      const storedPage =
        stored?.readingMode === "paged" && typeof stored.currentPage === "number"
          ? Math.min(stored.currentPage, lastPage)
          : Math.round(storedPercentage * lastPage);
      setCurrentPage(storedPage);
      const ratio = totalPages <= 1 ? 1 : (storedPage + 1) / totalPages;
      setProgressValue(Number.isFinite(ratio) ? ratio : 0);
    } else {
      const container = scrollContainerRef.current;
      if (!container) return;
      const storedTop =
        stored?.readingMode === "scroll" && typeof stored.scrollTop === "number"
          ? stored.scrollTop
          : storedPercentage * Math.max(container.scrollHeight - container.clientHeight, 0);
      container.scrollTo({ top: storedTop });
      lastScrollTopRef.current = storedTop;
      const { scrollHeight, clientHeight } = container;
      const denominator = scrollHeight - clientHeight;
      const ratio = denominator <= 0 ? 1 : storedTop / denominator;
      setProgressValue(Number.isFinite(ratio) ? ratio : 0);
    }

    restoredKeyRef.current = restoreKey;
  }, [
    processedSegments,
    settings.readingMode,
    storyPath,
    totalPages,
    initialFocus,
    initialJump,
    storyId,
  ]);

  useEffect(() => {
    if (!processedSegments.length || settings.readingMode !== "scroll") return;
    const container = scrollContainerRef.current;
    if (!container) return;

    let frame = 0;
    const handleScroll = () => {
      if (frame) cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const { scrollTop, scrollHeight, clientHeight } = container;
        const denominator = scrollHeight - clientHeight;
        const ratio = denominator <= 0 ? 1 : scrollTop / denominator;
        const clamped = Number.isFinite(ratio) ? Math.max(0, Math.min(1, ratio)) : 0;
        setProgressValue(clamped);
        updateProgress({
          readingMode: "scroll",
          scrollTop,
          percentage: clamped,
          updatedAt: Date.now(),
        });

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
  }, [processedSegments, settings.readingMode, updateProgress]);

  useEffect(() => {
    if (!processedSegments.length || settings.readingMode !== "paged" || totalPages === 0) return;
    const ratio = totalPages <= 1 ? 1 : (currentPage + 1) / totalPages;
    const clamped = Number.isFinite(ratio) ? Math.max(0, Math.min(1, ratio)) : 0;
    setProgressValue(clamped);
    updateProgress({
      readingMode: "paged",
      currentPage,
      percentage: clamped,
      updatedAt: Date.now(),
    });
  }, [processedSegments, currentPage, settings.readingMode, totalPages, updateProgress]);

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
    const handleKey = (event: KeyboardEvent) => {
      // 段落自己已经消费掉的按键（选段模式的空格/回车）不再重复处理。
      if (event.defaultPrevented) return;
      const target = event.target as HTMLElement | null;
      if (target?.tagName && ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName)) {
        return;
      }
      if (target?.isContentEditable) return;
      // 抽屉打开时把按键留给抽屉本身（Esc 关闭等）。
      if (settingsOpen || insightsOpen || shareDialogOpen) return;

      const isSpace = event.key === " " || event.key === "Spacebar";
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
    settings.readingMode,
    totalPages,
    settingsOpen,
    insightsOpen,
    shareDialogOpen,
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

      pendingScrollIndexRef.current = index;
      if (settings.readingMode === "scroll") {
        // 直接尝试一次，若元素未渲染，layout effect 会再次兜底
        scrollToSegment(index);
      } else {
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
    },
    [processedSegments, scrollToSegment, settings.readingMode, totalPages, pageBoundaries]
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
    }
    jumpAppliedRef.current = token;
  }, [
    initialJump,
    processedSegments,
    findFocusSegmentIndex,
    jumpToSegment,
    storyId,
  ]);

  // 初始角色高亮与定位（人物面板点击"在剧情中查看"）。使用 jumpToSegment，
  // 这样分页模式也会翻到该角色首次出场的那一页，而不是只在当前页滚动。
  useEffect(() => {
    if (!processedSegments.length) return;
    if (!initialCharacter) return;
    if (characterAppliedRef.current === initialCharacter && activeCharacter === initialCharacter) return;

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
  }, [processedSegments, initialCharacter, activeCharacter, jumpToSegment]);

  // 当页面或段落渲染完成后，执行挂起的滚动请求（最多尝试几次）
  useLayoutEffect(() => {
    if (pendingScrollIndexRef.current === null) return;
    let tries = 0;
    const tick = () => {
      const index = pendingScrollIndexRef.current;
      if (index === null) return;
      const container = scrollContainerRef.current;
      if (container) {
        const element = container.querySelector<HTMLElement>(`[data-segment-index="${index}"]`);
        if (element) {
          // 找到了目标元素，执行滚动
          scrollToSegment(index);
          pendingScrollIndexRef.current = null;
          return;
        }
      }
      if (tries < 30) {
        tries += 1;
        requestAnimationFrame(tick);
      }
    };
    requestAnimationFrame(tick);
  }, [renderableSegments, currentPage, settings.readingMode, scrollToSegment]);

  useEffect(() => {
    if (!initialFocus || !processedSegments.length) return;
    const token = initialFocus.issuedAt ?? Date.now();
    if (focusAppliedRef.current === token && highlightSegmentIndex !== null) {
      return;
    }

    const targetIndex = findFocusSegmentIndex(initialFocus);
    if (targetIndex === null) {
      focusAppliedRef.current = token;
      setHighlightSegmentIndex(null);
      return;
    }

    setActiveCharacter(null);
    jumpToSegment(targetIndex, { highlightSearch: true });
    focusAppliedRef.current = token;
  }, [
    initialFocus,
    processedSegments,
    findFocusSegmentIndex,
    jumpToSegment,
    highlightSegmentIndex,
  ]);

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

  const renderSegment = useCallback(
    ({ segment, index }: RenderableSegment, isLast: boolean) => {
      const spacing = isLast ? "0" : readerSpacing;
      const highlightable = isSegmentHighlightable(segment);
      const annotationHighlight = highlightable ? isHighlighted(index) : false;
      const searchHighlighted = highlightSegmentIndex === index;
      // When true, the segment is the freshly-navigated-to search hit —
      // attach `data-search-pulse` so the CSS keyframe runs once.
      const searchPulseActive = searchHighlighted && searchPulseToken > 0;
      const characterHighlighted =
        highlightable && segment.type === "dialogue" && activeCharacter === segment.characterName;
      const isSelected = selectedSegments.includes(index);
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
            isSelected && "ring-2 ring-[hsl(var(--color-primary))] ring-offset-2 ring-offset-transparent"
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
                border: `1px solid hsl(var(--color-${
                  annotationHighlight ? "primary" : "border"
                }) / ${annotationHighlight ? "0.45" : "1"})`,
                background: annotationHighlight
                  ? "hsl(var(--color-primary) / 0.18)"
                  : "hsl(var(--color-card) / 0.92)",
                color: annotationHighlight
                  ? "hsl(var(--color-primary))"
                  : "hsl(var(--color-muted-foreground))",
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
      activeCharacter,
      highlightSegmentIndex,
      inlineImages,
      isHighlighted,
      minimalMode,
      readerSpacing,
      renderLines,
      searchPulseToken,
      selectMode,
      selectedSegments,
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
      <div className="flex flex-col items-center justify-center h-full gap-4 px-6 text-center">
        <div className="text-[hsl(var(--color-destructive))]">加载失败: {error}</div>
        <div className="flex flex-wrap items-center justify-center gap-2">
          <Button onClick={() => void loadStory()} className="min-h-[44px]">
            <RefreshCw className="mr-2 h-4 w-4" />
            重试
          </Button>
          <Button onClick={onBack} variant="outline" className="min-h-[44px]">
            <ArrowLeft className="mr-2 h-4 w-4" />
            返回
          </Button>
        </div>
      </div>
    );
  }

  if (!content || processedSegments.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-4 px-6 text-center">
        <div className="text-[hsl(var(--color-muted-foreground))]">暂无内容</div>
        <div className="flex flex-wrap items-center justify-center gap-2">
          <Button onClick={() => void loadStory()} variant="outline" className="min-h-[44px]">
            <RefreshCw className="mr-2 h-4 w-4" />
            重新加载
          </Button>
          <Button onClick={onBack} variant="outline" className="min-h-[44px]">
            <ArrowLeft className="mr-2 h-4 w-4" />
            返回
          </Button>
        </div>
      </div>
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
        aria-hidden={headerHidden}
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
                  role="menu"
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
              {renderableSegments.map((segment, idx) =>
                renderSegment(segment, idx === renderableSegments.length - 1)
              )}
            </div>
          </div>
        </CustomScrollArea>
      </main>

      {settings.readingMode === "scroll" && !selectMode && (
        <div
          className="flex-shrink-0 bg-[hsl(var(--color-background)/0.92)] backdrop-blur border-t border-[hsl(var(--color-border))]"
          style={{ paddingBottom: "env(safe-area-inset-bottom, 0px)" }}
          aria-hidden="false"
        >
          <div className="progress-track">
            <div
              className="progress-thumb"
              style={{ width: `${progressPercentage}%` }}
              aria-hidden="true"
            />
          </div>
          <div className="container flex items-center justify-end px-4 py-1 text-[11px] uppercase tracking-wider text-[hsl(var(--color-muted-foreground))]">
            已读 {progressPercentage}%
          </div>
        </div>
      )}

      {settings.readingMode === "paged" && !selectMode && (
        <footer
          className="flex-shrink-0 bg-[hsl(var(--color-background)/0.95)] backdrop-blur border-t px-4 pt-4 pb-4"
          style={{ paddingBottom: "calc(env(safe-area-inset-bottom, 0px) + 1rem)" }}
        >
          <div className="container flex items-center justify-between gap-3">
            <Button
              variant="outline"
              onClick={goToPrevPage}
              disabled={currentPage === 0}
              className="flex-1 min-h-[44px]"
            >
              <ChevronLeft className="mr-2 h-4 w-4" />
              上一页
            </Button>
            <div className="text-xs tabular-nums text-[hsl(var(--color-muted-foreground))] min-w-[5.5rem] text-center">
              {currentPage + 1} / {totalPages}
              <span className="block text-[10px] opacity-75">{progressPercentage}%</span>
            </div>
            <Button
              variant="outline"
              onClick={goToNextPage}
              disabled={currentPage >= totalPages - 1}
              className="flex-1 min-h-[44px]"
            >
              下一页
              <ChevronRight className="ml-2 h-4 w-4" />
            </Button>
          </div>
        </footer>
      )}

      {/* 上/下一话导航 —— 基于 storyGroup + storySort 推导（仅在阅读且无选段/无抽屉时展示）。 */}
      {!selectMode && !settingsOpen && !insightsOpen && !shareDialogOpen && (neighbors.prev || neighbors.next) && (
        <div
          className="flex-shrink-0 border-t border-[hsl(var(--color-border))] bg-[hsl(var(--color-background)/0.92)] backdrop-blur px-4 py-2"
          style={{ paddingBottom: "calc(env(safe-area-inset-bottom, 0px) + 0.5rem)" }}
        >
          <div className="container grid grid-cols-2 gap-2">
            <button
              type="button"
              disabled={!neighbors.prev}
              onClick={() => neighbors.prev && onNavigateStory?.(neighbors.prev)}
              className="flex items-center gap-2 rounded-lg px-3 py-2 text-left text-xs transition-colors hover:bg-[hsl(var(--color-accent))] disabled:opacity-40 disabled:cursor-not-allowed"
              aria-label="上一话"
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
              aria-label="下一话"
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
            <div className="container flex items-center justify-between gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={goToPrevPage}
                disabled={currentPage === 0}
                className="flex-1 min-h-[44px]"
              >
                <ChevronLeft className="mr-2 h-4 w-4" />
                上一页
              </Button>
              <div className="text-xs tabular-nums text-[hsl(var(--color-muted-foreground))] min-w-[4.5rem] text-center">
                {currentPage + 1} / {totalPages}
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={goToNextPage}
                disabled={currentPage >= totalPages - 1}
                className="flex-1 min-h-[44px]"
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
              onClick={clearSelection}
              disabled={selectedSegments.length === 0}
            >
              清空
            </Button>
            <Button variant="outline" size="sm" onClick={exitSelectMode}>
              取消
            </Button>
            <Button
              variant="outline"
              size="sm"
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
              onClick={() => setShareDialogOpen(true)}
              disabled={selectedSegments.length === 0}
            >
              <Share2 className="mr-2 h-4 w-4" />
              生成图片
            </Button>
          </div>
        </footer>
      )}

      <StoryInsightsPanel
        open={insightsOpen}
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
        open={settingsOpen}
        settings={settings}
        onClose={() => setSettingsOpen(false)}
        onUpdateSettings={updateSettings}
        onReset={resetSettings}
      />

      <ShareImageDialog
        open={shareDialogOpen}
        onClose={() => setShareDialogOpen(false)}
        storyName={storyName}
        categoryName={categoryName}
        storyCode={storyEntry?.storyCode ?? null}
        segments={selectedShareSegments}
      />
    </div>
  );
}


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
