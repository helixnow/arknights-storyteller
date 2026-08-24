/**
 * searchTerms 单元测试（node:test + node:assert，无额外依赖）。
 *
 * highlightTerms / isAutoSearchable 承载着与后端查询语法对齐的细则，
 * 历史上出过多次回归：悬挂 NOT、`not -词` 连用把正向词误吞、`"not"`
 * 字面短语被当成连接词、未闭合引号触发自动搜等。这里逐条钉死当前行为，
 * 任何一条断言变红都意味着高亮 / 自动搜的语义漂移，必须显式评审。
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  highlightTerms,
  isAutoSearchable,
  MAX_HIGHLIGHT_TERMS,
} from "./searchTerms.ts";

// ─────────────────────────────────────────────────────────
// highlightTerms：NOT / 减号排除
// ─────────────────────────────────────────────────────────

test("highlightTerms：`not 博士` 的排除目标不高亮", () => {
  assert.deepEqual(highlightTerms("not 博士"), []);
});

test("highlightTerms：`NOT` 大小写不敏感", () => {
  assert.deepEqual(highlightTerms("NOT 博士"), []);
  assert.deepEqual(highlightTerms("Not 博士"), []);
});

test("highlightTerms：`-博士` 减号排除词不高亮", () => {
  assert.deepEqual(highlightTerms("-博士"), []);
  assert.deepEqual(highlightTerms("凯尔希 -博士"), ["凯尔希"]);
});

test("highlightTerms：`not \"博士\"` 引号短语同样被 NOT 吞掉", () => {
  assert.deepEqual(highlightTerms('not "博士"'), []);
});

test("highlightTerms：`not -博士 凯尔希` —— `-词` 消费悬挂 NOT，后续词保持正向", () => {
  // 若悬挂的 not 没被 `-博士` 消费，凯尔希会被误当排除词而丢失高亮。
  assert.deepEqual(highlightTerms("not -博士 凯尔希"), ["凯尔希"]);
});

test("highlightTerms：`\"not\" 博士` —— 引号里的 not 是字面短语，不是连接词", () => {
  // 连接词判定在去引号之前：`"not"` 要整体匹配并高亮（长词在前）。
  assert.deepEqual(highlightTerms('"not" 博士'), ["not", "博士"]);
});

test("highlightTerms：尾部悬挂 NOT 是空操作，不影响前面的词", () => {
  assert.deepEqual(highlightTerms("博士 not"), ["博士"]);
  assert.deepEqual(highlightTerms("博士 NOT"), ["博士"]);
});

test("highlightTerms：粘连 `not\"博士\"` 与后端一致按排除短语解析", () => {
  // 后端是逐字符扫描：开引号先 flush 掉 buf 里的裸 `not`（变成悬挂标记）
  // 再把它收进 quote_is_not，所以 `not"博士"` 是被排除的短语、纯否定查询
  // 是静态空集。此前按 \S+ 切 token 把整串当成一个字面词，判成"有正向词"。
  assert.deepEqual(highlightTerms('not"博士"'), []);
  assert.deepEqual(highlightTerms('not"博士" 凯尔希'), ["凯尔希"]);
  // 全角粘连写法 NFKC 折叠后同样成立。
  assert.deepEqual(highlightTerms("ＮＯＴ＂博士＂"), []);
});

test("highlightTerms：引号粘在词后按后端切开，词与短语分别高亮", () => {
  // 后端在任意位置遇到 `"` 都切换引号态：`博士"凯尔希"` 是两个正向词条。
  // 整串当一个字面词的话，这条查询搜得到结果、却什么都高亮不了。
  assert.deepEqual(highlightTerms('博士"凯尔希"'), ["凯尔希", "博士"]);
  // 排除词粘着正向短语：`-博士` 被排除，短语 凯尔希 保持正向高亮。
  assert.deepEqual(highlightTerms('-博士"凯尔希"'), ["凯尔希"]);
});

test("highlightTerms：`-\"短语\"` 是否定短语；引号前缀只认恰好单个减号", () => {
  assert.deepEqual(highlightTerms('-"博士"'), []);
  assert.deepEqual(highlightTerms('-"博士" 凯尔希'), ["凯尔希"]);
  // 后端 dash_prefix 判定是 `buf == "-"`：`--` 经 flush 后既不产生词条
  // 也不否定短语，`--"博士"` 的短语是正向的。
  assert.deepEqual(highlightTerms('--"博士"'), ["博士"]);
});

test("highlightTerms：未闭合引号内容退化成普通词，否定语义保留", () => {
  assert.deepEqual(highlightTerms('"博士'), ["博士"]);
  // 后端在收尾时给未闭合的否定短语补回 `-`，两边都不能把它高亮成正向。
  assert.deepEqual(highlightTerms('-"博士'), []);
  assert.deepEqual(highlightTerms('not "博士'), []);
});

test("highlightTerms：带空格的引号短语整体作为一个高亮词", () => {
  assert.deepEqual(highlightTerms('"凯尔希 博士"'), ["凯尔希 博士"]);
});

test("highlightTerms：落不成索引 token 的词条不高亮（假名、纯标点）", () => {
  // 后端 term_to_clause 只保留 ASCII 字母数字与 CJK；纯标点/假名词条在
  // 子句生成阶段被丢弃。`博士 ！！` 只按博士匹配，`!!` 不是命中原因。
  assert.deepEqual(highlightTerms("アイ"), []);
  assert.deepEqual(highlightTerms("！！"), []);
  assert.deepEqual(highlightTerms("博士 ！！"), ["博士"]);
});

test("highlightTerms：`and not X` —— and 是无操作连接词，not 照常排除下一词", () => {
  assert.deepEqual(highlightTerms("and not 干员"), []);
  assert.deepEqual(highlightTerms("博士 and not 干员"), ["博士"]);
});

test("highlightTerms：`not and X` —— and 不消费悬挂 NOT，X 仍被排除", () => {
  // 后端 flush 里裸词 and 直接 return、不碰 pending_not，悬挂的 not
  // 越过它落在下一个真正成词的 token 上。
  assert.deepEqual(highlightTerms("not and 干员"), []);
  assert.deepEqual(highlightTerms("博士 not and 干员"), ["博士"]);
});

test("highlightTerms：全角 ＮＯＴ／－ 经 NFKC 折叠后与半角同义", () => {
  // 后端解析前整体过 normalize_nfkc_lower_strip_marks：`ＮＯＴ` 是连接词、
  // `－词` 是排除。前端不折叠的话，用户明确排除的 干员/博士 会被高亮成命中。
  assert.deepEqual(highlightTerms("博士 ＮＯＴ 干员"), ["博士"]);
  assert.deepEqual(highlightTerms("凯尔希 －博士"), ["凯尔希"]);
  // 全角引号 ＂博士＂ 同样折叠成短语。
  assert.deepEqual(highlightTerms("＂博士＂"), ["博士"]);
});

test("highlightTerms：`OR AND` 连用只是连接词堆叠，两侧词照常高亮", () => {
  assert.deepEqual(highlightTerms("凯尔希 OR AND 博士"), ["凯尔希", "博士"]);
});

test("highlightTerms：空引号不产生词条，但要消费悬挂的 NOT", () => {
  assert.deepEqual(highlightTerms('""'), []);
  // 后端在开引号那一刻就消费 pending_not，空短语与 not 一起作废：
  // `not "" 博士` 的博士是正向词，必须高亮。
  assert.deepEqual(highlightTerms('not "" 博士'), ["博士"]);
});

test("highlightTerms：纯减号串不消费悬挂 NOT，顺延给下一个词", () => {
  // 后端里 `-` 不产生词条也不吸收 not（对照 `not -博士 凯尔希`：
  // 成词的 `-博士` 才吸收）——`not - 博士` 的博士被排除，不高亮。
  assert.deepEqual(highlightTerms("not - 博士"), []);
  assert.deepEqual(highlightTerms("凯尔希 not - 博士"), ["凯尔希"]);
});

// ─────────────────────────────────────────────────────────
// highlightTerms：OR / AND 连接词
// ─────────────────────────────────────────────────────────

test("highlightTerms：裸词 OR / AND 是连接词，不产出高亮词", () => {
  assert.deepEqual(highlightTerms("or"), []);
  assert.deepEqual(highlightTerms("OR"), []);
  assert.deepEqual(highlightTerms("and"), []);
  assert.deepEqual(highlightTerms("AND"), []);
});

test("highlightTerms：OR / AND 两侧的词照常高亮", () => {
  assert.deepEqual(highlightTerms("凯尔希 OR 博士"), ["凯尔希", "博士"]);
  assert.deepEqual(highlightTerms("凯尔希 and 博士"), ["凯尔希", "博士"]);
});

// ─────────────────────────────────────────────────────────
// highlightTerms：短语、排序、单字展开、去重限量
// ─────────────────────────────────────────────────────────

test("highlightTerms：引号短语去掉引号整体高亮", () => {
  assert.deepEqual(highlightTerms('"凯尔希"'), ["凯尔希"]);
});

test("highlightTerms：长词排在前面，保证整词先于单字命中", () => {
  assert.deepEqual(highlightTerms("博士 凯尔希"), ["凯尔希", "博士"]);
});

test("highlightTerms：4 字以上纯中文词补出单字（二元组匹配的可见化）", () => {
  assert.deepEqual(highlightTerms("罗德岛制药"), [
    "罗德岛制药",
    "罗",
    "德",
    "岛",
    "制",
    "药",
  ]);
});

test("highlightTerms：去重并按上限截断", () => {
  assert.deepEqual(highlightTerms("博士 博士"), ["博士"]);
  const thirteen = "一 二 三 四 五 六 七 八 九 十 壹 贰 叁";
  const terms = highlightTerms(thirteen);
  assert.equal(terms.length, MAX_HIGHLIGHT_TERMS);
  assert.ok(!terms.includes("叁"), "超限的最后一个词应被截掉");
});

test("highlightTerms：空串 / 纯空白返回空数组", () => {
  assert.deepEqual(highlightTerms(""), []);
  assert.deepEqual(highlightTerms("   "), []);
});

// ─────────────────────────────────────────────────────────
// isAutoSearchable：半截查询不自动发
// ─────────────────────────────────────────────────────────

test("isAutoSearchable：未闭合引号返回 false", () => {
  assert.equal(isAutoSearchable('"博士'), false);
  assert.equal(isAutoSearchable('博士 "凯尔'), false);
  // 引号配对后恢复可搜。
  assert.equal(isAutoSearchable('"博士"'), true);
});

test("isAutoSearchable：尾部悬挂 `-` 返回 false", () => {
  assert.equal(isAutoSearchable("博士 -"), false);
  assert.equal(isAutoSearchable("凯尔-"), false);
  // 减号后面已经有排除词则照常可搜。
  assert.equal(isAutoSearchable("博士 -干员"), true);
});

test("isAutoSearchable：尾部悬挂 OR / AND / NOT 返回 false（大小写不敏感）", () => {
  assert.equal(isAutoSearchable("博士 OR"), false);
  assert.equal(isAutoSearchable("博士 or"), false);
  assert.equal(isAutoSearchable("博士 AND"), false);
  assert.equal(isAutoSearchable("博士 and"), false);
  assert.equal(isAutoSearchable("博士 NOT"), false);
  assert.equal(isAutoSearchable("博士 not"), false);
  // `OR AND` 连用后停在 AND 上：单个尾连接词已由上面几条覆盖，
  // 这里钉住堆叠写法也被同一条正则拦下。
  assert.equal(isAutoSearchable("凯尔希 OR AND"), false);
});

test("isAutoSearchable：全角 ＮＯＴ／－／＂ 经 NFKC 折叠后同样拦截", () => {
  // 后端把全角折成半角解析，前端不折叠的话这些"半截查询"会被自动发出去。
  assert.equal(isAutoSearchable("博士 ＮＯＴ"), false);
  assert.equal(isAutoSearchable("博士 －"), false);
  assert.equal(isAutoSearchable("＂博士"), false);
  // 折叠后配对完整则照常可搜。
  assert.equal(isAutoSearchable("＂博士＂"), true);
});

test("isAutoSearchable：没有正向词的查询不自动发（后端静态空集）", () => {
  // `""`、纯否定在后端 build_fts_query_advanced 里直接构造成 None →
  // 空页。自动发出去只会闪一次"没有结果"；回车强搜不受影响。
  assert.equal(isAutoSearchable('""'), false);
  assert.equal(isAutoSearchable("-博士"), false);
  assert.equal(isAutoSearchable("not 博士"), false);
  // 粘连写法 `not"博士"` 在后端同样是纯否定（排除短语）。
  assert.equal(isAutoSearchable('not"博士"'), false);
  // 落不成索引 token 的查询（假名、纯标点）在后端也是静态空集。
  assert.equal(isAutoSearchable("アイ"), false);
  assert.equal(isAutoSearchable("！！"), false);
  // 有正向词就恢复可搜：空引号旁的词、排除词旁的词、粘连否定短语旁的词。
  assert.equal(isAutoSearchable('"" 博士'), true);
  assert.equal(isAutoSearchable("凯尔希 -博士"), true);
  assert.equal(isAutoSearchable('not"博士" 凯尔希'), true);
});

test("isAutoSearchable：`\\b` 只拦裸连接词，不误伤以 not 结尾的英文单词", () => {
  // "cannot" 的 not 前没有词边界，不该被当成悬挂 NOT。
  assert.equal(isAutoSearchable("cannot"), true);
});

test("isAutoSearchable：少于两个字符返回 false，普通查询返回 true", () => {
  assert.equal(isAutoSearchable(""), false);
  assert.equal(isAutoSearchable("凯"), false);
  assert.equal(isAutoSearchable("博士"), true);
  assert.equal(isAutoSearchable("凯尔希 OR 博士"), true);
});
