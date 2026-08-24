import { readFile } from "node:fs/promises";
import { test } from "node:test";
import assert from "node:assert/strict";
import ts from "typescript";

async function loadPureHighlights() {
  const raw = await readFile(new URL("./useHighlights.ts", import.meta.url), "utf8");
  const prefix = raw
    .slice(0, raw.indexOf("export function useHighlights("))
    .replace(/^import[^\n]*\n/gm, "");
  const source = ts.transpileModule(prefix, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  return import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
}

const highlightModule = await loadPureHighlights();
const {
  mergeHighlightLists,
  normalizeHighlightEntry,
  resolveHighlightEntryIndex,
  trimHighlightPreview,
} = highlightModule;

const mark = (segmentIndex, digest) => ({ segmentIndex, digest });

test("划线序列化：旧 number[] 会升级为对象并截断小数", () => {
  assert.deepEqual(normalizeHighlightEntry(3.9), { segmentIndex: 3 });
});

test("划线序列化：负数、NaN 与坏对象被丢弃", () => {
  assert.equal(normalizeHighlightEntry(-1), null);
  assert.equal(normalizeHighlightEntry(Number.NaN), null);
  assert.equal(normalizeHighlightEntry({ segmentIndex: "3" }), null);
});

test("划线序列化：空 digest 不冒充内容指纹", () => {
  assert.deepEqual(normalizeHighlightEntry({ segmentIndex: 2, digest: "" }), {
    segmentIndex: 2,
    digest: undefined,
  });
});

test("划线跨 storage：两个窗口同时新增同篇不同段，两条都保留", () => {
  const merged = mergeHighlightLists(
    [mark(1, "a")],
    [mark(1, "a"), mark(10, "local")],
    [mark(1, "a"), mark(20, "remote")]
  );
  assert.deepEqual(merged, [mark(1, "a"), mark(10, "local"), mark(20, "remote")]);
});

test("划线跨 storage：本地删除只删自己碰过的条目", () => {
  const merged = mergeHighlightLists(
    [mark(1, "a"), mark(2, "b")],
    [mark(2, "b")],
    [mark(1, "a"), mark(2, "b"), mark(3, "remote")]
  );
  assert.deepEqual(merged, [mark(2, "b"), mark(3, "remote")]);
});

test("划线跨 storage：外部删除本地未修改条目，不会被旧快照复活", () => {
  const merged = mergeHighlightLists(
    [mark(1, "a"), mark(2, "b")],
    [mark(1, "a"), mark(2, "b"), mark(4, "local")],
    [mark(1, "a")]
  );
  assert.deepEqual(merged, [mark(1, "a"), mark(4, "local")]);
});

test("划线跨 storage：清空只清已知基线，保留并发新收藏", () => {
  const merged = mergeHighlightLists(
    [mark(1, "a"), mark(2, "b")],
    null,
    [mark(1, "a"), mark(2, "b"), mark(9, "remote")]
  );
  assert.deepEqual(merged, [mark(9, "remote")]);
});

test("划线跨 storage：两边加同一条不会重复", () => {
  const merged = mergeHighlightLists([], [mark(5, "same")], [mark(5, "same")]);
  assert.deepEqual(merged, [mark(5, "same")]);
});

test("划线换包：原下标 digest 未变时留在原位", () => {
  assert.equal(
    resolveHighlightEntryIndex(mark(1, "keep"), ["x", "keep", "y"]),
    1
  );
});

test("划线换包：段落移动后按 digest 重定位", () => {
  const index = new Map([["move", 3]]);
  assert.equal(
    resolveHighlightEntryIndex(mark(1, "move"), ["x", "new", "y", "move"], index),
    3
  );
});

test("划线换包：内容消失时隐藏孤儿，不串到同下标新正文", () => {
  assert.equal(
    resolveHighlightEntryIndex(mark(1, "gone"), ["x", "unrelated", "y"]),
    -1
  );
});

test("划线预览：截断前修掉尾部标点，避免句号叠省略号", () => {
  const text = `${"阿".repeat(68)}？！后文`;
  assert.equal(trimHighlightPreview(text, 70), `${"阿".repeat(68)}…`);
});

test("划线预览：短句与内部标点保持原样，空白折叠", () => {
  assert.equal(trimHighlightPreview("  凯尔希：\n  博士，回来。  "), "凯尔希： 博士，回来。");
  assert.equal(trimHighlightPreview("   "), "");
});

test("划线 KeepAlive：隐藏时冲刷并摘监听，激活后以盘上状态对账", async () => {
  const source = await readFile(new URL("./useHighlights.ts", import.meta.url), "utf8");
  assert.match(
    source,
    /export function useHighlights\([\s\S]*?active = true[\s\S]*?\) \{/
  );
  assert.match(source, /if \(!active\) \{[\s\S]*?flushPendingStore\(\);[\s\S]*?return;/);
  assert.match(
    source,
    /if \(typeof window === "undefined" \|\| !active\) return;[\s\S]*?addEventListener\("storage"/
  );
});
