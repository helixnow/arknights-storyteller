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

  useEffect(() => {
    if (!enabled) return;

    const onPointerDown = (ev: PointerEvent) => {
      if (!ev.isPrimary || ev.pointerType !== "touch") return;
      if (ev.clientX > edgeWidth) return;
      pressSampleRef.current = { count: getOverlayHandlerCount(), at: Date.now() };
    };

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
      if (touch.clientX > edgeWidth) return;
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
      if (Math.abs(dy) > maxDeviation || dx < -8) {
        state.tracking = false;
      } else if (Date.now() - state.startedAt > MAX_GESTURE_MS) {
        state.tracking = false;
      } else if (dx >= threshold && Math.abs(dx) > Math.abs(dy)) {
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
    document.addEventListener("pointerdown", onPointerDown, opts);
    document.addEventListener("touchstart", onTouchStart, opts);
    document.addEventListener("touchmove", onTouchMove, opts);
    document.addEventListener("touchend", onTouchEnd, opts);
    document.addEventListener("touchcancel", onTouchEnd, opts);

    return () => {
      stateRef.current = null;
      pressSampleRef.current = null;
      document.removeEventListener("pointerdown", onPointerDown, opts);
      document.removeEventListener("touchstart", onTouchStart, opts);
      document.removeEventListener("touchmove", onTouchMove, opts);
      document.removeEventListener("touchend", onTouchEnd, opts);
      document.removeEventListener("touchcancel", onTouchEnd, opts);
    };
  }, [enabled, edgeWidth, threshold, maxDeviation, targetRef, deferToOverlays]);
}
