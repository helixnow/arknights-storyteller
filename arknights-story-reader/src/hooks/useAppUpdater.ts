import { useEffect } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { invoke } from "@tauri-apps/api/core";
import { acquireDataJob } from "@/hooks/useDataSyncManager";

const IS_DEV = import.meta.env.DEV;

/**
 * 更新源地址、下载直链、签名参数都不该出现在正式包的控制台里（用户随手截个图
 * 就把私有分发地址带出去了），界面文案里同样不该出现。
 */
export function redactSensitive(text: string): string {
  return text
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, "<链接>")
    .replace(/\b(token|key|signature|sig|secret|password)=[^\s&"']+/gi, "$1=<已隐藏>");
}

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

export type AndroidUpdateManifest = {
  version: string;
  url: string;
  fileName?: string | null;
  notes?: string | null;
};

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

const enum CompareResult {
  Greater = 1,
  Equals = 0,
  Less = -1,
}

export function compareVersions(a: string, b: string): CompareResult {
  const normalize = (input: string) => input.trim().replace(/^v/i, "");
  const partsA = normalize(a).split(".");
  const partsB = normalize(b).split(".");
  const length = Math.max(partsA.length, partsB.length);
  for (let i = 0; i < length; i += 1) {
    const segmentA = parseInt(partsA[i] ?? "0", 10);
    const segmentB = parseInt(partsB[i] ?? "0", 10);
    if (Number.isNaN(segmentA) || Number.isNaN(segmentB)) {
      return CompareResult.Equals;
    }
    if (segmentA > segmentB) return CompareResult.Greater;
    if (segmentA < segmentB) return CompareResult.Less;
  }
  return CompareResult.Equals;
}

export type UpdateIssueTone = "info" | "warning" | "error";

/**
 * 失败原因分类。调用方要靠它区分「用户自己取消」「网络不通」「签名不对」——
 * 前者根本不算错误，后者必须当成安全事件对待，不能混成同一条红字。
 */
export type UpdateIssueKind =
  | "unsupported"
  | "not-configured"
  | "cancelled"
  | "signature"
  | "feed"
  | "network"
  | "unknown";

export interface UpdateIssue {
  tone: UpdateIssueTone;
  kind: UpdateIssueKind;
  message: string;
}

/**
 * 更新检查失败在绝大多数情况下都不是用户能修的问题（没打更新签名、没配更新源、
 * 网络不通），所以只有签名校验这类真正危险的分支才用 error 语气。
 */
const UPDATE_ERROR_RULES: Array<{ test: RegExp; tone: UpdateIssueTone; kind: UpdateIssueKind; message: string }> = [
  {
    test: /并非\s*Tauri|not a tauri/i,
    tone: "info",
    kind: "unsupported",
    message: "当前环境不是桌面/移动客户端，无法检查更新。",
  },
  {
    test: /VITE_ANDROID_UPDATE_FEED|未配置安卓更新源/i,
    tone: "info",
    kind: "not-configured",
    message: "当前构建未配置更新源，请前往项目发布页手动下载新版本。",
  },
  {
    test: /not allowed|unknown plugin|plugin .*not (?:found|registered)|updater.*disabled/i,
    tone: "info",
    kind: "not-configured",
    message: "当前安装包未启用自动更新，请前往项目发布页手动下载新版本。",
  },
  {
    // 用户自己点了「取消」/UAC 拒绝（Windows 1223），不是故障。
    test: /user cancell?ed|cancell?ed by (?:the )?user|操作已取消|用户已?取消|os error 1223/i,
    tone: "info",
    kind: "cancelled",
    message: "更新已取消，可稍后在设置里重新检查。",
  },
  {
    test: /signature|pubkey|public key|verif/i,
    tone: "error",
    kind: "signature",
    message: "更新包签名校验失败，出于安全考虑已中止安装。",
  },
  {
    test: /could not fetch a valid release|releases?\.json|manifest|缺少 version|HTTP 4\d\d|HTTP 5\d\d/i,
    tone: "warning",
    kind: "feed",
    message: "更新源暂时不可用，请稍后再试。",
  },
  {
    test: /network|failed to fetch|error sending request|timed? ?out|超时|dns|connect|ECONN|ENOTFOUND|offline|网络/i,
    tone: "warning",
    kind: "network",
    message: "无法连接更新服务器，请检查网络后重试。",
  },
];

/** 把更新流程里的异常翻译成一句不吓人的中文；兜底透出的原文先脱敏。 */
export function describeUpdateError(
  error: unknown,
  fallback = "本次更新检查没有完成，可稍后再试。"
): UpdateIssue {
  const raw = error instanceof Error ? error.message : String(error ?? "");
  const text = raw.trim();
  for (const rule of UPDATE_ERROR_RULES) {
    if (rule.test.test(text)) {
      return { tone: rule.tone, kind: rule.kind, message: rule.message };
    }
  }
  if (!text) return { tone: "warning", kind: "unknown", message: fallback };
  return { tone: "warning", kind: "unknown", message: `${fallback}（${redactSensitive(text)}）` };
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
    const response = await fetch(feed, { cache: "no-store", signal: controller.signal });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    const data = (await response.json()) as AndroidUpdateManifest;
    if (!data?.version || !data?.url) {
      throw new Error("更新 manifest 缺少 version 或 url 字段");
    }
    return data;
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

/**
 * 确认对话框。macOS / iOS 的 WKWebView 不实现 JS 的 window.confirm（直接静默
 * 返回 false），所以优先走 plugin-dialog；Android 上该插件未注册，调用会被 ACL
 * 拒绝，此时再回退到 window.confirm（Android WebView 支持）。
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
    devLog("[Dialog] 对话框插件不可用，回退到 window.confirm", error);
  }
  try {
    return window.confirm(message);
  } catch (error) {
    devWarn("[Dialog] window.confirm 不可用", error);
    return false;
  }
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

  if (compareVersions(manifest.version, currentVersion) <= CompareResult.Equals) {
    return null;
  }

  return {
    platform: "android",
    currentVersion,
    manifest,
  };
}

export async function installAndroidUpdate(update: AndroidUpdateAvailable): Promise<AndroidInstallResponse> {
  const response = await invoke<AndroidInstallResponse>("plugin:apk-updater|download_and_install", {
    url: update.manifest.url,
    fileName: update.manifest.fileName ?? null,
  });
  return response;
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

export function useAppUpdater() {
  useEffect(() => {
    if (autoUpdateFlowStarted || !isTauriEnvironment()) return;
    autoUpdateFlowStarted = true;

    let cancelled = false;
    const isCancelled = () => cancelled;

    const runDesktopUpdateFlow = async () => {
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

        // 安装完会立刻重启进程：这时候若正在同步/导入，数据目录会写到一半被砍。
        const releaseJob = acquireDataJob("update");
        if (!releaseJob) {
          devLog("[Updater] 有数据任务在跑，跳过本次自动安装");
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
        logUpdateIssue("[Updater] 桌面更新未完成：", describeUpdateError(error), error);
      }
    };

    const runAndroidUpdateFlow = async () => {
      try {
        const manifest = await fetchAndroidManifest({ suppressErrors: true });
        if (!manifest || isCancelled()) return;

        const currentVersion = await getVersion();
        if (isCancelled()) return;

        if (compareVersions(manifest.version, currentVersion) <= CompareResult.Equals) {
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

        const releaseJob = acquireDataJob("update");
        if (!releaseJob) {
          devLog("[Updater] 有数据任务在跑，跳过本次自动安装");
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
          await openAndroidInstallPermissionSettings();
        } else {
          devLog("[Updater] 已触发 APK 安装流程", response?.status);
        }
      } catch (error) {
        if (isCancelled()) return;
        logUpdateIssue("[Updater] 安卓更新未完成：", describeUpdateError(error), error);
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
