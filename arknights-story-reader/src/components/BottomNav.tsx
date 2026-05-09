import { Book, Search, Settings, Users2, ListChecks } from "lucide-react";
import { cn } from "@/lib/utils";

type Tab = "stories" | "characters" | "search" | "clues" | "settings";

interface BottomNavProps {
  activeTab: Tab;
  onTabChange: (tab: Tab) => void;
}

const NAV_ITEMS: Array<{ id: Tab; label: string; Icon: typeof Book }> = [
  { id: "stories", label: "剧情", Icon: Book },
  { id: "clues", label: "线索集", Icon: ListChecks },
  { id: "characters", label: "人物", Icon: Users2 },
  { id: "search", label: "搜索", Icon: Search },
  { id: "settings", label: "设置", Icon: Settings },
];

export function BottomNav({ activeTab, onTabChange }: BottomNavProps) {
  return (
    <nav
      role="navigation"
      aria-label="主导航"
      className="fixed bottom-0 left-0 right-0 bg-[hsl(var(--color-background)/0.95)] backdrop-blur border-t motion-safe:animate-in motion-safe:slide-in-from-bottom-10 motion-safe:duration-500"
      style={{ paddingBottom: "env(safe-area-inset-bottom, 0px)" }}
    >
      <div
        role="tablist"
        aria-orientation="horizontal"
        className="container flex items-stretch justify-around"
      >
        {NAV_ITEMS.map(({ id, label, Icon }) => {
          const active = activeTab === id;
          return (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={active}
              aria-controls={`tab-panel-${id}`}
              onClick={() => onTabChange(id)}
              className={cn(
                "flex flex-col items-center justify-center gap-1 flex-1 min-h-[56px] py-2 transition-colors select-none",
                active
                  ? "text-[hsl(var(--color-primary))]"
                  : "text-[hsl(var(--color-muted-foreground))]"
              )}
            >
              <Icon className="h-5 w-5" strokeWidth={active ? 2.4 : 2} />
              <span className="text-xs">{label}</span>
            </button>
          );
        })}
      </div>
    </nav>
  );
}
