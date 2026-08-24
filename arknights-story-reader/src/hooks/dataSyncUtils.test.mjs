import { test } from "node:test";
import assert from "node:assert/strict";

import {
  PROGRESS_DONE_LINGER_MS,
  PROGRESS_FAIL_LINGER_MS,
  PROGRESS_STALL_TIMEOUT_MS,
  describeImportTransferFailure,
  isDialogPluginUnavailableError,
  isTerminalSyncProgress,
  localizeDataError,
  progressPercent,
  syncProgressLingerMs,
} from "./dataSyncUtils.ts";

const progress = (phase, current, total, message = phase) => ({
  phase,
  current,
  total,
  message,
});

test("阶段满刻度不是整项同步完成", () => {
  assert.equal(isTerminalSyncProgress(progress("准备", 1, 1)), false);
  assert.equal(isTerminalSyncProgress(progress("下载", 100, 100)), false);
  assert.equal(isTerminalSyncProgress(progress("解压", 100, 100)), false);
});

test("完成阶段与索引终态才会结束进度", () => {
  assert.equal(isTerminalSyncProgress(progress("完成", 1, 1)), true);
  assert.equal(isTerminalSyncProgress(progress("索引", 0, 0)), false);
  assert.equal(isTerminalSyncProgress(progress("索引", 1, 1)), true);
});

test("非终态进度使用停更兜底而非完成停留", () => {
  assert.equal(syncProgressLingerMs(progress("下载", 100, 100)), PROGRESS_STALL_TIMEOUT_MS);
});

test("成功终态短留、索引失败通知长留", () => {
  assert.equal(
    syncProgressLingerMs(progress("完成", 1, 1, "同步完成")),
    PROGRESS_DONE_LINGER_MS
  );
  assert.equal(
    syncProgressLingerMs(progress("索引", 1, 1, "索引重建失败，请稍后重试")),
    PROGRESS_FAIL_LINGER_MS
  );
});

test("无总量时返回不确定进度", () => {
  assert.equal(progressPercent(0, 0), null);
  assert.equal(progressPercent(10, -1), null);
  assert.equal(progressPercent(Number.NaN, 100), null);
});

test("确定进度会四舍五入并钳在 0 到 100", () => {
  assert.equal(progressPercent(1, 3), 33);
  assert.equal(progressPercent(120, 100), 100);
  assert.equal(progressPercent(-5, 100), 0);
});

test("磁盘满错误与普通写入错误分开描述", () => {
  assert.match(localizeDataError("write failed: No space left on device"), /存储空间不足/);
  assert.match(localizeDataError("Failed to write zip data"), /暂存文件失败/);
});

test("权限错误给出权限提示", () => {
  assert.match(localizeDataError({ message: "Permission denied (os error 13)" }), /没有文件读写权限/);
});

test("用户取消不会被描述成网络故障", () => {
  assert.match(localizeDataError(new DOMException("operation was aborted", "AbortError")), /操作已取消/);
});

test("网络断开给出网络提示", () => {
  assert.match(localizeDataError("tcp connect error: connection refused"), /网络连接失败/);
});

test("Tauri 普通错误对象的 message 会被读取", () => {
  assert.match(localizeDataError({ message: "GitHub API returned status 403" }), /访问限流/);
});

test("未知错误透出前会隐藏 URL 与 token", () => {
  const message = localizeDataError(
    "backend exploded at https://private.invalid/file?token=secret token=secret",
    "同步失败"
  );
  assert.doesNotMatch(message, /private\.invalid|secret/);
  assert.match(message, /同步失败/);
});

test("空错误使用调用方兜底", () => {
  assert.equal(localizeDataError({}, "导入失败"), "导入失败");
});

test("分块失败且中止成功时只承诺自动清理、不谎称已经删除", () => {
  const message = describeImportTransferFailure("ENOSPC", "cleaned");
  assert.match(message, /存储空间不足.*暂存文件会由应用自动清理/);
  assert.doesNotMatch(message, /已清理|已经清理/);
});

test("分块失败且中止失败时不谎称清理完成", () => {
  const message = describeImportTransferFailure("Permission denied", "deferred");
  assert.match(message, /未能立即清理/);
  assert.match(message, /超时后自动释放/);
  assert.doesNotMatch(message, /已清理/);
});

test("只有插件注册或 ACL 缺失才回退第二选择器", () => {
  assert.equal(isDialogPluginUnavailableError("plugin dialog not registered"), true);
  assert.equal(isDialogPluginUnavailableError("dialog.open not allowed"), true);
  assert.equal(isDialogPluginUnavailableError("unknown plugin: dialog"), true);
});

test("真实插件 I/O 失败不会误弹第二选择器", () => {
  assert.equal(isDialogPluginUnavailableError("dialog plugin failed to read portal response"), false);
  assert.equal(isDialogPluginUnavailableError("user cancelled plugin dialog"), false);
  assert.equal(isDialogPluginUnavailableError("Permission denied"), false);
});
