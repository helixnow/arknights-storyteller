/**
 * 剧情目录请求的短期缓存。把时序收在一个不依赖 React 的小模块里，首页与
 * 列表共享同一份实例，也能直接回归「换包时旧请求迟到」这类竞态。
 */
export interface VersionedRequestCache {
  fetch<T>(key: string, loader: () => Promise<T>, force?: boolean): Promise<T>;
  invalidate(): void;
}

interface CacheHit {
  value: unknown;
  at: number;
}

export function createVersionedRequestCache(
  ttlMs: number,
  now: () => number = Date.now
): VersionedRequestCache {
  const values = new Map<string, CacheHit>();
  const inflight = new Map<string, Promise<unknown>>();
  let generation = 0;

  return {
    fetch<T>(key: string, loader: () => Promise<T>, force = false): Promise<T> {
      if (force) values.delete(key);

      const hit = values.get(key);
      if (hit) {
        const age = now() - hit.at;
        // 墙钟回拨时不能把旧目录当成「刚刚读过」并无限续命。
        if (age >= 0 && age < ttlMs) {
          return Promise.resolve(hit.value as T);
        }
        values.delete(key);
      }

      const pending = inflight.get(key) as Promise<T> | undefined;
      // force 的语义是重新读取。复用旧在途请求不仅没有重试，还会让旧包的
      // 迟到结果冒充本轮结果；新请求会在 map 里接管该 key 的归属。
      if (pending && !force) return pending;

      const startedGeneration = generation;
      let request!: Promise<T>;
      request = Promise.resolve()
        .then(loader)
        .then((value) => {
          // 只允许当前代、且仍拥有这个 key 的请求写缓存。force 或 invalidate
          // 已经让归属易主时，旧请求仍可给原调用方收尾，但不能污染后续命中。
          if (
            generation === startedGeneration &&
            inflight.get(key) === request
          ) {
            values.set(key, { value, at: now() });
          }
          return value;
        });

      const release = () => {
        if (inflight.get(key) === request) inflight.delete(key);
      };
      request.then(release, release);
      inflight.set(key, request);
      return request;
    },

    invalidate() {
      generation += 1;
      values.clear();
      // 已发出的 IPC 无法取消；清归属就足以让它们落地时失去写缓存资格。
      inflight.clear();
    },
  };
}

/** 只有明确的目录缺失才等价于「未安装」；超时和普通 IPC 错误都不是。 */
export function isMissingStoryCatalogError(message: string): boolean {
  return message.includes("NOT_INSTALLED") || message.includes("No such file");
}

/** 简介缓存必须同时绑定剧情 id 与 info 路径，换包后同 id 才不会串文案。 */
export function storySummaryKey(story: {
  storyId: string;
  storyInfo?: string | null;
}): string {
  return `${story.storyId}|${story.storyInfo ?? ""}`;
}
