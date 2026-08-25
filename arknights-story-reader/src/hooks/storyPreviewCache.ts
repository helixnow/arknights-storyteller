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

/**
 * Map 保留插入顺序，命中时 delete + set 即可把条目移到 MRU 端。批量淘汰
 * 与旧实现一致，避免刚过上限时每插一条都做一次 Map 迭代。
 */
export class PreviewLruCache<K, V> {
  readonly limit: number;
  readonly evictBatch: number;
  readonly entries = new Map<K, V>();

  constructor(limit: number, evictBatch: number) {
    this.limit = Math.max(1, Math.trunc(limit));
    this.evictBatch = Math.max(1, Math.min(this.limit, Math.trunc(evictBatch)));
  }

  get size(): number {
    return this.entries.size;
  }

  get(key: K): V | undefined {
    if (!this.entries.has(key)) return undefined;
    const value = this.entries.get(key) as V;
    // 命中续期：Map 尾部是最近使用，头部才是真正的 LRU。
    this.entries.delete(key);
    this.entries.set(key, value);
    return value;
  }

  set(key: K, value: V): void {
    if (this.entries.has(key)) {
      this.entries.delete(key);
    } else if (this.entries.size >= this.limit) {
      let removed = 0;
      for (const stale of this.entries.keys()) {
        this.entries.delete(stale);
        removed += 1;
        if (removed >= this.evictBatch) break;
      }
    }
    this.entries.set(key, value);
  }

  delete(key: K): boolean {
    return this.entries.delete(key);
  }

  clear(): void {
    this.entries.clear();
  }

  /** 只供诊断/单测观察从 LRU 到 MRU 的次序。 */
  keys(): K[] {
    return Array.from(this.entries.keys());
  }
}

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

interface PreviewStorage {
  getItem(key: string): string | null;
  removeItem(key: string): void;
}

/**
 * 读取一条持久缓存。过期/损坏值一旦被碰到就立即删除；否则它会一直占着
 * localStorage，直到下一次数据版本变化才被全表 purge。
 */
export function readPreviewStorageEntry(
  storage: PreviewStorage,
  key: string,
  now: number,
  failureTtlMs = PREVIEW_FAILURE_TTL_MS
): PreviewCacheEntry | null {
  let raw: string | null;
  try {
    raw = storage.getItem(key);
  } catch {
    return null;
  }
  if (!raw) return null;

  let entry: PreviewCacheEntry | null = null;
  try {
    entry = parsePreviewCacheEntry(JSON.parse(raw));
  } catch {
    // 落到下面统一删除。
  }
  if (entry && !isPreviewCacheEntryExpired(entry, now, failureTtlMs)) {
    return entry;
  }
  try {
    storage.removeItem(key);
  } catch {
    // 隐私模式等环境连删除也可能抛错；读取仍按 miss 处理。
  }
  return null;
}

/** 换包后的旧请求可以完成，但不能写入新版本缓存。 */
export function isPreviewTaskCurrent(taskVersion: number, currentVersion: number): boolean {
  return taskVersion === currentVersion;
}
