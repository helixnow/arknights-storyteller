import { useEffect } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { invoke } from "@tauri-apps/api/core";
import { acquireDataJobWhenIdle } from "@/hooks/useDataSyncManager";
import {
  classifyAndroidInstallResponse,
  compareVersions,
  describeUpdateError,
  normalizeAndroidDownloadProgress,
  parseAndroidManifest,
  redactSensitive,
  validateAndroidFeedUrl,
  type AndroidManifestData,
  type UpdateIssue,
} from "@/hooks/appUpdaterUtils";

export {
  compareVersions,
  describeUpdateError,
  redactSensitive,
} from "@/hooks/appUpdaterUtils";
export type {
  UpdateIssue,
  UpdateIssueKind,
  UpdateIssueTone,
} from "@/hooks/appUpdaterUtils";

const IS_DEV = import.meta.env.DEV;

/**
 * 诊断日志只在开发构建输出。更新 / 同步流程打点很密，正式包里既刷屏又会把
 * 更新源地址暴露在控制台里。真正异常的分支仍然走 console.error。
 */
export function devLog(...args: unknown[]): void {
  if (IS_DEV) console.info(...args);
}

export function devWarn(...args: unknown[]): void {
  if (IS_DEV) console.warn(...args);
}

function isTauriEnvironment(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export type RuntimePlatform = "desktop" | "android" | "unknown";

export function detectRuntimePlatform(): RuntimePlatform {
  if (!isTauriEnvironment()) return "unknown";
  if (typeof navigator !== "undefined" && /Android/i.test(navigator.userAgent ?? "")) {
    return "android";
  }
  return "desktop";
}

type PluginUpdaterModule = typeof import("@tauri-apps/plugin-updater");
type PluginUpdateHandle = Awaited<ReturnType<PluginUpdaterModule["check"]>>;

export type AndroidUpdateManifest = AndroidManifestData;

export interface DesktopUpdateAvailable {
  platform: "desktop";
  currentVersion: string;
  availableVersion: string;
  notes?: string | null;
  releaseDate?: string | null;
  handle: NonNullable<PluginUpdateHandle>;
}

export interface AndroidUpdateAvailable {
  platform: "android";
  currentVersion: string;
  manifest: AndroidUpdateManifest;
}

export type UpdateAvailability = DesktopUpdateAvailable | AndroidUpdateAvailable;

export type AndroidInstallResponse = {
  status?: string;
  needsPermission?: boolean;
};

/** 桌面端下载进度的归一化形态，屏蔽 plugin-updater 的增量事件差异。 */
export interface UpdateDownloadProgress {
  downloadedBytes: number;
  /** 服务端未给出 Content-Length 时为 null。 */
  totalBytes: number | null;
  /** 0-100；总长度未知时为 null。 */
  percent: number | null;
  done: boolean;
}

/**
 * 更新流程里唯一允许在正式包落日志的出口：只打脱敏后的一行文本。
 * 原始 error 对象（可能带更新源地址、请求头）只在开发构建里展开。
 */
function logUpdateIssue(scope: string, issue: UpdateIssue, error: unknown): void {
  if (IS_DEV) {
    if (issue.tone === "error") console.error(`${scope} ${issue.message}`, error);
    else console.info(`${scope} ${issue.message}`, error);
    return;
  }
  if (issue.tone === "error") {
    console.error(`${scope} ${redactSensitive(issue.message)}`);
  }
}

type ManifestOptions = {
  suppressErrors?: boolean;
  timeoutMs?: number;
};

const MANIFEST_TIMEOUT_MS = 10_000;

async function fetchAndroidManifest(options: ManifestOptions = {}): Promise<AndroidUpdateManifest | null> {
  const { suppressErrors = false, timeoutMs = MANIFEST_TIMEOUT_MS } = options;
  const feed = import.meta.env.VITE_ANDROID_UPDATE_FEED as string | undefined;
  if (!feed) {
    if (!suppressErrors) {
      throw new Error("未配置安卓更新源 VITE_ANDROID_UPDATE_FEED");
    }
    devLog("[Updater] 未配置 VITE_ANDROID_UPDATE_FEED，跳过安卓更新检查");
    return null;
  }
  // 更新源挂掉时不能让请求一直吊着，否则启动期的自动检查会一直占着连接。
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const manifestUrl = validateAndroidFeedUrl(feed);
    const response = await fetch(manifestUrl, { cache: "no-store", signal: controller.signal });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    return parseAndroidManifest(await response.json());
  } catch (error) {
    const normalized =
      error instanceof DOMException && error.name === "AbortError"
        ? new Error("请求更新信息超时")
        : error instanceof Error
        ? error
        : new Error(String(error));
    if (!suppressErrors) {
      throw normalized;
    }
    devWarn("[Updater] 获取安卓更新信息失败", normalized);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

let fallbackDialogQueue: Promise<void> = Promise.resolve();

function enqueueFallbackDialog(
  message: string,
  options: {
    title: string;
    kind: "info" | "warning" | "error";
    messageOnly?: boolean;
  }
): Promise<boolean> {
  if (typeof document === "undefined" || !document.body) {
    try {
      return Promise.resolve(options.messageOnly ? (window.alert(message), true) : window.confirm(message));
    } catch {
      return Promise.resolve(false);
    }
  }

  const show = () =>
    new Promise<boolean>((resolve) => {
      const previouslyFocused = document.activeElement as HTMLElement | null;
      const previousOverflow = document.body.style.overflow;
      const overlay = document.createElement("div");
      const dialog = document.createElement("div");
      const title = document.createElement("h2");
      const body = document.createElement("p");
      const actions = document.createElement("div");
      const cancel = document.createElement("button");
      const confirm = document.createElement("button");
      const id = `safe-dialog-${Date.now()}-${Math.random().toString(36).slice(2)}`;

      overlay.dataset.safeDialog = "true";
      Object.assign(overlay.style, {
        position: "fixed",
        inset: "0",
        zIndex: "2147483647",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding:
          "max(16px, env(safe-area-inset-top, 0px)) max(16px, env(safe-area-inset-right, 0px)) max(16px, env(safe-area-inset-bottom, 0px)) max(16px, env(safe-area-inset-left, 0px))",
        background: "rgba(0, 0, 0, 0.55)",
      });
      dialog.setAttribute("role", "dialog");
      dialog.setAttribute("aria-modal", "true");
      dialog.setAttribute("aria-labelledby", `${id}-title`);
      dialog.setAttribute("aria-describedby", `${id}-body`);
      dialog.tabIndex = -1;
      Object.assign(dialog.style, {
        width: "min(100%, 420px)",
        maxHeight: "calc(100dvh - 32px)",
        overflowY: "auto",
        border: "1px solid hsl(var(--color-border))",
        borderRadius: "14px",
        padding: "20px",
        background: "hsl(var(--color-card))",
        color: "hsl(var(--color-card-foreground))",
        boxShadow: "0 20px 60px rgba(0, 0, 0, 0.35)",
      });
      title.id = `${id}-title`;
      title.textContent = options.title;
      Object.assign(title.style, { margin: "0", fontSize: "18px", fontWeight: "600" });
      body.id = `${id}-body`;
      body.textContent = message;
      Object.assign(body.style, {
        margin: "12px 0 20px",
        fontSize: "16px",
        lineHeight: "1.6",
        whiteSpace: "pre-wrap",
        overflowWrap: "anywhere",
      });
      Object.assign(actions.style, {
        display: "flex",
        justifyContent: "flex-end",
        flexWrap: "wrap",
        gap: "10px",
      });
      for (const button of [cancel, confirm]) {
        button.type = "button";
        Object.assign(button.style, {
          minWidth: "88px",
          minHeight: "44px",
          borderRadius: "9px",
          padding: "8px 16px",
          border: "1px solid hsl(var(--color-border))",
          font: "inherit",
          fontSize: "16px",
          cursor: "pointer",
        });
      }
      cancel.textContent = "取消";
      Object.assign(cancel.style, {
        background: "hsl(var(--color-background))",
        color: "hsl(var(--color-foreground))",
      });
      confirm.textContent = options.messageOnly ? "知道了" : "确定";
      Object.assign(confirm.style, {
        background:
          options.kind === "error"
            ? "hsl(var(--color-destructive))"
            : "hsl(var(--color-primary))",
        color:
          options.kind === "error"
            ? "hsl(var(--color-destructive-foreground))"
            : "hsl(var(--color-primary-foreground))",
      });

      let settled = false;
      const finish = (result: boolean) => {
        if (settled) return;
        settled = true;
        document.removeEventListener("keydown", onKeyDown, true);
        overlay.remove();
        document.body.style.overflow = previousOverflow;
        if (previouslyFocused && document.contains(previouslyFocused)) previouslyFocused.focus();
        resolve(result);
      };
      const onKeyDown = (event: KeyboardEvent) => {
        if (event.key === "Escape" || event.key === "BrowserBack" || event.key === "GoBack") {
          event.preventDefault();
          event.stopImmediatePropagation();
          finish(options.messageOnly === true);
          return;
        }
        if (event.key !== "Tab") return;
        const focusable = options.messageOnly ? [confirm] : [cancel, confirm];
        const current = document.activeElement;
        const index = focusable.indexOf(current as HTMLButtonElement);
        event.preventDefault();
        const next = event.shiftKey
          ? (index <= 0 ? focusable.length : index) - 1
          : (index + 1) % focusable.length;
        focusable[next].focus();
      };

      cancel.addEventListener("click", () => finish(false));
      confirm.addEventListener("click", () => finish(true));
      overlay.addEventListener("click", (event) => {
        if (event.target === overlay) finish(options.messageOnly === true);
      });
      actions.append(...(options.messageOnly ? [confirm] : [cancel, confirm]));
      dialog.append(title, body, actions);
      overlay.append(dialog);
      document.body.append(overlay);
      document.body.style.overflow = "hidden";
      document.addEventListener("keydown", onKeyDown, true);
      (options.messageOnly ? confirm : cancel).focus();
    });

  const result = fallbackDialogQueue.then(show, show);
  fallbackDialogQueue = result.then(
    () => undefined,
    () => undefined
  );
  return result;
}

/**
 * Native dialog first; if the mobile plugin is unavailable, use an in-app
 * modal instead of trusting WebView `confirm`, which may silently return false.
 */
export async function safeConfirm(
  message: string,
  options: { title?: string; kind?: "info" | "warning" | "error" } = {}
): Promise<boolean> {
  const { title = "请确认", kind = "info" } = options;
  try {
    const dialog = await import("@tauri-apps/plugin-dialog");
    if (typeof dialog.confirm === "function") {
      return await dialog.confirm(message, { title, kind });
    }
    if (typeof dialog.ask === "function") {
      return await dialog.ask(message, { title, kind });
    }
  } catch (error) {
    devLog("[Dialog] 对话框插件不可用，回退到应用内确认框", error);
  }
  return enqueueFallbackDialog(message, { title, kind });
}

/**
 * 提示对话框，回退策略与 safeConfirm 相同。
 * 它本身就是兜底反馈，展示失败只记日志，绝不能再抛错打断调用方。
 */
export async function safeMessage(
  text: string,
  options: { title?: string; kind?: "info" | "warning" | "error" } = {}
): Promise<void> {
  const { title = "提示", kind = "info" } = options;
  try {
    const dialog = await import("@tauri-apps/plugin-dialog");
    if (typeof dialog.message === "function") {
      await dialog.message(text, { title, kind });
      return;
    }
  } catch (error) {
    devLog("[Dialog] 对话框插件不可用，回退到应用内提示框", error);
  }
  await enqueueFallbackDialog(text, { title, kind, messageOnly: true });
}

export async function checkDesktopUpdate(currentVersionOverride?: string): Promise<DesktopUpdateAvailable | null> {
  const platform = detectRuntimePlatform();
  if (platform !== "desktop") {
    return null;
  }

  const { check } = await import("@tauri-apps/plugin-updater");
  const update = await check();
  if (!update) {
    return null;
  }

  const currentVersion = currentVersionOverride ?? (await getVersion());
  return {
    platform: "desktop",
    currentVersion,
    availableVersion: update.version,
    notes: (update as { notes?: string | null }).notes ?? update.body ?? null,
    releaseDate: (update as { date?: string | null }).date ?? null,
    handle: update,
  };
}

export async function installDesktopUpdate(
  update: DesktopUpdateAvailable,
  onProgress?: (progress: UpdateDownloadProgress) => void,
  options: { relaunch?: boolean } = {}
): Promise<void> {
  const { relaunch = true } = options;

  let totalBytes: number | null = null;
  let downloadedBytes = 0;

  await update.handle.downloadAndInstall((event) => {
    if (!onProgress) return;
    switch (event.event) {
      case "Started":
        totalBytes = event.data.contentLength ?? null;
        downloadedBytes = 0;
        break;
      case "Progress":
        downloadedBytes += event.data.chunkLength ?? 0;
        break;
      case "Finished":
        if (totalBytes !== null) downloadedBytes = totalBytes;
        break;
    }
    const total: number | null = totalBytes;
    onProgress({
      downloadedBytes,
      totalBytes: total,
      percent: total && total > 0 ? Math.min(100, Math.round((downloadedBytes / total) * 100)) : null,
      done: event.event === "Finished",
    });
  });

  if (relaunch) {
    const { relaunch: relaunchApp } = await import("@tauri-apps/plugin-process");
    await relaunchApp();
  }
}

export async function checkAndroidUpdate(currentVersionOverride?: string): Promise<AndroidUpdateAvailable | null> {
  const platform = detectRuntimePlatform();
  if (platform !== "android") {
    return null;
  }

  const manifest = await fetchAndroidManifest();
  const currentVersion = currentVersionOverride ?? (await getVersion());
  if (!manifest) {
    return null;
  }

  if (compareVersions(manifest.version, currentVersion) <= 0) {
    return null;
  }

  return {
    platform: "android",
    currentVersion,
    manifest,
  };
}

let androidInstallInFlight = false;

export async function installAndroidUpdate(
  update: AndroidUpdateAvailable,
  onProgress?: (progress: UpdateDownloadProgress) => void
): Promise<AndroidInstallResponse> {
  if (androidInstallInFlight) {
    throw new Error("已有更新下载正在进行，请等待完成后再试");
  }
  androidInstallInFlight = true;
  let unlisten: (() => void) | null = null;
  try {
    if (onProgress) {
      try {
        const { listen } = await import("@tauri-apps/api/event");
        // Listener registration itself is async. Await it before invoking the
        // plugin so the first (and cached-APK final) event cannot race past UI.
        unlisten = await listen<unknown>("apk-progress", ({ payload }) => {
          const normalized = normalizeAndroidDownloadProgress(payload);
          if (normalized) onProgress(normalized);
        });
      } catch (error) {
        // Progress is best-effort; inability to subscribe must not prevent an
        // otherwise valid install.
        devWarn("[Updater] 监听 Android 下载进度失败", error);
      }
    }
    const response = await invoke<AndroidInstallResponse>("plugin:apk-updater|download_and_install", {
      url: update.manifest.url,
      fileName: update.manifest.fileName ?? null,
    });
    // A resolved invoke is not by itself proof that Android opened anything.
    // Reject malformed/unknown plugin replies instead of declaring success.
    classifyAndroidInstallResponse(response);
    return response;
  } finally {
    unlisten?.();
    androidInstallInFlight = false;
  }
}

export async function openAndroidInstallPermissionSettings(): Promise<void> {
  await invoke("plugin:apk-updater|open_install_permission_settings");
}

/**
 * 启动期自动更新整个会话只跑一次。用模块级 flag 而不是组件内的 ref：
 * StrictMode 的双挂载、路由重建、乃至第二处误调 `useAppUpdater()`，
 * 都不该再弹一次「发现更新」或再冒一条同样的提示。
 */
let autoUpdateFlowStarted = false;

/**
 * 用户已确认安装、但任务锁被占（升级后首启很容易撞上自动索引重建，一跑就是
 * 几分钟）时的最长等待。立刻放弃会把用户刚点的「安装」静默吞掉；无限等又会
 * 让「立即安装」变成不知何时的突然重启。等不到就放弃，设置页里仍可手动安装。
 */
const INSTALL_LOCK_WAIT_MS = 5 * 60_000;

export function useAppUpdater() {
  useEffect(() => {
    if (autoUpdateFlowStarted || !isTauriEnvironment()) return;
    autoUpdateFlowStarted = true;

    let cancelled = false;
    const isCancelled = () => cancelled;

    const runDesktopUpdateFlow = async () => {
      // 用户点过「安装」之后的失败必须弹出来说清楚——否则确认框一关就没有任何
      // 下文，用户会以为更新已经在装了。确认前的检查失败仍然只记日志。
      let userConfirmedInstall = false;
      try {
        const updateInfo = await checkDesktopUpdate();
        if (!updateInfo || isCancelled()) return;

        const shouldInstall = await safeConfirm(
          `检测到新版本 ${updateInfo.availableVersion}，是否立即下载并安装更新？`,
          { title: "发现更新" }
        );
        if (!shouldInstall || isCancelled()) {
          devLog("[Updater] 用户取消更新");
          return;
        }
        userConfirmedInstall = true;

        // 安装完会立刻重启进程：这时候若正在同步/导入，数据目录会写到一半被砍。
        // 锁被占时等一会儿再装，而不是把用户刚点的确认静默丢掉。
        const releaseJob = await acquireDataJobWhenIdle("update", INSTALL_LOCK_WAIT_MS);
        if (!releaseJob) {
          devLog("[Updater] 数据任务长时间未结束，跳过本次自动安装");
          if (!isCancelled()) {
            await safeMessage("后台数据任务较久未结束，本次自动更新已跳过，可稍后在设置页手动安装。", {
              title: "更新未安装",
              kind: "warning",
            });
          }
          return;
        }
        if (isCancelled()) {
          releaseJob();
          return;
        }
        try {
          devLog("[Updater] 开始下载更新", updateInfo.availableVersion);
          await installDesktopUpdate(updateInfo, (progress) => {
            if (isCancelled() || !progress.done) return;
            devLog("[Updater] 更新包下载完成", progress.downloadedBytes);
          });
        } finally {
          releaseJob();
        }
      } catch (error) {
        if (isCancelled()) return;
        // 缺少 `updater:allow-check` 权限、未配置更新源之类都是打包配置问题，
        // 启动期没必要在控制台刷红。
        const issue = describeUpdateError(
          error,
          userConfirmedInstall
            ? "更新安装未完成，可稍后重试。"
            : "本次更新检查没有完成，可稍后再试。"
        );
        logUpdateIssue("[Updater] 桌面更新未完成：", issue, error);
        // 用户自己取消（含 Windows UAC 拒绝）不用再提醒一遍。
        if (userConfirmedInstall && issue.kind !== "cancelled") {
          await safeMessage(issue.message, {
            title: "更新未完成",
            kind: issue.tone === "error" ? "error" : "warning",
          });
        }
      }
    };

    const runAndroidUpdateFlow = async () => {
      let userConfirmedInstall = false;
      try {
        const manifest = await fetchAndroidManifest({ suppressErrors: true });
        if (!manifest || isCancelled()) return;

        const currentVersion = await getVersion();
        if (isCancelled()) return;

        if (compareVersions(manifest.version, currentVersion) <= 0) {
          devLog("[Updater] 安卓端已是最新版本", currentVersion, manifest.version);
          return;
        }

        const shouldInstall = await safeConfirm(
          `检测到新版本 ${manifest.version}，是否立即下载安装？`,
          { title: "发现更新" }
        );

        if (!shouldInstall || isCancelled()) {
          devLog("[Updater] 用户取消安卓更新");
          return;
        }
        userConfirmedInstall = true;

        const releaseJob = await acquireDataJobWhenIdle("update", INSTALL_LOCK_WAIT_MS);
        if (!releaseJob) {
          devLog("[Updater] 数据任务长时间未结束，跳过本次自动安装");
          if (!isCancelled()) {
            await safeMessage("后台数据任务较久未结束，本次自动更新已跳过，可稍后在设置页手动安装。", {
              title: "更新未安装",
              kind: "warning",
            });
          }
          return;
        }
        if (isCancelled()) {
          releaseJob();
          return;
        }
        let response: AndroidInstallResponse;
        try {
          response = await installAndroidUpdate({
            platform: "android",
            currentVersion,
            manifest,
          });
        } finally {
          releaseJob();
        }

        if (isCancelled()) return;

        if (response?.needsPermission) {
          devLog("[Updater] 需要开启未知来源安装权限");
          // 不解释就直接跳系统设置，用户只会一头雾水；而且启动期自动流程本次
          // 会话不会再跑，授权后必须指回设置页手动装。
          await safeMessage("需要先允许本应用安装未知来源应用。即将打开系统授权界面，授权后请在设置页重新点击安装更新。", {
            title: "需要安装权限",
            kind: "warning",
          });
          await openAndroidInstallPermissionSettings();
        } else {
          devLog("[Updater] 已触发 APK 安装流程", response?.status);
        }
      } catch (error) {
        if (isCancelled()) return;
        const issue = describeUpdateError(
          error,
          userConfirmedInstall
            ? "更新安装未完成，可稍后重试。"
            : "本次更新检查没有完成，可稍后再试。"
        );
        logUpdateIssue("[Updater] 安卓更新未完成：", issue, error);
        if (userConfirmedInstall && issue.kind !== "cancelled") {
          await safeMessage(issue.message, {
            title: "更新未完成",
            kind: issue.tone === "error" ? "error" : "warning",
          });
        }
      }
    };

    const runUpdateFlow = async () => {
      const platform = detectRuntimePlatform();
      if (platform === "android") {
        await runAndroidUpdateFlow();
      } else if (platform === "desktop") {
        await runDesktopUpdateFlow();
      }
    };

    void runUpdateFlow();

    return () => {
      cancelled = true;
    };
  }, []);
}
