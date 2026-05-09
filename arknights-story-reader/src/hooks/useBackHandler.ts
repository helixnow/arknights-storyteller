import { useEffect, useRef } from "react";

/**
 * Register a handler for Android hardware back button and browser popstate.
 *
 * The handler should return `true` when the back event has been consumed
 * (i.e. some in-app UI was dismissed) and the default exit behavior should be
 * suppressed. Returning `false` lets the system perform its default action
 * (on Android: exit the app; in a browser: navigate history).
 *
 * Multiple handlers may be registered simultaneously; the most recently
 * registered handler is invoked first (LIFO), matching a typical modal /
 * navigation stack.
 */
export type BackHandler = () => boolean;

const handlerStack: BackHandler[] = [];

function dispatchBack(): boolean {
  for (let i = handlerStack.length - 1; i >= 0; i -= 1) {
    const handler = handlerStack[i];
    try {
      if (handler()) return true;
    } catch (err) {
      console.warn("[useBackHandler] handler threw", err);
    }
  }
  return false;
}

let globalListenerInstalled = false;
function installGlobalListener() {
  if (globalListenerInstalled || typeof window === "undefined") return;
  globalListenerInstalled = true;

  window.addEventListener("app-back", (event) => {
    const consumed = dispatchBack();
    if (consumed) (event as Event).preventDefault?.();
  });

  window.history.replaceState({ __appRoot: true }, "");
  window.addEventListener("popstate", () => {
    const consumed = dispatchBack();
    if (consumed) {
      window.history.pushState({ __appRoot: true }, "");
    }
  });
}

/**
 * Hook variant: keeps a ref to the latest handler so React state updates
 * inside the handler don't force the effect to re-run. Only `active` toggles
 * registration.
 */
export function useBackHandler(active: boolean, handler: BackHandler): void {
  const ref = useRef<BackHandler>(handler);
  useEffect(() => {
    ref.current = handler;
  }, [handler]);

  useEffect(() => {
    if (!active) return;
    installGlobalListener();
    const wrapper: BackHandler = () => {
      try {
        return ref.current();
      } catch (err) {
        console.warn("[useBackHandler] wrapper threw", err);
        return false;
      }
    };
    handlerStack.push(wrapper);
    return () => {
      const idx = handlerStack.lastIndexOf(wrapper);
      if (idx >= 0) handlerStack.splice(idx, 1);
    };
  }, [active]);
}
