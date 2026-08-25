import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { createDataJobLockStore } from "./dataJobLock.ts";

const syncDialogSource = readFileSync(
  new URL("../components/SyncDialog.tsx", import.meta.url),
  "utf8"
);
const settingsSource = readFileSync(
  new URL("../components/Settings.tsx", import.meta.url),
  "utf8"
);

test("同步、导入、索引和更新共用一把互斥锁", () => {
  const store = createDataJobLockStore();
  const releaseImport = store.acquire("import");
  assert.equal(typeof releaseImport, "function");
  assert.equal(store.getSnapshot(), "import");
  assert.equal(store.acquire("sync"), null);
  assert.equal(store.acquire("index"), null);
  assert.equal(store.acquire("update"), null);
  releaseImport();
  assert.equal(store.getSnapshot(), null);
});

test("锁变更会通知订阅者，退订后停止通知", () => {
  const store = createDataJobLockStore();
  const snapshots = [];
  const unsubscribe = store.subscribe(() => snapshots.push(store.getSnapshot()));
  const release = store.acquire("import");
  release();
  unsubscribe();
  store.acquire("sync");
  assert.deepEqual(snapshots, ["import", null]);
});

test("交接释放函数幂等且不能释放后来同类任务", () => {
  const store = createDataJobLockStore();
  const first = store.acquire("import");
  first();
  const second = store.acquire("import");
  first();
  assert.equal(store.getSnapshot(), "import");
  second();
  assert.equal(store.getSnapshot(), null);
});

test("等待者在文件选择器交还锁后原子抢占", async () => {
  const store = createDataJobLockStore();
  const releasePicker = store.acquire("import");
  const waiting = store.acquireWhenIdle("update", 100);
  assert.equal(store.getSnapshot(), "import");
  releasePicker();
  const releaseUpdate = await waiting;
  assert.equal(typeof releaseUpdate, "function");
  assert.equal(store.getSnapshot(), "update");
  releaseUpdate();
});

test("迟到文件若锁已被等待者抢走会被明确拒绝", async () => {
  const store = createDataJobLockStore();
  const releasePicker = store.acquire("import");
  const waiting = store.acquireWhenIdle("update", 100);
  releasePicker();
  const releaseUpdate = await waiting;
  assert.equal(store.acquire("import"), null);
  releaseUpdate();
  const releaseLateImport = store.acquire("import");
  assert.equal(typeof releaseLateImport, "function");
  releaseLateImport();
});

test("等待超时返回 null 且不泄漏任务锁", async () => {
  const store = createDataJobLockStore();
  const releaseSync = store.acquire("sync");
  const waited = await store.acquireWhenIdle("update", 5);
  assert.equal(waited, null);
  assert.equal(store.getSnapshot(), "sync");
  releaseSync();
  assert.equal(store.getSnapshot(), null);
});

test("多个等待者被同一次释放唤醒时只有一个拿到锁", async () => {
  const store = createDataJobLockStore();
  const releaseSync = store.acquire("sync");
  const first = store.acquireWhenIdle("update", 100);
  const second = store.acquireWhenIdle("import", 10);
  releaseSync();
  const firstRelease = await first;
  assert.equal(store.getSnapshot(), "update");
  assert.equal(await second, null);
  firstRelease();
  assert.equal(store.getSnapshot(), null);
});

test("文件选择器 cancel 事件立即释放寄存导入锁与准备态", () => {
  const cancelHandler =
    /onCancel=\{\(\) => \{\s*takePendingImportJob\(\)\?\.\(\);\s*setPreparingImport\(false\);/;
  assert.match(syncDialogSource, cancelHandler);
  assert.match(settingsSource, cancelHandler);
});

test("等待文件期间关闭会收尾寄存锁，真实导入仍禁止关闭", () => {
  assert.match(
    syncDialogSource,
    /if \(busy \|\| preparingSync \|\| \(preparingImport && importing\)\) return;/
  );
  assert.match(syncDialogSource, /settleParkedImport\(\);\s*resetProgress\(\);/);
});
