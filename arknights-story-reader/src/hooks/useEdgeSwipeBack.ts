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
    tracking: boolean;
  } | null>(null);

  useEffect(() => {
    if (!enabled) return;
    const el = targetRef.current;
    if (!el) return;

    const onTouchStart = (ev: TouchEvent) => {
      if (ev.touches.length !== 1) return;
      const touch = ev.touches[0];
      if (touch.clientX > edgeWidth) return;
      stateRef.current = {
        startX: touch.clientX,
        startY: touch.clientY,
        tracking: true,
      };
    };

    const onTouchMove = (ev: TouchEvent) => {
      const state = stateRef.current;
      if (!state || !state.tracking) return;
      const touch = ev.touches[0];
      const dx = touch.clientX - state.startX;
      const dy = touch.clientY - state.startY;
      if (Math.abs(dy) > maxDeviation) {
        state.tracking = false;
      } else if (dx >= threshold) {
        state.tracking = false;
        onBack();
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
      el.removeEventListener("touchstart", onTouchStart);
      el.removeEventListener("touchmove", onTouchMove);
      el.removeEventListener("touchend", onTouchEnd);
      el.removeEventListener("touchcancel", onTouchEnd);
    };
  }, [enabled, edgeWidth, threshold, maxDeviation, onBack, targetRef]);
}
