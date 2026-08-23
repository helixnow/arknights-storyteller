import { memo, useCallback, useId, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { Button } from "@/components/ui/button";
import { CustomScrollArea } from "@/components/ui/custom-scroll-area";
import {
  SheetShell,
  SheetHeader,
  SheetGroup,
  SheetSectionLabel,
} from "@/components/ui/sheet-shell";
import { FONT_FAMILIES, ReaderSettings as Settings } from "@/hooks/useReaderSettings";
import { useSidePanel } from "@/hooks/useSidePanel";
import { Minus, Plus, RotateCcw, X } from "lucide-react";
import { cn } from "@/lib/utils";

const READING_MODES: Array<{ value: Settings["readingMode"]; label: string; description: string }> =
  [
    {
      value: "scroll",
      label: "连续滚动",
      description: "纵向滚动阅读，向下滑动时自动收起顶栏",
    },
    {
      value: "paged",
      label: "章节分页",
      description: "按页分段，点击正文左右两侧即可翻页",
    },
  ];

const READER_THEMES: Array<{ value: Settings["theme"]; label: string; swatch: string }> = [
  { value: "default", label: "跟随应用", swatch: "hsl(var(--color-background))" },
  { value: "paper", label: "白纸", swatch: "#fafafa" },
  { value: "sepia", label: "羊皮纸", swatch: "#f5ecd7" },
  { value: "green", label: "护眼绿", swatch: "#d7ebd2" },
  { value: "dark", label: "夜幕", swatch: "#0e1014" },
];

const ALIGN_OPTIONS: Array<{ value: Settings["textAlign"]; label: string }> = [
  { value: "left", label: "左对齐" },
  { value: "justify", label: "两端对齐" },
];

interface ReaderSettingsProps {
  open: boolean;
  settings: Settings;
  onClose: () => void;
  onUpdateSettings: (settings: Partial<Settings>) => void;
  onReset: () => void;
}

/**
 * Shared styling for the "picker chip" used across every grid in this
 * panel (reading mode, theme swatch, font, alignment). Active chip uses
 * `.glass-thick` + primary ring so it reads as a solid selection on top
 * of the glass sheet; inactive chip stays on `.glass-thin` so the grid
 * still feels layered.
 */
function pickerChipClass(active: boolean, extra?: string) {
  return cn(
    // 触控目标至少 44px 高，手机上不至于点不中。
    "glass glass-pane min-h-[44px] text-left transition-[background-color,color,box-shadow,transform] duration-200 ease-spring",
    "active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[hsl(var(--color-ring))]",
    active
      ? "glass-thick ring-1 ring-[hsl(var(--color-primary)/0.45)] text-[hsl(var(--color-foreground))]"
      : "glass-thin text-[hsl(var(--color-muted-foreground))] hover:text-[hsl(var(--color-foreground))]",
    extra
  );
}

/**
 * 记忆化：面板挂在阅读器里，阅读器每滚动一次就会重渲染一轮；设置项没变时
 * 没有理由跟着重画整块玻璃面板。
 */
export const ReaderSettingsPanel = memo(function ReaderSettingsPanel({
  open,
  settings,
  onClose,
  onUpdateSettings,
  onReset,
}: ReaderSettingsProps) {
  const { rendered, state } = useSidePanel({ open, onClose });
  const fontGroupLabelId = useId();

  /*
   * `useSidePanel` 的 Esc 监听会主动放过 INPUT，免得抢走输入框里「取消输入」
   * 的语义。但本面板里的 INPUT 全是滑杆：拖完字号后焦点就停在滑杆上，此时
   * 按 Esc 关不掉抽屉，键盘用户只能再 Tab 一圈去找关闭键。这里在面板内部
   * 补一条：焦点落在滑杆上时 Esc 同样关闭。
   */
  const handleContentKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      const target = event.target as HTMLElement | null;
      if (!(target instanceof HTMLInputElement) || target.type !== "range") return;
      event.preventDefault();
      onClose();
    },
    [onClose]
  );

  if (!rendered) return null;

  return (
    <SheetShell state={state} onClose={onClose} ariaLabel="阅读设置">
      <SheetHeader
        title="阅读设置"
        description="调整排版与布局，找到最舒适的阅读方式"
        actions={
          <>
            <Button
              variant="ghost"
              size="icon-pill"
              className="h-11 w-11"
              onClick={onReset}
              aria-label="恢复默认"
              title="恢复默认"
            >
              <RotateCcw className="h-4 w-4" />
            </Button>
            <Button
              variant="ghost"
              size="icon-pill"
              className="h-11 w-11"
              onClick={onClose}
              aria-label="关闭"
              title="关闭"
            >
              <X className="h-4 w-4" />
            </Button>
          </>
        }
      />

      <CustomScrollArea className="flex-1 min-h-0" viewportClassName="reader-scroll">
        <div className="px-4 pt-3 pb-8 space-y-5" onKeyDown={handleContentKeyDown}>
          {/* 阅读模式 ----------------------------------------- */}
          <section className="space-y-2">
            <SheetSectionLabel>
              阅读模式 · <span className="font-normal opacity-70">选择适合你场景的阅读方式</span>
            </SheetSectionLabel>
            <div role="group" aria-label="阅读模式" className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              {READING_MODES.map((mode) => {
                const active = settings.readingMode === mode.value;
                return (
                  <button
                    key={mode.value}
                    type="button"
                    aria-pressed={active}
                    onClick={() => onUpdateSettings({ readingMode: mode.value })}
                    className={pickerChipClass(active, "px-4 py-3")}
                  >
                    <div className="font-medium text-sm">{mode.label}</div>
                    <div className="text-xs opacity-80 mt-0.5 leading-relaxed">
                      {mode.description}
                    </div>
                  </button>
                );
              })}
            </div>
          </section>

          {/* 阅读主题 ----------------------------------------- */}
          <section className="space-y-2">
            <SheetSectionLabel>
              阅读主题 · <span className="font-normal opacity-70">仅作用于阅读器背景与文字</span>
            </SheetSectionLabel>
            <div role="group" aria-label="阅读主题" className="grid grid-cols-5 gap-2">
              {READER_THEMES.map((t) => {
                const active = settings.theme === t.value;
                return (
                  <button
                    key={t.value}
                    type="button"
                    aria-pressed={active}
                    aria-label={`切换至${t.label}主题`}
                    title={t.label}
                    onClick={() => onUpdateSettings({ theme: t.value })}
                    className={pickerChipClass(
                      active,
                      "flex flex-col items-center gap-1.5 p-2.5"
                    )}
                  >
                    <span
                      className="h-7 w-7 rounded-full border border-black/10 shadow-[0_2px_6px_-2px_hsl(0_0%_0%/0.25)]"
                      style={{ backgroundColor: t.swatch }}
                    />
                    <span className="text-[11px]">{t.label}</span>
                  </button>
                );
              })}
            </div>
          </section>

          {/* 排版 --------------------------------------------- */}
          <section className="space-y-2">
            <SheetSectionLabel>
              排版 · <span className="font-normal opacity-70">字体、字号与行距</span>
            </SheetSectionLabel>
            <SheetGroup padded>
              <div className="space-y-5">
                <div className="space-y-2">
                  {/* 这一组是按钮而不是表单控件，用 group + aria-labelledby 关联，
                      比一个指不到任何 id 的 <label> 更准确。 */}
                  <div
                    id={fontGroupLabelId}
                    className="text-sm font-medium text-[hsl(var(--color-foreground))]"
                  >
                    字体
                  </div>
                  <div
                    role="group"
                    aria-labelledby={fontGroupLabelId}
                    className="grid grid-cols-2 sm:grid-cols-3 gap-2"
                  >
                    {FONT_FAMILIES.map((font) => {
                      const active = settings.fontFamily === font.value;
                      return (
                        <button
                          key={font.value}
                          type="button"
                          aria-pressed={active}
                          onClick={() => onUpdateSettings({ fontFamily: font.value })}
                          className={pickerChipClass(active, "text-sm px-3 py-2 text-center")}
                          style={{ fontFamily: font.value === "system" ? undefined : font.value }}
                        >
                          {font.label}
                        </button>
                      );
                    })}
                  </div>
                </div>

                <SliderRow
                  label="字号"
                  display={`${settings.fontSize}px`}
                  min={14}
                  max={32}
                  step={2}
                  value={settings.fontSize}
                  onChange={(v) => onUpdateSettings({ fontSize: v })}
                  minLabel="小"
                  maxLabel="大"
                />
                <SliderRow
                  label="行距"
                  display={settings.lineHeight.toFixed(1)}
                  min={1.4}
                  max={3.4}
                  step={0.1}
                  value={settings.lineHeight}
                  onChange={(v) => onUpdateSettings({ lineHeight: v })}
                />
                <SliderRow
                  label="字间距"
                  display={`${settings.letterSpacing.toFixed(1)}px`}
                  min={0}
                  max={4}
                  step={0.5}
                  value={settings.letterSpacing}
                  onChange={(v) => onUpdateSettings({ letterSpacing: v })}
                />
                <SliderRow
                  label="段落间距"
                  display={`${settings.paragraphSpacing.toFixed(1)}rem`}
                  min={0.3}
                  max={3}
                  step={0.1}
                  value={settings.paragraphSpacing}
                  onChange={(v) => onUpdateSettings({ paragraphSpacing: v })}
                />
                <SliderRow
                  label="页面宽度"
                  display={`${settings.pageWidth}%`}
                  min={60}
                  max={100}
                  step={5}
                  value={settings.pageWidth}
                  onChange={(v) => onUpdateSettings({ pageWidth: v })}
                  minLabel="窄幅"
                  maxLabel="全宽"
                />
              </div>
            </SheetGroup>
          </section>

          {/* 段落格式 ----------------------------------------- */}
          <section className="space-y-2">
            <SheetSectionLabel>
              段落格式 · <span className="font-normal opacity-70">对齐方式与首行缩进</span>
            </SheetSectionLabel>
            <SheetGroup padded>
              <div className="space-y-4">
                <div role="group" aria-label="文本对齐方式" className="grid grid-cols-2 gap-2">
                  {ALIGN_OPTIONS.map((option) => {
                    const active = settings.textAlign === option.value;
                    return (
                      <button
                        key={option.value}
                        type="button"
                        aria-pressed={active}
                        onClick={() => onUpdateSettings({ textAlign: option.value })}
                        className={pickerChipClass(active, "text-sm px-3 py-2 text-center")}
                      >
                        {option.label}
                      </button>
                    );
                  })}
                </div>

                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <div className="text-sm font-medium">段落首行缩进</div>
                    <div className="text-xs text-[hsl(var(--color-muted-foreground))]">
                      按中文小说排版，每段首行缩进两字
                    </div>
                  </div>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={settings.paragraphIndent}
                    aria-label="段落首行缩进"
                    onClick={() =>
                      onUpdateSettings({ paragraphIndent: !settings.paragraphIndent })
                    }
                    className={cn(
                      "relative inline-flex h-7 w-12 flex-shrink-0 items-center rounded-full transition-colors duration-200 ease-spring focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[hsl(var(--color-ring))]",
                      settings.paragraphIndent
                        ? "bg-[hsl(var(--color-primary))]"
                        : "bg-[hsl(var(--color-foreground)/0.18)]"
                    )}
                  >
                    <span
                      className={cn(
                        "inline-block h-6 w-6 transform rounded-full bg-white shadow-[0_2px_6px_-1px_hsl(0_0%_0%/0.3)] transition-transform duration-200 ease-spring",
                        settings.paragraphIndent ? "translate-x-[22px]" : "translate-x-0.5"
                      )}
                    />
                  </button>
                </div>
              </div>
            </SheetGroup>
          </section>
        </div>
      </CustomScrollArea>
    </SheetShell>
  );
});

interface SliderRowProps {
  label: string;
  display: string;
  min: number;
  max: number;
  step: number;
  value: number;
  onChange: (value: number) => void;
  minLabel?: string;
  maxLabel?: string;
}

/** 浮点步进后修掉 0.30000000000000004 这类误差，否则显示值会抖。 */
function quantize(value: number, step: number) {
  const decimals = (String(step).split(".")[1] ?? "").length;
  return Number(value.toFixed(decimals));
}

const SliderRow = memo(function SliderRow({
  label,
  display,
  min,
  max,
  step,
  value,
  onChange,
  minLabel,
  maxLabel,
}: SliderRowProps) {
  const inputId = useId();

  const commit = useCallback(
    (next: number) => {
      if (!Number.isFinite(next)) return;
      onChange(quantize(Math.min(max, Math.max(min, next)), step));
    },
    [onChange, min, max, step]
  );

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <label htmlFor={inputId} className="text-sm font-medium">
          {label}
        </label>
        {/* 滑杆在手机上很难微调，配一对 44px 的步进按钮兜底。 */}
        <div className="flex items-center gap-1">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            onClick={() => commit(value - step)}
            disabled={value <= min}
            aria-label={`调小${label}`}
          >
            <Minus className="h-4 w-4" />
          </Button>
          <span className="min-w-[3.75rem] text-center text-sm tabular-nums text-[hsl(var(--color-muted-foreground))]">
            {display}
          </span>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            onClick={() => commit(value + step)}
            disabled={value >= max}
            aria-label={`调大${label}`}
          >
            <Plus className="h-4 w-4" />
          </Button>
        </div>
      </div>
      <input
        id={inputId}
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(event) => commit(parseFloat(event.target.value))}
        className="w-full"
        // 全局样式把 range 定死在 24px 高，手指很难压准；用行内样式撑到 44px，
        // 轨道与滑块本身仍由浏览器在元素内垂直居中。
        style={{ height: "2.75rem" }}
        aria-valuetext={display}
      />
      {(minLabel || maxLabel) && (
        <div className="flex justify-between text-xs text-[hsl(var(--color-muted-foreground))]">
          <span>{minLabel}</span>
          <span>{maxLabel}</span>
        </div>
      )}
    </div>
  );
});
