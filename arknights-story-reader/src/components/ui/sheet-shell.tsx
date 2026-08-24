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

/*
 * Esc 要放过正在输入的控件：那里 Esc 的语义是「撤销这次输入」。
 * 但 input 不全是文本框——滑杆 / 复选 / 单选没有「取消输入」一说，焦点停在
 * 上面时 Esc 应当照常关掉 sheet（拖完字号滑杆、勾完分享选项就是这个状态），
 * 否则键盘用户只能 Tab 一整圈去找关闭键。
 */
const NON_TEXT_INPUT_TYPES = new Set([
  "button",
  "checkbox",
  "color",
  "file",
  "image",
  "radio",
  "range",
  "reset",
  "submit",
]);

function isTextEntry(node: EventTarget | null): boolean {
  const el = node as HTMLElement | null;
  if (!el) return false;
  if (el.tagName === "TEXTAREA" || el.isContentEditable === true) return true;
  return (
    el.tagName === "INPUT" &&
    !NON_TEXT_INPUT_TYPES.has((el as HTMLInputElement).type)
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

/*
 * 键盘（Escape / Tab 圈禁）和焦点回收只该由「最顶层呈现的模态」消费。
 * 每个 SheetShell 都往 document 捕获阶段挂 keydown，多个实例并存时按
 * 「谁先打开谁先执行」排队——没有这层判定，一次 Escape 会关掉最底下的
 * sheet 并用 preventDefault 把真正在顶上的那个挡住；useBackHandler 里
 * dismissPresentedModal 专门派发给最顶层对话框的合成 Escape 同样会被
 * 底层实例截走，返回手势于是关错层。判定规则：事件目标落在哪个 dialog
 * 里就归谁；不在任何 dialog 里时，按 DOM 顺序取最后一个仍在呈现的
 * aria-modal 对话框当顶层（后开的 sheet 挂载在后，与视觉层叠一致）。
 */
function isTopmostPresentedDialog(
  panel: HTMLElement,
  target: EventTarget | null
): boolean {
  const targetEl = target instanceof Element ? target : null;
  const targetDialog = targetEl?.closest?.('[role="dialog"]');
  if (targetDialog) return targetDialog === panel;
  const dialogs = document.querySelectorAll<HTMLElement>(
    '[role="dialog"][aria-modal="true"]'
  );
  for (let i = dialogs.length - 1; i >= 0; i -= 1) {
    const dialog = dialogs[i];
    if (dialog === panel) return true;
    if (dialog.closest("[inert]")) continue;
    if (dialog.closest('[data-state="closed"]')) continue;
    if (dialog.getClientRects().length === 0) continue;
    return false;
  }
  // 查询里找不到自己（理论上不会发生）：按单一模态的旧行为处理。
  return true;
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
 * 解锁刻意推迟到微任务：React 在同一次提交里先跑完所有清理再跑所有挂载
 * 效果（关 A 开 B 的交接、严格模式的卸载重挂都是这个形态），若清理阶段
 * 就把 body 样式写回原值，交接期间会出现一帧「锁被放开又立刻重上」的
 * 中间态。等提交结束再看计数：还有人持锁就什么也不写，最后落到 body 的
 * 一定是第一次上锁前记下的原值。（历史上 `useSidePanel` 曾持有第二份
 * 同样的锁、两边清理互相覆盖，那份锁已经拆掉了——见该 hook 的注释。）
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
      if (!isTopmostPresentedDialog(panel, event.target)) return;

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
      // 焦点跌到所有模态之外（body 等）时，只有最顶层的 sheet 有资格把它
      // 请回来；底下那层抢的话焦点会穿到被遮住的面板里。
      if (!isTopmostPresentedDialog(panel, null)) return;
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
      {/*
       * 退场动画的 300ms 里 sheet 仍然挂载（useSidePanel 两阶段卸载），但
       * 它对用户来说已经关掉了：透明的 scrim 若继续参与命中测试，整屏点击
       * 都会被一块看不见的玻璃吃掉（还会把 onClose 重复触发一遍），滑出中
       * 的面板按钮也仍可点到。closed 态一律 pointer-events-none，输入立刻
       * 落回下层内容——与返回栈的语义一致（关闭中的 sheet 已不占返回栈）。
       */}
      <div
        data-state={state}
        aria-hidden="true"
        className={cn(
          "absolute inset-0 glass-scrim transition-opacity duration-300",
          "data-[state=closed]:opacity-0 data-[state=open]:opacity-100",
          "data-[state=closed]:pointer-events-none"
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
            // 同 scrim：退场中的面板不再接收输入，避免用户点中一个正在
            // 滑出、状态即将被卸载的控件。
            state === "open" ? "pointer-events-auto" : "pointer-events-none",
            "h-full flex flex-col overflow-hidden",
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
