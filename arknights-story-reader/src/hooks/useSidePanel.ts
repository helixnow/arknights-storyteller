import { useEffect, useRef, useState } from "react";

interface UseSidePanelOptions {
  /** Controlled open flag from the parent. */
  open: boolean;
  /** Invoked when the panel should close (ESC, swipe-dismiss, etc.). */
  onClose: () => void;
  /**
   * Duration (ms) of the closing animation. The panel stays mounted for this
   * long after `open` flips to false so the exit animation can play before we
   * unmount.
   */
  exitDurationMs?: number;
}

interface UseSidePanelResult {
  /** Whether the panel DOM should be rendered (true during open + exit). */
  rendered: boolean;
  /** Data-state string — drives enter/exit animation via Tailwind data variants. */
  state: "open" | "closed";
}

/**
 * Shared behavior for right-hand side panels (aka drawers):
 *
 * - Graceful two-phase mount/unmount so exit animations can play
 * - ESC key closes the panel
 * - Locks background body scroll while open
 *
 * Returns a `state` string ("open" / "closed") that consumers should spread
 * to `data-state` on their animated container so Tailwind's
 * `data-[state=closed]:*` variants can drive the exit animation.
 */
export function useSidePanel({
  open,
  onClose,
  exitDurationMs = 220,
}: UseSidePanelOptions): UseSidePanelResult {
  const [rendered, setRendered] = useState(open);
  const [state, setState] = useState<"open" | "closed">(open ? "open" : "closed");
  // Latest onClose callback so the ESC listener doesn't re-bind on every render.
  const onCloseRef = useRef(onClose);

  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  // Two-phase render: when opening, mount first, then flip data-state to
  // "open" on the next frame so the CSS transition is triggered. When closing,
  // flip to "closed" immediately and unmount after the exit animation.
  useEffect(() => {
    if (open) {
      setRendered(true);
      const id = requestAnimationFrame(() => setState("open"));
      return () => cancelAnimationFrame(id);
    }

    setState("closed");
    const id = window.setTimeout(() => setRendered(false), exitDurationMs);
    return () => window.clearTimeout(id);
  }, [open, exitDurationMs]);

  // ESC to dismiss — only while actually open (not during exit animation).
  useEffect(() => {
    if (!open) return;
    const handle = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      const target = event.target as HTMLElement | null;
      // Don't swallow ESC from input fields where the user may still be typing.
      if (target && ["INPUT", "TEXTAREA"].includes(target.tagName)) return;
      event.preventDefault();
      onCloseRef.current();
    };
    window.addEventListener("keydown", handle);
    return () => window.removeEventListener("keydown", handle);
  }, [open]);

  // Lock body scroll so the page behind the drawer doesn't move on trackpad
  // scroll / touch drag outside the drawer area.
  useEffect(() => {
    if (!rendered) return;
    const body = document.body;
    const previousOverflow = body.style.overflow;
    const previousPaddingRight = body.style.paddingRight;
    // Compensate for the disappearing scrollbar on desktop to avoid layout shift.
    const scrollbarWidth = window.innerWidth - document.documentElement.clientWidth;
    body.style.overflow = "hidden";
    if (scrollbarWidth > 0) {
      body.style.paddingRight = `${scrollbarWidth}px`;
    }
    return () => {
      body.style.overflow = previousOverflow;
      body.style.paddingRight = previousPaddingRight;
    };
  }, [rendered]);

  return { rendered, state };
}
