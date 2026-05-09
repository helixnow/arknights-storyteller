import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "@/services/api";
import type { StoryEntry, ParsedStoryContent, StorySegment, Chapter, StoryCategory } from "@/types/story";
import { CustomScrollArea } from "@/components/ui/custom-scroll-area";
import { Button } from "@/components/ui/button";
import { ArrowLeft, ExternalLink, Settings as SettingsIcon, BookOpen } from "lucide-react";
import { useClueSets } from "@/hooks/useClueSets";
import { digestToHex64, fnv1a64, normalizeForDigest } from "@/lib/clueCodecs";
import { cn } from "@/lib/utils";
import { useReaderSettings } from "@/hooks/useReaderSettings";
import { ReaderSettingsPanel } from "@/components/ReaderSettings";
import { useEdgeSwipeBack } from "@/hooks/useEdgeSwipeBack";
import { useBackHandler } from "@/hooks/useBackHandler";

interface ClueSetReaderProps {
  setId: string;
  onClose: () => void;
  onOpenStoryJump: (story: StoryEntry, jump: { segmentIndex: number; digestHex?: string; preview?: string }) => void;
}

interface RenderItem {
  key: string;
  story: StoryEntry;
  segmentIndex: number;
  segment?: StorySegment | null;
  preview?: string;
  digestHex?: string;
  resolvedIndex?: number | null;
}

function processSegments(content: ParsedStoryContent): StorySegment[] {
  const cleaned = content.segments.flatMap<StorySegment>((segment) => {
    if (segment.type === "dialogue" || segment.type === "narration") {
      const normalizedText = segment.text
        .replace(/\r\n/g, "\n")
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
        .join("\n");
      if (!normalizedText) return [];
      if (normalizedText === segment.text) return [segment];
      return [{ ...segment, text: normalizedText }];
    }
    if (segment.type === "decision") {
      const options = segment.options.map((option) => option.trim()).filter(Boolean);
      if (options.length === 0) return [];
      if (options.length === segment.options.length) return [segment];
      return [{ ...segment, options }];
    }
    return [segment];
  });

  const merged: StorySegment[] = [];
  cleaned.forEach((segment) => {
    if (segment.type === "dialogue") {
      const last = merged[merged.length - 1];
      if (last && last.type === "dialogue" && last.characterName === segment.characterName) {
        merged[merged.length - 1] = {
          ...last,
          text: `${last.text}\n${segment.text}`.replace(/\n{2,}/g, "\n"),
        };
        return;
      }
    }
    merged.push(segment);
  });
  return merged;
}

function segmentSearchText(seg: StorySegment): string {
  switch (seg.type) {
    case "dialogue":
      return `${seg.characterName} ${seg.text}`;
    case "narration":
    case "subtitle":
    case "sticker":
      return seg.text;
    case "system":
      return seg.speaker ? `${seg.speaker} ${seg.text}` : seg.text;
    case "decision":
      return seg.options.join(" ");
    default:
      return "";
  }
}

function digestHexFor(seg: StorySegment): string {
  const d = fnv1a64(normalizeForDigest(segmentSearchText(seg)));
  return digestToHex64(d);
}

export function ClueSetReader({ setId, onClose, onOpenStoryJump }: ClueSetReaderProps) {
  const { sets } = useClueSets();
  const set = sets[setId];
  // Local maps were previously stored but not used outside initialization; remove to satisfy TS strict rules
  const [items, setItems] = useState<RenderItem[]>([]);
  const anchorRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const { settings, updateSettings, resetSettings } = useReaderSettings();
  const [progressValue, setProgressValue] = useState(0);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);

  useBackHandler(settingsOpen, () => {
    setSettingsOpen(false);
    return true;
  });
  useEdgeSwipeBack(rootRef, { enabled: !settingsOpen, onBack: onClose });
  const [chapterMap, setChapterMap] = useState<Record<string, string>>({}); // chapterId -> chapterName
  const [chapterNameByStoryId, setChapterNameByStoryId] = useState<Record<string, string>>({}); // storyId -> chapterName
  const [chapterNameByStoryGroup, setChapterNameByStoryGroup] = useState<Record<string, string>>({}); // storyGroup -> chapterName

  useEffect(() => {
    let cancelled = false;
    (async () => {
      // preload chapter names for mapping storyGroup -> chapterName
      try {
        const chapters = await api.getChapters();
        if (!cancelled && Array.isArray(chapters)) {
          const map: Record<string, string> = {};
          (chapters as Chapter[]).forEach((c) => {
            map[c.chapterId] = c.chapterName || c.chapterName2 || c.chapterId;
          });
          setChapterMap(map);
        }
      } catch {}

      // fallback mapping: from storyId -> chapter category name (更稳健)
      try {
        const categories = await api.getStoryCategories();
        if (!cancelled && Array.isArray(categories)) {
          const m: Record<string, string> = {};
          (categories as StoryCategory[])
            .filter((cat) => cat.type === 'chapter')
            .forEach((cat) => {
              for (const s of cat.stories || []) {
                m[s.storyId] = cat.name;
              }
            });
          setChapterNameByStoryId(m);
        }
      } catch {}

      // additional mapping: storyGroup -> 主线章节名称（例如 main_16 -> 反常光谱）
      try {
        const mainGrouped = await api.getMainStoriesGrouped();
        if (!cancelled && Array.isArray(mainGrouped)) {
          const m: Record<string, string> = {};
          (mainGrouped as Array<[string, StoryEntry[]]>).forEach(([chapterName, stories]) => {
            stories.forEach((s) => {
              if (s.storyGroup) m[s.storyGroup] = chapterName;
            });
          });
          setChapterNameByStoryGroup(m);
        }
      } catch {}

      if (!set || set.items.length === 0) return;
      const storyIds = Array.from(new Set(set.items.map((it) => it.storyId)));
      const entries: Record<string, StoryEntry> = {};
      for (const sid of storyIds) {
        try {
          const entry = await api.getStoryEntry(sid);
          entries[sid] = entry;
        } catch {
          // ignore
        }
      }
      if (cancelled) return;
      const segs: Record<string, StorySegment[]> = {};
      for (const sid of storyIds) {
        const entry = entries[sid];
        if (!entry) continue;
        try {
          const content = await api.getStoryContent(entry.storyTxt);
          segs[sid] = processSegments(content);
        } catch {
          segs[sid] = [];
        }
      }
      if (cancelled) return;
      const renderItems: RenderItem[] = set.items.map((it, index) => {
        const story = entries[it.storyId];
        const arr = segs[it.storyId] ?? [];
        let seg: StorySegment | null | undefined = arr[it.segmentIndex];
        let resolvedIndex: number | null = it.segmentIndex;
        // 若索引不准，使用摘要或预览回退
        const hex = (it.digestHex || '').toLowerCase();
        if (!seg || (hex && hex !== '0000000000000000' && digestHexFor(seg).toLowerCase() !== hex)) {
          // 邻域 ±12 查找
          const want = hex && hex !== '0000000000000000' ? hex : '';
          const range = 12;
          let found: number | null = null;
          if (want && arr.length > 0) {
            const start = Math.max(0, it.segmentIndex - range);
            const end = Math.min(arr.length - 1, it.segmentIndex + range);
            for (let i = start; i <= end; i++) {
              if (digestHexFor(arr[i]).toLowerCase() === want) { found = i; break; }
            }
          }
          if (found !== null) {
            seg = arr[found];
            resolvedIndex = found;
          } else if (it.preview) {
            const normPrev = it.preview.replace(/…/g, ' ').replace(/\.{3}/g, ' ').trim().toLowerCase();
            for (let i = 0; i < arr.length; i++) {
              const t = segmentSearchText(arr[i]).replace(/\s+/g, ' ').toLowerCase();
              if (t.includes(normPrev)) { seg = arr[i]; resolvedIndex = i; break; }
            }
          }
        }
        return {
          key: `${it.storyId}-${index}`,
          story: story as any,
          segmentIndex: it.segmentIndex,
          segment: seg ?? null,
          preview: it.preview,
          digestHex: it.digestHex,
          resolvedIndex,
        };
      });
      setItems(renderItems);
    })();
    return () => { cancelled = true; };
  }, [set?.updatedAt, setId]);

  // Helper no longer needed; removed to satisfy noUnusedLocals

  // 分组：保持“第一次出现”的关卡顺序，组内维持线索集原有顺序
  const groups = useMemo(() => {
    const order: string[] = [];
    const map = new Map<string, { story?: StoryEntry; items: RenderItem[] }>();
    for (const it of items) {
      const sid = it.story?.storyId || ('' + (it as any).storyId) || 'unknown';
      if (!map.has(sid)) {
        map.set(sid, { story: it.story, items: [] });
        order.push(sid);
      }
      map.get(sid)!.items.push(it);
    }
    return order.map((sid) => ({ storyId: sid, story: map.get(sid)!.story, items: map.get(sid)!.items }));
  }, [items]);

  // progress for scroll mode
  const scrollViewportRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = scrollViewportRef.current;
    if (!el) return;
    let frame = 0;
    const onScroll = () => {
      if (frame) cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const { scrollTop, scrollHeight, clientHeight } = el;
        const denom = scrollHeight - clientHeight;
        const ratio = denom <= 0 ? 1 : scrollTop / denom;
        const clamped = Number.isFinite(ratio) ? Math.max(0, Math.min(1, ratio)) : 0;
        setProgressValue(clamped);
      });
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    onScroll();
    return () => { el.removeEventListener('scroll', onScroll); if (frame) cancelAnimationFrame(frame); };
  }, [items.length]);

  return (
    <div
      ref={rootRef}
      className="h-full flex flex-col overflow-hidden reader-surface"
      data-reader-theme={settings.theme}
    >
      <header className="flex-shrink-0 z-10 bg-[hsl(var(--color-background)/0.95)] backdrop-blur border-b">
        <div className="container flex items-center justify-between gap-2 h-16">
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="icon" onClick={onClose} aria-label="返回线索集">
              <ArrowLeft className="h-5 w-5" />
            </Button>
            <div>
              <div className="text-xs uppercase tracking-widest text-[hsl(var(--color-muted-foreground))]">Clue Reading</div>
              <div className="text-base font-semibold">线索集阅读</div>
            </div>
          </div>
          <div className="text-xs text-[hsl(var(--color-muted-foreground))]">{set?.title ?? ''} · {set?.items.length ?? 0} 条</div>
          <div className="flex items-center gap-1">
            <Button variant="ghost" size="icon" onClick={() => setSettingsOpen(true)} aria-label="阅读设置">
              <SettingsIcon className="h-5 w-5" />
            </Button>
          </div>
        </div>
        <div className="progress-track">
          <div className="progress-thumb" style={{ width: `${Math.round(progressValue * 1000) / 10}%` }} aria-hidden="true" />
        </div>
      </header>

      <main className="flex-1 overflow-hidden">
          <CustomScrollArea className="h-full" viewportClassName="reader-scroll" viewportRef={scrollViewportRef as any}
          trackOffsetTop="calc(4rem + 10px)" trackOffsetBottom="calc(4.5rem + env(safe-area-inset-bottom, 0px))">
          <div className="container py-6 pb-24">
            {(!set || set.items.length === 0) && (
              <div className="text-center text-[hsl(var(--color-muted-foreground))]">该线索集暂无条目</div>
            )}
            <div
              className="reader-content"
              style={{
                fontFamily: settings.fontFamily === 'system' ? undefined : settings.fontFamily,
                fontSize: `${settings.fontSize}px`,
                lineHeight: settings.lineHeight,
                letterSpacing: `${settings.letterSpacing}px`,
                textAlign: settings.textAlign,
                // Use CSS var so the stylesheet's max-width fallback kicks in.
                // (Removes the double max-width clamp from the old code.)
                ["--reader-max-width" as unknown as string]: `${Math.round(
                  (settings.pageWidth / 100) * 768
                )}px`,
                width: "100%",
                // Apply paragraph spacing as a CSS var the children pick up via
                // their own marginBottom — keeps parity with StoryReader.
                ["--reader-paragraph-spacing" as unknown as string]: `${Math.max(
                  settings.paragraphSpacing,
                  0.5
                )}rem`,
                ...(settings.paragraphIndent ? { textIndent: "2em" } : {}),
              } as React.CSSProperties}
            >
              {groups.map((group) => {
                // 按原文顺序渲染：优先用 resolvedIndex，否则用 segmentIndex
                const sortedItems = [...group.items].sort((a, b) => {
                  const ai = (a.resolvedIndex ?? a.segmentIndex) ?? 0;
                  const bi = (b.resolvedIndex ?? b.segmentIndex) ?? 0;
                  return ai - bi;
                });
                const firstResolved = (() => {
                  let v: number | null = null;
                  for (const x of sortedItems) {
                    const idx = x.resolvedIndex ?? x.segmentIndex;
                    if (typeof idx === 'number') { v = idx; break; }
                  }
                  return v ?? 0;
                })();
                const story = group.story;
                const chapterLabel = story
                  ? (chapterNameByStoryGroup[story.storyGroup] ?? chapterNameByStoryId[story.storyId] ?? (story.storyGroup ? (chapterMap[story.storyGroup] ?? story.storyGroup) : ""))
                  : "";
                return (
                  <div key={group.storyId} className="mb-8">
                    <div className="mb-3">
                      {/* 采用三列自适应栅格，确保中间标题真正居中 */}
                      <div className="grid items-center" style={{ gridTemplateColumns: '1fr auto 1fr' }}>
                        <div />
                        <div className="reader-header text-center">{story?.storyName ?? group.storyId}</div>
                        <div className="flex items-center justify-end gap-2">
                          {story?.avgTag && (
                            <span className="text-xs text-[hsl(var(--color-muted-foreground))]">{story.avgTag}</span>
                          )}
                          {story && (
                            <Button
                              variant="ghost"
                              size="icon"
                              aria-label="打开整章"
                              title="打开整章"
                              onClick={() => onOpenStoryJump(story, { segmentIndex: firstResolved })}
                            >
                              <BookOpen className="h-4 w-4" />
                            </Button>
                          )}
                        </div>
                      </div>
                      <div className="grid items-center mt-1 text-xs text-[hsl(var(--color-muted-foreground))]" style={{ gridTemplateColumns: '1fr auto 1fr' }}>
                        <div />
                        <div className="flex items-center gap-3 justify-center">
                          {story?.storyCode && <span>{story.storyCode}</span>}
                          {chapterLabel && <span>{chapterLabel}</span>}
                        </div>
                        <div className="text-right">{group.items.length} 条</div>
                      </div>
                    </div>
                    {sortedItems.map((it, idxInGroup) => {
                      const prev = idxInGroup > 0 ? sortedItems[idxInGroup - 1] : null;
                      const prevIdx = prev?.resolvedIndex ?? prev?.segmentIndex ?? null;
                      const currIdx = it.resolvedIndex ?? it.segmentIndex;
                      const discontinuous = !!prev && (prevIdx === null || currIdx === null || currIdx !== prevIdx + 1);
                      return (
                        <div key={it.key} ref={(el) => { anchorRefs.current[it.key] = el; }}>
                          {discontinuous && (
                            <div className="reader-ellipsis">…</div>
                          )}
                          {!it.segment ? (
                            <div className="text-xs text-[hsl(var(--color-muted-foreground))] mb-4">未能定位该段，建议打开原文查看</div>
                          ) : (
                            (() => {
                              const segment = it.segment;
                              if (!segment) return null;

                              const renderTextLines = (text: string) =>
                                text.split("\n").map((line, idx, arr) => (
                                  <span key={idx}>
                                    {line}
                                    {idx < arr.length - 1 ? <br /> : null}
                                  </span>
                                ));

                              return (
                                <div
                                  className={cn(
                                    "mb-4",
                                    segment.type === "dialogue" && "reader-paragraph reader-dialogue reader-segment",
                                    segment.type === "narration" && "reader-narration reader-segment",
                                    segment.type === "system" && "reader-system reader-segment",
                                    segment.type === "subtitle" && "reader-subtitle reader-segment",
                                    segment.type === "sticker" && "reader-sticker reader-segment",
                                    segment.type === "decision" && "reader-decision reader-segment",
                                    segment.type === "header" && "reader-header"
                                  )}
                                >
                                  {segment.type === "dialogue" ? (
                                    <>
                                      <div className="reader-character-name">{segment.characterName}</div>
                                      <div className="reader-text">{renderTextLines(segment.text)}</div>
                                    </>
                                  ) : null}

                                  {(segment.type === "narration" || segment.type === "system" || segment.type === "subtitle" || segment.type === "sticker") ? (
                                    <div className="reader-text">{renderTextLines(segment.text)}</div>
                                  ) : null}

                                  {segment.type === "decision" ? (
                                    <div className="reader-decision">
                                      <div className="reader-decision-title">选择：</div>
                                      {segment.options.map((option, optionIndex) => (
                                        <div key={optionIndex} className="reader-decision-option">
                                          <span className="reader-decision-bullet">{optionIndex + 1}</span>
                                          <span>{option}</span>
                                        </div>
                                      ))}
                                    </div>
                                  ) : null}

                                  {segment.type === "header" ? (
                                    <div className="reader-header">{segment.title}</div>
                                  ) : null}
                                </div>
                              );
                            })()
                          )}
                          {it.story && (
                            <div className="-mt-2 mb-6 text-right">
                              <Button
                                variant="ghost"
                                size="icon"
                                aria-label="原文"
                                title="原文"
                                onClick={() => onOpenStoryJump(it.story!, { segmentIndex: it.resolvedIndex ?? it.segmentIndex, digestHex: it.digestHex, preview: it.preview })}
                              >
                                <ExternalLink className="h-4 w-4" />
                              </Button>
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                );
              })}
            </div>
          </div>
        </CustomScrollArea>
      </main>
      <ReaderSettingsPanel open={settingsOpen} settings={settings} onClose={() => setSettingsOpen(false)} onUpdateSettings={updateSettings} onReset={resetSettings} />
    </div>
  );
}
