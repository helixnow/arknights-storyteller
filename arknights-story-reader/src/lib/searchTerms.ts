/**
 * 搜索查询串的纯函数工具。
 *
 * 从 SearchPanel 抽出来的纯逻辑必须能脱离 React 用 node:test 直接锁行为：
 * 查询词解析要与后端的 `-排除`、`NOT`、`OR`/`AND`、`"短语"` 语法一致，
 * 缓存版本则只能接受后端正常同步产生的 commit 缩写。
 */

/**
 * 正向内容不足两个原子不自动搜：中文单字命中面太大，等于把整库拉一遍。
 * 量的是「能落进索引的原子数」而不是原始串长度——`凯。`、`"凯"`、`a.`
 * 检索内容都只有一个原子，标点撑起来的长度不算数；Ext-B 单字（代理对）
 * 也只算一个原子，不因 UTF-16 占两位而放行。
 */
export const AUTO_SEARCH_MIN_LEN = 2;

/** 高亮词上限：去重后仍超长的查询只取前几个，避免拼出超长正则。 */
export const MAX_HIGHLIGHT_TERMS = 12;

/**
 * 必须与 Rust `data_service.rs::INDEX_VERSION` 同步。搜索缓存的 namespace
 * 会带上这个版本：索引语料/解析语义升级但数据 commit 不变时，旧结果也
 * 必须失效，不能继续以当前 commit 的名义命中。
 */
export const SEARCH_INDEX_VERSION = 10;

/**
 * 与后端 Rust `char::is_whitespace`（Unicode White_Space 属性）逐字对齐的
 * 切词空白集，不能用 JS 的 `\s`：`\s` 比 White_Space 多收 U+FEFF（BOM，
 * 粘贴文本常见）、少收 U+0085（NEL）。差一个字符就会翻转 NOT 极性。
 */
const QUERY_WHITESPACE_RE =
  /[\t\n\v\f\r \u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]/;

/** Rust `str::trim` 同款修边；刻意不把 U+FEFF 当空白。 */
export function trimSearchQuery(raw: string): string {
  const chars = Array.from(raw);
  let start = 0;
  let end = chars.length;
  while (start < end && QUERY_WHITESPACE_RE.test(chars[start])) start += 1;
  while (end > start && QUERY_WHITESPACE_RE.test(chars[end - 1])) end -= 1;
  return chars.slice(start, end).join("");
}

/**
 * 与后端 `normalize_nfkc_lower_strip_marks` 的 NFKC 一步对齐：后端解析
 * 查询前先整体折叠兼容形，全角 `ＮＯＴ`／`－`／`＂` 因此与半角同义
 * （Rust 侧有 `fts_query_fullwidth_minus_is_negation` 等测试钉着）。
 * 前端若在原始文本上判定，全角写法下用户明确排除的词会被当成正向词
 * 高亮成"命中"。只做 NFKC、不小写化也不去组合符：连接词正则本就带
 * `i`，而高亮词最终要拿去匹配未归一化的原文——把 café 折成 cafe
 * 反而会让本来能命中的高亮失配。
 */
function normalizeQuery(raw: string): string {
  // 后端顺序是 raw.trim() → NFKC。先按同一空白集修边，不能用 JS trim：
  // 它会擅自删掉后端视为正文的 U+FEFF。
  return trimSearchQuery(raw).normalize("NFKC");
}

/**
 * `get_current_version` 的正常同步版本固定以 7 位十六进制 commit 缩写开头，
 * 后面才是会随时间变化的相对日期。只有这个头部能证明缓存属于哪份数据。
 *
 * `manual-`（所有手动导入经后端截短后都相同）、`unknown`、CJK 状态文案，
 * 以及手改 version.json 产生的任意 ASCII 文本都没有数据身份，必须折成空串，
 * 让调用方停用缓存；loadCacheMap 也据此丢弃历史假版本条目。
 */
export function stableVersionOf(version: string): string {
  // 内存/落盘缓存保存的是纯 commit；后端原始返回则严格是
  // `<commit> (<相对时间>)`。不能只 split 第一段，否则
  // `abcdef1 arbitrary-text` 这种手改版本也会被误认成数据身份。
  const match = /^([0-9a-f]{7})(?:$| \([^()\r\n]*\))$/i.exec(version);
  return match?.[1] ?? "";
}

/** 只有状态查询明确报 ready、且当前没有重建，搜索结果才具备索引可信度。 */
export function isSearchIndexTrusted(
  status: { ready: boolean } | null,
  buildingIndex: boolean
): boolean {
  return status?.ready === true && !buildingIndex;
}

/**
 * 零命中播报必须和可见空态共用同一套三分法。尤其 `status == null` 只表示
 * 状态尚未确认，不能借 `!indexReady` 把它说成“索引还没建好”。
 */
export function searchEmptyAnnouncement(
  status: { ready: boolean } | null,
  buildingIndex: boolean
): string {
  if (status == null && !buildingIndex) return "正在确认索引状态";
  if (!isSearchIndexTrusted(status, buildingIndex)) {
    return "暂时没有结果：全文索引还没建好";
  }
  return "没有找到匹配结果";
}

/**
 * 半截的查询串先别发出去：引号还没配对、停在 `-` / `OR` 上，或者整句
 * 没有任何正向词（`""`、`-排除词`、`not 词`）时，后端只会返回一堆噪音
 * ——最后一类在后端是静态空集（FTS 串构造成 None 直接短路成空页），
 * 自动发出去必然闪一次"没有结果"。正向词的门槛按索引原子数量（见
 * AUTO_SEARCH_MIN_LEN）：`凯。` 这种靠标点撑长度的单字查询同样不发。
 * 用户按回车仍可强制搜索。
 */
export function isAutoSearchable(raw: string): boolean {
  const query = normalizeQuery(raw);
  if (query.length < AUTO_SEARCH_MIN_LEN) return false;
  if ((query.match(/"/g)?.length ?? 0) % 2 === 1) return false;
  if (/-$/.test(query)) return false;
  // 连接词必须是整个裸 token。`\b` 会把 CJK→ASCII 的边界也当词边界，
  // 将 `博士not` 误判成悬挂 NOT；后端把整串解析成普通正向词。
  let tail = "";
  for (const ch of query) {
    tail = QUERY_WHITESPACE_RE.test(ch) ? "" : tail + ch;
  }
  if (/^(or|and|not)$/i.test(tail)) return false;
  // 只数正向词条里能落成索引 token 的字符：CJK 逐字、ASCII 字母数字逐个，
  // 标点/假名后端在子句生成阶段就丢掉，凑不出命中面。为 0 是静态空集
  // （等价于旧的 highlightTerms 为空判定），为 1 是单原子全库拉取，都不发。
  let positiveAtoms = 0;
  for (const term of parseQueryTerms(query)) {
    if (term.isNot) continue;
    positiveAtoms += atomLengthOf(term.text);
    if (positiveAtoms >= AUTO_SEARCH_MIN_LEN) return true;
  }
  return false;
}

/** 单个查询词条：text 已剥掉引号/减号等语法字符，isNot 标记它被排除。 */
interface ParsedTerm {
  text: string;
  isNot: boolean;
}

/**
 * 与后端 `build_fts_query_advanced` / `split_query_terms` 同构的逐字符
 * 扫描器。必须逐字符、不能按空白切 token：后端在任意位置遇到 `"` 都会
 * 切换引号态，`博士"凯尔希"` 是「词 博士 + 短语 凯尔希」两个正向词条；
 * 粘连的 `not"博士"`（flush 把 buf 里的裸 not 变成悬挂标记、开引号把它
 * 收进 quote_is_not）是被排除的短语。此前按 `/"[^"]*"|\S+/` 切 token，
 * 整串被当成一个字面词：`博士"凯尔希"` 搜得到结果却什么都不高亮，
 * `not"博士"`（后端纯否定 → 静态空集）反而被判成「有正向词」自动发出去。
 */
function parseQueryTerms(query: string): ParsedTerm[] {
  const terms: ParsedTerm[] = [];
  let buf = "";
  let inQuotes = false;
  let pendingNot = false;
  let quoteIsNot = false;

  // 对应后端 flush_bare：连接词判定在去减号之前、只认整个裸 token
  // （`"not"` 是字面短语、`-or` 是排除字面量 or）；纯减号串不产生词条
  // 也不消费悬挂 not（顺延给下一个词，`not - 博士` 的博士仍被排除）；
  // 真正成词的 token 无条件消费悬挂 not（`not -X Y` 的 Y 必须保持正向）。
  const flushBare = () => {
    if (!buf) return;
    const token = buf;
    buf = "";
    const lower = token.toLowerCase();
    if (lower === "or" || lower === "and") return;
    if (lower === "not") {
      pendingNot = true;
      return;
    }
    const isNot = token.startsWith("-");
    const content = token.replace(/^-+/, "");
    if (!content) return;
    const notPrefix = pendingNot;
    pendingNot = false;
    terms.push({ text: content, isNot: isNot || notPrefix });
  };

  for (const ch of query) {
    if (ch === '"') {
      if (inQuotes) {
        inQuotes = false;
        // 空引号 `""` 不产生词条；悬挂的 not 在开引号那一刻已被消费，
        // 不会漂到下一个词上（`not "" 博士` 的博士是正向词）。
        if (buf) {
          terms.push({ text: buf, isNot: quoteIsNot });
          buf = "";
        }
        quoteIsNot = false;
      } else {
        // 先记减号（只认恰好 `-`，与后端 `buf == "-"` 一致），再 flush
        // ——粘连的 `not"X"` 由 flush 转成悬挂标记后一并收进 quoteIsNot。
        const dashPrefix = buf === "-";
        flushBare();
        const notPrefix = pendingNot;
        pendingNot = false;
        quoteIsNot = dashPrefix || notPrefix;
        inQuotes = true;
      }
    } else if (!inQuotes && QUERY_WHITESPACE_RE.test(ch)) {
      flushBare();
    } else {
      buf += ch;
    }
  }
  // 引号没闭合：内容退化成普通词，否定语义保住（后端同款收尾）。
  if (inQuotes && quoteIsNot) buf = `-${buf}`;
  flushBare();
  return terms;
}

/**
 * 「这个词条真的会参与匹配」的判定，与后端 `term_to_clause` /
 * `split_match_atoms` 的切原子规则一致：ASCII 字母数字与 CJK（含扩展区）
 * 能落成索引 token，其余字符（标点、假名、西里尔等）根本不进索引。
 * 纯这类字符的词条在后端于子句生成阶段被丢弃——`！！`、`アイ` 单独成
 * 查询时是静态空集，不该被 isAutoSearchable 判成「有正向词」自动发出去；
 * 混在别的词里（`博士 ！！`）时也不该把 `!!` 高亮成"命中原因"。
 */
const ATOM_CHAR_RE =
  /[0-9A-Za-z\u4e00-\u9fff\u3400-\u4dbf\u{20000}-\u{2a6df}\u{2a700}-\u{2b73f}\u{2b740}-\u{2b81f}\u{2b820}-\u{2ceaf}]/u;

/** 词条里能落成索引 token 的字符数（按码点数，代理对只算一个）。 */
function atomLengthOf(text: string): number {
  let count = 0;
  for (const ch of text) {
    if (ATOM_CHAR_RE.test(ch)) count += 1;
  }
  return count;
}

/**
 * 高亮词的修边正则：剥掉词条首尾的标点（\p{P}）、符号（\p{S}）、空白
 * （\p{Z}）与控制/格式字符（\p{C}）。这些字符后端分词器一律不入索引、
 * 不可能是命中原因，留在高亮词里只会让整个字面串在原文里失配——最常见
 * 的是中文输入法默认打出的弯引号：`“凯尔希”` 在后端是 凯/尔/希 逐字
 * AND（弯引号不是查询语法、NFKC 也不折叠成 `"`），命中一堆结果却因为
 * 原文里没有字面 `“凯尔希”` 而整页零高亮；`「博士」`、`博士！`、引号
 * 短语 `"-博士"` 同理。只修边不动内部：`don't`、`0-1` 这类词内标点
 * 保留字面串做尽力匹配，原子间的邻接关系高亮本来就表达不了。
 */
const EDGE_TRIM_RE = /^[\p{P}\p{S}\p{Z}\p{C}]+|[\p{P}\p{S}\p{Z}\p{C}]+$/gu;

/**
 * 把查询串拆成用于高亮的词：
 *   - `-排除词` 不该被高亮（它压根不该出现在结果里）；
 *   - `OR` / `AND` 是连接符不是词；
 *   - 裸词 `NOT` 与减号同义（后端 `not X` ≡ `-X`），它后面那个词同样是
 *     排除词。段落模式的排除只看段落文本，剧情标题里仍可能出现该词——
 *     不跳过的话，用户明确排除的词会在标题里被标成"命中"；
 *   - `"短语"` 去掉引号整体高亮，引号粘在词后也按后端规则切开；
 *   - 纯中文长词后端按二元组匹配，顺带把单字也标出来，让用户看得出命中原因。
 */
export function highlightTerms(query: string): string[] {
  const trimmed = normalizeQuery(query);
  if (!trimmed) return [];
  const terms: string[] = [];
  for (const parsed of parseQueryTerms(trimmed)) {
    if (parsed.isNot) continue;
    // 双引号在扫描时已按语法剥掉；这里再修掉首尾所有进不了索引的
    // 标点/符号/空白（见 EDGE_TRIM_RE），`'博士'`、`“博士”`、`「博士」`
    // 这类写法都按内容高亮。字母（含 é 等带音标的拉丁字母）不修——
    // 它们虽然不是索引原子，但仍是用户想找的字面内容的一部分。
    const stripped = parsed.text.replace(EDGE_TRIM_RE, "");
    if (!stripped || !ATOM_CHAR_RE.test(stripped)) continue;
    terms.push(stripped);
    if (stripped.length >= 4 && /^[\u4e00-\u9fff\u3400-\u4dbf]+$/.test(stripped)) {
      terms.push(...stripped.split(""));
    }
  }
  // 长词优先，保证「凯尔希」整体先于单字命中；去重后限量，避免超长正则。
  return Array.from(new Set(terms))
    .sort((a, b) => b.length - a.length)
    .slice(0, MAX_HIGHLIGHT_TERMS);
}

// ─────────────────────────────────────────────────────────
// 无请求 ID 的后端进度事件门禁
// ─────────────────────────────────────────────────────────

/** SearchPanel / useAutoIndex 共用的最小进度形状。 */
export interface SearchProgressLike {
  phase: string;
  current: number;
  total: number;
  message: string;
}

function isValidProgress(progress: SearchProgressLike): boolean {
  return (
    typeof progress.phase === "string" &&
    typeof progress.message === "string" &&
    Number.isFinite(progress.current) &&
    Number.isFinite(progress.total) &&
    progress.current >= 0 &&
    progress.total >= 0 &&
    (progress.total <= 0 || progress.current <= progress.total)
  );
}

export interface SearchProgressCursor {
  epoch: number;
  mode: "story" | "segment";
  query: string;
  started: boolean;
  rank: number;
  current: number;
  total: number;
}

/** 每次真正发 invoke 前创建新游标；epoch 是当前数据版本代际。 */
export function beginSearchProgress(
  mode: "story" | "segment",
  query: string,
  epoch: number
): SearchProgressCursor {
  return { epoch, mode, query, started: false, rank: -1, current: 0, total: 0 };
}

function searchProgressRank(mode: "story" | "segment", phase: string): number | null {
  if (mode === "segment") return phase === "段落检索" ? 0 : null;
  switch (phase) {
    case "检索":
      return 0;
    case "索引检索":
    case "线性扫描":
      return 1;
    case "统计":
      return 2;
    default:
      return null;
  }
}

/**
 * 接受当前请求的单调进度，拒绝迟到、倒退、分母突变与旧数据代际。
 *
 * 后端事件没有 requestId/version，唯一可证明归属的边界是每个命令第一条
 * `搜索「query」`。终态不在这里接收：Promise resolve/reject 才是当前
 * invoke 的可靠终态，旧请求迟到的“完成”尤其不能替新请求收场。
 */
export function advanceSearchProgress(
  cursor: SearchProgressCursor,
  progress: SearchProgressLike,
  epoch: number
): SearchProgressCursor | null {
  if (cursor.epoch !== epoch || !isValidProgress(progress)) return null;
  const rank = searchProgressRank(cursor.mode, progress.phase);
  if (rank == null) return null;

  if (!cursor.started) {
    const expectedPhase = cursor.mode === "segment" ? "段落检索" : "检索";
    if (
      progress.phase !== expectedPhase ||
      progress.current !== 0 ||
      progress.total !== 0 ||
      progress.message !== `搜索「${cursor.query}」`
    ) {
      return null;
    }
    return { ...cursor, started: true, rank, current: 0, total: 0 };
  }

  if (rank < cursor.rank || rank > cursor.rank + 1) return null;
  if (rank === cursor.rank) {
    if (progress.current < cursor.current) return null;
    if (cursor.total > 0 && progress.total !== cursor.total) return null;
  }
  return {
    ...cursor,
    rank,
    current: progress.current,
    total: progress.total,
  };
}

export interface IndexProgressCursor {
  epoch: number;
  started: boolean;
  terminal: boolean;
  allowTerminalWithoutStart: boolean;
  rank: number;
  current: number;
  total: number;
}

export function beginIndexProgress(
  epoch: number,
  allowTerminalWithoutStart = false
): IndexProgressCursor {
  return {
    epoch,
    started: false,
    terminal: false,
    allowTerminalWithoutStart,
    rank: -1,
    current: 0,
    total: 0,
  };
}

/**
 * 只有后端明确发出的“完成”才是成功终态。最后一条“构建”事件通常已经是
 * `current === total`，但事务此时尚未提交；若把满刻度当完成，会提前退出
 * 忙碌态、查询到旧状态，并因游标已 terminal 而丢掉随后真正的“完成”事件。
 */
export function isIndexProgressTerminal(progress: SearchProgressLike): boolean {
  return progress.phase === "完成";
}

/**
 * 索引事件按数据代际与阶段单调推进。数据更新后调用方换 epoch 并重置游标，
 * 旧构建迟到的“构建/完成”因没有当前代的“收集”起点而被丢弃。
 */
export function advanceIndexProgress(
  cursor: IndexProgressCursor,
  progress: SearchProgressLike,
  epoch: number
): IndexProgressCursor | null {
  if (
    cursor.epoch !== epoch ||
    cursor.terminal ||
    !isValidProgress(progress)
  ) {
    return null;
  }
  const terminal = isIndexProgressTerminal(progress);
  const rank =
    progress.phase === "收集" ? 0 : progress.phase === "构建" ? 1 : terminal ? 2 : null;
  if (rank == null) return null;

  if (!cursor.started) {
    const isStart = progress.phase === "收集" && progress.current === 0;
    if (!isStart && !(terminal && cursor.allowTerminalWithoutStart)) return null;
    return {
      ...cursor,
      started: true,
      terminal,
      rank,
      current: progress.current,
      total: progress.total,
    };
  }

  if (rank < cursor.rank) return null;
  if (rank === cursor.rank) {
    if (progress.current < cursor.current) return null;
    if (cursor.total > 0 && progress.total !== cursor.total) return null;
  }
  return {
    ...cursor,
    terminal,
    rank,
    current: progress.current,
    total: progress.total,
  };
}
