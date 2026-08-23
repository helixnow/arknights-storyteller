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
    // 内置头像（打包在 public/bundled/avatar/，无网络开销）
    `/bundled/avatar/${cid}.png`,
    `${YUANYAN}/avatar/${cid}.png`,
    `${FEXLI}/charpor/${cid}.png`,
    `${PUPPIIZ}/avatars/${cid}.png`,
  ];
}

function portraitCandidates(token: string, index: CharacterIndex | null): string[] {
  // NPC 没有 char_ ID，也就没有精二/精一立绘，只能复用覆盖表里那张图。
  if (NPC_AVATAR_OVERRIDES[token]) {
    return NPC_AVATAR_OVERRIDES[token];
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

/**
 * 从活动 id 里猜 KV 素材名的核心部分：`act17side` → `side` 之类。
 * 猜错（削成空串，或压根没削掉东西）时返回 null，调用方就只用原始 token。
 */
function stripActPrefix(token: string): string | null {
  let core = token;
  if (core.startsWith("act_")) core = core.slice(4);
  else if (core.startsWith("act")) core = core.slice(3);
  core = core.replace(/^\d+/, "");
  if (core.endsWith("side")) core = core.slice(0, -4);
  if (core.endsWith("mini")) core = core.slice(0, -4);
  if (!core || core === token) return null;
  return core;
}

function activityKvCandidates(token: string): string[] {
  // token 可能已经是 story_review_table 给的图片名（`storyPic` /
  // `storyEntryPicId`，形如 `act17side_entrypic` / `xxx_storyMainPic`），
  // 这种情况下再去剥 `act` 前缀只会把它削坏，所以原始 token 永远排在最前。
  const base = token.replace(/\.(png|jpg|jpeg|webp)$/i, "");
  const urls = [
    `${FEXLI}/kvimg/${base}.png`,
    `${FEXLI}/kvimg/default_kv_${base}.png`,
    `${FEXLI}/kvimg/kv_${base}.png`,
  ];
  // 旧的启发式猜测保留作兜底。
  const core = stripActPrefix(base);
  if (core) {
    urls.push(
      `${FEXLI}/kvimg/default_kv_${core}.png`,
      `${FEXLI}/kvimg/kv_${core}1.png`,
      `${FEXLI}/kvimg/kv_${core}.png`
    );
  }
  return Array.from(new Set(urls));
}

function activityLogoCandidates(token: string): string[] {
  const base = token.replace(/\.(png|jpg|jpeg|webp)$/i, "");
  const urls = [
    `${FEXLI}/kvimg/brand_${base}.png`,
    `${FEXLI}/camplogo/logo_${base}.png`,
  ];
  const core = stripActPrefix(base);
  if (core) {
    urls.push(
      `${FEXLI}/kvimg/brand_${core}.png`,
      `${FEXLI}/camplogo/logo_${core}.png`
    );
  }
  return Array.from(new Set(urls));
}

function chapterCoverCandidates(token: string): string[] {
  // `token` 通常是 `main_0`、`main_8`、`main_13`。
  const raw = token.replace(/^main_/, "").trim();
  const nn = /^\d+$/.test(raw) ? raw.padStart(2, "0") : raw;
  return Array.from(
    new Set([
      // 内置章节封面（打包在 public/bundled/mapreview/）
      `/bundled/mapreview/main_${nn}-01.png`,
      `${FEXLI}/mapreview/main_${nn}-01.png`,
      `${FEXLI}/avgs/bg_main_${raw}.png`,
      `${FEXLI}/avgs/${raw}_i01.png`,
      `${FEXLI}/avgs/${raw}_I01.png`,
    ])
  );
}

// ─────────────────────────────────────────────────────────────
// Session 级候选健康度
//
// `<AssetImage>` 与 `<StoryThumbnail>` 共用同一份失败记录，否则同一张
// 404 的封面会在两条渲染路径上各失败一次。
// ─────────────────────────────────────────────────────────────

/** 本进程内已确认加载失败的具体 URL。 */
const deadUrls = new Set<string>();

/** 至少成功返回过一张图的 host。这类 host 永不熔断。 */
const provenHosts = new Set<string>();

interface HostStrike {
  /** 自上次成功以来的连续失败次数。 */
  failures: number;
  /** 熔断到期时间戳（ms）；0 表示未熔断。 */
  blockedUntil: number;
  /** 已熔断次数，用于指数退避。 */
  strikes: number;
}

const hostStrikes = new Map<string, HostStrike>();

/**
 * 熔断阈值。一张活动卡最多会串行试 3–7 条 URL，所以阈值取得比单张卡的
 * 候选数高一截：只有「这个域名从头到尾没成功过」才会触发，正常网络下
 * 命中一次就把 host 标成 proven，之后再多 404 也不会误伤。
 */
const HOST_FAILURE_THRESHOLD = 8;
const HOST_BLOCK_BASE_MS = 30_000;
const HOST_BLOCK_MAX_MS = 10 * 60_000;

/** 取 URL 的 host。相对路径（`/bundled/...`）返回 null —— 本地素材不熔断。 */
function hostOf(url: string): string | null {
  const schemeEnd = url.indexOf("://");
  if (schemeEnd < 0) return null;
  const start = schemeEnd + 3;
  const end = url.indexOf("/", start);
  const host = end < 0 ? url.slice(start) : url.slice(start, end);
  return host || null;
}

/**
 * 这条 URL 现在还值不值得请求。除了 URL 自身失败过，还包括「所属 host
 * 正在熔断窗口内」——断网 / GitHub Raw 被墙时，这一条能把每张卡省下的
 * 3–7 次必失败请求直接抹掉。
 */
export function isAssetUrlDead(url: string): boolean {
  if (deadUrls.has(url)) return true;
  const host = hostOf(url);
  if (!host || provenHosts.has(host)) return false;
  const strike = hostStrikes.get(host);
  return strike !== undefined && strike.blockedUntil > Date.now();
}

/** 记一次加载失败，必要时熔断整个 host。 */
export function markAssetUrlDead(url: string): void {
  deadUrls.add(url);
  const host = hostOf(url);
  if (!host || provenHosts.has(host)) return;
  const strike = hostStrikes.get(host) ?? { failures: 0, blockedUntil: 0, strikes: 0 };
  strike.failures += 1;
  if (strike.failures >= HOST_FAILURE_THRESHOLD) {
    strike.failures = 0;
    strike.strikes += 1;
    strike.blockedUntil =
      Date.now() + Math.min(HOST_BLOCK_BASE_MS * 2 ** (strike.strikes - 1), HOST_BLOCK_MAX_MS);
  }
  hostStrikes.set(host, strike);
}

/**
 * 记一次加载成功。host 一旦证明可达就永久免疫熔断——后续的 404 都是
 * 「这个素材不存在」而不是「这个源挂了」，不该再连坐。
 */
export function markAssetUrlAlive(url: string): void {
  const host = hostOf(url);
  if (!host) return;
  provenHosts.add(host);
  hostStrikes.delete(host);
}

/**
 * 从 `from` 开始找第一条还值得试的候选。返回命中的下标，方便调用方把
 * 游标推到它后面继续 fallback。
 */
export function pickLiveCandidate(
  candidates: string[],
  from = 0
): { url: string; index: number } | null {
  for (let i = Math.max(0, from); i < candidates.length; i += 1) {
    const url = candidates[i];
    if (!isAssetUrlDead(url)) return { url, index: i };
  }
  return null;
}

/** 素材兜底色块的 hue。同一 seed 在任何组件里都得到同一个颜色。 */
export function hashHue(input: string): number {
  let h = 0;
  for (let i = 0; i < input.length; i += 1) {
    h = (h * 31 + input.charCodeAt(i)) >>> 0;
  }
  return h % 360;
}

/** 素材兜底色块的 CSS `background`，AssetImage / StoryThumbnail 共用。 */
export function gradientFallbackBackground(seed: string): string {
  const hue = hashHue(seed || "ark");
  return `linear-gradient(135deg, hsl(${hue} 26% 46% / 0.32), hsl(${
    (hue + 40) % 360
  } 32% 36% / 0.28))`;
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
