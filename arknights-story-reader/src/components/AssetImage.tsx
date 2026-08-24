import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
} from "react";
import { cn } from "@/lib/utils";
import { useAsset, useAssetHealthNonce } from "@/hooks/useAsset";
import {
  getAssetRecoveryAction,
  gradientFallbackBackground,
  hasRecoverableCandidate,
  isStaleOfflineAssetError,
  markAssetUrlAlive,
  markAssetUrlDead,
  pickLiveCandidate,
  type AssetIssueNetSnapshot,
} from "@/lib/assetUrls";
import type { AssetKind } from "@/types/story";

interface AssetImageProps {
  kind: AssetKind;
  token: string | null | undefined;
  alt?: string;
  className?: string;
  style?: CSSProperties;
  /**
   * 在素材主题下"降饱和 + 主题色混色"的变体。`auto` 表示由父级决定；
   * `none` 表示彩色；`tint` 表示强烈上色；`soft` 为默认（柔和）。
   */
  tint?: "auto" | "none" | "soft" | "tint";
  /** 加载失败时显示的兜底节点（通常是首字母 monogram 或渐变色块）。 */
  fallback?: React.ReactNode;
  /** 懒加载开关；默认 true。 */
  lazy?: boolean;
  /** 加载完成回调，可用于父级切换 skeleton。 */
  onReady?: (url: string) => void;
  /** 所有 URL 都加载失败时调用，父级可用来隐藏自己。 */
  onExhausted?: () => void;
  /**
   * 图像缩放策略：
   *  - `cover`（默认）：拉满容器并裁剪，用于封面/头像等固定框。
   *  - `contain`：保持宽高比铺满容器，不裁剪（容器大小固定）。
   *  - `natural`：按图片自身尺寸居中显示，容器自适应高度，适用于
   *    内文插画——这样竖图、方图都能完整呈现，不会被 16:9 切掉。
   */
  fit?: "cover" | "contain" | "natural";
}

/**
 * 已知素材的原始像素尺寸。`fit="natural"` 的插画没有固定容器，重新挂载
 * （虚拟滚动、切章回来）时如果不给 `<img>` 内在尺寸，浏览器会先按 0 高
 * 布局、图片到位再撑开，正文因此上下跳一次。本会话内加载过一次之后就把
 * 尺寸记下来，后续挂载直接用它预留空间。
 */
const naturalSizes = new Map<string, { width: number; height: number }>();
const NATURAL_SIZE_LIMIT = 2000;

function rememberNaturalSize(url: string, width: number, height: number) {
  if (!width || !height) return;
  if (naturalSizes.has(url)) return;
  if (naturalSizes.size >= NATURAL_SIZE_LIMIT) {
    const oldest = naturalSizes.keys().next();
    if (!oldest.done) naturalSizes.delete(oldest.value);
  }
  naturalSizes.set(url, { width, height });
}

// ─────────────────────────────────────────────────────────────
// 离线恢复
//
// `navigator.onLine === false` 时 img.onerror 不是「这条 URL 404」的可靠
// 判决，此时不能往共享失败缓存里记账：host 一旦被证明可达（proven），
// `markAssetUrlAlive` 不会再撤销它名下的失败记录，离线窗口里写进去的
// 「死链」在网络恢复后整个会话都洗不掉——这正是「会话中途断过一次网，
// 之后那批头像/封面永远停在兜底上」的根因（首启就离线的场景已由
// markAssetUrlAlive 的存疑撤销覆盖，这里补上 proven host 的窗口）。
// 所以离线期间的失败只推进本地游标、完全不落账，并在网络恢复（`online`
// 事件）时把游标拨回 0，整条候选链原样重试。
//
// 「离线期间」按请求发出的时刻算，不是 onerror 落地的时刻：断网时挂起的
// 在途请求常常拖到网络恢复之后才报错，那一刻 `navigator.onLine` 已经是
// true，单看错误时刻会把这次不可靠的失败当真 404 落账。串行 fallback 下
// 每次断网每个组件恰好有一条这样的在途请求，host 已 proven 时这笔账整个
// 会话都撤销不掉。所以发起请求时记一份网络快照（`getOnlineVersion` +
// `isBrowserOffline`），onerror 时「发出时离线，或发出后经历过 online
// 事件」都视同离线余波。
//
// 与 `useAssetHealthNonce` 同一套共享订阅表模式：整个模块只挂一个
// window listener，不随组件数量增长。
// ─────────────────────────────────────────────────────────────
let onlineVersion = 0;
const onlineSubscribers = new Set<() => void>();
if (typeof window !== "undefined") {
  window.addEventListener("online", () => {
    onlineVersion += 1;
    onlineSubscribers.forEach((notify) => {
      try {
        notify();
      } catch {}
    });
  });
}

/**
 * 「网络恢复」事件的版本号。请求发出时记下它，onerror 时不相等就说明
 * 这条请求横跨了一次断网窗口——错误判决不可靠，不该写进共享失败缓存。
 * `<StoryThumbnail>` 与本组件共用。
 */
export function getOnlineVersion(): number {
  return onlineVersion;
}

export type IssueNetSnapshot = AssetIssueNetSnapshot;

/** 这次 onerror 是否属于离线余波（发出时离线，或在途期间网络恢复过）。 */
export function isStaleOfflineError(
  issue: IssueNetSnapshot | null,
  failedUrl: string
): boolean {
  return isStaleOfflineAssetError(issue, failedUrl, onlineVersion);
}

const NOOP_UNSUBSCRIBE = () => {};

/** 浏览器当前是否明确处于离线状态。拿不到 navigator 时按在线算。 */
export function isBrowserOffline(): boolean {
  return typeof navigator !== "undefined" && navigator.onLine === false;
}

/**
 * 订阅「网络刚恢复」。返回值本身没有意义，只是一个会变的版本号，用来把
 * 组件重新渲染一次、让它重扫候选链。`active` 为假时不订阅：正常显示、
 * 或没有离线失败记录的组件不该为此付出任何代价。
 */
export function useOnlineRecoveryNonce(active: boolean): number {
  const subscribe = useCallback(
    (onChange: () => void) => {
      if (!active) return NOOP_UNSUBSCRIBE;
      onlineSubscribers.add(onChange);
      return () => {
        onlineSubscribers.delete(onChange);
      };
    },
    [active]
  );
  return useSyncExternalStore(subscribe, getOnlineVersion, getOnlineVersion);
}

/**
 * 统一的素材 `<img>` 封装。性能注意点：
 *
 * 1. **不用 IntersectionObserver**。上一版给每个实例挂一个 observer，
 *    CharactersPanel 400+ 头像直接把滚动主线程压死。改用浏览器原生
 *    `loading="lazy"`，0 JS 成本。
 * 2. **不订阅全局 index**。index 通过 `useAsset` 的共享订阅表统一分发，
 *    只有真的换了快照（数据同步完成）才会重渲染。
 * 3. **不每帧 filter**。失败记录集中在 `@/lib/assetUrls`（与
 *    `<StoryThumbnail>` 共用一份），只在 onLoad / onError 时读写一次，
 *    候选链直接来自 `useAsset` 的 memo 化结果。
 * 4. **解码异步化**。`onLoad` 之后先 `img.decode()` 再淡入，大图的解码
 *    不会卡住滚动，也不会出现"解了一半"的图。
 */
export function AssetImage({
  kind,
  token,
  alt,
  className,
  style,
  tint = "soft",
  fallback,
  lazy = true,
  onReady,
  onExhausted,
  fit = "cover",
}: AssetImageProps) {
  const { candidates, loading } = useAsset(kind, token ?? null);
  const [currentIdx, setCurrentIdx] = useState(0);
  // 同一 URL 的离线余波要在网络恢复后原地重发一次。仅重置游标不会让
  // React 重挂相同 key/src 的 <img>，所以用 nonce 明确创建一轮新请求。
  const [requestNonce, setRequestNonce] = useState(0);
  const [loaded, setLoaded] = useState(false);
  /** 成功解码并正在展示的 URL；`loaded` 只在它与当前候选一致时才算数。 */
  const loadedUrlRef = useRef<string | null>(null);
  /** 有失败发生在离线窗口内（没写进共享失败缓存），等 online 后要重试。 */
  const offlineFailedRef = useRef(false);
  const exhaustedFiredRef = useRef(false);

  // 候选集合变了就重置。key 用字符串拼接而非数组引用比较，避免 memo
  // 失效时白白 setState。
  //
  // 重置必须在渲染期同步做（与 `<StoryThumbnail>` 同一套模式），不能放进
  // useEffect：token 原地切换（阅读器切章时 ReaderImageSegment 按位置复用）
  // 的那一帧里，新候选表会配上旧游标——pickLiveCandidate 从过期下标起扫，
  // 可能扫空并把 `exhausted` 误判为真；若父级传的是内联 onExhausted（引用
  // 每次渲染都变），上报 effect 会在重置 effect 清掉 fired 标记之后重跑，
  // 一次虚假的 onExhausted 就把本来加载得出的插画段永久隐藏了。
  const candidatesKey = candidates.join("|");
  const appliedKeyRef = useRef(candidatesKey);
  if (appliedKeyRef.current !== candidatesKey) {
    appliedKeyRef.current = candidatesKey;
    exhaustedFiredRef.current = false;
    loadedUrlRef.current = null;
    offlineFailedRef.current = false;
    setCurrentIdx(0);
    setRequestNonce(0);
    setLoaded(false);
  }

  // `currentIdx` 只是游标下界；真正跳过哪些候选由共享的失败缓存 +
  // host 熔断决定，这两者都在 onLoad / onError 里 mutate，不触发 re-render。
  const currentUrl = pickLiveCandidate(candidates, currentIdx);

  // 全部候选都被跳过时区分两种情况：URL 自己 404（真没了）和 host 正在
  // 熔断（等窗口结束还能再试）。后者先不上报 exhausted —— 否则一次断网
  // 会让阅读器把插画段永久删掉。
  //
  // 健康度订阅不能只看「熔断中」：markAssetUrlAlive 在 host 首次被证明
  // 可达时会撤销该 host 此前的 URL 级失败记录（那些失败发生在源不可达的
  // 窗口内，判决不可靠），候选全部标死的组件也要被叫醒重试，否则断网
  // 期间打开过的头像/封面在网络恢复后永远停在兜底上。
  const stuck = currentUrl === null && candidates.length > 0;
  const recoverable = stuck && hasRecoverableCandidate(candidates, currentIdx);
  const healthNonce = useAssetHealthNonce(stuck);
  // 健康事件到来时把游标拨回 0 重扫整条候选链：被撤销失败记录的 URL 可能
  // 排在游标之前；真正失败过的仍会被 deadUrls 跳过，不会原地打转。
  const healthNonceRef = useRef(healthNonce);
  const healthRecoveryAction = getAssetRecoveryAction(
    healthNonceRef.current,
    healthNonce,
    stuck,
    stuck ||
      (currentUrl !== null &&
        !(loaded && loadedUrlRef.current === currentUrl.url))
  );
  if (healthRecoveryAction === "retry") {
    healthNonceRef.current = healthNonce;
    setCurrentIdx(0);
  } else if (healthRecoveryAction === "observe") {
    healthNonceRef.current = healthNonce;
  }

  // 网络恢复时重试离线窗口内失败过的候选。那些失败没有写进共享缓存
  // （见模块顶部说明），游标拨回 0 后会被原样重新请求。
  const onlineNonce = useOnlineRecoveryNonce(stuck && offlineFailedRef.current);
  const onlineNonceRef = useRef(onlineNonce);
  const onlineRecoveryAction = getAssetRecoveryAction(
    onlineNonceRef.current,
    onlineNonce,
    stuck,
    offlineFailedRef.current
  );
  if (onlineRecoveryAction === "retry") {
    onlineNonceRef.current = onlineNonce;
    offlineFailedRef.current = false;
    setCurrentIdx(0);
  } else if (onlineRecoveryAction === "observe") {
    onlineNonceRef.current = onlineNonce;
  }

  // `loaded` 只对当初解码成功的那条 URL 有效。正在展示的 URL 可能被另一
  // 条渲染路径（同一张图出现在两处）标死，pickLiveCandidate 随即换到下
  // 一条候选——此时 <img> 已换 src 但还没有像素，不能再顶着 loaded=true
  // 把兜底藏起来，否则用户会看到一格空白、然后新图无过渡地弹出（候选被
  // 跳空时更是整个格子直接放空）。渲染期同步纠正，与上面 candidatesKey
  // 的重置同一套模式。
  if (loaded && loadedUrlRef.current !== (currentUrl?.url ?? null)) {
    setLoaded(false);
  }

  // 离线失败没有落账，共享缓存里不会产生任何能把父级叫回来的事件；此时
  // 上报 exhausted 会让父级（如 ReaderImageSegment）把这一段卸载，online
  // 重试就永远没机会了。先按住不报，网络恢复后重试仍全灭的才是真 404。
  const exhausted =
    !loading &&
    !recoverable &&
    !offlineFailedRef.current &&
    candidates.length > 0 &&
    currentUrl === null;
  const noneAvailable = !loading && candidates.length === 0;

  useEffect(() => {
    if ((exhausted || noneAvailable) && !exhaustedFiredRef.current) {
      exhaustedFiredRef.current = true;
      onExhausted?.();
    }
  }, [exhausted, noneAvailable, onExhausted]);

  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);
  const currentUrlRef = useRef<string | null>(null);
  currentUrlRef.current = currentUrl?.url ?? null;

  // 当前候选发起请求那一刻的网络快照（见模块顶部「离线期间按发出时刻算」）。
  // 渲染的 URL 换了才刷新——img 以 URL 为 key，URL 不变就不会重新发请求。
  const issueNetRef = useRef<IssueNetSnapshot | null>(null);
  if (issueNetRef.current === null || issueNetRef.current.url !== (currentUrl?.url ?? null)) {
    issueNetRef.current = {
      url: currentUrl?.url ?? null,
      version: getOnlineVersion(),
      offline: isBrowserOffline(),
    };
  }

  const tintClass =
    tint === "none"
      ? ""
      : tint === "tint"
      ? "asset-tinted asset-tinted--strong"
      : tint === "soft"
      ? "asset-tinted"
      : "";

  // 只有 `natural` 需要内在尺寸：其余 fit 的盒子由容器决定，给了也会被
  // `h-full w-full` 覆盖掉。
  const reservedSize =
    fit === "natural" && currentUrl ? naturalSizes.get(currentUrl.url) ?? null : null;

  return (
    <div
      className={cn(
        "asset-image-slot relative",
        fit === "natural" ? "flex items-center justify-center" : "overflow-hidden",
        className
      )}
      style={style}
      data-asset-loaded={loaded ? "true" : "false"}
    >
      {currentUrl ? (
        <img
          key={`${currentUrl.url}::${requestNonce}`}
          src={currentUrl.url}
          alt={alt ?? ""}
          loading={lazy ? "lazy" : "eager"}
          decoding="async"
          fetchPriority={lazy ? "low" : "high"}
          width={reservedSize?.width}
          height={reservedSize?.height}
          referrerPolicy="no-referrer"
          draggable={false}
          onLoad={(event) => {
            const img = event.currentTarget;
            const url = currentUrl.url;
            markAssetUrlAlive(url);
            rememberNaturalSize(url, img.naturalWidth, img.naturalHeight);
            const show = () => {
              if (!mountedRef.current || currentUrlRef.current !== url) return;
              loadedUrlRef.current = url;
              offlineFailedRef.current = false;
              setLoaded(true);
              onReady?.(url);
            };
            // 解码失败（极少见的损坏图）也走同一条路径：让 onError 之外的
            // 兜底逻辑保持简单，图画不出来时顶多是淡入一张空图。
            if (typeof img.decode === "function") {
              img.decode().then(show, show);
            } else {
              show();
            }
          }}
          onError={() => {
            if (isBrowserOffline()) {
              // 离线时的失败不落账（见模块顶部说明），只推进本地游标；
              // 候选烧完后停在 stuck 态，等 online 事件拨回游标重试。
              offlineFailedRef.current = true;
            } else if (isStaleOfflineError(issueNetRef.current, currentUrl.url)) {
              // online 已经发生，不能等下一次事件；原地重挂同一 URL，让恢复
              // 后的网络给出一次可信结果。否则它若恰好是最后一个候选，
              // 推进游标会误报 exhausted，阅读器会永久卸掉这段插画。
              issueNetRef.current = {
                url: currentUrl.url,
                version: getOnlineVersion(),
                offline: false,
              };
              setRequestNonce((nonce) => nonce + 1);
              return;
            } else {
              markAssetUrlDead(currentUrl.url);
            }
            setCurrentIdx(Math.min(currentUrl.index + 1, candidates.length));
          }}
          className={cn(
            "asset-image motion-safe:transition-opacity motion-safe:duration-300",
            fit === "natural"
              ? "max-w-full h-auto w-auto mx-auto block"
              : fit === "contain"
              ? "h-full w-full object-contain"
              : "h-full w-full object-cover",
            tintClass,
            loaded ? "opacity-100" : "opacity-0"
          )}
        />
      ) : null}
      {/* 兜底常驻（与 <StoryThumbnail> 同款）：此前按条件卸载，loaded 翻真
          的那一帧兜底整个消失，而图片还要 300ms 才淡入完——交叉淡入退化
          成「闪一下槽位底色再浮出图」。常驻只切 opacity 才是真 crossfade；
          pointer-events-none 保证淡出后这层不挡图片的右键 / 长按。 */}
      <div
        className={cn(
          "asset-image-fallback pointer-events-none absolute inset-0 flex items-center justify-center motion-safe:transition-opacity motion-safe:duration-300",
          loaded && !exhausted && !noneAvailable ? "opacity-0" : "opacity-100"
        )}
        aria-hidden="true"
      >
        {fallback ?? <GradientFallback seed={token ?? ""} />}
      </div>
    </div>
  );
}

/**
 * 默认 fallback：纯渐变色块。不显示 monogram 文字——`ac`/`bg`/`act17side`
 * 这种缩写比空着更丑。调用方（例如 CharacterAvatar）需要文字占位时自己传
 * `fallback` prop。
 */
function GradientFallback({ seed }: { seed: string }) {
  const style: CSSProperties = { background: gradientFallbackBackground(seed) };
  return <div style={style} className="h-full w-full" />;
}
