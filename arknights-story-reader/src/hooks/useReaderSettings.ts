import { useEffect, useRef, useState } from "react";

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

export function useReaderSettings() {
  const [settings, setSettings] = useState<ReaderSettings>(() => {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) {
      try {
        const parsed = JSON.parse(stored) as Partial<ReaderSettings>;
        const ff = parsed.fontFamily;
        const fontFamily: string = ff && FONT_FAMILY_VALUES.has(ff) ? ff : DEFAULT_SETTINGS.fontFamily;
        return { ...DEFAULT_SETTINGS, ...parsed, fontFamily } as ReaderSettings;
      } catch {
        return DEFAULT_SETTINGS;
      }
    }
    return DEFAULT_SETTINGS;
  });

  // Persist on change, but coalesce bursts from slider drags so we don't
  // hit localStorage 18 times while the user is pulling the font-size
  // knob across its full range. A single flush on unmount covers the
  // final value when the drawer closes mid-drag.
  const persistTimerRef = useRef<number | null>(null);
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (persistTimerRef.current !== null) {
      window.clearTimeout(persistTimerRef.current);
    }
    persistTimerRef.current = window.setTimeout(() => {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
      } catch {
        // ignore quota errors
      }
      persistTimerRef.current = null;
    }, 200);
    return () => {
      if (persistTimerRef.current !== null) {
        window.clearTimeout(persistTimerRef.current);
        persistTimerRef.current = null;
        try {
          localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
        } catch {
          // ignore quota errors
        }
      }
    };
  }, [settings]);

  const updateSettings = (partial: Partial<ReaderSettings>) => {
    setSettings((prev) => ({ ...prev, ...partial }));
  };

  const resetSettings = () => {
    setSettings(DEFAULT_SETTINGS);
  };

  return { settings, updateSettings, resetSettings };
}
