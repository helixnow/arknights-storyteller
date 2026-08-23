import { useCallback, useMemo, useSyncExternalStore } from "react";
import type { AssetKind, CharacterIndex } from "@/types/story";
import {
  getAssetHealthVersion,
  resolveAssetCandidatesLocal,
  subscribeAssetHealth,
} from "@/lib/assetUrls";

interface UseAssetState {
  /** 首选可用的 URL；尚在请求/fallback 时为 null。 */
  url: string | null;
  /** 整条 candidate 链，组件可自行选择 fallback 顺序。 */
  candidates: string[];
  /** 还在等角色索引落地——此时的空候选表不代表「这个素材没有」。 */
  loading: boolean;
  error: boolean;
}

// ─────────────────────────────────────────────────────────────
// 全局共享的 character index。CharactersResolverProvider 启动时
// 拿一次后端快照 → 调用 `setGlobalCharacterIndex()` 注入到这里，
// 之后所有 `useAsset(avatar)` / `useAsset(portrait)` 的 URL 解析
// 都走纯 JS 同步逻辑，避免每次渲染都做一次 Tauri IPC。
//
// 性能注意：不给每个组件挂 window listener——CharactersPanel 渲染
// 400+ 头像时，400+ `addEventListener` 会显著拖累滚动。这里改用一个
// 共享的订阅表（`useSyncExternalStore`），插入/删除都是 Set 操作，
// 且只在索引真的换了（generation +1）时才触发重渲染。
// ─────────────────────────────────────────────────────────────

let globalCharIndex: CharacterIndex | null = null;
let indexReady = false;
/**
 * 索引代际。数据同步完成后 Provider 会重新注入一份索引，此时早先按空索引
 * 算出来的候选表全部作废——组件必须重算，否则首启（数据尚未同步）挂载的
 * 头像会永远停在空候选上，直到下次冷启动。
 */
let indexGeneration = 0;
const indexSubscribers = new Set<() => void>();

// `kind|token` → candidate URL 列表。CharactersPanel 一屏几百个头像、
// 洞察面板每次开合都会重解析同一批名字，这里缓存下来既省掉重复的字符串
// 拼接，也保证返回的数组引用稳定（下游 useMemo / useEffect 不会误触发）。
//
// 这份缓存同时是「同一 token 的解析只做一次」的去重点：`useAsset`、
// `peekAssetCandidates`、`<StoryThumbnail>` 全部经由此处，同一个 token
// 在任何时刻都只有一份解析结果、一个数组引用。
const candidateCache = new Map<string, string[]>();
const CANDIDATE_CACHE_LIMIT = 4000;
const CANDIDATE_CACHE_EVICT = 1000;

// ─────────────────────────────────────────────────────────────
// 死模板修正
//
// assetUrls.ts 有两处模板与镜像仓库的真实文件布局不符，拼出的 URL 是
// 全库 404（用仓库目录清单核实过）：
//   1. fexli 的 `charpor/{cid}.png` —— 该目录下所有文件都带精英化后缀，
//      绝大多数干员有 `{cid}_1.png`，个别（近卫阿米娅等）只有 `{cid}_2.png`，
//      裸 `{cid}.png` 一个都不存在；
//   2. Puppiiz 的 `storyline/images/` 与 `storyline/backgrounds/` ——
//      仓库里没有这两个子目录（storyline/ 下只有一批 abbr 图标）。
// 必失败的候选不只是浪费一次请求：每次 onerror 都会给所属 host 的熔断
// 计数记一笔账，一屏头像/插画攒够 8 次就把整个 host 熔断，连坐该源上
// 明明存在的素材。所有候选解析（useAsset / peekAssetCandidates）都经过
// 本文件这一个出口，在进缓存前统一修正；Rust 侧 asset_service.rs 的模板
// 已同步改成修正后的形态。
// ─────────────────────────────────────────────────────────────
const FEXLI_CHARPOR_PREFIX =
  "https://raw.githubusercontent.com/fexli/ArknightsResource/main/charpor/";
const PUPPIIZ_STORYLINE_PREFIX =
  "https://raw.githubusercontent.com/PuppiizSunniiz/Arknight-Images/main/storyline/";

function repairDeadTemplates(urls: string[]): string[] {
  const out: string[] = [];
  for (const url of urls) {
    if (
      url.startsWith(`${PUPPIIZ_STORYLINE_PREFIX}images/`) ||
      url.startsWith(`${PUPPIIZ_STORYLINE_PREFIX}backgrounds/`)
    ) {
      continue;
    }
    if (
      url.startsWith(FEXLI_CHARPOR_PREFIX) &&
      url.endsWith(".png") &&
      // 已带精英后缀的（假想的未来形态）不再重复加工。
      !/_\d+\.png$/.test(url)
    ) {
      const stem = url.slice(0, -".png".length);
      out.push(`${stem}_1.png`, `${stem}_2.png`);
      continue;
    }
    out.push(url);
  }
  return out;
}

function resolveCandidatesCached(kind: AssetKind, token: string): string[] {
  const key = `${kind}|${token}`;
  const hit = candidateCache.get(key);
  if (hit) return hit;
  const next = repairDeadTemplates(
    resolveAssetCandidatesLocal(kind, token, globalCharIndex)
  );
  if (candidateCache.size >= CANDIDATE_CACHE_LIMIT) {
    // 整表清空会让还挂在屏幕上的组件拿到全新数组引用、白白重挂 `<img>`；
    // 按插入顺序淘汰最老的一批，正在渲染的那些通常刚被访问过。
    let removed = 0;
    for (const stale of candidateCache.keys()) {
      candidateCache.delete(stale);
      removed += 1;
      if (removed >= CANDIDATE_CACHE_EVICT) break;
    }
  }
  candidateCache.set(key, next);
  return next;
}

export function setGlobalCharacterIndex(next: CharacterIndex | null) {
  if (next === globalCharIndex) return;
  globalCharIndex = next;
  indexReady = Boolean(next);
  // 索引换了，之前按旧索引算出来的 charId 全部作废。
  candidateCache.clear();
  indexGeneration += 1;
  indexSubscribers.forEach((notify) => {
    try {
      notify();
    } catch {}
  });
  if (typeof window !== "undefined") {
    try {
      window.dispatchEvent(new Event("asset:index-ready"));
    } catch {}
  }
}

export function getGlobalCharacterIndex(): CharacterIndex | null {
  return globalCharIndex;
}

function subscribeIndex(onChange: () => void): () => void {
  indexSubscribers.add(onChange);
  return () => {
    indexSubscribers.delete(onChange);
  };
}

function getIndexGeneration(): number {
  return indexGeneration;
}

/**
 * 同步拿到一条候选 URL 列表。零 IPC。
 *
 * - 对 avatar / portrait：`char_` id 与 NPC 覆盖表不经索引就能解析，
 *   立即返回候选（首选通常是本地打包文件）；名字/alias 类 token 在索引
 *   未加载前返回空数组并把 `loading` 置真，索引落地（或被换成新快照）
 *   后自动重算。
 * - 其他 kind：纯字符串拼接，随取随有。
 */
export function useAsset(
  kind: AssetKind | null,
  token: string | null | undefined
): UseAssetState {
  const needsIndex = kind === "avatar" || kind === "portrait";
  // 订阅索引代际。非 avatar/portrait 的素材跟索引无关，直接读快照即可，
  // 连 Set 插入都省了。
  const subscribe = useCallback(
    (onChange: () => void) => (needsIndex ? subscribeIndex(onChange) : NOOP_UNSUBSCRIBE),
    [needsIndex]
  );
  const generation = useSyncExternalStore(subscribe, getIndexGeneration, getIndexGeneration);

  const candidates = useMemo(() => {
    if (!kind || !token) return EMPTY_CANDIDATES;
    // 索引未落地也先解析：`char_` id / NPC 覆盖表不查索引，密录立绘、
    // NPC 头像（本地文件）不必等 character_table 的 IPC——那次请求慢
    // 或失败时，这些明明可解析的图会白白停在兜底上。名字类 token 此时
    // 解析出的空数组会被缓存，但索引注入即清缓存 + bump generation，
    // 不会有陈旧命中。
    return resolveCandidatesCached(kind, token);
    // `generation` 是索引快照的版本号：它变了就必须重算，哪怕 token 没动。
  }, [kind, token, generation]);

  // 只有「解析结果为空 且 索引还没落地」才是在等索引；解析已经出结果的
  // token（char_ id、NPC 覆盖表）跟索引无关，不该报 loading。
  const pending = needsIndex && !indexReady && candidates.length === 0;

  return {
    url: candidates[0] ?? null,
    candidates,
    loading: pending && Boolean(kind && token),
    error: !pending && candidates.length === 0 && Boolean(kind && token),
  };
}

const NOOP_UNSUBSCRIBE = () => {};

// Stable empty array reference so `useMemo` never returns a fresh `[]` that
// invalidates downstream `useEffect` dep arrays.
const EMPTY_CANDIDATES: string[] = [];

/** 直接同步返回 token 对应的 candidate 列表。给 Canvas 分享图等场景。 */
export function peekAssetCandidates(kind: AssetKind, token: string): string[] {
  if (!token) return EMPTY_CANDIDATES;
  return resolveCandidatesCached(kind, token);
}

/** 用于金句卡/分享图等需要跨组件协作的用例。 */
export function useAssetCandidates(
  kind: AssetKind | null,
  token: string | null | undefined
): string[] {
  const { candidates } = useAsset(kind, token);
  return candidates;
}

/**
 * 订阅「候选健康度变好了」（host 熔断窗口到期、某个源首次被证明可达）。
 * 返回值本身没有意义，只是一个会变的版本号，用来把组件重新渲染一次、
 * 让它重跑 `pickLiveCandidate`。
 *
 * `active` 为假时不订阅：正常显示图片的组件不该为此付出任何代价，只有
 * 已经退化成兜底色块、且还有候选等着解封的组件才需要被叫醒。
 */
export function useAssetHealthNonce(active: boolean): number {
  const subscribe = useCallback(
    (onChange: () => void) => (active ? subscribeAssetHealth(onChange) : NOOP_UNSUBSCRIBE),
    [active]
  );
  return useSyncExternalStore(subscribe, getAssetHealthVersion, getAssetHealthVersion);
}
