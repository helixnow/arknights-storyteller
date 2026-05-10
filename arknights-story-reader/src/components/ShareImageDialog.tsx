import { useCallback, useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { CustomScrollArea } from "@/components/ui/custom-scroll-area";
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
import type { DialogueSegment, StorySegment } from "@/types/story";
import { Download, Loader2, Share2, X } from "lucide-react";

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

interface PreparedSegment {
  index: number;
  role: "dialogue" | "narration" | "subtitle" | "sticker" | "system" | "decision" | "header";
  title?: string;
  speaker?: string;
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
  contentWidth: number
): LayoutBlock[] {
  const blocks: LayoutBlock[] = [];

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
        ctx.font = `600 24px ${TITLE_FONT_FAMILY}`;
        blocks.push({
          marginTop: firstSegmentMargin,
          height: 32,
          draw: (c, x, top, _w) => {
            c.fillStyle = ACCENT_COLOR;
            c.font = `600 24px ${TITLE_FONT_FAMILY}`;
            c.textBaseline = "top";
            c.fillText(item.speaker ?? "", x, top);
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
  segments: ShareSegmentInput[]
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

  const blocks = buildLayout(probeCtx, storyName, subtitle, prepared, contentWidth);
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
            result = renderImage(storyName, subtitle, segments);
          } else {
            result = renderQuoteImage(storyName, subtitle, firstDialogue.segment);
          }
        } else {
          result = renderImage(storyName, subtitle, segments);
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
  }, [open, segments, storyName, categoryName, storyCode, template, toast]);

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
    <div
      className="fixed inset-0 z-50 flex"
      role="dialog"
      aria-modal="true"
      aria-label="分享为图片"
    >
      <div
        data-state={state}
        className="absolute inset-0 bg-black/50 transition-opacity duration-200 data-[state=closed]:opacity-0 data-[state=open]:opacity-100"
        onClick={onClose}
      />
      <div
        data-state={state}
        className="relative ml-auto h-full w-full max-w-md transform transition-transform duration-200 ease-out data-[state=closed]:translate-x-full data-[state=open]:translate-x-0"
      >
        <div className="h-full flex flex-col bg-[hsl(var(--color-background))] shadow-2xl border-l border-[hsl(var(--color-border))]">
          <header className="flex-shrink-0 flex items-center justify-between gap-3 px-4 py-3 border-b border-[hsl(var(--color-border))] bg-[hsl(var(--color-background))]">
            <div className="min-w-0">
              <h2 className="text-base font-semibold truncate">分享为图片</h2>
              <p className="text-xs text-[hsl(var(--color-muted-foreground))] truncate">
                已选 {segments.length} 段 · {storyName}
              </p>
            </div>
            <Button variant="ghost" size="icon" onClick={onClose} aria-label="关闭" title="关闭">
              <X className="h-5 w-5" />
            </Button>
          </header>

          <CustomScrollArea className="flex-1 min-h-0" viewportClassName="reader-scroll">
            <div className="p-4 space-y-4">
              <Card>
                <CardHeader>
                  <CardTitle className="text-base">模板</CardTitle>
                </CardHeader>
                <CardContent>
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
                          className={
                            "rounded-md border px-3 py-2 text-left transition-colors " +
                            (active
                              ? "border-[hsl(var(--color-primary))] bg-[hsl(var(--color-primary)/0.08)]"
                              : "border-[hsl(var(--color-border))] hover:bg-[hsl(var(--color-accent)/0.3)]")
                          }
                        >
                          <div className="text-sm font-medium">{opt.label}</div>
                          <div className="text-xs text-[hsl(var(--color-muted-foreground))]">
                            {opt.hint}
                          </div>
                        </button>
                      );
                    })}
                  </div>
                  {template === "quote" && effectiveTemplate === "classic" && (
                    <p className="mt-3 text-xs text-[hsl(var(--color-warning-foreground,var(--color-muted-foreground)))]">
                      当前选段没有对话，已回落到经典模板。
                    </p>
                  )}
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle className="text-base">预览</CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="rounded-lg border border-[hsl(var(--color-border))] bg-[hsl(var(--color-muted)/0.3)] p-3 min-h-[220px] flex items-center justify-center">
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
                        className="max-w-full h-auto rounded shadow-sm"
                        loading="lazy"
                      />
                    )}
                  </div>
                  <p className="mt-3 text-xs text-[hsl(var(--color-muted-foreground))] leading-relaxed">
                    图片会按剧情原文顺序排列，分享或保存时使用同一份 PNG。
                  </p>
                </CardContent>
              </Card>

              {platform === "android" ? (
                <Card>
                  <CardHeader>
                    <CardTitle className="text-base">操作</CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-3 text-sm text-[hsl(var(--color-muted-foreground))]">
                    <p>保存到相册会写入 <span className="font-mono">Pictures/ArknightsStoryReader</span>，首次保存可能需要授权。</p>
                    <p>分享会唤起系统分享面板，无需额外权限。</p>
                  </CardContent>
                </Card>
              ) : (
                <Card>
                  <CardHeader>
                    <CardTitle className="text-base">说明</CardTitle>
                  </CardHeader>
                  <CardContent className="text-sm text-[hsl(var(--color-muted-foreground))] leading-relaxed">
                    桌面或浏览器环境下将直接下载图片到本地，再由你选择分享方式。
                  </CardContent>
                </Card>
              )}
            </div>
          </CustomScrollArea>

          <footer
            className="flex-shrink-0 border-t border-[hsl(var(--color-border))] bg-[hsl(var(--color-background))] px-4 py-3 flex items-center gap-2"
            style={{ paddingBottom: "calc(env(safe-area-inset-bottom, 0px) + 0.75rem)" }}
          >
            {showShareAction && (
              <Button
                type="button"
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
              variant={showShareAction ? "outline" : "default"}
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
          </footer>
        </div>
      </div>
    </div>
  );
}
