export type VersionCompareResult = -1 | 0 | 1;

export function compareVersions(a: string, b: string): VersionCompareResult {
  const parse = (input: string) => {
    const cleaned = input.trim().replace(/^v/i, "").split("+")[0];
    const dashIndex = cleaned.indexOf("-");
    return {
      core: (dashIndex === -1 ? cleaned : cleaned.slice(0, dashIndex)).split("."),
      prerelease: dashIndex === -1 ? null : cleaned.slice(dashIndex + 1),
    };
  };
  const versionA = parse(a);
  const versionB = parse(b);
  const length = Math.max(versionA.core.length, versionB.core.length);
  for (let index = 0; index < length; index += 1) {
    const segmentA = parseInt(versionA.core[index] ?? "0", 10);
    const segmentB = parseInt(versionB.core[index] ?? "0", 10);
    if (Number.isNaN(segmentA) || Number.isNaN(segmentB)) return 0;
    if (segmentA > segmentB) return 1;
    if (segmentA < segmentB) return -1;
  }
  if (versionA.prerelease === null && versionB.prerelease === null) return 0;
  if (versionA.prerelease === null) return 1;
  if (versionB.prerelease === null) return -1;
  return comparePrerelease(versionA.prerelease, versionB.prerelease);
}

function comparePrerelease(a: string, b: string): VersionCompareResult {
  const idsA = a.split(".");
  const idsB = b.split(".");
  const length = Math.max(idsA.length, idsB.length);
  for (let index = 0; index < length; index += 1) {
    const idA = idsA[index];
    const idB = idsB[index];
    if (idA === undefined) return -1;
    if (idB === undefined) return 1;
    const numA = /^\d+$/.test(idA) ? parseInt(idA, 10) : null;
    const numB = /^\d+$/.test(idB) ? parseInt(idB, 10) : null;
    if (numA !== null && numB !== null) {
      if (numA > numB) return 1;
      if (numA < numB) return -1;
    } else if (numA !== null) {
      return -1;
    } else if (numB !== null) {
      return 1;
    } else if (idA !== idB) {
      return idA > idB ? 1 : -1;
    }
  }
  return 0;
}

export function redactSensitive(text: string): string {
  return text
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, "<链接>")
    .replace(/\b(token|key|signature|sig|secret|password)=[^\s&"']+/gi, "$1=<已隐藏>");
}

export type UpdateIssueTone = "info" | "warning" | "error";
export type UpdateIssueKind =
  | "unsupported"
  | "not-configured"
  | "cancelled"
  | "busy"
  | "signature"
  | "feed"
  | "network"
  | "unknown";

export interface UpdateIssue {
  tone: UpdateIssueTone;
  kind: UpdateIssueKind;
  message: string;
}

function errorText(error: unknown): string {
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

const UPDATE_ERROR_RULES: Array<{
  test: RegExp;
  tone: UpdateIssueTone;
  kind: UpdateIssueKind;
  message: string;
}> = [
  {
    test: /并非\s*Tauri|not a tauri/i,
    tone: "info",
    kind: "unsupported",
    message: "当前环境不是桌面/移动客户端，无法检查更新。",
  },
  {
    test: /VITE_ANDROID_UPDATE_FEED|未配置安卓更新源|更新组件未初始化|原生插件注册失败/i,
    tone: "info",
    kind: "not-configured",
    message: "当前安装包未正确启用自动更新，请前往项目发布页手动下载新版本。",
  },
  {
    test: /not allowed|unknown plugin|plugin .*not (?:found|registered)|updater.*disabled/i,
    tone: "info",
    kind: "not-configured",
    message: "当前安装包未启用自动更新，请前往项目发布页手动下载新版本。",
  },
  {
    test: /user cancell?ed|cancell?ed by (?:the )?user|操作已取消|用户已?取消|os error 1223/i,
    tone: "info",
    kind: "cancelled",
    message: "更新已取消，可稍后在设置里重新检查。",
  },
  {
    test: /已有更新下载正在进行|download already in progress|update.*in progress/i,
    tone: "warning",
    kind: "busy",
    message: "已有更新下载正在进行，请等待完成后再试。",
  },
  {
    test: /signature|pubkey|public key|verif/i,
    tone: "error",
    kind: "signature",
    message: "更新包签名校验失败，出于安全考虑已中止安装。",
  },
  {
    test: /network|failed to fetch|error sending request|timed? ?out|超时|dns|connect|ECONN|ENOTFOUND|offline|网络/i,
    tone: "warning",
    kind: "network",
    message: "无法连接更新服务器，请检查网络后重试。",
  },
  {
    test: /could not fetch a valid release|releases?\.json|manifest (?:缺少|无效)|缺少 version|HTTP 4\d\d|HTTP 5\d\d|android-latest\.json/i,
    tone: "warning",
    kind: "feed",
    message: "更新源暂时不可用，请稍后再试。",
  },
];

export function describeUpdateError(
  error: unknown,
  fallback = "本次更新检查没有完成，可稍后再试。"
): UpdateIssue {
  const text = errorText(error);
  for (const rule of UPDATE_ERROR_RULES) {
    if (rule.test.test(text)) {
      return { tone: rule.tone, kind: rule.kind, message: rule.message };
    }
  }
  if (!text) return { tone: "warning", kind: "unknown", message: fallback };
  return { tone: "warning", kind: "unknown", message: `${fallback}（${redactSensitive(text)}）` };
}

export interface AndroidManifestData {
  version: string;
  url: string;
  fileName?: string | null;
  notes?: string | null;
}

export function validateAndroidFeedUrl(feed: string): string {
  let parsed: URL;
  try {
    parsed = new URL(feed);
  } catch {
    throw new Error("android-latest.json 更新源地址无效");
  }
  if (!/^https?:$/.test(parsed.protocol) || !parsed.pathname.endsWith("/android-latest.json")) {
    throw new Error("Android 更新必须使用 android-latest.json");
  }
  return parsed.toString();
}

export function parseAndroidManifest(input: unknown): AndroidManifestData {
  if (!input || typeof input !== "object") {
    throw new Error("更新 manifest 无效");
  }
  const raw = input as Record<string, unknown>;
  const version = typeof raw.version === "string" ? raw.version.trim() : "";
  const url = typeof raw.url === "string" ? raw.url.trim() : "";
  if (!version || !url) throw new Error("更新 manifest 缺少 version 或 url 字段");

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(url);
  } catch {
    throw new Error("更新 manifest 下载地址无效");
  }
  if (!/^https?:$/.test(parsedUrl.protocol)) {
    throw new Error("更新 manifest 下载地址无效");
  }

  const fileName =
    raw.fileName === null || raw.fileName === undefined
      ? null
      : typeof raw.fileName === "string"
        ? raw.fileName.trim()
        : null;
  if (
    fileName &&
    (!fileName.toLowerCase().endsWith(".apk") ||
      fileName.includes("/") ||
      fileName.includes("\\") ||
      fileName.includes(".."))
  ) {
    throw new Error("更新 manifest 文件名无效");
  }
  const notes =
    raw.notes === null || raw.notes === undefined
      ? null
      : typeof raw.notes === "string"
        ? raw.notes
        : null;
  return { version, url: parsedUrl.toString(), fileName, notes };
}

export type AndroidInstallOutcome = "needs-permission" | "installer-launched";

export function classifyAndroidInstallResponse(response: unknown): AndroidInstallOutcome {
  if (!response || typeof response !== "object") {
    throw new Error("Android 安装组件未返回安装结果");
  }
  const value = response as { status?: unknown; needsPermission?: unknown };
  if (value.needsPermission === true) return "needs-permission";
  if (value.status === "install-intent-launched") return "installer-launched";
  throw new Error("Android 安装组件返回了无法识别的状态，安装尚未开始");
}

export interface DownloadProgressLike {
  downloadedBytes: number;
  totalBytes: number | null;
  percent: number | null;
  done: boolean;
}

export function normalizeAndroidDownloadProgress(payload: unknown): DownloadProgressLike | null {
  if (!payload || typeof payload !== "object") return null;
  const raw = payload as { current?: unknown; total?: unknown; message?: unknown };
  const current = Number(raw.current);
  const total = Number(raw.total);
  if (!Number.isFinite(current) || current < 0) return null;
  const knownTotal = Number.isFinite(total) && total > 0 ? total : null;
  return {
    downloadedBytes: current,
    totalBytes: knownTotal,
    percent: knownTotal ? Math.min(100, Math.round((current / knownTotal) * 100)) : null,
    done: raw.message === "下载完成" || (knownTotal !== null && current >= knownTotal),
  };
}
