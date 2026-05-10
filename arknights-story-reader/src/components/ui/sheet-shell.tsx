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

export function SheetShell({
  state,
  onClose,
  ariaLabel,
  children,
  className,
}: SheetShellProps) {
  return (
    <div
      className="fixed inset-0 z-50 flex"
      role="dialog"
      aria-modal="true"
      aria-label={ariaLabel}
    >
      <div
        data-state={state}
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
          className={cn(
            "pointer-events-auto h-full flex flex-col overflow-hidden",
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
        "px-5 pt-4 pb-3",
        "border-b border-[hsl(var(--color-foreground)/0.06)]"
      )}
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
