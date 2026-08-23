import { useEffect, useMemo, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { useStoryPreview } from "@/hooks/useStoryPreview";
import { peekAssetCandidates, useAssetHealthNonce } from "@/hooks/useAsset";
import {
  gradientFallbackBackground,
  markAssetUrlAlive,
  markAssetUrlDead,
  pickLiveCandidate,
} from "@/lib/assetUrls";
import type { StoryEntry } from "@/types/story";

/**
 * 剧情列表/首页上的缩略图。优先展示该关卡剧情里真正出现的那张插画；
 * 拿不到时退化到章节/活动封面。视觉上撑满调用方提供的容器。
 */
interface StoryThumbnailProps {
  story: StoryEntry;
  className?: string;
  alt?: string;
  lazy?: boolean;
  tint?: "none" | "soft";
}

export function StoryThumbnail({
  story,
  className,
  alt,
  lazy = true,
  tint = "soft",
}: StoryThumbnailProps) {
  const { token: previewToken } = useStoryPreview(story.storyTxt);

  // 候选表统一走 `peekAssetCandidates` 的按-token 缓存：同一张封面在列表
  // 缩略图和卡片模糊背景里各渲染一次，两处拿到的是同一个数组引用，字符串
  // 拼接也只做一次。
  const candidates = useMemo(() => {
    const urls: string[] = [];

    if (previewToken) {
      urls.push(...peekAssetCandidates(previewToken.kind, previewToken.token));
    }

    const storyTxt = story.storyTxt ?? "";
    const group = story.storyGroup ?? "";
    if (!group) {
      // 没 group，没法兜底
    } else if (storyTxt.startsWith("obt/main/")) {
      urls.push(...peekAssetCandidates("chapter_cover", group));
    } else if (storyTxt.startsWith("activities/")) {
      urls.push(...peekAssetCandidates("activity_kv", group));
    }

    return Array.from(new Set(urls));
  }, [previewToken, story.storyTxt, story.storyGroup]);

  // ---- 图片加载状态 ----
  // 用 ref 跟踪"当前成功加载的 URL"，当 candidates 变化时，如果已成功的
  // URL 仍在新列表中，就保持显示，不重置。这避免了 token 异步回来后把已经
  // 显示好的图片闪掉再重新加载的问题。
  const loadedUrlRef = useRef<string | null>(null);
  const [cursor, setCursor] = useState(0);
  const [loaded, setLoaded] = useState(false);

  // candidates 变了就同步 state（React 允许在 render 中条件性 setState，
  // 只要不会无限循环）。
  const candidatesKey = candidates.join("|");
  const appliedKeyRef = useRef(candidatesKey);
  if (appliedKeyRef.current !== candidatesKey) {
    appliedKeyRef.current = candidatesKey;
    const keptIdx = loadedUrlRef.current ? candidates.indexOf(loadedUrlRef.current) : -1;
    if (keptIdx >= 0) {
      setCursor(keptIdx);
      setLoaded(true);
    } else {
      loadedUrlRef.current = null;
      setCursor(0);
      setLoaded(false);
    }
  }

  // 与 `<AssetImage>` 共用同一份失败缓存 / host 熔断：同一张 404 的封面
  // 不会因为走了两条渲染路径就被请求两遍。
  const live = pickLiveCandidate(candidates, cursor);
  // 候选全被跳过（host 熔断或 URL 标死）都订阅健康度事件：host 首次被
  // 证明可达时 markAssetUrlAlive 会撤销此前的存疑失败记录，此时把游标
  // 拨回 0 重扫候选链——否则断网期间看过的封面在网络恢复后永远停在
  // 渐变兜底上。真正失败过的 URL 仍被 deadUrls 跳过，不会原地打转；
  // 图片正常显示时不订阅，零开销。
  const stuck = live === null && candidates.length > 0;
  const healthNonce = useAssetHealthNonce(stuck);
  const healthNonceRef = useRef(healthNonce);
  if (healthNonceRef.current !== healthNonce) {
    healthNonceRef.current = healthNonce;
    if (stuck) setCursor(0);
  }

  // 解码放到主线程之外：滚动时一张 1920px 的活动 KV 同步解码足以掉帧。
  // 解码完成前保持兜底色块，完成后再淡入，避免"半张图"闪现。
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);
  const currentUrlRef = useRef<string | null>(null);
  currentUrlRef.current = live?.url ?? null;

  const tintClass = tint === "soft" ? "filter saturate-[0.85]" : "";

  return (
    <div
      className={cn(
        "absolute inset-0 h-full w-full overflow-hidden bg-[hsl(var(--color-secondary)/0.4)]",
        className
      )}
    >
      {/* 兜底色块常驻：卡片的宽高由调用方的容器决定，这里只做淡入淡出，
          既不会在图片到位的瞬间产生一次 DOM 增删，也不会有任何布局位移。 */}
      <GradientFallback
        seed={story.storyGroup || story.storyId}
        hidden={Boolean(live) && loaded}
      />
      {live ? (
        <img
          key={live.url}
          src={live.url}
          alt={alt ?? story.storyName}
          loading={lazy ? "lazy" : "eager"}
          decoding="async"
          fetchPriority={lazy ? "low" : "high"}
          referrerPolicy="no-referrer"
          draggable={false}
          onLoad={(event) => {
            const img = event.currentTarget;
            const url = live.url;
            markAssetUrlAlive(url);
            const show = () => {
              if (!mountedRef.current || currentUrlRef.current !== url) return;
              loadedUrlRef.current = url;
              setLoaded(true);
            };
            if (typeof img.decode === "function") {
              img.decode().then(show, show);
            } else {
              show();
            }
          }}
          onError={() => {
            markAssetUrlDead(live.url);
            setCursor(Math.min(live.index + 1, candidates.length));
          }}
          className={cn(
            "absolute inset-0 h-full w-full object-cover motion-safe:transition-opacity motion-safe:duration-300",
            tintClass,
            loaded ? "opacity-100" : "opacity-0"
          )}
        />
      ) : null}
    </div>
  );
}

/**
 * 纯渐变兜底。`.story-thumbnail-fallback` 是 index.css 里约定好的钩子——
 * `.story-card-memory-bg` 靠它把这块装饰色块藏掉，否则封面加载失败时卡片
 * 背后会冒出一块跟卡片底色打架的渐变。
 */
function GradientFallback({ seed, hidden }: { seed: string; hidden: boolean }) {
  return (
    <div
      aria-hidden="true"
      className={cn(
        "story-thumbnail-fallback absolute inset-0 motion-safe:transition-opacity motion-safe:duration-300",
        hidden ? "opacity-0" : "opacity-100"
      )}
      style={{ background: gradientFallbackBackground(seed) }}
    />
  );
}
