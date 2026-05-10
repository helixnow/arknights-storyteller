import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";

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

interface Prefs {
  showSummaries: boolean;
  minimalMode: boolean;
  inlineImages: boolean;
}

const DEFAULT_PREFS: Prefs = {
  showSummaries: false,
  minimalMode: false,
  inlineImages: true,
};

function readPrefs(): Prefs {
  if (typeof window === "undefined") return DEFAULT_PREFS;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      // Back-compat: try the old v1 key.
      const legacy = window.localStorage.getItem("arknights-app-prefs-v1");
      if (legacy) {
        try {
          const p = JSON.parse(legacy);
          return { ...DEFAULT_PREFS, showSummaries: Boolean(p?.showSummaries) };
        } catch {}
      }
      return DEFAULT_PREFS;
    }
    const parsed = JSON.parse(raw);
    return {
      showSummaries: Boolean(parsed?.showSummaries),
      minimalMode: Boolean(parsed?.minimalMode),
      inlineImages: parsed?.inlineImages === false ? false : true,
    };
  } catch {
    return DEFAULT_PREFS;
  }
}

export function AppPreferencesProvider({ children }: { children: ReactNode }) {
  const [prefs, setPrefs] = useState<Prefs>(() => readPrefs());

  useEffect(() => {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
    } catch {}
  }, [prefs]);

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

  const value = useMemo<AppPreferencesContextValue>(
    () => ({
      showSummaries: prefs.showSummaries,
      setShowSummaries: (v) => setPrefs((p) => ({ ...p, showSummaries: v })),
      minimalMode: prefs.minimalMode,
      setMinimalMode: (v) => setPrefs((p) => ({ ...p, minimalMode: v })),
      inlineImages: prefs.inlineImages,
      setInlineImages: (v) => setPrefs((p) => ({ ...p, inlineImages: v })),
    }),
    [prefs]
  );
  return <AppPreferencesContext.Provider value={value}>{children}</AppPreferencesContext.Provider>;
}

export function useAppPreferences() {
  const ctx = useContext(AppPreferencesContext);
  if (!ctx) throw new Error("useAppPreferences must be used within AppPreferencesProvider");
  return ctx;
}

