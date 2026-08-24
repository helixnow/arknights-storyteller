import { readFile } from "node:fs/promises";
import { test } from "node:test";
import assert from "node:assert/strict";

test("导览清理操作：清空与清除高亮同时满足 44px 最小触控宽高", async () => {
  const source = await readFile(
    new URL("./StoryInsightsPanel.tsx", import.meta.url),
    "utf8"
  );
  for (const label of ["清空", "清除高亮"]) {
    const labelIndex = new RegExp(`>\\s*${label}\\s*</button>`).exec(source)?.index ?? -1;
    assert.notEqual(labelIndex, -1, `missing ${label} button`);
    const buttonStart = source.lastIndexOf("<button", labelIndex);
    const button = source.slice(buttonStart, labelIndex);
    assert.match(button, /min-h-\[44px\]/);
    assert.match(button, /min-w-\[44px\]/);
  }
});
