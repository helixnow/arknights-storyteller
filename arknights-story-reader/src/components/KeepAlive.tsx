import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

interface KeepAliveProps {
  active: boolean;
  children: ReactNode;
  className?: string;
}

export function KeepAlive({ active, children, className }: KeepAliveProps) {
  return (
    <div
      className={cn("h-full w-full overflow-hidden", className)}
      style={{
        visibility: active ? "visible" : "hidden",
        pointerEvents: active ? "auto" : "none",
        zIndex: active ? 1 : 0,
      }}
      aria-hidden={!active}
    >
      {children}
    </div>
  );
}

