import { useMemo } from "react";
import { Button } from "@/components/ui/button";
import { CustomScrollArea } from "@/components/ui/custom-scroll-area";
import {
  SheetShell,
  SheetHeader,
  SheetGroup,
  SheetSectionLabel,
} from "@/components/ui/sheet-shell";
import { CharacterAvatar } from "@/components/CharacterAvatar";
import { useSidePanel } from "@/hooks/useSidePanel";
import { safeConfirm } from "@/hooks/useAppUpdater";
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
 *
 * 抽屉挂在阅读器里，阅读器每滚一段就会重渲染一次。`insights` 本身由阅读器
 * 缓存（只在段落变化时重算），这里再把派生数字和三段列表各自 memo 起来，
 * 抽屉关着的时候父组件的高频渲染就不会顺带重建几百个节点。
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
  const { headers, characters, decisions } = insights;

  /** 总发言量与最高发言数：占比条和小标题都要用，一次遍历算完。 */
  const characterStats = useMemo(() => {
    let totalLines = 0;
    let topCount = 0;
    characters.forEach((character) => {
      totalLines += character.count;
      if (character.count > topCount) topCount = character.count;
    });
    return { totalLines, topCount };
  }, [characters]);

  const tocRows = useMemo(
    () =>
      headers.map((h) => (
        <button
          key={`toc-${h.index}`}
          type="button"
          className={cn(
            "w-full min-h-[44px] px-4 py-3 text-left text-sm transition-colors duration-150",
            "hover:bg-[hsl(var(--color-foreground)/0.04)] active:bg-[hsl(var(--color-foreground)/0.08)]",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[hsl(var(--color-ring))]"
          )}
          onClick={() => onJumpToSegment(h.index)}
        >
          {h.title}
        </button>
      )),
    [headers, onJumpToSegment]
  );

  const highlightRows = useMemo(
    () =>
      highlightEntries.map((entry) => (
        <div key={entry.index} className="flex items-start gap-1 px-3 py-2.5">
          <button
            type="button"
            className="flex-1 min-w-0 min-h-[44px] text-left text-sm leading-relaxed px-2 py-2 rounded-md transition-colors hover:text-[hsl(var(--color-primary))] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[hsl(var(--color-ring))]"
            onClick={() => onJumpToSegment(entry.index)}
          >
            {entry.label}
          </button>
          <Button
            variant="ghost"
            size="icon-pill"
            className="h-11 w-11 flex-shrink-0 text-[hsl(var(--color-muted-foreground))] hover:text-[hsl(var(--color-destructive))]"
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
      )),
    [highlightEntries, onJumpToSegment, onRemoveHighlight]
  );

  const characterRows = useMemo(
    () =>
      characters.map((character) => {
        const isActive = activeCharacter === character.name;
        // 相对话最多的那位取百分比：一眼能看出谁是这篇的主角。
        const share =
          characterStats.topCount > 0
            ? Math.max(3, Math.round((character.count / characterStats.topCount) * 100))
            : 0;
        return (
          <button
            key={character.name}
            type="button"
            aria-pressed={isActive}
            onClick={() => onCharacterSelect(character.name, character.firstIndex)}
            className={cn(
              "relative flex w-full min-h-[44px] overflow-hidden text-left transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[hsl(var(--color-ring))]",
              isActive
                ? "bg-[hsl(var(--color-primary)/0.12)] text-[hsl(var(--color-primary))]"
                : "hover:bg-[hsl(var(--color-foreground)/0.04)] active:bg-[hsl(var(--color-foreground)/0.08)]"
            )}
          >
            <span
              aria-hidden="true"
              className={cn(
                "absolute inset-y-0 left-0 pointer-events-none",
                isActive
                  ? "bg-[hsl(var(--color-primary)/0.16)]"
                  : "bg-[hsl(var(--color-primary)/0.07)]"
              )}
              style={{ width: `${share}%` }}
            />
            <span className="relative flex flex-1 items-center gap-3 px-4 py-2.5">
              <CharacterAvatar name={character.name} size={28} />
              <span className="flex-1 min-w-0 font-medium truncate text-sm">
                {character.name}
              </span>
              <span className="text-xs tabular-nums text-[hsl(var(--color-muted-foreground))] flex-shrink-0">
                {character.count} 次
              </span>
            </span>
          </button>
        );
      }),
    [activeCharacter, characterStats.topCount, characters, onCharacterSelect]
  );

  const decisionCards = useMemo(
    () =>
      decisions.map((decision, idx) => (
        <SheetGroup key={`${decision.index}-${idx}`} padded>
          <div className="flex items-center justify-between mb-2">
            <span className="text-sm font-semibold">抉择 {idx + 1}</span>
            <Button
              variant="glass"
              size="sm"
              className="min-h-[44px] px-4 rounded-full text-xs"
              onClick={() => onJumpToSegment(decision.index)}
            >
              前往
            </Button>
          </div>
          <div className="space-y-1 text-sm text-[hsl(var(--color-muted-foreground))]">
            {decision.options.map((option, optionIndex) => {
              const value = decision.values?.[optionIndex]?.trim();
              return (
                <div key={optionIndex} className="flex items-start gap-2 leading-relaxed">
                  <span className="text-[hsl(var(--color-primary))] tabular-nums font-medium">
                    {optionIndex + 1}.
                  </span>
                  <span className="min-w-0 flex-1">{option}</span>
                  {value ? (
                    <span className="max-w-[40%] flex-shrink-0 truncate text-[11px] uppercase tracking-wider opacity-75">
                      {value}
                    </span>
                  ) : null}
                </div>
              );
            })}
          </div>
        </SheetGroup>
      )),
    [decisions, onJumpToSegment]
  );

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
            className="h-11 w-11"
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
          {headers.length > 0 && (
            <section className="space-y-2">
              <SheetSectionLabel>
                章节目录 · <span className="font-normal opacity-70">共 {headers.length} 节</span>
              </SheetSectionLabel>
              {/* 无内边距的列表组必须自己裁剪：行的 hover/按压底色、角色行的
                  占比条都是方角且贴边绘制，不裁的话首末行的四个角会溢出
                  `glass-pane` 的 22px 圆角，压到容器边框外面。 */}
              <SheetGroup padded={false} className="overflow-hidden">
                <div className="glass-list">{tocRows}</div>
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
                      : "点击段落右上角书签即可收藏"}
                  </span>
                </span>
                {highlightEntries.length > 0 && (
                  <button
                    type="button"
                    className="-my-2 inline-flex min-h-[44px] min-w-[44px] items-center justify-center px-2 text-[11px] font-medium text-[hsl(var(--color-muted-foreground))] hover:text-[hsl(var(--color-destructive))] transition-colors"
                    onClick={() => {
                      void (async () => {
                        const ok = await safeConfirm(
                          `确定要清空这篇剧情的 ${highlightEntries.length} 条划线吗？此操作无法撤销。`,
                          { title: "清空划线", kind: "warning" }
                        );
                        if (ok) onClearHighlights();
                      })();
                    }}
                  >
                    清空
                  </button>
                )}
              </span>
            </SheetSectionLabel>

            {highlightEntries.length === 0 ? (
              <SheetGroup padded>
                <p className="text-sm leading-relaxed text-[hsl(var(--color-muted-foreground))]">
                  还没有划线。阅读时点一下段落右上角的书签，就能把这一句收进这里。
                </p>
              </SheetGroup>
            ) : (
              <SheetGroup padded={false} className="overflow-hidden">
                <div className="glass-list">{highlightRows}</div>
              </SheetGroup>
            )}
          </section>

          <section className="space-y-2">
            <SheetSectionLabel>
              <span className="flex items-center justify-between gap-2">
                <span>
                  角色出场 ·{" "}
                  <span className="font-normal opacity-70">
                    {characters.length > 0
                      ? `${characters.length} 位角色 · ${characterStats.totalLines} 句对话`
                      : "暂无角色统计"}
                  </span>
                </span>
                {activeCharacter && (
                  <button
                    type="button"
                    className="-my-2 inline-flex min-h-[44px] min-w-[44px] items-center justify-center px-2 text-[11px] font-medium text-[hsl(var(--color-muted-foreground))] hover:text-[hsl(var(--color-destructive))] transition-colors"
                    onClick={onClearCharacter}
                  >
                    清除高亮
                  </button>
                )}
              </span>
            </SheetSectionLabel>

            {characters.length === 0 ? (
              <SheetGroup padded>
                <p className="text-sm text-[hsl(var(--color-muted-foreground))]">
                  暂无角色统计
                </p>
              </SheetGroup>
            ) : (
              <SheetGroup padded={false} className="overflow-hidden">
                <div className="glass-list">{characterRows}</div>
              </SheetGroup>
            )}
          </section>

          <section className="space-y-2">
            <SheetSectionLabel>
              抉择片段 ·{" "}
              <span className="font-normal opacity-70">
                {decisions.length > 0 ? `${decisions.length} 个抉择点` : "尚未出现抉择"}
              </span>
            </SheetSectionLabel>

            {decisions.length === 0 ? (
              <SheetGroup padded>
                <p className="text-sm text-[hsl(var(--color-muted-foreground))]">
                  尚未出现抉择
                </p>
              </SheetGroup>
            ) : (
              <div className="space-y-2">{decisionCards}</div>
            )}
          </section>
        </div>
      </CustomScrollArea>
    </SheetShell>
  );
}
