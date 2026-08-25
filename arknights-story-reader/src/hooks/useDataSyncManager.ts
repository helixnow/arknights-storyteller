import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { api, type SyncProgress } from "@/services/api";
import { devLog, devWarn } from "@/hooks/useAppUpdater";
import {
  PROGRESS_DONE_LINGER_MS,
  PROGRESS_FAIL_LINGER_MS,
  describeImportTransferFailure,
  isFailureSyncProgress,
  isTerminalSyncProgress,
  localizeDataError,
  shouldAbortImportTransfer,
  syncProgressLingerMs,
} from "@/hooks/dataSyncUtils";
import {
  dataJobLock,
  type DataJobKind,
} from "@/hooks/dataJobLock";

export type { DataJobKind } from "@/hooks/dataJobLock";

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
const DATA_JOB_LABELS: Record<DataJobKind, string> = {
  sync: "同步剧情数据",
  import: "导入 ZIP",
  index: "重建全文索引",
  update: "安装应用更新",
};

export function getActiveDataJob(): DataJobKind | null {
  return dataJobLock.getSnapshot();
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

/**
 * 抢占任务锁。被别的任务占着时返回 null，调用方负责给提示；
 * 拿到的释放函数可重复调用（finally 里调一次、卸载时再兜底调一次都安全）。
 */
export function acquireDataJob(kind: DataJobKind): (() => void) | null {
  return dataJobLock.acquire(kind);
}

/**
 * 等到锁空闲后再抢。给「用户已经点头确认、但此刻恰好有任务在跑」的流程用：
 * 立刻放弃会把用户的确认静默吞掉，无限等待又可能永远不结束，所以带超时，
 * 超时返回 null 由调用方决定怎么收场。多个等待者被同一次释放唤醒时只有
 * 先抢到的成功，其余继续等自己的超时。
 */
export function acquireDataJobWhenIdle(kind: DataJobKind, timeoutMs: number): Promise<(() => void) | null> {
  return dataJobLock.acquireWhenIdle(kind, timeoutMs);
}

/** 订阅任务锁，用于禁用冲突入口并显示占用者。 */
export function useActiveDataJob(): DataJobKind | null {
  return useSyncExternalStore(dataJobLock.subscribe, getActiveDataJob, getActiveDataJob);
}

/**
 * 分块导入的块大小。太小徒增 IPC 往返；太大则单块的 base64 字符串
 * （约 4/3 倍体积）会顶高 WebView 峰值内存——Android 的 IPC 会把整条
 * 消息再序列化一次。4 MiB 时单块开销约 11 MB，几百 MB 的包也只要
 * 一百来次往返。
 */
const IMPORT_CHUNK_BYTES = 4 * 1024 * 1024;

/**
 * Blob 切片 → base64（去掉 dataURL 前缀）。用 FileReader 的原生编码器，
 * 不在 JS 里手搓字节循环；每次只读一块，内存与文件总大小无关。
 */
function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error("读取文件失败"));
    reader.onload = () => {
      const text = String(reader.result);
      resolve(text.slice(text.indexOf(",") + 1));
    };
    reader.readAsDataURL(blob);
  });
}

/** 把后端错误翻成中文；识别不了的英文原文加上中文前缀，中文原文原样透出。 */
export function localizeBackendError(error: unknown, fallback = "操作失败"): string {
  return localizeDataError(error, fallback);
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
  /**
   * 当前展示的进度是不是失败终态。收尾的 scheduleAutoClear 在 finally 里
   * 拿不到最新 state（闭包里是旧值），失败通知不能按「完成」的 2.2s 收起，
   * 只能用 ref 镜像一份。事件监听里跟着每条进度刷新；本地写进度（起步、
   * 分块传输）都是非终态，写的同时清掉。
   */
  const progressIsFailureRef = useRef(false);
  /** loadVersionInfo 的代际号：慢的旧请求不许覆盖新请求已写入的结果。 */
  const loadSeqRef = useRef(0);
  const onSuccessRef = useRef(onSuccess);
  const importCancelRef = useRef(false);

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
        if (mountedRef.current && !busyRef.current) {
          setProgress(null);
          progressIsFailureRef.current = false;
        }
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
    // 入口不止一个（挂载、app:data-updated 广播、同步/导入收尾、手动刷新），
    // 并发调用的三段 await 会交错：慢的旧请求晚到，会把新请求刚写好的版本
    // 信息盖回过期值（同步刚完成又显示回「未安装」）；旧请求先收尾还会把
    // loadingInfo 提前关掉，「读取中...」闪成「未知」再跳回。带上代际号，
    // 只允许最新一代落状态，旧代一律整段作废。
    const seq = ++loadSeqRef.current;
    const isStale = () => !mountedRef.current || seq !== loadSeqRef.current;
    setLoadingInfo(true);
    let failure: unknown = null;
    try {
      const current = await api.getCurrentVersion().catch((err) => {
        failure ??= err;
        return "";
      });
      if (isStale()) return;
      setCurrentVersion(current);

      const remote = await api.getRemoteVersion().catch((err) => {
        failure ??= err;
        return "";
      });
      if (isStale()) return;
      setRemoteVersion(remote);

      const needUpdate = await api.checkUpdate().catch((err) => {
        failure ??= err;
        return false;
      });
      if (isStale()) return;
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
      // 已被新一代接管时不许动 loadingInfo：新一代正在路上，这里关掉会让
      // 界面在它写回结果前先闪一帧「未知」。收尾交给最新一代自己。
      if (!isStale()) setLoadingInfo(false);
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
      progressIsFailureRef.current = isTerminalSyncProgress(p) && isFailureSyncProgress(p);
      // 后端的索引重建是异步线程，会在 sync_data 返回之后继续发进度；
      // 这里跟着刷新收起计时，既能显示后续阶段，也不会永远挂在 100%。
      if (busyRef.current) {
        cancelAutoClear();
      } else {
        scheduleAutoClear(syncProgressLingerMs(p));
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
    progressIsFailureRef.current = false;
    try {
      await api.syncData();
      window.dispatchEvent(new Event("app:data-updated"));
      onSuccessRef.current?.();
      void loadVersionInfo({ silent: true });
      if (mountedRef.current) {
        // 只是兜底：后端在 sync_data 返回前已发过同款「完成」事件。版本查询
        // 不占任务锁，避免离线导入后对话框被 GitHub 请求拖成 busy。
        // 索引重建线程可能已经经 sync-progress
        // 发来自己的终态——尤其是快速失败（磁盘满、索引库打不开）时的
        // 「索引重建失败，可稍后在设置中手动重试」。无条件覆盖会把刚亮出来的
        // 失败通知刷成「同步完成」，那是它在本流程里唯一的主动提示。已是终态
        // 就保持原样，只在进度还停在中途（完成事件丢失/未达）时补写。
        setProgress((prev) =>
          prev && isTerminalSyncProgress(prev)
            ? prev
            : { phase: "完成", current: 1, total: 1, message: "同步完成" }
        );
      }
    } catch (err) {
      devWarn("[useDataSyncManager] 同步失败:", err);
      if (mountedRef.current) {
        // 失败时收掉进度条，只留错误卡片，免得半截进度和报错互相打架。
        setProgress(null);
        progressIsFailureRef.current = false;
        setError(localizeBackendError(err, "同步失败"));
      }
    } finally {
      releaseJob();
      busyRef.current = false;
      if (mountedRef.current) {
        setSyncing(false);
        // 忙期间到达的失败终态（后台索引重建快速失败）不能按「完成」的
        // 2.2s 收起；state 在闭包里是旧值，成败看 ref 镜像。
        scheduleAutoClear(
          progressIsFailureRef.current ? PROGRESS_FAIL_LINGER_MS : PROGRESS_DONE_LINGER_MS
        );
      }
    }
  }, [cancelAutoClear, loadVersionInfo, scheduleAutoClear]);

  const runImport = useCallback(
    async (label: string, run: () => Promise<void>, transferredJob?: () => void) => {
      if (busyRef.current) {
        // 本实例正忙时也要有下文：这条路真实可达——文件选择器的取消侦测
        // 误判提前放锁（change 姗姗来迟）后用户先点了同步，随后 change 到达、
        // 用户又在覆盖确认框点了确定。静默 return 会把这次已确认的导入吞掉，
        // 让用户以为导入开始了；给出和下面抢锁失败同款的冲突提示。交接来的
        // 锁按约定由这里收场（释放函数幂等，调用方兜底再放一次无害）。
        transferredJob?.();
        setError(dataJobConflictMessage("导入"));
        return;
      }
      // 调用方可能在弹文件选择器前就抢到了 "import" 锁（见 Settings 的导入入口）。
      // 必须整把交接过来，不能先放再抢：释放会同步唤醒 acquireDataJobWhenIdle
      // 的等待者（比如自动更新安装），它们在同一个 tick 里就能把锁抢走。
      // 接手后释放责任归这里；释放函数幂等，调用方兜底再释放一次也无害。
      const releaseJob = transferredJob ?? acquireDataJob("import");
      if (!releaseJob) {
        setError(dataJobConflictMessage("导入"));
        return;
      }
      busyRef.current = true;
      cancelAutoClear();
      setImporting(true);
      setError(null);
      setProgress({ phase: "导入", current: 0, total: 100, message: label });
      progressIsFailureRef.current = false;
      try {
        await run();
        window.dispatchEvent(new Event("app:data-updated"));
        onSuccessRef.current?.();
        void loadVersionInfo({ silent: true });
        if (mountedRef.current) {
          // 与 handleSync 同一句兜底纪律：后端已发过「完成」，这里只补
          // 事件丢失的场景；索引重建线程若已发来终态（含失败通知），
          // 保持原样，不许拿「导入完成」把它盖掉。
          setProgress((prev) =>
            prev && isTerminalSyncProgress(prev)
              ? prev
              : { phase: "完成", current: 100, total: 100, message: "导入完成" }
          );
        }
      } catch (err) {
        devWarn("[useDataSyncManager] 导入失败:", err);
        if (mountedRef.current) {
          setProgress(null);
          progressIsFailureRef.current = false;
          setError(localizeBackendError(err, "导入失败"));
        }
      } finally {
        releaseJob();
        busyRef.current = false;
        if (mountedRef.current) {
          setImporting(false);
          // 同 handleSync：失败终态按 ref 镜像给更长的停留。
          scheduleAutoClear(
            progressIsFailureRef.current ? PROGRESS_FAIL_LINGER_MS : PROGRESS_DONE_LINGER_MS
          );
        }
      }
    },
    [cancelAutoClear, loadVersionInfo, scheduleAutoClear]
  );

  /**
   * 浏览器字节流导入（dialog 插件不可用时的回退）。`transferredJob` 与
   * importFromPath 同义：交接调用方在弹 <input type="file"> 前就持有的
   * "import" 锁——选完文件必须整把交棒，绝不能先放再抢，否则释放的瞬间
   * 锁就会被其他等待者截走。
   */
  const importFromFile = useCallback(
    async (file: File, options: { transferredJob?: () => void } = {}) => {
      await runImport(`正在准备暂存 ${file.name}`, async () => {
        devLog("[useDataSyncManager] 导入 ZIP 字节数:", file.size);
        importCancelRef.current = false;
        // 绝不能 file.arrayBuffer() 一口吞：整包会先占满 JS 堆，再被
        // IPC 序列化成 JSON 数字数组，几百 MB 的 ZIP 在 Android 上直接
        // OOM。改成逐块 slice → base64 → 追加到后端暂存文件，最后一块
        // 让后端按路径走统一导入流程；两端峰值内存都只有一块的量级。
        const total = file.size;
        let offset = 0;
        try {
          do {
            if (shouldAbortImportTransfer(importCancelRef.current)) {
              throw new Error("操作已取消");
            }
            const end = Math.min(offset + IMPORT_CHUNK_BYTES, total);
            const chunk = await blobToBase64(file.slice(offset, end));
            const isLast = end >= total;
            await api.importZipChunk(chunk, offset, isLast);
            offset = end;
            // 进度要等块成功送达后再上报，并按已完成字节（即新的 offset）计算，
            // 否则显示会恒定落后一块（第一块传完还停在 0%）。传输映射到 0–30%，
            // 与后端导入进度（校验 30 → 解压 40 → 完成 100）衔接；最后一块返回时
            // 后端已接管发进度，这里不再上报，免得把后端推进的进度拉回 30%。
            if (!isLast && mountedRef.current) {
              const ratio = total > 0 ? offset / total : 0;
              setProgress({
                phase: "暂存",
                current: Math.min(Math.round(ratio * 30), 30),
                total: 100,
                message: `正在分块暂存 ZIP；导入结束后会清理临时文件…（${Math.round(
                  ratio * 100
                )}%）`,
              });
              // 传输进度是非终态：上一次同步遗留的后台索引失败通知若恰好
              // 在传输中途到达又被这里盖掉，失败镜像也要跟着清，免得收尾
              // 给一条成功提示配上失败的停留时长。
              progressIsFailureRef.current = false;
            }
          } while (offset < total);
        } catch (err) {
          // 传输半途而废（FileReader 读块失败 / 某块 IPC 没送达）时，
          // 后端寄存的安装互斥没人回调释放，会一直攥到 60 秒弃单超时，
          // 期间点「同步」只会收到「导入正在进行」。主动通知后端中止：
          // 立刻放锁并删掉半截暂存文件。中止本身失败也无妨（弃单超时
          // 仍是兜底），原始错误照样抛给 runImport 的统一错误处理。
          let cleanup: "cleaned" | "deferred" = "cleaned";
          try {
            await api.abortZipImport();
          } catch (abortErr) {
            cleanup = "deferred";
            devWarn("[useDataSyncManager] 通知后端中止分块导入失败:", abortErr);
          }
          throw new Error(describeImportTransferFailure(err, cleanup));
        }
      }, options.transferredJob);
    },
    [runImport]
  );

  /**
   * 桌面端按路径导入：整包不经过 JS 堆，但 UI 状态要和字节流导入完全一致。
   * `transferredJob` 用于交接调用方已持有的 "import" 任务锁（弹文件选择器前
   * 抢到的那把），避免中途释放被其他等待者插队。
   */
  const importFromPath = useCallback(
    async (path: string, options: { transferredJob?: () => void } = {}) => {
      await runImport(
        "正在读取所选压缩包…",
        async () => {
          await api.importFromZip(path);
        },
        options.transferredJob
      );
    },
    [runImport]
  );

  const resetProgress = useCallback(() => {
    cancelAutoClear();
    setProgress(null);
    progressIsFailureRef.current = false;
  }, [cancelAutoClear]);

  const cancelImportTransfer = useCallback(() => {
    importCancelRef.current = true;
  }, []);

  const status = useMemo(() => {
    // 后端约定：只有数据集真的不存在才返回「未安装」；已安装但 version.json
    // 缺失/损坏时返回「本地数据（版本未知）」。空串意味着还没加载出来或读取
    // 失败，状态未知，不能顺手当成「未安装」——那会把装好的数据说成没装、
    // 催用户首次下载（与后端 check_update 堵住的是同一类撒谎）。
    if (!currentVersion) {
      return "unknown" as const;
    }
    if (currentVersion === "未安装") {
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
    cancelImportTransfer,
    loadVersionInfo,
    resetProgress,
  };
}
