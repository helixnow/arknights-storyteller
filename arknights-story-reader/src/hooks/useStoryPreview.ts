import { useEffect, useState } from "react";
import { api } from "@/services/api";
import type { StoryPreviewToken } from "@/types/story";

/**
 * 缩略图 token 解析器。首页/剧情列表每条卡片都要展示一张剧情插画，
 * 如果每次 render 都让后端扫一遍 TXT 会很慢（IPC 往返 + 读盘），所以：
 *
 * 1. 内存级缓存 `MEMO`：一个进程内只解析一次。
 * 2. localStorage 级缓存：跨启动也不用重算。key = `sp:{schema}:{dataVersion}:{storyPath}`。
 * 3. 并发限流：同一时间最多只跑 2 条 IPC，避免 16 张卡片一起灌满 IPC 队列。
 *
 * 缓存带「数据版本」：收到 `app:data-updated`（剧情数据重新同步）后 bump 版本，
 * 旧 key 立刻失效并被清理，不会拿旧数据里的 token 去渲染新剧情。
 *
 * 「查不到」也会缓存，但区分两种情况：
 *   - 后端明确返回 null（这章确实没有插画）→ 永久缓存。
 *   - 请求抛错（IPC 超时、文件还没落盘）→ 只缓存 FAILURE_TTL_MS，之后可重试。
 */

interface CacheEntry {
  token: StoryPreviewToken | null; // null = 查过但没有
  /** true 表示这是一次失败的请求，短 TTL 之后允许重试。 */
  failed?: boolean;
  /** 写入时间戳，仅 failed 条目需要。 */
  ts?: number;
}

const LS_PREFIX = "sp:";
// schema 版本：如果脚本解析规则变了，统一 bump 就能清理旧缓存。
const LS_SCHEMA = "v2";
// 数据版本：剧情数据每同步一次就 +1，随 key 一起变。
const DATA_VERSION_KEY = "sp:data-version";
/** 失败缓存的存活时间，过期后允许重新请求。 */
const FAILURE_TTL_MS = 5 * 60 * 1000;

const MEMO = new Map<string, CacheEntry>();
const INFLIGHT = new Map<string, Promise<CacheEntry>>();
const QUEUE: Array<() => void> = [];
let inflightCount = 0;
const MAX_INFLIGHT = 2;

function readDataVersion(): number {
  if (typeof window === "undefined") return 0;
  try {
    const raw = window.localStorage.getItem(DATA_VERSION_KEY);
    const parsed = raw ? Number.parseInt(raw, 10) : 0;
    return Number.isFinite(parsed) ? parsed : 0;
  } catch {
    return 0;
  }
}

let dataVersion = readDataVersion();

/** 版本变化时通知所有挂载中的 hook 重新解析。 */
const subscribers = new Set<() => void>();

function keyPrefix() {
  return `${LS_PREFIX}${LS_SCHEMA}:${dataVersion}:`;
}

function lsKey(path: string) {
  return `${keyPrefix()}${path}`;
}

/** 清掉所有不属于当前 schema + 数据版本的旧条目。 */
function purgeStaleCache() {
  if (typeof window === "undefined") return;
  try {
    const current = keyPrefix();
    const stale: string[] = [];
    for (let i = 0; i < window.localStorage.length; i += 1) {
      const key = window.localStorage.key(i);
      if (!key || key === DATA_VERSION_KEY) continue;
      if (key.startsWith(LS_PREFIX) && !key.startsWith(current)) {
        stale.push(key);
      }
    }
    stale.forEach((key) => window.localStorage.removeItem(key));
  } catch {}
}

function isExpired(entry: CacheEntry): boolean {
  if (!entry.failed) return false;
  return Date.now() - (entry.ts ?? 0) > FAILURE_TTL_MS;
}

function readLsCache(path: string): CacheEntry | null {
  try {
    const raw = window.localStorage.getItem(lsKey(path));
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") {
      const entry: CacheEntry | null =
        parsed.token === null
          ? { token: null, failed: Boolean(parsed.failed), ts: Number(parsed.ts ?? 0) }
          : parsed.token &&
            typeof parsed.token.kind === "string" &&
            typeof parsed.token.token === "string"
          ? { token: parsed.token }
          : null;
      if (entry && !isExpired(entry)) return entry;
    }
  } catch {}
  return null;
}

function writeLsCache(path: string, entry: CacheEntry) {
  try {
    window.localStorage.setItem(lsKey(path), JSON.stringify(entry));
  } catch {
    // Quota exceeded or JSON issue — just ignore; memo cache is still useful.
  }
}

function readMemo(path: string): CacheEntry | null {
  const memo = MEMO.get(path);
  if (!memo) return null;
  if (isExpired(memo)) {
    MEMO.delete(path);
    return null;
  }
  return memo;
}

/** 剧情数据重新同步：作废所有缓存并让挂载中的组件重新解析。 */
function invalidateAll() {
  MEMO.clear();
  INFLIGHT.clear();
  dataVersion += 1;
  try {
    window.localStorage.setItem(DATA_VERSION_KEY, String(dataVersion));
  } catch {}
  purgeStaleCache();
  subscribers.forEach((notify) => notify());
}

if (typeof window !== "undefined") {
  purgeStaleCache();
  window.addEventListener("app:data-updated", invalidateAll);
}

function runNext() {
  while (inflightCount < MAX_INFLIGHT && QUEUE.length > 0) {
    const task = QUEUE.shift();
    if (task) task();
  }
}

function resolvePreview(path: string): Promise<CacheEntry> {
  const memo = readMemo(path);
  if (memo) return Promise.resolve(memo);

  const persisted = readLsCache(path);
  if (persisted) {
    MEMO.set(path, persisted);
    return Promise.resolve(persisted);
  }

  const existing = INFLIGHT.get(path);
  if (existing) return existing;

  const p = new Promise<CacheEntry>((resolve) => {
    const run = async () => {
      inflightCount += 1;
      // 请求期间如果数据被重新同步，这条结果就属于旧版本，不能再写进缓存。
      const startedAt = dataVersion;
      const commit = (entry: CacheEntry) => {
        if (dataVersion === startedAt) {
          MEMO.set(path, entry);
          writeLsCache(path, entry);
        }
        resolve(entry);
      };
      try {
        const token = await api.getStoryPreviewToken(path);
        commit({ token: token ?? null });
      } catch (err) {
        console.warn("[useStoryPreview] 读取缩略图 token 失败", path, err);
        // 失败只缓存一小段时间，避免同步刚完成时把「暂时读不到」钉死成永久空图。
        commit({ token: null, failed: true, ts: Date.now() });
      } finally {
        inflightCount -= 1;
        INFLIGHT.delete(path);
        runNext();
      }
    };
    QUEUE.push(run);
    runNext();
  });
  INFLIGHT.set(path, p);
  return p;
}

/**
 * 返回给定剧情的缩略图 token；首次请求会异步取，结果会填入 React state。
 * 当 `storyPath` 为空/未就绪时返回 `{ token: null, loading: false }`。
 */
export function useStoryPreview(
  storyPath: string | null | undefined
): {
  token: StoryPreviewToken | null;
  loading: boolean;
} {
  const [version, setVersion] = useState(dataVersion);
  const [state, setState] = useState<{
    token: StoryPreviewToken | null;
    loading: boolean;
  }>(() => {
    if (!storyPath) return { token: null, loading: false };
    const memo = readMemo(storyPath);
    if (memo) return { token: memo.token, loading: false };
    const persisted = readLsCache(storyPath);
    if (persisted) {
      MEMO.set(storyPath, persisted);
      return { token: persisted.token, loading: false };
    }
    return { token: null, loading: true };
  });

  useEffect(() => {
    const notify = () => setVersion(dataVersion);
    subscribers.add(notify);
    return () => {
      subscribers.delete(notify);
    };
  }, []);

  useEffect(() => {
    if (!storyPath) {
      setState({ token: null, loading: false });
      return;
    }
    const memo = readMemo(storyPath);
    if (memo) {
      setState({ token: memo.token, loading: false });
      return;
    }

    let cancelled = false;
    setState((prev) => ({ ...prev, loading: true }));
    resolvePreview(storyPath).then((entry) => {
      if (cancelled) return;
      setState({ token: entry.token, loading: false });
    });
    return () => {
      cancelled = true;
    };
  }, [storyPath, version]);

  return state;
}

/** 仅用于脚本化预取（例如 CSV 导入后刷缓存）。组件内部不需要调用。 */
export function prefetchStoryPreview(storyPath: string): Promise<void> {
  return resolvePreview(storyPath).then(() => undefined);
}
