import { useEffect } from "react";
import { api } from "@/services/api";
import { acquireDataJob, describeDataJob, getActiveDataJob } from "@/hooks/useDataSyncManager";
import type { StoryIndexStatus } from "@/types/story";

/** 首屏渲染先跑完，再去碰磁盘。 */
const INITIAL_DELAY_MS = 500;
/** 数据刚换过：给后端自带的重建留出启动时间，再决定要不要兜底。 */
const AFTER_DATA_UPDATE_DELAY_MS = 3000;
/** 超过这么久没有新的 index-progress，就认为那次重建已经结束/死掉了。 */
const INDEX_PROGRESS_STALE_MS = 60_000;
/** 让路之后过多久再回来看一眼。 */
const RETRY_DELAY_MS = 10_000;
/** 一直有人占着就别死等：留给用户手动重建，省得后台无限轮询。 */
const MAX_DEFERRALS = 6;

/**
 * 在应用启动时悄悄把全文索引准备好。
 *
 * 后端的 `sync_data` / `import_zip_from_bytes` 已经会在数据更新后自动
 * 重建索引，但以下三种情况仍会出现「索引未就绪」：
 *   1. 老版本装好后升级到带索引的新版本，本地还没有索引；
 *   2. 上次索引重建中途失败（崩溃、断电）；
 *   3. 用户手动清除了 sqlite 数据目录但没重新导入。
 *
 * 任何一种情况下，都应该由应用自己启动后台重建，而不是逼用户去「设置」或
 * 「搜索」页点「刷新索引」。这个 hook 做的就是这件事：
 *   - 等到数据已安装；
 *   - 检查索引状态；
 *   - 未就绪就触发 `build_story_index`，交给后端线程跑；
 *   - 全过程不占主线程，也不弹 toast；日志只在开发构建里打，线上保持安静。
 *
 * 关键是「不跟人抢」：同步/导入在跑、用户自己点了重建、后端正在发索引进度，
 * 这三种情况都直接让路——多跑一次重建不会更快，只会让两个写库任务互相拖慢，
 * 还会让搜索页的进度条来回跳。
 *
 * 每次检查完都派发 `app:story-index-updated`（带上 detail 里的状态快照），
 * 让 SearchPanel 等 UI 立刻把「索引尚未就绪」的提示刷出来，而不是等用户
 * 切到搜索页才发现搜索退化成了逐篇扫描。
 */
export function useAutoIndex() {
  useEffect(() => {
    let cancelled = false;
    /** 本 hook 自己发起的重建在途；和全局任务锁一起用，避免重复触发。 */
    let running = false;
    let lastIndexProgressAt = 0;
    let backendBuilding = false;
    let deferrals = 0;
    /** 上一次广播出去的状态，用来去重，避免退让期间反复惊动监听方。 */
    let lastBroadcast: string | null = null;
    const timers = new Set<number>();

    const later = (fn: () => void, delay: number) => {
      const timer = window.setTimeout(() => {
        timers.delete(timer);
        if (!cancelled) fn();
      }, delay);
      timers.add(timer);
    };

    /** 后端正在重建（不管是谁点的）：有新鲜进度事件就算。 */
    const isBackendBuilding = () =>
      backendBuilding && Date.now() - lastIndexProgressAt < INDEX_PROGRESS_STALE_MS;

    /** 别人占着的时候只是让路，不是放弃：过一会儿回来补一次兜底。 */
    const deferRetry = (reason: string) => {
      if (deferrals >= MAX_DEFERRALS) return;
      deferrals += 1;
      later(() => void ensureIndex(reason), RETRY_DELAY_MS);
    };

    const broadcast = (status: StoryIndexStatus | null, reason: string) => {
      const signature = `${status?.ready ?? false}:${status?.total ?? 0}`;
      if (signature === lastBroadcast) return;
      lastBroadcast = signature;
      dispatchIndexUpdated(status, reason);
    };

    const ensureIndex = async (reason: string) => {
      if (cancelled || running) return;
      running = true;
      try {
        const installed = await api.isInstalled();
        if (cancelled || !installed) return;

        const status = await api.getStoryIndexStatus();
        if (cancelled) return;

        // 无论就绪与否都广播：UI 得知道现在到底能不能走索引搜索，
        // 「数据换过之后索引还没跟上」这件事必须当场看得见。
        broadcast(status, reason);
        if (status.ready) {
          deferrals = 0;
          return;
        }

        if (isBackendBuilding()) {
          // 这里不能走 deferRetry 消耗让路预算：预算总共 6×10s=60s，而
          // 「停更即死」的判定窗也是 60s——后端自动重建失败时不发终态
          // index-progress（失败通知走 sync-progress），只要它发过几秒进度
          // 再死（磁盘满、IO 错都是这种形态），预算必先于判定窗耗尽，
          // 兜底重建从此整个会话不再发生。改为定到停更判定刚好过期的
          // 时刻回来：活着的重建会用新进度把下次检查继续往后推（约每
          // 60s 读一次状态），死掉的则在判定过期后立刻接手；索引一就绪
          // 就停，不会无限轮询。让路预算只留给下面的锁竞争分支。
          devLog(`索引未就绪，但后端已在重建，等它结束或停更再看（${reason}）`);
          later(
            () => void ensureIndex(reason),
            Math.max(RETRY_DELAY_MS, lastIndexProgressAt + INDEX_PROGRESS_STALE_MS - Date.now() + 1_000)
          );
          return;
        }

        // 同步/导入结束后后端会自己重建；用户点的重建也占着这把锁。
        const release = acquireDataJob("index");
        if (!release) {
          const owner = getActiveDataJob();
          devLog(`索引未就绪，但「${owner ? describeDataJob(owner) : "其他任务"}」占用中，稍后再看（${reason}）`);
          deferRetry(reason);
          return;
        }
        try {
          devLog(`检测到索引未就绪，自动后台重建…（${reason}）`);
          await api.buildStoryIndex();
        } finally {
          release();
        }
        if (cancelled) return;

        devLog("索引重建完成");
        deferrals = 0;
        const rebuilt = await api.getStoryIndexStatus().catch(() => null);
        if (cancelled) return;
        // reason 不能叫 "rebuilt"：那是搜索面板重建收场广播的专用终态，
        // 设置页收到就会释放它持有的 "index" 任务锁。上面 release() 之后
        // 设置页可能立刻抢到锁发起新一轮重建，这条广播若冒用同名终态，
        // 会把那次还在跑的重建的锁提前放掉，同步/导入就能趁虚而入。
        broadcast(rebuilt, "auto-rebuilt");
      } catch (err) {
        // 失败不影响可用性：后端搜索会退回线性扫描，UI 也有"刷新索引"入口。
        devLog("自动索引任务失败，搜索将回退到线性扫描", err);
      } finally {
        running = false;
      }
    };

    // 后端重建进度是「有人在写索引」的唯一可靠信号，和发起方无关。
    let disposeProgress: (() => void) | null = null;
    void api
      .onIndexProgress((p) => {
        lastIndexProgressAt = Date.now();
        backendBuilding = !(p.total > 0 && p.current >= p.total);
      })
      .then((unlisten) => {
        if (cancelled) {
          unlisten();
          return;
        }
        disposeProgress = unlisten;
      })
      .catch((err) => devLog("监听索引进度失败", err));

    // 用户在搜索页/设置页点了重建：把自动流程整个让出去。
    const onUserRebuild = () => {
      lastIndexProgressAt = Date.now();
      backendBuilding = true;
    };
    // 数据换过之后索引必然过期。后端通常会自己重建，这里只做兜底与状态广播。
    const onDataUpdated = () => {
      deferrals = 0;
      lastBroadcast = null;
      later(() => void ensureIndex("data-updated"), AFTER_DATA_UPDATE_DELAY_MS);
    };

    window.addEventListener("app:rebuild-story-index", onUserRebuild);
    window.addEventListener("app:data-updated", onDataUpdated);
    later(() => void ensureIndex("startup"), INITIAL_DELAY_MS);

    return () => {
      cancelled = true;
      for (const timer of timers) window.clearTimeout(timer);
      timers.clear();
      window.removeEventListener("app:rebuild-story-index", onUserRebuild);
      window.removeEventListener("app:data-updated", onDataUpdated);
      disposeProgress?.();
    };
  }, []);
}

function devLog(message: string, err?: unknown) {
  if (!import.meta.env.DEV) return;
  if (err === undefined) {
    console.info(`[useAutoIndex] ${message}`);
  } else {
    console.warn(`[useAutoIndex] ${message}`, err);
  }
}

/**
 * 事件名保持不变（SearchPanel 等已在监听），只额外带上状态快照：
 * 老监听者忽略 detail 即可，新监听者可以直接拿到「是否过期」的判断依据。
 */
function dispatchIndexUpdated(status: StoryIndexStatus | null, reason: string) {
  try {
    window.dispatchEvent(
      new CustomEvent("app:story-index-updated", {
        detail: { ready: status?.ready ?? false, total: status?.total ?? 0, reason },
      })
    );
  } catch {
    /* ignore */
  }
}
