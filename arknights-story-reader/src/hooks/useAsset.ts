import { useEffect, useMemo, useState } from "react";
import type { AssetKind, CharacterIndex } from "@/types/story";
import { resolveAssetCandidatesLocal } from "@/lib/assetUrls";

interface UseAssetState {
  /** 首选可用的 URL；尚在请求/fallback 时为 null。 */
  url: string | null;
  /** 整条 candidate 链，组件可自行选择 fallback 顺序。 */
  candidates: string[];
  loading: boolean;
  error: boolean;
}

// ─────────────────────────────────────────────────────────────
// 全局共享的 character index。CharactersResolverProvider 启动时
// 拿一次后端快照 → 调用 `setGlobalCharacterIndex()` 注入到这里，
// 之后所有 `useAsset(avatar)` / `useAsset(portrait)` 的 URL 解析
// 都走纯 JS 同步逻辑，避免每次渲染都做一次 Tauri IPC。
//
// 性能注意：不再允许每个组件订阅索引变更——当 CharactersPanel 渲染
// 400+ 头像时，同时 400+ `useEffect(subscribe)` 会显著拖累滚动。
// 索引在启动后就稳定了（Provider 只 setState 一次），后续变动极少；
// 若真的变了，会触发一次全局 `asset:index-ready` window event，
// 对已挂载的敏感组件有需要可以单独监听。
// ─────────────────────────────────────────────────────────────

let globalCharIndex: CharacterIndex | null = null;
let indexReady = false;

export function setGlobalCharacterIndex(next: CharacterIndex | null) {
  globalCharIndex = next;
  indexReady = Boolean(next);
  if (typeof window !== "undefined") {
    try {
      window.dispatchEvent(new Event("asset:index-ready"));
    } catch {}
  }
}

export function getGlobalCharacterIndex(): CharacterIndex | null {
  return globalCharIndex;
}

/**
 * 同步拿到一条候选 URL 列表。零 IPC。
 *
 * - 对 avatar / portrait：索引未加载前返回空数组；加载后通过一次全局
 *   事件同步重新解析。
 * - 其他 kind：纯字符串拼接，随取随有。
 */
export function useAsset(
  kind: AssetKind | null,
  token: string | null | undefined
): UseAssetState {
  const needsIndex = kind === "avatar" || kind === "portrait";

  // 一旦索引就绪就停止监听，避免滚动时 400+ 监听器同时在线
  const [ready, setReady] = useState<boolean>(!needsIndex || indexReady);
  useEffect(() => {
    if (ready) return; // already ready
    if (!needsIndex) {
      setReady(true);
      return;
    }
    if (indexReady) {
      setReady(true);
      return;
    }
    const handler = () => setReady(true);
    window.addEventListener("asset:index-ready", handler);
    return () => window.removeEventListener("asset:index-ready", handler);
  }, [needsIndex, ready]);

  const candidates = useMemo(() => {
    if (!kind || !token) return EMPTY_CANDIDATES;
    if (needsIndex && !ready) return EMPTY_CANDIDATES;
    return resolveAssetCandidatesLocal(kind, token, globalCharIndex);
  }, [kind, token, needsIndex, ready]);

  return {
    url: candidates[0] ?? null,
    candidates,
    loading: false,
    error: candidates.length === 0 && Boolean(kind && token),
  };
}

// Stable empty array reference so `useMemo` never returns a fresh `[]` that
// invalidates downstream `useEffect` dep arrays.
const EMPTY_CANDIDATES: string[] = [];

/** 直接同步返回 token 对应的 candidate 列表。给 Canvas 分享图等场景。 */
export function peekAssetCandidates(kind: AssetKind, token: string): string[] {
  return resolveAssetCandidatesLocal(kind, token, globalCharIndex);
}

/** 用于金句卡/分享图等需要跨组件协作的用例。 */
export function useAssetCandidates(
  kind: AssetKind | null,
  token: string | null | undefined
): string[] {
  const { candidates } = useAsset(kind, token);
  return candidates;
}
