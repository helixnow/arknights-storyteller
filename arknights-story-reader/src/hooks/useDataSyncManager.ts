import { useCallback, useEffect, useMemo, useState } from "react";
import { api, type SyncProgress } from "@/services/api";

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
      const current = await api.getCurrentVersion().catch(() => "");
      setCurrentVersion(current);
      const remote = await api.getRemoteVersion().catch(() => "未知");
      setRemoteVersion(remote);
      const needUpdate = await api.checkUpdate().catch(() => false);
      setHasUpdate(needUpdate);
    } catch (err) {
      console.error("[useDataSyncManager] 加载版本信息失败:", err);
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
      window.dispatchEvent(new Event("app:data-updated"));
      onSuccess?.();
      await loadVersionInfo();
      setProgress({ phase: "完成", current: 1, total: 1, message: "同步完成" });
    } catch (err) {
      const message = err instanceof Error ? err.message : "同步失败";
      console.error("[useDataSyncManager] 同步失败:", message, err);
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
          phase: "完成",
          current: 100,
          total: 100,
          message: "导入完成",
        });

        window.dispatchEvent(new Event("app:data-updated"));
        onSuccess?.();
        await loadVersionInfo();
      } catch (err) {
        const message = err instanceof Error ? err.message : "导入失败";
        console.error("[useDataSyncManager] 导入失败:", message, err);
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
