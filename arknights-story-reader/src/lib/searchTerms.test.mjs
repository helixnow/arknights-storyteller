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

test("highlightTerms：粘连 `not\"博士\"` 是单个字面 token，不触发 NOT 语义", () => {
  // 没有空格分隔时整串按 \S+ 收进一个 token：不是裸词 not，不做排除；
  // 去除首尾引号后剩 `not"博士`（词中引号保留）。钉死此行为，避免
  // 未来"顺手"把它解析成 NOT 语义而与后端脱节。
  assert.deepEqual(highlightTerms('not"博士"'), ['not"博士']);
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
