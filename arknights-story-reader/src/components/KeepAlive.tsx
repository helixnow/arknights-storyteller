import { useEffect, useLayoutEffect, useRef, type ReactNode } from "react";
import { cn } from "@/lib/utils";
import { keepAliveContentVisibility } from "@/lib/appShellLogic";

interface KeepAliveProps {
  active: boolean;
  children: ReactNode;
  className?: string;
}

/**
 * 常驻挂载、只切可见性的面板容器。
 *
 * 用 `visibility` 而不是 `display: none` / 卸载：面板保持布局盒，滚动位置、
 * 图片解码结果、列表状态都不会丢，切回来是瞬时的。代价是隐藏的子树仍在
 * 无障碍树和命中测试里，所以这里逐条堵上：
 *
 *  - `visibility: hidden`  不绘制，但保留布局盒（这就是我们要的）；
 *  - `pointer-events: none` 命中测试兜底，防止子元素显式写了
 *    `visibility: visible` 之后又变得可点；
 *  - `inert`               子树整体退出焦点序列与无障碍树，Tab 键不会
 *    「掉进」看不见的面板里；
 *  - `aria-hidden`         给尚未实现 inert 的旧 WebView 兜底无障碍树；
 *    但 aria-hidden 不拦焦点，所以下面还有一个 focusin 监听器兜底焦点；
 *  - `data-keepalive-active` 供 index.css 暂停隐藏面板里的循环动画。
 *
 * 刻意不给 z-index：面板是内容，不该把自己抬到应用外壳之上。以前这里写
 * `zIndex: active ? 1 : 0`，绝对定位 + z-index 让每个面板都成了一个层叠上下文，
 * 后果有两个——面板整体盖住了 z-index:auto 的底部导航（导航因此完全点不动），
 * 面板内部 `fixed inset-0 z-50` 的弹窗又被封在面板这一层里出不来。去掉之后
 * 层叠顺序回到「面板 < 导航(z-40) < 弹窗(z-50) < toast(z-100)」。
 *
 * 后台面板必须 `content-visibility: hidden`。五个 tab 加上未卸载的阅读器
 * 都是 `absolute inset-0`，子树里的 `content-visibility: auto` 仍把它们
 * 当成在视口内，只靠 visibility 会叠在一起抢布局和合成。
 *
 * 滚动位置用捕获阶段的 scroll 事件按目标记账，不扫整棵子树；切后台时
 * 不再补拍——那时 DOM 已是 hidden，读几何会把好快照盖成空的。
 */
export function KeepAlive({ active, children, className }: KeepAliveProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const scrollPositionsRef = useRef(new Map<Element, { top: number; left: number }>());

  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container || !active) return;

    for (const [el, pos] of scrollPositionsRef.current) {
      if (!el.isConnected) {
        scrollPositionsRef.current.delete(el);
        continue;
      }
      el.scrollTop = pos.top;
      el.scrollLeft = pos.left;
    }

    const onScroll = (event: Event) => {
      const el = event.target;
      if (!(el instanceof Element) || !container.contains(el)) return;
      scrollPositionsRef.current.set(el, { top: el.scrollTop, left: el.scrollLeft });
    };

    container.addEventListener("scroll", onScroll, { capture: true, passive: true });
    return () => {
      container.removeEventListener("scroll", onScroll, true);
    };
  }, [active]);

  /* 面板转入后台时，焦点可能还停在里面。inert 会让浏览器把焦点丢回
     document.body，但各引擎时机不一致（有的要等一帧，有的干脆留着一个
     「聚焦但不可交互」的元素，键盘从此点不动）。这里显式收一次焦点，
     行为就固定成「回到 body，Tab 从新面板的开头开始」。

     隐藏期间再挂一个 focusin 围堵：不认识 inert 的旧 WebView 只剩
     aria-hidden，而 aria-hidden 并不阻止聚焦——Tab（或面板后台代码里的
     focus() 调用）仍能把焦点送进看不见的面板，接着空格/方向键就在滚
     一个隐藏的滚动区。焦点一进来立刻 blur 弹回 body。在 inert 生效的
     引擎上焦点根本进不来，监听器一次都不会触发，纯属零成本保险。
     用捕获阶段，免得子组件 stopPropagation 把事件截走。 */
  useEffect(() => {
    if (active) return;
    const container = containerRef.current;
    if (!container) return;

    const releaseFocus = () => {
      const focused = document.activeElement;
      if (focused instanceof HTMLElement && container.contains(focused)) {
        focused.blur();
      }
    };

    releaseFocus();
    container.addEventListener("focusin", releaseFocus, true);
    return () => container.removeEventListener("focusin", releaseFocus, true);
  }, [active]);

  return (
    <div
      ref={containerRef}
      className={cn("h-full w-full overflow-hidden", className)}
      style={{
        visibility: active ? "visible" : "hidden",
        pointerEvents: active ? "auto" : "none",
        contentVisibility: keepAliveContentVisibility(active),
      }}
      inert={!active}
      aria-hidden={!active}
      data-keepalive-active={active}
    >
      {children}
    </div>
  );
}
