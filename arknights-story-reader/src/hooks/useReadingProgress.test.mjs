import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const THROTTLE_MS = 1200;

function persistDelay(now, lastWriteAt) {
  return Math.min(THROTTLE_MS, Math.max(0, THROTTLE_MS - (now - lastWriteAt)));
}

test("进度持久化延时在墙钟回拨时仍封顶为一个节流窗口", () => {
  assert.equal(persistDelay(10_000, 10_500), THROTTLE_MS);
  assert.equal(persistDelay(10_600, 10_000), 600);
  assert.equal(persistDelay(12_000, 10_000), 0);
});

test("生产 hook 使用同一套双边钳位公式", () => {
  const source = readFileSync(new URL("./useReadingProgress.ts", import.meta.url), "utf8").replace(
    /\s+/g,
    " "
  );
  assert.match(
    source,
    /const delay = Math\.min\( PERSIST_THROTTLE_MS, Math\.max\(0, PERSIST_THROTTLE_MS - \(Date\.now\(\) - lastWriteRef\.current\)\) \);/
  );
});
