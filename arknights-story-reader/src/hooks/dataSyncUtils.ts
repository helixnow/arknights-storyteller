export interface SyncProgressLike {
  phase: string;
  current: number;
  total: number;
  message: string;
}

export const PROGRESS_DONE_LINGER_MS = 2200;
export const PROGRESS_FAIL_LINGER_MS = 15_000;
export const PROGRESS_STALL_TIMEOUT_MS = 30_000;

/** A sync event reports the current phase, not whole-job completion. */
export function isTerminalSyncProgress(progress: SyncProgressLike): boolean {
  return (
    progress.phase === "完成" ||
    (progress.phase === "索引" && progress.total > 0 && progress.current >= progress.total)
  );
}

export function isFailureSyncProgress(progress: SyncProgressLike): boolean {
  return progress.message.includes("失败");
}

export function syncProgressLingerMs(progress: SyncProgressLike): number {
  if (!isTerminalSyncProgress(progress)) return PROGRESS_STALL_TIMEOUT_MS;
  return isFailureSyncProgress(progress) ? PROGRESS_FAIL_LINGER_MS : PROGRESS_DONE_LINGER_MS;
}

/** `null` means the backend has not supplied an honest scale yet. */
export function progressPercent(current: number, total: number): number | null {
  if (!Number.isFinite(current) || !Number.isFinite(total) || total <= 0) return null;
  return Math.min(100, Math.max(0, Math.round((current / total) * 100)));
}

export function errorText(error: unknown): string {
  const raw =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : error && typeof error === "object" && typeof (error as { message?: unknown }).message === "string"
          ? (error as { message: string }).message
          : String(error ?? "");
  const text = raw.trim();
  return text === "[object Object]" ? "" : text;
}

function redactSensitive(text: string): string {
  return text
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, "<链接>")
    .replace(/\b(token|key|signature|sig|secret|password)=[^\s&"']+/gi, "$1=<已隐藏>");
}

const BACKEND_ERROR_RULES: Array<[RegExp, string]> = [
  [/^NOT_INSTALLED$/i, "本机还没有剧情数据，请先同步或导入 ZIP。"],
  [
    /(?:No space left on device|disk (?:is )?full|ENOSPC|QuotaExceeded|os error 28|存储空间不足|磁盘空间不足)/i,
    "存储空间不足，临时文件未能完整写入。请清理空间后重试。",
  ],
  [
    /(?:Permission denied|EACCES|EPERM|Operation not permitted|AccessDenied|权限不足|没有权限)/i,
    "没有文件读写权限，请检查系统存储权限或数据目录权限后重试。",
  ],
  [
    /(?:AbortError|operation (?:was )?aborted|user cancell?ed|cancell?ed by (?:the )?user|操作已取消|用户已?取消)/i,
    "操作已取消，现有剧情数据不会被覆盖。",
  ],
  [/Failed to create http client/i, "网络组件初始化失败，请重启应用后重试。"],
  [/Failed to request latest commit/i, "无法连接 GitHub 获取版本信息，请检查网络或代理后重试。"],
  [/GitHub API returned status 403/i, "GitHub 接口触发访问限流，请稍后再试。"],
  [/GitHub API returned status (\d+)/i, "GitHub 接口返回异常状态 $1，请稍后再试。"],
  [/Failed to (?:parse commit response|read commit sha)/i, "GitHub 返回的数据无法解析，请稍后再试。"],
  [/Download returned status (\d+)/i, "下载失败，服务器返回状态 $1。"],
  [/Download failed/i, "下载失败，请检查网络或代理后重试。"],
  [/Failed to read download stream/i, "下载中断，请检查网络后重试。"],
  [
    /Failed to (?:create temp zip file|write zip data|flush zip file)|写入 ZIP 数据失败/i,
    "写入导入暂存文件失败，请确认存储空间与目录权限。",
  ],
  [/Failed to read zip archive/i, "无法解析 ZIP，压缩包可能已损坏或不是有效的数据包。"],
  [
    /Failed to (?:create (?:extract dir|parent directory|directory|file)|write file)/i,
    "解压写入失败，请确认磁盘空间与目录权限。",
  ],
  [/Failed to remove old data/i, "清理旧数据失败，请关闭占用数据目录的程序后重试。"],
  [
    /Failed to (?:create data directory|write version info)/i,
    "写入版本信息失败，请确认磁盘空间与目录权限。",
  ],
  [/Failed to (?:copy file|read directory|read entry|read file type)/i, "读写数据目录失败，请确认目录权限。"],
  [
    /Failed to (?:open|configure) .*database|Failed to (?:ensure index tables|init story index meta)/i,
    "索引数据库读写失败，可在设置中重建全文索引。",
  ],
  [/Failed to parse/i, "数据解析失败，可能是数据包格式与当前版本不匹配。"],
  [/Failed to join .*task/i, "后台任务异常结束，请重试。"],
  [/Invalid data directory/i, "数据目录无效，请重新安装应用后重试。"],
  [
    /error sending request|dns error|connection (?:refused|reset|closed|aborted)|timed? ?out|tcp connect error|certificate|ECONN|ENOTFOUND/i,
    "网络连接失败，请检查网络或代理后重试。",
  ],
];

export function localizeDataError(error: unknown, fallback = "操作失败"): string {
  const text = errorText(error);
  if (!text) return fallback;
  for (const [pattern, template] of BACKEND_ERROR_RULES) {
    const match = text.match(pattern);
    if (match) {
      return template.replace(/\$(\d)/g, (_, index: string) => match[Number(index)] ?? "");
    }
  }
  const safeText = redactSensitive(text);
  return /[\u4e00-\u9fff]/.test(text) ? safeText : `${fallback}：${safeText}`;
}

export type SyncDialogCloseAction = "block" | "settle-parked" | "background" | "idle";

/**
 * 同步对话框的关闭策略：确认框还在时不能关；真实同步/导入只把对话框
 * 收到后台；等文件选择器时要收尾寄存锁。
 */
export function planSyncDialogClose(input: {
  busy: boolean;
  preparingSync: boolean;
  preparingImport: boolean;
}): SyncDialogCloseAction {
  if (input.preparingSync) return "block";
  if (input.busy) return "background";
  if (input.preparingImport) return "settle-parked";
  return "idle";
}

export function shouldAbortImportTransfer(cancelled: boolean): boolean {
  return cancelled === true;
}

export type ImportCleanupResult = "cleaned" | "deferred";

export function describeImportTransferFailure(
  error: unknown,
  cleanup: ImportCleanupResult
): string {
  const reason = localizeDataError(error, "导入失败");
  return cleanup === "cleaned"
    ? `${reason} 未完成的导入暂存文件会由应用自动清理。`
    : `${reason} 导入暂存文件未能立即清理，应用会在超时后自动释放；清理空间或权限后再重试。`;
}

/**
 * Only capability/registration failures justify opening the browser picker.
 * A generic message containing the word "plugin" may be a real I/O failure.
 */
export function isDialogPluginUnavailableError(error: unknown): boolean {
  const text = errorText(error);
  return /not allowed|unknown plugin|plugin [^:]*not (?:found|registered)|plugin [^:]*unavailable|dialog plugin (?:is )?disabled/i.test(
    text
  );
}
