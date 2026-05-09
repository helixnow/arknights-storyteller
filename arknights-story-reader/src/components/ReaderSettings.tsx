import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { CustomScrollArea } from "@/components/ui/custom-scroll-area";
import { FONT_FAMILIES, ReaderSettings as Settings } from "@/hooks/useReaderSettings";
import { RotateCcw, X } from "lucide-react";

const READING_MODES: Array<{ value: Settings["readingMode"]; label: string; description: string }> =
  [
    { value: "scroll", label: "连续滚动", description: "纵向滚动阅读，更接近移动端小说体验" },
    { value: "paged", label: "章节分页", description: "按页分段阅读，便于快速定位" },
  ];

const READER_THEMES: Array<{ value: Settings["theme"]; label: string; swatch: string }> = [
  { value: "default", label: "跟随应用", swatch: "hsl(var(--color-background))" },
  { value: "paper", label: "白纸", swatch: "#fafafa" },
  { value: "sepia", label: "羊皮纸", swatch: "#f5ecd7" },
  { value: "green", label: "护眼绿", swatch: "#d7ebd2" },
  { value: "dark", label: "夜幕", swatch: "#0e1014" },
];

interface ReaderSettingsProps {
  open: boolean;
  settings: Settings;
  onClose: () => void;
  onUpdateSettings: (settings: Partial<Settings>) => void;
  onReset: () => void;
}

export function ReaderSettingsPanel({
  open,
  settings,
  onClose,
  onUpdateSettings,
  onReset,
}: ReaderSettingsProps) {
  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex">
      <div className="absolute inset-0 bg-black/45" onClick={onClose} />
      <div className="ml-auto h-full w-full max-w-sm sm:max-w-md relative motion-safe:animate-in motion-safe:slide-in-from-right-10 motion-safe:duration-300">
        <Card className="relative z-10 h-full rounded-none sm:rounded-l-2xl flex flex-col shadow-2xl border-l border-[hsl(var(--color-border))] bg-[hsl(var(--color-card))] overflow-hidden">
          <CardHeader className="flex flex-row items-start justify-between gap-4 sticky top-0 z-10 bg-[hsl(var(--color-card))] border-b flex-shrink-0 px-5 sm:px-6 py-4">
            <div>
              <div className="text-xs uppercase tracking-widest text-[hsl(var(--color-muted-foreground))]">
                Reader Preferences
              </div>
              <CardTitle className="text-lg font-semibold mt-1">阅读设置</CardTitle>
              <p className="mt-2 text-sm text-[hsl(var(--color-muted-foreground))] leading-relaxed max-w-xs">
                调整排版与布局，找到最舒适的阅读方式。
              </p>
            </div>
            <div className="flex flex-col sm:flex-row gap-2">
              <Button variant="ghost" size="icon" onClick={onReset} aria-label="重置设置">
                <RotateCcw className="h-4 w-4" />
              </Button>
              <Button variant="ghost" size="icon" onClick={onClose} aria-label="关闭阅读设置">
                <X className="h-4 w-4" />
              </Button>
            </div>
          </CardHeader>
          <CardContent className="flex-1 min-h-0 p-0">
            <CustomScrollArea
              className="h-full min-h-0"
              viewportClassName="reader-scroll"
              hideTrackWhenIdle={false}
              trackOffsetTop="4.25rem"
            >
              <div className="space-y-6 px-5 sm:px-8 py-7 pb-12">
                {/* 阅读模式 */}
                <div className="space-y-3">
                  <label className="text-sm font-medium">阅读模式</label>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                    {READING_MODES.map((mode) => (
                      <button
                        key={mode.value}
                        onClick={() => onUpdateSettings({ readingMode: mode.value })}
                        className={`p-3 border rounded-lg text-sm transition-all duration-200 text-left hover:-translate-y-0.5 ${
                          settings.readingMode === mode.value
                            ? "border-[hsl(var(--color-primary))] bg-[hsl(var(--color-accent))]"
                            : "border-[hsl(var(--color-border))]"
                        }`}
                      >
                        <div className="font-medium">{mode.label}</div>
                        <div className="text-xs text-[hsl(var(--color-muted-foreground))] mt-1 leading-relaxed">
                          {mode.description}
                        </div>
                      </button>
                    ))}
                  </div>
                </div>

                {/* 阅读主题（与全局主题色独立，仅作用于阅读器背景/文字） */}
                <div className="space-y-3">
                  <label className="text-sm font-medium">阅读主题</label>
                  <div className="grid grid-cols-5 gap-2">
                    {READER_THEMES.map((t) => {
                      const active = settings.theme === t.value;
                      return (
                        <button
                          key={t.value}
                          type="button"
                          aria-pressed={active}
                          onClick={() => onUpdateSettings({ theme: t.value })}
                          className={`flex flex-col items-center gap-1 rounded-lg border p-2 transition-colors ${
                            active
                              ? "border-[hsl(var(--color-primary))] bg-[hsl(var(--color-accent))]"
                              : "border-[hsl(var(--color-border))]"
                          }`}
                        >
                          <span
                            className="h-6 w-6 rounded-full border border-black/10 shadow-sm"
                            style={{ backgroundColor: t.swatch }}
                          />
                          <span className="text-[11px] text-[hsl(var(--color-muted-foreground))]">
                            {t.label}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                </div>

                {/* 字体选择 */}
                <div className="space-y-2">
                  <label className="text-sm font-medium">字体</label>
                  <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                    {FONT_FAMILIES.map((font) => (
                      <button
                        key={font.value}
                        onClick={() => onUpdateSettings({ fontFamily: font.value })}
                        className={`p-2 border rounded-md text-sm transition-all duration-200 hover:-translate-y-0.5 ${
                          settings.fontFamily === font.value
                            ? "border-[hsl(var(--color-primary))] bg-[hsl(var(--color-accent))]"
                            : "border-[hsl(var(--color-border))]"
                        }`}
                        style={{ fontFamily: font.value === "system" ? undefined : font.value }}
                      >
                        {font.label}
                      </button>
                    ))}
                  </div>
                </div>

                {/* 字号 */}
                <div className="space-y-2">
                  <div className="flex justify-between">
                    <label className="text-sm font-medium">字号</label>
                    <span className="text-sm text-[hsl(var(--color-muted-foreground))]">
                      {settings.fontSize}px
                    </span>
                  </div>
                  <input
                    type="range"
                    min="14"
                    max="32"
                    step="2"
                    value={settings.fontSize}
                    onChange={(e) => onUpdateSettings({ fontSize: parseInt(e.target.value, 10) })}
                    className="w-full"
                  />
                  <div className="flex justify-between text-xs text-[hsl(var(--color-muted-foreground))]">
                    <span>小</span>
                    <span>大</span>
                  </div>
                </div>

                {/* 行距 */}
                <div className="space-y-2">
                  <div className="flex justify-between">
                    <label className="text-sm font-medium">行距</label>
                    <span className="text-sm text-[hsl(var(--color-muted-foreground))]">
                      {settings.lineHeight.toFixed(1)}
                    </span>
                  </div>
                  <input
                    type="range"
                    min="1.4"
                    max="3.4"
                    step="0.1"
                    value={settings.lineHeight}
                    onChange={(e) => onUpdateSettings({ lineHeight: parseFloat(e.target.value) })}
                    className="w-full"
                  />
                </div>

                {/* 字间距 */}
                <div className="space-y-2">
                  <div className="flex justify-between">
                    <label className="text-sm font-medium">字间距</label>
                    <span className="text-sm text-[hsl(var(--color-muted-foreground))]">
                      {settings.letterSpacing.toFixed(1)}px
                    </span>
                  </div>
                  <input
                    type="range"
                    min="0"
                    max="4"
                    step="0.5"
                    value={settings.letterSpacing}
                    onChange={(e) => onUpdateSettings({ letterSpacing: parseFloat(e.target.value) })}
                    className="w-full"
                  />
                </div>

                {/* 段落间距 */}
                <div className="space-y-2">
                  <div className="flex justify-between">
                    <label className="text-sm font-medium">段落间距</label>
                    <span className="text-sm text-[hsl(var(--color-muted-foreground))]">
                      {settings.paragraphSpacing.toFixed(1)}rem
                    </span>
                  </div>
                  <input
                    type="range"
                    min="0.3"
                    max="3"
                    step="0.1"
                    value={settings.paragraphSpacing}
                    onChange={(e) =>
                      onUpdateSettings({ paragraphSpacing: parseFloat(e.target.value) })
                    }
                    className="w-full"
                  />
                </div>

                {/* 页面宽度 */}
                <div className="space-y-2">
                  <div className="flex justify-between">
                    <label className="text-sm font-medium">页面宽度</label>
                    <span className="text-sm text-[hsl(var(--color-muted-foreground))]">
                      {settings.pageWidth}%
                    </span>
                  </div>
                  <input
                    type="range"
                    min="60"
                    max="100"
                    step="5"
                    value={settings.pageWidth}
                    onChange={(e) => onUpdateSettings({ pageWidth: parseInt(e.target.value, 10) })}
                    className="w-full"
                  />
                  <div className="flex justify-between text-xs text-[hsl(var(--color-muted-foreground))]">
                    <span>窄幅</span>
                    <span>全宽</span>
                  </div>
                </div>

                {/* 对齐方式 */}
                <div className="space-y-2">
                  <label className="text-sm font-medium">对齐方式</label>
                  <div className="grid grid-cols-2 gap-2">
                    <button
                      onClick={() => onUpdateSettings({ textAlign: "left" })}
                      className={`p-2 border rounded-md text-sm transition-colors ${
                        settings.textAlign === "left"
                          ? "border-[hsl(var(--color-primary))] bg-[hsl(var(--color-accent))]"
                          : "border-[hsl(var(--color-border))]"
                      }`}
                    >
                      左对齐
                    </button>
                    <button
                      onClick={() => onUpdateSettings({ textAlign: "justify" })}
                      className={`p-2 border rounded-md text-sm transition-colors ${
                        settings.textAlign === "justify"
                          ? "border-[hsl(var(--color-primary))] bg-[hsl(var(--color-accent))]"
                          : "border-[hsl(var(--color-border))]"
                      }`}
                    >
                      两端对齐
                    </button>
                  </div>
                </div>

                {/* 首行缩进 */}
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <div className="text-sm font-medium">段落首行缩进</div>
                    <div className="text-xs text-[hsl(var(--color-muted-foreground))]">
                      按照中文小说排版，每段首行缩进两字
                    </div>
                  </div>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={settings.paragraphIndent}
                    onClick={() => onUpdateSettings({ paragraphIndent: !settings.paragraphIndent })}
                    className={`relative inline-flex h-6 w-11 flex-shrink-0 items-center rounded-full border transition-colors ${
                      settings.paragraphIndent
                        ? "bg-[hsl(var(--color-primary))] border-[hsl(var(--color-primary))]"
                        : "bg-[hsl(var(--color-secondary))] border-[hsl(var(--color-border))]"
                    }`}
                  >
                    <span
                      className={`inline-block h-5 w-5 transform rounded-full bg-[hsl(var(--color-card))] shadow transition-transform ${
                        settings.paragraphIndent ? "translate-x-5" : "translate-x-0.5"
                      }`}
                    />
                  </button>
                </div>
              </div>
            </CustomScrollArea>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
