import { useEffect, useRef } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { invoke } from "@tauri-apps/api/core";

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

type ManifestOptions = {
  suppressErrors?: boolean;
};

async function fetchAndroidManifest(options: ManifestOptions = {}): Promise<AndroidUpdateManifest | null> {
  const { suppressErrors = false } = options;
  const feed = import.meta.env.VITE_ANDROID_UPDATE_FEED as string | undefined;
  if (!feed) {
    if (!suppressErrors) {
      throw new Error("未配置安卓更新源 VITE_ANDROID_UPDATE_FEED");
    }
    console.info("[Updater] 未配置 VITE_ANDROID_UPDATE_FEED，跳过安卓更新检查");
    return null;
  }

  try {
    const response = await fetch(feed, { cache: "no-store" });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    const data = (await response.json()) as AndroidUpdateManifest;
    if (!data?.version || !data?.url) {
      throw new Error("更新 manifest 缺少 version 或 url 字段");
    }
    return data;
  } catch (error) {
    if (!suppressErrors) {
      throw error instanceof Error ? error : new Error(String(error));
    }
    console.error("[Updater] 获取安卓更新信息失败", error);
    return null;
  }
}

async function safeConfirm(message: string): Promise<boolean> {
  try {
    const dialog = await import("@tauri-apps/plugin-dialog");
    if (typeof dialog.confirm === "function") {
      return await dialog.confirm(message, { title: "发现更新", kind: "info" });
    }
    if (typeof dialog.ask === "function") {
      return await dialog.ask(message, { title: "发现更新" });
    }
  } catch (error) {
    console.info("[Updater] 对话框插件不可用，回退到 window.confirm", error);
  }
  return window.confirm(message);
}

export async function checkDesktopUpdate(currentVersionOverride?: string): Promise<DesktopUpdateAvailable | null> {
  const platform = detectRuntimePlatform();
  if (platform !== "desktop") {
    return null;
  }

  const [{ check }] = await Promise.all([import("@tauri-apps/plugin-updater")]);
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
  onProgress?: (event: { event: string; data?: unknown }) => void,
  options: { relaunch?: boolean } = {}
): Promise<void> {
  const { relaunch = true } = options;
  await update.handle.downloadAndInstall((event) => {
    onProgress?.(event);
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

export function useAppUpdater() {
  const startedRef = useRef(false);

  useEffect(() => {
    if (startedRef.current || !isTauriEnvironment()) return;
    startedRef.current = true;

    let cancelled = false;

    const runUpdateFlow = async () => {
      try {
        const platform = detectRuntimePlatform();
        if (platform === "android") {
          await runAndroidUpdateFlow(cancelled);
        } else if (platform === "desktop") {
          await runDesktopUpdateFlow(cancelled);
        }
      } catch (error) {
        if (!cancelled) {
          console.error("[Updater] 自动更新流程失败", error);
        }
      }
    };

    const runDesktopUpdateFlow = async (isCancelled: boolean) => {
      try {
        const updateInfo = await checkDesktopUpdate();
        if (!updateInfo || isCancelled) return;

        const shouldInstall = await safeConfirm(
          `检测到新版本 ${updateInfo.availableVersion}，是否立即下载并安装更新？`
        );
        if (!shouldInstall || isCancelled) {
          console.info("[Updater] 用户取消更新");
          return;
        }

        console.info("[Updater] 开始下载更新", updateInfo);
        await installDesktopUpdate(updateInfo, (event) => {
          if (isCancelled) return;
          console.info("[Updater] 下载事件", event);
        });
      } catch (error) {
        if (!isCancelled) {
          // Tauri 未授予 `updater:allow-check` 权限时会抛 "not allowed" 错误，
          // 这是配置缺失、不是运行时问题，吞成 info，免得每次启动都在控制台
          // 刷红。
          const msg = error instanceof Error ? error.message : String(error);
          if (/plugin/i.test(msg) || /not allowed/i.test(msg)) {
            console.info("[Updater] 桌面更新不可用：", msg);
          } else {
            console.error("[Updater] 桌面更新失败", error);
          }
        }
      }
    };

    const runAndroidUpdateFlow = async (isCancelled: boolean) => {
      try {
        const manifest = await fetchAndroidManifest({ suppressErrors: true });
        if (!manifest || isCancelled) return;

        const currentVersion = await getVersion();
        if (isCancelled) return;

        if (compareVersions(manifest.version, currentVersion) <= CompareResult.Equals) {
          console.info("[Updater] 安卓端已是最新版本", { currentVersion, remote: manifest.version });
          return;
        }

        const shouldInstall = await safeConfirm(
          `检测到新版本 ${manifest.version}，是否立即下载安装？`
        );

        if (!shouldInstall || isCancelled) {
          console.info("[Updater] 用户取消安卓更新");
          return;
        }

        const response = await installAndroidUpdate({
          platform: "android",
          currentVersion,
          manifest,
        });

        if (isCancelled) return;

        if (response?.needsPermission) {
          console.warn("[Updater] 需要开启未知来源安装权限");
          await openAndroidInstallPermissionSettings();
        } else {
          console.info("[Updater] 已触发 APK 安装流程", response);
        }
      } catch (error) {
        if (!isCancelled) {
          console.error("[Updater] 下载或安装安卓更新失败", error);
        }
      }
    };

    void runUpdateFlow();

    return () => {
      cancelled = true;
    };
  }, []);
}
