import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { api, type SyncProgress } from "@/services/api";
import { devLog, devWarn, redactSensitive } from "@/hooks/useAppUpdater";

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

/**
 * 等到锁空闲后再抢。给「用户已经点头确认、但此刻恰好有任务在跑」的流程用：
 * 立刻放弃会把用户的确认静默吞掉，无限等待又可能永远不结束，所以带超时，
 * 超时返回 null 由调用方决定怎么收场。多个等待者被同一次释放唤醒时只有
 * 先抢到的成功，其余继续等自己的超时。
 */
export function acquireDataJobWhenIdle(kind: DataJobKind, timeoutMs: number): Promise<(() => void) | null> {
  const immediate = acquireDataJob(kind);
  if (immediate) return Promise.resolve(immediate);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (release: (() => void) | null) => {
      if (settled) {
        // 超时和释放通知赛跑时拿到的锁不能吞掉，得还回去。
        release?.();
        return;
      }
      settled = true;
      unsubscribe();
      window.clearTimeout(timer);
      resolve(release);
    };
    const unsubscribe = subscribeDataJob(() => {
      if (settled || getActiveDataJob() !== null) return;
      finish(acquireDataJob(kind));
    });
    const timer = window.setTimeout(() => finish(null), timeoutMs);
  });
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

/** 终态进度多留一会儿让用户看清「完成」，之后自动收起。 */
const PROGRESS_DONE_LINGER_MS = 2200;
/**
 * 带失败字样的终态（后台索引重建失败走 sync-progress 报「索引重建失败，
 * 可稍后在设置中手动重试」）要留得更久：它是那次失败在本流程里唯一的
 * 主动提示，2.2 秒就收起等于把失败演成了成功，用户根本来不及读完。
 */
const PROGRESS_FAIL_LINGER_MS = 15_000;
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
  // Tauri 插件的 invoke 失败可能抛出带 message 字段的普通对象（不是 Error
  // 实例）；不掏出来就会被 String() 压成 "[object Object]"，规则一条都
  // 匹配不上，最后端给用户看一句「操作失败：[object Object]」。
  const raw =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : error && typeof error === "object" && typeof (error as { message?: unknown }).message === "string"
          ? (error as { message: string }).message
          : String(error ?? "");
  const text = raw.trim();
  if (!text || text === "[object Object]") return fallback;

  for (const [pattern, template] of BACKEND_ERROR_RULES) {
    const match = text.match(pattern);
    if (match) {
      return template.replace(/\$(\d)/g, (_, index: string) => match[Number(index)] ?? "");
    }
  }

  // 不含中文说明是没被规则覆盖到的后端原文，补个中文前缀再展示。
  // 原文透出前先脱敏：后端错误串里可能嵌着完整下载地址（reqwest 的报错习惯），
  // 数据源地址不该出现在界面文案里，用户截图求助时会一并带出去。
  // 注意「是否含中文」要看原文——脱敏占位符 `<链接>` 本身就是中文。
  const safeText = redactSensitive(text);
  return /[\u4e00-\u9fff]/.test(text) ? safeText : `${fallback}：${safeText}`;
}

function isTerminalProgress(progress: SyncProgress): boolean {
  return progress.phase === "完成" || (progress.total > 0 && progress.current >= progress.total);
}

/**
 * 终态是不是失败通知。sync-progress 通道上唯一带「失败」的消息就是
 * 后台索引重建的失败终态（其余失败都走 Promise reject / 错误卡片）；
 * 万一将来误伤别的消息，代价也只是多留几秒，绝不会把失败提前收掉。
 */
function isFailureNotice(progress: SyncProgress): boolean {
  return progress.message.includes("失败");
}

/** 终态按成败给不同的停留时长；非终态走停更兜底。 */
function lingerFor(progress: SyncProgress): number {
  if (!isTerminalProgress(progress)) return PROGRESS_STALL_TIMEOUT_MS;
  return isFailureNotice(progress) ? PROGRESS_FAIL_LINGER_MS : PROGRESS_DONE_LINGER_MS;
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
      progressIsFailureRef.current = isTerminalProgress(p) && isFailureNotice(p);
      // 后端的索引重建是异步线程，会在 sync_data 返回之后继续发进度；
      // 这里跟着刷新收起计时，既能显示后续阶段，也不会永远挂在 100%。
      if (busyRef.current) {
        cancelAutoClear();
      } else {
        scheduleAutoClear(lingerFor(p));
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
      await loadVersionInfo({ silent: true });
      if (mountedRef.current) {
        // 只是兜底：后端在 sync_data 返回前已发过同款「完成」事件。这里隔着
        // loadVersionInfo 的几次网络往返，索引重建线程可能已经经 sync-progress
        // 发来自己的终态——尤其是快速失败（磁盘满、索引库打不开）时的
        // 「索引重建失败，可稍后在设置中手动重试」。无条件覆盖会把刚亮出来的
        // 失败通知刷成「同步完成」，那是它在本流程里唯一的主动提示。已是终态
        // 就保持原样，只在进度还停在中途（完成事件丢失/未达）时补写。
        setProgress((prev) =>
          prev && isTerminalProgress(prev)
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
        await loadVersionInfo({ silent: true });
        if (mountedRef.current) {
          // 与 handleSync 同一句兜底纪律：后端已发过「完成」，这里只补
          // 事件丢失的场景；索引重建线程若已发来终态（含失败通知），
          // 保持原样，不许拿「导入完成」把它盖掉。
          setProgress((prev) =>
            prev && isTerminalProgress(prev)
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
      await runImport(`正在读取 ${file.name}`, async () => {
        devLog("[useDataSyncManager] 导入 ZIP 字节数:", file.size);
        // 绝不能 file.arrayBuffer() 一口吞：整包会先占满 JS 堆，再被
        // IPC 序列化成 JSON 数字数组，几百 MB 的 ZIP 在 Android 上直接
        // OOM。改成逐块 slice → base64 → 追加到后端暂存文件，最后一块
        // 让后端按路径走统一导入流程；两端峰值内存都只有一块的量级。
        const total = file.size;
        let offset = 0;
        try {
          do {
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
                phase: "导入",
                current: Math.min(Math.round(ratio * 30), 30),
                total: 100,
                message: `正在传输 ZIP 数据…（${Math.round(ratio * 100)}%）`,
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
          await api.abortZipImport().catch((abortErr) => {
            devWarn("[useDataSyncManager] 通知后端中止分块导入失败:", abortErr);
          });
          throw err;
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
    loadVersionInfo,
    resetProgress,
  };
}
