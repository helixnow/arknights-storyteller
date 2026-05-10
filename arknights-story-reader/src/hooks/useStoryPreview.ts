import { useEffect, useState } from "react";
import { api } from "@/services/api";
import type { StoryPreviewToken } from "@/types/story";

/**
 * 缩略图 token 解析器。首页/剧情列表每条卡片都要展示一张剧情插画，
 * 如果每次 render 都让后端扫一遍 TXT 会很慢（IPC 往返 + 读盘），所以：
 *
 * 1. 内存级缓存 `MEMO`：一个进程内只解析一次。
 * 2. localStorage 级缓存：跨启动也不用重算。key = `sp:{storyPath}`。
 * 3. 并发限流：同一时间最多只跑 2 条 IPC，避免 16 张卡片一起灌满 IPC 队列。
 *
 * 查不到时会把 null 也写进缓存（用哨兵值），下次不会再重复请求。
 */

interface CacheEntry {
  token: StoryPreviewToken | null; // null = 查过但没有
}

const LS_PREFIX = "sp:";
// 版本号：如果脚本解析规则变了，统一 bump 就能清理旧缓存。
const LS_VERSION = "v1";

const MEMO = new Map<string, CacheEntry>();
const INFLIGHT = new Map<string, Promise<CacheEntry>>();
const QUEUE: Array<() => void> = [];
let inflightCount = 0;
const MAX_INFLIGHT = 2;

function lsKey(path: string) {
  return `${LS_PREFIX}${LS_VERSION}:${path}`;
}

function readLsCache(path: string): CacheEntry | null {
  try {
    const raw = window.localStorage.getItem(lsKey(path));
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") {
      if (parsed.token === null) return { token: null };
      if (
        parsed.token &&
        typeof parsed.token.kind === "string" &&
        typeof parsed.token.token === "string"
      ) {
        return { token: parsed.token };
      }
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

function runNext() {
  while (inflightCount < MAX_INFLIGHT && QUEUE.length > 0) {
    const task = QUEUE.shift();
    if (task) task();
  }
}

function resolvePreview(path: string): Promise<CacheEntry> {
  const memo = MEMO.get(path);
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
      try {
        const token = await api.getStoryPreviewToken(path);
        const entry: CacheEntry = { token: token ?? null };
        MEMO.set(path, entry);
        writeLsCache(path, entry);
        resolve(entry);
      } catch (err) {
        console.warn("[useStoryPreview] 读取缩略图 token 失败", path, err);
        // 失败也缓存，避免每次渲染都重试；用户重装数据后 MEMO 会随页面刷新重置。
        const entry: CacheEntry = { token: null };
        MEMO.set(path, entry);
        resolve(entry);
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
  const [state, setState] = useState<{
    token: StoryPreviewToken | null;
    loading: boolean;
  }>(() => {
    if (!storyPath) return { token: null, loading: false };
    const memo = MEMO.get(storyPath);
    if (memo) return { token: memo.token, loading: false };
    const persisted = readLsCache(storyPath);
    if (persisted) {
      MEMO.set(storyPath, persisted);
      return { token: persisted.token, loading: false };
    }
    return { token: null, loading: true };
  });

  useEffect(() => {
    if (!storyPath) {
      setState({ token: null, loading: false });
      return;
    }
    const memo = MEMO.get(storyPath);
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
  }, [storyPath]);

  return state;
}

/** 仅用于脚本化预取（例如 CSV 导入后刷缓存）。组件内部不需要调用。 */
export function prefetchStoryPreview(storyPath: string): Promise<void> {
  return resolvePreview(storyPath).then(() => undefined);
}
