import { useEffect, useRef, type RefObject } from "react";
import { BACK_PRIORITY, getOverlayHandlerCount, requestBack } from "@/hooks/useBackHandler";

interface Options {
  /** Pixel width of the left-edge zone that initiates the gesture. */
  edgeWidth?: number;
  /** Minimum horizontal distance (px) before we declare "back" intent. */
  threshold?: number;
  /** Maximum vertical drift allowed while swiping. */
  maxDeviation?: number;
  /** Only active when `true`. */
  enabled: boolean;
  /**
   * 宿主视图是否在前台。`enabled=false` 也可能只是因为阅读器里开着菜单：
   * 那种情况下 pointerdown 采样器必须保留，才能识别“同一根手指先关菜单”
   * 的竞态；KeepAlive 真正退到后台时则连采样器都必须摘掉。
   */
  active?: boolean;
  /** Callback invoked when a back gesture is confirmed. */
  onBack: () => void;
  /**
   * 手势先让 overlay 级别的返回处理器（抽屉 / 菜单 / 选择模式）消费，只有
   * 没人接手时才调用 `onBack`。这样边缘返回和硬件返回键走同一条优先级链，
   * 不会出现「菜单还开着，一划就把整个视图关了」。若浮层已被这根手指按下
   * 时的「点外部关闭」提前关掉，这次滑动同样视为已消费，不再下落到 `onBack`。
   */
  deferToOverlays?: boolean;
}

/** 手指按下超过这个时长还没划够距离，就当成长按/选词，不再算返回手势。 */
const MAX_GESTURE_MS = 1200;

/** 从这些东西上起手时不接管手势：滑杆要横向拖，浮层有自己的关闭方式。 */
const IGNORED_ORIGINS =
  "input[type='range'], [data-no-edge-swipe], [role='dialog'], [role='menu'], [role='listbox']";

export type EdgeSwipeDecision = "track" | "cancel" | "trigger";

/**
 * 边缘返回的纯判定器。事件层只负责取坐标；阈值、反向移动、垂直漂移和长按
 * 取消都在这里统一，便于用 node:test 锁住临界值。
 */
export function evaluateEdgeSwipe(
  dx: number,
  dy: number,
  elapsedMs: number,
  threshold: number,
  maxDeviation: number
): EdgeSwipeDecision {
  if (!Number.isFinite(dx) || !Number.isFinite(dy) || !Number.isFinite(elapsedMs)) {
    return "cancel";
  }
  if (Math.abs(dy) > maxDeviation || dx < -8 || elapsedMs > MAX_GESTURE_MS) {
    return "cancel";
  }
  if (dx >= threshold && Math.abs(dx) > Math.abs(dy)) return "trigger";
  return "track";
}

/**
 * 分页触控只接受一根手指、且位移不超过阈值的轻点。双指捏合即使最终合成
 * 一个 click，也会因 maxTouchCount > 1 被拒绝；纵向滚动后的 click 同理。
 */
export function isUnambiguousPageTap(
  maxTouchCount: number,
  deltaX: number,
  deltaY: number,
  maxTravel = 12
): boolean {
  return (
    maxTouchCount === 1 &&
    Number.isFinite(deltaX) &&
    Number.isFinite(deltaY) &&
    Math.hypot(deltaX, deltaY) <= maxTravel
  );
}

export function isWithinVisualViewportEdge(
  clientX: number,
  viewportOffsetLeft: number,
  edgeWidth: number
): boolean {
  if (
    !Number.isFinite(clientX) ||
    !Number.isFinite(viewportOffsetLeft) ||
    !Number.isFinite(edgeWidth)
  ) {
    return false;
  }
  const distance = clientX - viewportOffsetLeft;
  return distance >= 0 && distance <= Math.max(0, edgeWidth);
}

export interface TouchClickOutcome {
  at: number;
  accepted: boolean;
  clientX: number;
  clientY: number;
}

/**
 * 拒绝过的触摸只吞掉同一落点附近的合成 click；800ms 内来自鼠标的远处点击
 * 必须放行，否则一次捏合会让用户紧接着点的按钮/翻页区看似失灵。
 */
export function shouldSuppressRejectedTouchClick(
  outcome: TouchClickOutcome | null,
  clientX: number,
  clientY: number,
  now: number,
  maxAge = 800,
  maxDistance = 32
): boolean {
  if (!outcome || outcome.accepted) return false;
  const age = now - outcome.at;
  if (
    !Number.isFinite(age) ||
    age < 0 ||
    age >= maxAge ||
    !Number.isFinite(clientX) ||
    !Number.isFinite(clientY)
  ) {
    return false;
  }
  return (
    Math.hypot(clientX - outcome.clientX, clientY - outcome.clientY) <=
    Math.max(0, maxDistance)
  );
}

/**
 * iOS-style edge swipe back for any scrollable container. Pass a ref to the
 * element you want to monitor (usually the reader root). The gesture only
 * triggers when the initial touch point is within `edgeWidth` pixels of the
 * left edge and lands inside that element, which keeps normal in-content
 * horizontal scrolling / text selection unaffected.
 *
 * 监听挂在 document 上而不是元素上：目标元素常常要等异步内容加载完才挂载
 * （阅读器 loading 期间整棵子树都还是骨架屏），如果在 effect 里读一次
 * `ref.current` 就绑定，`enabled` 之后不再变化的话手势会永久失效。改成每次
 * 触摸时现查 ref，并用 `contains` 做归属判断。
 */
export function useEdgeSwipeBack(
  targetRef: RefObject<HTMLElement | null>,
  {
    edgeWidth = 24,
    threshold = 60,
    maxDeviation = 40,
    enabled,
    active = true,
    onBack,
    deferToOverlays = true,
  }: Options
) {
  const stateRef = useRef<{
    startX: number;
    startY: number;
    startedAt: number;
    tracking: boolean;
    /** 手指按下那一刻（pointerdown 捕获期）栈里的 overlay 处理器数量。 */
    overlayBaseline: number;
  } | null>(null);

  /**
   * pointerdown 捕获阶段采到的 overlay 处理器数量。浮层的「点外部关闭」挂
   * 在 window 冒泡的 pointerdown 上，React 18 会把那次 setState 连同 effect
   * 注销在 touchstart 派发之前同步 flush 完——touchstart 里再采样已经晚了，
   * 基线会把「刚被这根手指关掉的浮层」漏掉。document 捕获必然先于 window
   * 冒泡，这里采到的才是按下瞬间的真实栈。
   */
  const pressSampleRef = useRef<{ count: number; at: number } | null>(null);

  // 通过 ref 读回调：父组件每次渲染都会传进来一个新的 `onBack`，直接进
  // 依赖数组会导致每帧解绑/重绑四个 touch 监听。
  const onBackRef = useRef(onBack);
  onBackRef.current = onBack;

  /*
   * 采样器与手势监听分开挂载，且不受 `enabled` 门控。调用方的 `enabled`
   * 往往包含「⋯菜单没开」这类条件，而那个菜单恰好死在这根手指的
   * pointerdown 上：按下 → 菜单关闭 → 同一次 discrete flush 里 `enabled`
   * 翻真、手势监听在 touchstart 之前才挂上。若采样器也一起被门控，
   * touchstart 只能退回现场采样，拿到的是菜单已出栈之后的数量——基线
   * 与现值相等，下面的数量对比防线失明，一划连菜单带整个视图关掉两层。
   * 采样器常驻后，按下那一刻（捕获期先于关闭器）的真实基线总在，中途
   * 挂上的手势会看到「基线比现值多一层」，正确判定这一划已消费在关浮层上。
   * 常驻的代价只是往 ref 写一次数字，禁用期间可以忽略。
   */
  useEffect(() => {
    if (!active) {
      pressSampleRef.current = null;
      return;
    }
    const onPointerDown = (ev: PointerEvent) => {
      if (!ev.isPrimary || ev.pointerType !== "touch") return;
      if (
        !isWithinVisualViewportEdge(
          ev.clientX,
          window.visualViewport?.offsetLeft ?? 0,
          edgeWidth
        )
      ) {
        return;
      }
      pressSampleRef.current = { count: getOverlayHandlerCount(), at: Date.now() };
    };

    const opts = { passive: true, capture: true } as const;
    document.addEventListener("pointerdown", onPointerDown, opts);
    return () => {
      pressSampleRef.current = null;
      document.removeEventListener("pointerdown", onPointerDown, opts);
    };
  }, [active, edgeWidth]);

  useEffect(() => {
    if (!active || !enabled) return;

    const onTouchStart = (ev: TouchEvent) => {
      // 同一次触点的 pointerdown 紧贴在 touchstart 之前，样本一次性领用；
      // 没有新鲜样本（老 WebView 无 PointerEvent）就退回 touchstart 采样，
      // 时序上救不了同帧被关掉的浮层，但不会比没有这层判定更差。
      const sample = pressSampleRef.current;
      pressSampleRef.current = null;
      const overlayBaseline =
        sample && Date.now() - sample.at < 500 ? sample.count : getOverlayHandlerCount();
      if (ev.touches.length !== 1) {
        stateRef.current = null;
        return;
      }
      const touch = ev.touches[0];
      if (
        !isWithinVisualViewportEdge(
          touch.clientX,
          window.visualViewport?.offsetLeft ?? 0,
          edgeWidth
        )
      ) {
        return;
      }
      const root = targetRef.current;
      const target = ev.target as HTMLElement | null;
      if (!root || !target || !root.contains(target)) return;
      if (target.closest(IGNORED_ORIGINS)) return;
      stateRef.current = {
        startX: touch.clientX,
        startY: touch.clientY,
        startedAt: Date.now(),
        tracking: true,
        overlayBaseline,
      };
    };

    const onTouchMove = (ev: TouchEvent) => {
      const state = stateRef.current;
      if (!state || !state.tracking) return;
      // 中途多指按下（缩放/双指滚动）一律放弃。
      if (ev.touches.length !== 1) {
        state.tracking = false;
        return;
      }
      const touch = ev.touches[0];
      const dx = touch.clientX - state.startX;
      const dy = touch.clientY - state.startY;
      const decision = evaluateEdgeSwipe(
        dx,
        dy,
        Date.now() - state.startedAt,
        threshold,
        maxDeviation
      );
      if (decision === "cancel") {
        state.tracking = false;
      } else if (decision === "trigger") {
        state.tracking = false;
        if (deferToOverlays) {
          if (requestBack({ minPriority: BACK_PRIORITY.overlay })) return;
          // 按下那一刻还有 overlay 处理器、到阈值时却变少了：几乎必然是
          // 这根手指的 pointerdown 触发了浮层的「点外部关闭」（如阅读器
          // 的 ⋯ 菜单），处理器在划够距离前就出栈了。这一划的语义已经
          // 消费在关浮层上，再调 onBack 会一划错两层——菜单和整个视图
          // 一起没了，与硬件返回键（只关菜单）不一致。用数量对比而不是
          // 「有没有」：被 KeepAlive 藏住的陈旧处理器（inert 时拒绝消费
          // 返回）会常驻栈里，按「有没有」判会把滑动返回永远吞掉。
          if (getOverlayHandlerCount() < state.overlayBaseline) return;
        }
        onBackRef.current();
      }
    };

    const onTouchEnd = () => {
      stateRef.current = null;
    };

    const opts = { passive: true, capture: true } as const;
    document.addEventListener("touchstart", onTouchStart, opts);
    document.addEventListener("touchmove", onTouchMove, opts);
    document.addEventListener("touchend", onTouchEnd, opts);
    document.addEventListener("touchcancel", onTouchEnd, opts);

    return () => {
      /* 只清手势状态，不清 pressSampleRef：样本属于常驻采样器的生命周期。
         本 effect 在手势中途因 `enabled` 翻转重挂时（见上），touchstart
         还等着领用按下时的那份基线。 */
      stateRef.current = null;
      document.removeEventListener("touchstart", onTouchStart, opts);
      document.removeEventListener("touchmove", onTouchMove, opts);
      document.removeEventListener("touchend", onTouchEnd, opts);
      document.removeEventListener("touchcancel", onTouchEnd, opts);
    };
  }, [active, enabled, edgeWidth, threshold, maxDeviation, targetRef, deferToOverlays]);
}
