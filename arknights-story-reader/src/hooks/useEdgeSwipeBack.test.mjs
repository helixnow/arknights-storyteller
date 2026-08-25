import { readFile } from "node:fs/promises";
import { test } from "node:test";
import assert from "node:assert/strict";
import ts from "typescript";

async function loadPureGestures() {
  const raw = await readFile(new URL("./useEdgeSwipeBack.ts", import.meta.url), "utf8");
  const prefix = raw
    .slice(0, raw.indexOf("export function useEdgeSwipeBack("))
    .replace(/^import[^\n]*\n/gm, "");
  const source = ts.transpileModule(prefix, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  return import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
}

const {
  evaluateEdgeSwipe,
  isUnambiguousPageTap,
  isWithinVisualViewportEdge,
  shouldIgnorePagedTapAfterMenuClose,
  shouldSuppressRejectedTouchClick,
} = await loadPureGestures();

test("边缘手势：达到水平阈值且水平占优时触发", () => {
  assert.equal(evaluateEdgeSwipe(60, 10, 300, 60, 40), "trigger");
});

test("边缘手势：阈值前保持跟踪", () => {
  assert.equal(evaluateEdgeSwipe(59.9, 10, 300, 60, 40), "track");
});

test("边缘手势：垂直漂移超过上限立即取消", () => {
  assert.equal(evaluateEdgeSwipe(70, 40.1, 300, 60, 40), "cancel");
});

test("边缘手势：反向移动超过容差立即取消", () => {
  assert.equal(evaluateEdgeSwipe(-8.1, 0, 100, 60, 40), "cancel");
});

test("边缘手势：长按超过 1.2 秒不再算返回", () => {
  assert.equal(evaluateEdgeSwipe(80, 0, 1201, 60, 40), "cancel");
});

test("边缘手势：斜向移动纵向占优时不误触发", () => {
  assert.equal(evaluateEdgeSwipe(60, 60, 200, 60, 80), "track");
});

test("边缘手势：非有限坐标直接取消", () => {
  assert.equal(evaluateEdgeSwipe(Number.NaN, 0, 0, 60, 40), "cancel");
});

test("分页轻点：单指小位移被接受", () => {
  assert.equal(isUnambiguousPageTap(1, 6, 8), true);
});

test("分页轻点：第二指出现过即拒绝，捏合后的合成 click 不翻页", () => {
  assert.equal(isUnambiguousPageTap(2, 0, 0), false);
});

test("分页轻点：纵向滚动后的合成 click 不翻页", () => {
  assert.equal(isUnambiguousPageTap(1, 0, 12.1), false);
});

test("分页轻点：阈值边界可接受，自定义阈值生效", () => {
  assert.equal(isUnambiguousPageTap(1, 12, 0), true);
  assert.equal(isUnambiguousPageTap(1, 5, 0, 4), false);
});

test("边缘手势：以 visualViewport.offsetLeft 为可视左边缘", () => {
  assert.equal(isWithinVisualViewportEdge(120, 100, 24), true);
  assert.equal(isWithinVisualViewportEdge(124, 100, 24), true);
  assert.equal(isWithinVisualViewportEdge(125, 100, 24), false);
  assert.equal(isWithinVisualViewportEdge(99, 100, 24), false);
});

test("触摸拒绝：只吞同落点附近的合成 click", () => {
  const outcome = {
    at: 1_000,
    accepted: false,
    clientX: 20,
    clientY: 40,
  };
  assert.equal(shouldSuppressRejectedTouchClick(outcome, 30, 45, 1_500), true);
  assert.equal(shouldSuppressRejectedTouchClick(outcome, 200, 300, 1_500), false);
});

test("触摸拒绝：超时、时钟回拨和已接受轻点都不吞鼠标 click", () => {
  const rejected = {
    at: 1_000,
    accepted: false,
    clientX: 20,
    clientY: 40,
  };
  assert.equal(shouldSuppressRejectedTouchClick(rejected, 20, 40, 1_800), false);
  assert.equal(shouldSuppressRejectedTouchClick(rejected, 20, 40, 999), false);
  assert.equal(
    shouldSuppressRejectedTouchClick({ ...rejected, accepted: true }, 20, 40, 1_100),
    false
  );
});

test("分页关菜单 / 关 sheet：400ms 内的同一次点击不当翻页", () => {
  assert.equal(shouldIgnorePagedTapAfterMenuClose(1_000, 1_200), true);
  assert.equal(shouldIgnorePagedTapAfterMenuClose(1_000, 1_399), true);
  assert.equal(shouldIgnorePagedTapAfterMenuClose(1_000, 1_400), false);
  assert.equal(shouldIgnorePagedTapAfterMenuClose(0, 1_200), false);
  assert.equal(shouldIgnorePagedTapAfterMenuClose(1_000, 999), false);
  assert.equal(shouldIgnorePagedTapAfterMenuClose(Number.NaN, 1_200), false);
});
