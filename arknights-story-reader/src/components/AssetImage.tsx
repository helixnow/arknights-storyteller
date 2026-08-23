import { useEffect, useRef, useState, type CSSProperties } from "react";
import { cn } from "@/lib/utils";
import { useAsset, useAssetHealthNonce } from "@/hooks/useAsset";
import {
  gradientFallbackBackground,
  hasRecoverableCandidate,
  markAssetUrlAlive,
  markAssetUrlDead,
  pickLiveCandidate,
} from "@/lib/assetUrls";
import type { AssetKind } from "@/types/story";

interface AssetImageProps {
  kind: AssetKind;
  token: string | null | undefined;
  alt?: string;
  className?: string;
  style?: CSSProperties;
  /**
   * 在素材主题下"降饱和 + 主题色混色"的变体。`auto` 表示由父级决定；
   * `none` 表示彩色；`tint` 表示强烈上色；`soft` 为默认（柔和）。
   */
  tint?: "auto" | "none" | "soft" | "tint";
  /** 加载失败时显示的兜底节点（通常是首字母 monogram 或渐变色块）。 */
  fallback?: React.ReactNode;
  /** 懒加载开关；默认 true。 */
  lazy?: boolean;
  /** 加载完成回调，可用于父级切换 skeleton。 */
  onReady?: (url: string) => void;
  /** 所有 URL 都加载失败时调用，父级可用来隐藏自己。 */
  onExhausted?: () => void;
  /**
   * 图像缩放策略：
   *  - `cover`（默认）：拉满容器并裁剪，用于封面/头像等固定框。
   *  - `contain`：保持宽高比铺满容器，不裁剪（容器大小固定）。
   *  - `natural`：按图片自身尺寸居中显示，容器自适应高度，适用于
   *    内文插画——这样竖图、方图都能完整呈现，不会被 16:9 切掉。
   */
  fit?: "cover" | "contain" | "natural";
}

/**
 * 已知素材的原始像素尺寸。`fit="natural"` 的插画没有固定容器，重新挂载
 * （虚拟滚动、切章回来）时如果不给 `<img>` 内在尺寸，浏览器会先按 0 高
 * 布局、图片到位再撑开，正文因此上下跳一次。本会话内加载过一次之后就把
 * 尺寸记下来，后续挂载直接用它预留空间。
 */
const naturalSizes = new Map<string, { width: number; height: number }>();
const NATURAL_SIZE_LIMIT = 2000;

function rememberNaturalSize(url: string, width: number, height: number) {
  if (!width || !height) return;
  if (naturalSizes.has(url)) return;
  if (naturalSizes.size >= NATURAL_SIZE_LIMIT) {
    const oldest = naturalSizes.keys().next();
    if (!oldest.done) naturalSizes.delete(oldest.value);
  }
  naturalSizes.set(url, { width, height });
}

/**
 * 统一的素材 `<img>` 封装。性能注意点：
 *
 * 1. **不用 IntersectionObserver**。上一版给每个实例挂一个 observer，
 *    CharactersPanel 400+ 头像直接把滚动主线程压死。改用浏览器原生
 *    `loading="lazy"`，0 JS 成本。
 * 2. **不订阅全局 index**。index 通过 `useAsset` 的共享订阅表统一分发，
 *    只有真的换了快照（数据同步完成）才会重渲染。
 * 3. **不每帧 filter**。失败记录集中在 `@/lib/assetUrls`（与
 *    `<StoryThumbnail>` 共用一份），只在 onLoad / onError 时读写一次，
 *    候选链直接来自 `useAsset` 的 memo 化结果。
 * 4. **解码异步化**。`onLoad` 之后先 `img.decode()` 再淡入，大图的解码
 *    不会卡住滚动，也不会出现"解了一半"的图。
 */
export function AssetImage({
  kind,
  token,
  alt,
  className,
  style,
  tint = "soft",
  fallback,
  lazy = true,
  onReady,
  onExhausted,
  fit = "cover",
}: AssetImageProps) {
  const { candidates, loading } = useAsset(kind, token ?? null);
  const [currentIdx, setCurrentIdx] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const exhaustedFiredRef = useRef(false);

  // 候选集合变了就重置。key 用字符串拼接而非数组引用比较，避免 memo
  // 失效时白白 setState。
  const candidatesKey = candidates.join("|");

  useEffect(() => {
    setCurrentIdx(0);
    setLoaded(false);
    exhaustedFiredRef.current = false;
  }, [candidatesKey]);

  // `currentIdx` 只是游标下界；真正跳过哪些候选由共享的失败缓存 +
  // host 熔断决定，这两者都在 onLoad / onError 里 mutate，不触发 re-render。
  const currentUrl = pickLiveCandidate(candidates, currentIdx);

  // 全部候选都被跳过时区分两种情况：URL 自己 404（真没了）和 host 正在
  // 熔断（等窗口结束还能再试）。后者订阅一次健康度事件等待重试，并且
  // 先不上报 exhausted —— 否则一次断网会让阅读器把插画段永久删掉。
  const recoverable = currentUrl === null && hasRecoverableCandidate(candidates, currentIdx);
  useAssetHealthNonce(recoverable);

  const exhausted = !loading && !recoverable && candidates.length > 0 && currentUrl === null;
  const noneAvailable = !loading && candidates.length === 0;

  useEffect(() => {
    if ((exhausted || noneAvailable) && !exhaustedFiredRef.current) {
      exhaustedFiredRef.current = true;
      onExhausted?.();
    }
  }, [exhausted, noneAvailable, onExhausted]);

  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);
  const currentUrlRef = useRef<string | null>(null);
  currentUrlRef.current = currentUrl?.url ?? null;

  const tintClass =
    tint === "none"
      ? ""
      : tint === "tint"
      ? "asset-tinted asset-tinted--strong"
      : tint === "soft"
      ? "asset-tinted"
      : "";

  // 只有 `natural` 需要内在尺寸：其余 fit 的盒子由容器决定，给了也会被
  // `h-full w-full` 覆盖掉。
  const reservedSize =
    fit === "natural" && currentUrl ? naturalSizes.get(currentUrl.url) ?? null : null;

  return (
    <div
      className={cn(
        "asset-image-slot relative",
        fit === "natural" ? "flex items-center justify-center" : "overflow-hidden",
        className
      )}
      style={style}
      data-asset-loaded={loaded ? "true" : "false"}
    >
      {currentUrl ? (
        <img
          key={currentUrl.url}
          src={currentUrl.url}
          alt={alt ?? ""}
          loading={lazy ? "lazy" : "eager"}
          decoding="async"
          fetchPriority={lazy ? "low" : "high"}
          width={reservedSize?.width}
          height={reservedSize?.height}
          referrerPolicy="no-referrer"
          draggable={false}
          onLoad={(event) => {
            const img = event.currentTarget;
            const url = currentUrl.url;
            markAssetUrlAlive(url);
            rememberNaturalSize(url, img.naturalWidth, img.naturalHeight);
            const show = () => {
              if (!mountedRef.current || currentUrlRef.current !== url) return;
              setLoaded(true);
              onReady?.(url);
            };
            // 解码失败（极少见的损坏图）也走同一条路径：让 onError 之外的
            // 兜底逻辑保持简单，图画不出来时顶多是淡入一张空图。
            if (typeof img.decode === "function") {
              img.decode().then(show, show);
            } else {
              show();
            }
          }}
          onError={() => {
            markAssetUrlDead(currentUrl.url);
            setCurrentIdx(Math.min(currentUrl.index + 1, candidates.length));
          }}
          className={cn(
            "asset-image motion-safe:transition-opacity motion-safe:duration-300",
            fit === "natural"
              ? "max-w-full h-auto w-auto mx-auto block"
              : fit === "contain"
              ? "h-full w-full object-contain"
              : "h-full w-full object-cover",
            tintClass,
            loaded ? "opacity-100" : "opacity-0"
          )}
        />
      ) : null}
      {(!loaded || exhausted || noneAvailable) && (
        <div
          className={cn(
            "asset-image-fallback absolute inset-0 flex items-center justify-center motion-safe:transition-opacity motion-safe:duration-300",
            loaded && !exhausted && !noneAvailable ? "opacity-0" : "opacity-100"
          )}
          aria-hidden="true"
        >
          {fallback ?? <GradientFallback seed={token ?? ""} />}
        </div>
      )}
    </div>
  );
}

/**
 * 默认 fallback：纯渐变色块。不显示 monogram 文字——`ac`/`bg`/`act17side`
 * 这种缩写比空着更丑。调用方（例如 CharacterAvatar）需要文字占位时自己传
 * `fallback` prop。
 */
function GradientFallback({ seed }: { seed: string }) {
  const style: CSSProperties = { background: gradientFallbackBackground(seed) };
  return <div style={style} className="h-full w-full" />;
}
