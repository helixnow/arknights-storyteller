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
 * Animation and lifecycle (esc/scroll-lock/two-phase unmount) are left to
 * the caller via `state`, which must be spread onto the outer element's
 * `data-state` attribute. The existing `useSidePanel` hook returns that
 * value already — see `ShareImageDialog` for the usage.
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

export function SheetShell({
  state,
  onClose,
  ariaLabel,
  children,
  className,
}: SheetShellProps) {
  const panelRef = React.useRef<HTMLDivElement | null>(null);
  const restoreRef = React.useRef<HTMLElement | null>(null);

  /*
   * `aria-modal` 只是给辅助技术的声明，真正的模态行为要自己实现：
   * 打开时把焦点移进面板（面板本身可聚焦，避免直接跳到输入框弹起软键盘），
   * 关闭时还给触发它的按钮，否则键盘/读屏用户会被扔回文档开头。
   */
  React.useEffect(() => {
    if (state !== "open") return;
    restoreRef.current = document.activeElement as HTMLElement | null;
    panelRef.current?.focus({ preventScroll: true });
    return () => {
      const previous = restoreRef.current;
      if (previous && document.contains(previous)) {
        previous.focus({ preventScroll: true });
      }
    };
  }, [state]);

  React.useEffect(() => {
    if (state !== "open") return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Tab") return;
      const panel = panelRef.current;
      if (!panel) return;
      const items = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
        (el) => el.offsetParent !== null || el === document.activeElement
      );
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
