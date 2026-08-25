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

/**
 * 从普通对象里安全取字符串值。剧情脚本里的说话人名字直接当 key 用，
 * 碰上 `constructor` / `toString` 这类名字时 `obj[key]` 会摸到原型链上的
 * 函数，下游把它当 URL 拼进 `<img src>`。只认自有属性 + 字符串值。
 */
function ownString(
  table: Record<string, string> | null | undefined,
  key: string
): string | null {
  if (!table) return null;
  if (!Object.prototype.hasOwnProperty.call(table, key)) return null;
  const value = table[key];
  return typeof value === "string" && value ? value : null;
}

function npcOverride(token: string): string[] | null {
  if (!Object.prototype.hasOwnProperty.call(NPC_AVATAR_OVERRIDES, token)) return null;
  const urls = NPC_AVATAR_OVERRIDES[token];
  return Array.isArray(urls) && urls.length > 0 ? urls : null;
}

/**
 * 这个名字（修剪空白后）是否命中 NPC 头像覆盖表。
 *
 * 给 `<CharacterAvatar>` 用：覆盖表里的名字不在干员表中（character_table
 * 的测试钉死了这一点），所以随台词一起传来的 `char_` id 只可能是解析器
 * 「只写显示名就继承上一条 [Character] 立绘」的启发式带来的别人的 id。
 * 命中覆盖表时显示名才是权威身份，charId 必须让位。
 */
export function hasNpcAvatarOverride(name: string | null | undefined): boolean {
  if (!name) return false;
  return npcOverride(name.trim()) !== null;
}

/**
 * 分享图等非 React 渲染路径使用的头像身份键。
 *
 * 同一个角色在剧情里可能先显示「？？？」、之后才显示真名，或携带不同的
 * `#skin` 后缀；只要 `char_` id 相同，最终请求的就是同一组头像候选。身份
 * 键因此优先使用规范化 id，避免重复下载、解码同一张图。NPC 覆盖名仍然
 * 优先，因为它们随行的 charId 可能是解析器继承来的上一位干员。
 */
export function characterAvatarIdentityKey(
  name: string | null | undefined,
  charId: string | null | undefined
): string {
  const cleanName = (name ?? "").trim();
  if (npcOverride(cleanName)) return `npc:${cleanName}`;

  const directId = charId ? directCharacterId(charId) : null;
  if (directId) return `char:${directId}`;

  // 非 char_ alias 只有和显示名一起才能安全确定身份：未知 alias 可能被
  // 多位角色共用，实际候选会回退到 name，不能只按 alias 合并。
  const cleanAlias = (charId ?? "").trim().split("#", 1)[0]?.toLowerCase() ?? "";
  return `name:${simplifyCharacterToken(cleanName)}::alias:${cleanAlias}`;
}

export interface CharacterResolverSnapshot {
  hasIndex: boolean;
  resolveCharId: (name: string | null | undefined) => string | null;
  resolveName: (charId: string | null | undefined) => string | null;
}

/**
 * 名字侧的宽松匹配键。中文不受 lower-case 影响；英文代号 / appellation
 * 因而也能大小写不敏感。只去掉项目里约定的分隔符，不吞普通标点，避免把
 * 两个本来不同的显示名过度合并。
 */
function simplifyCharacterToken(value: string): string {
  return value.trim().toLowerCase().replace(/[\s·‧•・]+/g, "");
}

/** 只归一化真正的 `char_` token；普通显示名返回 null。 */
function directCharacterId(token: string): string | null {
  const base = token.trim().split("#", 1)[0] ?? "";
  if (!/^char_/i.test(base)) return null;
  // 游戏数据里的 charId 是 ASCII 小写。路径前缀在数据侧没有大小写承诺，
  // `Obt/Memory/CHAR_002_AMIYA/...` 必须和小写路径得到同一个素材 URL。
  return base.toLowerCase();
}

/**
 * CharacterIndex 快照对应的纯解析器。Provider 与素材 URL 解析必须共用同一
 * 套规则，否则人物卡能认出的密录 alias 到分享图里又会变成无头像。
 *
 * WeakMap 让同一份后端快照只建一次反向表；数据换包会给出新对象，自然得到
 * 全新 overlay，不会把旧包的 alias / 显示名混进来。
 */
const characterResolverCache = new WeakMap<CharacterIndex, CharacterResolverSnapshot>();

export function createCharacterResolver(index: CharacterIndex): CharacterResolverSnapshot {
  const cached = characterResolverCache.get(index);
  if (cached) return cached;

  const nameMap = index.nameToCharId ?? {};
  const idMap = index.charIdToName ?? {};
  const hasIndex = Object.keys(nameMap).length > 0 || Object.keys(idMap).length > 0;
  const canonicalIdByLower = new Map<string, string>();
  const idLookupKeyByLower = new Map<string, string>();
  const aliasMap = new Map<string, string>();
  const simplifiedNameMap = new Map<string, string>();

  for (const cid of Object.keys(idMap)) {
    const base = cid.split("#", 1)[0]?.trim();
    if (!base || !/^char_/i.test(base)) continue;
    const canonical = base.toLowerCase();
    if (!canonicalIdByLower.has(canonical)) canonicalIdByLower.set(canonical, canonical);
    if (!idLookupKeyByLower.has(canonical)) idLookupKeyByLower.set(canonical, cid);
    const match = canonical.match(/^char_\d+_(.+)$/);
    if (match && !aliasMap.has(match[1])) aliasMap.set(match[1], canonical);
  }

  const normalizeMappedId = (raw: string): string => {
    const base = raw.trim().split("#", 1)[0] ?? raw.trim();
    const direct = directCharacterId(base);
    if (!direct) return base;
    return canonicalIdByLower.get(direct) ?? direct;
  };

  for (const [name, cid] of Object.entries(nameMap)) {
    if (typeof cid !== "string" || !cid.trim()) continue;
    const key = simplifyCharacterToken(name);
    if (key && !simplifiedNameMap.has(key)) {
      simplifiedNameMap.set(key, normalizeMappedId(cid));
    }
  }

  const resolvedIds = new Map<string, string | null>();
  const resolvedNames = new Map<string, string | null>();

  const resolveCharId = (name: string | null | undefined): string | null => {
    if (!name) return null;
    const trimmed = name.trim();
    if (!trimmed) return null;
    if (resolvedIds.has(trimmed)) return resolvedIds.get(trimmed) ?? null;

    const direct = directCharacterId(trimmed);
    const exact = ownString(nameMap, trimmed);
    const out =
      (direct ? canonicalIdByLower.get(direct) ?? direct : null) ??
      (exact ? normalizeMappedId(exact) : null) ??
      simplifiedNameMap.get(simplifyCharacterToken(trimmed)) ??
      aliasMap.get(trimmed.toLowerCase()) ??
      null;
    resolvedIds.set(trimmed, out);
    return out;
  };

  const resolveName = (charId: string | null | undefined): string | null => {
    if (!charId) return null;
    const trimmed = charId.trim();
    if (!trimmed) return null;
    if (resolvedNames.has(trimmed)) return resolvedNames.get(trimmed) ?? null;
    const direct = directCharacterId(trimmed);
    const canonical = direct ? canonicalIdByLower.get(direct) ?? direct : null;
    const lookupKey = canonical ? idLookupKeyByLower.get(canonical) ?? canonical : null;
    const out = lookupKey ? ownString(idMap, lookupKey) : null;
    resolvedNames.set(trimmed, out);
    return out;
  };

  const snapshot = { hasIndex, resolveCharId, resolveName };
  characterResolverCache.set(index, snapshot);
  return snapshot;
}

/** 不建 React context 时也能复用的单次 charId 解析。 */
export function resolveCharacterIdLocal(
  token: string,
  index: CharacterIndex | null
): string | null {
  const direct = directCharacterId(token);
  if (direct) {
    return index ? createCharacterResolver(index).resolveCharId(direct) : direct;
  }
  return index ? createCharacterResolver(index).resolveCharId(token) : null;
}

function resolveCharId(token: string, index: CharacterIndex | null): string | null {
  return resolveCharacterIdLocal(token, index);
}

function avatarCandidates(token: string, index: CharacterIndex | null): string[] {
  // 优先检查 NPC 头像覆盖表（这些角色没有 char_ ID）
  const override = npcOverride(token);
  if (override) return override;
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
  const override = npcOverride(token);
  if (override) return override;
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
      `${FEXLI}/mapreview/main_${nn}-01.png`,
      `${FEXLI}/avgs/bg_main_${raw}.png`,
      `${FEXLI}/avgs/${raw}_i01.png`,
      `${FEXLI}/avgs/${raw}_I01.png`,
    ])
  );
}

/**
 * 一次图片请求发出时的网络快照。`onlineVersion` 由调用方维护：每收到一次
 * `online` 事件就递增，用来识别「请求在途期间经历过网络恢复」。
 */
export interface AssetIssueNetSnapshot {
  url: string | null;
  version: number;
  offline: boolean;
}

/**
 * 这次 onerror 是否属于离线余波。发出时已离线，或发出后经历过 online
 * 事件，都不能当成可靠 404。保持纯函数，普通 `<img>` 与 Canvas 头像加载
 * 共用同一条判定，也便于不依赖 DOM 地回归测试。
 */
export function isStaleOfflineAssetError(
  issue: AssetIssueNetSnapshot | null,
  failedUrl: string,
  currentOnlineVersion: number
): boolean {
  return (
    issue !== null &&
    issue.url === failedUrl &&
    (issue.offline || issue.version !== currentOnlineVersion)
  );
}

export type AssetRecoveryAction = "none" | "observe" | "defer" | "retry";

/**
 * 判定组件该如何消费一次恢复版本变化（`online` 或素材健康度）。
 *
 * 恢复可能发生在候选仍在途时，此时必须先保留通知。若当前候选成功，调用方
 * 会清掉 `recoveryPending`，下次渲染只需 observe；若它仍然 404 并最终
 * stuck，则用同一次已发生的恢复把游标拨回开头，重试恢复后重新可用的候选。
 */
export function getAssetRecoveryAction(
  observedVersion: number,
  currentVersion: number,
  stuck: boolean,
  recoveryPending: boolean
): AssetRecoveryAction {
  if (observedVersion === currentVersion) return "none";
  if (!recoveryPending) return "observe";
  return stuck ? "retry" : "defer";
}

// ─────────────────────────────────────────────────────────────
// Session 级候选健康度
//
// `<AssetImage>` 与 `<StoryThumbnail>` 共用同一份失败记录，否则同一张
// 404 的封面会在两条渲染路径上各失败一次。
// ─────────────────────────────────────────────────────────────

/**
 * 本进程内已确认加载失败的具体 URL。素材 404 是永久事实（镜像仓库不会
 * 凭空长出图），所以只记不删；但长会话里翻遍全部剧情也可能攒到上万条，
 * 到顶后按插入顺序丢掉最老的一批。
 */
const deadUrls = new Set<string>();
const DEAD_URL_LIMIT = 8000;
const DEAD_URL_EVICT = 2000;

/** 至少成功返回过一张图的 host。这类 host 永不熔断。 */
const provenHosts = new Set<string>();

interface HostStrike {
  /** 观察窗口内的失败次数。 */
  failures: number;
  /** 窗口内最后一次失败的时间戳（ms）。 */
  lastFailureAt: number;
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
/**
 * 失败计数的观察窗口。断网时几十张卡会在同一秒内集体失败，这正是要熔断的
 * 场景；而「翻了半小时剧情、零散撞上 8 张缺图」不是——超过窗口就重新计数，
 * 否则一个健康但素材不全的镜像迟早会被误伤。
 */
const HOST_FAILURE_WINDOW_MS = 15_000;
/** 熔断窗口结束后再安静这么久，就把指数退避的档位清零。 */
const HOST_STRIKE_DECAY_MS = 5 * 60_000;

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
  return hostBlockedUntil(url) > Date.now();
}

/** host 的熔断到期时间；未熔断（或本地素材 / 已证明可达）返回 0。 */
function hostBlockedUntil(url: string): number {
  const host = hostOf(url);
  if (!host || provenHosts.has(host)) return 0;
  return hostStrikes.get(host)?.blockedUntil ?? 0;
}

/** 记一次加载失败，必要时熔断整个 host。 */
export function markAssetUrlDead(url: string): void {
  // 同一条 URL 只计一次账。一张封面同时出现在列表缩略图和卡片背景里，
  // 两条渲染路径会各报一次 error；重复计数会让阈值形同虚设。
  if (deadUrls.has(url)) return;
  if (deadUrls.size >= DEAD_URL_LIMIT) evictOldestDeadUrls();
  deadUrls.add(url);

  const host = hostOf(url);
  if (!host || provenHosts.has(host)) return;
  const now = Date.now();
  const strike = hostStrikes.get(host) ?? {
    failures: 0,
    lastFailureAt: 0,
    blockedUntil: 0,
    strikes: 0,
  };
  // 熔断窗口内到达的失败只可能来自窗口开启前就已在途的请求——熔断一旦
  // 生效，pickLiveCandidate 不会再放新请求出门。这些 onerror 是同一次
  // 断网的余波，不是新一轮证据：URL 级的账（上面）照记，host 级计数就此
  // 打住。否则一屏在途图片的失败会把同一次故障连升好几档退避（每 8 条
  // 余波 strikes +1），首次 30s 的熔断瞬间膨胀成几分钟，而真正的升档
  // 本该留给「窗口到期重试后仍然全灭」的下一轮。
  if (strike.blockedUntil > now) return;
  // 窗口外的旧账不参与判定，零散 404 攒不出熔断。
  if (now - strike.lastFailureAt > HOST_FAILURE_WINDOW_MS) strike.failures = 0;
  if (strike.blockedUntil && now - strike.blockedUntil > HOST_STRIKE_DECAY_MS) strike.strikes = 0;
  strike.failures += 1;
  strike.lastFailureAt = now;
  hostStrikes.set(host, strike);

  if (strike.failures >= HOST_FAILURE_THRESHOLD) {
    strike.failures = 0;
    strike.strikes += 1;
    strike.blockedUntil =
      now + Math.min(HOST_BLOCK_BASE_MS * 2 ** (strike.strikes - 1), HOST_BLOCK_MAX_MS);
    // 熔断窗口结束时叫醒还在显示兜底色块的组件，让它们再试一次；
    // 否则一次断网会把已挂载的卡片永久钉死在渐变上。
    scheduleHealthNotice(strike.blockedUntil);
  }
}

/** Set 保持插入顺序，直接从头删就是「最早记录的失败」。 */
function evictOldestDeadUrls() {
  let removed = 0;
  for (const url of deadUrls) {
    deadUrls.delete(url);
    removed += 1;
    if (removed >= DEAD_URL_EVICT) break;
  }
}

/**
 * 记一次加载成功。host 一旦证明可达就永久免疫熔断——后续的 404 都是
 * 「这个素材不存在」而不是「这个源挂了」，不该再连坐。
 */
export function markAssetUrlAlive(url: string): void {
  const host = hostOf(url);
  if (!host) return;
  if (provenHosts.has(host)) return;
  provenHosts.add(host);
  const previousStrike = hostStrikes.get(host);
  hostStrikes.delete(host);
  // 撤销这个 host 在「尚未证明可达」期间记下的 URL 级失败：断网/被墙时
  // img.onerror 与真 404 无法区分，那些判决不可靠。不撤销的话，断网期间
  // 打开过的头像/封面会在网络恢复后仍被 deadUrls 永久跳过，直到重启。
  // 此后（host 已 proven）再失败的才是真 404，照旧永久记账。
  for (const dead of deadUrls) {
    if (hostOf(dead) === host) deadUrls.delete(dead);
  }
  // 若这个 host 原本正占着共享闹钟，证明可达后旧闹钟已经没有意义；立即按
  // 剩余 host 重排。否则 30 秒后还会多广播一次“恢复”，几百张兜底图会被
  // 无缘无故叫醒重扫。
  //
  // 只在它确实是“当前最早闹钟”的目标时重排。普通 first-alive（host 从未
  // 熔断）若也全表重扫，系统时钟回拨后可能把历史 blockedUntil 当成未来
  // 窗口、凭空复活一只长定时器。
  if (
    previousStrike &&
    previousStrike.blockedUntil > Date.now() &&
    healthTimer !== null &&
    healthTimerAt === previousStrike.blockedUntil
  ) {
    rescheduleNextHostWake();
  }
  // 这个源刚被证明可达：之前因它熔断而放弃的候选现在值得重试。
  notifyAssetHealth();
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

/**
 * 候选全被跳过时，判断这是「暂时的」还是「已经没救了」：只要还有一条
 * URL 本身没失败过、仅仅是所属 host 在熔断窗口内，就还有翻盘机会。
 * 调用方据此决定是订阅健康事件等待重试，还是直接报告 exhausted。
 */
export function hasRecoverableCandidate(candidates: string[], from = 0): boolean {
  const now = Date.now();
  for (let i = Math.max(0, from); i < candidates.length; i += 1) {
    const url = candidates[i];
    if (deadUrls.has(url)) continue;
    if (hostBlockedUntil(url) > now) return true;
  }
  return false;
}

// ─────────────────────────────────────────────────────────────
// 健康度变更广播
//
// 熔断窗口到期 / 某个源首次被证明可达时，界面上那些已经退化成渐变兜底的
// 组件需要一次重试机会。用一个共享的订阅表 + 一个共享定时器，而不是每个
// 组件各自 setTimeout —— 一屏几百张卡时后者会排出几百个定时器。
// ─────────────────────────────────────────────────────────────

const healthSubscribers = new Set<() => void>();
let healthVersion = 0;
let healthTimer: ReturnType<typeof setTimeout> | null = null;
let healthTimerAt = 0;

function notifyAssetHealth() {
  healthVersion += 1;
  healthSubscribers.forEach((notify) => {
    try {
      notify();
    } catch {}
  });
}

function scheduleHealthNotice(at: number) {
  // 已经有一个更早（或同时）的唤醒计划就不必重排。
  if (healthTimer !== null && healthTimerAt <= at) return;
  if (healthTimer !== null) clearTimeout(healthTimer);
  healthTimerAt = at;
  healthTimer = setTimeout(() => {
    healthTimer = null;
    healthTimerAt = 0;
    notifyAssetHealth();
    scheduleNextHostWake();
  }, Math.max(0, at - Date.now()) + 50);
}

/**
 * 定时器一次只记得住一个最早的唤醒时刻，多个 host 的熔断到期时间不同时
 * （指数退避下必然如此），较晚那些的唤醒计划会被 `scheduleHealthNotice`
 * 的去重丢掉。所以每次唤醒触发后重扫一遍 strike 表，为下一个仍在熔断中
 * 的 host 续排闹钟——否则候选全落在较晚 host 上的组件会一直订阅健康事件
 * 却永远等不到通知，卡在渐变兜底上。
 */
function scheduleNextHostWake() {
  const now = Date.now();
  let next = Infinity;
  for (const strike of hostStrikes.values()) {
    if (strike.blockedUntil > now && strike.blockedUntil < next) {
      next = strike.blockedUntil;
    }
  }
  if (next !== Infinity) scheduleHealthNotice(next);
}

/** 清掉已经失去目标的共享闹钟，再从当前 strike 表选择真正最早的到期点。 */
function rescheduleNextHostWake() {
  if (healthTimer !== null) clearTimeout(healthTimer);
  healthTimer = null;
  healthTimerAt = 0;
  scheduleNextHostWake();
}

/** 订阅「候选健康度可能变好了」事件。返回取消订阅函数。 */
export function subscribeAssetHealth(onChange: () => void): () => void {
  healthSubscribers.add(onChange);
  return () => {
    healthSubscribers.delete(onChange);
  };
}

/** 供 `useSyncExternalStore` 用的快照。 */
export function getAssetHealthVersion(): number {
  return healthVersion;
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
