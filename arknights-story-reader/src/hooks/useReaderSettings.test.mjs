import { readFile } from "node:fs/promises";
import { test } from "node:test";
import assert from "node:assert/strict";
import ts from "typescript";

async function loadPureSettings() {
  const raw = await readFile(new URL("./useReaderSettings.ts", import.meta.url), "utf8");
  const prefix = raw
    .slice(0, raw.indexOf("export function useReaderSettings"))
    .replace(/^import[^\n]*\n/gm, "");
  const source = ts.transpileModule(prefix, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  return import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
}

const settingsModule = await loadPureSettings();
const {
  DEFAULT_READER_SETTINGS,
  mergeReaderSettings,
  readerSettingsEqual,
  sanitizeReaderSettings,
} = settingsModule;

test("设置：空值回落完整默认设置", () => {
  assert.deepEqual(sanitizeReaderSettings(null), DEFAULT_READER_SETTINGS);
});

test("设置：旧版数字字符串可迁移，越界值被钳住", () => {
  const value = sanitizeReaderSettings({
    fontSize: "99",
    lineHeight: "1.2",
    paragraphSpacing: "2.4",
    pageWidth: "-1",
  });
  assert.equal(value.fontSize, 32);
  assert.equal(value.lineHeight, 1.4);
  assert.equal(value.paragraphSpacing, 2.4);
  assert.equal(value.pageWidth, 60);
});

test("设置：null、布尔和空串不会被 Number 强转成滑杆下限", () => {
  const value = sanitizeReaderSettings({
    fontSize: null,
    lineHeight: true,
    pageWidth: "",
  });
  assert.equal(value.fontSize, DEFAULT_READER_SETTINGS.fontSize);
  assert.equal(value.lineHeight, DEFAULT_READER_SETTINGS.lineHeight);
  assert.equal(value.pageWidth, DEFAULT_READER_SETTINGS.pageWidth);
});

test("设置：NaN 与 Infinity 回落默认值", () => {
  const value = sanitizeReaderSettings({
    fontSize: Number.NaN,
    lineHeight: Number.POSITIVE_INFINITY,
  });
  assert.equal(value.fontSize, DEFAULT_READER_SETTINGS.fontSize);
  assert.equal(value.lineHeight, DEFAULT_READER_SETTINGS.lineHeight);
});

test("设置：存储值吸附到滑杆步进，显示与实际排版保持一致", () => {
  const value = sanitizeReaderSettings({
    fontSize: 18.6,
    lineHeight: 1.73,
    letterSpacing: 0.3,
    paragraphSpacing: 0.34,
    pageWidth: 73,
  });
  assert.equal(value.fontSize, 19);
  assert.equal(value.lineHeight, 1.7);
  assert.equal(value.letterSpacing, 0.5);
  assert.equal(value.paragraphSpacing, 0.3);
  assert.equal(value.pageWidth, 75);
});

test("设置：非法枚举与未知字体不能进入正文样式", () => {
  const value = sanitizeReaderSettings({
    fontFamily: "url(javascript:bad)",
    readingMode: "columns",
    theme: "neon",
    textAlign: "center",
  });
  assert.equal(value.fontFamily, DEFAULT_READER_SETTINGS.fontFamily);
  assert.equal(value.readingMode, "scroll");
  assert.equal(value.theme, "default");
  assert.equal(value.textAlign, "justify");
});

test("设置合并：只改主题时保留其余排版", () => {
  const base = sanitizeReaderSettings({
    fontSize: 24,
    lineHeight: 2.1,
    paragraphSpacing: 1.4,
    pageWidth: 75,
  });
  const next = mergeReaderSettings(base, { theme: "sepia" });
  assert.equal(next.theme, "sepia");
  assert.equal(next.fontSize, 24);
  assert.equal(next.lineHeight, 2.1);
  assert.equal(next.paragraphSpacing, 1.4);
  assert.equal(next.pageWidth, 75);
});

test("设置合并：局部坏值也会统一清洗", () => {
  const next = mergeReaderSettings(DEFAULT_READER_SETTINGS, {
    fontSize: -100,
    paragraphSpacing: 99,
  });
  assert.equal(next.fontSize, 14);
  assert.equal(next.paragraphSpacing, 3);
});

test("设置比较：相同字段忽略对象身份，真实字段变化可见", () => {
  const clone = { ...DEFAULT_READER_SETTINGS };
  assert.equal(readerSettingsEqual(DEFAULT_READER_SETTINGS, clone), true);
  assert.equal(
    readerSettingsEqual(DEFAULT_READER_SETTINGS, { ...clone, paragraphIndent: true }),
    false
  );
});

test("设置 storage：事件任务内同步 settingsRef，后续局部合并不回滚外部值", async () => {
  const source = await readFile(new URL("./useReaderSettings.ts", import.meta.url), "utf8");
  const storageStart = source.indexOf("const onStorage = (event: StorageEvent)");
  const storageEnd = source.indexOf('window.addEventListener("storage"', storageStart);
  const handler = source.slice(storageStart, storageEnd);
  assert.match(handler, /settingsRef\.current = next;\s+setSettings/);
});

test("设置 KeepAlive：隐藏时摘监听并冲刷，重新激活再对账", async () => {
  const source = await readFile(new URL("./useReaderSettings.ts", import.meta.url), "utf8");
  assert.match(source, /export function useReaderSettings\(active = true\)/);
  assert.match(source, /if \(!active\) \{[\s\S]*?flushPendingSettings\(\);[\s\S]*?return;/);
  assert.match(
    source,
    /if \(typeof window === "undefined" \|\| !active\) return;[\s\S]*?addEventListener\("storage"/
  );
});
