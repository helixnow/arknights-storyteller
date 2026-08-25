import { readFile } from "node:fs/promises";
import { test } from "node:test";
import assert from "node:assert/strict";
import ts from "typescript";

async function loadPureReader() {
  const raw = await readFile(new URL("./StoryReader.tsx", import.meta.url), "utf8");
  const start = raw.indexOf("const BASE_MAX_WIDTH");
  const end = raw.indexOf("function renderLines");
  const source = ts.transpileModule(raw.slice(start, end), {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  return import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
}

const {
  createLruCache,
  postProcessSegments,
  readerChromeHeightFromMeasurements,
  readerLocalDayKey,
  scrollTopFromAnchorGeometry,
  shouldResetReaderPositionForContent,
  stableReaderIntentToken,
} = await loadPureReader();

function withClock(run) {
  const original = Date.now;
  let now = 1000;
  Date.now = () => now;
  try {
    run((value) => {
      now = value;
    });
  } finally {
    Date.now = original;
  }
}

test("预取缓存：TTL 内命中，超过五分钟失效", () => {
  withClock((setNow) => {
    const cache = createLruCache(2);
    cache.set("a", "正文 A");
    setNow(301000);
    assert.equal(cache.get("a"), "正文 A");
    setNow(301001);
    assert.equal(cache.get("a"), null);
  });
});

test("预取缓存：墙钟回拨立即失效，不把旧正文永久当新数据", () => {
  withClock((setNow) => {
    const cache = createLruCache(2);
    cache.set("a", "旧正文");
    setNow(999);
    assert.equal(cache.get("a"), null);
  });
});

test("预取缓存：命中会刷新 LRU 顺序", () => {
  withClock(() => {
    const cache = createLruCache(2);
    cache.set("a", 1);
    cache.set("b", 2);
    assert.equal(cache.get("a"), 1);
    cache.set("c", 3);
    assert.equal(cache.get("b"), null);
    assert.equal(cache.get("a"), 1);
    assert.equal(cache.get("c"), 3);
  });
});

test("预取缓存：clear 在数据换包后整体失效", () => {
  const cache = createLruCache(2);
  cache.set("a", 1);
  cache.set("b", 2);
  cache.clear();
  assert.equal(cache.get("a"), null);
  assert.equal(cache.get("b"), null);
});

test("跳转意图：缺少 issuedAt 时使用稳定 token，不随重渲染变化", () => {
  assert.equal(stableReaderIntentToken(undefined), 0);
  assert.equal(stableReaderIntentToken(undefined), 0);
});

test("跳转意图：合法 issuedAt 保留，非有限值回落稳定 token", () => {
  assert.equal(stableReaderIntentToken(123456), 123456);
  assert.equal(stableReaderIntentToken(Number.NaN), 0);
});

test("正文替换：TTL 重验得到等价首尾与段数时保留页码", () => {
  const signature = { segmentCount: 80, firstDigest: "first", lastDigest: "last" };
  assert.equal(
    shouldResetReaderPositionForContent(signature, { ...signature }),
    false
  );
});

test("正文替换：换包或首尾/段数变化时重置并重新恢复", () => {
  const base = { segmentCount: 80, firstDigest: "first", lastDigest: "last" };
  assert.equal(
    shouldResetReaderPositionForContent(base, { ...base, segmentCount: 81 }),
    true
  );
  assert.equal(
    shouldResetReaderPositionForContent(base, { ...base, lastDigest: "new-last" }),
    true
  );
  assert.equal(shouldResetReaderPositionForContent(base, base, true), true);
  assert.equal(shouldResetReaderPositionForContent(null, base), true);
});

test("阅读 streak：本地日期键跨日变化，同日翻页保持一致", () => {
  assert.equal(readerLocalDayKey(new Date(2026, 7, 24, 1)), "2026-8-24");
  assert.equal(readerLocalDayKey(new Date(2026, 7, 24, 23)), "2026-8-24");
  assert.equal(readerLocalDayKey(new Date(2026, 7, 25, 0)), "2026-8-25");
});

test("滚动恢复：锚段优先按 index + offset 还原并钳位", () => {
  assert.equal(scrollTopFromAnchorGeometry(400, 100, 160, 10, 1000), 450);
  assert.equal(scrollTopFromAnchorGeometry(900, 100, 400, 0, 1000), 1000);
  assert.equal(scrollTopFromAnchorGeometry(10, 100, 20, 0, 1000), 0);
  assert.equal(
    scrollTopFromAnchorGeometry(Number.NaN, 100, 160, 10, 1000),
    null
  );
});

test("分页 chrome：顶栏、页脚、邻话栏高度求和并向上取整", () => {
  assert.equal(readerChromeHeightFromMeasurements([56, 76, 64]), 196);
  assert.equal(readerChromeHeightFromMeasurements([56.2, 76.1, 64.1]), 197);
});

test("分页 chrome：缺失、负值与非有限测量不会污染 CSS 变量", () => {
  assert.equal(
    readerChromeHeightFromMeasurements([56, 0, -20, Number.NaN, Number.POSITIVE_INFINITY]),
    56
  );
});

test("分页 chrome：ResizeObserver 写入变量，隐藏或卸载时清理", async () => {
  const source = await readFile(new URL("./StoryReader.tsx", import.meta.url), "utf8");
  assert.match(source, /new ResizeObserver\(measure\)/);
  assert.match(source, /root\.style\.setProperty\("--reader-chrome", `\$\{chromeHeight\}px`\)/);
  assert.match(source, /root\.style\.removeProperty\("--reader-chrome"\)/);
  assert.match(source, /ref=\{footerRef\}/);
  assert.match(source, /ref=\{neighborBarRef\}/);

  const css = await readFile(new URL("../index.css", import.meta.url), "utf8");
  assert.match(css, /calc\(100dvh - var\(--reader-chrome, 12rem\)\)/);
});

test("KeepAlive 隐藏：退出选段模式但不清空已选段落", async () => {
  const source = await readFile(new URL("./StoryReader.tsx", import.meta.url), "utf8");
  const start = source.indexOf("if (active) return;", source.indexOf("停止所有会话型 UI"));
  const end = source.indexOf("}, [active]);", start);
  const effect = source.slice(start, end);
  assert.match(effect, /setSelectMode\(false\)/);
  assert.doesNotMatch(effect, /setSelectedSegments/);
});

test("KeepAlive 隐藏：同步清掉未结束的分页触摸，恢复后不沿用旧手势", async () => {
  const source = await readFile(new URL("./StoryReader.tsx", import.meta.url), "utf8");
  const start = source.indexOf("if (pageTapEnabled) return;");
  const end = source.indexOf("}, [pageTapEnabled]);", start);
  const effect = source.slice(start, end);
  assert.notEqual(start, -1);
  assert.match(effect, /pageTouchRef\.current = null/);
  assert.match(effect, /lastTouchOutcomeRef\.current = null/);
});

test("KeepAlive 隐藏：失败插画暂停健康度订阅，仅在前台重试", async () => {
  const source = await readFile(new URL("./StoryReader.tsx", import.meta.url), "utf8");
  assert.match(source, /<ReaderActivityContext\.Provider value=\{active\}>/);
  assert.match(source, /useAssetHealthNonce\(failed && readerActive\)/);
});

test("边缘返回：加载、错误和空内容状态同样挂载手势目标", async () => {
  const source = await readFile(new URL("./StoryReader.tsx", import.meta.url), "utf8");
  const loadingStart = source.indexOf("if (loading) {");
  const errorStart = source.indexOf("if (error) {", loadingStart);
  assert.match(source.slice(loadingStart, errorStart), /ref=\{readerRootRef\}/);
  assert.equal(
    source.match(/<ReaderStatusScreen\s+rootRef=\{readerRootRef\}/g)?.length,
    2
  );
  assert.match(source, /function ReaderStatusScreen[\s\S]*?<div\s+ref=\{rootRef\}/);
});

test("正文后处理：清理空白并合并连续同角色台词", () => {
  const result = postProcessSegments([
    { type: "dialogue", characterName: "阿米娅", text: "  第一行 \r\n\n 第二行 " },
    { type: "dialogue", characterName: "阿米娅", text: "第三行" },
  ]);
  assert.deepEqual(result, [
    { type: "dialogue", characterName: "阿米娅", text: "第一行\n第二行\n第三行" },
  ]);
});

test("正文后处理：空正文、音乐和空抉择不会生成空页", () => {
  const result = postProcessSegments([
    { type: "music", key: "bgm" },
    { type: "narration", text: " \n " },
    { type: "decision", options: [" ", "\t"] },
  ]);
  assert.deepEqual(result, []);
});

test("正文后处理：连续相同插画去重，不同插画保留", () => {
  const result = postProcessSegments([
    { type: "image", token: "bg_a" },
    { type: "image", token: "bg_a" },
    { type: "image", token: "bg_b" },
  ]);
  assert.deepEqual(result, [
    { type: "image", token: "bg_a" },
    { type: "image", token: "bg_b" },
  ]);
});
