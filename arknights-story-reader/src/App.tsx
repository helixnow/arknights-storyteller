import { useCallback, useMemo, useState } from "react";
import { ThemeProvider } from "@/components/theme-provider";
import { StoryList } from "@/components/StoryList";
import { StoryReader } from "@/components/StoryReader";
import { SearchPanel } from "@/components/SearchPanel";
import { Settings } from "@/components/Settings";
import { BottomNav } from "@/components/BottomNav";
import type { StoryEntry } from "@/types/story";
import { FavoritesProvider } from "@/hooks/useFavorites";
import { ClueSetsProvider } from "@/hooks/useClueSets";
import { AppPreferencesProvider } from "@/hooks/useAppPreferences";
import { ClueSetsPanel } from "@/components/ClueSetsPanel";
import { ClueSetReader } from "@/components/ClueSetReader";
import { KeepAlive } from "@/components/KeepAlive";
import { CharactersPanel } from "@/components/CharactersPanel";
import { useAppUpdater } from "@/hooks/useAppUpdater";
import { useBackHandler } from "@/hooks/useBackHandler";
import { ToastProvider } from "@/components/ui/toast";

type Tab = "stories" | "characters" | "search" | "clues" | "settings";

interface ReaderFocus {
  storyId: string;
  query: string;
  snippet?: string | null;
  issuedAt: number;
}

function App() {
  useAppUpdater();
  const [activeTab, setActiveTab] = useState<Tab>("stories");
  const [readerVisible, setReaderVisible] = useState(false);
  const [readerStory, setReaderStory] = useState<StoryEntry | null>(null);
  const [readerFocus, setReaderFocus] = useState<ReaderFocus | null>(null);
  const [readerInitialCharacter, setReaderInitialCharacter] = useState<string | null>(null);
  const [readerInitialJump, setReaderInitialJump] = useState<{
    storyId: string;
    segmentIndex: number;
    digestHex?: string;
    preview?: string;
    issuedAt: number;
  } | null>(null);
  const [clueReaderSetId, setClueReaderSetId] = useState<string | null>(null);

  const readerActive = readerVisible && readerStory !== null;

  const handleSelectStory = useCallback((story: StoryEntry) => {
    console.log("[App] 选择剧情:", story.storyName);
    setReaderStory(story);
    setReaderFocus(null);
    setReaderInitialCharacter(null);
    setReaderInitialJump(null);
    setReaderVisible(true);
  }, []);

  const handleBackToList = useCallback(() => {
    console.log("[App] 返回剧情列表");
    setReaderVisible(false);
  }, []);

  const handleSearchResult = useCallback(
    (story: StoryEntry, focus: { query: string; snippet?: string | null }) => {
      console.log("[App] 搜索结果选择，storyId:", story.storyId);
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
      console.log("[App] 从人物面板打开剧情:", story.storyName, "角色:", character);
      setReaderStory(story);
      setReaderFocus(null);
      setReaderInitialCharacter(character);
      setReaderInitialJump(null);
      setReaderVisible(true);
    },
    []
  );

  const handleOpenStoryJump = useCallback(
    (story: StoryEntry, jump: { segmentIndex: number; digestHex?: string; preview?: string }) => {
      setReaderStory(story);
      setReaderFocus(null);
      setReaderInitialCharacter(null);
      setReaderInitialJump({ storyId: story.storyId, segmentIndex: jump.segmentIndex, digestHex: jump.digestHex, preview: jump.preview, issuedAt: Date.now() });
      setActiveTab("stories");
      setReaderVisible(true);
    },
    []
  );

  const handleTabChange = useCallback(
    (tab: Tab) => {
      if (readerActive) {
        setReaderVisible(false);
      }
      setActiveTab(tab);
    },
    [readerActive]
  );

  const handleReadClueSet = useCallback((setId: string) => {
    setClueReaderSetId(setId);
  }, []);

  // Android/Browser back-button: close open full-screen layers before falling
  // back to the system default. Priority: clue reader > story reader > ...
  useBackHandler(Boolean(clueReaderSetId), () => {
    setClueReaderSetId(null);
    return true;
  });
  useBackHandler(readerActive, () => {
    setReaderVisible(false);
    return true;
  });

  const storyListView = useMemo(
    () => <StoryList onSelectStory={handleSelectStory} />,
    [handleSelectStory]
  );
  const searchView = useMemo(
    () => <SearchPanel onSelectResult={handleSearchResult} />,
    [handleSearchResult]
  );
  const settingsView = useMemo(() => <Settings />, []);
  const cluesView = useMemo(
    () => <ClueSetsPanel onOpenStoryJump={handleOpenStoryJump} onReadSet={handleReadClueSet} />,
    [handleOpenStoryJump, handleReadClueSet]
  );

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
        readerInitialJump && readerInitialJump.storyId === readerStory.storyId ? readerInitialJump : null
      }
      onBack={handleBackToList}
    />
  ) : null;

  console.log(
    "[App] 当前状态 - activeTab:",
    activeTab,
    "readerVisible:",
    readerVisible,
    "readerStory:",
    readerStory?.storyName ?? null
  );

  const appContent = (
    <div className="h-full flex flex-col overflow-hidden pt-[calc(env(safe-area-inset-top,0px)+20px)]">
      <div className="relative flex-1 overflow-hidden">
        <KeepAlive active={!readerActive && activeTab === "stories"} className="absolute inset-0">
          {storyListView}
        </KeepAlive>
        <KeepAlive
          active={!readerActive && activeTab === "characters"}
          className="absolute inset-0"
        >
          <CharactersPanel onOpenStory={handleOpenStoryWithCharacter} />
        </KeepAlive>
        <KeepAlive active={!readerActive && activeTab === "search"} className="absolute inset-0">
          {searchView}
        </KeepAlive>
        <KeepAlive active={!readerActive && activeTab === "clues" && !clueReaderSetId} className="absolute inset-0">
          {cluesView}
        </KeepAlive>
        <KeepAlive active={!readerActive && activeTab === "settings"} className="absolute inset-0">
          {settingsView}
        </KeepAlive>
        {readerStory && (
          <KeepAlive active={readerActive} className="absolute inset-0">
            {readerView}
          </KeepAlive>
        )}
        {clueReaderSetId && (
          <KeepAlive active={Boolean(clueReaderSetId)} className="absolute inset-0">
            <ClueSetReader
              key={clueReaderSetId}
              setId={clueReaderSetId}
              onClose={() => setClueReaderSetId(null)}
              onOpenStoryJump={(story, jump) => {
                setClueReaderSetId(null);
                handleOpenStoryJump(story, jump);
              }}
            />
          </KeepAlive>
        )}
      </div>
      {!readerActive && !clueReaderSetId && <BottomNav activeTab={activeTab} onTabChange={handleTabChange} />}
    </div>
  );

  return (
    <ThemeProvider defaultTheme="system" storageKey="story-teller-theme">
      <ToastProvider>
        <FavoritesProvider>
          <AppPreferencesProvider>
            <ClueSetsProvider>
              {appContent}
            </ClueSetsProvider>
          </AppPreferencesProvider>
        </FavoritesProvider>
      </ToastProvider>
    </ThemeProvider>
  );
}

export default App;
