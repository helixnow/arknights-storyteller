import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { CustomScrollArea } from "@/components/ui/custom-scroll-area";
import { useSidePanel } from "@/hooks/useSidePanel";
import { cn } from "@/lib/utils";
import { Trash2, X } from "lucide-react";

export interface StoryInsightsPanelProps {
  open: boolean;
  insights: {
    characters: Array<{ name: string; count: number; firstIndex: number }>;
    decisions: Array<{ index: number; options: string[]; values?: string[] }>;
    headers: Array<{ index: number; title: string }>;
  };
  highlightEntries: Array<{ index: number; label: string }>;
  activeCharacter: string | null;
  onClose: () => void;
  onJumpToSegment: (index: number) => void;
  onClearHighlights: () => void;
  onRemoveHighlight: (index: number) => void;
  onCharacterSelect: (name: string, firstIndex: number) => void;
  onClearCharacter: () => void;
}

/**
 * Right-hand side drawer that surfaces per-story insights (table of
 * contents, saved highlights, character appearances, decision summary).
 * Shares the `useSidePanel` animation/back/esc plumbing with
 * `ReaderSettingsPanel` and `ShareImageDialog` so the three panels behave
 * consistently.
 *
 * Rendered outside of the main reader column so the reader can keep its
 * scroll state / edge-swipe gestures intact even while this panel is open.
 */
export function StoryInsightsPanel({
  open,
  insights,
  highlightEntries,
  activeCharacter,
  onClose,
  onJumpToSegment,
  onClearHighlights,
  onRemoveHighlight,
  onCharacterSelect,
  onClearCharacter,
}: StoryInsightsPanelProps) {
  const { rendered, state } = useSidePanel({ open, onClose });
  if (!rendered) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex"
      role="dialog"
      aria-modal="true"
      aria-label="剧情导览"
    >
      <div
        data-state={state}
        className="absolute inset-0 bg-black/40 transition-opacity duration-200 data-[state=closed]:opacity-0 data-[state=open]:opacity-100"
        onClick={onClose}
      />
      <div
        data-state={state}
        className="relative ml-auto h-full w-full max-w-md transform transition-transform duration-200 ease-out data-[state=closed]:translate-x-full data-[state=open]:translate-x-0"
      >
        <div className="h-full flex flex-col bg-[hsl(var(--color-background))] shadow-2xl border-l border-[hsl(var(--color-border))]">
          <header className="flex-shrink-0 flex items-center justify-between gap-3 px-4 py-3 border-b border-[hsl(var(--color-border))] bg-[hsl(var(--color-background))]">
            <div className="min-w-0">
              <h2 className="text-base font-semibold">剧情导览</h2>
              <p className="text-xs text-[hsl(var(--color-muted-foreground))]">
                快速跳转章节、角色与抉择节点
              </p>
            </div>
            <Button variant="ghost" size="icon" onClick={onClose} aria-label="关闭" title="关闭">
              <X className="h-5 w-5" />
            </Button>
          </header>

          <CustomScrollArea className="flex-1 min-h-0" viewportClassName="reader-scroll">
            <div className="p-4 pb-8 space-y-4">
              {insights.headers.length > 0 && (
                <Card>
                  <CardHeader>
                    <CardTitle className="text-base">章节目录</CardTitle>
                    <CardDescription>共 {insights.headers.length} 节</CardDescription>
                  </CardHeader>
                  <CardContent>
                    <div className="space-y-1">
                      {insights.headers.map((h) => (
                        <button
                          key={`toc-${h.index}`}
                          type="button"
                          className="w-full rounded-lg border border-transparent px-3 py-2 text-left text-sm transition-colors hover:border-[hsl(var(--color-border))] hover:bg-[hsl(var(--color-accent))] active:scale-[0.99] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[hsl(var(--color-ring))] focus-visible:ring-offset-2 focus-visible:ring-offset-[hsl(var(--color-card))]"
                          onClick={() => onJumpToSegment(h.index)}
                        >
                          {h.title}
                        </button>
                      ))}
                    </div>
                  </CardContent>
                </Card>
              )}

              <Card>
                <CardHeader className="flex flex-row items-start justify-between gap-3 space-y-0">
                  <div>
                    <CardTitle className="text-base">划线收藏</CardTitle>
                    <CardDescription>
                      {highlightEntries.length > 0 ? `${highlightEntries.length} 条划线` : "在阅读模式下点击书签可收藏段落"}
                    </CardDescription>
                  </div>
                  {highlightEntries.length > 0 && (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="text-xs h-auto px-2 py-1 text-[hsl(var(--color-muted-foreground))] hover:text-[hsl(var(--color-destructive))]"
                      onClick={onClearHighlights}
                    >
                      清空
                    </Button>
                  )}
                </CardHeader>
                <CardContent>
                  {highlightEntries.length === 0 ? (
                    <p className="text-sm text-[hsl(var(--color-muted-foreground))]">
                      暂无划线内容
                    </p>
                  ) : (
                    <div className="space-y-2">
                      {highlightEntries.map((entry) => (
                        <div
                          key={entry.index}
                          className="flex items-start gap-2 rounded-lg border border-[hsl(var(--color-border))] bg-[hsl(var(--color-background))] p-3 transition-colors hover:border-[hsl(var(--color-primary)/0.5)]"
                        >
                          <button
                            type="button"
                            className="flex-1 min-w-0 text-left text-sm leading-relaxed transition-colors hover:text-[hsl(var(--color-primary))]"
                            onClick={() => onJumpToSegment(entry.index)}
                          >
                            {entry.label}
                          </button>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-7 w-7 flex-shrink-0 text-[hsl(var(--color-muted-foreground))] hover:text-[hsl(var(--color-destructive))]"
                            onClick={(event) => {
                              event.preventDefault();
                              event.stopPropagation();
                              onRemoveHighlight(entry.index);
                            }}
                            aria-label="移除划线"
                            title="移除划线"
                          >
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        </div>
                      ))}
                    </div>
                  )}
                </CardContent>
              </Card>

              <Card>
                <CardHeader className="flex flex-row items-start justify-between gap-3 space-y-0">
                  <div>
                    <CardTitle className="text-base">角色出场</CardTitle>
                    <CardDescription>
                      {insights.characters.length > 0
                        ? `${insights.characters.length} 位角色`
                        : "暂无角色统计"}
                    </CardDescription>
                  </div>
                  {activeCharacter && (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="text-xs h-auto px-2 py-1 text-[hsl(var(--color-muted-foreground))] hover:text-[hsl(var(--color-destructive))]"
                      onClick={onClearCharacter}
                    >
                      清除高亮
                    </Button>
                  )}
                </CardHeader>
                <CardContent>
                  {insights.characters.length === 0 ? (
                    <p className="text-sm text-[hsl(var(--color-muted-foreground))]">
                      暂无角色统计
                    </p>
                  ) : (
                    <div className="space-y-2">
                      {insights.characters.map((character) => {
                        const active = activeCharacter === character.name;
                        return (
                          <button
                            key={character.name}
                            type="button"
                            aria-pressed={active}
                            onClick={() => onCharacterSelect(character.name, character.firstIndex)}
                            className={cn(
                              "w-full flex items-center justify-between rounded-lg border px-3 py-2 text-left transition-colors active:scale-[0.99] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[hsl(var(--color-ring))] focus-visible:ring-offset-2 focus-visible:ring-offset-[hsl(var(--color-card))]",
                              active
                                ? "border-[hsl(var(--color-primary))] bg-[hsl(var(--color-accent))] text-[hsl(var(--color-primary))]"
                                : "border-[hsl(var(--color-border))] bg-[hsl(var(--color-background))] hover:border-[hsl(var(--color-primary)/0.5)] hover:bg-[hsl(var(--color-accent))]"
                            )}
                          >
                            <div className="font-medium truncate pr-2">{character.name}</div>
                            <div className="text-xs tabular-nums text-[hsl(var(--color-muted-foreground))] flex-shrink-0">
                              {character.count} 次
                            </div>
                          </button>
                        );
                      })}
                    </div>
                  )}
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle className="text-base">抉择片段</CardTitle>
                  <CardDescription>
                    {insights.decisions.length > 0 ? `${insights.decisions.length} 个抉择点` : "尚未出现抉择"}
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  {insights.decisions.length === 0 ? (
                    <p className="text-sm text-[hsl(var(--color-muted-foreground))]">
                      尚未出现抉择
                    </p>
                  ) : (
                    <div className="space-y-3">
                      {insights.decisions.map((decision, idx) => (
                        <div
                          key={`${decision.index}-${idx}`}
                          className="rounded-lg border border-[hsl(var(--color-border))] bg-[hsl(var(--color-background))] p-3 transition-colors hover:border-[hsl(var(--color-primary)/0.5)]"
                        >
                          <div className="flex items-center justify-between mb-2">
                            <span className="text-sm font-medium">抉择 {idx + 1}</span>
                            <Button
                              variant="ghost"
                              size="sm"
                              className="text-xs h-auto px-2 py-1"
                              onClick={() => onJumpToSegment(decision.index)}
                            >
                              前往
                            </Button>
                          </div>
                          <div className="space-y-1 text-xs text-[hsl(var(--color-muted-foreground))]">
                            {decision.options.map((option, optionIndex) => (
                              <div key={optionIndex} className="flex gap-2">
                                <span className="text-[hsl(var(--color-primary))] tabular-nums">
                                  {optionIndex + 1}.
                                </span>
                                <span className="flex-1">{option}</span>
                              </div>
                            ))}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </CardContent>
              </Card>
            </div>
          </CustomScrollArea>
        </div>
      </div>
    </div>
  );
}
