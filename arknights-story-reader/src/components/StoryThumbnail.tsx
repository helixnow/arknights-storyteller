import { useMemo, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { useStoryPreview } from "@/hooks/useStoryPreview";
import { resolveAssetCandidatesLocal } from "@/lib/assetUrls";
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
  const prevCandidatesKeyRef = useRef<string>("");

  const candidatesKey = candidates.join("|");
  let initialCursor = 0;
  let initialLoaded = false;

  if (candidatesKey !== prevCandidatesKeyRef.current) {
    // candidates 变了
    if (loadedUrlRef.current && candidates.includes(loadedUrlRef.current)) {
      // 已成功的 URL 仍在新列表中，保持它
      initialCursor = candidates.indexOf(loadedUrlRef.current);
      initialLoaded = true;
    } else {
      // 需要重新加载
      initialCursor = 0;
      initialLoaded = false;
      loadedUrlRef.current = null;
    }
    prevCandidatesKeyRef.current = candidatesKey;
  }

  const [cursor, setCursor] = useState(initialCursor);
  const [loaded, setLoaded] = useState(initialLoaded);

  // 当 candidates 变化时同步 state（React 允许在 render 中 setState，
  // 只要是条件性的且不会无限循环）
  const lastAppliedKeyRef = useRef(candidatesKey);
  if (lastAppliedKeyRef.current !== candidatesKey) {
    lastAppliedKeyRef.current = candidatesKey;
    setCursor(initialCursor);
    setLoaded(initialLoaded);
  }

  const currentUrl = candidates[cursor] ?? null;
  const tintClass = tint === "soft" ? "filter saturate-[0.85]" : "";

  return (
    <div
      className={cn(
        "absolute inset-0 h-full w-full overflow-hidden bg-[hsl(var(--color-secondary)/0.4)]",
        className
      )}
    >
      {currentUrl ? (
        <img
          key={currentUrl}
          src={currentUrl}
          alt={alt ?? story.storyName}
          loading={lazy ? "lazy" : "eager"}
          decoding="async"
          referrerPolicy="no-referrer"
          draggable={false}
          onLoad={() => {
            loadedUrlRef.current = currentUrl;
            setLoaded(true);
          }}
          onError={() => {
            if (cursor + 1 < candidates.length) {
              setCursor(cursor + 1);
            } else {
              setCursor(candidates.length);
            }
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

function GradientFallback({ seed }: { seed: string }) {
  const hue = hashHue(seed || "ark");
  return (
    <div
      aria-hidden="true"
      className="absolute inset-0"
      style={{
        background: `linear-gradient(135deg, hsl(${hue} 26% 46% / 0.32), hsl(${
          (hue + 40) % 360
        } 32% 36% / 0.28))`,
      }}
    />
  );
}

function hashHue(input: string): number {
  let h = 0;
  for (let i = 0; i < input.length; i += 1) {
    h = (h * 31 + input.charCodeAt(i)) >>> 0;
  }
  return h % 360;
}
