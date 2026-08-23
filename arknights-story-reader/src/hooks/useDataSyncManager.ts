import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { api, type SyncProgress } from "@/services/api";
import { devLog, devWarn } from "@/hooks/useAppUpdater";

interface UseDataSyncManagerOptions {
  active: boolean;
  onSuccess?: () => void;
}

/**
 * 会互相踩踏的重任务：同步/导入都在改数据目录，索引重建在读同一批文件，
 * 安装应用更新最后还会重启进程。它们同时跑轻则进度条打架，重则把数据写坏，
 * 所以共用一把进程内的任务锁。
 *
 * 锁必须放在模块作用域：设置页和 StoryList 里的同步对话框各持有一份
 * `useDataSyncManager`，组件内的 ref 拦不住「一边开着对话框同步、一边在设置页
 * 点同步」这种情况。
 */
export type DataJobKind = "sync" | "import" | "index" | "update";

const DATA_JOB_LABELS: Record<DataJobKind, string> = {
  sync: "同步剧情数据",
  import: "导入 ZIP",
  index: "重建全文索引",
  update: "安装应用更新",
};

let activeDataJob: DataJobKind | null = null;
const dataJobListeners = new Set<() => void>();

export function getActiveDataJob(): DataJobKind | null {
  return activeDataJob;
}

/** 任务名，用来在按钮旁边说明「现在是谁占着」。 */
export function describeDataJob(kind: DataJobKind): string {
  return DATA_JOB_LABELS[kind];
}

/** 抢锁失败时的统一话术：说清是哪个任务占着，而不是只把按钮灰掉。 */
export function dataJobConflictMessage(intent: string): string {
  const owner = getActiveDataJob();
  return owner
    ? `正在${DATA_JOB_LABELS[owner]}，请等待完成后再${intent}。`
    : `另一项数据任务正在进行，请稍后再${intent}。`;
}

function notifyDataJobListeners(): void {
  for (const listener of [...dataJobListeners]) listener();
}

/**
 * 抢占任务锁。被别的任务占着时返回 null，调用方负责给提示；
 * 拿到的释放函数可重复调用（finally 里调一次、卸载时再兜底调一次都安全）。
 */
export function acquireDataJob(kind: DataJobKind): (() => void) | null {
  if (activeDataJob !== null) return null;
  activeDataJob = kind;
  notifyDataJobListeners();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (activeDataJob === kind) {
      activeDataJob = null;
      notifyDataJobListeners();
    }
  };
}

function subscribeDataJob(listener: () => void): () => void {
  dataJobListeners.add(listener);
  return () => {
    dataJobListeners.delete(listener);
  };
}

/** 订阅任务锁，用于禁用冲突入口并显示占用者。 */
export function useActiveDataJob(): DataJobKind | null {
  return useSyncExternalStore(subscribeDataJob, getActiveDataJob, getActiveDataJob);
}

/** 终态进度多留一会儿让用户看清「完成」，之后自动收起。 */
const PROGRESS_DONE_LINGER_MS = 2200;
/** 后端长时间没有新进度时的兜底，避免进度条永远卡在中间。 */
const PROGRESS_STALL_TIMEOUT_MS = 30_000;

/**
 * 后端把错误统一成英文字符串抛过来（`Failed to ...` / `NOT_INSTALLED` 等），
 * 直接展示对用户毫无意义，这里按前缀翻译成可执行的中文提示。
 */
const BACKEND_ERROR_RULES: Array<[RegExp, string]> = [
  [/^NOT_INSTALLED$/i, "本机还没有剧情数据，请先同步或导入 ZIP。"],
  [/Failed to create http client/i, "网络组件初始化失败，请重启应用后重试。"],
  [/Failed to request latest commit/i, "无法连接 GitHub 获取版本信息，请检查网络或代理后重试。"],
  [/GitHub API returned status 403/i, "GitHub 接口触发访问限流，请稍后再试。"],
  [/GitHub API returned status (\d+)/i, "GitHub 接口返回异常状态 $1，请稍后再试。"],
  [/Failed to (?:parse commit response|read commit sha)/i, "GitHub 返回的数据无法解析，请稍后再试。"],
  [/Download returned status (\d+)/i, "下载失败，服务器返回状态 $1。"],
  [/Download failed/i, "下载失败，请检查网络或代理后重试。"],
  [/Failed to read download stream/i, "下载中断，请检查网络后重试。"],
  [
    /Failed to (?:create temp zip file|write zip data|flush zip file)/i,
    "写入临时文件失败，请确认磁盘剩余空间是否充足。",
  ],
  [/Failed to read zip archive/i, "无法解析 ZIP，压缩包可能已损坏或不是有效的数据包。"],
  [
    /Failed to (?:create (?:extract dir|parent directory|directory|file)|write file)/i,
    "解压写入失败，请确认磁盘空间与目录权限。",
  ],
  [/Failed to remove old data/i, "清理旧数据失败，请关闭占用数据目录的程序后重试。"],
  [
    /Failed to (?:create data directory|write version info)/i,
    "写入版本信息失败，请确认磁盘空间与目录权限。",
  ],
  [/Failed to (?:copy file|read directory|read entry|read file type)/i, "读写数据目录失败，请确认目录权限。"],
  [/Failed to (?:open|configure) .*database|Failed to (?:ensure index tables|init story index meta)/i,
    "索引数据库读写失败，可在设置中重建全文索引。"],
  [/Failed to parse/i, "数据解析失败，可能是数据包格式与当前版本不匹配。"],
  [/Failed to join .*task/i, "后台任务异常结束，请重试。"],
  [/Invalid data directory/i, "数据目录无效，请重新安装应用后重试。"],
  [
    /error sending request|dns error|connection (?:refused|reset|closed|aborted)|timed? ?out|tcp connect error|certificate|ECONN|ENOTFOUND/i,
    "网络连接失败，请检查网络或代理后重试。",
  ],
];

/** 把后端错误翻成中文；识别不了的英文原文加上中文前缀，中文原文原样透出。 */
export function localizeBackendError(error: unknown, fallback = "操作失败"): string {
  const raw = error instanceof Error ? error.message : typeof error === "string" ? error : String(error ?? "");
  const text = raw.trim();
  if (!text) return fallback;

  for (const [pattern, template] of BACKEND_ERROR_RULES) {
    const match = text.match(pattern);
    if (match) {
      return template.replace(/\$(\d)/g, (_, index: string) => match[Number(index)] ?? "");
    }
  }

  // 不含中文说明是没被规则覆盖到的后端原文，补个中文前缀再展示。
  return /[\u4e00-\u9fff]/.test(text) ? text : `${fallback}：${text}`;
}

function isTerminalProgress(progress: SyncProgress): boolean {
  return progress.phase === "完成" || (progress.total > 0 && progress.current >= progress.total);
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

  const mountedRef = useRef(true);
  /** 同步/导入是否在途；用 ref 是因为按钮的防抖判断等不到 state 落地。 */
  const busyRef = useRef(false);
  const clearTimerRef = useRef<number | null>(null);
  const onSuccessRef = useRef(onSuccess);

  useEffect(() => {
    onSuccessRef.current = onSuccess;
  }, [onSuccess]);

  const cancelAutoClear = useCallback(() => {
    if (clearTimerRef.current !== null) {
      window.clearTimeout(clearTimerRef.current);
      clearTimerRef.current = null;
    }
  }, []);

  const scheduleAutoClear = useCallback(
    (delay: number) => {
      cancelAutoClear();
      clearTimerRef.current = window.setTimeout(() => {
        clearTimerRef.current = null;
        if (mountedRef.current && !busyRef.current) setProgress(null);
      }, delay);
    },
    [cancelAutoClear]
  );

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (clearTimerRef.current !== null) {
        window.clearTimeout(clearTimerRef.current);
        clearTimerRef.current = null;
      }
    };
  }, []);

  const loadVersionInfo = useCallback(async (options: { silent?: boolean } = {}) => {
    const { silent = false } = options;
    setLoadingInfo(true);
    let failure: unknown = null;
    try {
      const current = await api.getCurrentVersion().catch((err) => {
        failure ??= err;
        return "";
      });
      if (!mountedRef.current) return;
      setCurrentVersion(current);

      const remote = await api.getRemoteVersion().catch((err) => {
        failure ??= err;
        return "";
      });
      if (!mountedRef.current) return;
      setRemoteVersion(remote);

      const needUpdate = await api.checkUpdate().catch((err) => {
        failure ??= err;
        return false;
      });
      if (!mountedRef.current) return;
      setHasUpdate(needUpdate);

      if (failure) {
        devWarn("[useDataSyncManager] 加载版本信息部分失败:", failure);
        // 远程信息拿不到不影响本地阅读，静默模式（同步/导入之后的自动刷新）
        // 不该把用户刚看到的成功状态盖成红色报错。
        if (!silent) {
          setError(localizeBackendError(failure, "加载版本信息失败"));
        }
      }
    } finally {
      if (mountedRef.current) setLoadingInfo(false);
    }
  }, []);

  useEffect(() => {
    if (!active) return;
    void loadVersionInfo({ silent: true });
  }, [active, loadVersionInfo]);

  useEffect(() => {
    const unlistenPromise = api.onSyncProgress((p) => {
      if (!mountedRef.current) return;
      setProgress(p);
      // 后端的索引重建是异步线程，会在 sync_data 返回之后继续发进度；
      // 这里跟着刷新收起计时，既能显示后续阶段，也不会永远挂在 100%。
      if (busyRef.current) {
        cancelAutoClear();
      } else {
        scheduleAutoClear(isTerminalProgress(p) ? PROGRESS_DONE_LINGER_MS : PROGRESS_STALL_TIMEOUT_MS);
      }
    });

    return () => {
      unlistenPromise
        .then((unlisten) => unlisten())
        .catch((err) => devWarn("[useDataSyncManager] 移除进度监听器失败:", err));
    };
  }, [cancelAutoClear, scheduleAutoClear]);

  const handleSync = useCallback(async () => {
    if (busyRef.current) return;
    const releaseJob = acquireDataJob("sync");
    if (!releaseJob) {
      setError(dataJobConflictMessage("同步"));
      return;
    }
    busyRef.current = true;
    cancelAutoClear();
    setSyncing(true);
    setError(null);
    setProgress({ phase: "准备", current: 0, total: 1, message: "准备开始..." });
    try {
      await api.syncData();
      window.dispatchEvent(new Event("app:data-updated"));
      onSuccessRef.current?.();
      await loadVersionInfo({ silent: true });
      if (mountedRef.current) {
        setProgress({ phase: "完成", current: 1, total: 1, message: "同步完成" });
      }
    } catch (err) {
      devWarn("[useDataSyncManager] 同步失败:", err);
      if (mountedRef.current) {
        // 失败时收掉进度条，只留错误卡片，免得半截进度和报错互相打架。
        setProgress(null);
        setError(localizeBackendError(err, "同步失败"));
      }
    } finally {
      releaseJob();
      busyRef.current = false;
      if (mountedRef.current) {
        setSyncing(false);
        scheduleAutoClear(PROGRESS_DONE_LINGER_MS);
      }
    }
  }, [cancelAutoClear, loadVersionInfo, scheduleAutoClear]);

  const runImport = useCallback(
    async (label: string, run: () => Promise<void>) => {
      if (busyRef.current) return;
      const releaseJob = acquireDataJob("import");
      if (!releaseJob) {
        setError(dataJobConflictMessage("导入"));
        return;
      }
      busyRef.current = true;
      cancelAutoClear();
      setImporting(true);
      setError(null);
      setProgress({ phase: "导入", current: 0, total: 100, message: label });
      try {
        await run();
        window.dispatchEvent(new Event("app:data-updated"));
        onSuccessRef.current?.();
        await loadVersionInfo({ silent: true });
        if (mountedRef.current) {
          setProgress({ phase: "完成", current: 100, total: 100, message: "导入完成" });
        }
      } catch (err) {
        devWarn("[useDataSyncManager] 导入失败:", err);
        if (mountedRef.current) {
          setProgress(null);
          setError(localizeBackendError(err, "导入失败"));
        }
      } finally {
        releaseJob();
        busyRef.current = false;
        if (mountedRef.current) {
          setImporting(false);
          scheduleAutoClear(PROGRESS_DONE_LINGER_MS);
        }
      }
    },
    [cancelAutoClear, loadVersionInfo, scheduleAutoClear]
  );

  const importFromFile = useCallback(
    async (file: File) => {
      await runImport(`正在读取 ${file.name}`, async () => {
        const buffer = await file.arrayBuffer();
        const bytes = new Uint8Array(buffer);
        devLog("[useDataSyncManager] 导入 ZIP 字节数:", bytes.byteLength);
        if (mountedRef.current) {
          setProgress({ phase: "导入", current: 20, total: 100, message: "正在传输 ZIP 数据…" });
        }
        await api.importZipFromBytes(bytes);
      });
    },
    [runImport]
  );

  /** 桌面端按路径导入：整包不经过 JS 堆，但 UI 状态要和字节流导入完全一致。 */
  const importFromPath = useCallback(
    async (path: string) => {
      await runImport("正在读取所选压缩包…", async () => {
        await api.importFromZip(path);
      });
    },
    [runImport]
  );

  const resetProgress = useCallback(() => {
    cancelAutoClear();
    setProgress(null);
  }, [cancelAutoClear]);

  const status = useMemo(() => {
    if (!currentVersion || currentVersion === "未安装") {
      return "not-installed" as const;
    }
    if (hasUpdate) {
      return "update-available" as const;
    }
    return "up-to-date" as const;
  }, [currentVersion, hasUpdate]);

  const busy = syncing || importing;
  const activeJob = useActiveDataJob();
  /** 锁被本组件之外的任务占着：按钮要禁用，并且得说明在等谁。 */
  const blockedBy = activeJob && !busy ? activeJob : null;

  return {
    syncing,
    importing,
    busy,
    activeJob,
    blockedBy,
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
    importFromPath,
    loadVersionInfo,
    resetProgress,
  };
}
