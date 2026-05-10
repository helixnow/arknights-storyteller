// 剧情条目
export interface StoryEntry {
  storyId: string;
  storyName: string;
  storyCode?: string;
  storyGroup: string;
  storySort: number;
  avgTag?: string; // 行动前/行动后
  storyTxt: string; // 剧情文本文件路径
  storyInfo?: string; // 剧情简介文件路径
  storyReviewType: string;
  unLockType: string;
  // 元数据（存在则返回）
  storyDependence?: string | null;
  storyCanShow?: number | null;
  storyCanEnter?: number | null;
  stageCount?: number | null;
  requiredStages?: Array<{
    stageId: string;
    minState: string;
    maxState: string;
  }>; 
  costItemType?: string | null;
  costItemId?: string | null;
  costItemCount?: number | null;
}

// 章节
export interface Chapter {
  chapterId: string;
  chapterName: string;
  chapterName2: string;
  chapterIndex: number;
  preposedChapterId?: string;
  startZoneId: string;
  endZoneId: string;
  chapterEndStageId: string;
}

// 活动
export interface Activity {
  id: string;
  name: string;
  entryType: string;
  actType: string;
  startTime: number;
  endTime: number;
  infoUnlockDatas: StoryEntry[];
}

// 解析后的剧情内容
export interface ParsedStoryContent {
  segments: StorySegment[];
}

// 剧情段落类型
export type StorySegment =
  | DialogueSegment
  | NarrationSegment
  | DecisionSegment
  | SystemSegment
  | SubtitleSegment
  | StickerSegment
  | HeaderSegment
  | ImageSegment
  | MusicSegment;

// 对话段落
export interface DialogueSegment {
  type: 'dialogue';
  characterName: string;
  text: string;
  position?: 'left' | 'right' | null;
  /** 后端解析出的 charId，例如 `char_010_chen`。可用于拼头像 URL。 */
  characterId?: string | null;
}

// 旁白段落
export interface NarrationSegment {
  type: 'narration';
  text: string;
}

// 选项段落
export interface DecisionSegment {
  type: 'decision';
  options: string[];
  values?: string[];
}

export interface SystemSegment {
  type: 'system';
  speaker?: string | null;
  text: string;
}

export interface SubtitleSegment {
  type: 'subtitle';
  text: string;
  alignment?: string | null;
}

export interface StickerSegment {
  type: 'sticker';
  text: string;
  alignment?: string | null;
}

export interface HeaderSegment {
  type: 'header';
  title: string;
}

/** 剧情插画段（`[Image]` / `[Background]` 指令产生）。 */
export interface ImageSegment {
  type: 'image';
  token: string;
  caption?: string | null;
}

/** BGM 指令段，默认前端不渲染。 */
export interface MusicSegment {
  type: 'music';
  key: string;
}

// 剧情分类
export interface StoryCategory {
  id: string;
  name: string;
  type: 'chapter' | 'activity' | 'memory' | 'roguelike' | 'sidestory';
  stories: StoryEntry[];
}

// 搜索结果
export interface SearchResult {
  storyId: string;
  storyName: string;
  matchedText: string;
  category: string;
}

/** 带 facet 与总数的扩展搜索响应 */
export interface SearchResultsPage {
  results: SearchResult[];
  totalMatched: number;
  truncated: boolean;
  facets: Record<string, number>;
}

/** 段级搜索命中 */
export interface SegmentHit {
  storyId: string;
  storyName: string;
  category: string;
  segmentIndex: number;
  segmentType: "dialogue" | "narration" | "system" | "subtitle" | "sticker" | "header" | "decision";
  characterName?: string | null;
  matchedText: string;
  /**
   * 命中所在的字段：
   *   - `body`：搜索词出现在段落正文
   *   - `speaker`：只在说话人/角色名里命中（正文本身可能很短）
   *   - `title`：整篇剧情标题或 storyCode 命中（聚合到 header 段展示）
   *   - `mixed`：分词后零件命中，无法归因到具体列（不显示 badge）
   */
  matchTarget: "body" | "speaker" | "title" | "mixed";
}

export interface SegmentSearchPage {
  hits: SegmentHit[];
  totalMatched: number;
  truncated: boolean;
}

export interface SearchDebugResponse {
  results: SearchResult[];
  logs: string[];
}

export interface StoryIndexStatus {
  ready: boolean;
  total: number;
  lastBuiltAt?: number | null;
}

/** 同一 storyGroup 内的前后剧情。 */
export interface StoryNeighbors {
  prev?: StoryEntry | null;
  next?: StoryEntry | null;
}

/** 剧情缩略图 token：对应后端 `get_story_preview_token` 的返回。`kind` 目前
 *  为 `"image"` 或 `"background"`，前端再拿去 `useAsset` 解析成候选 URL。 */
export interface StoryPreviewToken {
  kind: 'image' | 'background';
  token: string;
}

/** 干员名 ↔ charId 映射（后端 character_table 快照）。 */
export interface CharacterIndex {
  charIdToName: Record<string, string>;
  nameToCharId: Record<string, string>;
}

/** 素材种类——对应 Rust `AssetKind`。 */
export type AssetKind =
  | 'avatar'
  | 'portrait'
  | 'image'
  | 'background'
  | 'activity_kv'
  | 'activity_logo'
  | 'chapter_cover';
