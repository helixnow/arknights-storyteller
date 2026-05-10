import { useCallback, useEffect, useMemo, useState } from "react";
import { api, type SyncProgress } from "@/services/api";
import { logger } from "@/lib/logger";

interface UseDataSyncManagerOptions {
  active: boolean;
  onSuccess?: () => void;
}

export function useDataSyncManager({ active, onSuccess }: UseDataSyncManagerOptions) {
  const [syncing, setSyncing] = useState(false);
  const [importing, setImporting] = useState(false);
  const [loadingInfo, setLoadingInfo] = useState(false);
  const [progress, setProgress] = useState<SyncProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [currentVersion, setCurrentVersion] = useState<string>("");
  const [remoteVersion, setRemoteVersion] = useState<string>("");
  const [hasUpdate, setHasUpdate] = useState<boolean>(false);

  const loadVersionInfo = useCallback(async () => {
    setLoadingInfo(true);
    try {
      const [current, remote, needUpdate] = await Promise.all([
        api.getCurrentVersion(),
        api.getRemoteVersion(),
        api.checkUpdate(),
      ]);
      setCurrentVersion(current);
      setRemoteVersion(remote);
      setHasUpdate(needUpdate);
    } catch (err) {
      logger.error("useDataSyncManager", "加载版本信息失败:", err);
      setError((err instanceof Error ? err.message : "加载版本信息失败") ?? "加载版本信息失败");
    } finally {
      setLoadingInfo(false);
    }
  }, []);

  useEffect(() => {
    if (!active) return;
    void loadVersionInfo();
  }, [active, loadVersionInfo]);

  useEffect(() => {
    const unlistenPromise = api.onSyncProgress((p) => {
      setProgress(p);
    });

    return () => {
      unlistenPromise
        .then((unlisten) => unlisten())
        .catch((err) => console.warn("[useDataSyncManager] 移除进度监听器失败:", err));
    };
  }, []);

  const handleSync = useCallback(async () => {
    try {
      setSyncing(true);
      setError(null);
      setProgress({ phase: "准备", current: 0, total: 1, message: "准备开始..." });
      await api.syncData();
      onSuccess?.();
      // 同步完成后自动建立全文索引，减少用户手动点击
      try {
        setProgress({ phase: "索引", current: 0, total: 1, message: "正在建立全文索引…" });
        await api.buildStoryIndex();
        setProgress({ phase: "索引", current: 1, total: 1, message: "索引完成" });
        // 通知搜索面板刷新索引状态（兼容已有监听）
        try { window.dispatchEvent(new CustomEvent("app:rebuild-story-index")); } catch {}
      } catch (e) {
        logger.warn("useDataSyncManager", "自动建立索引失败", e);
      }
      
      // 清空搜索缓存，防止返回陈旧结果
      try {
        localStorage.removeItem("arknights-story-search-cache-v1");
      } catch {}
      
      await loadVersionInfo();
    } catch (err) {
      const message = err instanceof Error ? err.message : "同步失败";
      logger.error("useDataSyncManager", "同步失败:", message, err);
      setError(message);
    } finally {
      setSyncing(false);
    }
  }, [loadVersionInfo, onSuccess]);

  const importFromFile = useCallback(
    async (file: File) => {
      try {
        setImporting(true);
        setError(null);

        setProgress({
          phase: "导入",
          current: 0,
          total: 100,
          message: `正在读取 ${file.name}`,
        });

        const buffer = await file.arrayBuffer();
        const bytes = new Uint8Array(buffer);

        setProgress({
          phase: "导入",
          current: 20,
          total: 100,
          message: "正在传输 ZIP 数据…",
        });

        await api.importZipFromBytes(bytes);

        setProgress({
          phase: "导入",
          current: 40,
          total: 100,
          message: "正在校验 ZIP 文件…",
        });

        onSuccess?.();
        // 导入完成后自动建立全文索引
        try {
          setProgress({ phase: "索引", current: 0, total: 1, message: "正在建立全文索引…" });
          await api.buildStoryIndex();
          setProgress({ phase: "索引", current: 1, total: 1, message: "索引完成" });
          try { window.dispatchEvent(new CustomEvent("app:rebuild-story-index")); } catch {}
        } catch (e) {
          logger.warn("useDataSyncManager", "导入后自动建立索引失败", e);
        }
        
        // 清空搜索缓存
        try {
          localStorage.removeItem("arknights-story-search-cache-v1");
        } catch {}
        
        await loadVersionInfo();
      } catch (err) {
        const message = err instanceof Error ? err.message : "导入失败";
        logger.error("useDataSyncManager", "导入失败:", message, err);
        setError(message);
      } finally {
        setImporting(false);
      }
    },
    [loadVersionInfo, onSuccess]
  );

  const resetProgress = useCallback(() => setProgress(null), []);

  const status = useMemo(() => {
    if (!currentVersion || currentVersion === "未安装") {
      return "not-installed" as const;
    }
    if (hasUpdate) {
      return "update-available" as const;
    }
    return "up-to-date" as const;
  }, [currentVersion, hasUpdate]);

  return {
    syncing,
    importing,
    loadingInfo,
    progress,
    error,
    setError,
    currentVersion,
    remoteVersion,
    hasUpdate,
    status,
    handleSync,
    importFromFile,
    loadVersionInfo,
    resetProgress,
  };
}
