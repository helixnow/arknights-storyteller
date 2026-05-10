import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "@/services/api";
import type { AssetKind } from "@/types/story";

interface UseAssetState {
  /** 首选可用的 URL；尚在请求/fallback 时为 null。 */
  url: string | null;
  /** 整条 candidate 链，组件可自行选择 fallback 顺序。 */
  candidates: string[];
  loading: boolean;
  error: boolean;
}

const memoryCache = new Map<string, string[]>();
const pendingCache = new Map<string, Promise<string[]>>();

function cacheKey(kind: AssetKind, token: string) {
  return `${kind}::${token}`;
}

async function fetchCandidates(kind: AssetKind, token: string): Promise<string[]> {
  const key = cacheKey(kind, token);
  const cached = memoryCache.get(key);
  if (cached) return cached;
  const pending = pendingCache.get(key);
  if (pending) return pending;
  const promise = api
    .resolveAssetUrls(kind, token)
    .then((urls) => {
      memoryCache.set(key, urls);
      pendingCache.delete(key);
      return urls;
    })
    .catch((err) => {
      pendingCache.delete(key);
      console.warn("[useAsset] resolve failed", kind, token, err);
      return [];
    });
  pendingCache.set(key, promise);
  return promise;
}

/**
 * 拿到一组素材候选 URL。`<AssetImage>` 组件会按序尝试，首个加载成功的
 * 即作为最终 src。调用方通常直接用 `<AssetImage>`，该 hook 主要给
 * 自定义渲染（例如 Canvas 画金句图）用。
 */
export function useAsset(kind: AssetKind | null, token: string | null | undefined): UseAssetState {
  const [state, setState] = useState<UseAssetState>({
    url: null,
    candidates: [],
    loading: Boolean(kind && token),
    error: false,
  });
  const cancelledRef = useRef(false);

  useEffect(() => {
    cancelledRef.current = false;
    if (!kind || !token) {
      setState({ url: null, candidates: [], loading: false, error: false });
      return;
    }
    setState({ url: null, candidates: [], loading: true, error: false });
    fetchCandidates(kind, token).then((urls) => {
      if (cancelledRef.current) return;
      setState({
        url: urls[0] ?? null,
        candidates: urls,
        loading: false,
        error: urls.length === 0,
      });
    });
    return () => {
      cancelledRef.current = true;
    };
  }, [kind, token]);

  return state;
}

/**
 * 直接同步返回 token 对应的 candidate 列表（仅读缓存，不触发请求）。
 * 用于对首屏性能敏感的场景。
 */
export function peekAssetCandidates(kind: AssetKind, token: string): string[] | null {
  return memoryCache.get(cacheKey(kind, token)) ?? null;
}

/** 用于金句卡/分享图等需要跨组件协作的用例。 */
export function useAssetCandidates(kind: AssetKind | null, token: string | null | undefined): string[] {
  const { candidates } = useAsset(kind, token);
  return useMemo(() => candidates, [candidates]);
}
