/**
 * 搜索查询串的纯函数工具。
 *
 * 从 SearchPanel 抽出来的原因只有一个：这两个函数承载了与后端查询语法
 * （`-排除`、`NOT`、`OR`/`AND`、`"短语"`）对齐的细则，历史上出过好几次
 * 回归（悬挂 NOT、`not -词` 连用、`"not"` 字面短语被当成连接词），必须
 * 能脱离 React 用 node:test 直接锁行为。逻辑与常量都原样搬运，行为不变。
 */

/** 少于两个字符不自动搜：中文单字命中面太大，等于把整库拉一遍。 */
export const AUTO_SEARCH_MIN_LEN = 2;

/** 高亮词上限：去重后仍超长的查询只取前几个，避免拼出超长正则。 */
export const MAX_HIGHLIGHT_TERMS = 12;

/**
 * 半截的查询串先别发出去：引号还没配对、或者停在 `-` / `OR` 上时，
 * 后端只会返回一堆噪音，用户每敲一个符号就闪一次"没有结果"。
 */
export function isAutoSearchable(raw: string): boolean {
  if (raw.length < AUTO_SEARCH_MIN_LEN) return false;
  if ((raw.match(/"/g)?.length ?? 0) % 2 === 1) return false;
  if (/-$/.test(raw)) return false;
  if (/\b(or|and|not)$/i.test(raw)) return false;
  return true;
}

/**
 * 把查询串拆成用于高亮的词：
 *   - `-排除词` 不该被高亮（它压根不该出现在结果里）；
 *   - `OR` / `AND` 是连接符不是词；
 *   - 裸词 `NOT` 与减号同义（后端 `not X` ≡ `-X`），它后面那个词同样是
 *     排除词。段落模式的排除只看段落文本，剧情标题里仍可能出现该词——
 *     不跳过的话，用户明确排除的词会在标题里被标成"命中"；
 *   - `"短语"` 去掉引号整体高亮；
 *   - 纯中文长词后端按二元组匹配，顺带把单字也标出来，让用户看得出命中原因。
 */
export function highlightTerms(query: string): string[] {
  const trimmed = query.trim();
  if (!trimmed) return [];
  const tokens = trimmed.match(/"[^"]*"|\S+/g) ?? [];
  const terms: string[] = [];
  let pendingNot = false;
  for (const token of tokens) {
    if (token.startsWith("-")) {
      // 后端里 `-词` 会消费掉悬挂的 not（`not -博士 凯尔希` 的凯尔希是正向词）。
      pendingNot = false;
      continue;
    }
    // 连接词判定必须在去引号之前、只认裸词——与后端一致：`"not"` 是要
    // 整体匹配（并高亮）的字面短语，不是连接词。
    if (/^not$/i.test(token)) {
      pendingNot = true;
      continue;
    }
    if (/^(or|and)$/i.test(token)) continue;
    const stripped = token.replace(/^["']+|["']+$/g, "").trim();
    if (!stripped) continue;
    if (pendingNot) {
      pendingNot = false;
      continue;
    }
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
