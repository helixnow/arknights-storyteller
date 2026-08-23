import { useEffect, useRef, type ReactNode } from "react";
import { cn } from "@/lib/utils";

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
 *  - `aria-hidden`         给尚未实现 inert 的旧 WebView 兜底；
 *  - `data-keepalive-active` 供 index.css 暂停隐藏面板里的循环动画。
 */
export function KeepAlive({ active, children, className }: KeepAliveProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);

  /* 面板转入后台时，焦点可能还停在里面。inert 会让浏览器把焦点丢回
     document.body，但各引擎时机不一致（有的要等一帧，有的干脆留着一个
     「聚焦但不可交互」的元素，键盘从此点不动）。这里显式收一次焦点，
     行为就固定成「回到 body，Tab 从新面板的开头开始」。 */
  useEffect(() => {
    if (active) return;
    const container = containerRef.current;
    const focused = document.activeElement;
    if (container && focused instanceof HTMLElement && container.contains(focused)) {
      focused.blur();
    }
  }, [active]);

  return (
    <div
      ref={containerRef}
      className={cn("h-full w-full overflow-hidden", className)}
      style={{
        visibility: active ? "visible" : "hidden",
        pointerEvents: active ? "auto" : "none",
        zIndex: active ? 1 : 0,
      }}
      inert={!active}
      aria-hidden={!active}
      data-keepalive-active={active}
    >
      {children}
    </div>
  );
}
