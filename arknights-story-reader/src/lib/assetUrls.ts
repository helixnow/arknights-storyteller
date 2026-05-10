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

function resolveCharId(token: string, index: CharacterIndex | null): string | null {
  if (token.startsWith("char_")) {
    return token.split("#")[0] ?? token;
  }
  if (!index) return null;
  return index.nameToCharId[token] ?? null;
}

function avatarCandidates(token: string, index: CharacterIndex | null): string[] {
  const cid = resolveCharId(token, index);
  if (!cid) return [];
  return [
    `${YUANYAN}/avatar/${cid}.png`,
    `${FEXLI}/charpor/${cid}.png`,
    `${PUPPIIZ}/avatars/${cid}.png`,
  ];
}

function portraitCandidates(token: string, index: CharacterIndex | null): string[] {
  const cid = resolveCharId(token, index);
  if (!cid) return [];
  return [
    `${YUANYAN}/portrait/${cid}_1.png`,
    `${YUANYAN}/portrait/${cid}_1b.png`,
    `${FEXLI}/charpack/${cid}_1.png`,
    `${PUPPIIZ}/characters/${cid}_1.png`,
  ];
}

function avgCandidates(token: string): string[] {
  const t = token.replace(/^\$/, "");
  return [`${FEXLI}/avgs/${t}.png`, `${PUPPIIZ}/storyline/images/${t}.png`];
}

function backgroundCandidates(token: string): string[] {
  const t = token.replace(/^\$/, "");
  return [`${FEXLI}/avgs/${t}.png`, `${PUPPIIZ}/storyline/backgrounds/${t}.png`];
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
  const t = token.replace(/^main_/, "");
  return [
    `${FEXLI}/avgs/bg_main_${t}.png`,
    `${FEXLI}/avgs/${t}_i01.png`,
    `${FEXLI}/avgs/${t}_I01.png`,
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
