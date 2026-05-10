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
import { RotateCcw, X } from "lucide-react";
import { cn } from "@/lib/utils";

const READING_MODES: Array<{ value: Settings["readingMode"]; label: string; description: string }> =
  [
    { value: "scroll", label: "连续滚动", description: "纵向滚动阅读，接近小说体验" },
    { value: "paged", label: "章节分页", description: "按页分段，便于快速定位" },
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
    "glass glass-pane text-left transition-[background-color,color,box-shadow,transform] duration-200 ease-spring",
    "active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[hsl(var(--color-ring))]",
    active
      ? "glass-thick ring-1 ring-[hsl(var(--color-primary)/0.45)] text-[hsl(var(--color-foreground))]"
      : "glass-thin text-[hsl(var(--color-muted-foreground))] hover:text-[hsl(var(--color-foreground))]",
    extra
  );
}

export function ReaderSettingsPanel({
  open,
  settings,
  onClose,
  onUpdateSettings,
  onReset,
}: ReaderSettingsProps) {
  const { rendered, state } = useSidePanel({ open, onClose });
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
              onClick={onReset}
              aria-label="恢复默认"
              title="恢复默认"
            >
              <RotateCcw className="h-4 w-4" />
            </Button>
            <Button
              variant="ghost"
              size="icon-pill"
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
        <div className="px-4 pt-3 pb-8 space-y-5">
          {/* 阅读模式 ----------------------------------------- */}
          <section className="space-y-2">
            <SheetSectionLabel>
              阅读模式 · <span className="font-normal opacity-70">选择适合你场景的阅读方式</span>
            </SheetSectionLabel>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
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
            <div className="grid grid-cols-5 gap-2">
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
                  <label className="text-sm font-medium text-[hsl(var(--color-foreground))]">
                    字体
                  </label>
                  <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
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
                <div className="grid grid-cols-2 gap-2">
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
}

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

function SliderRow({
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
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <label className="text-sm font-medium">{label}</label>
        <span className="text-sm tabular-nums text-[hsl(var(--color-muted-foreground))]">
          {display}
        </span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(parseFloat(e.target.value))}
        className="w-full"
        aria-label={label}
      />
      {(minLabel || maxLabel) && (
        <div className="flex justify-between text-xs text-[hsl(var(--color-muted-foreground))]">
          <span>{minLabel}</span>
          <span>{maxLabel}</span>
        </div>
      )}
    </div>
  );
}
