import type { ReactNode } from "react";
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
 * 无障碍树和命中测试里，所以额外用 `inert` + `aria-hidden` 把它彻底摘掉。
 */
export function KeepAlive({ active, children, className }: KeepAliveProps) {
  return (
    <div
      className={cn("h-full w-full overflow-hidden", className)}
      style={{
        visibility: active ? "visible" : "hidden",
        pointerEvents: active ? "auto" : "none",
        zIndex: active ? 1 : 0,
      }}
      inert={!active}
      aria-hidden={!active}
    >
      {children}
    </div>
  );
}
