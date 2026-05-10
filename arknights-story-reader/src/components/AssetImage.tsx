import { useEffect, useRef, useState, type CSSProperties } from "react";
import { cn } from "@/lib/utils";
import { useAsset } from "@/hooks/useAsset";
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
}

/**
 * 统一的素材 `<img>` 封装：
 * 1. 从后端 `resolve_asset_urls` 拿一条候选链
 * 2. 渲染时按顺序尝试，首个加载成功的即作为最终 src
 * 3. 全部失败则显示 fallback（默认透明占位）
 * 4. 交叉 observer 懒加载；首屏外不占用带宽
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
}: AssetImageProps) {
  const { candidates, loading } = useAsset(kind, token ?? null);
  const [currentIdx, setCurrentIdx] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const [visible, setVisible] = useState(!lazy);
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    setCurrentIdx(0);
    setLoaded(false);
  }, [candidates.join("|")]);

  useEffect(() => {
    if (!lazy || visible) return;
    const el = containerRef.current;
    if (!el) return;
    const io = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            setVisible(true);
            io.disconnect();
            break;
          }
        }
      },
      { rootMargin: "200px 0px", threshold: 0 }
    );
    io.observe(el);
    return () => io.disconnect();
  }, [lazy, visible]);

  const currentUrl = candidates[currentIdx];
  const exhausted = !loading && candidates.length > 0 && currentIdx >= candidates.length;
  const noneAvailable = !loading && candidates.length === 0;

  const tintClass =
    tint === "none"
      ? ""
      : tint === "tint"
      ? "asset-tinted asset-tinted--strong"
      : tint === "soft"
      ? "asset-tinted"
      : "";

  return (
    <div
      ref={containerRef}
      className={cn("asset-image-slot relative overflow-hidden", className)}
      style={style}
      data-asset-loaded={loaded ? "true" : "false"}
    >
      {visible && currentUrl && !exhausted ? (
        <img
          key={currentUrl}
          src={currentUrl}
          alt={alt ?? ""}
          loading={lazy ? "lazy" : "eager"}
          decoding="async"
          referrerPolicy="no-referrer"
          draggable={false}
          onLoad={() => {
            setLoaded(true);
            onReady?.(currentUrl);
          }}
          onError={() => {
            if (currentIdx + 1 < candidates.length) {
              setCurrentIdx((i) => i + 1);
            } else {
              setCurrentIdx(candidates.length); // mark exhausted
            }
          }}
          className={cn(
            "asset-image h-full w-full object-cover transition-opacity duration-300",
            tintClass,
            loaded ? "opacity-100" : "opacity-0"
          )}
        />
      ) : null}
      {(!loaded || exhausted || noneAvailable) && (
        <div
          className={cn(
            "asset-image-fallback absolute inset-0 flex items-center justify-center",
            loaded && !exhausted && !noneAvailable ? "opacity-0" : "opacity-100",
            "transition-opacity duration-300"
          )}
          aria-hidden="true"
        >
          {fallback ?? <DefaultFallback seed={token ?? ""} />}
        </div>
      )}
    </div>
  );
}

function DefaultFallback({ seed }: { seed: string }) {
  const hue = hashHue(seed || "ark");
  const style: CSSProperties = {
    background: `linear-gradient(135deg, hsl(${hue} 42% 72% / 0.45), hsl(${
      (hue + 40) % 360
    } 42% 58% / 0.35))`,
  };
  const label = (seed || "?").replace(/[^\p{L}\p{N}]/gu, "").slice(0, 2) || "…";
  return (
    <div
      style={style}
      className="h-full w-full flex items-center justify-center text-[hsl(var(--color-foreground)/0.55)] text-lg font-semibold tracking-widest select-none"
    >
      {label}
    </div>
  );
}

function hashHue(input: string): number {
  let h = 0;
  for (let i = 0; i < input.length; i += 1) {
    h = (h * 31 + input.charCodeAt(i)) >>> 0;
  }
  return h % 360;
}
