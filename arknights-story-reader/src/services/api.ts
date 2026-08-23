import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type {
  StoryCategory,
  Chapter,
  ParsedStoryContent,
  SearchResult,
  SearchResultsPage,
  SegmentSearchPage,
  StoryEntry,
  StoryIndexStatus,
  SearchDebugResponse,
  AssetKind,
  CharacterIndex,
  StoryNeighbors,
  StoryPreviewToken,
} from "@/types/story";

/**
 * `sync-progress` / `search-progress` / `index-progress` 在 Rust 侧是三个
 * 同形状的结构体，前端共用一个类型即可。`total <= 0` 表示还没有真实刻度，
 * UI 应该走不确定态。
 */
export interface ProgressPayload {
  phase: string;
  current: number;
  total: number;
  message: string;
}

/** `sync-progress` 的载荷，等价于 {@link ProgressPayload}。 */
export type SyncProgress = ProgressPayload;

type ProgressEvent = "sync-progress" | "search-progress" | "index-progress";

/** 三个进度事件的订阅逻辑只有事件名不同。 */
function onProgress(
  event: ProgressEvent,
  callback: (progress: ProgressPayload) => void
): Promise<UnlistenFn> {
  return listen<ProgressPayload>(event, ({ payload }) => callback(payload));
}

/**
 * 同步 / 版本这类生命周期命令一旦失败就是异常路径：留一条 console.error
 * 方便从用户日志里定位，再把原始错误原样抛回去交给调用方做 UI 提示。
 * 目录读取那类命令的失败由调用方自行处理（不少是可以静默的），不走这里。
 */
async function invokeReporting<T>(command: string): Promise<T> {
  try {
    return await invoke<T>(command);
  } catch (error) {
    console.error(`[API] ${command} 失败:`, error);
    throw error;
  }
}

export const api = {
  // 是否已安装数据
  isInstalled: async (): Promise<boolean> => {
    try {
      return await invoke<boolean>("is_installed");
    } catch (error) {
      // 读不到安装状态时按「未安装」处理，让首屏去引导同步而不是卡在报错上。
      console.error("[API] is_installed 失败:", error);
      return false;
    }
  },
  // 同步数据
  syncData: async (): Promise<void> => {
    return invokeReporting<void>("sync_data");
  },

  // 获取当前版本
  getCurrentVersion: async (): Promise<string> => {
    return invokeReporting<string>("get_current_version");
  },

  // 获取远程版本
  getRemoteVersion: async (): Promise<string> => {
    return invokeReporting<string>("get_remote_version");
  },

  // 检查更新
  checkUpdate: async (): Promise<boolean> => {
    return invokeReporting<boolean>("check_update");
  },

  // 手动导入 ZIP（按路径，避免整包穿过 JS 堆）
  importFromZip: async (path: string): Promise<void> => {
    return invoke<void>("import_from_zip", { path });
  },

  // 手动导入ZIP（字节流，移动端回退）
  importZipFromBytes: async (bytes: Uint8Array): Promise<void> => {
    return invoke<void>("import_from_zip_bytes", { bytes });
  },

  // 监听同步进度
  onSyncProgress: (callback: (progress: ProgressPayload) => void) => {
    return onProgress("sync-progress", callback);
  },

  // 获取章节列表
  getChapters: async (): Promise<Chapter[]> => {
    return invoke("get_chapters");
  },

  // 获取剧情分类
  getStoryCategories: async (): Promise<StoryCategory[]> => {
    return invoke("get_story_categories");
  },

  // 获取剧情内容
  getStoryContent: async (storyPath: string): Promise<ParsedStoryContent> => {
    return invoke("get_story_content", { storyPath });
  },

  // 获取剧情缩略图 token（第一条 `[Image]` / `[Background]` 的 token）
  getStoryPreviewToken: async (
    storyPath: string
  ): Promise<StoryPreviewToken | null> => {
    return invoke<StoryPreviewToken | null>("get_story_preview_token", {
      storyPath,
    });
  },

  // 获取剧情简介
  getStoryInfo: async (infoPath: string): Promise<string> => {
    return invoke("get_story_info", { infoPath });
  },

  // 根据ID获取剧情条目
  getStoryEntry: async (storyId: string): Promise<StoryEntry> => {
    return invoke("get_story_entry", { storyId });
  },

  // 获取全文索引状态
  getStoryIndexStatus: async (): Promise<StoryIndexStatus> => {
    return invoke("get_story_index_status");
  },

  // 重建全文索引
  buildStoryIndex: async (): Promise<void> => {
    return invoke("build_story_index");
  },

  // 搜索剧情
  searchStories: async (query: string): Promise<SearchResult[]> => {
    return invoke("search_stories", { query });
  },

  /** 扩展搜索：返回总数 + facet */
  searchStoriesEx: async (query: string): Promise<SearchResultsPage> => {
    return invoke("search_stories_ex", { query });
  },

  /** 段级搜索：返回精确段落位置 */
  searchSegments: async (query: string): Promise<SegmentSearchPage> => {
    return invoke("search_segments", { query });
  },

  // 搜索剧情（带进度事件）
  searchStoriesWithProgress: async (query: string): Promise<SearchResult[]> => {
    return invoke("search_stories_with_progress", { query });
  },

  // 监听搜索进度
  onSearchProgress: (callback: (progress: ProgressPayload) => void) => {
    return onProgress("search-progress", callback);
  },

  // 监听索引重建进度
  onIndexProgress: (callback: (progress: ProgressPayload) => void) => {
    return onProgress("index-progress", callback);
  },

  // 调试模式搜索剧情
  searchStoriesDebug: async (query: string): Promise<SearchDebugResponse> => {
    return invoke("search_stories_debug", { query });
  },

  // 获取主线剧情（按章节分组）
  getMainStoriesGrouped: async (): Promise<Array<[string, StoryEntry[]]>> => {
    return invoke("get_main_stories_grouped");
  },

  // 获取活动剧情（按活动分组）
  getActivityStoriesGrouped: async (): Promise<Array<[string, StoryEntry[]]>> => {
    return invoke("get_activity_stories_grouped");
  },

  // 获取支线剧情（按项目分组）
  getSidestoryStoriesGrouped: async (): Promise<Array<[string, StoryEntry[]]>> => {
    return invoke("get_sidestory_stories_grouped");
  },

  // 获取肉鸽剧情（按项目分组）
  getRoguelikeStoriesGrouped: async (): Promise<Array<[string, StoryEntry[]]>> => {
    return invoke("get_roguelike_stories_grouped");
  },

  // 获取干员密录（原追忆集）
  getMemoryStories: async (): Promise<StoryEntry[]> => {
    return invoke("get_memory_stories");
  },

  // ─────────────────────────────────────────────────────────
  // 素材与人物映射（v1.11 新增）
  // ─────────────────────────────────────────────────────────

  /** 拿到一组候选 URL，前端按顺序 fallback。 */
  resolveAssetUrls: async (kind: AssetKind, token: string): Promise<string[]> => {
    if (!token) return [];
    return invoke<string[]>("resolve_asset_urls", { kind, token });
  },

  /** 获取 charId ↔ 名称映射快照（启动时拉一次，缓存到内存）。 */
  getCharacterIndex: async (): Promise<CharacterIndex> => {
    return invoke<CharacterIndex>("get_character_index");
  },

  /** 根据 storyId 拿前后剧情。 */
  getStoryNeighbors: async (storyId: string): Promise<StoryNeighbors> => {
    return invoke<StoryNeighbors>("get_story_neighbors", { storyId });
  },

  /** 根据 storyId 拿所在章节 / 活动名（分享图会用）。 */
  getStoryCategoryName: async (storyId: string): Promise<string | null> => {
    return invoke<string | null>("get_story_category_name", { storyId });
  },
};
