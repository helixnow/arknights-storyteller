import { useEffect, useMemo, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { useStoryPreview } from "@/hooks/useStoryPreview";
import {
  getOnlineVersion,
  isBrowserOffline,
  isStaleOfflineError,
  useOnlineRecoveryNonce,
  type IssueNetSnapshot,
} from "@/components/AssetImage";
import { peekAssetCandidates, useAssetHealthNonce } from "@/hooks/useAsset";
import {
  getAssetRecoveryAction,
  gradientFallbackBackground,
  markAssetUrlAlive,
  markAssetUrlDead,
  pickLiveCandidate,
} from "@/lib/assetUrls";
import type { StoryEntry } from "@/types/story";
import {
  getStoryThumbnailSources,
  thumbnailCandidateTransition,
} from "@/components/storyThumbnailSources";

/**
 * 剧情列表/首页上的缩略图。优先展示该关卡剧情里真正出现的那张插画；
 * 拿不到时退化到章节/活动封面。视觉上撑满调用方提供的容器。
 */
interface StoryThumbnailProps {
  story: StoryEntry;
  className?: string;
  alt?: string;
  lazy?: boolean;
  tint?: "none" | "soft";
}

export function StoryThumbnail({
  story,
  className,
  alt,
  lazy = true,
  tint = "soft",
}: StoryThumbnailProps) {
  const { token: previewToken } = useStoryPreview(story.storyTxt);

  // 候选表统一走 `peekAssetCandidates` 的按-token 缓存：同一张封面在列表
  // 缩略图和卡片模糊背景里各渲染一次，两处拿到的是同一个数组引用，字符串
  // 拼接也只做一次。
  const candidates = useMemo(() => {
    const urls = getStoryThumbnailSources(story, previewToken).flatMap(({ kind, token }) =>
      peekAssetCandidates(kind, token)
    );
    return Array.from(new Set(urls));
  }, [previewToken, story.storyGroup, story.storyPic, story.storyTxt]);

  // ---- 图片加载状态 ----
  // 用 ref 跟踪当前成功加载的 URL。候选变化后它仍是首选就原位保留；若
  // 篇内插画晚到、把它挤到后面，则作为 bridge 垫底并从新首选开始升级。
  const loadedUrlRef = useRef<string | null>(null);
  /** 有失败发生在离线窗口内（没写进共享失败缓存），等 online 后要重试。 */
  const offlineFailedRef = useRef(false);
  const [cursor, setCursor] = useState(0);
  // 离线余波落地时需要原地重挂相同 URL；只把 cursor 留在原处不会让
  // React 对同一个 key/src 再发请求。
  const [requestNonce, setRequestNonce] = useState(0);
  const [loaded, setLoaded] = useState(false);
  /** 篇内插画晚到时用已解码的章节/活动封面垫底，直到新首选解码完成。 */
  const [bridgeUrl, setBridgeUrl] = useState<string | null>(null);

  // candidates 变了就同步 state（React 允许在 render 中条件性 setState，
  // 只要不会无限循环）。
  const candidatesKey = candidates.join("|");
  const appliedKeyRef = useRef(candidatesKey);
  if (appliedKeyRef.current !== candidatesKey) {
    appliedKeyRef.current = candidatesKey;
    offlineFailedRef.current = false;
    setRequestNonce(0);
    const transition = thumbnailCandidateTransition(candidates, loadedUrlRef.current);
    setCursor(transition.cursor);
    setLoaded(transition.loaded);
    setBridgeUrl(transition.bridgeUrl);
    if (!transition.loaded && !transition.bridgeUrl) {
      loadedUrlRef.current = null;
    }
  }

  // 与 `<AssetImage>` 共用同一份失败缓存 / host 熔断：同一张 404 的封面
  // 不会因为走了两条渲染路径就被请求两遍。
  const live = pickLiveCandidate(candidates, cursor);
  // 候选全被跳过（host 熔断或 URL 标死）都订阅健康度事件：host 首次被
  // 证明可达时 markAssetUrlAlive 会撤销此前的存疑失败记录，此时把游标
  // 拨回 0 重扫候选链——否则断网期间看过的封面在网络恢复后永远停在
  // 渐变兜底上。真正失败过的 URL 仍被 deadUrls 跳过，不会原地打转；
  // 图片正常显示时不订阅，零开销。
  const stuck = live === null && candidates.length > 0;
  const visuallyLoaded = Boolean(live && loadedUrlRef.current === live.url) || loaded;
  const healthNonce = useAssetHealthNonce(stuck);
  const healthNonceRef = useRef(healthNonce);
  const healthRecoveryAction = getAssetRecoveryAction(
    healthNonceRef.current,
    healthNonce,
    stuck,
    stuck || (live !== null && !visuallyLoaded)
  );
  if (healthRecoveryAction === "retry") {
    healthNonceRef.current = healthNonce;
    setCursor(0);
  } else if (healthRecoveryAction === "observe") {
    healthNonceRef.current = healthNonce;
  }

  // 网络恢复时重试离线窗口内失败过的候选。离线时 onerror 不是「404」的
  // 可靠判决，不会写进共享失败缓存（proven host 的失败记录一旦写入就
  // 永远撤销不掉，断过一次网的封面会整个会话停在渐变兜底上），所以只在
  // 本地记一笔，online 事件到来时把游标拨回 0 原样重扫。
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
    setCursor(0);
  } else if (onlineRecoveryAction === "observe") {
    onlineNonceRef.current = onlineNonce;
  }

  // `loaded` 只对当初解码成功的那条 URL 有效。正在展示的 URL 可能被另一
  // 条渲染路径（同一张封面同时出现在列表缩略图和卡片模糊背景里）标死，
  // pickLiveCandidate 随即换到下一条候选——此时 <img> 已换 src 但还没有
  // 像素，不能再顶着 loaded=true 把渐变兜底藏起来，否则卡片会先放空一格、
  // 然后新图无过渡地弹出。渲染期同步纠正，与上面 candidatesKey 同一套模式。
  if (loaded && loadedUrlRef.current !== (live?.url ?? null)) {
    setLoaded(false);
  }

  // bridge 也要尊重共享失败表/host 熔断。另一条渲染路径已证明它失效时，
  // 不能为了无闪烁继续把旧图钉在屏幕上。
  const liveBridge =
    bridgeUrl && bridgeUrl !== live?.url
      ? pickLiveCandidate([bridgeUrl], 0)?.url ?? null
      : null;

  // 解码放到主线程之外：滚动时一张 1920px 的活动 KV 同步解码足以掉帧。
  // 解码完成前保持兜底色块，完成后再淡入，避免"半张图"闪现。
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);
  const currentUrlRef = useRef<string | null>(null);
  currentUrlRef.current = live?.url ?? null;

  // 当前候选发起请求那一刻的网络快照。断网时挂起的在途请求常拖到网络
  // 恢复后才报错，那一刻 navigator.onLine 已是 true，单看错误时刻会把
  // 这次不可靠的失败当真 404 永久落账（host 已 proven 时撤销不掉）。
  // 与 <AssetImage> 同一套判定：发出时离线、或在途期间经历过 online
  // 事件，都视同离线余波。URL 换了才刷新——img 以 URL 为 key。
  const issueNetRef = useRef<IssueNetSnapshot | null>(null);
  if (issueNetRef.current === null || issueNetRef.current.url !== (live?.url ?? null)) {
    issueNetRef.current = {
      url: live?.url ?? null,
      version: getOnlineVersion(),
      offline: isBrowserOffline(),
    };
  }

  const tintClass = tint === "soft" ? "filter saturate-[0.85]" : "";

  return (
    <div
      className={cn(
        "absolute inset-0 h-full w-full overflow-hidden bg-[hsl(var(--color-secondary)/0.4)]",
        className
      )}
    >
      {/* 兜底色块常驻：卡片的宽高由调用方的容器决定，这里只做淡入淡出，
          既不会在图片到位的瞬间产生一次 DOM 增删，也不会有任何布局位移。 */}
      <GradientFallback
        seed={story.storyGroup || story.storyId}
        hidden={(Boolean(live) && visuallyLoaded) || Boolean(liveBridge)}
      />
      {liveBridge ? (
        <img
          src={liveBridge}
          alt=""
          aria-hidden="true"
          loading="eager"
          decoding="async"
          referrerPolicy="no-referrer"
          draggable={false}
          className={cn("absolute inset-0 h-full w-full object-cover", tintClass)}
        />
      ) : null}
      {live ? (
        <img
          key={`${live.url}::${requestNonce}`}
          src={live.url}
          alt={alt ?? story.storyName}
          loading={lazy ? "lazy" : "eager"}
          decoding="async"
          fetchPriority={lazy ? "low" : "high"}
          referrerPolicy="no-referrer"
          draggable={false}
          onLoad={(event) => {
            const img = event.currentTarget;
            const url = live.url;
            markAssetUrlAlive(url);
            const show = () => {
              if (!mountedRef.current || currentUrlRef.current !== url) return;
              loadedUrlRef.current = url;
              offlineFailedRef.current = false;
              setBridgeUrl(null);
              setLoaded(true);
            };
            if (typeof img.decode === "function") {
              img.decode().then(show, show);
            } else {
              show();
            }
          }}
          onError={() => {
            if (isBrowserOffline()) {
              // 离线时的失败不落账，只推进本地游标；候选烧完后停在
              // stuck 态，等 online 事件拨回游标重试。
              offlineFailedRef.current = true;
            } else if (isStaleOfflineError(issueNetRef.current, live.url)) {
              // online 已经过去，不能再靠恢复订阅叫醒；重挂当前 URL 取得
              // 一次恢复后的可信结果。最后一条候选也不会因此被误推进到空。
              issueNetRef.current = {
                url: live.url,
                version: getOnlineVersion(),
                offline: false,
              };
              setRequestNonce((nonce) => nonce + 1);
              return;
            } else {
              markAssetUrlDead(live.url);
            }
            setCursor(Math.min(live.index + 1, candidates.length));
          }}
          className={cn(
            "absolute inset-0 h-full w-full object-cover motion-safe:transition-opacity motion-safe:duration-300",
            tintClass,
            visuallyLoaded ? "opacity-100" : "opacity-0"
          )}
        />
      ) : null}
    </div>
  );
}

/**
 * 纯渐变兜底。`.story-thumbnail-fallback` 是 index.css 里约定好的钩子——
 * `.story-card-memory-bg` 靠它把这块装饰色块藏掉，否则封面加载失败时卡片
 * 背后会冒出一块跟卡片底色打架的渐变。
 */
function GradientFallback({ seed, hidden }: { seed: string; hidden: boolean }) {
  return (
    <div
      aria-hidden="true"
      className={cn(
        "story-thumbnail-fallback absolute inset-0 motion-safe:transition-opacity motion-safe:duration-300",
        hidden ? "opacity-0" : "opacity-100"
      )}
      style={{ background: gradientFallbackBackground(seed) }}
    />
  );
}
