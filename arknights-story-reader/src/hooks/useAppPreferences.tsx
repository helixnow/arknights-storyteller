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

/** 持久化数据只认真正的布尔值；字符串 / 数字等脏值一律回落到各自默认。 */
function readBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function normalizePrefs(parsed: unknown): Prefs {
  const source = (parsed ?? {}) as Partial<Record<keyof Prefs, unknown>>;
  return {
    showSummaries: readBoolean(source.showSummaries, DEFAULT_PREFS.showSummaries),
    minimalMode: readBoolean(source.minimalMode, DEFAULT_PREFS.minimalMode),
    inlineImages: readBoolean(source.inlineImages, DEFAULT_PREFS.inlineImages),
  };
}

/** 失败提示的会话级闩锁：同一轮连续失败只打扰用户一次，写成功后复位。 */
let persistFailureNotified = false;

function samePrefs(a: Prefs, b: Prefs): boolean {
  return (
    a.showSummaries === b.showSummaries &&
    a.minimalMode === b.minimalMode &&
    a.inlineImages === b.inlineImages
  );
}

function readPrefs(): Prefs {
  if (typeof window === "undefined") return DEFAULT_PREFS;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw) return normalizePrefs(JSON.parse(raw));

    const legacy = window.localStorage.getItem(LEGACY_STORAGE_KEY);
    if (!legacy) return DEFAULT_PREFS;

    // v1 只存过 showSummaries。就地升级成 v2 并清掉旧键，否则每次启动都要走一遍回退分支。
    let migrated = DEFAULT_PREFS;
    try {
      migrated = normalizePrefs({ ...DEFAULT_PREFS, showSummaries: JSON.parse(legacy)?.showSummaries });
    } catch {
      // 旧数据损坏，用默认值继续。
    }
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(migrated));
      window.localStorage.removeItem(LEGACY_STORAGE_KEY);
    } catch {
      // 回写新键失败（隐私模式 / 配额满）只影响「下次启动还要再迁一遍」，
      // 绝不能连累本次会话：迁移值已经从旧键成功读出来了，必须原样返回。
      // 之前这一步失败会掉进外层 catch、把用户的旧偏好整个打回默认。
    }
    return migrated;
  } catch {
    return DEFAULT_PREFS;
  }
}

export function AppPreferencesProvider({ children }: { children: ReactNode }) {
  const [prefs, setPrefs] = useState<Prefs>(readPrefs);

  // 写失败提示走 ref 取最新句柄，避免 toast 身份变化搅动持久化 effect 的 deps。
  const toast = useToast();
  const toastRef = useRef(toast);
  useEffect(() => {
    toastRef.current = toast;
  }, [toast]);

  // 首帧的值就是刚从 localStorage 读出来的，回写没有意义；更糟的是：如果
  // 读取因数据损坏 / 迁移中断回落到了 DEFAULT_PREFS，这次回写会立刻用默认值
  // 覆盖掉尚未迁移或只读到一半的原始数据，连恢复的机会都不留。守卫不能用
  // 「跳过第一次 effect」的布尔标记：StrictMode 开发模式下挂载期 effect 连跑
  // 两次、ref 不会重置，第二次就把初始状态写回去了（收藏 / 高亮 hook 踩过
  // 同一个坑）。改为与初始 state 做引用比较——用户任何真实改动都会产生新
  // 对象，自然落盘。
  const initialPrefsRef = useRef(prefs);
  useEffect(() => {
    if (prefs === initialPrefsRef.current) {
      return;
    }
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
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
      if (event.key !== null && event.key !== STORAGE_KEY) return;
      setPrefs((prev) => {
        const next = readPrefs();
        return samePrefs(prev, next) ? prev : next;
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
