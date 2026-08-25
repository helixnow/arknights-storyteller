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
      /* 拖动中按住滑块不动时滚动事件早已停发，若照常倒计时，
         轨道会在用户手里淡出（拖动虽仍有效但滑块看不见了）。
         拖动期间一律不排隐藏，pointerup 里松手后再排。 */
      if (draggingRef.current) return;
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

        /* 滑块的行程坐标系是轨道而不是 viewport：轨道被 CSS 上下各内缩
           clamp(0.75rem, 2vw, 1rem)，调用方还会叠加 trackOffset*（阅读器里
           上下合计约 170px）。若按 clientHeight 推位置，滚到底时滑块会冲出
           轨道下端、压进 trackOffsetBottom 特意避开的底栏；而拖动/轨道点击
           用的是 trackRect.height，两套坐标一长一短，拖动中每帧 rAF 重算还
           会把滑块从指针握点下方拽走。 */
        const trackHeight = trackRef.current?.clientHeight ?? clientHeight;
        const ratio = clientHeight / scrollHeight;
        const height = Math.min(Math.max(trackHeight * ratio, 36), trackHeight);
        const maxOffset = Math.max(trackHeight - height, 0);
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

      const handleResize = () => {
        if (frame) cancelAnimationFrame(frame);
        frame = requestAnimationFrame(updateThumbMetrics);
      };
      const resizeObserver =
        typeof ResizeObserver === "undefined" ? null : new ResizeObserver(handleResize);

      resizeObserver?.observe(viewport);
      // 轨道高度不只跟着 viewport 变：trackOffset* 是 CSS 变量，阅读模式
      // 切换（分页↔滚动）只改它不改容器尺寸，得单独观察轨道本身。
      if (trackRef.current) resizeObserver?.observe(trackRef.current);
      // viewport 的边框盒不会随 scrollHeight 改变。观察直接内容根节点，图片
      // 加载、折叠区展开或异步结果落地时，滑块比例也能跟着更新；只观察这一
      // 层，避免给数百个列表项各挂一个 ResizeObserver 目标。
      Array.from(viewport.children).forEach((child) => resizeObserver?.observe(child));
      // 旧 WebView 没有 ResizeObserver 时至少跟随视口/键盘尺寸变化。
      if (!resizeObserver) window.addEventListener("resize", handleResize);

      // 只监听 viewport 直接子节点的增删（整篇剧情/列表切换等）。
      // 早期版本用 `subtree: true`，每张图加载完都会触发一次子树变动，
      // 在人物统计这种 400+ 卡片的面板里会把主线程打爆。
      const mutationObserver = new MutationObserver((records) => {
        if (resizeObserver) {
          for (const record of records) {
            record.removedNodes.forEach((node) => {
              if (node instanceof Element && !viewport.contains(node)) {
                resizeObserver.unobserve(node);
              }
            });
          }
          // observe() 可重复调用；以最终 DOM 为准，兼容同一批变更中的移动。
          Array.from(viewport.children).forEach((child) => resizeObserver.observe(child));
        }
        if (frame) cancelAnimationFrame(frame);
        frame = requestAnimationFrame(updateThumbMetrics);
      });

      mutationObserver.observe(viewport, { childList: true, subtree: false });

      return () => {
        viewport.removeEventListener("scroll", handleScroll);
        resizeObserver?.disconnect();
        if (!resizeObserver) window.removeEventListener("resize", handleResize);
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

    const isScrollable = thumbMetrics.height > 0;

    const shouldShowTrack = useMemo(
      () => trackActive && isScrollable,
      [trackActive, isScrollable]
    );

    const formatOffset = useCallback((value: number | string) => {
      return typeof value === "number" ? `${value}px` : value;
    }, []);

    /* 偏移变量必须内联在轨道元素自身上，而不是根容器上：index.css 的
       `.scroll-area__track` 规则给这三个变量声明了 0px 默认值，CSS 级联里
       「元素自身的声明」永远盖过「从祖先继承的值」——写在根上时轨道读到的
       永远是 0px，调用方为避开工具栏/底栏传的 trackOffset* 全部失效：轨道
       全高铺满，滑块行程冲进底栏后面，桌面端可点击的轨道还会盖住右缘的
       工具栏按钮。同一元素上内联样式优先级高于类选择器，稳赢。 */
    const trackStyle = useMemo<CSSProperties>(() => {
      return {
        "--scroll-area-track-offset-top": formatOffset(trackOffsetTop),
        "--scroll-area-track-offset-bottom": formatOffset(trackOffsetBottom),
        "--scroll-area-track-offset-right": formatOffset(trackOffsetRight),
        /* 轨道点击会建立和滑块一样的拖动（draggingRef + 指针捕获），所以
           也要同一份 touch-action: none：鼠标为主的触屏设备（pointer: fine，
           轨道保持可点）上手指按轨道拖动时，浏览器会把触摸判定成平移接管
           并派发 pointercancel，拖动刚建立就被掐断——捕获拦不住这个接管，
           只有 touch-action 能。纯触屏设备不受影响：那里轨道本来就是
           pointer-events: none（见 index.css 的 pointer: coarse 分支），
           命中不到它，这条声明不会吃掉正常的页面平移。 */
        touchAction: "none",
      } as CSSProperties;
    }, [formatOffset, trackOffsetBottom, trackOffsetRight, trackOffsetTop]);

    const handleThumbPointerDown = useCallback(
      (event: ReactPointerEvent<HTMLDivElement>) => {
        /* 只认主键：右键按下会弹上下文菜单，此后 pointerup 通常不再送达，
           拖动状态卡死，关掉菜单后滑块会粘着指针乱滚。 */
        if (event.button !== 0) return;
        /* 拖动中第二根指针（混合设备上鼠标拖着、手指又碰到滑块）不许抢占：
           轨道路径已有同款守卫，但事件先派发到滑块，不在这里挡的话
           draggingRef 会被改成新 pointerId，原指针的 pointerup 从此对不上号，
           正在进行的拖动被直接劫走。 */
        if (draggingRef.current) return;

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

        /* 捕获失败不影响功能：拖动本来就是靠 window 上的 pointermove /
           pointerup 跟的，捕获只是让指针移出滑块后事件仍打在滑块上。
           指针在同一帧里被取消（触摸被滚动手势接管、鼠标被拔掉）时抛
           NotFoundError 是常态，为此往控制台刷一行警告纯属噪音。 */
        try {
          thumb.setPointerCapture?.(event.pointerId);
        } catch {
          /* 忽略：走 window 监听的兜底路径。 */
        }
      },
      [clearHideTimer, showTrack]
    );

    const handleTrackPointerDown = useCallback(
      (event: ReactPointerEvent<HTMLDivElement>) => {
        if (event.button !== 0) return;
        /* 事件从滑块冒泡上来时 handleThumbPointerDown 已经接管
           （draggingRef 已置位）；顺带也挡掉拖动中第二根指针的抢占。 */
        if (draggingRef.current) return;

        const viewport = viewportInnerRef.current;
        const track = trackRef.current;
        const thumb = thumbRef.current;
        if (!viewport || !track) return;

        /* 可见的空轨道原本吃掉点击却毫无反应：既挡住了下层内容，
           mousedown 的默认行为还会把焦点从正文/输入框上抢走。
           对齐原生滚动条：preventDefault 保焦点，滚动跳到点击处，
           并以滑块中心为握点进入拖动，一次按住即可继续拖。 */
        event.preventDefault();
        clearHideTimer();
        showTrack();

        const trackRect = track.getBoundingClientRect();
        const thumbHeight = thumb?.offsetHeight ?? metricsRef.current.height;
        const maxOffset = Math.max(trackRect.height - thumbHeight, 0);
        let nextTop = event.clientY - trackRect.top - thumbHeight / 2;
        nextTop = Math.max(0, Math.min(nextTop, maxOffset));

        const scrollRange = viewport.scrollHeight - viewport.clientHeight;
        viewport.scrollTop = maxOffset <= 0 ? 0 : (nextTop / maxOffset) * scrollRange;

        metricsRef.current = { height: thumbHeight, top: nextTop };
        setThumbMetrics({ height: thumbHeight, top: nextTop });

        draggingRef.current = { pointerId: event.pointerId, offsetY: thumbHeight / 2 };
        try {
          thumb?.setPointerCapture?.(event.pointerId);
        } catch {
          /* 同滑块按下：走 window 监听的兜底路径。 */
        }
      },
      [clearHideTimer, showTrack]
    );

    useEffect(() => {
      const handlePointerMove = (event: PointerEvent) => {
        const drag = draggingRef.current;
        /* 多指/多设备并存时只跟随发起拖动的那个指针，否则第二根
           手指的移动会把滚动位置直接带飞。 */
        if (!drag || event.pointerId !== drag.pointerId) return;

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
        /* 同上：别的指针抬起不应提前终止本次拖动。 */
        if (!drag || event.pointerId !== drag.pointerId) return;

        draggingRef.current = null;
        // 先问 hasPointerCapture 再释放：没捕获时直接调 release 会抛，
        // 而「没捕获」在 pointercancel 路径上是正常情况。
        const thumb = thumbRef.current;
        if (thumb?.hasPointerCapture?.(event.pointerId)) {
          try {
            thumb.releasePointerCapture(event.pointerId);
          } catch {
            // pointercancel 与节点卸载可能发生在 has/release 两次调用之间；
            // 拖动状态已经清空，释放失败不应把全局 pointerup 处理器炸断。
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
        style={style}
        {...rest}
      >
        <div
          ref={assignViewportRef}
          className={cn("scroll-area__viewport", viewportClassName)}
          /* 内容真的溢出时才给一个 tab 停靠点：Safari 不会像 Chrome/Firefox
             那样自动让溢出容器可聚焦，没有它键盘用户就滚不动这块区域。 */
          tabIndex={isScrollable ? 0 : undefined}
        >
          {children}
        </div>
        {/* 轨道只是原生滚动的视觉替身，对辅助技术隐藏，避免多播一个无名控件。 */}
        <div
          ref={trackRef}
          className="scroll-area__track"
          data-visible={shouldShowTrack}
          aria-hidden="true"
          style={trackStyle}
          onPointerDown={handleTrackPointerDown}
        >
          <div
            className="scroll-area__thumb"
            ref={thumbRef}
            onPointerDown={handleThumbPointerDown}
            style={{
              height: `${thumbMetrics.height}px`,
              transform: `translateY(${thumbMetrics.top}px)`,
              touchAction: "none",
            }}
          />
        </div>
      </div>
    );
  }
);
