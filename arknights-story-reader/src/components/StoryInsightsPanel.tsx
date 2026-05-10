import { Button } from "@/components/ui/button";
import { CustomScrollArea } from "@/components/ui/custom-scroll-area";
import {
  SheetShell,
  SheetHeader,
  SheetGroup,
  SheetSectionLabel,
} from "@/components/ui/sheet-shell";
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
 * Visuals follow the Liquid Glass playbook:
 *   - Sheet body uses `.glass-thick` via `SheetShell`
 *   - Each insight group is an inset-grouped list (`.glass-list`) so rows
 *     stack without their own borders — hairline dividers only.
 *   - Row press highlight uses primary-tinted glass, not a hard ring.
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
    <SheetShell state={state} onClose={onClose} ariaLabel="剧情导览">
      <SheetHeader
        title="剧情导览"
        description="快速跳转章节、角色与抉择节点"
        actions={
          <Button
            variant="ghost"
            size="icon-pill"
            onClick={onClose}
            aria-label="关闭"
            title="关闭"
          >
            <X className="h-5 w-5" />
          </Button>
        }
      />

      <CustomScrollArea className="flex-1 min-h-0" viewportClassName="reader-scroll">
        <div className="px-4 pt-3 pb-8 space-y-5">
          {insights.headers.length > 0 && (
            <section className="space-y-2">
              <SheetSectionLabel>
                章节目录 · <span className="font-normal opacity-70">共 {insights.headers.length} 节</span>
              </SheetSectionLabel>
              <SheetGroup padded={false}>
                <div className="glass-list">
                  {insights.headers.map((h) => (
                    <button
                      key={`toc-${h.index}`}
                      type="button"
                      className={cn(
                        "w-full px-4 py-3 text-left text-sm transition-colors duration-150",
                        "hover:bg-[hsl(var(--color-foreground)/0.04)] active:bg-[hsl(var(--color-foreground)/0.08)]",
                        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[hsl(var(--color-ring))]"
                      )}
                      onClick={() => onJumpToSegment(h.index)}
                    >
                      {h.title}
                    </button>
                  ))}
                </div>
              </SheetGroup>
            </section>
          )}

          <section className="space-y-2">
            <SheetSectionLabel>
              <span className="flex items-center justify-between gap-2">
                <span>
                  划线收藏 ·{" "}
                  <span className="font-normal opacity-70">
                    {highlightEntries.length > 0
                      ? `${highlightEntries.length} 条划线`
                      : "在阅读模式下点击书签可收藏段落"}
                  </span>
                </span>
                {highlightEntries.length > 0 && (
                  <button
                    type="button"
                    className="text-[11px] font-medium text-[hsl(var(--color-muted-foreground))] hover:text-[hsl(var(--color-destructive))] transition-colors"
                    onClick={onClearHighlights}
                  >
                    清空
                  </button>
                )}
              </span>
            </SheetSectionLabel>

            {highlightEntries.length === 0 ? (
              <SheetGroup padded>
                <p className="text-sm text-[hsl(var(--color-muted-foreground))]">
                  暂无划线内容
                </p>
              </SheetGroup>
            ) : (
              <SheetGroup padded={false}>
                <div className="glass-list">
                  {highlightEntries.map((entry) => (
                    <div key={entry.index} className="flex items-start gap-1 px-3 py-2.5">
                      <button
                        type="button"
                        className="flex-1 min-w-0 text-left text-sm leading-relaxed px-2 py-1 rounded-md transition-colors hover:text-[hsl(var(--color-primary))] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[hsl(var(--color-ring))]"
                        onClick={() => onJumpToSegment(entry.index)}
                      >
                        {entry.label}
                      </button>
                      <Button
                        variant="ghost"
                        size="icon-pill"
                        className="h-8 w-8 flex-shrink-0 text-[hsl(var(--color-muted-foreground))] hover:text-[hsl(var(--color-destructive))]"
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
              </SheetGroup>
            )}
          </section>

          <section className="space-y-2">
            <SheetSectionLabel>
              <span className="flex items-center justify-between gap-2">
                <span>
                  角色出场 ·{" "}
                  <span className="font-normal opacity-70">
                    {insights.characters.length > 0
                      ? `${insights.characters.length} 位角色`
                      : "暂无角色统计"}
                  </span>
                </span>
                {activeCharacter && (
                  <button
                    type="button"
                    className="text-[11px] font-medium text-[hsl(var(--color-muted-foreground))] hover:text-[hsl(var(--color-destructive))] transition-colors"
                    onClick={onClearCharacter}
                  >
                    清除高亮
                  </button>
                )}
              </span>
            </SheetSectionLabel>

            {insights.characters.length === 0 ? (
              <SheetGroup padded>
                <p className="text-sm text-[hsl(var(--color-muted-foreground))]">
                  暂无角色统计
                </p>
              </SheetGroup>
            ) : (
              <SheetGroup padded={false}>
                <div className="glass-list">
                  {insights.characters.map((character) => {
                    const active = activeCharacter === character.name;
                    return (
                      <button
                        key={character.name}
                        type="button"
                        aria-pressed={active}
                        onClick={() =>
                          onCharacterSelect(character.name, character.firstIndex)
                        }
                        className={cn(
                          "w-full flex items-center justify-between px-4 py-3 text-left transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[hsl(var(--color-ring))]",
                          active
                            ? "bg-[hsl(var(--color-primary)/0.12)] text-[hsl(var(--color-primary))]"
                            : "hover:bg-[hsl(var(--color-foreground)/0.04)] active:bg-[hsl(var(--color-foreground)/0.08)]"
                        )}
                      >
                        <div className="font-medium truncate pr-2 text-sm">
                          {character.name}
                        </div>
                        <div className="text-xs tabular-nums text-[hsl(var(--color-muted-foreground))] flex-shrink-0">
                          {character.count} 次
                        </div>
                      </button>
                    );
                  })}
                </div>
              </SheetGroup>
            )}
          </section>

          <section className="space-y-2">
            <SheetSectionLabel>
              抉择片段 ·{" "}
              <span className="font-normal opacity-70">
                {insights.decisions.length > 0
                  ? `${insights.decisions.length} 个抉择点`
                  : "尚未出现抉择"}
              </span>
            </SheetSectionLabel>

            {insights.decisions.length === 0 ? (
              <SheetGroup padded>
                <p className="text-sm text-[hsl(var(--color-muted-foreground))]">
                  尚未出现抉择
                </p>
              </SheetGroup>
            ) : (
              <div className="space-y-2">
                {insights.decisions.map((decision, idx) => (
                  <SheetGroup key={`${decision.index}-${idx}`} padded>
                    <div className="flex items-center justify-between mb-2">
                      <span className="text-sm font-semibold">抉择 {idx + 1}</span>
                      <Button
                        variant="glass"
                        size="sm"
                        className="h-7 px-3 rounded-full text-xs"
                        onClick={() => onJumpToSegment(decision.index)}
                      >
                        前往
                      </Button>
                    </div>
                    <div className="space-y-1 text-sm text-[hsl(var(--color-muted-foreground))]">
                      {decision.options.map((option, optionIndex) => (
                        <div key={optionIndex} className="flex gap-2 leading-relaxed">
                          <span className="text-[hsl(var(--color-primary))] tabular-nums font-medium">
                            {optionIndex + 1}.
                          </span>
                          <span className="flex-1">{option}</span>
                        </div>
                      ))}
                    </div>
                  </SheetGroup>
                ))}
              </div>
            )}
          </section>
        </div>
      </CustomScrollArea>
    </SheetShell>
  );
}
