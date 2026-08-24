/**
 * 搜索查询串的纯函数工具。
 *
 * 从 SearchPanel 抽出来的原因只有一个：这两个函数承载了与后端查询语法
 * （`-排除`、`NOT`、`OR`/`AND`、`"短语"`）对齐的细则，历史上出过好几次
 * 回归（悬挂 NOT、`not -词` 连用、`"not"` 字面短语被当成连接词、粘连
 * 引号 `not"短语"` 的极性），必须能脱离 React 用 node:test 直接锁行为。
 */

/** 少于两个字符不自动搜：中文单字命中面太大，等于把整库拉一遍。 */
export const AUTO_SEARCH_MIN_LEN = 2;

/** 高亮词上限：去重后仍超长的查询只取前几个，避免拼出超长正则。 */
export const MAX_HIGHLIGHT_TERMS = 12;

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
  return raw.normalize("NFKC");
}

/**
 * 半截的查询串先别发出去：引号还没配对、停在 `-` / `OR` 上，或者整句
 * 没有任何正向词（`""`、`-排除词`、`not 词`）时，后端只会返回一堆噪音
 * ——最后一类在后端是静态空集（FTS 串构造成 None 直接短路成空页），
 * 自动发出去必然闪一次"没有结果"。用户按回车仍可强制搜索。
 */
export function isAutoSearchable(raw: string): boolean {
  const query = normalizeQuery(raw);
  if (query.length < AUTO_SEARCH_MIN_LEN) return false;
  if ((query.match(/"/g)?.length ?? 0) % 2 === 1) return false;
  if (/-$/.test(query)) return false;
  if (/\b(or|and|not)$/i.test(query)) return false;
  if (highlightTerms(query).length === 0) return false;
  return true;
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
    } else if (!inQuotes && /\s/.test(ch)) {
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
  const trimmed = normalizeQuery(query).trim();
  if (!trimmed) return [];
  const terms: string[] = [];
  for (const parsed of parseQueryTerms(trimmed)) {
    if (parsed.isNot) continue;
    // 双引号在扫描时已按语法剥掉；这里再剥一层成对单引号并收掉短语
    // 首尾空白，`'博士'` 这类写法仍按内容高亮。
    const stripped = parsed.text.replace(/^["']+|["']+$/g, "").trim();
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
