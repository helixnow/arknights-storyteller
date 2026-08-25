import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useToast } from "@/components/ui/toast";
import {
  DEFAULT_APP_PREFS,
  hydrateAppPrefs,
  type AppPrefsSnapshot,
  type HydratedAppPrefs,
} from "@/lib/appShellLogic";

interface AppPreferencesContextValue {
  showSummaries: boolean;
  setShowSummaries: (value: boolean) => void;
  /** 极简模式：全局隐藏封面/头像等装饰性素材，只留纯文本体验。 */
  minimalMode: boolean;
  setMinimalMode: (value: boolean) => void;
  /** 阅读器段落是否渲染 `[Image]` 插画段。默认 true。 */
  inlineImages: boolean;
  setInlineImages: (value: boolean) => void;
}

const AppPreferencesContext = createContext<AppPreferencesContextValue | null>(null);

const STORAGE_KEY = "arknights-app-prefs-v2";
const LEGACY_STORAGE_KEY = "arknights-app-prefs-v1";

type Prefs = AppPrefsSnapshot;

/** 失败提示的会话级闩锁：同一轮连续失败只打扰用户一次，写成功后复位。 */
let persistFailureNotified = false;

function samePrefs(a: Prefs, b: Prefs): boolean {
  return (
    a.showSummaries === b.showSummaries &&
    a.minimalMode === b.minimalMode &&
    a.inlineImages === b.inlineImages
  );
}

function readPrefs(): HydratedAppPrefs {
  const unavailable = (): HydratedAppPrefs => {
    const prefs = { ...DEFAULT_APP_PREFS };
    return {
      readable: false,
      prefs,
      source: "default",
      currentCorrupt: false,
      serialized: JSON.stringify(prefs),
    };
  };
  if (typeof window === "undefined") return unavailable();
  try {
    // Accessing the localStorage property itself can throw in a sandboxed or
    // policy-restricted WebView, before getItem has a chance to be caught.
    return hydrateAppPrefs(window.localStorage, STORAGE_KEY, LEGACY_STORAGE_KEY);
  } catch {
    return unavailable();
  }
}

export function AppPreferencesProvider({ children }: { children: ReactNode }) {
  const initialHydrationRef = useRef<HydratedAppPrefs | null>(null);
  if (initialHydrationRef.current === null) initialHydrationRef.current = readPrefs();
  const [prefs, setPrefs] = useState<Prefs>(initialHydrationRef.current.prefs);
  // 这份签名表示「storage 已经知道的值」。首帧、迁移结果和外部窗口更新都
  // 先登记再 setState，持久化 effect 就不会把 hydration 当成一次用户修改。
  const persistedPrefsRef = useRef(initialHydrationRef.current.serialized);

  // 写失败提示走 ref 取最新句柄，避免 toast 身份变化搅动持久化 effect 的 deps。
  const toast = useToast();
  const toastRef = useRef(toast);
  useEffect(() => {
    toastRef.current = toast;
  }, [toast]);

  useEffect(() => {
    const serialized = JSON.stringify(prefs);
    if (serialized === persistedPrefsRef.current) return;
    try {
      window.localStorage.setItem(STORAGE_KEY, serialized);
      persistedPrefsRef.current = serialized;
      persistFailureNotified = false;
    } catch {
      // 隐私模式 / 配额不足：偏好只在本次会话内生效。开关在界面上已经
      // 翻过去了，静默失败等于骗用户「已保存」，重启后被打回——和收藏 /
      // 划线 / 阅读设置的同类失败一样提示一次（下次任何偏好改动会带着
      // 全量对象自然重试）。
      if (!persistFailureNotified) {
        persistFailureNotified = true;
        toastRef.current.warn("偏好设置未能保存到本地存储（空间可能已满）");
      }
    }
  }, [prefs]);

  // 多窗口（桌面端可以开多个）时跟随其它窗口的修改，避免互相覆盖。
  useEffect(() => {
    if (typeof window === "undefined") return;
    const onStorage = (event: StorageEvent) => {
      if (
        event.key !== null &&
        event.key !== STORAGE_KEY &&
        event.key !== LEGACY_STORAGE_KEY
      ) {
        return;
      }
      const hydrated = readPrefs();
      // storage 暂时不可读（隐私权限切换等）时保留本窗口已经能用的状态；
      // 把一次读取异常当成“用户清空了设置”会制造跨窗口数据丢失。
      if (!hydrated.readable) return;
      persistedPrefsRef.current = hydrated.serialized;
      persistFailureNotified = false;
      setPrefs((prev) => {
        return samePrefs(prev, hydrated.prefs) ? prev : hydrated.prefs;
      });
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  // Reflect minimal mode on <html> so CSS can scope rules easily.
  useEffect(() => {
    if (typeof document === "undefined") return;
    const root = document.documentElement;
    if (prefs.minimalMode) {
      root.setAttribute("data-minimal", "true");
    } else {
      root.removeAttribute("data-minimal");
    }
  }, [prefs.minimalMode]);

  const setShowSummaries = useCallback((value: boolean) => {
    setPrefs((p) => (p.showSummaries === value ? p : { ...p, showSummaries: value }));
  }, []);

  const setMinimalMode = useCallback((value: boolean) => {
    setPrefs((p) => (p.minimalMode === value ? p : { ...p, minimalMode: value }));
  }, []);

  const setInlineImages = useCallback((value: boolean) => {
    setPrefs((p) => (p.inlineImages === value ? p : { ...p, inlineImages: value }));
  }, []);

  const value = useMemo<AppPreferencesContextValue>(
    () => ({
      showSummaries: prefs.showSummaries,
      setShowSummaries,
      minimalMode: prefs.minimalMode,
      setMinimalMode,
      inlineImages: prefs.inlineImages,
      setInlineImages,
    }),
    [prefs, setShowSummaries, setMinimalMode, setInlineImages]
  );
  return <AppPreferencesContext.Provider value={value}>{children}</AppPreferencesContext.Provider>;
}

export function useAppPreferences() {
  const ctx = useContext(AppPreferencesContext);
  if (!ctx) throw new Error("useAppPreferences must be used within AppPreferencesProvider");
  return ctx;
}
