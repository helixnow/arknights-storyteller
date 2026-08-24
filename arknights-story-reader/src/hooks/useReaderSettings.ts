import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useToast } from "@/components/ui/toast";

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
  // 滑杆最小值是 1.4。早前这里写成 1.2：落在 [1.2, 1.4) 的旧值能通过校验，
  // 但 range 元素会把 value 钳到 min 显示——滑块停在 1.4、数字标签却显示
  // 1.2/1.3，「调小」按钮还被误禁用。区间必须与滑杆完全一致。
  lineHeight: [1.4, 3.4],
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
  // 只接受数字和非空数字字符串（老版本可能把滑杆值序列化成字符串）。
  // 其余形状（null / 布尔 / 数组等）一律回落默认值：直接 Number(null) === 0
  // 会把缺失值钳到区间下限——pageWidth 变 60%、字号变 14，页面明显不对。
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim() !== ""
        ? Number(value)
        : Number.NaN;
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

/** 失败提示的会话级闩锁：滑杆连拖会连发写入，同一轮失败只提醒一次。 */
let persistFailureNotified = false;

/**
 * quota 满时没写进盘的最后一份设置。StoryReader 按 storyId 重挂，实例级
 * pending 会随旧章节一起回收；不放到模块级暂存的话，用户刚调好的排版会在
 * 切到下一章时退回盘上的旧值，「将自动重试」也无从兑现。
 *
 * 设置是一个整体对象，冲突口径仍是 last-write-wins：收到其它窗口的
 * storage 事件时会直接丢掉这份暂存并采用外部值，不做逐字段合并。
 */
let failedSettingsWrite: ReaderSettings | null = null;

/** 初始挂载 / 换章对账时优先保住本会话里尚未落盘的最新设置。 */
function loadLatestSettings(): ReaderSettings {
  return failedSettingsWrite ?? loadSettings();
}

export function useReaderSettings() {
  const [settings, setSettings] = useState<ReaderSettings>(loadLatestSettings);

  // Persist on change, but coalesce bursts from slider drags so we don't
  // hit localStorage 18 times while the user is pulling the font-size
  // knob across its full range. A single flush on unmount covers the
  // final value when the drawer closes mid-drag.
  const persistTimerRef = useRef<number | null>(null);
  // 等待防抖写入的最新快照；已落盘时为 null。
  const pendingSettingsRef = useRef<ReaderSettings | null>(null);
  // 「盘上当前内容」的序列化串：最后一次成功写入、或最后一次收到的外部
  // storage 事件值。用来抑制回声写入，也用来识别 storage 事件是否源于
  // 本窗口自己的写入。
  const lastRawRef = useRef<string | null>(null);

  // 冲刷跑在 setTimeout 回调和卸载清理里，通过 ref 取最新的 toast 句柄。
  const toast = useToast();
  const toastRef = useRef(toast);
  useEffect(() => {
    toastRef.current = toast;
  }, [toast]);

  /**
   * 把待写快照冲刷进 localStorage。写失败以前是静默吞掉的——面板上排版
   * 已经生效，用户以为设置保存了，重启后却被打回原样。改为明确提示一次；
   * 且失败时保留 pending（与阅读进度 hook 的 flushPending 一致），后续
   * 改动 / 卸载冲刷会带着它重试。只有真正写成功才清空 pending。
   */
  const flushPendingSettings = useCallback(() => {
    const pending = pendingSettingsRef.current ?? failedSettingsWrite;
    if (pending === null) return;
    const raw = JSON.stringify(pending);
    if (raw === lastRawRef.current) {
      // 内容与盘上完全一致（典型场景：跟随 storage 事件之后的回写），
      // 再写一遍只会在别的窗口触发一轮多余的事件。
      pendingSettingsRef.current = null;
      failedSettingsWrite = null;
      return;
    }
    try {
      window.localStorage.setItem(STORAGE_KEY, raw);
      lastRawRef.current = raw;
      persistFailureNotified = false;
      pendingSettingsRef.current = null;
      failedSettingsWrite = null;
      return;
    } catch {
      // 隐私模式 / 配额不足时写入失败是原子的：旧数据原样保留，本次改动
      // 只在会话内生效。
    }
    // 实例还活着时 pending 会继续重试；切章回收实例后由模块级快照接力。
    failedSettingsWrite = pending;
    if (!persistFailureNotified) {
      persistFailureNotified = true;
      toastRef.current.warn("阅读设置未能保存到本地存储（空间可能已满），将自动重试");
    }
  }, []);
  // 首帧的值就是刚从 localStorage 读出来的，回写没有意义；更糟的是：如果
  // 读取因数据损坏回落到了默认值，这次回写会立刻用默认值覆盖掉原始数据，
  // 连恢复的机会都不留。守卫不能用「跳过第一次 effect」的布尔标记：
  // StrictMode 开发模式下挂载期 effect 连跑两次、ref 不会重置，第二次就把
  // 初始状态写回去了（收藏、划线两个 hook 都踩过同一个坑）。改为与初始
  // state 做引用比较——任何真实改动都会经 sanitizeSettings 产生新对象。
  const initialSettingsRef = useRef(settings);
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (settings === initialSettingsRef.current) {
      return;
    }
    pendingSettingsRef.current = settings;
    if (persistTimerRef.current !== null) {
      window.clearTimeout(persistTimerRef.current);
    }
    persistTimerRef.current = window.setTimeout(() => {
      persistTimerRef.current = null;
      flushPendingSettings();
    }, 200);
    return () => {
      // deps 变化触发的 cleanup 只负责拆掉旧定时器——下一次 effect 会带着
      // 更新的值重新装上，连发才真正被合并。之前在这里顺手同步 persist()，
      // 等于滑杆每动一格就同步写一次 localStorage，恰是上面注释要避免的事。
      if (persistTimerRef.current !== null) {
        window.clearTimeout(persistTimerRef.current);
        persistTimerRef.current = null;
      }
    };
  }, [settings, flushPendingSettings]);

  // 卸载冲刷：拖着滑杆直接关掉抽屉/离开阅读器时，把还在防抖窗口里的
  // 最终值写掉，而不是悄悄丢弃。
  useEffect(() => () => flushPendingSettings(), [flushPendingSettings]);

  // 挂载后对账一次盘上内容。阅读器按 storyId 重挂，换章时新实例的 useState
  // 初始化在 render 阶段读盘，而旧实例的卸载冲刷要到 commit 的 passive 清理
  // 阶段才落盘（React 先跑被删子树的 passive 清理、再跑新子树的 passive
  // effect，所以这里必然读得到那笔写入）——初始快照因此可能落后一笔：旧实例
  // 防抖窗口里、或 quota 失败后滞留重试成功的那次调整。设置是单对象整体
  // 覆写，不对账的话新章里随手改个主题就会从过期基线出发，把那笔调整打回
  // 旧样。逐键比较：值全一致时保留原引用，别惊动排版，也别触发回写。
  useEffect(() => {
    if (typeof window === "undefined") return;
    setSettings((prev) => {
      const disk = loadLatestSettings();
      const changed = (Object.keys(disk) as Array<keyof ReaderSettings>).some(
        (key) => disk[key] !== prev[key]
      );
      return changed ? disk : prev;
    });
  }, []);

  // 切后台 / 关标签页冲刷：移动端杀掉 app、桌面端直接关窗口都不会走
  // unmount（阅读器被 KeepAlive 常驻挂载，settings hook 跟着常驻）。
  // 调完字号 200ms 内锁屏或关掉 app，防抖窗口里的最终值以前会静默丢失，
  // 下次打开排版被打回旧样。与阅读进度 hook 的同名兜底对齐。
  useEffect(() => {
    if (typeof window === "undefined") return;
    const handleHide = () => {
      if (document.visibilityState === "hidden") flushPendingSettings();
    };
    const handlePageHide = () => flushPendingSettings();
    document.addEventListener("visibilitychange", handleHide);
    window.addEventListener("pagehide", handlePageHide);
    return () => {
      document.removeEventListener("visibilitychange", handleHide);
      window.removeEventListener("pagehide", handlePageHide);
    };
  }, [flushPendingSettings]);

  // 多窗口（桌面端可以开多个）时跟随其它窗口的修改。设置是整对象回写：
  // 不跟随的话，A 窗口刚调好的字号会在 B 窗口下一次改主题的回写里被 B 的
  // 旧内存快照打回（收藏 / 偏好 hook 修过同一个坑）。
  useEffect(() => {
    if (typeof window === "undefined") return;
    const onStorage = (event: StorageEvent) => {
      // key 为 null 表示外部 storage.clear()，也要跟随。
      if (event.key !== null && event.key !== STORAGE_KEY) return;
      const raw = event.key === STORAGE_KEY ? event.newValue : null;
      if (event.key === STORAGE_KEY && raw === lastRawRef.current) return;
      lastRawRef.current = raw;
      // 本窗口还压在防抖里的快照已经过期，冲出去会盖掉对方刚写的内容；
      // 外部写入以后到为准，把它丢弃。
      pendingSettingsRef.current = null;
      failedSettingsWrite = null;
      persistFailureNotified = false;
      setSettings((prev) => {
        const next = loadSettings();
        const changed = (Object.keys(next) as Array<keyof ReaderSettings>).some(
          (key) => next[key] !== prev[key]
        );
        return changed ? next : prev;
      });
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

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
