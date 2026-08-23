import * as React from "react";
import { cn } from "@/lib/utils";

/**
 * Liquid-glass sheet primitive.
 *
 * A shared shell for right-hand-side (and eventually bottom) drawers in
 * the app. Replaces the ad-hoc `fixed inset-0 flex + scrim + panel` markup
 * that each of `ReaderSettingsPanel`, `StoryInsightsPanel` and
 * `ShareImageDialog` used to carry around.
 *
 * The styling mirrors iOS 26 Liquid Glass sheets:
 *   - Panel floats with a small gap from the screen edge (inset by 8–12px)
 *   - Large `--radius-sheet` corner so it reads as a tablet of glass, not a page
 *   - `.glass-thick` material so the page content behind blurs out of focus
 *   - Soft shadow beneath for lift; inner highlight on the top edge
 *
 * The enter/exit animation and the two-phase unmount are still driven by the
 * caller via `state`, which must be spread onto the outer element's
 * `data-state` attribute — the existing `useSidePanel` hook returns that
 * value already (see `ShareImageDialog` for the usage). Everything a modal
 * owes the user regardless of how it is animated — focus trap, focus
 * restore, Escape, background scroll lock — lives here so a sheet is never
 * half-modal just because a caller wired it up by hand.
 */

export type SheetState = "open" | "closed";

interface SheetShellProps {
  state: SheetState;
  onClose: () => void;
  ariaLabel: string;
  children: React.ReactNode;
  /** Optional class merged onto the panel (e.g. `max-w-lg` overrides). */
  className?: string;
}

/** 可聚焦元素选择器，用于把 Tab 键锁在 sheet 内部。 */
const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** Esc 要放过正在输入的控件：那里 Esc 的语义是「撤销这次输入」。 */
function isTextEntry(node: EventTarget | null): boolean {
  const el = node as HTMLElement | null;
  if (!el) return false;
  return (
    el.tagName === "INPUT" ||
    el.tagName === "TEXTAREA" ||
    el.isContentEditable === true
  );
}

/**
 * sheet 挂在阅读器子树里，而阅读器退到后台时整棵子树会被 KeepAlive 置为
 * inert（抽屉状态还留着）。这种时候面板并没有真的呈现在用户面前，键盘和
 * 焦点看守必须一起失效 —— 否则用户在剧情列表里按 Tab，焦点会被拽进一个
 * inert 的面板，等于整个应用的 Tab 键失灵。
 */
function isPresented(panel: HTMLElement | null): panel is HTMLElement {
  return Boolean(panel && !panel.closest("[inert]"));
}

function focusableWithin(panel: HTMLElement): HTMLElement[] {
  return Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((el) => {
    if (el.closest("[inert]") || el.closest('[aria-hidden="true"]')) return false;
    // getClientRects() 对 position: fixed 的元素也成立，offsetParent 不行。
    return el.getClientRects().length > 0 || el === document.activeElement;
  });
}

/*
 * 背景滚动锁。计数是模块级的：同时开两个 sheet 时后关的那个才真正解锁。
 *
 * `useSidePanel` 里还有一份同样的锁（它比 sheet 早一步存在，不能直接拆），
 * 两边的清理在同一次提交里同步执行且先后顺序没有保证 —— 谁最后落笔谁说了
 * 算，先解锁再被对方按原值写回 `hidden` 就永久锁死了。所以这里把解锁推到
 * 微任务：提交跑完才轮到我们，最后写进 body 的一定是开锁前记下的原值。
 */
let scrollLockCount = 0;
let scrollLockRestore: { overflow: string; paddingRight: string } | null = null;
let scrollLockReleaseScheduled = false;

function lockBodyScroll() {
  scrollLockCount += 1;
  if (scrollLockCount > 1) return;
  const body = document.body;
  if (!scrollLockRestore) {
    scrollLockRestore = {
      overflow: body.style.overflow,
      paddingRight: body.style.paddingRight,
    };
  }
  // 桌面端补上消失的滚动条宽度，避免整页横向抖一下。
  const scrollbarWidth = window.innerWidth - document.documentElement.clientWidth;
  body.style.overflow = "hidden";
  if (scrollbarWidth > 0) body.style.paddingRight = `${scrollbarWidth}px`;
}

function unlockBodyScroll() {
  scrollLockCount = Math.max(0, scrollLockCount - 1);
  if (scrollLockCount > 0 || scrollLockReleaseScheduled) return;
  scrollLockReleaseScheduled = true;
  queueMicrotask(() => {
    scrollLockReleaseScheduled = false;
    // 微任务排队期间又开了一个 sheet（严格模式的重挂载也算），锁继续留着。
    if (scrollLockCount > 0 || !scrollLockRestore) return;
    document.body.style.overflow = scrollLockRestore.overflow;
    document.body.style.paddingRight = scrollLockRestore.paddingRight;
    scrollLockRestore = null;
  });
}

export function SheetShell({
  state,
  onClose,
  ariaLabel,
  children,
  className,
}: SheetShellProps) {
  const panelRef = React.useRef<HTMLDivElement | null>(null);
  const restoreRef = React.useRef<HTMLElement | null>(null);
  // 键盘监听里读最新的 onClose，省得每次父组件重渲染都重绑一遍。
  const onCloseRef = React.useRef(onClose);
  React.useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  /*
   * 下面三个 effect 的声明顺序有意义：清理函数按声明顺序执行，焦点归还必须
   * 排在焦点看守卸载之后 —— 否则归还焦点的那一下会被看守当成「焦点跑到面板
   * 外面了」再抓回来，触发它的按钮就永远拿不回焦点。
   */

  // 键盘：Tab 循环锁在面板内，Esc 关闭。
  React.useEffect(() => {
    if (state !== "open") return;
    const handleKeyDown = (event: KeyboardEvent) => {
      const panel = panelRef.current;
      if (!isPresented(panel)) return;

      if (event.key === "Escape") {
        if (event.defaultPrevented || isTextEntry(event.target)) return;
        event.preventDefault();
        onCloseRef.current();
        return;
      }

      if (event.key !== "Tab") return;
      const items = focusableWithin(panel);
      const active = document.activeElement;
      if (items.length === 0) {
        event.preventDefault();
        panel.focus({ preventScroll: true });
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      if (!panel.contains(active)) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
      } else if (event.shiftKey && (active === first || active === panel)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", handleKeyDown, true);
    return () => document.removeEventListener("keydown", handleKeyDown, true);
  }, [state]);

  /*
   * Tab 只是最常见的一条逃逸路径。读屏手势、软键盘的「下一项」、外部代码
   * 主动 focus 都能把焦点送出面板，这里兜底把它请回来。上面还压着另一个
   * dialog 时不抢，免得两个模态互相拉扯。
   */
  React.useEffect(() => {
    if (state !== "open") return;
    const handleFocusIn = (event: FocusEvent) => {
      const panel = panelRef.current;
      const target = event.target as HTMLElement | null;
      if (!isPresented(panel) || !target || panel.contains(target)) return;
      if (target.closest?.('[role="dialog"]')) return;
      panel.focus({ preventScroll: true });
    };
    document.addEventListener("focusin", handleFocusIn);
    return () => document.removeEventListener("focusin", handleFocusIn);
  }, [state]);

  /*
   * `aria-modal` 只是给辅助技术的声明，真正的模态行为要自己实现：
   * 打开时把焦点移进面板（面板本身可聚焦，避免直接跳到输入框弹起软键盘），
   * 关闭时还给触发它的按钮，否则键盘/读屏用户会被扔回文档开头。
   */
  React.useEffect(() => {
    if (state !== "open") return;
    restoreRef.current = document.activeElement as HTMLElement | null;
    if (isPresented(panelRef.current)) {
      panelRef.current.focus({ preventScroll: true });
    }
    return () => {
      const previous = restoreRef.current;
      if (previous && document.contains(previous)) {
        previous.focus({ preventScroll: true });
      }
    };
  }, [state]);

  // 背景滚动锁跟着挂载周期走（含退场动画），而不是跟着 `state`：动画播到
  // 一半时页面在底下滚起来同样出戏。
  React.useEffect(() => {
    lockBodyScroll();
    return unlockBodyScroll;
  }, []);

  return (
    <div className="fixed inset-0 z-50 flex">
      <div
        data-state={state}
        aria-hidden="true"
        className={cn(
          "absolute inset-0 glass-scrim transition-opacity duration-300",
          "data-[state=closed]:opacity-0 data-[state=open]:opacity-100"
        )}
        onClick={onClose}
      />
      {/*
       * Outer frame: full-height on mobile, insets on md+ so the sheet
       * reads as a floating glass slab with the page still visible at
       * the edge. `pointer-events-none` on the frame so clicks in the
       * gutter hit the scrim and dismiss.
       */}
      <div
        data-state={state}
        className={cn(
          "relative ml-auto h-full w-full max-w-md pointer-events-none",
          "transition-transform duration-300 ease-spring",
          "data-[state=closed]:translate-x-full data-[state=open]:translate-x-0",
          className
        )}
      >
        <div
          ref={panelRef}
          role="dialog"
          aria-modal="true"
          aria-label={ariaLabel}
          tabIndex={-1}
          className={cn(
            "pointer-events-auto h-full flex flex-col overflow-hidden",
            "focus:outline-none",
            "glass glass-thick"
          )}
        >
          {children}
        </div>
      </div>
    </div>
  );
}

/**
 * Header for a `SheetShell`. Transparent background so the glass material
 * of the shell shows through; hairline divider at the bottom hints at the
 * scroll region below without drawing a full border.
 *
 * The sheet is `fixed inset-0`, so on notched phones its header would slide
 * under the status bar / dynamic island. Pick up the top safe-area inset
 * here, mirroring what `SheetFooter` does for the home indicator.
 */
export function SheetHeader({
  title,
  description,
  actions,
}: {
  title: React.ReactNode;
  description?: React.ReactNode;
  actions?: React.ReactNode;
}) {
  return (
    <header
      className={cn(
        "flex-shrink-0 flex items-center justify-between gap-3",
        "px-5 pb-3",
        "border-b border-[hsl(var(--color-foreground)/0.06)]"
      )}
      style={{ paddingTop: "calc(env(safe-area-inset-top, 0px) + 1rem)" }}
    >
      <div className="min-w-0">
        <h2 className="text-[17px] font-semibold tracking-tight truncate">
          {title}
        </h2>
        {description ? (
          <p className="text-xs text-[hsl(var(--color-muted-foreground))] truncate mt-0.5">
            {description}
          </p>
        ) : null}
      </div>
      {actions ? <div className="flex items-center gap-1">{actions}</div> : null}
    </header>
  );
}

/**
 * Footer pinned to the bottom of a `SheetShell`. Picks up the safe-area
 * bottom inset on iOS so action buttons clear the home indicator.
 */
export function SheetFooter({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <footer
      className={cn(
        "flex-shrink-0 flex items-center gap-2",
        "px-4 pt-3",
        "border-t border-[hsl(var(--color-foreground)/0.06)]",
        className
      )}
      style={{ paddingBottom: "calc(env(safe-area-inset-bottom, 0px) + 0.75rem)" }}
    >
      {children}
    </footer>
  );
}

/**
 * Section label above a `SheetGroup`. iOS Settings–style:
 * small + muted + wide letter spacing.
 */
export function SheetSectionLabel({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("glass-section-label px-4", className)}>{children}</div>
  );
}

/**
 * Grouped-list container. Replaces the shadcn `Card + CardHeader/Content`
 * triplet inside sheets. Rows inside stack naturally with a subtle
 * divider (see `.glass-list > * + *` in `index.css`).
 *
 * Use `.glass-row` or `.glass-pane` radii depending on whether the group
 * contains a single row or multiple stacked rows.
 */
export function SheetGroup({
  children,
  className,
  padded = true,
}: {
  children: React.ReactNode;
  className?: string;
  padded?: boolean;
}) {
  return (
    <div
      className={cn(
        // `.glass-thin` inside a `.glass-thick` shell so nested groups
        // look like a second glass pane sitting on the sheet, not a new
        // opaque card.
        "glass glass-thin glass-pane",
        padded && "p-4",
        className
      )}
    >
      {children}
    </div>
  );
}
