export interface PreviewToken {
  kind: "image" | "background";
  token: string;
}

export interface PreviewCacheEntry {
  token: PreviewToken | null;
  failed?: boolean;
  ts?: number;
  skipped?: boolean;
}

export const PREVIEW_CACHE_PREFIX = "sp:";
export const PREVIEW_CACHE_SCHEMA = "v2";
export const PREVIEW_DATA_VERSION_KEY = "sp:data-version";
export const PREVIEW_FAILURE_TTL_MS = 5 * 60 * 1000;

export function previewCachePrefix(version: number): string {
  return `${PREVIEW_CACHE_PREFIX}${PREVIEW_CACHE_SCHEMA}:${version}:`;
}

export function previewCacheKey(version: number, storyPath: string): string {
  return `${previewCachePrefix(version)}${storyPath}`;
}

export function previewRequestKey(version: number, storyPath: string): string {
  return `${version}:${storyPath}`;
}

/**
 * 明确「无图」永久有效；只有请求失败才走短 TTL。墙钟回拨、坏时间戳和
 * 恰好到达边界都按过期处理，避免一次暂态失败被无限缓存。
 */
export function isPreviewCacheEntryExpired(
  entry: PreviewCacheEntry,
  now: number,
  failureTtlMs = PREVIEW_FAILURE_TTL_MS
): boolean {
  if (!entry.failed) return false;
  const timestamp = entry.ts;
  if (typeof timestamp !== "number" || !Number.isFinite(timestamp)) return true;
  const age = now - timestamp;
  return age < 0 || age >= failureTtlMs;
}

/** 从不可信的 localStorage JSON 恢复严格的缓存形状。 */
export function parsePreviewCacheEntry(value: unknown): PreviewCacheEntry | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const parsed = value as {
    token?: unknown;
    failed?: unknown;
    ts?: unknown;
  };

  if (parsed.token === null) {
    if (parsed.failed === true) {
      return {
        token: null,
        failed: true,
        ts: typeof parsed.ts === "number" ? parsed.ts : Number.NaN,
      };
    }
    // 后端明确返回 null 是永久「无图」，不继承无关的 failed/ts 脏字段。
    return { token: null };
  }

  const token = parsed.token;
  if (!token || typeof token !== "object" || Array.isArray(token)) return null;
  const candidate = token as { kind?: unknown; token?: unknown };
  if (candidate.kind !== "image" && candidate.kind !== "background") return null;
  if (typeof candidate.token !== "string" || candidate.token.trim().length === 0) return null;
  return {
    token: {
      kind: candidate.kind,
      token: candidate.token.trim(),
    },
  };
}

/** 换包后的旧请求可以完成，但不能写入新版本缓存。 */
export function isPreviewTaskCurrent(taskVersion: number, currentVersion: number): boolean {
  return taskVersion === currentVersion;
}
