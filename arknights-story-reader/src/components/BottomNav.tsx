import { type KeyboardEvent, useCallback, useRef } from "react";
import { Book, Home, Search, Settings, Users2 } from "lucide-react";
import { cn } from "@/lib/utils";

type Tab = "home" | "stories" | "characters" | "search" | "settings";

interface BottomNavProps {
  activeTab: Tab;
  onTabChange: (tab: Tab) => void;
}

const NAV_ITEMS: Array<{ id: Tab; label: string; Icon: typeof Book }> = [
  { id: "home", label: "首页", Icon: Home },
  { id: "stories", label: "剧情", Icon: Book },
  { id: "characters", label: "人物", Icon: Users2 },
  { id: "search", label: "搜索", Icon: Search },
  { id: "settings", label: "设置", Icon: Settings },
];

/** 各 tab 面板通过 `aria-labelledby` 指回来的按钮 id。 */
export function tabButtonId(tab: Tab) {
  return `tab-button-${tab}`;
}

/** tab 按钮通过 `aria-controls` 指向的面板 id。 */
export function tabPanelId(tab: Tab) {
  return `tab-panel-${tab}`;
}

export function BottomNav({ activeTab, onTabChange }: BottomNavProps) {
  const buttonsRef = useRef<Array<HTMLButtonElement | null>>([]);

  // tablist 的键盘规范：方向键在 tab 之间移动焦点并切换，Home/End 跳首尾。
  // 配合 roving tabindex（只有当前 tab 参与 Tab 键序列）。
  const moveTo = useCallback(
    (index: number) => {
      const count = NAV_ITEMS.length;
      const target = (index + count) % count;
      buttonsRef.current[target]?.focus();
      onTabChange(NAV_ITEMS[target].id);
    },
    [onTabChange]
  );

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
      switch (event.key) {
        case "ArrowRight":
        case "ArrowDown":
          event.preventDefault();
          moveTo(index + 1);
          break;
        case "ArrowLeft":
        case "ArrowUp":
          event.preventDefault();
          moveTo(index - 1);
          break;
        case "Home":
          event.preventDefault();
          moveTo(0);
          break;
        case "End":
          event.preventDefault();
          moveTo(NAV_ITEMS.length - 1);
          break;
        default:
          break;
      }
    },
    [moveTo]
  );

  return (
    <nav
      aria-label="主导航"
      className="bottom-nav-glass motion-safe:animate-in motion-safe:slide-in-from-bottom-8 motion-safe:duration-500"
    >
      <div
        role="tablist"
        aria-orientation="horizontal"
        aria-label="页面切换"
        className="flex items-stretch justify-between px-1 py-1"
      >
        {NAV_ITEMS.map(({ id, label, Icon }, index) => {
          const active = activeTab === id;
          return (
            <button
              key={id}
              id={tabButtonId(id)}
              ref={(node) => {
                buttonsRef.current[index] = node;
              }}
              type="button"
              role="tab"
              aria-selected={active}
              aria-controls={tabPanelId(id)}
              tabIndex={active ? 0 : -1}
              onClick={() => onTabChange(id)}
              onKeyDown={(event) => handleKeyDown(event, index)}
              className={cn(
                "bottom-nav-pill relative flex flex-col items-center justify-center gap-0.5 flex-1 min-h-[52px] rounded-3xl px-2 pt-1.5 pb-2.5 select-none",
                active
                  ? "font-semibold text-[hsl(var(--color-primary))]"
                  : "text-[hsl(var(--color-muted-foreground))] hover:text-[hsl(var(--color-foreground))]"
              )}
            >
              <Icon className="h-5 w-5" strokeWidth={active ? 2.4 : 2} />
              <span className="text-[11px] leading-tight">{label}</span>
              <span
                aria-hidden="true"
                className={cn(
                  "absolute bottom-1 h-0.5 w-5 rounded-full transition-opacity duration-200",
                  active
                    ? "bg-[hsl(var(--color-primary))] opacity-100"
                    : "opacity-0"
                )}
              />
            </button>
          );
        })}
      </div>
    </nav>
  );
}
