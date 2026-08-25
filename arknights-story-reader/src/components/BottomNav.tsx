import { type KeyboardEvent, useCallback, useEffect, useRef } from "react";
import { Book, Home, Search, Settings, Users2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { calculateBottomNavInset } from "@/lib/appShellLogic";

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

/* 打开阅读器时导航会被卸载，关闭时重新挂载。入场动画只在本次会话第一次
   挂载时播：否则每次退出阅读器，底栏都要再从屏幕外滑上来一遍，看着像页面
   在抖。用模块级变量而不是 state——它要跨组件实例存活。 */
let hasPlayedEntrance = false;

/** 其它浮层（toast 等）避让底栏用的 CSS 变量名，定义见 index.css。 */
const INSET_VAR = "--bottom-nav-inset";

export function BottomNav({ activeTab, onTabChange }: BottomNavProps) {
  const buttonsRef = useRef<Array<HTMLButtonElement | null>>([]);
  const navRef = useRef<HTMLElement | null>(null);
  const playEntranceRef = useRef(!hasPlayedEntrance);

  /* 把「屏幕底边到导航上沿」的实测距离发布成 CSS 变量。高度受字号/换行影响
     算不准，所以只能量；量到之后交给 CSS，浮层就不用各自去 querySelector。
     卸载时删掉变量而不是写 0：读的一方 `var(--bottom-nav-inset, …)` 才能
     落到「没有底栏」的兜底值上。 */
  useEffect(() => {
    hasPlayedEntrance = true;
    const nav = navRef.current;
    if (!nav) return;
    const root = document.documentElement;
    let frame = 0;

    const sync = () => {
      // 用 offsetHeight + 计算后的 bottom，而不是 getBoundingClientRect：
      // 入场动画期间导航还带着 translateY，量矩形会得到一个偏小的值，而动画
      // 结束不触发任何观察器，那个错值就会一直留着。这两个量都只看布局，
      // 不受 transform 影响；`bottom` 还顺带把 max()/env() 解析成了 px。
      const bottom = Number.parseFloat(window.getComputedStyle(nav).bottom);
      const inset = calculateBottomNavInset(nav.offsetHeight, bottom);
      root.style.setProperty(INSET_VAR, `${inset}px`);
    };
    const scheduleSync = () => {
      if (frame) window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => {
        frame = 0;
        sync();
      });
    };

    sync();

    // 导航自身高度变化（字号、换行）用 ResizeObserver；视口高度变化时导航
    // 尺寸没变、但它离底边的距离变了，得靠 resize/旋转事件兜住。
    // visualViewport 的 resize/scroll 在部分 Android 上会跟着旋转一起到；
    // 软键盘本身不改 offsetHeight / computed bottom，inset 不会被键盘抬起
    // ——toast 的避让走 `--keyboard-inset`，不依赖这里。
    const observer =
      typeof ResizeObserver === "undefined" ? null : new ResizeObserver(scheduleSync);
    observer?.observe(nav);
    window.addEventListener("resize", scheduleSync);
    window.addEventListener("orientationchange", scheduleSync);
    window.visualViewport?.addEventListener("resize", scheduleSync);
    window.visualViewport?.addEventListener("scroll", scheduleSync);

    return () => {
      observer?.disconnect();
      if (frame) window.cancelAnimationFrame(frame);
      window.removeEventListener("resize", scheduleSync);
      window.removeEventListener("orientationchange", scheduleSync);
      window.visualViewport?.removeEventListener("resize", scheduleSync);
      window.visualViewport?.removeEventListener("scroll", scheduleSync);
      root.style.removeProperty(INSET_VAR);
    };
  }, []);

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
      ref={navRef}
      aria-label="主导航"
      className={cn(
        "bottom-nav-glass",
        playEntranceRef.current &&
          "motion-safe:animate-in motion-safe:slide-in-from-bottom-8 motion-safe:duration-500"
      )}
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
              /* aria-selected 说的是「这个 tab 被选中」，aria-current="page"
                 说的是「你现在就在这一页」。屏幕阅读器的地标/导航速览里读的是
                 后者，缺了它用户在导航里跳来跳去时不知道自己站在哪。 */
              aria-current={active ? "page" : undefined}
              aria-controls={tabPanelId(id)}
              tabIndex={active ? 0 : -1}
              onClick={() => onTabChange(id)}
              onKeyDown={(event) => handleKeyDown(event, index)}
              className={cn(
                "bottom-nav-pill relative flex flex-col items-center justify-center gap-0.5 flex-1 min-h-[52px] min-w-[44px] rounded-3xl px-2 pt-1.5 pb-2.5 select-none",
                active
                  ? "font-semibold text-[hsl(var(--color-primary))]"
                  : "text-[hsl(var(--color-muted-foreground))] hover:text-[hsl(var(--color-foreground))]"
              )}
            >
              <Icon className="h-5 w-5" strokeWidth={active ? 2.4 : 2} />
              <span className="text-[0.6875rem] leading-tight">{label}</span>
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
