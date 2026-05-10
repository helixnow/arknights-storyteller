import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { logger } from "@/lib/logger";
import type {
  StoryCategory,
  Chapter,
  ParsedStoryContent,
  SearchResult,
  StoryEntry,
  StoryIndexStatus,
  SearchDebugResponse,
  RoguelikeCharm,
  RoguelikeRelic,
  RoguelikeStage,
  CharacterBasicInfo,
  CharacterHandbook,
  CharacterVoice,
  CharacterEquipment,
  CharacterPotentialToken,
  CharacterTalents,
  CharacterTrait,
  CharacterPotentialRanks,
  CharacterSkills,
  CharacterSkins,
  SubProfessionInfo,
  TeamPowerInfo,
  CharacterBuildingSkills,
  CharacterAllData,
  Furniture,
  FurnitureTheme,
  FurnitureSearchResult,
  CharacterHandbookByName,
  CharacterIndex,
  AssetKind,
  StoryPreviewToken,
} from "@/types/story";

export interface SyncProgress {
  phase: string;
  current: number;
  total: number;
  message: string;
}

export const api = {
  // 是否已安装数据
  isInstalled: async (): Promise<boolean> => {
    logger.debug("API", "调用 is_installed");
    try {
      const ok = await invoke<boolean>("is_installed");
      logger.debug("API", "is_installed:", ok);
      return ok;
    } catch (error) {
      logger.error("API", "is_installed 失败:", error);
      return false;
    }
  },
  // 同步数据
  syncData: async (): Promise<void> => {
    logger.debug("API", "开始调用 sync_data 命令");
    try {
      await invoke<void>("sync_data");
      logger.debug("API", "sync_data 命令成功完成");
    } catch (error) {
      logger.error("API", "sync_data 命令失败:", error);
      throw error;
    }
  },

  // 获取当前版本
  getCurrentVersion: async (): Promise<string> => {
    logger.debug("API", "调用 get_current_version");
    try {
      const version = await invoke<string>("get_current_version");
      logger.debug("API", "当前版本:", version);
      return version;
    } catch (error) {
      logger.error("API", "获取当前版本失败:", error);
      throw error;
    }
  },

  // 获取远程版本
  getRemoteVersion: async (): Promise<string> => {
    logger.debug("API", "调用 get_remote_version");
    try {
      const version = await invoke<string>("get_remote_version");
      logger.debug("API", "远程版本:", version);
      return version;
    } catch (error) {
      logger.error("API", "获取远程版本失败:", error);
      throw error;
    }
  },

  // 检查更新
  checkUpdate: async (): Promise<boolean> => {
    logger.debug("API", "调用 check_update");
    try {
      const hasUpdate = await invoke<boolean>("check_update");
      logger.debug("API", "是否有更新:", hasUpdate);
      return hasUpdate;
    } catch (error) {
      logger.error("API", "检查更新失败:", error);
      throw error;
    }
  },

  // 手动导入ZIP（字节流）
  importZipFromBytes: async (bytes: Uint8Array): Promise<void> => {
    logger.debug("API", "调用 import_from_zip_bytes, 大小:", bytes.byteLength);
    return invoke<void>("import_from_zip_bytes", { bytes });
  },

  // 监听同步进度
  onSyncProgress: (callback: (progress: SyncProgress) => void) => {
    logger.debug("API", "开始监听 sync-progress 事件");
    return listen<SyncProgress>("sync-progress", (event) => {
      logger.debug("API", "收到同步进度:", event.payload);
      callback(event.payload);
    });
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

  // 搜索剧情（带进度事件）
  searchStoriesWithProgress: async (query: string): Promise<SearchResult[]> => {
    return invoke("search_stories_with_progress", { query });
  },

  // 监听搜索进度
  onSearchProgress: (callback: (progress: { phase: string; current: number; total: number; message: string }) => void) => {
    return listen("search-progress", (event) => {
      // @ts-expect-error payload shape from Rust
      callback(event.payload);
    });
  },

  // 调试模式搜索剧情
  searchStoriesDebug: async (query: string): Promise<SearchDebugResponse> => {
    return invoke("search_stories_debug", { query });
  },

  // 获取主线剧情（按章节分组）
  getMainStoriesGrouped: async (): Promise<Array<[string, StoryEntry[]]>> => {
    logger.debug("API", "调用 get_main_stories_grouped");
    return invoke("get_main_stories_grouped");
  },

  // 获取活动剧情（按活动分组）
  getActivityStoriesGrouped: async (): Promise<Array<[string, StoryEntry[]]>> => {
    logger.debug("API", "调用 get_activity_stories_grouped");
    return invoke("get_activity_stories_grouped");
  },

  // 获取支线剧情（按项目分组）
  getSidestoryStoriesGrouped: async (): Promise<Array<[string, StoryEntry[]]>> => {
    logger.debug("API", "调用 get_sidestory_stories_grouped");
    return invoke("get_sidestory_stories_grouped");
  },

  // 获取肉鸽剧情（按项目分组）
  getRoguelikeStoriesGrouped: async (): Promise<Array<[string, StoryEntry[]]>> => {
    logger.debug("API", "调用 get_roguelike_stories_grouped");
    return invoke("get_roguelike_stories_grouped");
  },

  // 获取干员密录（原追忆集）
  getMemoryStories: async (): Promise<StoryEntry[]> => {
    logger.debug("API", "调用 get_memory_stories");
    return invoke("get_memory_stories");
  },

  // 获取主线笔记剧情（按章节分组）
  getRecordStoriesGrouped: async (): Promise<Array<[string, StoryEntry[]]>> => {
    logger.debug("API", "调用 get_record_stories_grouped");
    return invoke("get_record_stories_grouped");
  },

  // 获取危机合约剧情
  getRuneStories: async (): Promise<StoryEntry[]> => {
    logger.debug("API", "调用 get_rune_stories");
    return invoke("get_rune_stories");
  },

  // 获取肉鸽符文道具
  getRoguelikeCharms: async (): Promise<RoguelikeCharm[]> => {
    logger.debug("API", "调用 get_roguelike_charms");
    return invoke("get_roguelike_charms");
  },

  getRoguelikeRelics: async (): Promise<RoguelikeRelic[]> => {
    logger.debug("API", "调用 get_roguelike_relics");
    return invoke("get_roguelike_relics");
  },

  // 获取肉鸽场景
  getRoguelikeStages: async (): Promise<RoguelikeStage[]> => {
    logger.debug("API", "调用 get_roguelike_stages");
    return invoke("get_roguelike_stages");
  },

  // 获取干员列表
  getCharactersList: async (): Promise<CharacterBasicInfo[]> => {
    logger.debug("API", "调用 get_characters_list");
    return invoke("get_characters_list");
  },

  // 获取干员档案
  getCharacterHandbook: async (charId: string): Promise<CharacterHandbook> => {
    logger.debug("API", "调用 get_character_handbook, charId:", charId);
    return invoke("get_character_handbook", { charId });
  },

  // 获取干员语音
  getCharacterVoices: async (charId: string): Promise<CharacterVoice> => {
    logger.debug("API", "调用 get_character_voices, charId:", charId);
    return invoke("get_character_voices", { charId });
  },

  // 获取干员模组
  getCharacterEquipment: async (charId: string): Promise<CharacterEquipment> => {
    logger.debug("API", "调用 get_character_equipment, charId:", charId);
    return invoke("get_character_equipment", { charId });
  },

  // 获取干员潜能信物
  getCharacterPotentialToken: async (charId: string): Promise<CharacterPotentialToken> => {
    logger.debug("API", "调用 get_character_potential_token, charId:", charId);
    return invoke("get_character_potential_token", { charId });
  },

  // 获取干员天赋
  getCharacterTalents: async (charId: string): Promise<CharacterTalents> => {
    logger.debug("API", "调用 get_character_talents, charId:", charId);
    return invoke("get_character_talents", { charId });
  },

  // 获取干员特性
  getCharacterTrait: async (charId: string): Promise<CharacterTrait> => {
    logger.debug("API", "调用 get_character_trait, charId:", charId);
    return invoke("get_character_trait", { charId });
  },

  // 获取干员潜能加成
  getCharacterPotentialRanks: async (charId: string): Promise<CharacterPotentialRanks> => {
    logger.debug("API", "调用 get_character_potential_ranks, charId:", charId);
    return invoke("get_character_potential_ranks", { charId });
  },

  // 获取干员技能
  getCharacterSkills: async (charId: string): Promise<CharacterSkills> => {
    logger.debug("API", "调用 get_character_skills, charId:", charId);
    return invoke("get_character_skills", { charId });
  },

  // 获取干员皮肤
  getCharacterSkins: async (charId: string): Promise<CharacterSkins> => {
    logger.debug("API", "调用 get_character_skins, charId:", charId);
    return invoke("get_character_skins", { charId });
  },

  // 获取子职业信息
  getSubProfessionInfo: async (subProfId: string): Promise<SubProfessionInfo> => {
    logger.debug("API", "调用 get_sub_profession_info, subProfId:", subProfId);
    return invoke("get_sub_profession_info", { subProfId });
  },

  // 获取势力/团队信息
  getTeamPowerInfo: async (powerId: string): Promise<TeamPowerInfo> => {
    logger.debug("API", "调用 get_team_power_info, powerId:", powerId);
    return invoke("get_team_power_info", { powerId });
  },

  // 获取干员基建技能
  getCharacterBuildingSkills: async (charId: string): Promise<CharacterBuildingSkills> => {
    logger.debug("API", "调用 get_character_building_skills, charId:", charId);
    return invoke("get_character_building_skills", { charId });
  },

  // 一次性获取干员所有数据（优化版）
  getCharacterAllData: async (charId: string): Promise<CharacterAllData> => {
    logger.debug("API", "调用 get_character_all_data (优化版), charId:", charId);
    return invoke("get_character_all_data", { charId });
  },

  // ==================== 家具相关 API ====================

  // 获取所有家具列表
  getAllFurnitures: async (): Promise<Furniture[]> => {
    logger.debug("API", "调用 get_all_furnitures");
    return invoke("get_all_furnitures");
  },

  // 按主题ID获取家具
  getFurnituresByTheme: async (themeId: string): Promise<Furniture[]> => {
    logger.debug("API", "调用 get_furnitures_by_theme, themeId:", themeId);
    return invoke("get_furnitures_by_theme", { themeId });
  },

  // 搜索家具（按名称或描述）
  searchFurnitures: async (query: string): Promise<FurnitureSearchResult[]> => {
    logger.debug("API", "调用 search_furnitures, query:", query);
    return invoke("search_furnitures", { query });
  },

  // 获取所有家具主题
  getFurnitureThemes: async (): Promise<FurnitureTheme[]> => {
    logger.debug("API", "调用 get_furniture_themes");
    return invoke("get_furniture_themes");
  },

  // ==================== 干员密录通过名字查询 ====================

  // 通过干员名字获取干员密录
  getCharacterHandbookByName: async (
    charName: string
  ): Promise<CharacterHandbookByName> => {
    logger.debug("API", "调用 get_character_handbook_by_name, charName:", charName);
    return invoke("get_character_handbook_by_name", { charName });
  },

  // 批量通过干员名字获取密录
  getCharacterHandbooksByNames: async (
    charNames: string[]
  ): Promise<CharacterHandbookByName[]> => {
    logger.debug("API", "调用 get_character_handbooks_by_names, charNames:", charNames);
    return invoke("get_character_handbooks_by_names", { charNames });
  },

  // ==================== Main 分支功能 ====================

  // 获取干员索引
  getCharacterIndex: async (): Promise<CharacterIndex> => {
    logger.debug("API", "调用 get_character_index");
    return invoke("get_character_index");
  },

  // 素材 URL 解析
  resolveAssetUrls: async (kind: AssetKind, token: string): Promise<string[]> => {
    logger.debug("API", "调用 resolve_asset_urls, kind:", kind, "token:", token);
    return invoke("resolve_asset_urls", { kind, token });
  },

  // 获取前后剧情
  getStoryNeighbors: async (storyId: string): Promise<{ prev: StoryEntry | null; next: StoryEntry | null }> => {
    logger.debug("API", "调用 get_story_neighbors, storyId:", storyId);
    return invoke("get_story_neighbors", { storyId });
  },

  // 获取章节/活动名
  getStoryCategoryName: async (storyId: string): Promise<string | null> => {
    logger.debug("API", "调用 get_story_category_name, storyId:", storyId);
    return invoke("get_story_category_name", { storyId });
  },

  // 高级搜索
  searchStoriesEx: async (query: string): Promise<any> => {
    logger.debug("API", "调用 search_stories_ex, query:", query);
    return invoke("search_stories_ex", { query });
  },

  // 段落级搜索
  searchSegments: async (query: string): Promise<any> => {
    logger.debug("API", "调用 search_segments, query:", query);
    return invoke("search_segments", { query });
  },

  // 获取故事预览 token
  getStoryPreviewToken: async (storyPath: string): Promise<StoryPreviewToken | null> => {
    logger.debug("API", "调用 get_story_preview_token, storyPath:", storyPath);
    // TODO: 后端尚未实现此命令，暂时返回 null
    return null;
  },
};
