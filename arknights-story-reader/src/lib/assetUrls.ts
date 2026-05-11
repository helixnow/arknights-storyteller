/**
 * 纯前端素材 URL 解析器。
 *
 * 这些 URL 模板是纯字符串拼接，没必要让每个 `<AssetImage>` 都做一次
 * Tauri IPC。在 CharactersPanel / StoryList 这类一次渲染 100+ 个头像/
 * 封面的场景里，IPC 队列会直接把 UI 卡死。
 *
 * Rust 侧的 `asset_service.rs` 仍然保留，作为原始数据来源；这个文件只是
 * 把同样的规则翻译到 JS，保证两边命中同一组 URL。
 */
import type { AssetKind } from "@/types/story";
import type { CharacterIndex } from "@/types/story";

const YUANYAN = "https://raw.githubusercontent.com/yuanyan3060/ArknightsGameResource/main";
const FEXLI = "https://raw.githubusercontent.com/fexli/ArknightsResource/main";
const PUPPIIZ = "https://raw.githubusercontent.com/PuppiizSunniiz/Arknight-Images/main";
/**
 * 已知 NPC 头像覆盖表。这些角色不在 character_table 中（非干员），
 * 但在剧情中频繁出现，需要手动指定头像 URL。
 * 图片已持久化到 public/avatars/npc/ 目录下。
 * key = 中文名（与剧情脚本 `[name="..."]` 一致）
 */
const NPC_AVATAR_OVERRIDES: Record<string, string[]> = {
  "普瑞赛斯": ["/avatars/npc/priestess.png"],
  "希尔达": ["/avatars/npc/hierda.png"],
};

function resolveCharId(token: string, index: CharacterIndex | null): string | null {
  if (token.startsWith("char_")) {
    return token.split("#")[0] ?? token;
  }
  if (!index) return null;
  const exact = index.nameToCharId[token];
  if (exact) return exact;
  // alias 兜底：干员密录等场景会传 `char_{num}_{alias}` 的 alias 部分
  // （如 `kroos`、`amgoat`）。按 index 快照动态构造反向表并缓存，
  // 避免每次都 O(N) 扫描。
  const aliasMap = getAliasMap(index);
  return aliasMap.get(token.toLowerCase()) ?? null;
}

// 按 CharacterIndex 快照缓存 alias→charId 反向表。index 在启动时稳定，
// 同一个对象引用拿到的都是同一份 Map，不会重复构造。
const aliasMapCache = new WeakMap<CharacterIndex, Map<string, string>>();
function getAliasMap(index: CharacterIndex): Map<string, string> {
  const hit = aliasMapCache.get(index);
  if (hit) return hit;
  const map = new Map<string, string>();
  for (const cid of Object.keys(index.charIdToName ?? {})) {
    const m = cid.match(/^char_\d+_(.+?)(?:#.*)?$/);
    if (!m) continue;
    const alias = m[1].toLowerCase();
    if (!map.has(alias)) map.set(alias, cid);
  }
  aliasMapCache.set(index, map);
  return map;
}

function avatarCandidates(token: string, index: CharacterIndex | null): string[] {
  // 优先检查 NPC 头像覆盖表（这些角色没有 char_ ID）
  if (NPC_AVATAR_OVERRIDES[token]) {
    return NPC_AVATAR_OVERRIDES[token];
  }
  const cid = resolveCharId(token, index);
  if (!cid) return [];
  return [
    `${YUANYAN}/avatar/${cid}.png`,
    `${FEXLI}/charpor/${cid}.png`,
    `${PUPPIIZ}/avatars/${cid}.png`,
  ];
}

function portraitCandidates(token: string, index: CharacterIndex | null): string[] {
  // NPC 立绘覆盖：使用 wiki 全尺寸图
  if (NPC_AVATAR_OVERRIDES[token]) {
    // 立绘用全尺寸图（第二条 URL）
    return NPC_AVATAR_OVERRIDES[token].slice().reverse();
  }
  const cid = resolveCharId(token, index);
  if (!cid) return [];
  // 精二立绘优先（`_2`），没有时回落到精一（`_1`）。少数干员（3 星及
  // 以下或仅作为剧情 NPC 的）没有精二素材，不做强制匹配。
  return [
    `${YUANYAN}/portrait/${cid}_2.png`,
    `${FEXLI}/charpack/${cid}_2.png`,
    `${PUPPIIZ}/characters/${cid}_2.png`,
    `${YUANYAN}/portrait/${cid}_1.png`,
    `${YUANYAN}/portrait/${cid}_1b.png`,
    `${FEXLI}/charpack/${cid}_1.png`,
    `${PUPPIIZ}/characters/${cid}_1.png`,
  ];
}

function avgCandidates(token: string): string[] {
  const t = token.replace(/^\$/, "");
  return [
    `${FEXLI}/avgs/${t}.png`,
    `${FEXLI}/avgs/bg/${t}.png`,
    `${PUPPIIZ}/storyline/images/${t}.png`,
  ];
}

function backgroundCandidates(token: string): string[] {
  const t = token.replace(/^\$/, "");
  // fexli 仓库里大多数背景其实在 `avgs/bg/<token>.png` 子目录，少部分老的在
  // `avgs/<token>.png` 根目录。两条路径都列出来，谁先 200 就用谁。
  return [
    `${FEXLI}/avgs/bg/${t}.png`,
    `${FEXLI}/avgs/${t}.png`,
    `${PUPPIIZ}/storyline/backgrounds/${t}.png`,
  ];
}

function stripActPrefix(token: string): string {
  let core = token;
  if (core.startsWith("act_")) core = core.slice(4);
  else if (core.startsWith("act")) core = core.slice(3);
  core = core.replace(/^\d+/, "");
  if (core.endsWith("side")) core = core.slice(0, -4);
  if (core.endsWith("mini")) core = core.slice(0, -4);
  return core;
}

function activityKvCandidates(token: string): string[] {
  const core = stripActPrefix(token);
  return [
    `${FEXLI}/kvimg/default_kv_${core}.png`,
    `${FEXLI}/kvimg/kv_${core}1.png`,
    `${FEXLI}/kvimg/kv_${core}.png`,
  ];
}

function activityLogoCandidates(token: string): string[] {
  const core = stripActPrefix(token);
  return [
    `${FEXLI}/kvimg/brand_${core}.png`,
    `${FEXLI}/camplogo/logo_${core}.png`,
  ];
}

function chapterCoverCandidates(token: string): string[] {
  // `token` 通常是 `main_0`、`main_8`、`main_13`。
  const raw = token.replace(/^main_/, "").trim();
  const nn = /^\d+$/.test(raw) ? raw.padStart(2, "0") : raw;
  return [
    `${FEXLI}/mapreview/main_${nn}-01.png`,
    `${FEXLI}/avgs/bg_main_${raw}.png`,
    `${FEXLI}/avgs/${raw}_i01.png`,
    `${FEXLI}/avgs/${raw}_I01.png`,
  ];
}

export function resolveAssetCandidatesLocal(
  kind: AssetKind,
  token: string,
  index: CharacterIndex | null
): string[] {
  const t = token.trim();
  if (!t) return [];
  switch (kind) {
    case "avatar":
      return avatarCandidates(t, index);
    case "portrait":
      return portraitCandidates(t, index);
    case "image":
      return avgCandidates(t);
    case "background":
      return backgroundCandidates(t);
    case "activity_kv":
      return activityKvCandidates(t);
    case "activity_logo":
      return activityLogoCandidates(t);
    case "chapter_cover":
      return chapterCoverCandidates(t);
    default:
      return [];
  }
}
