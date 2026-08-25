export type StoryThumbnailSourceKind =
  | "image"
  | "background"
  | "activity_kv"
  | "chapter_cover";

export interface StoryThumbnailSource {
  kind: StoryThumbnailSourceKind;
  token: string;
}

interface ThumbnailStory {
  storyTxt?: string | null;
  storyGroup?: string | null;
  storyPic?: string | null;
}

/**
 * 先列篇内插画，再列数据表给出的活动封面，最后才按 group 猜封面。
 * 返回 token 描述而不是 URL，使这段规则不依赖 React/素材缓存并可直接测试。
 */
export function getStoryThumbnailSources(
  story: ThumbnailStory,
  preview: { kind: "image" | "background"; token: string } | null
): StoryThumbnailSource[] {
  const sources: StoryThumbnailSource[] = [];
  const push = (kind: StoryThumbnailSourceKind, rawToken: string | null | undefined) => {
    const token = rawToken?.trim();
    if (!token) return;
    if (sources.some((source) => source.kind === kind && source.token === token)) return;
    sources.push({ kind, token });
  };

  if (preview) push(preview.kind, preview.token);

  const storyTxt = (story.storyTxt ?? "").replace(/\\/g, "/").toLowerCase();
  const group = story.storyGroup ?? "";
  if (storyTxt.startsWith("obt/main/")) {
    push("chapter_cover", group);
  } else if (storyTxt.startsWith("activities/")) {
    // storyPic 是后端从 storyPic/storyEntryPicId 等字段回填的成品 token。
    // 必须原样排在 act group 启发式之前，尤其不能预先剥掉 act/act_ 前缀。
    push("activity_kv", story.storyPic);
    push("activity_kv", group);
  }

  return sources;
}

export interface ThumbnailCandidateTransition {
  cursor: number;
  loaded: boolean;
  /** 新的高优先级图加载期间继续垫在下面的已解码图片。 */
  bridgeUrl: string | null;
}

/**
 * `loaded` 只说明某次解码曾成功；共享失败表可能已经让当前候选换成另一条。
 * URL 也一致时才能把新 `<img>` 当成已有像素，避免一帧空白或无过渡闪现。
 */
export function isThumbnailVisuallyLoaded(
  loaded: boolean,
  loadedUrl: string | null,
  liveUrl: string | null
): boolean {
  return loaded && liveUrl !== null && loadedUrl === liveUrl;
}

/**
 * 候选表改变时的同步状态迁移。旧图仍是第一候选才原位保留；若只是因为篇内
 * 插画晚到而退居后面，就从新首选开始加载、同时拿旧图垫底，避免永远停在
 * 章节封面或闪回渐变色。换包后旧 URL 已不在候选表时则立刻丢弃。
 */
export function thumbnailCandidateTransition(
  candidates: string[],
  loadedUrl: string | null
): ThumbnailCandidateTransition {
  if (!loadedUrl) return { cursor: 0, loaded: false, bridgeUrl: null };
  const index = candidates.indexOf(loadedUrl);
  if (index === 0) return { cursor: 0, loaded: true, bridgeUrl: null };
  if (index > 0) return { cursor: 0, loaded: false, bridgeUrl: loadedUrl };
  return { cursor: 0, loaded: false, bridgeUrl: null };
}
