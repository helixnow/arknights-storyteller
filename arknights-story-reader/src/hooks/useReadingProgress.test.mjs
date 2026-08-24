import { readFile } from "node:fs/promises";
import { test } from "node:test";
import assert from "node:assert/strict";
import ts from "typescript";

async function loadPureProgress() {
  const raw = await readFile(new URL("./useReadingProgress.ts", import.meta.url), "utf8");
  const prefix = raw
    .slice(0, raw.indexOf("export function useReadingProgress("))
    .replace(/^import[^\n]*\n/gm, "");
  const source = ts.transpileModule(prefix, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  return import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
}

const progressModule = await loadPureProgress();
const {
  deserializeProgressMap,
  isWorthPersisting,
  pageIndexFromPercentage,
  progressPersistDelay,
  sanitizeReadingProgress,
} = progressModule;

function progress(overrides = {}) {
  return {
    storyPath: "story/a.txt",
    percentage: 0.4,
    currentPage: 3,
    scrollTop: 400,
    readingMode: "scroll",
    updatedAt: 1000,
    ...overrides,
  };
}

test("进度序列化：map key 是归属真值，不能被内嵌旧路径串篇", () => {
  const value = sanitizeReadingProgress(
    progress({ storyPath: "story/wrong.txt" }),
    "story/right.txt"
  );
  assert.equal(value.storyPath, "story/right.txt");
});

test("进度序列化：比例、页码与滚动位置被收敛到合法范围", () => {
  const value = sanitizeReadingProgress(
    progress({ percentage: 8, currentPage: -3.7, scrollTop: -20 }),
    "story/a.txt"
  );
  assert.equal(value.percentage, 1);
  assert.equal(value.currentPage, 0);
  assert.equal(value.scrollTop, 0);
});

test("进度序列化：非有限数字不会进入恢复计算", () => {
  const value = sanitizeReadingProgress(
    progress({
      percentage: Number.NaN,
      currentPage: Number.POSITIVE_INFINITY,
      scrollTop: Number.NaN,
      updatedAt: Number.NEGATIVE_INFINITY,
    }),
    "story/a.txt"
  );
  assert.equal(value.percentage, 0);
  assert.equal(value.currentPage, undefined);
  assert.equal(value.scrollTop, undefined);
  assert.equal(value.updatedAt, 0);
});

test("进度序列化：未知阅读模式回落滚动，null storyCode 原样保留", () => {
  const value = sanitizeReadingProgress(
    progress({ readingMode: "columns", storyCode: null }),
    "story/a.txt"
  );
  assert.equal(value.readingMode, "scroll");
  assert.equal(value.storyCode, null);
});

test("进度整表：坏 JSON 与数组根节点安全回落空表", () => {
  assert.deepEqual(deserializeProgressMap("{"), {});
  assert.deepEqual(deserializeProgressMap("[]"), {});
});

test("进度整表：坏条目逐条丢弃，不牵连正常剧情", () => {
  const map = deserializeProgressMap(
    JSON.stringify({
      "story/a.txt": progress(),
      "story/b.txt": null,
      "": progress(),
    })
  );
  assert.deepEqual(Object.keys(map), ["story/a.txt"]);
});

test("进度节流：正常墙钟按剩余窗口等待", () => {
  assert.equal(progressPersistDelay(1500, 1000, 1200), 700);
  assert.equal(progressPersistDelay(2500, 1000, 1200), 0);
});

test("进度节流：墙钟回拨最多等待一个窗口", () => {
  assert.equal(progressPersistDelay(500, 1000, 1200), 1200);
  assert.equal(progressPersistDelay(-1e12, 1e12, 1200), 1200);
});

test("进度换模式：分页比例逆变换不会在中段多跳一页", () => {
  // 第 5/10 页持久化为 0.5，恢复仍应落下标 4。
  assert.equal(pageIndexFromPercentage(0.5, 10), 4);
  assert.equal(pageIndexFromPercentage(0.1, 10), 0);
  assert.equal(pageIndexFromPercentage(1, 10), 9);
});

test("进度换模式：非法比例与页数安全钳位", () => {
  assert.equal(pageIndexFromPercentage(Number.NaN, 0), 0);
  assert.equal(pageIndexFromPercentage(-1, 8), 0);
  assert.equal(pageIndexFromPercentage(2, 8), 7);
});

test("进度 dirty：页码、模式、首尾跃迁始终值得落盘", () => {
  const base = progress();
  assert.equal(isWorthPersisting(progress({ currentPage: 4 }), base), true);
  assert.equal(isWorthPersisting(progress({ readingMode: "paged" }), base), true);
  assert.equal(isWorthPersisting(progress({ percentage: 1 }), base), true);
  assert.equal(isWorthPersisting(progress({ percentage: 0 }), base), true);
});

test("进度 dirty：微小滚动不刷盘，离开时仍由 force 冲刷", () => {
  const base = progress();
  assert.equal(
    isWorthPersisting(progress({ percentage: 0.401, scrollTop: 410 }), base),
    false
  );
  assert.equal(
    isWorthPersisting(progress({ percentage: 0.401, scrollTop: 430 }), base),
    true
  );
});
