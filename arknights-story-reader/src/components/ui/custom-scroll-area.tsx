import { forwardRef, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, MutableRefObject, PointerEvent as ReactPointerEvent } from "react";
import { cn } from "@/lib/utils";

interface CustomScrollAreaProps extends React.HTMLAttributes<HTMLDivElement> {
  viewportClassName?: string;
  viewportRef?: React.Ref<HTMLDivElement>;
  hideTrackWhenIdle?: boolean;
  trackOffsetTop?: number | string;
  trackOffsetBottom?: number | string;
  trackOffsetRight?: number | string;
}

export const CustomScrollArea = forwardRef<HTMLDivElement, CustomScrollAreaProps>(
  function CustomScrollArea(
    {
      className,
      children,
      viewportClassName,
      viewportRef,
      hideTrackWhenIdle = true,
      trackOffsetTop = 0,
      trackOffsetBottom = 0,
      trackOffsetRight = 0,
      style,
      ...rest
    },
    ref
  ) {
    const viewportInnerRef = useRef<HTMLDivElement | null>(null);
    const trackRef = useRef<HTMLDivElement | null>(null);
    const thumbRef = useRef<HTMLDivElement | null>(null);
    const metricsRef = useRef<{ height: number; top: number }>({ height: 0, top: 0 });
    const hideTimerRef = useRef<number | null>(null);
    const draggingRef = useRef<{ pointerId: number; offsetY: number } | null>(null);
    const [thumbMetrics, setThumbMetrics] = useState({ height: 0, top: 0 });
    const [trackActive, setTrackActive] = useState(false);

    const assignViewportRef = useCallback(
      (node: HTMLDivElement | null) => {
        viewportInnerRef.current = node;
        if (typeof viewportRef === "function") {
          viewportRef(node);
        } else if (viewportRef && typeof viewportRef === "object") {
          (viewportRef as MutableRefObject<HTMLDivElement | null>).current = node;
        }
      },
      [viewportRef]
    );

    const clearHideTimer = useCallback(() => {
      if (hideTimerRef.current !== null) {
        window.clearTimeout(hideTimerRef.current);
        hideTimerRef.current = null;
      }
    }, []);

    const scheduleHide = useCallback(() => {
      if (!hideTrackWhenIdle) return;
      clearHideTimer();
      hideTimerRef.current = window.setTimeout(() => {
        setTrackActive(false);
        hideTimerRef.current = null;
      }, 700);
    }, [hideTrackWhenIdle, clearHideTimer]);

    const showTrack = useCallback(() => {
      if (metricsRef.current.height <= 0) return;
      setTrackActive(true);
    }, []);

    useEffect(() => {
      const viewport = viewportInnerRef.current;
      if (!viewport) return;

      let frame = 0;

      const updateThumbMetrics = () => {
        const { scrollTop, scrollHeight, clientHeight } = viewport;

        if (scrollHeight <= clientHeight + 1) {
          metricsRef.current = { height: 0, top: 0 };
          setThumbMetrics({ height: 0, top: 0 });
          setTrackActive(false);
          return;
        }

        const ratio = clientHeight / scrollHeight;
        const height = Math.max(clientHeight * ratio, 36);
        const maxOffset = clientHeight - height;
        const top =
          maxOffset <= 0 ? 0 : (scrollTop / (scrollHeight - clientHeight)) * maxOffset;

        const nextMetrics = { height, top };
        metricsRef.current = nextMetrics;
        setThumbMetrics(nextMetrics);
        setTrackActive(true);
        scheduleHide();
      };

      const handleScroll = () => {
        showTrack();
        clearHideTimer();
        if (frame) cancelAnimationFrame(frame);
        frame = requestAnimationFrame(updateThumbMetrics);
      };

      updateThumbMetrics();

      viewport.addEventListener("scroll", handleScroll, { passive: true });

      const resizeObserver = new ResizeObserver(() => {
        if (frame) cancelAnimationFrame(frame);
        frame = requestAnimationFrame(updateThumbMetrics);
      });

      resizeObserver.observe(viewport);

      // 只监听 viewport 直接子节点的增删（整篇剧情/列表切换等）。
      // 早期版本用 `subtree: true`，每张图加载完都会触发一次子树变动，
      // 在人物统计这种 400+ 卡片的面板里会把主线程打爆。
      const mutationObserver = new MutationObserver(() => {
        if (frame) cancelAnimationFrame(frame);
        frame = requestAnimationFrame(updateThumbMetrics);
      });

      mutationObserver.observe(viewport, { childList: true, subtree: false });

      return () => {
        viewport.removeEventListener("scroll", handleScroll);
        resizeObserver.disconnect();
        mutationObserver.disconnect();
        if (frame) cancelAnimationFrame(frame);
        clearHideTimer();
      };
    }, [clearHideTimer, scheduleHide, showTrack]);

    const handlePointerEnter = useCallback(() => {
      if (draggingRef.current) return;
      clearHideTimer();
      showTrack();
    }, [clearHideTimer, showTrack]);

    const handlePointerLeave = useCallback(() => {
      if (draggingRef.current) return;
      scheduleHide();
    }, [scheduleHide]);

    const shouldShowTrack = useMemo(
      () => trackActive && thumbMetrics.height > 0,
      [trackActive, thumbMetrics.height]
    );

    const formatOffset = useCallback((value: number | string) => {
      return typeof value === "number" ? `${value}px` : value;
    }, []);

    const mergedStyle = useMemo<CSSProperties>(() => {
      return {
        ...(style as CSSProperties),
        ["--scroll-area-track-offset-top" as const]: formatOffset(trackOffsetTop),
        ["--scroll-area-track-offset-bottom" as const]: formatOffset(trackOffsetBottom),
        ["--scroll-area-track-offset-right" as const]: formatOffset(trackOffsetRight),
      };
    }, [formatOffset, style, trackOffsetBottom, trackOffsetRight, trackOffsetTop]);

    const handleThumbPointerDown = useCallback(
      (event: ReactPointerEvent<HTMLDivElement>) => {
        const viewport = viewportInnerRef.current;
        const track = trackRef.current;
        const thumb = thumbRef.current;
        if (!viewport || !track || !thumb) return;

        event.preventDefault();
        clearHideTimer();
        showTrack();

        const thumbRect = thumb.getBoundingClientRect();
        draggingRef.current = {
          pointerId: event.pointerId,
          offsetY: event.clientY - thumbRect.top,
        };

        if (thumb.setPointerCapture) {
          try {
            thumb.setPointerCapture(event.pointerId);
          } catch (error) {
            console.warn("[ScrollArea] setPointerCapture failed", error);
          }
        }
      },
      [clearHideTimer, showTrack]
    );

    useEffect(() => {
      const handlePointerMove = (event: PointerEvent) => {
        const drag = draggingRef.current;
        if (!drag) return;

        const viewport = viewportInnerRef.current;
        const track = trackRef.current;
        const thumb = thumbRef.current;
        if (!viewport || !track) return;

        const trackRect = track.getBoundingClientRect();
        const thumbHeight = thumb?.offsetHeight ?? metricsRef.current.height;
        const maxOffset = Math.max(trackRect.height - thumbHeight, 0);
        let nextTop = event.clientY - trackRect.top - drag.offsetY;
        nextTop = Math.max(0, Math.min(nextTop, maxOffset));

        const scrollRange = viewport.scrollHeight - viewport.clientHeight;
        const nextScrollTop = maxOffset <= 0 ? 0 : (nextTop / maxOffset) * scrollRange;
        viewport.scrollTop = nextScrollTop;

        metricsRef.current = { height: thumbHeight, top: nextTop };
        setThumbMetrics((prev) => {
          if (Math.abs(prev.top - nextTop) < 0.5 && Math.abs(prev.height - thumbHeight) < 0.5) {
            return prev;
          }
          return { height: thumbHeight, top: nextTop };
        });
      };

      const handlePointerUp = (event: PointerEvent) => {
        const drag = draggingRef.current;
        if (!drag) return;

        draggingRef.current = null;
        if (thumbRef.current?.releasePointerCapture) {
          try {
            thumbRef.current.releasePointerCapture(event.pointerId);
          } catch (error) {
            console.warn("[ScrollArea] releasePointerCapture failed", error);
          }
        }
        scheduleHide();
      };

      window.addEventListener("pointermove", handlePointerMove);
      window.addEventListener("pointerup", handlePointerUp);
      window.addEventListener("pointercancel", handlePointerUp);

      return () => {
        window.removeEventListener("pointermove", handlePointerMove);
        window.removeEventListener("pointerup", handlePointerUp);
        window.removeEventListener("pointercancel", handlePointerUp);
      };
    }, [scheduleHide]);

    return (
      <div
        ref={ref}
        className={cn("scroll-area", className)}
        onPointerEnter={handlePointerEnter}
        onPointerLeave={handlePointerLeave}
        style={mergedStyle}
        {...rest}
      >
        <div
          ref={assignViewportRef}
          className={cn("scroll-area__viewport", viewportClassName)}
        >
          {children}
        </div>
        <div ref={trackRef} className="scroll-area__track" data-visible={shouldShowTrack}>
          <div
            className="scroll-area__thumb"
            ref={thumbRef}
            onPointerDown={handleThumbPointerDown}
            style={{
              height: `${thumbMetrics.height}px`,
              transform: `translateY(${thumbMetrics.top}px)`,
            }}
          />
        </div>
      </div>
    );
  }
);
