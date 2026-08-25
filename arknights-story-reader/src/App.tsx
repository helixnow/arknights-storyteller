import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ThemeProvider } from "@/components/theme-provider";
import { StoryList } from "@/components/StoryList";
import { StoryReader } from "@/components/StoryReader";
import { SearchPanel } from "@/components/SearchPanel";
import { Settings } from "@/components/Settings";
import { BottomNav, tabButtonId, tabPanelId } from "@/components/BottomNav";
import { HomePanel } from "@/components/HomePanel";
import type { StoryEntry } from "@/types/story";
import { FavoritesProvider } from "@/hooks/useFavorites";
import { AppPreferencesProvider } from "@/hooks/useAppPreferences";
import { CharacterResolverProvider } from "@/hooks/useCharacterResolver";
import { KeepAlive } from "@/components/KeepAlive";
import { CharactersPanel } from "@/components/CharactersPanel";
import { useAppUpdater } from "@/hooks/useAppUpdater";
import { BACK_PRIORITY, useBackHandler } from "@/hooks/useBackHandler";
import { useAutoIndex } from "@/hooks/useAutoIndex";
import { flushReadingProgressWrites } from "@/hooks/useReadingProgress";
import { useLegacyStorageCleanup } from "@/hooks/useLegacyStorageCleanup";
import { ToastProvider, useToast } from "@/components/ui/toast";
import { READER_RETENTION_MS } from "@/lib/appShellLogic";

const TABS = ["home", "stories", "characters", "search", "settings"] as const;
type Tab = (typeof TABS)[number];

interface ReaderFocus {
  storyId: string;
  query: string;
  snippet?: string | null;
  issuedAt: number;
}

interface ReaderJump {
  storyId: string;
  segmentIndex: number;
  preview?: string;
  issuedAt: number;
}

/** 打开阅读器时最多只会带其中一种意图（搜索命中 / 角色 / 段落跳转）。 */
interface ReaderIntent {
  focus?: ReaderFocus;
  character?: string;
  jump?: ReaderJump;
}

function AppUpdaterHost() {
  const toast = useToast();
  useAppUpdater({
    notify: (message, kind) =>
      toast.show(message, { kind: kind === "warning" ? "warning" : "default", duration: 5000 }),
  });
  return null;
}

function App() {
  useAutoIndex();
  useLegacyStorageCleanup();
  const [activeTab, setActiveTab] = useState<Tab>("home");
  const [readerVisible, setReaderVisible] = useState(false);
  const [readerStory, setReaderStory] = useState<StoryEntry | null>(null);
  const [readerFocus, setReaderFocus] = useState<ReaderFocus | null>(null);
  const [readerInitialCharacter, setReaderInitialCharacter] = useState<string | null>(null);
  const [readerInitialJump, setReaderInitialJump] = useState<ReaderJump | null>(null);
  const readerActive = readerVisible && readerStory !== null;
  const activeTabRef = useRef<Tab>(activeTab);

  // 关闭阅读器时要不要广播 `app:home-refresh`，取决于它当时是不是真的开着。
  // 用 ref 而不是把 `readerVisible` 写进 useCallback 依赖：那样每次开合阅读器
  // 都会换掉 `handleGoToTab` 的引用，连带把 memo 过的首页视图重算一遍。
  const readerVisibleRef = useRef(readerVisible);
  const readerFocusRestoreRef = useRef<HTMLElement | null>(null);
  const readerEvictionTimerRef = useRef<number | null>(null);
  useEffect(() => {
    readerVisibleRef.current = readerVisible;
  }, [readerVisible]);

  const cancelReaderEviction = useCallback(() => {
    if (readerEvictionTimerRef.current === null) return;
    window.clearTimeout(readerEvictionTimerRef.current);
    readerEvictionTimerRef.current = null;
  }, []);

  const scheduleReaderEviction = useCallback(() => {
    cancelReaderEviction();
    readerEvictionTimerRef.current = window.setTimeout(() => {
      readerEvictionTimerRef.current = null;
      if (readerVisibleRef.current) return;
      // KeepAlive 只负责短期返回时保住位置。超过预取缓存同样的 TTL 后真正
      // 卸载阅读器，释放整篇段落、图片与观察器持有的实例内存。
      setReaderStory(null);
      setReaderFocus(null);
      setReaderInitialCharacter(null);
      setReaderInitialJump(null);
    }, READER_RETENTION_MS);
  }, [cancelReaderEviction]);

  useEffect(() => cancelReaderEviction, [cancelReaderEviction]);

  /**
   * 收起阅读器并（仅在它确实开着时）广播一次进度刷新。首页的「继续阅读」和
   * 剧情列表的进度条都靠这个事件回读 localStorage —— 不管用户是按返回、点
   * 返回箭头还是被 `app:go-tab` 带走，都要走这里，否则列表会停在旧进度。
   */
  const closeReader = useCallback((): boolean => {
    if (!readerVisibleRef.current) return false;
    readerVisibleRef.current = false;
    setReaderVisible(false);
    // 进度是节流落盘的（≤1.2s），而下面的事件会让列表同步回读
    // localStorage；阅读器又被 KeepAlive 常驻挂载，等它收到 active=false
    // 再冲刷已经晚了。先在这里强制冲刷，列表读到的才是最终进度。
    flushReadingProgressWrites();
    window.dispatchEvent(new Event("app:home-refresh"));
    scheduleReaderEviction();
    return true;
  }, [scheduleReaderEviction]);

  useEffect(() => {
    if (readerVisible) return;
    const previous = readerFocusRestoreRef.current;
    readerFocusRestoreRef.current = null;
    if (!previous) return;
    if (previous.isConnected) {
      previous.focus({ preventScroll: true });
      return;
    }
    document.getElementById(tabButtonId(activeTabRef.current))?.focus({ preventScroll: true });
  }, [readerVisible]);

  /** 打开阅读器的唯一入口：意图之间互斥，没带的一律清空。 */
  const openReader = useCallback((story: StoryEntry, intent: ReaderIntent = {}) => {
    const active = document.activeElement;
    readerFocusRestoreRef.current =
      active instanceof HTMLElement && active !== document.body ? active : null;
    cancelReaderEviction();
    setReaderStory(story);
    setReaderFocus(intent.focus ?? null);
    setReaderInitialCharacter(intent.character ?? null);
    setReaderInitialJump(intent.jump ?? null);
    readerVisibleRef.current = true;
    setReaderVisible(true);
  }, [cancelReaderEviction]);

  const handleSelectStory = useCallback(
    (story: StoryEntry) => {
      openReader(story);
    },
    [openReader]
  );

  const handleBackToList = useCallback(() => {
    void closeReader();
  }, [closeReader]);

  const handleSearchResult = useCallback(
    (story: StoryEntry, focus: { query: string; snippet?: string | null }) => {
      openReader(story, {
        focus: {
          storyId: story.storyId,
          query: focus.query,
          snippet: focus.snippet,
          issuedAt: Date.now(),
        },
      });
    },
    [openReader]
  );

  const handleOpenStoryWithCharacter = useCallback(
    (story: StoryEntry, character: string) => {
      openReader(story, { character });
    },
    [openReader]
  );

  const handleOpenStoryJump = useCallback(
    (story: StoryEntry, jump: { segmentIndex: number; preview?: string }) => {
      openReader(story, {
        jump: {
          storyId: story.storyId,
          segmentIndex: jump.segmentIndex,
          preview: jump.preview,
          issuedAt: Date.now(),
        },
      });
    },
    [openReader]
  );

  const handleTabChange = useCallback((tab: Tab) => {
    activeTabRef.current = tab;
    setActiveTab(tab);
  }, []);

  const handleGoToTab = useCallback(
    (tab: Tab) => {
      handleTabChange(tab);
      closeReader();
    },
    [closeReader, handleTabChange]
  );

  useEffect(() => {
    const onGoTab = (event: Event) => {
      const detail = (event as CustomEvent<Tab>).detail;
      if (detail && TABS.includes(detail)) handleGoToTab(detail);
    };
    // 收藏入口：事件自带「去剧情 tab」的语义，派发方只要喊一声就行，
    // 具体切到哪个分类由 StoryList 自己听同一个事件处理。
    const onOpenFavorites = () => handleGoToTab("stories");
    window.addEventListener("app:go-tab", onGoTab as EventListener);
    window.addEventListener("app:open-favorites", onOpenFavorites);
    return () => {
      window.removeEventListener("app:go-tab", onGoTab as EventListener);
      window.removeEventListener("app:open-favorites", onOpenFavorites);
    };
  }, [handleGoToTab]);

  /*
   * 返回栈（Android 硬件返回键 / 浏览器手势返回）：抽屉 → 阅读器 → 回首页
   * → 退出。抽屉那一层由 StoryReader 自己按默认的 overlay 优先级注册，这里
   * 只声明外层两级，优先级保证「阅读器带着抽屉一起重新显示」时也是先关抽屉。
   *
   * 首页这一层刻意不注册任何处理器：注册一个永远返回 false 的处理器会让
   * useBackHandler 认为「有人可能消费返回」而垫上历史哨兵，结果首页的第一次
   * 返回被哨兵吃掉，用户得按两次才能退出。没有处理器时返回原样落到系统。
   */
  useBackHandler(
    readerActive,
    () => {
      // React 的 effect 注销要等提交；ref 已在第一次返回里同步置 false，
      // 连按时这层明确放行，不能再吞掉下一层 tab/退出返回。
      return closeReader();
    },
    BACK_PRIORITY.view
  );

  useBackHandler(
    activeTab !== "home",
    () => {
      if (activeTabRef.current === "home") return false;
      activeTabRef.current = "home";
      setActiveTab("home");
      return true;
    },
    BACK_PRIORITY.tab
  );

  const homeView = useMemo(
    () => (
      <HomePanel onSelectStory={handleSelectStory} onGoToTab={handleGoToTab} />
    ),
    [handleSelectStory, handleGoToTab]
  );
  const storyListView = useMemo(
    () => <StoryList onSelectStory={handleSelectStory} />,
    [handleSelectStory]
  );
  const handleOpenSegmentResult = useCallback(
    (story: StoryEntry, jump: { segmentIndex: number; preview?: string; query: string }) => {
      handleOpenStoryJump(story, {
        segmentIndex: jump.segmentIndex,
        preview: jump.preview,
      });
    },
    [handleOpenStoryJump]
  );

  const searchView = useMemo(
    () => (
      <SearchPanel
        onSelectResult={handleSearchResult}
        onSelectSegment={handleOpenSegmentResult}
      />
    ),
    [handleSearchResult, handleOpenSegmentResult]
  );
  const settingsView = useMemo(() => <Settings />, []);

  const charactersActive = !readerActive && activeTab === "characters";
  const charactersView = useMemo(
    () => (
      <CharactersPanel
        active={charactersActive}
        onOpenStory={handleOpenStoryWithCharacter}
        onOpenStoryJump={handleOpenStoryJump}
      />
    ),
    [charactersActive, handleOpenStoryJump, handleOpenStoryWithCharacter]
  );

  const readerView = readerStory ? (
    <StoryReader
      key={readerStory.storyId}
      storyPath={readerStory.storyTxt}
      storyName={readerStory.storyName}
      storyId={readerStory.storyId}
      active={readerActive}
      initialCharacter={readerInitialCharacter ?? undefined}
      initialFocus={
        readerFocus && readerFocus.storyId === readerStory.storyId ? readerFocus : null
      }
      initialJump={
        readerInitialJump && readerInitialJump.storyId === readerStory.storyId
          ? readerInitialJump
          : null
      }
      onBack={handleBackToList}
      onNavigateStory={(next) => openReader(next)}
    />
  ) : null;

  // 面板全部常驻挂载（KeepAlive 只切可见性，保住滚动位置），所以
  // tabpanel 要一直存在并指回底部导航里对应的 tab 按钮。
  const panels: Array<{ tab: Tab; content: ReactNode }> = [
    { tab: "home", content: homeView },
    { tab: "stories", content: storyListView },
    { tab: "characters", content: charactersView },
    { tab: "search", content: searchView },
    { tab: "settings", content: settingsView },
  ];

  const appContent = (
    <div className="app-shell h-full flex flex-col overflow-hidden">
      <div className="relative flex-1 overflow-hidden">
        {/*
         * 阅读器是盖在 tab 层之上的整屏浮层，所以整层 tab 一起从无障碍树和
         * 焦点序列里摘掉。这里必须是真正的盒子：`display: contents` 不产生
         * 层叠/裁剪边界，inert 在部分 WebView 上也不会传到子树，隐藏 tab
         * 会和阅读器叠在同一视口里抢渲染。不要加 isolate：那会把面板内
         * z-50 模态封在包装层里，玻璃底栏会浮在同步框遮罩之上还能点。
         */}
        <div
          className="absolute inset-0 overflow-hidden"
          aria-hidden={readerActive}
          inert={readerActive}
        >
          {panels.map(({ tab, content }) => (
            <KeepAlive
              key={tab}
              active={!readerActive && activeTab === tab}
              className="absolute inset-0"
            >
              <div
                id={tabPanelId(tab)}
                role="tabpanel"
                aria-labelledby={tabButtonId(tab)}
                className="h-full"
              >
                {content}
              </div>
            </KeepAlive>
          ))}
        </div>
        {readerStory && (
          <KeepAlive active={readerActive} className="absolute inset-0">
            {readerView}
          </KeepAlive>
        )}
      </div>
      {!readerActive && <BottomNav activeTab={activeTab} onTabChange={handleTabChange} />}
    </div>
  );

  return (
    <ThemeProvider defaultTheme="system" storageKey="story-teller-theme">
      <ToastProvider>
        <AppUpdaterHost />
        <FavoritesProvider>
          <AppPreferencesProvider>
            <CharacterResolverProvider>{appContent}</CharacterResolverProvider>
          </AppPreferencesProvider>
        </FavoritesProvider>
      </ToastProvider>
    </ThemeProvider>
  );
}

export default App;
