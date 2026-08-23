import { useCallback, useEffect, useMemo, useState } from "react";
import { ThemeProvider } from "@/components/theme-provider";
import { StoryList } from "@/components/StoryList";
import { StoryReader } from "@/components/StoryReader";
import { SearchPanel } from "@/components/SearchPanel";
import { Settings } from "@/components/Settings";
import { BottomNav, tabPanelId } from "@/components/BottomNav";
import { HomePanel } from "@/components/HomePanel";
import type { StoryEntry } from "@/types/story";
import { FavoritesProvider } from "@/hooks/useFavorites";
import { AppPreferencesProvider } from "@/hooks/useAppPreferences";
import { CharacterResolverProvider } from "@/hooks/useCharacterResolver";
import { KeepAlive } from "@/components/KeepAlive";
import { CharactersPanel } from "@/components/CharactersPanel";
import { useAppUpdater } from "@/hooks/useAppUpdater";
import { useBackHandler } from "@/hooks/useBackHandler";
import { useAutoIndex } from "@/hooks/useAutoIndex";
import { useLegacyStorageCleanup } from "@/hooks/useLegacyStorageCleanup";
import { ToastProvider } from "@/components/ui/toast";

type Tab = "home" | "stories" | "characters" | "search" | "settings";

interface ReaderFocus {
  storyId: string;
  query: string;
  snippet?: string | null;
  issuedAt: number;
}

function App() {
  useAppUpdater();
  useAutoIndex();
  useLegacyStorageCleanup();
  const [activeTab, setActiveTab] = useState<Tab>("home");
  const [readerVisible, setReaderVisible] = useState(false);
  const [readerStory, setReaderStory] = useState<StoryEntry | null>(null);
  const [readerFocus, setReaderFocus] = useState<ReaderFocus | null>(null);
  const [readerInitialCharacter, setReaderInitialCharacter] = useState<string | null>(null);
  const [readerInitialJump, setReaderInitialJump] = useState<{
    storyId: string;
    segmentIndex: number;
    preview?: string;
    issuedAt: number;
  } | null>(null);
  const readerActive = readerVisible && readerStory !== null;

  const handleSelectStory = useCallback((story: StoryEntry) => {
    setReaderStory(story);
    setReaderFocus(null);
    setReaderInitialCharacter(null);
    setReaderInitialJump(null);
    setReaderVisible(true);
  }, []);

  const handleBackToList = useCallback(() => {
    setReaderVisible(false);
    window.dispatchEvent(new Event("app:home-refresh"));
  }, []);

  const handleSearchResult = useCallback(
    (story: StoryEntry, focus: { query: string; snippet?: string | null }) => {
      setReaderStory(story);
      setReaderFocus({
        storyId: story.storyId,
        query: focus.query,
        snippet: focus.snippet,
        issuedAt: Date.now(),
      });
      setReaderInitialCharacter(null);
      setReaderInitialJump(null);
      setReaderVisible(true);
    },
    []
  );

  const handleOpenStoryWithCharacter = useCallback(
    (story: StoryEntry, character: string) => {
      setReaderStory(story);
      setReaderFocus(null);
      setReaderInitialCharacter(character);
      setReaderInitialJump(null);
      setReaderVisible(true);
    },
    []
  );

  const handleOpenStoryJump = useCallback(
    (story: StoryEntry, jump: { segmentIndex: number; preview?: string }) => {
      setReaderStory(story);
      setReaderFocus(null);
      setReaderInitialCharacter(null);
      setReaderInitialJump({
        storyId: story.storyId,
        segmentIndex: jump.segmentIndex,
        preview: jump.preview,
        issuedAt: Date.now(),
      });
      setReaderVisible(true);
    },
    []
  );

  const handleTabChange = useCallback((tab: Tab) => {
    setActiveTab(tab);
  }, []);

  const handleGoToTab = useCallback((tab: Tab) => {
    setActiveTab(tab);
    setReaderVisible(false);
  }, []);

  useEffect(() => {
    const onGoTab = (event: Event) => {
      const detail = (event as CustomEvent<Tab>).detail;
      if (detail) handleGoToTab(detail);
    };
    window.addEventListener("app:go-tab", onGoTab as EventListener);
    return () => window.removeEventListener("app:go-tab", onGoTab as EventListener);
  }, [handleGoToTab]);

  useBackHandler(readerActive, () => {
    handleBackToList();
    return true;
  });

  useBackHandler(!readerActive && activeTab !== "home", () => {
    setActiveTab("home");
    return true;
  });

  useBackHandler(!readerActive && activeTab === "home", () => false);

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

  const readerView = readerStory ? (
    <StoryReader
      key={readerStory.storyId}
      storyPath={readerStory.storyTxt}
      storyName={readerStory.storyName}
      storyId={readerStory.storyId}
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
      onNavigateStory={(next) => {
        setReaderStory(next);
        setReaderFocus(null);
        setReaderInitialCharacter(null);
        setReaderInitialJump(null);
      }}
    />
  ) : null;

  const appContent = (
    <div className="h-full flex flex-col overflow-hidden pt-[max(env(safe-area-inset-top,0px),12px)]">
      <div className="relative flex-1 overflow-hidden">
        <KeepAlive
          active={!readerActive && activeTab === "home"}
          className="absolute inset-0"
        >
          <div id={tabPanelId("home")} role="tabpanel" className="h-full">
            {homeView}
          </div>
        </KeepAlive>
        <KeepAlive
          active={!readerActive && activeTab === "stories"}
          className="absolute inset-0"
        >
          <div id={tabPanelId("stories")} role="tabpanel" className="h-full">
            {storyListView}
          </div>
        </KeepAlive>
        <KeepAlive
          active={!readerActive && activeTab === "characters"}
          className="absolute inset-0"
        >
          <div id={tabPanelId("characters")} role="tabpanel" className="h-full">
            <CharactersPanel
              active={!readerActive && activeTab === "characters"}
              onOpenStory={handleOpenStoryWithCharacter}
              onOpenStoryJump={(story, jump) => handleOpenStoryJump(story, jump)}
            />
          </div>
        </KeepAlive>
        <KeepAlive
          active={!readerActive && activeTab === "search"}
          className="absolute inset-0"
        >
          <div id={tabPanelId("search")} role="tabpanel" className="h-full">
            {searchView}
          </div>
        </KeepAlive>
        <KeepAlive
          active={!readerActive && activeTab === "settings"}
          className="absolute inset-0"
        >
          <div id={tabPanelId("settings")} role="tabpanel" className="h-full">
            {settingsView}
          </div>
        </KeepAlive>
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
