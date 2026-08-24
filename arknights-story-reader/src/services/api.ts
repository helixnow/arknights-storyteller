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
 * 同步 / 导入 / 索引重建 / 版本这类生命周期命令一旦失败就是异常路径：
 * 留一条 console.error 方便从用户日志里定位，再把原始错误原样抛回去交给
 * 调用方做 UI 提示。调用方失败分支里的 devWarn / devLog 在正式包里是
 * 静默的（见 useAppUpdater 的 IS_DEV 开关），这里是失败在生产日志里唯一
 * 的落点，漏挂等于把该命令的线上故障变成无迹可查。
 * 日志只记命令名与错误，绝不记 args——分块导入的参数里是整块 base64，
 * 导入路径里还有用户目录名，截图求助时不该被一并带出去。
 * 目录读取那类命令的失败由调用方自行处理（不少是可以静默的），不走这里。
 */
async function invokeReporting<T>(
  command: string,
  args?: Record<string, unknown>
): Promise<T> {
  try {
    return await invoke<T>(command, args);
  } catch (error) {
    console.error(`[API] ${command} 失败:`, error);
    throw error;
  }
}

/**
 * 后端 search-progress 是进程级事件，没有 requestId。Tauri invoke 又不能
 * abort：输入变化后旧搜索仍会跑，若直接并发，新旧进度无法可靠归属。
 *
 * 搜索命令在前端串行；一旦有更新请求排队，旧请求后续进度立即静默。这样
 * onSearchProgress 只转发“当前最新且已经真正开始”的命令，SearchPanel 再用
 * 查询起点/阶段/数据代际做第二层门禁。被更新请求越过、尚未开始的中间查询
 * 不再白跑后端。
 */
let latestSearchRequest = 0;
let activeSearchRequest = 0;
let searchQueue: Promise<void> = Promise.resolve();

async function invokeSearchReporting<T>(
  command: string,
  args: Record<string, unknown>
): Promise<T> {
  const request = ++latestSearchRequest;
  const run = searchQueue.then(async () => {
    // 等待期间又来了更新意图：调用方已有自己的 stale generation，这条无需
    // 再进后端。抛错只负责结束 Promise，旧 SearchPanel catch 会按代际丢弃。
    if (request !== latestSearchRequest) throw new Error("SEARCH_SUPERSEDED");
    activeSearchRequest = request;
    try {
      return await invokeReporting<T>(command, args);
    } finally {
      if (activeSearchRequest === request) activeSearchRequest = 0;
    }
  });
  searchQueue = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

export const api = {
  // 是否已安装数据。IPC 失败必须原样抛给调用方，绝不能吞成 false：
  // 「读不到安装状态」≠「未安装」。消费方全都按「会抛错」的契约写了
  // 各自的失败分支——StoryList 挂载检查的 catch 改为乐观直读目录、
  // HomePanel 立「重试 / 去设置」错误卡、CharactersPanel 走错误态、
  // useAutoIndex 跳过本轮。吞成 false 会让这些分支全部变成死代码：
  // 一次 IPC 抖动就弹同步对话框 / 显示「未安装」空态，把有数据的用户
  // 带去做一次没必要的同步；false 还会被 storyCatalog 当成功结果缓存
  // 60 秒，错误状态在 TTL 内都纠不回来（rejection 则不会进缓存）。
  isInstalled: async (): Promise<boolean> => {
    return invokeReporting<boolean>("is_installed");
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

  // 手动导入 ZIP（按路径，避免整包穿过 JS 堆）。导入与同步在后端共用
  // 同一把安装互斥，是同级别的生命周期命令：失败必须走 invokeReporting
  // 在生产日志里留痕（调用方 runImport 的 devWarn 正式包里不输出）。
  importFromZip: async (path: string): Promise<void> => {
    return invokeReporting<void>("import_from_zip", { path });
  },

  // 手动导入 ZIP 的分块通道（移动端 / <input type="file"> 回退）。
  // 千万不要把 Uint8Array 塞进 invoke 参数：Android 的 IPC 走 postMessage，
  // 二进制会被 JSON 化成数字数组，整包几百 MB 的 ZIP 直接 OOM——
  // 所以按块传 base64。offset 为该块的字节偏移（0 开启新一轮传输），
  // last 为 true 时后端把暂存文件转正并执行导入。失败同样要留生产日志
  // （invokeReporting 只记命令名与错误，不会把整块 base64 打进控制台）；
  // 一轮传输至多一块失败——循环在第一个 reject 处就停了，不会刷屏。
  importZipChunk: async (chunkBase64: string, offset: number, last: boolean): Promise<void> => {
    return invokeReporting<void>("import_from_zip_bytes", { chunkBase64, offset, last });
  },

  // 显式中止在途的分块导入。FileReader 读块失败 / 某块 IPC 没送达后端时，
  // 后端寄存的安装互斥没有任何回调会来释放，只能干等 60 秒弃单超时，
  // 期间点「同步」只会收到「导入正在进行」。复用同一个命令的 cancel
  // 分支（免得后端再注册一个 invoke handler）：立刻放锁并清理暂存文件。
  // 中止失败意味着安装互斥要攥到 60 秒弃单超时、期间同步一直报「导入
  // 正在进行」，而调用方 catch 里只有 devWarn（正式包静默）——必须在
  // 这里留生产日志，事后才对得上「同步莫名被锁」的用户反馈。
  abortZipImport: async (): Promise<void> => {
    return invokeReporting<void>("import_from_zip_bytes", { chunkBase64: "", offset: 0, last: false, cancel: true });
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
    return invokeReporting<StoryIndexStatus>("get_story_index_status");
  },

  // 重建全文索引。也是生命周期命令：失败后搜索会静默退化成线性扫描，
  // 而三个调用方（SearchPanel、useAutoIndex、设置页事件链）的失败分支
  // 全走 devLog/devWarn（正式包静默），不留这条日志线上就无从定位。
  buildStoryIndex: async (): Promise<void> => {
    return invokeReporting<void>("build_story_index");
  },

  // 搜索剧情
  searchStories: async (query: string): Promise<SearchResult[]> => {
    return invokeSearchReporting<SearchResult[]>("search_stories", { query });
  },

  /** 扩展搜索：返回总数 + facet */
  searchStoriesEx: async (query: string): Promise<SearchResultsPage> => {
    return invokeSearchReporting<SearchResultsPage>("search_stories_ex", { query });
  },

  /** 段级搜索：返回精确段落位置 */
  searchSegments: async (query: string): Promise<SegmentSearchPage> => {
    return invokeSearchReporting<SegmentSearchPage>("search_segments", { query });
  },

  // 搜索剧情（带进度事件）
  searchStoriesWithProgress: async (query: string): Promise<SearchResult[]> => {
    return invokeSearchReporting<SearchResult[]>("search_stories_with_progress", { query });
  },

  // 监听搜索进度
  onSearchProgress: (callback: (progress: ProgressPayload) => void) => {
    return onProgress("search-progress", (progress) => {
      if (activeSearchRequest !== 0 && activeSearchRequest === latestSearchRequest) {
        callback(progress);
      }
    });
  },

  // 监听索引重建进度
  onIndexProgress: (callback: (progress: ProgressPayload) => void) => {
    return onProgress("index-progress", callback);
  },

  // 调试模式搜索剧情
  searchStoriesDebug: async (query: string): Promise<SearchDebugResponse> => {
    return invokeSearchReporting<SearchDebugResponse>("search_stories_debug", { query });
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
