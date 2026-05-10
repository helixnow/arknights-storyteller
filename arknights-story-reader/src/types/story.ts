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
  | HeaderSegment;

// 对话段落
export interface DialogueSegment {
  type: 'dialogue';
  characterName: string;
  characterId?: string | null;
  text: string;
  position?: 'left' | 'right' | null;
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

// 剧情分类
export interface StoryCategory {
  id: string;
  name: string;
  type: 'chapter' | 'activity' | 'memory' | 'roguelike' | 'sidestory';
  stories: StoryEntry[];
}

export interface RoguelikeCharm {
  id: string;
  name: string;
  sort: number;
  icon?: string;
  rarity?: string;
  charmType?: string;
  price?: number;
  obtainInRandom: boolean;
  itemUsage?: string;
  itemDescription?: string;
  shortDescription?: string;
  obtainApproach?: string;
  specialObtainApproach?: string;
  runeDescription?: string;
  runePoints?: number;
  dropStageIds: string[];
}

export interface RoguelikeRelic {
  id: string;
  name: string;
  description?: string;
  usage?: string;
  obtainApproach?: string;
  rarity: string;
  sortId: number;
  category: string;
  type?: string;
  subType?: string;
  iconId?: string;
  value?: number;
}

export interface RoguelikeStage {
  id: string;
  name: string;
  code?: string;
  description?: string;
  eliteDescription?: string;
  difficulty?: string;
  isBoss: boolean;
  isElite: boolean;
  levelId?: string;
  themeKey?: string;
  themeLabel?: string;
  category?: string;
  categoryLabel?: string;
  loadingPicId?: string;
}

// ==================== 干员相关类型 ====================

export interface CharacterBasicInfo {
  charId: string;
  name: string;
  appellation: string;
  rarity: number;
  profession: string;
  subProfessionId: string;
  subProfessionName?: string;
  position: string;
  nationId?: string;
  groupId?: string;
  teamId?: string;
  itemDesc?: string;
  itemUsage?: string;
  description?: string;
  tagList: string[];
}

export interface CharacterHandbook {
  charId: string;
  charName: string;
  rarity: number;
  profession: string;
  subProfession?: string;
  storyTextAudio: HandbookStorySection[];
}

export interface HandbookStorySection {
  storyTitle: string;
  stories: HandbookStory[];
}

export interface HandbookStory {
  storyText: string;
  unLockType: string;
  unLockParam: string;
}

export interface CharacterVoice {
  charId: string;
  charName: string;
  voices: VoiceLine[];
}

export interface VoiceLine {
  voiceId: string;
  voiceTitle: string;
  voiceText: string;
  voiceIndex: number;
  unlockType: string;
}

export interface CharacterEquipment {
  charId: string;
  charName: string;
  equipments: EquipmentInfo[];
}

export interface EquipmentInfo {
  equipId: string;
  equipName: string;
  equipDesc: string;
  equipShiningColor?: string;
  typeName: string;
}

// ==================== 新增：潜能信物 ====================

export interface CharacterPotentialToken {
  charId: string;
  charName: string;
  itemId: string;
  tokenName: string;
  tokenDesc: string;
  tokenUsage: string;
  rarity: string;
  obtainApproach: string;
}

// ==================== 新增：天赋 ====================

export interface CharacterTalents {
  charId: string;
  charName: string;
  talents: TalentInfo[];
}

export interface TalentInfo {
  talentIndex: number;
  candidates: TalentCandidate[];
}

export interface TalentCandidate {
  unlockCondition: TalentUnlockCondition;
  name: string;
  description?: string;
  rangeDescription?: string;
}

export interface TalentUnlockCondition {
  phase: string;
  level: number;
}

// ==================== 新增：特性 ====================

export interface CharacterTrait {
  charId: string;
  charName: string;
  trait?: TraitInfo;
}

export interface TraitInfo {
  candidates: TraitCandidate[];
}

export interface TraitCandidate {
  unlockCondition: TraitUnlockCondition;
  overrideDescripton?: string;
}

export interface TraitUnlockCondition {
  phase: string;
  level: number;
}

// ==================== 新增：潜能加成 ====================

export interface CharacterPotentialRanks {
  charId: string;
  charName: string;
  potentialRanks: PotentialRank[];
}

export interface PotentialRank {
  rank: number;
  description: string;
}

// ==================== 新增：技能 ====================

export interface CharacterSkills {
  charId: string;
  charName: string;
  skills: SkillInfo[];
}

export interface SkillInfo {
  skillId: string;
  iconId?: string;
  levels: SkillLevel[];
}

export interface SkillLevel {
  level: number;
  name: string;
  description: string;
  skillType: string;
  durationType: string;
  spData: SkillSPData;
  duration: number;
  blackboard: BlackboardValue[];
}

export interface BlackboardValue {
  key: string;
  value: number;
}

export interface SkillSPData {
  spType: string;
  spCost: number;
  initSp: number;
}

// ==================== 新增：皮肤 ====================

export interface CharacterSkins {
  charId: string;
  charName: string;
  skins: SkinInfo[];
}

export interface SkinInfo {
  skinId: string;
  skinName?: string;
  illustId?: string;
  avatarId: string;
  portraitId?: string;
  isBuySkin: boolean;
  skinGroupName?: string;
  content?: string;
  dialog?: string;
  usage?: string;
  description?: string;
  obtainApproach?: string;
  drawerList: string[];
}

// ==================== 新增：子职业信息 ====================

export interface SubProfessionInfo {
  subProfessionId: string;
  subProfessionName: string;
  subProfessionCatagory: number;
}

// ==================== 新增：势力/团队信息 ====================

export interface TeamPowerInfo {
  powerId: string;
  powerName: string;
  powerCode: string;
  color: string;
  isLimited: boolean;
}

// ==================== 新增：基建技能 ====================

export interface CharacterBuildingSkills {
  charId: string;
  charName: string;
  buildingSkills: BuildingSkillInfo[];
}

export interface BuildingSkillInfo {
  buffId: string;
  buffName: string;
  description: string;
  roomType: string;
  unlockCondition: BuildingSkillUnlockCondition;
}

export interface BuildingSkillUnlockCondition {
  phase: string;
  level: number;
}

// ==================== 新增：一次性获取所有干员数据 ====================

export interface CharacterAllData {
  charId: string;
  charName: string;
  handbook: CharacterHandbook;
  voices: CharacterVoice;
  equipment: CharacterEquipment;
  potentialToken?: CharacterPotentialToken;
  talents?: CharacterTalents;
  trait?: CharacterTrait;
  potentialRanks?: CharacterPotentialRanks;
  skills?: CharacterSkills;
  skins?: CharacterSkins;
  buildingSkills?: CharacterBuildingSkills;
}

// 搜索结果
export interface SearchResult {
  storyId: string;
  storyName: string;
  matchedText: string;
  category: string;
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

// ==================== 家具相关类型 ====================

export interface Furniture {
  id: string;
  sortId: number;
  name: string;
  iconId: string;
  interactType: string;
  musicId?: string;
  type: string;
  subType: string;
  location: string;
  category: string;
  validOnRotate: boolean;
  enableRotate: boolean;
  rarity: number;
  themeId: string;
  groupId: string;
  width: number;
  depth: number;
  height: number;
  comfort: number;
  usage: string;
  description: string;
  obtainApproach: string;
  canBeDestroy: boolean;
  quantity: number;
}

export interface FurnitureTheme {
  themeId: string;
  themeName: string;
  themeType?: string;
  sortId: number;
}

export interface FurnitureSearchResult {
  furniture: Furniture;
  themeName?: string;
}

// ==================== 通过干员名字查询密录 ====================

export interface CharacterHandbookByName {
  charId: string;
  charName: string;
  handbook: CharacterHandbook;
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

export interface StoryPreviewToken {
  kind: 'image' | 'background';
  token: string;
}
