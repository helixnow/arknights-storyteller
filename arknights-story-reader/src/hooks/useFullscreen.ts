import { useCallback, useEffect, useMemo, useState } from "react";

const canAccessDom = typeof document !== "undefined";

/** Safari（含 iPadOS）到现在仍然只认带 webkit 前缀的那套 API。 */
interface WebkitFullscreenDocument extends Document {
  webkitFullscreenElement?: Element | null;
  webkitExitFullscreen?: () => Promise<void> | void;
}

interface WebkitFullscreenElement extends HTMLElement {
  webkitRequestFullscreen?: () => Promise<void> | void;
}

function currentFullscreenElement(): Element | null {
  if (!canAccessDom) return null;
  const doc = document as WebkitFullscreenDocument;
  return doc.fullscreenElement ?? doc.webkitFullscreenElement ?? null;
}

export function useFullscreen() {
  const [isFullscreen, setIsFullscreen] = useState<boolean>(() =>
    Boolean(currentFullscreenElement())
  );

  useEffect(() => {
    if (!canAccessDom) return;
    const handleChange = () => {
      setIsFullscreen(Boolean(currentFullscreenElement()));
    };
    // 订阅后立刻对一次账：注册前状态可能已经变了。
    handleChange();
    document.addEventListener("fullscreenchange", handleChange);
    document.addEventListener("webkitfullscreenchange", handleChange);
    return () => {
      document.removeEventListener("fullscreenchange", handleChange);
      document.removeEventListener("webkitfullscreenchange", handleChange);
    };
  }, []);

  const enter = useCallback(async (element?: HTMLElement) => {
    if (!canAccessDom) return;
    const target = (element ?? document.documentElement) as WebkitFullscreenElement;
    const request = target.requestFullscreen ?? target.webkitRequestFullscreen;
    if (!request) return;
    try {
      await request.call(target);
    } catch {
      // 用户手势之外的调用会被拒绝，忽略即可。
    }
  }, []);

  const exit = useCallback(async () => {
    if (!canAccessDom || !currentFullscreenElement()) return;
    const doc = document as WebkitFullscreenDocument;
    const request = doc.exitFullscreen ?? doc.webkitExitFullscreen;
    if (!request) return;
    try {
      await request.call(doc);
    } catch {
      // ignore
    }
  }, []);

  const toggle = useCallback(
    async (element?: HTMLElement) => {
      if (currentFullscreenElement()) {
        await exit();
      } else {
        await enter(element);
      }
    },
    [enter, exit]
  );

  return useMemo(
    () => ({ isFullscreen, enter, exit, toggle }),
    [isFullscreen, enter, exit, toggle]
  );
}
