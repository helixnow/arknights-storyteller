import { useEffect, useRef, type RefObject } from "react";

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
}

/** 手指按下超过这个时长还没划够距离，就当成长按/选词，不再算返回手势。 */
const MAX_GESTURE_MS = 1200;

/**
 * iOS-style edge swipe back for any scrollable container. Attach the returned
 * ref to the element you want to monitor (usually the reader root). The
 * gesture only triggers when the initial touch point is within `edgeWidth`
 * pixels of the left edge, which keeps normal in-content horizontal scrolling
 * / text selection unaffected.
 */
export function useEdgeSwipeBack(
  targetRef: RefObject<HTMLElement | null>,
  { edgeWidth = 24, threshold = 60, maxDeviation = 40, enabled, onBack }: Options
) {
  const stateRef = useRef<{
    startX: number;
    startY: number;
    startedAt: number;
    tracking: boolean;
  } | null>(null);

  // 通过 ref 读回调：父组件每次渲染都会传进来一个新的 `onBack`，直接进
  // 依赖数组会导致每帧解绑/重绑四个 touch 监听。
  const onBackRef = useRef(onBack);
  onBackRef.current = onBack;

  useEffect(() => {
    if (!enabled) return;
    const el = targetRef.current;
    if (!el) return;

    const onTouchStart = (ev: TouchEvent) => {
      if (ev.touches.length !== 1) {
        stateRef.current = null;
        return;
      }
      const touch = ev.touches[0];
      if (touch.clientX > edgeWidth) return;
      // 从可横向滚动的元素（图片长条、代码块）起手时不接管手势。
      const target = ev.target as HTMLElement | null;
      if (target?.closest("input[type='range'], [data-no-edge-swipe]")) return;
      stateRef.current = {
        startX: touch.clientX,
        startY: touch.clientY,
        startedAt: Date.now(),
        tracking: true,
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
        onBackRef.current();
      }
    };

    const onTouchEnd = () => {
      stateRef.current = null;
    };

    el.addEventListener("touchstart", onTouchStart, { passive: true });
    el.addEventListener("touchmove", onTouchMove, { passive: true });
    el.addEventListener("touchend", onTouchEnd, { passive: true });
    el.addEventListener("touchcancel", onTouchEnd, { passive: true });

    return () => {
      stateRef.current = null;
      el.removeEventListener("touchstart", onTouchStart);
      el.removeEventListener("touchmove", onTouchMove);
      el.removeEventListener("touchend", onTouchEnd);
      el.removeEventListener("touchcancel", onTouchEnd);
    };
  }, [enabled, edgeWidth, threshold, maxDeviation, targetRef]);
}
