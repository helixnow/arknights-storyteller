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

const { createLruCache, postProcessSegments } = await loadPureReader();

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
