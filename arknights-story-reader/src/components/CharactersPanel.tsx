import {
  memo,
  useCallback,
  useDeferredValue,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { api } from "@/services/api";
import type { ParsedStoryContent, StoryEntry } from "@/types/story";
import { Button } from "@/components/ui/button";
import { CustomScrollArea } from "@/components/ui/custom-scroll-area";
import { Input } from "@/components/ui/input";
import { Collapsible } from "@/components/ui/collapsible";
import { ArrowLeft, Loader2, Shuffle, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { CharacterAvatar } from "@/components/CharacterAvatar";
import { useCharacterResolver } from "@/hooks/useCharacterResolver";
import { postProcessSegments } from "@/components/StoryReader";
import { BACK_PRIORITY, useBackHandler } from "@/hooks/useBackHandler";

interface CharactersPanelProps {
  active?: boolean;
  onOpenStory: (story: StoryEntry, character: string) => void;
  onOpenStoryJump?: (
    story: StoryEntry,
    jump: { segmentIndex: number; preview?: string },
  ) => void;
}

interface CharacterStatsPerStory {
  story: StoryEntry;
  count: number;
}

interface CharacterAggregate {
  name: string;
  total: number;
  perStory: CharacterStatsPerStory[];
}

interface CharacterQuote {
  text: string;
  /** 收集时的说话人（＝当时的 selected）。跳转匹配要用它锚定正确的段。 */
  speaker: string;
  storyName: string;
  story: StoryEntry;
  segmentIndex: number;
}

type GroupCategory = "main" | "activity" | "memory" | "other";

// 详情页「出场章节」的分类展示顺序：主线 → 活动 → 密录 → 其他。
// groupOrder 只是各分类内部的序号（主线第 0 章和活动第 0 期都叫 0），
// 直接拿它跨分类比较会让主线章节和活动条目按各自序号交错排布，
// 每个角色看到的顺序都不一样。先比分类，再比组内序号。
const CATEGORY_RANK: Record<GroupCategory, number> = {
  main: 0,
  activity: 1,
  memory: 2,
  other: 3,
};

// 统计阶段的剧情读取并发。
const STATS_POOL_SIZE = 6;
// 进度条刷新粒度：每 N 篇才 setState 一次，避免几千次无意义 re-render。
const PROGRESS_STEP = 8;

// ── 金句抓取 ───────────────────────────────────────────────
// 博士/凯尔希这类角色的 perStory 有上千条，绝不能 Promise.all 全量拉。
// 只取发言最多的若干篇（金句密度最高），并且限制并发。
const QUOTE_STORY_LIMIT = 36;
const QUOTE_FETCH_CONCURRENCY = 5;
/** 候选池上限；UI 每次从池里随机抽 5 条。 */
const QUOTE_POOL_SIZE = 80;
/** 收集到这么多条就提前收工，后面的剧情不再拉。 */
const QUOTE_HARD_CAP = 400;
const QUOTE_MIN_LEN = 10;
const QUOTE_MAX_LEN = 160;
const QUOTE_DISPLAY_COUNT = 5;

interface GroupInfo {
  category: GroupCategory;
  groupName: string;
  groupOrder: number; // 用于排序章节/活动顺序
  storyOrder: number; // 用于组内排序（同主页）
}

/** 过滤用的归一化：大小写、空白、各种间隔号都不参与匹配。 */
function normalizeForSearch(value: string): string {
  return value.trim().toLowerCase().replace(/[\s·‧•・]+/g, "");
}

/** Fisher–Yates 洗牌后取前 n 条，不改动传入数组。 */
function pickRandomQuotes(pool: CharacterQuote[], n: number): CharacterQuote[] {
  const shuffled = [...pool];
  for (let i = shuffled.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled.slice(0, n);
}

/**
 * 输入法友好的过滤输入框。
 *
 * 拼音/日文输入法在选词前会一路触发 change（「z」「zh」「zhong」…），
 * 直接拿这些中间态过滤，列表会在用户还没打完字时就抖成"无匹配"。
 * 所以合成期间只更新本地草稿，等 compositionend 才把结果提交给父级。
 * 草稿由组件自己持有，父级只保存已提交的关键词。
 */
function FilterInput({
  initialValue = "",
  placeholder,
  ariaLabel,
  onCommit,
}: {
  initialValue?: string;
  placeholder: string;
  ariaLabel: string;
  onCommit: (value: string) => void;
}) {
  const [draft, setDraft] = useState(initialValue);
  const composingRef = useRef(false);

  const commit = useCallback(
    (value: string) => {
      composingRef.current = false;
      setDraft(value);
      onCommit(value);
    },
    [onCommit],
  );

  return (
    <div className="relative">
      <Input
        value={draft}
        placeholder={placeholder}
        aria-label={ariaLabel}
        className="pr-9"
        autoComplete="off"
        autoCorrect="off"
        spellCheck={false}
        enterKeyHint="search"
        onChange={(e) => {
          const value = e.target.value;
          setDraft(value);
          if (!composingRef.current) onCommit(value);
        }}
        onCompositionStart={() => {
          composingRef.current = true;
        }}
        onCompositionEnd={(e) => {
          // 部分安卓输入法的 change 会排在 compositionend 之后，只靠
          // 清标记会漏掉最后一次输入；这里直接用事件里的最终文本。
          commit((e.target as HTMLInputElement).value);
        }}
        onKeyDown={(e) => {
          if (e.key !== "Escape" || !draft) return;
          if (e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229) return;
          // 别让 Esc 冒到全局返回处理上，这里只清输入框。
          e.preventDefault();
          e.stopPropagation();
          commit("");
        }}
      />
      {draft && (
        <button
          type="button"
          className="absolute right-0 top-0 flex h-full w-9 items-center justify-center rounded-r-md text-[hsl(var(--color-muted-foreground))] transition-colors hover:text-[hsl(var(--color-foreground))] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[hsl(var(--color-ring))]"
          onClick={() => commit("")}
          aria-label={`清除${ariaLabel}`}
        >
          <X className="h-4 w-4" />
        </button>
      )}
    </div>
  );
}

/** memo 一层：搜索、选中这类 state 变化不该重渲染另外 400 张卡片。 */
const CharacterCard = memo(function CharacterCard({
  name,
  total,
  onSelect,
}: {
  name: string;
  total: number;
  onSelect: (name: string) => void;
}) {
  return (
    <button
      className={cn(
        "character-grid-cell flex items-center gap-3 rounded-lg border border-[hsl(var(--color-border))] bg-[hsl(var(--color-card))] p-3 text-left"
      )}
      onClick={() => onSelect(name)}
    >
      <CharacterAvatar name={name} size={40} />
      <div className="font-medium truncate flex-1 min-w-0">{name}</div>
      <div className="text-xs text-[hsl(var(--color-muted-foreground))] shrink-0">{total} 次</div>
    </button>
  );
});

// 出场关卡列表可以有上千行（博士、凯尔希）。视口外的行跳过绘制与布局，
// 展开长章节时才不会整屏 repaint。和人物网格用的是同一套办法。
const STORY_ROW_STYLE: CSSProperties = {
  contentVisibility: "auto",
  containIntrinsicSize: "1px 72px",
};

const CACHE_PREFIX = "arknights-characters-cache";

/**
 * 清掉本前缀下不属于当前数据版本的统计缓存。
 *
 * 缓存键带数据 commit，每次同步都会产生一个新键；旧键（一条就有几百 KB
 * 到 MB 级）从此无人读也无人删，几次同步就能把 localStorage 配额塞满。
 * 满了之后不止本缓存写不进（每次冷启动都重扫几千篇剧情），阅读进度、
 * 高亮这些共享 localStorage 的落盘也会跟着静默失败。必须在写入之前扫：
 * 配额已被旧键占满时，先腾出地方本次落盘才有机会成功。
 */
function sweepStaleStatsCaches(currentKey: string): void {
  try {
    const stale: string[] = [];
    for (let i = 0; i < localStorage.length; i += 1) {
      const key = localStorage.key(i);
      if (key && key !== currentKey && key.startsWith(`${CACHE_PREFIX}:`)) stale.push(key);
    }
    stale.forEach((key) => localStorage.removeItem(key));
  } catch {
    // localStorage 不可用（隐私模式等）：读写路径各自有兜底，跳过即可。
  }
}

function countCharactersInStory(content: ParsedStoryContent): Map<string, number> {
  const map = new Map<string, number>();
  content.segments.forEach((seg) => {
    if (seg.type === "dialogue") {
      const key = seg.characterName;
      map.set(key, (map.get(key) ?? 0) + 1);
    }
  });
  return map;
}

export function CharactersPanel({
  active = true,
  onOpenStory,
  onOpenStoryJump,
}: CharactersPanelProps) {
  const [loading, setLoading] = useState(true);
  const [progress, setProgress] = useState({ current: 0, total: 0 });
  const [error, setError] = useState<string | null>(null);
  const [notInstalled, setNotInstalled] = useState(false);
  const [aggregates, setAggregates] = useState<Map<string, CharacterAggregate>>(new Map());
  const [selected, setSelected] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const loadingRef = useRef(false);
  // 扫描进行中又收到强制刷新（数据同步在后台完成）时先记账，本轮跑完
  // 立刻重跑。直接丢掉的话，这一轮读到的新旧混合统计会一直顶到下次
  // 数据更新为止。
  const pendingForceRef = useRef(false);
  const activeRef = useRef(active);
  const loadedOnceRef = useRef(false);
  const staleRef = useRef(false);
  // 统计要读几千篇剧情、金句要读几十篇，都远比一次面板切换活得久。
  // 卸载后既不能继续 setState，也没必要继续发 IPC。
  const aliveRef = useRef(true);
  const [groupInfoByStoryId, setGroupInfoByStoryId] = useState<Map<string, GroupInfo>>(new Map());
  const [groupSearch, setGroupSearch] = useState<Record<string, string>>({});
  const [cacheUsed, setCacheUsed] = useState(false);
  const [cacheBuiltAt, setCacheBuiltAt] = useState<number | null>(null);
  const [version, setVersion] = useState<string | null>(null);
  const [quotes, setQuotes] = useState<CharacterQuote[]>([]);
  const [quoteCandidates, setQuoteCandidates] = useState<CharacterQuote[]>([]);
  const [loadingQuotes, setLoadingQuotes] = useState(false);
  /** 当前 quotes 属于哪位角色；和 selected 不一致就说明还没抓完。 */
  const [quotesFor, setQuotesFor] = useState<string | null>(null);
  const quotesRunRef = useRef(0);
  const { loaded: resolverLoaded, hasIndex, refresh: refreshResolver } = useCharacterResolver();

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  // 缓存 key 只取 commit hash 部分（版本字符串前 7 位），忽略时间戳。
  // 这样只要底层数据没变（同一个 commit），缓存就一直有效，不会因为
  // 重启或重新同步（同版本）而失效。
  const getCacheKey = useCallback((v: string) => {
    const commitPart = v.split(" ")[0] || v;
    return `${CACHE_PREFIX}:${commitPart}`;
  }, []);

  const loadAll = useCallback(async (opts?: { forceRefresh?: boolean }) => {
    if (loadingRef.current) {
      // 数据刚换完却撞上正在跑的扫描：本轮读到的可能是新旧混合的内容，
      // 这次刷新请求不能就地丢掉，记下来等本轮结束再重跑。
      if (opts?.forceRefresh) pendingForceRef.current = true;
      return;
    }
    loadingRef.current = true;
    setLoading(true);
    setError(null);
    try {
      // 数据没同步时后端每个命令都会抛错，先问一次省掉一串失败请求。
      const installed = await api.isInstalled();
      if (!aliveRef.current) return;
      if (!installed) {
        setNotInstalled(true);
        setAggregates(new Map());
        setProgress({ current: 0, total: 0 });
        // 不算"已加载"：同步完数据切回来要能自动重试。
        loadedOnceRef.current = false;
        return;
      }
      setNotInstalled(false);

      const ver = await api.getCurrentVersion();
      if (!aliveRef.current) return;
      setVersion(ver);
      // 数据版本换过之后，旧版本的缓存键就成了纯垃圾，趁写入前清掉。
      if (ver) sweepStaleStatsCaches(getCacheKey(ver));

      // 本次统计是否缺斤短两：目录拉挂被 catch 吞掉、或个别剧情读取失败。
      // 残缺结果本次会话先凑合显示，但绝不能写进缓存（见下方保存处）。
      let statsIncomplete = false;

      // 使用主页同样的分组与排序数据源
      const [mainGrouped, activityGrouped, sidestoryGrouped, roguelikeGrouped, memoryStories] =
        await Promise.all([
          api.getMainStoriesGrouped(),
          api.getActivityStoriesGrouped(),
          api.getSidestoryStoriesGrouped().catch(() => {
            statsIncomplete = true;
            return [];
          }),
          api.getRoguelikeStoriesGrouped().catch(() => {
            statsIncomplete = true;
            return [];
          }),
          api.getMemoryStories(),
        ]);
      if (!aliveRef.current) return;

      // 生成 groupInfoByStoryId
      const groupInfo = new Map<string, GroupInfo>();

      mainGrouped.forEach(([chapterName, stories], groupOrder) => {
        stories.forEach((s) => {
          groupInfo.set(s.storyId, {
            category: "main",
            groupName: chapterName,
            groupOrder,
            storyOrder: s.storySort,
          });
        });
      });

      activityGrouped.forEach(([activityName, stories], groupOrder) => {
        stories.forEach((s) => {
          groupInfo.set(s.storyId, {
            category: "activity",
            groupName: activityName,
            groupOrder,
            storyOrder: s.storySort,
          });
        });
      });

      memoryStories.forEach((s, idx) => {
        groupInfo.set(s.storyId, {
          category: "memory",
          groupName: "干员密录",
          groupOrder: idx,
          storyOrder: s.storySort,
        });
      });

      sidestoryGrouped.forEach(([name, stories], groupOrder) => {
        stories.forEach((s) => {
          if (!groupInfo.has(s.storyId)) {
            groupInfo.set(s.storyId, {
              category: "activity",
              groupName: name,
              // 支线与活动同归 "activity" 分类，但两边的 groupOrder 都是
              // 各自列表的下标，裸用必然撞号（活动第 3 期和支线第 3 组都
              // 是 3）。撞号的桶排序打平后，先后就由 perStory 里 storySort
              // 的交错决定——每个角色详情页看到的活动/支线相对顺序都不一
              // 样。按剧情页的分类顺序（活动在前、支线在后）给支线整体加
              // 偏移，两边序号空间不再重叠。
              groupOrder: activityGrouped.length + groupOrder,
              storyOrder: s.storySort,
            });
          }
        });
      });

      roguelikeGrouped.forEach(([name, stories], groupOrder) => {
        stories.forEach((s) => {
          groupInfo.set(s.storyId, {
            category: "other",
            groupName: name,
            groupOrder,
            storyOrder: s.storySort,
          });
        });
      });

      const storiesMap = new Map<string, StoryEntry>();
      mainGrouped.forEach(([, stories]) => stories.forEach((s) => storiesMap.set(s.storyId, s)));
      activityGrouped.forEach(([, stories]) => stories.forEach((s) => storiesMap.set(s.storyId, s)));
      sidestoryGrouped.forEach(([, stories]) => stories.forEach((s) => storiesMap.set(s.storyId, s)));
      roguelikeGrouped.forEach(([, stories]) => stories.forEach((s) => storiesMap.set(s.storyId, s)));
      memoryStories.forEach((s) => storiesMap.set(s.storyId, s));

      const stories = Array.from(storiesMap.values());
      setGroupInfoByStoryId(groupInfo);
      setProgress({ current: 0, total: stories.length });

      const aggMap = new Map<string, CharacterAggregate>();

      // 1) 先尝试命中缓存
      let cacheApplied = false;
      if (!opts?.forceRefresh && ver) {
        try {
          const raw = localStorage.getItem(getCacheKey(ver));
          if (raw) {
            const parsed: {
              builtAt: number;
              data: Record<string, { name: string; total: number; perStory: Array<{ storyId: string; count: number }> }>;
            } = JSON.parse(raw);
            Object.values(parsed.data).forEach((item) => {
              const perStory: CharacterStatsPerStory[] = [];
              item.perStory.forEach((ps) => {
                const story = storiesMap.get(ps.storyId);
                if (story) perStory.push({ story, count: ps.count });
              });
              aggMap.set(item.name, { name: item.name, total: item.total, perStory });
            });
            cacheApplied = true;
            setCacheUsed(true);
            setCacheBuiltAt(parsed.builtAt);
          }
        } catch {
          // 缓存损坏就丢掉重建，不用打扰用户。回填可能在半路抛错，此时
          // aggMap 已混入部分缓存条目，必须清空：否则下面的全量重扫会在
          // 残留计数上继续累加，统计翻倍后还会被原样写回缓存。
          aggMap.clear();
          try {
            localStorage.removeItem(getCacheKey(ver));
          } catch {}
        }
      }

      // 顺序加载，避免峰值占用过高；可根据需要增加并发
      if (!cacheApplied) {
        setCacheUsed(false);
        setCacheBuiltAt(null);
        // Concurrency pool: process N stories in parallel so first-start on
        // slow devices doesn't take minutes. Each story's aggregation still
        // runs on a single thread — we just overlap I/O and parse work.
        let cursor = 0;
        let done = 0;
        let failed = 0;
        const applyCounts = (story: StoryEntry, counts: Map<string, number>) => {
          counts.forEach((count, name) => {
            const existing = aggMap.get(name);
            if (existing) {
              existing.total += count;
              existing.perStory.push({ story, count });
            } else {
              aggMap.set(name, {
                name,
                total: count,
                perStory: [{ story, count }],
              });
            }
          });
        };
        const worker = async () => {
          // 面板卸载后剩下的几千次读取直接放弃，不再排队占用 IPC。
          while (aliveRef.current) {
            const i = cursor++;
            if (i >= stories.length) return;
            const story = stories[i];
            try {
              const content = await api.getStoryContent(story.storyTxt);
              // JS 单线程，applyCounts 是同步的，不需要任何锁。
              applyCounts(story, countCharactersInStory(content));
            } catch {
              failed += 1;
            } finally {
              done += 1;
              if (aliveRef.current && (done % PROGRESS_STEP === 0 || done === stories.length)) {
                setProgress({ current: done, total: stories.length });
              }
            }
          }
        };
        await Promise.all(
          Array.from({ length: Math.min(STATS_POOL_SIZE, stories.length) }, () => worker())
        );
        if (!aliveRef.current) return;
        if (failed > 0) {
          statsIncomplete = true;
          console.warn(`[CharactersPanel] ${failed}/${stories.length} 篇剧情读取失败，已跳过`);
        }
      }

      // 整理每个角色的 perStory 排序（先分类，再章节序，最后组内序）
      aggMap.forEach((agg) => {
        agg.perStory.sort((a, b) => {
          const ga = groupInfo.get(a.story.storyId);
          const gb = groupInfo.get(b.story.storyId);
          const cOrder =
            (ga ? CATEGORY_RANK[ga.category] : CATEGORY_RANK.other) -
            (gb ? CATEGORY_RANK[gb.category] : CATEGORY_RANK.other);
          if (cOrder !== 0) return cOrder;
          const gOrder = (ga?.groupOrder ?? 9999) - (gb?.groupOrder ?? 9999);
          if (gOrder !== 0) return gOrder;
          const sOrder = (ga?.storyOrder ?? a.story.storySort) - (gb?.storyOrder ?? b.story.storySort);
          if (sOrder !== 0) return sOrder;
          return a.story.storyName.localeCompare(b.story.storyName, "zh-Hans");
        });
      });

      setAggregates(aggMap);

      // 2) 没用缓存则保存缓存（精简 perStory 为 storyId + count）。
      // 扫描不完整时跳过落盘：缓存 key 只随数据版本变，一次瞬时失败算出
      // 的偏小计数一旦写进去，就会顶着「已使用缓存」活到下个数据版本。
      if (!cacheApplied && ver && !statsIncomplete) {
        try {
          const plain: Record<string, { name: string; total: number; perStory: Array<{ storyId: string; count: number }> }> = {};
          aggMap.forEach((agg, name) => {
            plain[name] = {
              name,
              total: agg.total,
              perStory: agg.perStory.map((ps) => ({ storyId: ps.story.storyId, count: ps.count })),
            };
          });
          const builtAt = Date.now();
          localStorage.setItem(
            getCacheKey(ver),
            JSON.stringify({ builtAt, data: plain })
          );
          setCacheBuiltAt(builtAt);
        } catch {
          // localStorage 写满或被禁用：统计仍然可用，只是下次要重算。
        }
      }

      loadedOnceRef.current = true;
    } catch (err) {
      const raw = err instanceof Error ? err.message : String(err);
      loadedOnceRef.current = false;
      if (!aliveRef.current) return;
      if (/NOT_INSTALLED|未安装/i.test(raw)) {
        setNotInstalled(true);
      } else {
        setError(raw || "加载失败");
      }
    } finally {
      if (aliveRef.current) setLoading(false);
      loadingRef.current = false;
      // 消化扫描期间排队的强制刷新。deps 恒定，loadAll 引用自身是安全的。
      if (pendingForceRef.current && aliveRef.current) {
        pendingForceRef.current = false;
        if (activeRef.current) {
          void loadAll({ forceRefresh: true });
        } else {
          // 排队期间面板被切走了：按不可见时的规矩打标，等切回来再扫。
          staleRef.current = true;
          loadedOnceRef.current = false;
        }
      }
    }
  }, [getCacheKey]);

  // 只在面板首次可见时统计；之后除非数据变了，切回来不重跑。
  useEffect(() => {
    activeRef.current = active;
    if (!active) return;
    if (loadedOnceRef.current && !staleRef.current) return;
    const force = staleRef.current;
    staleRef.current = false;
    void loadAll(force ? { forceRefresh: true } : undefined);
  }, [active, loadAll]);

  useEffect(() => {
    const handler = () => {
      // 面板不可见时只打个标记，等用户切回来再重算——后台重扫几千篇
      // 剧情会把正在阅读的页面拖卡。
      if (!activeRef.current) {
        staleRef.current = true;
        loadedOnceRef.current = false;
        return;
      }
      void loadAll({ forceRefresh: true });
    };
    window.addEventListener("app:refresh-character-stats", handler);
    window.addEventListener("app:data-updated", handler);
    return () => {
      window.removeEventListener("app:refresh-character-stats", handler);
      window.removeEventListener("app:data-updated", handler);
    };
  }, [loadAll]);

  const allCharacters = useMemo(() => {
    return Array.from(aggregates.values())
      .filter((c) => !!c.name && c.name.trim().length > 0)
      .sort((a, b) => b.total - a.total || a.name.localeCompare(b.name, "zh-Hans"));
  }, [aggregates]);

  // 400+ 个人物的过滤放到低优先级更新里：输入框永远先跟上手速，列表慢一帧
  // 重排也不会卡住输入法候选框。
  const deferredSearch = useDeferredValue(search);
  const searchStale = deferredSearch !== search;

  // 名字里的间隔号常被漏打（「玛恩纳·临光」），两边都抹掉再比。
  const searchNeedles = useMemo(
    () => allCharacters.map((c) => normalizeForSearch(c.name)),
    [allCharacters]
  );

  const filteredCharacters = useMemo(() => {
    const q = normalizeForSearch(deferredSearch);
    if (!q) return allCharacters;
    return allCharacters.filter((_, i) => searchNeedles[i].includes(q));
  }, [allCharacters, searchNeedles, deferredSearch]);

  // 网格和详情共用同一个滚动容器，面板又是 KeepAlive 常驻的——容器从不
  // 重建，偏移一直留着。在网格里滚到深处再点开博士这类角色，详情会停在
  // 旧偏移的半腰（几千行的关卡列表夹不回顶部），头像和金句根本看不见；
  // 返回时网格位置又被详情里的滚动覆盖。进详情记下网格偏移并归顶，回
  // 列表再还原。用 layout effect：在绘制前落位，不闪半截内容。
  const scrollViewportRef = useRef<HTMLDivElement | null>(null);
  const gridScrollTopRef = useRef(0);

  // 网格偏移必须在点击那一刻、DOM 还没换成详情之前保存。等到 layout
  // effect 再读，提交里网格已经卸载，读 scrollTop 会按详情的新高度强制
  // 重排并夹小偏移——低出场角色恰好排在网格底部（滚得最深）、详情又最
  // 短，保存值直接塌到 0，返回时「还原」的就是坏值。
  const handleSelectCharacter = useCallback((name: string) => {
    const viewport = scrollViewportRef.current;
    if (viewport) gridScrollTopRef.current = viewport.scrollTop;
    setSelected(name);
  }, []);

  const prevSelectedRef = useRef(selected);
  useLayoutEffect(() => {
    const prev = prevSelectedRef.current;
    if (prev === selected) return;
    prevSelectedRef.current = selected;
    const viewport = scrollViewportRef.current;
    if (!viewport) return;
    if (selected !== null) {
      viewport.scrollTop = 0;
    } else {
      // 卡片有 contain-intrinsic-size，本次提交里 scrollHeight 已就位，
      // 直接还原不会被夹回 0。
      viewport.scrollTop = gridScrollTopRef.current;
    }
  }, [selected]);

  // 搜索词一变，网格就是「整个被换掉」：旧偏移只会被浏览器随机夹在新
  // 结果的半截。和 StoryList 的处理对齐——关键词（归一化后）真的变了
  // 就归顶。跟着 deferredSearch 走，重置正好落在列表真正重排的那次提交。
  const normalizedDeferredSearch = normalizeForSearch(deferredSearch);
  const searchScrollResetRef = useRef(normalizedDeferredSearch);
  useLayoutEffect(() => {
    if (searchScrollResetRef.current === normalizedDeferredSearch) return;
    searchScrollResetRef.current = normalizedDeferredSearch;
    // 详情盖着时网格没渲染，滚动位置是详情的，别动。
    if (selected !== null) return;
    const viewport = scrollViewportRef.current;
    if (viewport && viewport.scrollTop !== 0) viewport.scrollTop = 0;
  }, [normalizedDeferredSearch, selected]);

  // 人物详情是盖在网格上的全屏二级视图，必须占一层返回栈：否则 Android
  // 硬返回 / 手势返回会越过它落到 App 的 tab 兜底，整个 tab 直接跳回首页，
  // 而详情还留在原地（切回人物页时它仍开着）。与 `active` 相与：阅读器盖
  // 在上面或面板隐藏时，这一层不许继续占着返回栈。
  useBackHandler(
    active && selected !== null,
    () => {
      setSelected(null);
      return true;
    },
    BACK_PRIORITY.view
  );

  const selectedAgg = useMemo(() => (selected ? aggregates.get(selected) ?? null : null), [aggregates, selected]);

  // 详情开着的时候数据可能被重扫（同步完成后改名/删档），selected 就悬空
  // 了：详情块因为 selectedAgg 为 null 不渲染，网格又因为 selected 非空不
  // 渲染——正文区只剩一块白屏。统计落定后名字不在了就自动退回列表。
  useEffect(() => {
    if (loading || !selected) return;
    if (!aggregates.has(selected)) setSelected(null);
  }, [aggregates, loading, selected]);

  const groupedByChapter = useMemo(() => {
    if (!selectedAgg)
      return [] as Array<{
        key: string;
        groupName: string;
        items: CharacterStatsPerStory[];
        rank: number;
        order: number;
      }>;
    const buckets = new Map<
      string,
      {
        key: string;
        groupName: string;
        rank: number;
        order: number;
        items: CharacterStatsPerStory[];
      }
    >();
    selectedAgg.perStory.forEach((ps) => {
      const info = groupInfoByStoryId.get(ps.story.storyId);
      // 不同分类下可能撞同名章节，React key 与组内搜索都用带分类前缀的 key。
      const key = info ? `${info.category}:${info.groupName}` : `other:其他`;
      const bucket = buckets.get(key);
      if (bucket) {
        bucket.items.push(ps);
      } else {
        buckets.set(key, {
          key,
          groupName: info?.groupName ?? "其他",
          // 与 perStory 相同的比较键：分类在前，组内序号在后。groupOrder
          // 是分类内序号，跨分类裸比会把主线章节和活动条目交错排开。
          rank: info ? CATEGORY_RANK[info.category] : CATEGORY_RANK.other,
          order: info?.groupOrder ?? 9999,
          items: [ps],
        });
      }
    });
    return Array.from(buckets.values()).sort(
      (a, b) => a.rank - b.rank || a.order - b.order
    );
  }, [groupInfoByStoryId, selectedAgg]);

  // 组内搜索按章节名存。换个角色还留着上一位的关键词，展开章节就会莫名
  // 其妙地显示"无匹配结果"。
  useEffect(() => {
    setGroupSearch((prev) => (Object.keys(prev).length > 0 ? {} : prev));
  }, [selected]);

  useEffect(() => {
    if (!selected || !selectedAgg) {
      quotesRunRef.current += 1;
      setQuotes([]);
      setQuoteCandidates([]);
      setQuotesFor(null);
      setLoadingQuotes(false);
      return;
    }
    const runId = ++quotesRunRef.current;
    setLoadingQuotes(true);
    setQuotes([]);
    setQuoteCandidates([]);
    setQuotesFor(null);

    // 博士这类角色能有上千篇 perStory。只挑发言最多的几十篇，再用固定
    // 并发去读——既够凑满候选池，又不会一次性打爆 IPC 队列。
    const targets = [...selectedAgg.perStory]
      .sort((a, b) => b.count - a.count)
      .slice(0, QUOTE_STORY_LIMIT);

    const collected: CharacterQuote[] = [];
    const seenText = new Set<string>();
    let cursor = 0;
    let cancelled = false;
    // 换角色 / 卸载后这一轮就作废：既不再取新剧情，也不解析已经拿到的，
    // 更不会拿旧角色的金句去 setState。
    const live = () => !cancelled && aliveRef.current && runId === quotesRunRef.current;

    const worker = async () => {
      while (live()) {
        if (collected.length >= QUOTE_HARD_CAP) return;
        const i = cursor++;
        if (i >= targets.length) return;
        const { story } = targets[i];
        try {
          const content = await api.getStoryContent(story.storyTxt);
          if (!live()) return;
          // 必须走 postProcessSegments：阅读器渲染的就是这份下标，
          // 否则点金句跳过去会错位。
          postProcessSegments(content.segments).forEach((seg, segmentIndex) => {
            if (seg.type !== "dialogue" || seg.characterName !== selected) return;
            const text = seg.text.trim();
            if (text.length < QUOTE_MIN_LEN || text.length > QUOTE_MAX_LEN) return;
            if (seenText.has(text)) return;
            seenText.add(text);
            collected.push({
              text,
              speaker: seg.characterName,
              storyName: story.storyName,
              story,
              segmentIndex,
            });
          });
        } catch {
          // 单篇读不到就跳过，不影响其他金句。
        }
      }
    };

    void Promise.all(
      Array.from({ length: Math.min(QUOTE_FETCH_CONCURRENCY, targets.length) }, () =>
        worker()
      )
    ).then(() => {
      if (!live()) return;
      // 长句更像"金句"，取最长的一批做候选池，再从池里随机抽几条展示。
      collected.sort((a, b) => b.text.length - a.text.length);
      const pool = collected.slice(0, QUOTE_POOL_SIZE);
      // 候选池和展示句一起落地，避免中间出现一帧"暂无金句"。
      setQuoteCandidates(pool);
      setQuotes(pickRandomQuotes(pool, QUOTE_DISPLAY_COUNT));
      setQuotesFor(selected);
      setLoadingQuotes(false);
    });

    return () => {
      cancelled = true;
    };
  }, [selected, selectedAgg]);

  const handleShuffleQuotes = useCallback(() => {
    setQuotes(pickRandomQuotes(quoteCandidates, QUOTE_DISPLAY_COUNT));
  }, [quoteCandidates]);

  const handleGoToSettings = useCallback(() => {
    window.dispatchEvent(new CustomEvent("app:go-tab", { detail: "settings" }));
  }, []);

  const handleReloadResolver = useCallback(() => {
    void refreshResolver();
  }, [refreshResolver]);

  // 索引没载进来时头像只剩首字缩写，别名解析也会失效。统计本身照常可用，
  // 所以有数据时只提示一行，没数据时才占满整块空态。
  const resolverIndexMissing = resolverLoaded && !hasIndex && !notInstalled;

  // 刚选中角色、effect 还没跑起来的那一帧也算"加载中"，否则会闪一下空态。
  const quotesPending = loadingQuotes || (selected !== null && quotesFor !== selected);

  const handleQuoteClick = useCallback(
    (quote: CharacterQuote) => {
      if (onOpenStoryJump) {
        onOpenStoryJump(quote.story, {
          segmentIndex: quote.segmentIndex,
          // 阅读器以 preview 文本匹配为准（防数据同步后段号漂移），而它对
          // 对话段的匹配语料是「说话人 + 正文」。只传正文时，同一句台词若
          // 更早出现在别人嘴里（或旁白复述），会命中更早那段——带上说话人
          // 才锚定到本角色的这一句。文本匹配不到时阅读器仍回退到段号。
          preview: `${quote.speaker} ${quote.text}`,
        });
      } else {
        onOpenStory(quote.story, selectedAgg?.name ?? "");
      }
    },
    [onOpenStory, onOpenStoryJump, selectedAgg],
  );

  return (
    <div className="h-full flex flex-col">
      <header className="px-4 py-3 border-b border-[hsl(var(--color-border))] flex items-center gap-3">
        {selected && (
          <Button variant="ghost" size="icon" onClick={() => setSelected(null)} aria-label="返回">
            <ArrowLeft className="h-5 w-5" />
          </Button>
        )}
        <h1 className="text-base font-semibold truncate">
          {selected ? `人物：${selected}` : "人物统计"}
        </h1>
        {!selected && (
          <div className="ml-auto min-w-0 flex-1 max-w-[14rem]">
            {/* 进出角色详情会让搜索框重新挂载，initialValue 让草稿跟已提交的关键词对齐。 */}
            <FilterInput
              initialValue={search}
              placeholder="搜索人物"
              ariaLabel="搜索人物"
              onCommit={setSearch}
            />
          </div>
        )}
      </header>

      <CustomScrollArea
        className="flex-1"
        viewportRef={scrollViewportRef}
        trackOffsetTop="calc(3.25rem + 10px)"
        trackOffsetBottom="calc(4.5rem + env(safe-area-inset-bottom, 0px))"
      >
        <div className="p-4 pb-24 space-y-4">
          {loading && (
            <div className="flex items-center gap-3 text-sm text-[hsl(var(--color-muted-foreground))]">
              <Loader2 className="h-4 w-4 animate-spin" />
              <span>
                {progress.total > 0
                  ? `正在统计人物发言… ${progress.current}/${progress.total}`
                  : "正在准备人物统计…"}
              </span>
            </div>
          )}

          {notInstalled && !loading && (
            <div className="rounded-2xl border border-dashed border-[hsl(var(--color-border))] p-5">
              <div className="text-sm font-medium">还没有剧情数据</div>
              <p className="mt-1.5 text-sm leading-relaxed text-[hsl(var(--color-muted-foreground))]">
                人物统计需要先同步一次剧情文本。到设置页下载或导入 ArknightsGameData
                之后，这里会自动统计每位干员的发言次数、出场章节和金句。
              </p>
              <div className="mt-3 flex flex-wrap gap-2">
                <Button className="min-h-[44px]" onClick={handleGoToSettings}>
                  去设置同步
                </Button>
                <Button
                  variant="ghost"
                  className="min-h-[44px]"
                  onClick={() => void loadAll({ forceRefresh: true })}
                >
                  重新检测
                </Button>
              </div>
            </div>
          )}

          {error && !loading && (
            <div className="rounded-2xl border border-[hsl(var(--color-border))] p-5">
              <div className="text-sm font-medium text-[hsl(var(--color-destructive))]">
                统计失败
              </div>
              <p className="mt-1.5 text-sm leading-relaxed text-[hsl(var(--color-muted-foreground))] break-words">
                {error}
              </p>
              <Button
                className="mt-3 min-h-[44px]"
                onClick={() => void loadAll({ forceRefresh: true })}
              >
                重试
              </Button>
            </div>
          )}

          {!loading && !selected && !notInstalled && !error && (
            <div className="text-xs text-[hsl(var(--color-muted-foreground))]">
              {cacheUsed && cacheBuiltAt
                ? `已使用缓存，构建于 ${new Date(cacheBuiltAt).toLocaleString()}`
                : version
                ? `未使用缓存（版本 ${version}）`
                : null}
            </div>
          )}

          {!selected &&
            !loading &&
            resolverIndexMissing &&
            (allCharacters.length > 0 ? (
              // 统计还在，只是头像退化了：一行提示就够，别抢走整块空间。
              <div className="flex flex-wrap items-center gap-x-2 rounded-xl border border-dashed border-[hsl(var(--color-border))] px-3 py-1.5 text-xs text-[hsl(var(--color-muted-foreground))]">
                <span>角色索引没载入，头像暂时用首字缩写代替。</span>
                <button
                  type="button"
                  className="-my-2 inline-flex min-h-[44px] items-center px-1 font-medium text-[hsl(var(--color-primary))] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[hsl(var(--color-ring))] rounded"
                  onClick={handleReloadResolver}
                >
                  重新载入
                </button>
              </div>
            ) : (
              <div className="rounded-2xl border border-dashed border-[hsl(var(--color-border))] p-5">
                <div className="text-sm font-medium">角色索引没有载入</div>
                <p className="mt-1.5 text-sm leading-relaxed text-[hsl(var(--color-muted-foreground))]">
                  角色索引是空的，人物统计也就没有可显示的内容。先重新载入一次；还是空的就到设置页同步
                  ArknightsGameData 之后再回来。
                </p>
                <div className="mt-3 flex flex-wrap gap-2">
                  <Button className="min-h-[44px]" onClick={handleReloadResolver}>
                    重新载入索引
                  </Button>
                  <Button variant="ghost" className="min-h-[44px]" onClick={handleGoToSettings}>
                    去设置同步
                  </Button>
                </div>
              </div>
            ))}

          {!selected && !notInstalled && (
            <div
              className={cn(
                "grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3",
                // 过滤结果还在低优先级更新里排队时先淡一下，比列表突然跳变可读。
                searchStale && "opacity-60 transition-opacity duration-150"
              )}
            >
              {filteredCharacters.map((c) => (
                <CharacterCard
                  key={c.name}
                  name={c.name}
                  total={c.total}
                  onSelect={handleSelectCharacter}
                />
              ))}
              {loading &&
                filteredCharacters.length === 0 &&
                Array.from({ length: 6 }, (_, i) => (
                  <div
                    key={`skeleton-${i}`}
                    className="flex items-center gap-3 rounded-lg border border-[hsl(var(--color-border))] bg-[hsl(var(--color-card))] p-3"
                    aria-hidden="true"
                  >
                    <div className="h-10 w-10 shrink-0 rounded-full bg-[hsl(var(--color-secondary))] animate-pulse" />
                    <div className="h-3 w-24 rounded bg-[hsl(var(--color-secondary))] animate-pulse" />
                  </div>
                ))}
              {!loading && !error && !resolverIndexMissing && filteredCharacters.length === 0 && (
                <div className="col-span-full text-sm text-[hsl(var(--color-muted-foreground))]">
                  {deferredSearch.trim()
                    ? `没有匹配“${deferredSearch.trim()}”的人物`
                    : "还没有统计到人物"}
                </div>
              )}
            </div>
          )}

          {selected && selectedAgg && (
            <div className="space-y-4">
              <div className="flex items-center gap-4">
                <CharacterAvatar name={selected} size={80} tint="none" />
                <div className="min-w-0">
                  <div className="text-lg font-semibold truncate">{selectedAgg.name}</div>
                  <div className="text-sm text-[hsl(var(--color-muted-foreground))]">
                    共计 {selectedAgg.total} 次发言，涉及 {selectedAgg.perStory.length} 个章节/关卡
                  </div>
                </div>
              </div>

              {quotesPending && (
                <div
                  className="rounded-lg border border-[hsl(var(--color-border))] bg-[hsl(var(--color-card))] p-4 space-y-2"
                  style={{ minHeight: 80 }}
                >
                  <div className="h-3 w-24 rounded bg-[hsl(var(--color-secondary))] animate-pulse" />
                  <div className="h-3 w-full rounded bg-[hsl(var(--color-secondary))] animate-pulse" />
                  <div className="h-3 w-3/4 rounded bg-[hsl(var(--color-secondary))] animate-pulse" />
                </div>
              )}

              {!quotesPending && quotes.length > 0 && (
                <div
                  className="rounded-lg border border-[hsl(var(--color-border))] bg-[hsl(var(--color-card))] p-4 space-y-3"
                  style={{ minHeight: 80 }}
                >
                  <div className="flex items-center justify-between">
                    <div className="text-sm font-medium">金句</div>
                    {quoteCandidates.length > quotes.length && (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="-my-1 min-h-[44px] px-3 text-xs text-[hsl(var(--color-muted-foreground))]"
                        onClick={handleShuffleQuotes}
                        aria-label="换一批金句"
                      >
                        <Shuffle className="h-3.5 w-3.5 mr-1" />
                        换一批
                      </Button>
                    )}
                  </div>
                  {quotes.map((quote, i) => (
                    <button
                      key={`${quote.story.storyId}-${quote.segmentIndex}-${i}`}
                      type="button"
                      onClick={() => handleQuoteClick(quote)}
                      className="relative block w-full min-h-[44px] pl-6 pr-2 py-2 text-left text-sm leading-relaxed text-[hsl(var(--color-foreground))] rounded-md transition-colors hover:bg-[hsl(var(--color-secondary))] focus:outline-none focus-visible:ring-2 focus-visible:ring-[hsl(var(--color-ring))]"
                      aria-label={`跳转到 ${quote.storyName} 中的这句话`}
                    >
                      <span
                        aria-hidden="true"
                        className="absolute left-0 top-0 text-2xl leading-none text-[hsl(var(--color-muted-foreground))] select-none"
                      >
                        &ldquo;
                      </span>
                      <div className="whitespace-pre-wrap break-words">{quote.text}</div>
                      <div className="mt-1 text-xs text-[hsl(var(--color-muted-foreground))]">
                        —— {selectedAgg.name} · {quote.storyName}
                      </div>
                    </button>
                  ))}
                </div>
              )}

              {!quotesPending && quotes.length === 0 && (
                <div className="rounded-lg border border-dashed border-[hsl(var(--color-border))] p-4 text-sm text-[hsl(var(--color-muted-foreground))]">
                  这位角色暂时没有合适长度的金句，往下翻可以直接看出场章节。
                </div>
              )}

          {groupedByChapter.map((group, idx) => {
            const key = group.key;
            const q = normalizeForSearch(groupSearch[key] ?? "");
            const items = q
              ? group.items.filter(({ story }) =>
                  [story.storyName, story.storyCode ?? "", story.storyGroup ?? ""].some((v) =>
                    normalizeForSearch(v).includes(q)
                  )
                )
              : group.items;
            const totalCount = group.items.reduce((sum, it) => sum + it.count, 0);

            return (
              // 带上角色名：换人时整棵子树重建，组内搜索框里的草稿不会串台。
              <Collapsible
                key={`${selected}:${key}`}
                title={group.groupName}
                defaultOpen={idx === 0}
              >
                <div className="flex items-center justify-between gap-3 px-1">
                  <div className="text-xs text-[hsl(var(--color-muted-foreground))]">
                    共 {group.items.length} 个关卡，合计 {totalCount} 次
                  </div>
                  <div className="min-w-0 flex-1 max-w-[12rem]">
                    <FilterInput
                      initialValue={groupSearch[key] ?? ""}
                      placeholder="组内搜索"
                      ariaLabel={`在 ${group.groupName} 中搜索关卡`}
                      onCommit={(value) =>
                        setGroupSearch((prev) => ({ ...prev, [key]: value }))
                      }
                    />
                  </div>
                </div>
                <div className="space-y-2 mt-2">
                  {items.length === 0 && (
                    <div className="text-xs text-[hsl(var(--color-muted-foreground))] px-1">无匹配结果</div>
                  )}
                  {items.map(({ story, count }) => (
                    <div
                      key={story.storyId}
                      className="flex items-center justify-between rounded-lg border border-[hsl(var(--color-border))] bg-[hsl(var(--color-card))] p-3 shadow-sm"
                      style={STORY_ROW_STYLE}
                    >
                      <div className="min-w-0">
                        <div className="font-medium truncate">{story.storyName}</div>
                        <div className="text-xs text-[hsl(var(--color-muted-foreground))] truncate">
                          {story.storyCode || story.storyGroup}
                        </div>
                      </div>
                      <div className="flex items-center gap-3 ml-4">
                        <div className="text-xs tabular-nums text-[hsl(var(--color-muted-foreground))]">
                          {count} 次
                        </div>
                        <Button
                          size="sm"
                          className="min-h-[44px] px-4"
                          onClick={() => onOpenStory(story, selectedAgg.name)}
                        >
                          打开
                        </Button>
                      </div>
                    </div>
                  ))}
                </div>
              </Collapsible>
            );
          })}
            </div>
          )}
        </div>
      </CustomScrollArea>
    </div>
  );
}
