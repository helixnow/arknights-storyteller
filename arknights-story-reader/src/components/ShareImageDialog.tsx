import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
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
import {
  getAssetHealthVersion,
  hasNpcAvatarOverride,
  isAssetUrlDead,
  markAssetUrlAlive,
} from "@/lib/assetUrls";
import { isBrowserOffline } from "@/components/AssetImage";
import type { DialogueSegment, StorySegment } from "@/types/story";
import { Download, Loader2, RotateCcw, Share2, X } from "lucide-react";
import { cn } from "@/lib/utils";

const SHOW_AVATAR_STORAGE_KEY = "arknights-share-image-show-avatar";
const THEME_AWARE_STORAGE_KEY = "arknights-share-image-theme-aware";

function readBooleanPreference(key: string, fallback: boolean): boolean {
  if (typeof window === "undefined") return fallback;
  try {
    const raw = window.localStorage.getItem(key);
    return raw === null ? fallback : raw === "true";
  } catch {
    return fallback;
  }
}

function writeBooleanPreference(key: string, value: boolean): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(key, String(value));
  } catch {
    // 忽略配额 / 隐私模式等写入失败
  }
}

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

/** 一张分享图用到的全部颜色。两个模板共用同一份，配色才不会互相打架。 */
interface SharePalette {
  bg: string;
  accent: string;
  text: string;
  muted: string;
  divider: string;
}

// Measured colors — paper-white background with ink-black body copy so the
// image stays readable in messaging apps that re-render previews at small
// sizes. 这也是所有兜底路径的落点：取不到阅读器配色、或取到的配色对比度
// 不合格时都退回这里。
const PAPER_PALETTE: SharePalette = {
  bg: "#f6f2ea",
  accent: "#b45309",
  text: "#221c14",
  muted: "#7b6d58",
  divider: "rgba(123, 109, 88, 0.25)",
};

type Rgb = [number, number, number];

function parseRgb(input: string): Rgb | null {
  const match = /^rgba?\(([^)]+)\)$/i.exec(input.trim());
  if (!match) return null;
  // `rgb(1, 2, 3)`、`rgb(1 2 3 / 50%)` 两种序列化形式都要吃得下。
  const parts = match[1]
    .split(/[\s,/]+/)
    .filter(Boolean)
    .map((piece) => Number.parseFloat(piece));
  if (parts.length < 3 || parts.slice(0, 3).some((n) => !Number.isFinite(n))) return null;
  // 完全透明说明这个元素压根没画背景，不能当成有效取色。
  if (parts.length >= 4 && parts[3] === 0) return null;
  return [parts[0], parts[1], parts[2]];
}

function cssRgb([r, g, b]: Rgb): string {
  return `rgb(${Math.round(r)}, ${Math.round(g)}, ${Math.round(b)})`;
}

function cssRgba([r, g, b]: Rgb, alpha: number): string {
  return `rgba(${Math.round(r)}, ${Math.round(g)}, ${Math.round(b)}, ${alpha})`;
}

/** `t = 0` 取 `a`，`t = 1` 取 `b`。 */
function mixRgb(a: Rgb, b: Rgb, t: number): Rgb {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

function relativeLuminance([r, g, b]: Rgb): number {
  const channel = (value: number) => {
    const c = Math.min(255, Math.max(0, value)) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function contrastRatio(a: Rgb, b: Rgb): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/**
 * 从阅读器所在的 `.reader-surface` 上取当前真正生效的配色。
 *
 * 分享图之前永远是暖纸色，夜里读 `dark` 主题的用户点一下分享，导出的却是
 * 一张刺眼的米白长图——它跟屏幕上刚读完的那一页毫无关系。这里改成跟随
 * **阅读器纸张**（`--reader-*`），而不是应用外壳（sheet / 导航栏那层玻璃）：
 * 用户要分享的是正文，不是 app 的 UI。
 *
 * 取色走 `getComputedStyle` 的**已用值**而不是自定义属性的字面量：
 * `--reader-bg` 在 `default` 主题下是 `hsl(var(--color-background))`，
 * 只有读元素真实的 `background-color` / `color` 才能拿到解析后的 rgb。
 * accent 没有对应的 CSS 属性可读，挂一个隐藏探针让浏览器替我们解析。
 */
function resolveSharePalette(anchor: HTMLElement | null): SharePalette {
  if (typeof window === "undefined" || !anchor) return PAPER_PALETTE;
  const surface = anchor.closest<HTMLElement>(".reader-surface");
  if (!surface) return PAPER_PALETTE;

  let probe: HTMLElement | null = null;
  try {
    const surfaceStyle = window.getComputedStyle(surface);
    const bg = parseRgb(surfaceStyle.backgroundColor);
    const text = parseRgb(surfaceStyle.color);
    if (!bg || !text) return PAPER_PALETTE;
    // 正文和背景对比度不够，说明取到的是半透明玻璃层之类的中间态。这种
    // 图在聊天软件的小尺寸预览里根本读不清，宁可退回暖纸。
    if (contrastRatio(bg, text) < 4.5) return PAPER_PALETTE;

    probe = document.createElement("span");
    probe.style.cssText =
      "position:absolute;width:0;height:0;overflow:hidden;visibility:hidden;color:var(--reader-accent)";
    surface.appendChild(probe);
    const probed = parseRgb(window.getComputedStyle(probe).color);
    // accent 跟背景糊在一起（比如主题没定义 accent 时继承了正文色）就退回
    // 正文色，至少不会出现"看不见的标题"。
    const accent = probed && contrastRatio(bg, probed) >= 3 ? probed : text;

    const muted = mixRgb(text, bg, 0.42);
    return {
      bg: cssRgb(bg),
      accent: cssRgb(accent),
      text: cssRgb(text),
      muted: cssRgb(muted),
      divider: cssRgba(muted, 0.35),
    };
  } catch {
    return PAPER_PALETTE;
  } finally {
    probe?.remove();
  }
}

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
  // 引号 / 破折号 / 省略号落在跟正文不同的 unicode-range 子集里，必须显式
  // 带进探针，否则金句模板的大引号会在光栅化时静默 fallback 到系统字体。
  const punctuation = `${QUOTE_MARK_GLYPHS}——…·`;
  const probe = (sampleText && sampleText.length > 0 ? sampleText : "示例文本 Sample") + punctuation;
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

/**
 * Canvas 侧独有的失败 URL。刻意不写回 `@/lib/assetUrls` 的共享缓存：
 * 这里的 `<img>` 带 `crossOrigin="anonymous"`，一次 CORS 失败并不代表
 * 这张图在普通展示路径上也拉不到，回灌会误伤列表页的封面。反过来读
 * 共享缓存是安全的——展示路径确认过的 404 在这里同样是 404。
 */
const canvasFailedUrls = new Set<string>();

/**
 * 缓存上限。一张 128px 头像解码后大约几十 KB，长会话里翻遍全剧情足够把
 * 上千张位图钉在内存里；Map 保持插入顺序，超限时淘汰最早的一条即可。
 */
const AVATAR_CACHE_LIMIT = 200;

function avatarCacheKey(name: string | null | undefined, charId: string | null | undefined): string {
  return `${(name ?? "").trim()}::${(charId ?? "").trim()}`;
}

function rememberAvatar(key: string, img: HTMLImageElement | null): void {
  if (!avatarCache.has(key) && avatarCache.size >= AVATAR_CACHE_LIMIT) {
    const oldest = avatarCache.keys().next().value;
    if (oldest !== undefined) avatarCache.delete(oldest);
  }
  avatarCache.set(key, img);
}

/**
 * 上次清理否定性缓存时看到的健康度版本号。断网 / 源被熔断期间攒下的
 * 「null 头像」和失败 URL 与真 404 无法区分，判决并不可靠——展示路径
 * （AssetImage / StoryThumbnail）已经会在健康事件里撤销这类记录，这里的
 * 私有缓存必须跟着放行：否则离线时开过一次分享弹窗，网络恢复后全应用的
 * 头像都回来了，唯独分享图会一直缺头像，直到重启应用。
 */
let seenAssetHealthVersion = getAssetHealthVersion();

/** 丢掉否定性缓存（失败 URL 与 null 头像）；已成功的位图仍然保留。 */
function purgeNegativeAvatarCaches(): void {
  canvasFailedUrls.clear();
  for (const [key, img] of avatarCache) {
    if (img === null) avatarCache.delete(key);
  }
}

// 网络恢复时也要主动放行一次：此时各 host 多半早已 proven，
// markAssetUrlAlive 不会再发健康事件，单靠版本号对不出断网期间记的账。
// 与 AssetImage 的在线恢复订阅同一纪律：整个模块只挂这一个 listener。
if (typeof window !== "undefined") {
  window.addEventListener("online", purgeNegativeAvatarCaches);
}

/**
 * 单张头像的加载时限。头像源偶尔会「连上了但不回包」（移动网切换、镜像
 * 半死），这种挂起既不触发 onload 也不触发 onerror，`Promise.all` 会把
 * 整次渲染钉死在「正在生成图片」上——加载态下重试按钮根本不渲染，用户
 * 只能关掉抽屉重开。熔断器（isAssetUrlDead）只认「确定失败」，拦不住
 * 挂起的连接，必须在这里自己兜底。
 */
const AVATAR_LOAD_TIMEOUT_MS = 8_000;

/** 用类型区分「超时」与「确定失败」：前者不能写进任何否定性缓存。 */
class ImageLoadTimeoutError extends Error {}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    // 必须是 anonymous —— 否则 webview 会把图片标为 tainted，后续
    // `canvas.toDataURL()` 会直接抛 SecurityError。GitHub Raw CDN 对
    // 此类请求允许跨域（响应带 ACAO `*`）。
    img.crossOrigin = "anonymous";
    img.referrerPolicy = "no-referrer";
    img.decoding = "async";
    const timer = window.setTimeout(() => {
      // 先摘回调再断开 src：置空 src 中止底层请求时可能同步触发
      // onerror，不能让它把「超时」改判成「确定失败」。
      img.onload = null;
      img.onerror = null;
      img.src = "";
      reject(new ImageLoadTimeoutError(`Image load timed out: ${url}`));
    }, AVATAR_LOAD_TIMEOUT_MS);
    img.onload = () => {
      window.clearTimeout(timer);
      resolve(img);
    };
    img.onerror = () => {
      window.clearTimeout(timer);
      reject(new Error(`Failed to load image: ${url}`));
    };
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
  // 健康度版本变过（某个源首次被证明可达 / 熔断窗口到期）说明之前的
  // 否定判决可能已失效，先放行再查缓存。
  const healthVersion = getAssetHealthVersion();
  if (healthVersion !== seenAssetHealthVersion) {
    seenAssetHealthVersion = healthVersion;
    purgeNegativeAvatarCaches();
  }
  const key = avatarCacheKey(name, charId);
  if (avatarCache.has(key)) return avatarCache.get(key) ?? null;

  // NPC 覆盖名（普瑞赛斯 / 希尔达）不在干员表里，随台词传来的 charId 只
  // 可能是解析器「只写显示名就继承上一条 [Character] 立绘」启发式误配的
  // 别人的 id——该 id 的头像必然加载成功，若仍让它排在前面，分享长图里
  // NPC 行就会画上前一位干员的头像。与 CharacterAvatar 展示路径同一判定：
  // 命中覆盖表时显示名才是权威身份，charId 直接跳过。
  const npcName = name && hasNpcAvatarOverride(name) ? name.trim() : null;
  // 组装候选链：优先 charId（稳定），然后中文名（character_table 反查兜底）。
  const tokens: string[] = [];
  if (npcName) {
    tokens.push(npcName);
  } else {
    if (charId) tokens.push(charId);
    if (name && name !== charId) tokens.push(name);
  }
  const seen = new Set<string>();
  const candidates: string[] = [];
  for (const t of tokens) {
    for (const url of peekAssetCandidates("avatar", t)) {
      if (seen.has(url)) continue;
      seen.add(url);
      // 展示路径已经证明拉不到（或所属 host 正在熔断）的 URL 直接跳过，
      // 别让分享弹窗把同一批必失败请求再打一遍。
      if (canvasFailedUrls.has(url) || isAssetUrlDead(url)) continue;
      candidates.push(url);
    }
  }
  if (candidates.length === 0) {
    // seen 为空 = 这个角色本来就解析不出任何头像 URL，null 是稳定事实；
    // 否则只是候选全被失败记录 / 熔断挡住，一张图都没真正试过——这种
    // 判决会随健康度变化失效，缓存它等于把一次断网固化成「永远没头像」。
    if (seen.size === 0) rememberAvatar(key, null);
    return null;
  }

  let sawTimeout = false;
  for (const url of candidates) {
    let timedOut = false;
    const img = await loadImage(url).catch((err: unknown) => {
      timedOut = err instanceof ImageLoadTimeoutError;
      return null;
    });
    if (img) {
      markAssetUrlAlive(url);
      rememberAvatar(key, img);
      return img;
    }
    // 离线时的失败与真 404 无法区分，不能记进任何一本永久账；本次直接
    // 放弃，网络恢复后重试（与 AssetImage 展示路径的离线纪律一致）。
    if (isBrowserOffline()) return null;
    // 超时同理：慢源 ≠ 死源。跳过这一条继续试下一张镜像，但不记失败账。
    if (timedOut) {
      sawTimeout = true;
      continue;
    }
    canvasFailedUrls.add(url);
  }
  // 有候选因超时被跳过时不能盖「无头像」章——那只说明此刻网络慢，缓存
  // null 会让这个角色在整个会话里都缺头像，下次打开弹窗理应重试。
  if (!sawTimeout) rememberAvatar(key, null);
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
      current = "";
    }
    // 换行后行首不保留纯空白 token。
    if (token.trim().length === 0) continue;
    if (ctx.measureText(token).width <= maxWidth) {
      current = token;
      continue;
    }
    // 单个 token 比整行还宽（长 URL / 无空格的英文串）：按字符硬折行。
    // 以前直接把它原样 push 成一行，导出图上这一整行会越过右侧留白、
    // 在画布边缘被硬生生裁掉。末段留在 current 里，后续短词还能接上。
    const pieces = wrapCjk(ctx, token, maxWidth);
    current = pieces.pop() ?? "";
    lines.push(...pieces);
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
  avatarImages: Map<number, HTMLImageElement | null>,
  palette: SharePalette
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
      c.fillStyle = palette.text;
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
        c.fillStyle = palette.accent;
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
      c.fillStyle = palette.muted;
      c.font = `500 20px ${TITLE_FONT_FAMILY}`;
      c.textBaseline = "top";
      c.fillText("明日方舟剧情阅读器", x, top);
    },
  });

  blocks.push({
    marginTop: 22,
    height: 2,
    draw: (c, x, top, w) => {
      c.fillStyle = palette.divider;
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
          c.fillStyle = palette.accent;
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
          c.fillStyle = palette.accent;
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
            c.fillStyle = palette.text;
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
              drawCircleAvatar(c, avatarImg, x, top, AVATAR_SIZE, palette.divider);
              textX = x + AVATAR_SIZE + AVATAR_GAP;
            }
            c.fillStyle = palette.accent;
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
            c.fillStyle = palette.text;
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
          c.fillStyle = item.role === "narration" ? palette.text : palette.muted;
          c.font = `${italic ? "italic " : ""}400 ${CONTENT_FONT_SIZE}px ${CONTENT_FONT_FAMILY}`;
          c.textBaseline = "top";
          wrapped.forEach((line, i) => c.fillText(line, x, top + i * CONTENT_LINE_HEIGHT));
        },
      });
    });
  });

  return blocks;
}

/** 一次成功光栅化的产物。`width`/`height` 是 CSS 像素（未乘 dpr）。 */
interface RenderedImage {
  dataUrl: string;
  width: number;
  height: number;
  blob: Promise<Blob | null>;
}

/**
 * 把画好的 canvas 导出成 data URL + Blob，并挡住两类"静默失败"：
 * 跨域素材污染画布（`toDataURL` 抛 SecurityError）和尺寸过大导致部分
 * WebView 直接返回一个空的 `data:,`。两种情况以前都会让用户拿到一张
 * 打不开的图，而界面上一切正常。
 */
function exportCanvas(canvas: HTMLCanvasElement, width: number, height: number): RenderedImage {
  let dataUrl: string;
  try {
    dataUrl = canvas.toDataURL("image/png");
  } catch {
    throw new Error("图片导出被浏览器安全策略拦截（头像素材跨域），可关闭头像后重试");
  }
  if (!dataUrl.startsWith("data:image/png") || dataUrl.length < 512) {
    throw new Error("图片导出失败（画布内容可能过大），请减少选段后重试");
  }
  // Kick off a parallel Blob export so the save / share buttons can use
  // the native byte form directly (smaller than re-parsing the data URL).
  const blob = new Promise<Blob | null>((resolve) => {
    try {
      canvas.toBlob((b) => resolve(b), "image/png");
    } catch {
      resolve(null);
    }
  });
  return { dataUrl, width, height, blob };
}

function renderImage(
  storyName: string,
  subtitle: string | null,
  segments: ShareSegmentInput[],
  avatarImages: Map<number, HTMLImageElement | null>,
  palette: SharePalette
): RenderedImage | null {
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

  const blocks = buildLayout(
    probeCtx,
    storyName,
    subtitle,
    prepared,
    contentWidth,
    avatarImages,
    palette
  );
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
  ctx.fillStyle = palette.bg;
  ctx.fillRect(0, 0, width, canvasHeight);
  // Subtle top accent bar as a visual anchor
  ctx.fillStyle = palette.accent;
  ctx.fillRect(CANVAS_HORIZONTAL_PADDING, 56, 72, 6);

  let cursor = CANVAS_TOP_PADDING;
  blocks.forEach((block) => {
    cursor += block.marginTop;
    block.draw(ctx, CANVAS_HORIZONTAL_PADDING, cursor, contentWidth);
    cursor += block.height;
  });

  // Footer attribution
  ctx.fillStyle = palette.muted;
  ctx.font = `400 18px ${TITLE_FONT_FAMILY}`;
  ctx.textBaseline = "bottom";
  const footer = "来自 · 明日方舟剧情阅读器";
  const measure = ctx.measureText(footer).width;
  ctx.fillText(footer, width - CANVAS_HORIZONTAL_PADDING - measure, canvasHeight - 36);

  return exportCanvas(canvas, width, canvasHeight);
}

function sanitizeFileStem(storyName: string): string {
  const cleaned = storyName.replace(/[\\/:*?"<>|\u0000]+/g, "_").trim();
  if (!cleaned) return "arknights-story";
  // 按码点截断而不是 `slice(0, 40)`：后者数的是 UTF-16 单元，恰好跨在
  // 边界上的代理对（生僻字/emoji）会被劈成孤立代理项——Android 端
  // invoke 的 JSON 反序列化会直接拒绝，保存/分享整条路径报错。粒度与
  // useImageSharer 里 truncateToBytes 的码点截断保持一致。
  return Array.from(cleaned).slice(0, 40).join("");
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
 * 排版引号（U+201C / U+201D），不是 ASCII 的 `"`。衬线字体里这一对是
 * 真正的弯引号，ASCII 直引号在 120px 下会渲染成两根竖直的小棍子。
 * 同时列进 {@link ensureFontsLoaded} 的探针文本，确保对应的 unicode-range
 * 子集在 `toDataURL()` 之前就位。
 */
const QUOTE_MARK_GLYPHS = "\u201C\u201D";

/**
 * Render a single-quote "poster" — one dialogue, big serif quotation
 * marks, character + story attribution. Runs on a separate 1080x1350
 * canvas so the classic `renderImage` pipeline stays untouched.
 */
function renderQuoteImage(
  storyName: string,
  subtitle: string | null,
  dialogue: DialogueSegment,
  palette: SharePalette
): RenderedImage | null {
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
  ctx.fillStyle = palette.bg;
  ctx.fillRect(0, 0, width, height);

  // Oversized quotation marks — rendered at 50% alpha so they read as a
  // decorative anchor rather than competing with the body copy.
  ctx.save();
  ctx.globalAlpha = 0.5;
  ctx.fillStyle = palette.accent;
  ctx.font = `400 ${QUOTE_MARK_FONT_SIZE}px ${CONTENT_FONT_FAMILY}`;
  ctx.textBaseline = "top";
  ctx.fillText(QUOTE_MARK_GLYPHS, QUOTE_HORIZONTAL_PADDING, QUOTE_VERTICAL_PADDING);
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
    // Trim one trailing glyph at a time until the ellipsised line fits.
    // 必须按码点回退而不是 `slice(0, -2)`：行尾若是扩展区汉字 / emoji 这类
    // 代理对，按 UTF-16 单元切会留下孤立代理项，导出图上就是一个 �。
    // Array.from 的粒度与 wrapCjk 的分行粒度一致。
    const glyphs = Array.from(lines[QUOTE_BODY_MAX_LINES - 1]);
    while (
      glyphs.length > 1 &&
      ctx.measureText(glyphs.join("") + ellipsis).width > contentWidth
    ) {
      glyphs.pop();
    }
    lines[QUOTE_BODY_MAX_LINES - 1] = glyphs.join("") + ellipsis;
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
  ctx.fillStyle = palette.text;
  ctx.font = `400 ${QUOTE_BODY_FONT_SIZE}px ${CONTENT_FONT_FAMILY}`;
  ctx.textBaseline = "top";
  lines.forEach((line, i) =>
    ctx.fillText(line, QUOTE_HORIZONTAL_PADDING, bodyTop + i * QUOTE_BODY_LINE_HEIGHT)
  );

  // Bottom-right attribution — bold so it reads as the "signature" of the
  // piece without dominating the quote body.
  const storyLabel = [subtitle?.trim(), storyName].filter(Boolean).join(" · ");
  const attribution = `—— ${dialogue.characterName} · ${storyLabel}`;
  // 署名和左下角水印同在一条基线上：署名的可用宽度先扣掉水印再留一段
  // 间隙，否则长标题的署名会一路顶到左缘、和水印叠成一团。
  const watermark = "明日方舟剧情阅读器";
  ctx.font = `400 ${QUOTE_WATERMARK_FONT_SIZE}px ${TITLE_FONT_FAMILY}`;
  const watermarkWidth = ctx.measureText(watermark).width;
  const attrMaxWidth = contentWidth - watermarkWidth - 32;
  ctx.font = `700 ${QUOTE_ATTR_FONT_SIZE}px ${CONTENT_FONT_FAMILY}`;
  let attrText = attribution;
  if (ctx.measureText(attrText).width > attrMaxWidth) {
    // 超宽时按码点截断补省略号。以前不做任何截断就右对齐硬画：
    // `x = 宽度 - 边距 - 实测宽度` 在长标题下会算成负数，导出的图上
    // 署名从左缘被裁掉半截。码点粒度与正文 clamp 逻辑保持一致。
    const glyphs = Array.from(attribution);
    while (
      glyphs.length > 1 &&
      ctx.measureText(glyphs.join("") + "…").width > attrMaxWidth
    ) {
      glyphs.pop();
    }
    attrText = glyphs.join("") + "…";
  }
  ctx.fillStyle = palette.text;
  ctx.textBaseline = "bottom";
  const attrWidth = ctx.measureText(attrText).width;
  ctx.fillText(
    attrText,
    width - QUOTE_HORIZONTAL_PADDING - attrWidth,
    height - QUOTE_VERTICAL_PADDING
  );

  // Tiny bottom-left watermark so a reposted image still carries the
  // source without visual weight.
  ctx.fillStyle = palette.muted;
  ctx.font = `400 ${QUOTE_WATERMARK_FONT_SIZE}px ${TITLE_FONT_FAMILY}`;
  ctx.textBaseline = "bottom";
  ctx.fillText(watermark, QUOTE_HORIZONTAL_PADDING, height - QUOTE_VERTICAL_PADDING);

  return exportCanvas(canvas, width, height);
}

/**
 * Decode a `data:image/png;base64,...` URL into raw PNG bytes. Used only
 * as a slow-path fallback when `canvas.toBlob` hasn't resolved yet and
 * the user clicks share immediately. 99% of invocations go through the
 * Blob we already hold in state.
 */
function decodeDataUrlBytes(dataUrl: string): Uint8Array<ArrayBuffer> {
  const comma = dataUrl.indexOf(",");
  const b64 = comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl;
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/**
 * 抽出一条能给用户看的错误文本。
 *
 * Tauri 的 `invoke` 是用**字符串**而不是 `Error` reject 的，所以
 * `err instanceof Error ? err.message : "失败"` 会把原生层辛苦拼出来的
 * 中文原因整条丢掉，只剩一句没有信息量的"失败"。
 */
function errorText(err: unknown): string | null {
  if (typeof err === "string") return err.trim() || null;
  if (err instanceof Error) return err.message.trim() || null;
  if (err && typeof err === "object" && "message" in err) {
    const message = (err as { message?: unknown }).message;
    if (typeof message === "string" && message.trim()) return message.trim();
  }
  return null;
}

/** 用户在系统分享面板里点了取消——这是正常操作，不该弹错误提示。 */
function isShareAbort(err: unknown): boolean {
  return err instanceof Error && err.name === "AbortError";
}

function describeShareError(err: unknown): string {
  if (err instanceof Error && err.name === "NotAllowedError") {
    return "系统拒绝了分享请求：请确认已授予应用相关权限，或改用「下载图片」后手动分享";
  }
  if (err instanceof Error && (err.name === "DataError" || err.name === "TypeError")) {
    return "当前系统不支持直接分享图片，请改用「下载图片」后手动分享";
  }
  return errorText(err) ?? "分享失败，请稍后重试";
}

/** 权限类失败的兜底文案：一定要说清楚"去哪儿开"，而不是只说一句失败。 */
const STORAGE_PERMISSION_HINT =
  "请到 系统设置 → 应用 → 明日方舟剧情阅读器 → 权限 中开启「存储 / 照片」后重试";

function describeSaveError(err: unknown): string {
  const text = errorText(err);
  if (text && /permission|denied|EACCES|权限/i.test(text)) {
    return `系统拒绝了写入相册：${STORAGE_PERMISSION_HINT}`;
  }
  return text ?? "保存失败，请稍后重试";
}

function formatByteSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${Math.round(kb)} KB`;
  return `${(kb / 1024).toFixed(1)} MB`;
}

const TEMPLATE_OPTIONS = [
  { value: "classic", label: "经典", hint: "长图 · 完整段落" },
  { value: "quote", label: "对话金句", hint: "竖版 · 单条对话" },
] as const satisfies ReadonlyArray<{ value: TemplateKind; label: string; hint: string }>;

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
  // 导出规格（CSS 像素 + 字节数），显示在预览下方。`bytes` 要等
  // `canvas.toBlob` 落地才有。
  const [imageMeta, setImageMeta] = useState<{
    width: number;
    height: number;
    bytes: number | null;
  } | null>(null);
  const [renderError, setRenderError] = useState<string | null>(null);
  const [rendering, setRendering] = useState(false);
  const [busyAction, setBusyAction] = useState<"share" | "save" | null>(null);
  // 渲染失败后手动重试的计数器：光靠现有依赖项无法重跑同一份输入。
  const [retryToken, setRetryToken] = useState(0);
  // Template selection. `classic` is the unchanged long-form composition;
  // `quote` opts into the single-dialogue 1080×1350 poster. Switching
  // templates re-runs the render pipeline via the effect's dep array.
  const [template, setTemplate] = useState<TemplateKind>("classic");
  // 分享图里是否在 speaker 行前渲染头像。开关状态会写入 localStorage，
  // 这样切换剧情或重开弹窗时保持用户上一次的选择。
  // 默认开启：首次使用时直接展示更有"朋友圈风格"的排版。
  const [showAvatar, setShowAvatar] = useState<boolean>(() =>
    readBooleanPreference(SHOW_AVATAR_STORAGE_KEY, true)
  );
  useEffect(() => {
    writeBooleanPreference(SHOW_AVATAR_STORAGE_KEY, showAvatar);
  }, [showAvatar]);
  // 导出配色是否跟随阅读器主题。默认开启：用户分享的是刚读完的那一页，
  // 图片就该长得跟屏幕上一样。关掉则永远用经典暖纸配色。
  const [themeAware, setThemeAware] = useState<boolean>(() =>
    readBooleanPreference(THEME_AWARE_STORAGE_KEY, true)
  );
  useEffect(() => {
    writeBooleanPreference(THEME_AWARE_STORAGE_KEY, themeAware);
  }, [themeAware]);
  const platform = useMemo<RuntimePlatform>(() => detectRuntimePlatform(), []);

  /**
   * 预览区容器。既是取色锚点（`closest(".reader-surface")` 需要一个真实
   * 挂载在阅读器子树里的节点），也是 `aria-busy` 的载体。
   */
  const previewBoxRef = useRef<HTMLDivElement | null>(null);

  /*
   * 当前 object URL 的镜像。React 18 起对已卸载组件调用 setState 是空操作，
   * updater 函数根本不会执行——原来靠 `setPreviewUrl(prev => ...)` 在卸载
   * 时释放 URL 的写法，实际上一次都没释放过，每开一次弹窗就漏一张位图。
   */
  const previewUrlRef = useRef<string | null>(null);
  const setPreview = useCallback((next: string | null) => {
    const prev = previewUrlRef.current;
    if (prev === next) return;
    if (prev && prev.startsWith("blob:")) URL.revokeObjectURL(prev);
    previewUrlRef.current = next;
    setPreviewUrl(next);
  }, []);
  useEffect(
    () => () => {
      const url = previewUrlRef.current;
      if (url && url.startsWith("blob:")) URL.revokeObjectURL(url);
      previewUrlRef.current = null;
    },
    []
  );

  /** 丢掉上一张图的所有痕迹，让"能不能分享"和"屏幕上有没有图"保持一致。 */
  const clearRendered = useCallback(() => {
    setDataUrl(null);
    setPngBlob(null);
    setImageMeta(null);
    setPreview(null);
  }, [setPreview]);

  // 金句模板取选段里最靠前的一条对话。没有对话就只能回落到经典模板，
  // 这个判断在文件名、开关可见性、渲染分支三处都要用到，统一算一次。
  const firstDialogue = useMemo(
    () =>
      segments
        .slice()
        .sort((a, b) => a.index - b.index)
        .find(
          (s): s is ShareSegmentInput & { segment: DialogueSegment } =>
            s.segment.type === "dialogue"
        ) ?? null,
    [segments]
  );
  // 实际生效的模板。以前它是一份在渲染完成后才写回的 state，导致选段一变
  // 就有一帧"头像开关/回落提示"跟画面对不上；改成纯派生值后不会再抖。
  const resolvedTemplate: TemplateKind =
    template === "quote" && firstDialogue ? "quote" : "classic";

  // Re-render the image whenever the selection (or the visible story) changes
  // while the dialog is open. Use a microtask so the heavy canvas work
  // happens after the slide-in animation starts.
  useEffect(() => {
    // 关闭时刻意不清空：抽屉还要滑出 220ms，这段时间里把预览抹掉会看到
    // 一块空白。真正的释放交给下面那个跟着 `rendered` 走的 effect。
    if (!open) return;
    // `rendered` 要等 useSidePanel 那一轮 state 落地才为真。抢在挂载前
    // 开跑的话 `previewBoxRef` 还是空的，取色会白白退回默认暖纸。
    if (!rendered) return;
    if (!segments.length) {
      clearRendered();
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
        // 取色必须在 await 之前做：此刻 DOM 一定是挂着的，等到异步回来
        // 组件可能已经在卸载途中，`closest` 会拿到一个脱离文档的节点。
        const palette = themeAware
          ? resolveSharePalette(previewBoxRef.current)
          : PAPER_PALETTE;

        await ensureFontsLoaded(sample);
        if (cancelled) return;

        // 走金句分支时取用的那条对话；null 表示本次渲染经典长图。头像
        // 加载和下面的渲染分支必须共用这同一个判定：头像只被经典模板
        // 消费，renderQuoteImage 的签名里根本没有它们。
        const quoteDialogue = resolvedTemplate === "quote" ? firstDialogue : null;

        // 批量加载所有 dialogue 段的头像。关闭开关时跳过整段网络请求，
        // 等于退回到"只有角色名文字"的旧版排版。金句模板同样整段跳过：
        // 以前只看 showAvatar（默认开、且金句模式下开关根本不渲染），
        // 选中多段对话再切金句时会把每个说话人的头像候选都拉一遍——
        // 头像源半死（连上不回包）时每个候选要等满 8 秒超时，一张不画
        // 任何头像的竖版海报要白转几十秒的加载态才出图。
        const avatarImages = new Map<number, HTMLImageElement | null>();
        if (showAvatar && !quoteDialogue) {
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

        const result = quoteDialogue
          ? renderQuoteImage(storyName, subtitle, quoteDialogue.segment, palette)
          : renderImage(storyName, subtitle, segments, avatarImages, palette);

        if (cancelled) return;
        if (!result) {
          throw new Error("当前环境不支持 Canvas 绘图，无法生成分享图");
        }
        setDataUrl(result.dataUrl);
        // 新图的 Blob 还在编码。不把上一张的清掉，这一小段窗口里点"保存"
        // 就会拿着旧 Blob 配新 dataUrl，落盘的是上一次的图。
        setPngBlob(null);
        setImageMeta({ width: result.width, height: result.height, bytes: null });
        // Optimistic fallback — show the data URL instantly while the
        // Blob is encoding, so the user doesn't see an empty preview
        // for the ~100ms it takes canvas.toBlob to resolve.
        setPreview(result.dataUrl);
        // Kick off Blob export + preview URL in parallel. `toBlob` on a
        // big canvas can easily take 100ms+, so resolve the data URL
        // preview first and upgrade to the Blob URL when it lands.
        void result.blob.then((blob) => {
          if (cancelled || !blob) return;
          setPngBlob(blob);
          setImageMeta((prev) => (prev ? { ...prev, bytes: blob.size } : prev));
          setPreview(URL.createObjectURL(blob));
        });
      } catch (err) {
        if (cancelled) return;
        console.error("[ShareImageDialog] render failed", err);
        // 失败时必须把上一张成功的图一起丢掉：否则错误提示下面的「分享 /
        // 保存」仍然可点，用户会把一张跟当前选段对不上的旧图发出去。
        clearRendered();
        setRenderError(errorText(err) ?? "生成图片失败，请重试");
      } finally {
        if (!cancelled) setRendering(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [
    open,
    rendered,
    segments,
    storyName,
    categoryName,
    storyCode,
    resolvedTemplate,
    firstDialogue,
    showAvatar,
    themeAware,
    retryToken,
    clearRendered,
    setPreview,
  ]);

  // 抽屉整体卸载（退场动画放完）后再释放位图与错误态，下次打开是干净的。
  useEffect(() => {
    if (rendered) return;
    clearRendered();
    setRenderError(null);
    setRendering(false);
  }, [rendered, clearRendered]);

  const fileName = useMemo(() => {
    const stem = sanitizeFileStem(storyName);
    // Quote exports prefer `{character}-{storyName}-quote.png` so a
    // folder full of quote posters self-describes. When the quote
    // template falls back to classic (no dialogue in selection) we use
    // the classic naming instead.
    if (resolvedTemplate === "quote" && firstDialogue) {
      const character = sanitizeFileStem(
        firstDialogue.segment.characterName || "character"
      );
      return `${character}-${stem}-quote.png`;
    }
    return `${stem}.png`;
  }, [resolvedTemplate, firstDialogue, storyName]);

  const payload = useMemo<ShareImagePayload | null>(() => {
    if (!dataUrl) return null;
    return { dataUrl, fileName, title: storyName };
  }, [dataUrl, fileName, storyName]);

  /*
   * 按钮的 `disabled` 要等一次渲染才生效，而两次极快的点击（触摸屏上的
   * 双击、或者回车与鼠标同时触发）会落在同一帧里——那就会真的弹出两次
   * 系统分享面板、往相册里塞两张一模一样的图。用 ref 做真正的互斥闸。
   */
  const actionLockRef = useRef(false);
  const runExclusive = useCallback(
    async (action: "share" | "save", task: () => Promise<void>) => {
      if (actionLockRef.current) return;
      actionLockRef.current = true;
      setBusyAction(action);
      try {
        await task();
      } finally {
        actionLockRef.current = false;
        setBusyAction(null);
      }
    },
    []
  );

  const handleShare = useCallback(async () => {
    if (!payload) return;
    await runExclusive("share", async () => {
      try {
        if (platform === "android") {
          await shareImageViaSystem(payload);
          toast.show("已打开系统分享面板");
          return;
        }
        if (typeof navigator !== "undefined" && "share" in navigator) {
          // Web Share API path (mostly mobile browsers / PWAs). Use the
          // already-rasterised Blob when we have it — decoding the data
          // URL again just to build a File would pointlessly walk the
          // several-hundred-kilobyte string twice.
          const blob =
            pngBlob ?? new Blob([decodeDataUrlBytes(payload.dataUrl)], { type: "image/png" });
          const file = new File([blob], payload.fileName ?? "story.png", {
            type: "image/png",
          });
          // TS lib.dom doesn't always have `canShare` typed.
          const nav = navigator as Navigator & {
            canShare?: (data: { files: File[] }) => boolean;
            share?: (data: { files: File[]; title?: string }) => Promise<void>;
          };
          if (nav.canShare?.({ files: [file] }) && nav.share) {
            await nav.share({ files: [file], title: payload.title });
            return;
          }
        }
        saveImageToDesktopFile({ ...payload, blob: pngBlob });
        toast.show("已下载图片，请手动分享");
      } catch (err) {
        // 用户自己在分享面板上点了取消，不是错误，不该弹红条。
        if (isShareAbort(err)) return;
        console.error("[ShareImageDialog] share failed", err);
        toast.error(describeShareError(err));
      }
    });
  }, [payload, platform, pngBlob, runExclusive, toast]);

  const handleSave = useCallback(async () => {
    if (!payload) return;
    await runExclusive("save", async () => {
      try {
        if (platform !== "android") {
          saveImageToDesktopFile({ ...payload, blob: pngBlob });
          toast.success("已下载图片到浏览器");
          return;
        }
        const response = await saveImageToGallery(payload);
        if (response.needsPermission) {
          let jumped = true;
          try {
            await openStoragePermissionSettings();
          } catch (openErr) {
            jumped = false;
            console.warn("[ShareImageDialog] open settings failed", openErr);
          }
          // 权限被拒时最忌讳只说一句"失败"。无论有没有跳转成功，都要留下
          // 一条照着做就能解决的路径——跳过去了就说在哪一屏点什么，没跳成
          // 就把完整的设置路径写出来。
          toast.warn(
            jumped
              ? "需要存储权限才能保存到相册：请在刚打开的系统设置里开启「存储 / 照片」权限，再回到应用重试"
              : `需要存储权限才能保存到相册：${STORAGE_PERMISSION_HINT}`,
            8000
          );
          return;
        }
        if (response.saved) {
          toast.success("已保存到相册 · Pictures/ArknightsStoryReader");
          return;
        }
        // saved=false 又不缺权限：多半是 MediaStore 插入失败。给一条还能
        // 走通的退路，别让用户对着一个没有任何反馈的按钮反复点。
        toast.error("保存到相册失败，可改用「分享」把图片发给自己，或稍后重试");
      } catch (err) {
        console.error("[ShareImageDialog] save failed", err);
        toast.error(describeSaveError(err));
      }
    });
  }, [payload, platform, pngBlob, runExclusive, toast]);

  const handleRetry = useCallback(() => {
    setRenderError(null);
    setRetryToken((token) => token + 1);
  }, []);

  /**
   * 模板选择。金句模板缺对话时的提示放在这里而不是渲染 effect 里——
   * 后者每次选段变化都会重跑，同一句提示会被反复弹出来。
   */
  const selectTemplate = useCallback(
    (next: TemplateKind) => {
      setTemplate(next);
      if (next === "quote" && !firstDialogue) {
        toast.warn("金句模板需至少选中一条对话，已回落到经典模板");
      }
    },
    [firstDialogue, toast]
  );

  /** radiogroup 的方向键导航：只有选中项可 Tab 进入，左右/上下切换选项。 */
  const handleTemplateKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      const { key } = event;
      if (
        key !== "ArrowRight" &&
        key !== "ArrowDown" &&
        key !== "ArrowLeft" &&
        key !== "ArrowUp" &&
        key !== "Home" &&
        key !== "End"
      ) {
        return;
      }
      event.preventDefault();
      const count = TEMPLATE_OPTIONS.length;
      const current = TEMPLATE_OPTIONS.findIndex((opt) => opt.value === template);
      const nextIndex =
        key === "Home"
          ? 0
          : key === "End"
            ? count - 1
            : key === "ArrowRight" || key === "ArrowDown"
              ? (current + 1) % count
              : (current - 1 + count) % count;
      selectTemplate(TEMPLATE_OPTIONS[nextIndex].value);
      // 焦点跟着选中项走，读屏才会把新值念出来。
      event.currentTarget
        .querySelectorAll<HTMLButtonElement>('[role="radio"]')
        [nextIndex]?.focus();
    },
    [selectTemplate, template]
  );

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
              onKeyDown={handleTemplateKeyDown}
            >
              {TEMPLATE_OPTIONS.map((opt) => {
                const active = template === opt.value;
                return (
                  <button
                    key={opt.value}
                    type="button"
                    role="radio"
                    aria-checked={active}
                    // radiogroup 里只有当前选中项参与 Tab 序列，方向键负责
                    // 在选项之间移动——这是 ARIA 对 radio 的标准交互。
                    tabIndex={active ? 0 : -1}
                    onClick={() => selectTemplate(opt.value)}
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
            {template === "quote" && resolvedTemplate === "classic" && (
              <p className="text-xs text-[hsl(var(--color-muted-foreground))] px-1">
                当前选段没有对话，已回落到经典模板。
              </p>
            )}
            {resolvedTemplate === "classic" && (
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
            <label className="flex items-center gap-2 px-1 py-1 text-xs text-[hsl(var(--color-muted-foreground))] cursor-pointer select-none">
              <input
                type="checkbox"
                className="h-3.5 w-3.5 accent-[hsl(var(--color-primary))]"
                checked={themeAware}
                onChange={(e) => setThemeAware(e.target.checked)}
              />
              <span>配色跟随当前阅读主题</span>
            </label>
          </section>

          <section className="space-y-2">
            <SheetSectionLabel>预览</SheetSectionLabel>
            <SheetGroup padded>
              <div
                ref={previewBoxRef}
                aria-busy={rendering}
                className="rounded-[var(--radius-row)] bg-[hsl(var(--color-foreground)/0.04)] p-3 min-h-[220px] flex items-center justify-center"
              >
                {rendering && (
                  <div
                    role="status"
                    className="flex items-center gap-2 text-sm text-[hsl(var(--color-muted-foreground))]"
                  >
                    <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> 正在生成图片...
                  </div>
                )}
                {!rendering && renderError && (
                  <div role="alert" className="flex flex-col items-center gap-3 text-center">
                    <p className="text-sm text-[hsl(var(--color-destructive))]">{renderError}</p>
                    {/* 失败不是终点：多数失败（字体没加载完、头像超时）
                        再跑一次就好，别逼用户关掉重开抽屉。 */}
                    {segments.length > 0 && (
                      <Button type="button" size="pill" variant="glass" onClick={handleRetry}>
                        <RotateCcw className="mr-2 h-4 w-4" aria-hidden="true" />
                        重新生成
                      </Button>
                    )}
                  </div>
                )}
                {!rendering && !renderError && previewUrl && (
                  <img
                    src={previewUrl}
                    alt={`${storyName} 的分享图预览（${
                      resolvedTemplate === "quote" ? "对话金句模板" : "经典模板"
                    }）`}
                    className="max-w-full h-auto rounded-[var(--radius-row)] shadow-[0_8px_24px_-8px_hsl(0_0%_0%/0.25)]"
                    decoding="async"
                  />
                )}
              </div>
              <p className="mt-3 text-xs text-[hsl(var(--color-muted-foreground))] leading-relaxed">
                图片会按剧情原文顺序排列，分享或保存时使用同一份 PNG。
                {imageMeta
                  ? ` 当前 ${imageMeta.width}×${imageMeta.height}${
                      imageMeta.bytes ? ` · 约 ${formatByteSize(imageMeta.bytes)}` : ""
                    }。`
                  : ""}
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
            aria-busy={busyAction === "share"}
          >
            {busyAction === "share" ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />
            ) : (
              <Share2 className="mr-2 h-4 w-4" aria-hidden="true" />
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
          aria-busy={busyAction === "save"}
        >
          {busyAction === "save" ? (
            <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />
          ) : (
            <Download className="mr-2 h-4 w-4" aria-hidden="true" />
          )}
          {platform === "android" ? "保存到相册" : "下载图片"}
        </Button>
      </SheetFooter>
    </SheetShell>
  );
}
