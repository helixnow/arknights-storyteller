import { useEffect, useState } from "react";
import { api } from "@/services/api";
import type { StoryPreviewToken } from "@/types/story";

/**
 * 缩略图 token 解析器。首页/剧情列表每条卡片都要展示一张剧情插画，
 * 如果每次 render 都让后端扫一遍 TXT 会很慢（IPC 往返 + 读盘），所以：
 *
 * 1. 内存级缓存 `MEMO`：一个进程内同一条 storyPath 只解析一次。
 * 2. localStorage 级缓存：跨启动也不用重算。key = `sp:{schema}:{dataVersion}:{storyPath}`。
 * 3. 请求去重：同一条 storyPath 的在途请求全局只有一个（列表缩略图 +
 *    卡片模糊背景是两个组件，但共享同一个 Promise）。
 * 4. 并发限流 + 调度：同一时间最多只跑 2 条 IPC。队列不是朴素 FIFO——
 *    见下面 `takeNext()` 的说明，展开一个新分组不会排在上一个分组的
 *    几百条积压后面。
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
  /** true 表示这条请求在真正发出前就被放弃了（没人再关心它），不代表结果。 */
  skipped?: boolean;
}

const LS_PREFIX = "sp:";
// schema 版本：如果脚本解析规则变了，统一 bump 就能清理旧缓存。
const LS_SCHEMA = "v2";
// 数据版本：剧情数据每同步一次就 +1，随 key 一起变。
const DATA_VERSION_KEY = "sp:data-version";
/** 失败缓存的存活时间，过期后允许重新请求。 */
const FAILURE_TTL_MS = 5 * 60 * 1000;

const MEMO = new Map<string, CacheEntry>();
/** 全量剧情几千条，条目本身只有两个短字符串；到顶后淘汰最早写入的一批。 */
const MEMO_LIMIT = 4000;
const MEMO_EVICT = 1000;
const MAX_INFLIGHT = 2;

function writeMemo(path: string, entry: CacheEntry) {
  if (MEMO.size >= MEMO_LIMIT && !MEMO.has(path)) {
    let removed = 0;
    for (const key of MEMO.keys()) {
      MEMO.delete(key);
      removed += 1;
      if (removed >= MEMO_EVICT) break;
    }
  }
  MEMO.set(path, entry);
}

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

/** 命中任意一层缓存就直接返回，省掉一次 Promise 与一次 state 往返。 */
function readCached(path: string): CacheEntry | null {
  const memo = readMemo(path);
  if (memo) return memo;
  const persisted = readLsCache(path);
  if (persisted) {
    writeMemo(path, persisted);
    return persisted;
  }
  return null;
}

// ─────────────────────────────────────────────────────────────
// 调度
//
// 列表不做虚拟化：展开一个分组会一次性挂载几百张卡片，每张都想要一次
// IPC。朴素 FIFO 队列在这里有两个坑：
//   1. 用户折叠分组 / 切走页面后，那几百条请求还在队里慢慢跑；
//   2. 展开的新分组排在旧积压后面，用户盯着的卡片反而最后才出图。
// 所以队列按「批次」组织：同一瞬间涌进来的请求算一批，批内保持 FIFO
// （分组顶部的卡片先出图），取任务时永远从最新一批取。没有关注者的
// 任务在出队时直接丢弃，压根不会发出 IPC。
// ─────────────────────────────────────────────────────────────

interface Task {
  key: string;
  path: string;
  /** 发起时的数据版本；跨版本的结果不写缓存。 */
  version: number;
  /** 还有多少个挂载中的 hook 在等这条结果。 */
  waiters: number;
  /** 脚本化预取：没有组件等它也要跑完。 */
  keep: boolean;
  started: boolean;
  settled: boolean;
  bucket: Bucket | null;
  promise: Promise<CacheEntry>;
  resolve: (entry: CacheEntry) => void;
}

/** 一「批」= 几乎同时入队的一组任务，批内保持 FIFO。 */
type Bucket = Task[];

const INFLIGHT = new Map<string, Task>();
const BUCKETS: Bucket[] = [];
/** 间隔超过这个时间的入队算新一批（一次列表展开通常在同一帧内完成）。 */
const BURST_GAP_MS = 120;
let lastEnqueueAt = 0;
let inflightCount = 0;

function enqueue(task: Task) {
  const now = Date.now();
  let bucket = BUCKETS[BUCKETS.length - 1];
  if (!bucket || now - lastEnqueueAt > BURST_GAP_MS) {
    bucket = [];
    BUCKETS.push(bucket);
  }
  lastEnqueueAt = now;
  bucket.push(task);
  task.bucket = bucket;
}

/** 旧批次里的任务又被人关注了（滚回去 / 重新展开）：抬到最新一批。 */
function promote(task: Task) {
  if (task.started || task.settled || !task.bucket) return;
  if (task.bucket === BUCKETS[BUCKETS.length - 1]) return;
  const idx = task.bucket.indexOf(task);
  if (idx >= 0) task.bucket.splice(idx, 1);
  task.bucket = null;
  enqueue(task);
}

function takeNext(): Task | null {
  while (BUCKETS.length > 0) {
    const bucket = BUCKETS[BUCKETS.length - 1];
    while (bucket.length > 0) {
      const task = bucket.shift() as Task;
      task.bucket = null;
      if (task.settled) continue;
      if (task.waiters <= 0 && !task.keep) {
        // 卡片已经不在页面上了，这条 IPC 没有意义。
        settle(task, { token: null, skipped: true }, false);
        continue;
      }
      return task;
    }
    BUCKETS.pop();
  }
  return null;
}

function pump() {
  while (inflightCount < MAX_INFLIGHT) {
    const task = takeNext();
    if (!task) return;
    void run(task);
  }
}

function settle(task: Task, entry: CacheEntry, cacheable: boolean) {
  if (task.settled) return;
  task.settled = true;
  INFLIGHT.delete(task.key);
  // 请求期间数据被重新同步过的话，这条结果属于旧版本，不能写进缓存。
  if (cacheable && dataVersion === task.version) {
    writeMemo(task.path, entry);
    writeLsCache(task.path, entry);
  }
  task.resolve(entry);
}

async function run(task: Task) {
  task.started = true;
  inflightCount += 1;
  try {
    const token = await api.getStoryPreviewToken(task.path);
    settle(task, { token: token ?? null }, true);
  } catch (err) {
    console.warn("[useStoryPreview] 读取缩略图 token 失败", task.path, err);
    // 失败只缓存一小段时间，避免同步刚完成时把「暂时读不到」钉死成永久空图。
    settle(task, { token: null, failed: true, ts: Date.now() }, true);
  } finally {
    inflightCount -= 1;
    pump();
  }
}

interface PreviewRequest {
  promise: Promise<CacheEntry>;
  /** 调用方不再关心结果时必须调用；只有第一次调用生效。 */
  release: () => void;
}

/**
 * 请求一条 storyPath 的缩略图 token。同一路径的在途请求全局共享一个
 * Promise（去重），并按关注者计数决定还要不要真的发出去。
 */
function requestPreview(path: string, keep = false): PreviewRequest {
  const cached = readCached(path);
  if (cached) {
    return { promise: Promise.resolve(cached), release: NOOP };
  }

  const key = `${dataVersion}:${path}`;
  let task = INFLIGHT.get(key);
  if (task) {
    task.waiters += 1;
    if (keep) task.keep = true;
    promote(task);
  } else {
    let resolveFn: (entry: CacheEntry) => void = NOOP;
    const promise = new Promise<CacheEntry>((resolve) => {
      resolveFn = resolve;
    });
    task = {
      key,
      path,
      version: dataVersion,
      waiters: 1,
      keep,
      started: false,
      settled: false,
      bucket: null,
      promise,
      resolve: resolveFn,
    };
    INFLIGHT.set(key, task);
    enqueue(task);
  }

  const owned = task;
  let released = false;
  pump();
  return {
    promise: owned.promise,
    release: () => {
      if (released) return;
      released = true;
      owned.waiters -= 1;
    },
  };
}

const NOOP = () => {};

/**
 * 剧情数据重新同步：作废所有缓存并让挂载中的组件重新解析。
 *
 * 还没发出去的排队任务直接丢弃——它们带着旧版本号，跑完也写不进缓存，
 * 只会白占并发额度；挂载中的组件会因为版本变化重新发起请求。
 * 已经在途的请求留着自己跑完（`settle` 里按版本判断是否落缓存）。
 */
function invalidateAll() {
  MEMO.clear();
  dataVersion += 1;
  try {
    window.localStorage.setItem(DATA_VERSION_KEY, String(dataVersion));
  } catch {}
  dropQueuedTasks();
  purgeStaleCache();
  subscribers.forEach((notify) => notify());
}

function dropQueuedTasks() {
  while (BUCKETS.length > 0) {
    const bucket = BUCKETS.pop() as Bucket;
    for (const task of bucket) {
      task.bucket = null;
      settle(task, { token: null, skipped: true }, false);
    }
  }
}

/**
 * 跟随别的窗口完成的数据同步。`app:data-updated` 是窗口内事件，桌面端开
 * 多个窗口时只有执行同步的那个收得到；版本号却持久化在 localStorage 里。
 * 不跟随的话：本窗口的 MEMO 一直按旧数据渲染插画（token 指向已被替换的
 * 内容，直到重启都不刷新），readLsCache 还按旧版本前缀查缓存、把重新拉
 * 到的结果写回旧版本 key——对方刚清理掉的脏条目又被塞回来。做法与
 * `invalidateAll` 一致，只是版本号采用外部写入的值而不是自增。
 */
function adoptExternalDataVersion() {
  const external = readDataVersion();
  if (external === dataVersion) return;
  dataVersion = external;
  MEMO.clear();
  dropQueuedTasks();
  purgeStaleCache();
  subscribers.forEach((notify) => notify());
}

if (typeof window !== "undefined") {
  purgeStaleCache();
  window.addEventListener("app:data-updated", invalidateAll);
  window.addEventListener("storage", (event) => {
    // key 为 null 表示外部 storage.clear()：版本号键也被清掉了，同样对账。
    if (event.key !== null && event.key !== DATA_VERSION_KEY) return;
    adoptExternalDataVersion();
  });
}

function initialStateFor(storyPath: string | null | undefined): {
  token: StoryPreviewToken | null;
  loading: boolean;
} {
  if (!storyPath) return { token: null, loading: false };
  const cached = readCached(storyPath);
  if (cached) return { token: cached.token, loading: false };
  return { token: null, loading: true };
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
  const [state, setState] = useState(() => initialStateFor(storyPath));

  // storyPath 原地切换（列表复用行、首页卡片换目标）的那一帧不能把上一篇
  // 的 token 渲染出去——下游会把旧插画当命中候选继续展示，等 useEffect
  // （paint 之后）才纠正，用户能看到串篇闪帧。与 <AssetImage> 同一套
  // 渲染期同步重置的模式。
  const [renderedPath, setRenderedPath] = useState(storyPath);
  if (renderedPath !== storyPath) {
    setRenderedPath(storyPath);
    setState(initialStateFor(storyPath));
  }

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
    setState((prev) => (prev.loading && prev.token === null ? prev : { token: null, loading: true }));
    const request = requestPreview(storyPath);
    request.promise.then((entry) => {
      // `skipped` 说明这条请求在没人关心时被丢弃了——只可能发生在本组件
      // 已经卸载之后，忽略即可。
      if (cancelled || entry.skipped) return;
      setState({ token: entry.token, loading: false });
    });
    return () => {
      cancelled = true;
      request.release();
    };
  }, [storyPath, version]);

  return state;
}

/** 仅用于脚本化预取（例如 CSV 导入后刷缓存）。组件内部不需要调用。 */
export function prefetchStoryPreview(storyPath: string): Promise<void> {
  return requestPreview(storyPath, true).promise.then(() => undefined);
}
