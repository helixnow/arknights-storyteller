import { useEffect, useRef } from "react";
import { api } from "@/services/api";

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
 *   - 全过程不占主线程，也不弹 toast，成功失败都只写 console。
 *
 * 同时派发 `app:story-index-updated` 事件，让 SearchPanel 等 UI 订阅
 * 刷新状态条。
 */
export function useAutoIndex() {
  // 单例 flag：React StrictMode / Tab 重挂载都不要重复触发
  const triggeredRef = useRef(false);

  useEffect(() => {
    if (triggeredRef.current) return;
    triggeredRef.current = true;

    let cancelled = false;

    const run = async () => {
      try {
        const installed = await api.isInstalled();
        if (cancelled || !installed) return;

        const status = await api.getStoryIndexStatus();
        if (cancelled) return;

        if (status.ready) {
          // 已经就绪，告知 UI 可以直接走索引路径。
          dispatchIndexUpdated();
          return;
        }

        // 后端的 rebuild 是同步阻塞调用，但 Rust 侧用 spawn_blocking 跑在
        // 线程池，不会卡住 UI。前端这里直接 await；成功后再派发事件。
        console.log("[useAutoIndex] 检测到索引未就绪，自动后台重建…");
        await api.buildStoryIndex();
        if (cancelled) return;
        console.log("[useAutoIndex] 索引重建完成");
        dispatchIndexUpdated();
      } catch (err) {
        console.warn("[useAutoIndex] 自动索引任务失败，搜索将回退到线性扫描", err);
      }
    };

    // 不阻塞主线程，也不抢首屏 CPU——稍微延后一丢丢让首屏渲染先跑完。
    const timer = window.setTimeout(() => {
      void run();
    }, 500);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, []);
}

function dispatchIndexUpdated() {
  try {
    window.dispatchEvent(new Event("app:story-index-updated"));
  } catch {
    /* ignore */
  }
}
