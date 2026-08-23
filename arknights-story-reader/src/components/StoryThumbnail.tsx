import { useMemo, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { useStoryPreview } from "@/hooks/useStoryPreview";
import {
  gradientFallbackBackground,
  markAssetUrlAlive,
  markAssetUrlDead,
  pickLiveCandidate,
  resolveAssetCandidatesLocal,
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

  const candidates = useMemo(() => {
    const urls: string[] = [];

    if (previewToken) {
      urls.push(
        ...resolveAssetCandidatesLocal(previewToken.kind, previewToken.token, null)
      );
    }

    const storyTxt = story.storyTxt ?? "";
    const group = story.storyGroup ?? "";
    if (!group) {
      // 没 group，没法兜底
    } else if (storyTxt.startsWith("obt/main/")) {
      urls.push(...resolveAssetCandidatesLocal("chapter_cover", group, null));
    } else if (storyTxt.startsWith("activities/")) {
      urls.push(...resolveAssetCandidatesLocal("activity_kv", group, null));
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
  const currentUrl = live?.url ?? null;
  const tintClass = tint === "soft" ? "filter saturate-[0.85]" : "";

  return (
    <div
      className={cn(
        "absolute inset-0 h-full w-full overflow-hidden bg-[hsl(var(--color-secondary)/0.4)]",
        className
      )}
    >
      {live ? (
        <img
          key={live.url}
          src={live.url}
          alt={alt ?? story.storyName}
          loading={lazy ? "lazy" : "eager"}
          decoding="async"
          referrerPolicy="no-referrer"
          draggable={false}
          onLoad={() => {
            markAssetUrlAlive(live.url);
            loadedUrlRef.current = live.url;
            setLoaded(true);
          }}
          onError={() => {
            markAssetUrlDead(live.url);
            setCursor(Math.min(live.index + 1, candidates.length));
          }}
          className={cn(
            "absolute inset-0 h-full w-full object-cover",
            tintClass,
            loaded ? "opacity-100" : "opacity-0"
          )}
        />
      ) : null}
      {(!currentUrl || !loaded) && (
        <GradientFallback seed={story.storyGroup || story.storyId} />
      )}
    </div>
  );
}

/**
 * 纯渐变兜底。`.story-thumbnail-fallback` 是 index.css 里约定好的钩子——
 * `.story-card-memory-bg` 靠它把这块装饰色块藏掉，否则封面加载失败时卡片
 * 背后会冒出一块跟卡片底色打架的渐变。
 */
function GradientFallback({ seed }: { seed: string }) {
  return (
    <div
      aria-hidden="true"
      className="story-thumbnail-fallback absolute inset-0"
      style={{ background: gradientFallbackBackground(seed) }}
    />
  );
}
