import { useCallback, useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { CustomScrollArea } from "@/components/ui/custom-scroll-area";
import {
  SheetShell,
  SheetHeader,
  SheetFooter,
  SheetGroup,
  SheetSectionLabel,
} from "@/components/ui/sheet-shell";
import { useToast } from "@/components/ui/toast";
import { useSidePanel } from "@/hooks/useSidePanel";
import {
  detectRuntimePlatform,
  type RuntimePlatform,
} from "@/hooks/useAppUpdater";
import {
  openStoragePermissionSettings,
  saveImageToDesktopFile,
  saveImageToGallery,
  shareImageViaSystem,
  type ShareImagePayload,
} from "@/hooks/useImageSharer";
import { peekAssetCandidates } from "@/hooks/useAsset";
import type { DialogueSegment, StorySegment } from "@/types/story";
import { Download, Loader2, Share2, X } from "lucide-react";
import { cn } from "@/lib/utils";

const SHOW_AVATAR_STORAGE_KEY = "arknights-share-image-show-avatar";

export interface ShareSegmentInput {
  index: number;
  segment: StorySegment;
}

interface ShareImageDialogProps {
  open: boolean;
  onClose: () => void;
  storyName: string;
  /** 所在章节/活动名，例如 "黑暗时代·上"、"和光同尘"。未知时传 null。 */
  categoryName?: string | null;
  /** 关卡代号，例如 "0-1"。未知时传 null。 */
  storyCode?: string | null;
  segments: ShareSegmentInput[];
}

/**
 * Which share-image template to render. `classic` is the original long
 * composition; `quote` renders a 1080×1350 single-dialogue "poster" using
 * the first dialogue segment in the selection.
 */
type TemplateKind = "classic" | "quote";

const CANVAS_WIDTH = 1080;
const CANVAS_HORIZONTAL_PADDING = 72;
const CANVAS_TOP_PADDING = 96;
const CANVAS_BOTTOM_PADDING = 96;
const CONTENT_LINE_HEIGHT = 46;
const CONTENT_FONT_SIZE = 30;
const CONTENT_FONT_FAMILY =
  "'Arknights Noto Serif SC', 'Noto Serif SC', 'PingFang SC', 'Microsoft YaHei', serif";
const TITLE_FONT_FAMILY =
  "'Arknights Noto Sans SC', 'Noto Sans SC', 'PingFang SC', 'Microsoft YaHei', sans-serif";

// Measured colors — paper-white background with ink-black body copy so the
// image stays readable in messaging apps that re-render previews at small
// sizes.
const BG_COLOR = "#f6f2ea";
const ACCENT_COLOR = "#b45309";
const TEXT_COLOR = "#221c14";
const MUTED_COLOR = "#7b6d58";
const DIVIDER_COLOR = "rgba(123, 109, 88, 0.25)";

/**
 * Font specs used by {@link buildLayout}. We must `document.fonts.load()`
 * each spec before the first `canvas.toDataURL()` — the subset woff2 files
 * declared in `src/index.css` are loaded lazily via `font-display: swap`
 * and `unicode-range`, so if the user only ever touched sans/ UI glyphs
 * the serif body font may not be available when we rasterise. Missing a
 * font causes canvas to silently fall back to the system serif, which
 * measures differently from the woff2 that eventually ends up in the
 * visible preview — so the exported image breaks its own wrap math.
 */
const REQUIRED_FONT_SPECS = [
  `600 38px ${TITLE_FONT_FAMILY}`,
  `500 20px ${TITLE_FONT_FAMILY}`,
  `600 34px ${TITLE_FONT_FAMILY}`,
  `600 24px ${TITLE_FONT_FAMILY}`,
  `400 18px ${TITLE_FONT_FAMILY}`,
  `400 ${CONTENT_FONT_SIZE}px ${CONTENT_FONT_FAMILY}`,
  `italic 400 ${CONTENT_FONT_SIZE}px ${CONTENT_FONT_FAMILY}`,
  // Quote template — make sure the big serif quotation marks, the 38px
  // body line, the bold attribution and the tiny watermark all ship a
  // loaded font so canvas doesn't silently swap to a system fallback that
  // measures differently from what the preview tests against.
  `400 120px ${CONTENT_FONT_FAMILY}`,
  `400 38px ${CONTENT_FONT_FAMILY}`,
  `700 24px ${CONTENT_FONT_FAMILY}`,
  `400 12px ${TITLE_FONT_FAMILY}`,
];

async function ensureFontsLoaded(sampleText: string): Promise<void> {
  // Narrow `document.fonts` — older WebViews may not expose the Font
  // Loading API at all. If it's missing we fall back immediately; canvas
  // will pick the system font and the preview will match that choice.
  const fonts = typeof document !== "undefined" ? (document as unknown as { fonts?: FontFaceSet }).fonts : undefined;
  if (!fonts || typeof fonts.load !== "function") return;
  const probe = sampleText && sampleText.length > 0 ? sampleText : "示例文本 Sample";
  await Promise.all(
    REQUIRED_FONT_SPECS.map((spec) =>
      // Passing a sample string so the browser pulls in every unicode-range
      // subset actually needed for this story (CJK + ASCII at minimum).
      fonts.load(spec, probe).catch(() => undefined)
    )
  );
}

/**
 * 头像位图缓存。key 用 "name::charId" 组合，value 是第一条加载成功的
 * `HTMLImageElement`（canvas `drawImage` 可直接吃），失败则是 null。
 * 分享弹窗通常会被反复开启 / 切换选段，同一张头像多次入画时不该再次下载。
 */
const avatarCache = new Map<string, HTMLImageElement | null>();

function avatarCacheKey(name: string | null | undefined, charId: string | null | undefined): string {
  return `${(name ?? "").trim()}::${(charId ?? "").trim()}`;
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    // 必须是 anonymous —— 否则 webview 会把图片标为 tainted，后续
    // `canvas.toDataURL()` 会直接抛 SecurityError。GitHub Raw CDN 对
    // 此类请求允许跨域（响应带 ACAO `*`）。
    img.crossOrigin = "anonymous";
    img.referrerPolicy = "no-referrer";
    img.decoding = "async";
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`Failed to load image: ${url}`));
    img.src = url;
  });
}

/**
 * 按候选顺序异步下载第一张可用的头像位图。失败时缓存 null，避免
 * 选段切换时反复尝试同一个不存在的头像。
 */
async function loadAvatarImage(
  name: string | null | undefined,
  charId: string | null | undefined
): Promise<HTMLImageElement | null> {
  const key = avatarCacheKey(name, charId);
  if (avatarCache.has(key)) return avatarCache.get(key) ?? null;

  // 组装候选链：优先 charId（稳定），然后中文名（character_table 反查兜底）。
  const tokens: string[] = [];
  if (charId) tokens.push(charId);
  if (name && name !== charId) tokens.push(name);
  const seen = new Set<string>();
  const candidates: string[] = [];
  for (const t of tokens) {
    for (const url of peekAssetCandidates("avatar", t)) {
      if (!seen.has(url)) {
        seen.add(url);
        candidates.push(url);
      }
    }
  }
  if (candidates.length === 0) {
    avatarCache.set(key, null);
    return null;
  }

  for (const url of candidates) {
    const img = await loadImage(url).catch(() => null);
    if (img) {
      avatarCache.set(key, img);
      return img;
    }
  }
  avatarCache.set(key, null);
  return null;
}

/**
 * 把一张图画成圆头像。`x`/`y` 是外接矩形左上角，`size` 是直径。
 * 用 `drawImage` 的 4-arg 形式按 object-fit: cover 剪裁：取图片的中心
 * 正方形喂给圆形裁剪区域，避免 16:9 素材横向拉扁。
 */
function drawCircleAvatar(
  ctx: CanvasRenderingContext2D,
  img: HTMLImageElement,
  x: number,
  y: number,
  size: number,
  borderColor?: string
): void {
  const radius = size / 2;
  ctx.save();
  ctx.beginPath();
  ctx.arc(x + radius, y + radius, radius, 0, Math.PI * 2);
  ctx.closePath();
  ctx.clip();

  const iw = img.naturalWidth || img.width || size;
  const ih = img.naturalHeight || img.height || size;
  // object-fit: cover —— 取短边为 square 基准，放大到填满圆
  const scale = Math.max(size / iw, size / ih);
  const dw = iw * scale;
  const dh = ih * scale;
  const dx = x + (size - dw) / 2;
  const dy = y + (size - dh) / 2;
  ctx.drawImage(img, dx, dy, dw, dh);
  ctx.restore();

  if (borderColor) {
    ctx.save();
    ctx.beginPath();
    ctx.arc(x + radius, y + radius, radius - 0.5, 0, Math.PI * 2);
    ctx.lineWidth = 1;
    ctx.strokeStyle = borderColor;
    ctx.stroke();
    ctx.restore();
  }
}

interface PreparedSegment {
  index: number;
  role: "dialogue" | "narration" | "subtitle" | "sticker" | "system" | "decision" | "header";
  title?: string;
  speaker?: string;
  /** `char_xxx` 形式的 ID，dialogue 段特有，用于拼头像 URL。 */
  characterId?: string | null;
  bodyLines: string[];
  decisions?: string[];
}

function prepareSegment({ index, segment }: ShareSegmentInput): PreparedSegment | null {
  const splitLines = (text: string) => text.replace(/\r\n/g, "\n").split("\n").map((line) => line.trim()).filter(Boolean);

  switch (segment.type) {
    case "dialogue":
      return {
        index,
        role: "dialogue",
        speaker: segment.characterName,
        characterId: segment.characterId ?? null,
        bodyLines: splitLines(segment.text),
      };
    case "narration":
      return { index, role: "narration", bodyLines: splitLines(segment.text) };
    case "subtitle":
      return { index, role: "subtitle", bodyLines: splitLines(segment.text) };
    case "sticker":
      return { index, role: "sticker", bodyLines: splitLines(segment.text) };
    case "system":
      return {
        index,
        role: "system",
        speaker: segment.speaker ?? undefined,
        bodyLines: splitLines(segment.text),
      };
    case "decision":
      return {
        index,
        role: "decision",
        bodyLines: [],
        decisions: segment.options,
      };
    case "header":
      return { index, role: "header", title: segment.title, bodyLines: [] };
    default:
      return null;
  }
}

/**
 * Greedy Chinese/English word-wrap against a 2D canvas context.
 *
 * Performance: naive "try one char, remeasure the whole candidate" is
 * O(n²) because `measureText` scales with string length. For the long
 * CJK monologues our users sometimes select that blows the render time
 * past 300ms. We exploit the fact that `measureText` is near-linear in
 * input length to use a binary search: given the current line prefix,
 * find the longest additional character run that still fits by halving
 * the window, which is O(n log n) overall and trivially fast in practice.
 */
function wrapText(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string[] {
  if (!text) return [];
  // For CJK heavy content we wrap character-by-character which gives the
  // best visual density. For lines that look like alphabetic prose we fall
  // back to whitespace-separated tokens because splitting English at
  // arbitrary characters looks bad.
  const looksLatin = /^[\x20-\x7F]+$/.test(text);
  if (looksLatin) {
    return wrapLatin(ctx, text, maxWidth);
  }
  return wrapCjk(ctx, text, maxWidth);
}

function wrapLatin(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string[] {
  const tokens = text.split(/(\s+)/);
  const lines: string[] = [];
  let current = "";
  for (const token of tokens) {
    const candidate = current + token;
    if (ctx.measureText(candidate).width <= maxWidth) {
      current = candidate;
      continue;
    }
    if (current) {
      lines.push(current);
      current = token.trim().length > 0 ? token : "";
    } else {
      lines.push(token);
      current = "";
    }
  }
  if (current) lines.push(current);
  return lines;
}

function wrapCjk(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string[] {
  const chars = Array.from(text);
  const lines: string[] = [];
  let start = 0;
  while (start < chars.length) {
    // Binary search for the largest `end` such that `chars[start..end]`
    // still fits within `maxWidth`. Measure only log(n) substrings instead
    // of the old append-one-char loop.
    let lo = start + 1;
    let hi = chars.length;
    let best = start + 1; // fallback: at least one char per line
    while (lo <= hi) {
      const mid = (lo + hi) >>> 1;
      const slice = chars.slice(start, mid).join("");
      if (ctx.measureText(slice).width <= maxWidth) {
        best = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    lines.push(chars.slice(start, best).join(""));
    start = best;
  }
  return lines;
}

interface LayoutBlock {
  /** Pixels to advance before drawing this block (acts as the block's top margin). */
  marginTop: number;
  /** Pixels the block occupies after its baseline is placed. */
  height: number;
  draw: (ctx: CanvasRenderingContext2D, x: number, top: number, contentWidth: number) => void;
}

function buildLayout(
  ctx: CanvasRenderingContext2D,
  storyName: string,
  subtitle: string | null,
  prepared: PreparedSegment[],
  contentWidth: number,
  avatarImages: Map<number, HTMLImageElement | null>
): LayoutBlock[] {
  const blocks: LayoutBlock[] = [];
  const AVATAR_SIZE = 56; // diameter of speaker avatar in classic template
  const AVATAR_GAP = 16; // gap between avatar and speaker name text

  // Title block
  ctx.font = `600 38px ${TITLE_FONT_FAMILY}`;
  const titleLines = wrapText(ctx, storyName, contentWidth);
  blocks.push({
    marginTop: 0,
    height: titleLines.length * 48,
    draw: (c, x, top, _w) => {
      c.fillStyle = TEXT_COLOR;
      c.font = `600 38px ${TITLE_FONT_FAMILY}`;
      c.textBaseline = "top";
      titleLines.forEach((line, i) => c.fillText(line, x, top + i * 48));
    },
  });

  // Optional subtitle: chapter / activity name + story code
  const subLabel = (subtitle ?? "").trim();
  if (subLabel) {
    ctx.font = `500 24px ${TITLE_FONT_FAMILY}`;
    const subLines = wrapText(ctx, subLabel, contentWidth);
    blocks.push({
      marginTop: 14,
      height: subLines.length * 32,
      draw: (c, x, top, _w) => {
        c.fillStyle = ACCENT_COLOR;
        c.font = `500 24px ${TITLE_FONT_FAMILY}`;
        c.textBaseline = "top";
        subLines.forEach((line, i) => c.fillText(line, x, top + i * 32));
      },
    });
  }

  // Sub-label (brand)
  ctx.font = `500 20px ${TITLE_FONT_FAMILY}`;
  blocks.push({
    marginTop: 12,
    height: 28,
    draw: (c, x, top, _w) => {
      c.fillStyle = MUTED_COLOR;
      c.font = `500 20px ${TITLE_FONT_FAMILY}`;
      c.textBaseline = "top";
      c.fillText("明日方舟剧情阅读器", x, top);
    },
  });

  blocks.push({
    marginTop: 22,
    height: 2,
    draw: (c, x, top, w) => {
      c.fillStyle = DIVIDER_COLOR;
      c.fillRect(x, top, w, 2);
    },
  });

  // Each prepared segment becomes one or more layout blocks.
  prepared.forEach((item, idx) => {
    const firstSegmentMargin = idx === 0 ? 44 : 40;

    if (item.role === "header") {
      const titleText = item.title ?? "";
      ctx.font = `600 34px ${TITLE_FONT_FAMILY}`;
      const lines = wrapText(ctx, titleText, contentWidth);
      blocks.push({
        marginTop: firstSegmentMargin,
        height: lines.length * 44,
        draw: (c, x, top, w) => {
          c.fillStyle = ACCENT_COLOR;
          c.font = `600 34px ${TITLE_FONT_FAMILY}`;
          c.textBaseline = "top";
          lines.forEach((line, i) => {
            const measure = c.measureText(line).width;
            c.fillText(line, x + (w - measure) / 2, top + i * 44);
          });
        },
      });
      return;
    }

    if (item.role === "decision") {
      const label = "抉择";
      ctx.font = `600 24px ${TITLE_FONT_FAMILY}`;
      blocks.push({
        marginTop: firstSegmentMargin,
        height: 32,
        draw: (c, x, top, _w) => {
          c.fillStyle = ACCENT_COLOR;
          c.font = `600 24px ${TITLE_FONT_FAMILY}`;
          c.textBaseline = "top";
          c.fillText(label, x, top);
        },
      });

      ctx.font = `400 ${CONTENT_FONT_SIZE}px ${CONTENT_FONT_FAMILY}`;
      item.decisions?.forEach((option, optionIdx) => {
        const prefix = `${optionIdx + 1}. `;
        const wrapped = wrapText(ctx, prefix + option, contentWidth);
        blocks.push({
          marginTop: 14,
          height: wrapped.length * CONTENT_LINE_HEIGHT,
          draw: (c, x, top, _w) => {
            c.fillStyle = TEXT_COLOR;
            c.font = `400 ${CONTENT_FONT_SIZE}px ${CONTENT_FONT_FAMILY}`;
            c.textBaseline = "top";
            wrapped.forEach((line, i) => c.fillText(line, x, top + i * CONTENT_LINE_HEIGHT));
          },
        });
      });
      return;
    }

    if (item.role === "dialogue" || item.role === "system") {
      if (item.speaker) {
        // dialogue 段尝试取头像：避免 system 段（没有 characterId）走这条路。
        const avatarImg = item.role === "dialogue" ? avatarImages.get(item.index) ?? null : null;
        const hasAvatar = Boolean(avatarImg);
        ctx.font = `600 24px ${TITLE_FONT_FAMILY}`;
        // 有头像时把这一行撑高到头像直径；没头像就保留原来的 32px。
        const speakerRowHeight = hasAvatar ? AVATAR_SIZE : 32;
        blocks.push({
          marginTop: firstSegmentMargin,
          height: speakerRowHeight,
          draw: (c, x, top, _w) => {
            let textX = x;
            if (hasAvatar && avatarImg) {
              drawCircleAvatar(c, avatarImg, x, top, AVATAR_SIZE, DIVIDER_COLOR);
              textX = x + AVATAR_SIZE + AVATAR_GAP;
            }
            c.fillStyle = ACCENT_COLOR;
            c.font = `600 24px ${TITLE_FONT_FAMILY}`;
            // 头像行垂直居中对齐文字；无头像时保持旧的 top 对齐视觉。
            c.textBaseline = hasAvatar ? "middle" : "top";
            const textY = hasAvatar ? top + AVATAR_SIZE / 2 : top;
            c.fillText(item.speaker ?? "", textX, textY);
          },
        });
      }

      ctx.font = `400 ${CONTENT_FONT_SIZE}px ${CONTENT_FONT_FAMILY}`;
      item.bodyLines.forEach((raw, rawIdx) => {
        const wrapped = wrapText(ctx, raw, contentWidth);
        blocks.push({
          marginTop: rawIdx === 0 && item.speaker ? 12 : rawIdx === 0 ? firstSegmentMargin : 6,
          height: wrapped.length * CONTENT_LINE_HEIGHT,
          draw: (c, x, top, _w) => {
            c.fillStyle = TEXT_COLOR;
            c.font = `400 ${CONTENT_FONT_SIZE}px ${CONTENT_FONT_FAMILY}`;
            c.textBaseline = "top";
            wrapped.forEach((line, i) => c.fillText(line, x, top + i * CONTENT_LINE_HEIGHT));
          },
        });
      });
      return;
    }

    // narration / subtitle / sticker share the same style: italic muted body
    const italic = item.role === "subtitle" || item.role === "sticker";
    ctx.font = `${italic ? "italic " : ""}400 ${CONTENT_FONT_SIZE}px ${CONTENT_FONT_FAMILY}`;
    item.bodyLines.forEach((raw, rawIdx) => {
      const wrapped = wrapText(ctx, raw, contentWidth);
      blocks.push({
        marginTop: rawIdx === 0 ? firstSegmentMargin : 6,
        height: wrapped.length * CONTENT_LINE_HEIGHT,
        draw: (c, x, top, _w) => {
          c.fillStyle = item.role === "narration" ? TEXT_COLOR : MUTED_COLOR;
          c.font = `${italic ? "italic " : ""}400 ${CONTENT_FONT_SIZE}px ${CONTENT_FONT_FAMILY}`;
          c.textBaseline = "top";
          wrapped.forEach((line, i) => c.fillText(line, x, top + i * CONTENT_LINE_HEIGHT));
        },
      });
    });
  });

  return blocks;
}

function renderImage(
  storyName: string,
  subtitle: string | null,
  segments: ShareSegmentInput[],
  avatarImages: Map<number, HTMLImageElement | null>
): { canvas: HTMLCanvasElement; dataUrl: string; blob: Promise<Blob | null> } | null {
  if (!segments.length) return null;

  // Prepared segments are sorted by position in the story so the exported
  // image always reads top-to-bottom even if the user selected in random order.
  const prepared = segments
    .map(prepareSegment)
    .filter((s): s is PreparedSegment => s !== null)
    .sort((a, b) => a.index - b.index);

  const width = CANVAS_WIDTH;
  const contentWidth = width - CANVAS_HORIZONTAL_PADDING * 2;

  // First pass: use a throwaway canvas to measure the layout so we can size
  // the real canvas tight to the content.
  const probe = document.createElement("canvas");
  probe.width = width;
  probe.height = 100;
  const probeCtx = probe.getContext("2d");
  if (!probeCtx) return null;

  const blocks = buildLayout(probeCtx, storyName, subtitle, prepared, contentWidth, avatarImages);
  const totalHeight = blocks.reduce((acc, block) => acc + block.marginTop + block.height, 0);
  const canvasHeight = CANVAS_TOP_PADDING + totalHeight + CANVAS_BOTTOM_PADDING;

  // Most WebViews refuse to allocate a canvas whose largest dimension
  // exceeds 16384 px. Back off dpr first, and if we still blow the ceiling
  // there's simply too much content — bail rather than silently render a
  // broken image.
  let dpr = Math.min(window.devicePixelRatio || 1, 2);
  const MAX_CANVAS_EDGE = 16384;
  while (canvasHeight * dpr > MAX_CANVAS_EDGE && dpr > 1) {
    dpr -= 0.25;
  }
  if (canvasHeight * dpr > MAX_CANVAS_EDGE) {
    throw new Error("所选段落过多，无法生成单张图片，请减少选段后再试");
  }

  // Now draw for real.
  const canvas = document.createElement("canvas");
  canvas.width = width * dpr;
  canvas.height = canvasHeight * dpr;
  canvas.style.width = `${width}px`;
  canvas.style.height = `${canvasHeight}px`;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.scale(dpr, dpr);

  // Background
  ctx.fillStyle = BG_COLOR;
  ctx.fillRect(0, 0, width, canvasHeight);
  // Subtle top accent bar as a visual anchor
  ctx.fillStyle = ACCENT_COLOR;
  ctx.fillRect(CANVAS_HORIZONTAL_PADDING, 56, 72, 6);

  let cursor = CANVAS_TOP_PADDING;
  blocks.forEach((block) => {
    cursor += block.marginTop;
    block.draw(ctx, CANVAS_HORIZONTAL_PADDING, cursor, contentWidth);
    cursor += block.height;
  });

  // Footer attribution
  ctx.fillStyle = MUTED_COLOR;
  ctx.font = `400 18px ${TITLE_FONT_FAMILY}`;
  ctx.textBaseline = "bottom";
  const footer = "来自 · 明日方舟剧情阅读器";
  const measure = ctx.measureText(footer).width;
  ctx.fillText(footer, width - CANVAS_HORIZONTAL_PADDING - measure, canvasHeight - 36);

  const dataUrl = canvas.toDataURL("image/png");
  // Kick off a parallel Blob export so the save / share buttons can use
  // the native byte form directly (smaller than re-parsing the data URL).
  const blob = new Promise<Blob | null>((resolve) => {
    try {
      canvas.toBlob((b) => resolve(b), "image/png");
    } catch {
      resolve(null);
    }
  });
  return { canvas, dataUrl, blob };
}

function sanitizeFileStem(storyName: string): string {
  const cleaned = storyName.replace(/[\\/:*?"<>|\u0000]+/g, "_").trim();
  return cleaned ? cleaned.slice(0, 40) : "arknights-story";
}

/** Quote template canvas dimensions — fixed 4:5 portrait for social feeds. */
const QUOTE_CANVAS_WIDTH = 1080;
const QUOTE_CANVAS_HEIGHT = 1350;
const QUOTE_HORIZONTAL_PADDING = 96;
const QUOTE_VERTICAL_PADDING = 96;
const QUOTE_BODY_FONT_SIZE = 38;
const QUOTE_BODY_LINE_HEIGHT = 58;
const QUOTE_BODY_MAX_LINES = 4;
const QUOTE_MARK_FONT_SIZE = 120;
const QUOTE_ATTR_FONT_SIZE = 24;
const QUOTE_WATERMARK_FONT_SIZE = 12;

/**
 * Render a single-quote "poster" — one dialogue, big serif quotation
 * marks, character + story attribution. Runs on a separate 1080x1350
 * canvas so the classic `renderImage` pipeline stays untouched.
 */
function renderQuoteImage(
  storyName: string,
  subtitle: string | null,
  dialogue: DialogueSegment
): { canvas: HTMLCanvasElement; dataUrl: string; blob: Promise<Blob | null> } | null {
  const width = QUOTE_CANVAS_WIDTH;
  const height = QUOTE_CANVAS_HEIGHT;
  const contentWidth = width - QUOTE_HORIZONTAL_PADDING * 2;

  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const canvas = document.createElement("canvas");
  canvas.width = width * dpr;
  canvas.height = height * dpr;
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.scale(dpr, dpr);

  // Background matches the classic template so the two feel like a set.
  ctx.fillStyle = BG_COLOR;
  ctx.fillRect(0, 0, width, height);

  // Oversized quotation marks — rendered at 50% alpha so they read as a
  // decorative anchor rather than competing with the body copy.
  ctx.save();
  ctx.globalAlpha = 0.5;
  ctx.fillStyle = ACCENT_COLOR;
  ctx.font = `400 ${QUOTE_MARK_FONT_SIZE}px ${CONTENT_FONT_FAMILY}`;
  ctx.textBaseline = "top";
  ctx.fillText('""', QUOTE_HORIZONTAL_PADDING, QUOTE_VERTICAL_PADDING);
  ctx.restore();

  // Collapse dialogue line breaks into a single paragraph, then wrap and
  // clamp to 4 lines with a trailing ellipsis on overflow.
  const flat = dialogue.text
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean)
    .join(" ");
  ctx.font = `400 ${QUOTE_BODY_FONT_SIZE}px ${CONTENT_FONT_FAMILY}`;
  let lines = wrapText(ctx, flat, contentWidth);
  if (lines.length > QUOTE_BODY_MAX_LINES) {
    const ellipsis = "…";
    lines = lines.slice(0, QUOTE_BODY_MAX_LINES);
    let last = lines[QUOTE_BODY_MAX_LINES - 1] + ellipsis;
    // Trim one trailing glyph at a time until the ellipsised line fits.
    // Works for CJK-heavy strings because wrapText already split by glyph.
    while (last.length > 1 && ctx.measureText(last).width > contentWidth) {
      last = last.slice(0, -2) + ellipsis;
    }
    lines[QUOTE_BODY_MAX_LINES - 1] = last;
  }

  // Vertically centre the body block between the quote marks and the
  // attribution row so short and long quotes both sit nicely on the page.
  const bodyTopLimit = QUOTE_VERTICAL_PADDING + QUOTE_MARK_FONT_SIZE + 24;
  const bodyBottomLimit = height - QUOTE_VERTICAL_PADDING - QUOTE_ATTR_FONT_SIZE - 32;
  const bodyBlockHeight = lines.length * QUOTE_BODY_LINE_HEIGHT;
  const bodyTop = Math.max(
    bodyTopLimit,
    bodyTopLimit + (bodyBottomLimit - bodyTopLimit - bodyBlockHeight) / 2
  );
  ctx.fillStyle = TEXT_COLOR;
  ctx.font = `400 ${QUOTE_BODY_FONT_SIZE}px ${CONTENT_FONT_FAMILY}`;
  ctx.textBaseline = "top";
  lines.forEach((line, i) =>
    ctx.fillText(line, QUOTE_HORIZONTAL_PADDING, bodyTop + i * QUOTE_BODY_LINE_HEIGHT)
  );

  // Bottom-right attribution — bold so it reads as the "signature" of the
  // piece without dominating the quote body.
  const storyLabel = [subtitle?.trim(), storyName].filter(Boolean).join(" · ");
  const attribution = `—— ${dialogue.characterName} · ${storyLabel}`;
  ctx.fillStyle = TEXT_COLOR;
  ctx.font = `700 ${QUOTE_ATTR_FONT_SIZE}px ${CONTENT_FONT_FAMILY}`;
  ctx.textBaseline = "bottom";
  const attrWidth = ctx.measureText(attribution).width;
  ctx.fillText(
    attribution,
    width - QUOTE_HORIZONTAL_PADDING - attrWidth,
    height - QUOTE_VERTICAL_PADDING
  );

  // Tiny bottom-left watermark so a reposted image still carries the
  // source without visual weight.
  ctx.fillStyle = MUTED_COLOR;
  ctx.font = `400 ${QUOTE_WATERMARK_FONT_SIZE}px ${TITLE_FONT_FAMILY}`;
  ctx.textBaseline = "bottom";
  ctx.fillText(
    "明日方舟剧情阅读器",
    QUOTE_HORIZONTAL_PADDING,
    height - QUOTE_VERTICAL_PADDING
  );

  const dataUrl = canvas.toDataURL("image/png");
  const blob = new Promise<Blob | null>((resolve) => {
    try {
      canvas.toBlob((b) => resolve(b), "image/png");
    } catch {
      resolve(null);
    }
  });
  return { canvas, dataUrl, blob };
}

/**
 * Decode a `data:image/png;base64,...` URL into raw PNG bytes. Used only
 * as a slow-path fallback when `canvas.toBlob` hasn't resolved yet and
 * the user clicks share immediately. 99% of invocations go through the
 * Blob we already hold in state.
 */
function decodeDataUrlBytes(dataUrl: string): Uint8Array {
  const comma = dataUrl.indexOf(",");
  const b64 = comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl;
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

export function ShareImageDialog({
  open,
  onClose,
  storyName,
  categoryName,
  storyCode,
  segments,
}: ShareImageDialogProps) {
  const { rendered, state } = useSidePanel({ open, onClose });
  const toast = useToast();
  const [dataUrl, setDataUrl] = useState<string | null>(null);
  // The rasterised PNG as a Blob. Kept so `handleSave` / `handleShare` can
  // hand native bytes straight to the OS instead of re-parsing a data URL.
  const [pngBlob, setPngBlob] = useState<Blob | null>(null);
  // Object URL derived from the canvas Blob. Kept separately so the
  // preview <img> doesn't carry a several-hundred-kilobyte `data:` string
  // around in React's prop tree.
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [renderError, setRenderError] = useState<string | null>(null);
  const [rendering, setRendering] = useState(false);
  const [busyAction, setBusyAction] = useState<"share" | "save" | null>(null);
  // Template selection. `classic` is the unchanged long-form composition;
  // `quote` opts into the single-dialogue 1080×1350 poster. Switching
  // templates re-runs the render pipeline via the effect's dep array.
  const [template, setTemplate] = useState<TemplateKind>("classic");
  // Tracks whether we actually rendered the quote template or fell back
  // to classic (e.g. because the selection had no dialogue segment). Used
  // to pick the right filename suffix and to surface the fallback notice.
  const [effectiveTemplate, setEffectiveTemplate] = useState<TemplateKind>("classic");
  // 分享图里是否在 speaker 行前渲染头像。开关状态会写入 localStorage，
  // 这样切换剧情或重开弹窗时保持用户上一次的选择。
  const [showAvatar, setShowAvatar] = useState<boolean>(() => {
    if (typeof window === "undefined") return true;
    try {
      const raw = window.localStorage.getItem(SHOW_AVATAR_STORAGE_KEY);
      // 默认开启：首次使用时直接展示更有"朋友圈风格"的排版。
      return raw === null ? true : raw === "true";
    } catch {
      return true;
    }
  });
  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      window.localStorage.setItem(SHOW_AVATAR_STORAGE_KEY, String(showAvatar));
    } catch {
      // 忽略配额 / 隐私模式等写入失败
    }
  }, [showAvatar]);
  const platform = useMemo<RuntimePlatform>(() => detectRuntimePlatform(), []);

  // Re-render the image whenever the selection (or the visible story) changes
  // while the dialog is open. Use a microtask so the heavy canvas work
  // happens after the slide-in animation starts.
  useEffect(() => {
    if (!open) {
      setDataUrl(null);
      setPngBlob(null);
      setPreviewUrl((prev) => {
        if (prev && prev.startsWith("blob:")) URL.revokeObjectURL(prev);
        return null;
      });
      setRenderError(null);
      return;
    }
    if (!segments.length) {
      setDataUrl(null);
      setPngBlob(null);
      setPreviewUrl((prev) => {
        if (prev && prev.startsWith("blob:")) URL.revokeObjectURL(prev);
        return null;
      });
      setRenderError("未选择任何段落");
      // Safety: if a previous render was in flight when `segments` emptied
      // we'd be stuck in the loading state.
      setRendering(false);
      return;
    }
    let cancelled = false;
    setRendering(true);
    setRenderError(null);

    // Collect a fat sample of glyphs so `document.fonts.load` pulls in every
    // unicode-range subset we'll actually draw. Without this the CJK common
    // subset may not be ready when `toDataURL` fires.
    const sample =
      storyName +
      " " +
      segments
        .map((s) => {
          const seg = s.segment;
          switch (seg.type) {
            case "dialogue":
              return `${seg.characterName} ${seg.text}`;
            case "narration":
            case "subtitle":
            case "sticker":
              return seg.text;
            case "system":
              return `${seg.speaker ?? ""} ${seg.text}`;
            case "decision":
              return seg.options.join(" ");
            case "header":
              return seg.title;
            default:
              return "";
          }
        })
        .join(" ")
        .slice(0, 2000);

    (async () => {
      try {
        await ensureFontsLoaded(sample);
        if (cancelled) return;

        // 批量加载所有 dialogue 段的头像。关闭开关时跳过整段网络请求，
        // 等于退回到"只有角色名文字"的旧版排版。
        const avatarImages = new Map<number, HTMLImageElement | null>();
        if (showAvatar) {
          const dialogueEntries = segments.filter(
            (s): s is ShareSegmentInput & { segment: DialogueSegment } =>
              s.segment.type === "dialogue"
          );
          const resolved = await Promise.all(
            dialogueEntries.map(async (entry) => {
              const img = await loadAvatarImage(
                entry.segment.characterName,
                entry.segment.characterId ?? null
              ).catch(() => null);
              return [entry.index, img] as const;
            })
          );
          if (cancelled) return;
          for (const [idx, img] of resolved) avatarImages.set(idx, img);
        }

        // Compose the visual subtitle used on both templates: "章节/活动名 · 关卡代号"。
        // 任一部分缺失时自动省略对应段，不会出现多余的连接符。
        const subtitle = [categoryName?.trim(), storyCode?.trim()]
          .filter((x): x is string => Boolean(x))
          .join(" · ") || null;

        // Resolve which template to actually render. `template` is the
        // user's choice; `effective` is what we ship — they diverge when
        // the user picks "quote" but the selection has no dialogue.
        let effective: TemplateKind = template;
        let result: ReturnType<typeof renderImage> = null;
        if (template === "quote") {
          const firstDialogue = segments
            .slice()
            .sort((a, b) => a.index - b.index)
            .find((s): s is ShareSegmentInput & { segment: DialogueSegment } =>
              s.segment.type === "dialogue"
            );
          if (!firstDialogue) {
            toast.warn("金句模板需至少选中一条对话，已回落到经典模板");
            effective = "classic";
            result = renderImage(storyName, subtitle, segments, avatarImages);
          } else {
            result = renderQuoteImage(storyName, subtitle, firstDialogue.segment);
          }
        } else {
          result = renderImage(storyName, subtitle, segments, avatarImages);
        }

        if (cancelled) return;
        if (!result) {
          setRenderError("无法生成图片，请稍后重试");
        } else {
          setEffectiveTemplate(effective);
          setDataUrl(result.dataUrl);
          // Kick off Blob export + preview URL in parallel. `toBlob` on a
          // big canvas can easily take 100ms+, so resolve the data URL
          // preview first and upgrade to the Blob URL when it lands.
          result.blob.then((blob) => {
            if (cancelled) return;
            setPngBlob(blob);
            if (!blob) {
              setPreviewUrl(result.dataUrl);
              return;
            }
            const next = URL.createObjectURL(blob);
            setPreviewUrl((prev) => {
              if (prev && prev.startsWith("blob:")) URL.revokeObjectURL(prev);
              return next;
            });
          });
          // Optimistic fallback — show the data URL instantly while the
          // Blob is encoding, so the user doesn't see an empty preview
          // for the ~100ms it takes canvas.toBlob to resolve.
          setPreviewUrl((prev) => {
            if (prev && prev.startsWith("blob:")) URL.revokeObjectURL(prev);
            return result.dataUrl;
          });
        }
      } catch (err) {
        if (cancelled) return;
        console.error("[ShareImageDialog] render failed", err);
        setRenderError(err instanceof Error ? err.message : "生成图片失败");
      } finally {
        if (!cancelled) setRendering(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [open, segments, storyName, categoryName, storyCode, template, showAvatar, toast]);

  // Revoke the preview URL on unmount so we don't leak across story
  // switches when the dialog is kept mounted by a parent KeepAlive.
  useEffect(() => {
    return () => {
      setPreviewUrl((prev) => {
        if (prev && prev.startsWith("blob:")) URL.revokeObjectURL(prev);
        return null;
      });
    };
  }, []);

  const fileName = useMemo(() => {
    const stem = sanitizeFileStem(storyName);
    // Quote exports prefer `{character}-{storyName}-quote.png` so a
    // folder full of quote posters self-describes. When the quote
    // template falls back to classic (no dialogue in selection) we use
    // the classic naming instead.
    if (effectiveTemplate === "quote") {
      const firstDialogue = segments
        .slice()
        .sort((a, b) => a.index - b.index)
        .find((s): s is ShareSegmentInput & { segment: DialogueSegment } =>
          s.segment.type === "dialogue"
        );
      const character = firstDialogue
        ? sanitizeFileStem(firstDialogue.segment.characterName || "character")
        : "character";
      return `${character}-${stem}-quote.png`;
    }
    return `${stem}.png`;
  }, [effectiveTemplate, segments, storyName]);

  const payload = useMemo<ShareImagePayload | null>(() => {
    if (!dataUrl) return null;
    return { dataUrl, fileName, title: storyName };
  }, [dataUrl, fileName, storyName]);

  const handleShare = useCallback(async () => {
    if (!payload) return;
    setBusyAction("share");
    try {
      if (platform === "android") {
        await shareImageViaSystem(payload);
        toast.show("已打开系统分享面板");
      } else if (typeof navigator !== "undefined" && "share" in navigator) {
        // Web Share API path (mostly mobile browsers / PWAs). Use the
        // already-rasterised Blob when we have it — decoding the data
        // URL again just to build a File would pointlessly walk the
        // several-hundred-kilobyte string twice.
        const blob =
          pngBlob ?? new Blob([new Uint8Array(decodeDataUrlBytes(payload.dataUrl))], {
            type: "image/png",
          });
        const file = new File([blob], payload.fileName ?? "story.png", { type: "image/png" });
        // TS lib.dom doesn't always have `canShare` typed.
        const nav = navigator as Navigator & {
          canShare?: (data: { files: File[] }) => boolean;
          share?: (data: { files: File[]; title?: string }) => Promise<void>;
        };
        if (nav.canShare?.({ files: [file] }) && nav.share) {
          await nav.share({ files: [file], title: payload.title });
        } else {
          saveImageToDesktopFile({ ...payload, blob: pngBlob });
          toast.show("已下载图片，请手动分享");
        }
      } else {
        saveImageToDesktopFile({ ...payload, blob: pngBlob });
        toast.show("已下载图片，请手动分享");
      }
    } catch (err) {
      console.error("[ShareImageDialog] share failed", err);
      toast.error(err instanceof Error ? err.message : "分享失败");
    } finally {
      setBusyAction(null);
    }
  }, [payload, platform, pngBlob, toast]);

  const handleSave = useCallback(async () => {
    if (!payload) return;
    setBusyAction("save");
    try {
      if (platform === "android") {
        const response = await saveImageToGallery(payload);
        if (response.needsPermission) {
          toast.warn("需要存储权限才能保存，正在跳转系统设置");
          try {
            await openStoragePermissionSettings();
          } catch (openErr) {
            console.warn("[ShareImageDialog] open settings failed", openErr);
          }
          return;
        }
        if (response.saved) {
          toast.success("已保存到相册 · Pictures/ArknightsStoryReader");
        }
      } else {
        saveImageToDesktopFile({ ...payload, blob: pngBlob });
        toast.success("已下载图片到浏览器");
      }
    } catch (err) {
      console.error("[ShareImageDialog] save failed", err);
      toast.error(err instanceof Error ? err.message : "保存失败");
    } finally {
      setBusyAction(null);
    }
  }, [payload, platform, pngBlob, toast]);

  if (!rendered) return null;

  const showShareAction = platform === "android" || (typeof navigator !== "undefined" && "share" in navigator);

  return (
    <SheetShell state={state} onClose={onClose} ariaLabel="分享为图片">
      <SheetHeader
        title="分享为图片"
        description={`已选 ${segments.length} 段 · ${storyName}`}
        actions={
          <Button
            variant="ghost"
            size="icon-pill"
            onClick={onClose}
            aria-label="关闭"
            title="关闭"
          >
            <X className="h-5 w-5" />
          </Button>
        }
      />

      <CustomScrollArea className="flex-1 min-h-0" viewportClassName="reader-scroll">
        <div className="px-4 pt-3 pb-6 space-y-5">
          {/* Template picker — segmented card grid, feels like a radio picker
            on iOS 26 with two tappable chips instead of a card with radios. */}
          <section className="space-y-2">
            <SheetSectionLabel>模板</SheetSectionLabel>
            <div
              role="radiogroup"
              aria-label="选择分享模板"
              className="grid grid-cols-2 gap-2"
            >
              {(
                [
                  { value: "classic", label: "经典", hint: "长图 · 完整段落" },
                  { value: "quote", label: "对话金句", hint: "竖版 · 单条对话" },
                ] as const
              ).map((opt) => {
                const active = template === opt.value;
                return (
                  <button
                    key={opt.value}
                    type="button"
                    role="radio"
                    aria-checked={active}
                    onClick={() => setTemplate(opt.value)}
                    className={cn(
                      "glass glass-pane text-left px-4 py-3 transition-[background-color,color,box-shadow] duration-200 ease-spring",
                      active
                        ? "glass-thick ring-1 ring-[hsl(var(--color-primary)/0.45)] text-[hsl(var(--color-foreground))]"
                        : "glass-thin text-[hsl(var(--color-muted-foreground))] hover:text-[hsl(var(--color-foreground))]"
                    )}
                  >
                    <div className={cn("text-sm font-semibold", active && "text-[hsl(var(--color-foreground))]") }>
                      {opt.label}
                    </div>
                    <div className="text-xs opacity-80 mt-0.5">{opt.hint}</div>
                  </button>
                );
              })}
            </div>
            {template === "quote" && effectiveTemplate === "classic" && (
              <p className="text-xs text-[hsl(var(--color-muted-foreground))] px-1">
                当前选段没有对话，已回落到经典模板。
              </p>
            )}
            {effectiveTemplate === "classic" && (
              <label className="flex items-center gap-2 px-1 py-1 text-xs text-[hsl(var(--color-muted-foreground))] cursor-pointer select-none">
                <input
                  type="checkbox"
                  className="h-3.5 w-3.5 accent-[hsl(var(--color-primary))]"
                  checked={showAvatar}
                  onChange={(e) => setShowAvatar(e.target.checked)}
                />
                <span>在对话前显示角色头像</span>
              </label>
            )}
          </section>

          <section className="space-y-2">
            <SheetSectionLabel>预览</SheetSectionLabel>
            <SheetGroup padded>
              <div className="rounded-[var(--radius-row)] bg-[hsl(var(--color-foreground)/0.04)] p-3 min-h-[220px] flex items-center justify-center">
                {rendering && (
                  <div className="flex items-center gap-2 text-sm text-[hsl(var(--color-muted-foreground))]">
                    <Loader2 className="h-4 w-4 animate-spin" /> 正在生成图片...
                  </div>
                )}
                {!rendering && renderError && (
                  <div className="text-sm text-[hsl(var(--color-destructive))]">{renderError}</div>
                )}
                {!rendering && !renderError && previewUrl && (
                  <img
                    src={previewUrl}
                    alt="段落截图预览"
                    className="max-w-full h-auto rounded-[var(--radius-row)] shadow-[0_8px_24px_-8px_hsl(0_0%_0%/0.25)]"
                    loading="lazy"
                  />
                )}
              </div>
              <p className="mt-3 text-xs text-[hsl(var(--color-muted-foreground))] leading-relaxed">
                图片会按剧情原文顺序排列，分享或保存时使用同一份 PNG。
              </p>
            </SheetGroup>
          </section>

          <section className="space-y-2">
            <SheetSectionLabel>说明</SheetSectionLabel>
            <SheetGroup padded>
              {platform === "android" ? (
                <div className="space-y-2 text-sm text-[hsl(var(--color-muted-foreground))] leading-relaxed">
                  <p>
                    保存到相册会写入 <span className="font-mono">Pictures/ArknightsStoryReader</span>，首次保存可能需要授权。
                  </p>
                  <p>分享会唤起系统分享面板，无需额外权限。</p>
                </div>
              ) : (
                <p className="text-sm text-[hsl(var(--color-muted-foreground))] leading-relaxed">
                  桌面或浏览器环境下将直接下载图片到本地，再由你选择分享方式。
                </p>
              )}
            </SheetGroup>
          </section>
        </div>
      </CustomScrollArea>

      <SheetFooter>
        {showShareAction && (
          <Button
            type="button"
            size="pill"
            className="flex-1"
            onClick={handleShare}
            disabled={!dataUrl || rendering || busyAction !== null}
          >
            {busyAction === "share" ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <Share2 className="mr-2 h-4 w-4" />
            )}
            分享
          </Button>
        )}
        <Button
          type="button"
          size="pill"
          variant={showShareAction ? "glass" : "default"}
          className="flex-1"
          onClick={handleSave}
          disabled={!dataUrl || rendering || busyAction !== null}
        >
          {busyAction === "save" ? (
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          ) : (
            <Download className="mr-2 h-4 w-4" />
          )}
          {platform === "android" ? "保存到相册" : "下载图片"}
        </Button>
      </SheetFooter>
    </SheetShell>
  );
}
