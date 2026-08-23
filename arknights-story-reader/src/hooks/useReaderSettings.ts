import { useCallback, useEffect, useMemo, useRef, useState } from "react";

export const FONT_FAMILIES = [
  {
    value:
      "'Arknights Noto Serif SC', 'Noto Serif SC', 'Source Han Serif SC', 'Songti SC', 'SimSun', serif",
    label: "内置 · 思源宋体",
  },
  {
    value:
      "'Arknights Noto Sans SC', 'Noto Sans SC', 'Source Han Sans SC', 'PingFang SC', 'HarmonyOS Sans SC', 'Microsoft YaHei', sans-serif",
    label: "内置 · 思源黑体",
  },
  {
    value:
      "'Arknights LXGW WenKai', 'LXGW WenKai', 'Kaiti SC', 'STKaiti', 'KaiTi', 'Noto Serif SC', serif",
    label: "内置 · 霞鹜文楷",
  },
  { value: "system", label: "系统默认" },
];

const FONT_FAMILY_VALUES = new Set(FONT_FAMILIES.map((font) => font.value));

export interface ReaderSettings {
  fontFamily: string;
  fontSize: number;
  lineHeight: number;
  letterSpacing: number;
  paragraphSpacing: number; // 段落间距
  pageWidth: number; // 页面宽度（百分比）
  textAlign: 'left' | 'justify'; // 文本对齐方式
  /**
   * 阅读专用主题，映射到 `.reader-surface[data-reader-theme="..."]` 的 CSS。
   * `default` 表示跟随全局主题色，其余为阅读器专属配色。
   */
  theme: 'default' | 'sepia' | 'green' | 'dark' | 'paper';
  readingMode: 'paged' | 'scroll'; // 阅读模式：分页/滚动
  /** 段落首行缩进两个汉字宽（中文小说惯例） */
  paragraphIndent: boolean;
}

const DEFAULT_SETTINGS: ReaderSettings = {
  fontFamily:
    "'Arknights Noto Serif SC', 'Noto Serif SC', 'Source Han Serif SC', 'Songti SC', 'SimSun', serif",
  fontSize: 19,
  lineHeight: 1.7,
  letterSpacing: 0,
  paragraphSpacing: 0.7, // rem
  pageWidth: 100, // 100%
  textAlign: 'justify',
  theme: 'default',
  readingMode: 'scroll',
  paragraphIndent: false,
};

const STORAGE_KEY = "reader-settings";

/** 各数值项的合法区间，和设置面板里滑杆的 min/max 保持一致。 */
const NUMERIC_RANGES: Record<
  "fontSize" | "lineHeight" | "letterSpacing" | "paragraphSpacing" | "pageWidth",
  [number, number]
> = {
  fontSize: [14, 32],
  lineHeight: [1.2, 3.4],
  letterSpacing: [0, 4],
  paragraphSpacing: [0.3, 3],
  pageWidth: [60, 100],
};

const THEMES = new Set<ReaderSettings["theme"]>([
  "default",
  "sepia",
  "green",
  "dark",
  "paper",
]);
const READING_MODES = new Set<ReaderSettings["readingMode"]>(["paged", "scroll"]);
const TEXT_ALIGNS = new Set<ReaderSettings["textAlign"]>(["left", "justify"]);

function clampNumber(value: unknown, [min, max]: [number, number], fallback: number): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

/**
 * 把任意来源（localStorage、老版本、外部写入）的设置收敛成合法值。
 * 之前只校验了字体，一份被改坏的 `fontSize: 0` 就能让正文整块塌掉。
 */
function sanitizeSettings(input: Partial<ReaderSettings> | null | undefined): ReaderSettings {
  const source = input ?? {};
  const fontFamily =
    typeof source.fontFamily === "string" && FONT_FAMILY_VALUES.has(source.fontFamily)
      ? source.fontFamily
      : DEFAULT_SETTINGS.fontFamily;
  return {
    fontFamily,
    fontSize: clampNumber(source.fontSize, NUMERIC_RANGES.fontSize, DEFAULT_SETTINGS.fontSize),
    lineHeight: clampNumber(source.lineHeight, NUMERIC_RANGES.lineHeight, DEFAULT_SETTINGS.lineHeight),
    letterSpacing: clampNumber(
      source.letterSpacing,
      NUMERIC_RANGES.letterSpacing,
      DEFAULT_SETTINGS.letterSpacing
    ),
    paragraphSpacing: clampNumber(
      source.paragraphSpacing,
      NUMERIC_RANGES.paragraphSpacing,
      DEFAULT_SETTINGS.paragraphSpacing
    ),
    pageWidth: clampNumber(source.pageWidth, NUMERIC_RANGES.pageWidth, DEFAULT_SETTINGS.pageWidth),
    textAlign: TEXT_ALIGNS.has(source.textAlign as ReaderSettings["textAlign"])
      ? (source.textAlign as ReaderSettings["textAlign"])
      : DEFAULT_SETTINGS.textAlign,
    theme: THEMES.has(source.theme as ReaderSettings["theme"])
      ? (source.theme as ReaderSettings["theme"])
      : DEFAULT_SETTINGS.theme,
    readingMode: READING_MODES.has(source.readingMode as ReaderSettings["readingMode"])
      ? (source.readingMode as ReaderSettings["readingMode"])
      : DEFAULT_SETTINGS.readingMode,
    paragraphIndent:
      typeof source.paragraphIndent === "boolean"
        ? source.paragraphIndent
        : DEFAULT_SETTINGS.paragraphIndent,
  };
}

function loadSettings(): ReaderSettings {
  if (typeof window === "undefined") return DEFAULT_SETTINGS;
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (!stored) return DEFAULT_SETTINGS;
    return sanitizeSettings(JSON.parse(stored) as Partial<ReaderSettings>);
  } catch {
    return DEFAULT_SETTINGS;
  }
}

export function useReaderSettings() {
  const [settings, setSettings] = useState<ReaderSettings>(loadSettings);

  // Persist on change, but coalesce bursts from slider drags so we don't
  // hit localStorage 18 times while the user is pulling the font-size
  // knob across its full range. A single flush on unmount covers the
  // final value when the drawer closes mid-drag.
  const persistTimerRef = useRef<number | null>(null);
  // 首次挂载只是把刚读出来的值原样写回去，纯属浪费一次同步写。
  const hydratedRef = useRef(false);
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!hydratedRef.current) {
      hydratedRef.current = true;
      return;
    }
    const persist = () => {
      try {
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
      } catch {
        // ignore quota errors
      }
    };
    if (persistTimerRef.current !== null) {
      window.clearTimeout(persistTimerRef.current);
    }
    persistTimerRef.current = window.setTimeout(() => {
      persist();
      persistTimerRef.current = null;
    }, 200);
    return () => {
      if (persistTimerRef.current !== null) {
        window.clearTimeout(persistTimerRef.current);
        persistTimerRef.current = null;
        persist();
      }
    };
  }, [settings]);

  const updateSettings = useCallback((partial: Partial<ReaderSettings>) => {
    setSettings((prev) => {
      const next = sanitizeSettings({ ...prev, ...partial });
      // 滑杆按住不动也会持续派发 input 事件；值没变就别制造新对象，
      // 否则上千段的正文会跟着白白重排一次。
      const changed = (Object.keys(next) as Array<keyof ReaderSettings>).some(
        (key) => next[key] !== prev[key]
      );
      return changed ? next : prev;
    });
  }, []);

  const resetSettings = useCallback(() => {
    setSettings((prev) => {
      const changed = (Object.keys(DEFAULT_SETTINGS) as Array<keyof ReaderSettings>).some(
        (key) => DEFAULT_SETTINGS[key] !== prev[key]
      );
      return changed ? { ...DEFAULT_SETTINGS } : prev;
    });
  }, []);

  return useMemo(
    () => ({ settings, updateSettings, resetSettings }),
    [settings, updateSettings, resetSettings]
  );
}
