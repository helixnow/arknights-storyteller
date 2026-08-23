import { ChangeEvent, useCallback, useEffect, useRef, useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ThemeToggle } from "@/components/ThemeToggle";
import { CustomScrollArea } from "@/components/ui/custom-scroll-area";
import { useTheme } from "@/components/theme-provider";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { AlertCircle, CheckCircle, Download, Eye, EyeOff, ImageOff, Loader2, RefreshCw, Upload } from "lucide-react";
import {
  acquireDataJob,
  dataJobConflictMessage,
  describeDataJob,
  getActiveDataJob,
  localizeBackendError,
  useDataSyncManager,
} from "@/hooks/useDataSyncManager";
import { api } from "@/services/api";
import { useAppPreferences } from "@/hooks/useAppPreferences";
import { getVersion as getAppVersion } from "@tauri-apps/api/app";
import {
  detectRuntimePlatform,
  checkDesktopUpdate,
  describeUpdateError,
  devLog,
  installDesktopUpdate,
  checkAndroidUpdate,
  installAndroidUpdate,
  openAndroidInstallPermissionSettings,
  safeConfirm,
  type UpdateAvailability,
  type UpdateDownloadProgress,
  type UpdateIssue,
} from "@/hooks/useAppUpdater";
import { useToast } from "@/components/ui/toast";

const THEME_COLOR_OPTIONS = [
  {
    value: "default" as const,
    label: "极光白",
    description: "沉稳黑白主色",
    lightSwatch: "#f5f5f5",
    darkSwatch: "#1f1f21",
  },
  {
    value: "book" as const,
    label: "书纹棕",
    description: "温润羊皮纸",
    lightSwatch: "#d6a26d",
    darkSwatch: "#f3d6a7",
  },
  {
    value: "emerald" as const,
    label: "苔原绿",
    description: "清爽植被风",
    lightSwatch: "#37b189",
    darkSwatch: "#5edbb7",
  },
  {
    value: "noctilucent" as const,
    label: "极夜紫",
    description: "霓光科幻感",
    lightSwatch: "#7c6ef5",
    darkSwatch: "#ada3ff",
  },
];

// 插件未编译（Android）或未在 capability 中授权时，Tauri 会抛出 “not allowed” /
// “plugin ... not found” 之类的错误，这类情况才需要回退到浏览器文件选择器。
function isPluginUnavailableError(message: string): boolean {
  return /not allowed|not found|unknown plugin|plugin/i.test(message);
}

function formatMegabytes(bytes: number): string {
  return `${(bytes / 1_048_576).toFixed(1)} MB`;
}

/** 状态提示带一个自增序号，重复设置同一句话时也能重新计时。 */
interface StatusNotice {
  text: string;
  seq: number;
}

const STATUS_NOTICE_TTL_MS = 4000;

/**
 * 兜底看门狗：正常路径是搜索面板重建收场时广播 `app:story-index-updated`，
 * 收到就立刻放锁。只有那条广播丢了（面板异常卸载之类）才靠这个超时救锁，
 * 保证任何情况下都不会死锁。
 */
const INDEX_JOB_WATCHDOG_MS = 30_000;

/**
 * 回退 <input type="file"> 的取消侦测宽限期：窗口重新获得焦点说明系统选择器
 * 已经收场，但选中文件的 change 事件可能还在路上（Android 从选择器 activity
 * 返回时有延迟），等满宽限期仍没有文件才按「用户取消」处理。
 */
const FILE_PICKER_CANCEL_GRACE_MS = 1500;

/**
 * 兜底超时：个别平台打开 <input type="file"> 不会让窗口失焦，「先见失焦、
 * 再等回焦」的取消侦测永远布防不了，寄存的锁会一直占着。等这么久仍没有
 * change 就按取消放锁，保证不死锁。取 5 分钟而不是几秒：它只该在侦测完全
 * 失灵时兜底，绝不能反过来误伤慢慢挑文件的用户。
 */
const FILE_PICKER_STUCK_RELEASE_MS = 5 * 60_000;

export function Settings() {
  const { themeColor, setThemeColor } = useTheme();
  const { minimalMode, setMinimalMode, inlineImages, setInlineImages } = useAppPreferences();
  const [statusNotice, setStatusNotice] = useState<StatusNotice | null>(null);
  const statusSeqRef = useRef(0);
  const [appVersion, setAppVersion] = useState<string>("");
  const [updateStatus, setUpdateStatus] = useState<
    | "idle"
    | "checking"
    | "available"
    | "up-to-date"
    | "installing"
    | "installed"
    | "needs-permission"
    | "error"
  >("idle");
  const [updateMessage, setUpdateMessage] = useState<string | null>(null);
  const [updateIssue, setUpdateIssue] = useState<UpdateIssue | null>(null);
  const [downloadProgress, setDownloadProgress] = useState<UpdateDownloadProgress | null>(null);
  const [availableUpdate, setAvailableUpdate] = useState<UpdateAvailability | null>(null);
  const runtimePlatform = detectRuntimePlatform();

  const showStatus = useCallback((text: string | null) => {
    if (!text) {
      setStatusNotice(null);
      return;
    }
    statusSeqRef.current += 1;
    setStatusNotice({ text, seq: statusSeqRef.current });
  }, []);

  useEffect(() => {
    if (!statusNotice) return;
    const timer = window.setTimeout(() => setStatusNotice(null), STATUS_NOTICE_TTL_MS);
    return () => window.clearTimeout(timer);
  }, [statusNotice]);

  const handleSyncSuccess = useCallback(() => {
    showStatus("数据版本信息已更新");
  }, [showStatus]);

  const {
    syncing,
    importing,
    busy,
    activeJob,
    loadingInfo,
    progress,
    error,
    setError,
    currentVersion,
    remoteVersion,
    status,
    handleSync,
    importFromFile,
    importFromPath,
    loadVersionInfo,
    resetProgress,
  } = useDataSyncManager({
    active: true,
    onSuccess: handleSyncSuccess,
  });

  // 文件对话框弹出期间按钮必须先锁上：确认框与系统选择器都是异步的，
  // 此时 hook 的 importing 还没置起来，连点两下会开出两个选择器。
  const [preparingImport, setPreparingImport] = useState(false);
  const importBusy = importing || preparingImport;
  const dataBusy = busy || preparingImport;
  /**
   * 任务锁被本页之外的东西占着（同步对话框、自动索引、更新安装）。这时候所有
   * 会改数据的入口都要禁用，并把占用者报出来——只把按钮灰掉，用户只会以为坏了。
   */
  const blockedBy = activeJob && !dataBusy ? activeJob : null;
  const dataActionsDisabled = dataBusy || blockedBy !== null;

  const handleRefreshInfo = () => {
    showStatus(null);
    setError(null);
    resetProgress();
    void loadVersionInfo();
  };

  const handleSyncClick = async () => {
    if (dataActionsDisabled) return;
    showStatus(null);
    setError(null);
    const confirmed = await safeConfirm(
      status === "not-installed"
        ? "将从 GitHub 下载完整剧情数据包并占用较多存储，确定开始？"
        : "同步会覆盖本机已有的剧情数据并重建索引，确定继续？",
      { title: "同步剧情数据", kind: "warning" }
    );
    if (!confirmed) return;
    void handleSync();
  };

  const fileInputRef = useRef<HTMLInputElement | null>(null);

  /**
   * 回退到 <input type="file"> 期间寄存的任务锁。系统选择器开着时
   * handleImportClick 已经 return，绝不能让它的 finally 放锁——释放会同步唤醒
   * acquireDataJobWhenIdle 的等待者（自动更新安装），锁被截走后用户选完文件
   * 再导入只会报「导入正在进行」。锁的去向只有两条：选到文件整把交棒给
   * importFromFile；确认取消后在这里释放。
   */
  const pendingImportJobRef = useRef<(() => void) | null>(null);
  /** 撤掉取消侦测（blur / focus / visibility 监听 + 各计时器）；寄存的锁本身由调用方另行处置。 */
  const pendingImportWatchCleanupRef = useRef<(() => void) | null>(null);

  /** 取走寄存的锁并撤掉侦听；之后交棒还是释放由取走的人决定。 */
  const takePendingImportJob = useCallback(() => {
    pendingImportWatchCleanupRef.current?.();
    const job = pendingImportJobRef.current;
    pendingImportJobRef.current = null;
    return job;
  }, []);

  /**
   * 寄存锁并布防取消侦测。检测手法沿用本仓库刷新数据用的窗口焦点事件
   * （HomePanel / StoryList 同款），但必须分两步布防，不能一挂上就听 focus：
   * handleImportClick 里确认框刚收场，它归还焦点的那次 focus 可能在监听挂上
   * 之后才派发，若直接当「选择器收场」处理，宽限期一到就会在用户还在系统
   * 选择器里挑文件时把锁放掉——等待者（自动索引 / 更新安装）被唤醒截锁，
   * 空窗就回来了。所以：
   *   1. 先等窗口 blur 或页面被隐藏（Android 选择器是独立 activity）——这才是
   *      「选择器真的打开了」的信号，在此之前到达的 focus（确认框的余焦）
   *      一律忽略；
   *   2. 见过失焦后才认回焦（focus / 页面重新可见）：选择器收场时窗口必然
   *      回焦，先等一个宽限期让可能在路上的 change 先到，等不到才按
   *      「用户取消」放锁。用户在选择器里泡多久都安全——期间窗口始终失焦，
   *      回焦事件根本不会来，倒计时无从开始。
   * 个别平台打开选择器不夺焦点，第 1 步永远等不到，由 5 分钟兜底超时保证
   * 最终放锁、不死锁。万一误判（change 姗姗来迟），importFromFile 会退回
   * 自己抢锁，行为和修复前一致，不会更糟。
   */
  const armPendingImportWatch = useCallback((releaseJob: () => void) => {
    pendingImportJobRef.current = releaseJob;
    /** 已确认选择器真正打开过（窗口失焦 / 页面隐藏），回焦事件才可信。 */
    let pickerSeen = false;
    let graceTimer: number | null = null;
    let stuckTimer: number | null = null;

    // 按「用户取消」收场：撤掉全部侦听与计时器、放锁、清 preparing 态。
    const settleAsCancelled = () => {
      pendingImportWatchCleanupRef.current?.();
      const job = pendingImportJobRef.current;
      pendingImportJobRef.current = null;
      if (job) {
        job();
        setPreparingImport(false);
      }
    };

    const startGrace = () => {
      if (graceTimer !== null) return;
      graceTimer = window.setTimeout(() => {
        graceTimer = null;
        settleAsCancelled();
      }, FILE_PICKER_CANCEL_GRACE_MS);
    };

    const stopGrace = () => {
      if (graceTimer !== null) {
        window.clearTimeout(graceTimer);
        graceTimer = null;
      }
    };

    const onLostFocus = () => {
      pickerSeen = true;
      // 又失焦了（还在选择器里，或过渡动画抖出的假回焦）：撤掉可能误开的
      // 倒计时，等真正回焦再重新计时，绝不在用户看不见页面时放锁。
      stopGrace();
    };
    const onGotFocus = () => {
      if (!pickerSeen) return; // 确认框收尾的余焦，选择器还没开，不理。
      startGrace();
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === "hidden") onLostFocus();
      else onGotFocus();
    };

    pendingImportWatchCleanupRef.current = () => {
      window.removeEventListener("blur", onLostFocus);
      window.removeEventListener("focus", onGotFocus);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      stopGrace();
      if (stuckTimer !== null) {
        window.clearTimeout(stuckTimer);
        stuckTimer = null;
      }
      pendingImportWatchCleanupRef.current = null;
    };
    window.addEventListener("blur", onLostFocus);
    window.addEventListener("focus", onGotFocus);
    document.addEventListener("visibilitychange", onVisibilityChange);
    stuckTimer = window.setTimeout(() => {
      stuckTimer = null;
      settleAsCancelled();
    }, FILE_PICKER_STUCK_RELEASE_MS);
  }, []);

  // 设置页卸载时选择器可能还开着：侦听要拆，寄存的锁必须放掉，不能跟着组件蒸发。
  useEffect(() => {
    return () => {
      pendingImportWatchCleanupRef.current?.();
      pendingImportJobRef.current?.();
      pendingImportJobRef.current = null;
    };
  }, []);

  const handleImportClick = async () => {
    if (dataActionsDisabled) return;
    showStatus(null);
    setError(null);
    // 系统文件对话框可能开很久，这段时间同样要占住任务锁，否则别处（同步对话框、
    // 自动索引）会以为没人干活，跑起一个会和随后的导入互相覆盖的任务。
    const releaseJob = acquireDataJob("import");
    if (!releaseJob) {
      setError(dataJobConflictMessage("导入"));
      return;
    }
    setPreparingImport(true);
    // 回退到 <input type="file"> 时锁已寄存给选择器流程，本次 finally 必须跳过
    // 放锁，否则用户还在系统相册/文件器里挑文件，锁就被等待者截走了。
    let lockParkedForPicker = false;
    try {
      const confirmed = await safeConfirm(
        "导入 ZIP 会覆盖本机已有的剧情数据。请确保压缩包来自 ArknightsGameData。",
        { title: "导入 ZIP", kind: "warning" }
      );
      // 用户点了取消：安静退出，不要再弹文件选择器。
      if (!confirmed) return;

      // 只有在 dialog 插件确实不可用（移动端未注册 / 未授权）时才退回
      // <input type="file">，其余错误都要如实反馈，避免又弹一个选择器。
      let openDialog: typeof import("@tauri-apps/plugin-dialog").open;
      try {
        ({ open: openDialog } = await import("@tauri-apps/plugin-dialog"));
      } catch (err) {
        devLog("[Settings] 文件对话框插件不可用，回退到文件选择器", err);
        armPendingImportWatch(releaseJob);
        lockParkedForPicker = true;
        fileInputRef.current?.click();
        return;
      }

      let path: string | null;
      try {
        const selected = await openDialog({
          multiple: false,
          filters: [{ name: "ZIP", extensions: ["zip"] }],
        });
        path = (Array.isArray(selected) ? selected[0] : selected) ?? null;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (isPluginUnavailableError(message)) {
          devLog("[Settings] 文件对话框不可用，回退到文件选择器", err);
          armPendingImportWatch(releaseJob);
          lockParkedForPicker = true;
          fileInputRef.current?.click();
        } else {
          setError(localizeBackendError(err, "选择文件失败"));
        }
        return;
      }

      // 用户取消选择。
      if (!path) return;

      // 把手里这把锁整体交棒给 importFromPath，绝不能先放再让它重抢：
      // 释放会同步唤醒 acquireDataJobWhenIdle 的等待者（自动更新安装），
      // 它们在同一个 tick 里就会把锁截走。交棒后由导入流程负责释放；
      // 释放函数幂等，finally 里的兜底调用不会误伤。
      await importFromPath(path, { transferredJob: releaseJob });
    } finally {
      // 回退路径的锁与 preparing 态改由选择器流程收尾（选到文件交棒、取消放锁），
      // 这里再放就把空窗重新开出来了。其余路径（确认取消、原生对话框取消、
      // 插件报错未回退、导入收尾）照旧兜底；释放函数幂等，重复调用无害。
      if (!lockParkedForPicker) {
        releaseJob();
        setPreparingImport(false);
      }
    }
  };

  const handleFileSelected = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    // 接过回退路径寄存的锁（同时撤掉取消侦听）。
    const transferredJob = takePendingImportJob();
    // change 到了却没有文件：一样是取消，放锁并清 preparing 态。
    if (!file) {
      transferredJob?.();
      setPreparingImport(false);
      return;
    }
    try {
      // 与 path 路径同一句纪律：把手里这把锁整体交棒给 importFromFile，
      // 绝不能先放再让它重抢——释放会同步唤醒 acquireDataJobWhenIdle 的
      // 等待者，同一个 tick 里锁就被截走。交棒后由导入流程负责释放。
      await importFromFile(file, { transferredJob: transferredJob ?? undefined });
    } finally {
      // 释放函数幂等，这里兜底再放一次无害（正常已由导入流程释放）。
      transferredJob?.();
      setPreparingImport(false);
    }
  };

  const toast = useToast();

  /**
   * 索引重建实际跑在搜索面板里（它常驻挂载，监听 `app:rebuild-story-index`），
   * 这边只是发起方。放锁一主一备：
   *   1. 面板重建收场（成功或失败）广播 `app:story-index-updated`
   *      （reason: rebuilt / rebuild-failed），收到立刻放锁——失败秒放，
   *      不用再吊满 30s 看门狗；
   *   2. 广播万一丢了，由看门狗兜底放锁，保证不死锁。
   * 后端 index-progress 事件只用来给看门狗续期，绝不能当放锁信号：事件上
   * 没有发起方标记，sync/import 之后后端自动重建发的是同一种事件，把别人
   * 的终态当成自己的会提前放锁（见下方监听器内的说明）。
   */
  const indexJobReleaseRef = useRef<(() => void) | null>(null);
  const indexWatchdogRef = useRef<number | null>(null);

  const releaseIndexJob = useCallback(() => {
    if (indexWatchdogRef.current !== null) {
      window.clearTimeout(indexWatchdogRef.current);
      indexWatchdogRef.current = null;
    }
    indexJobReleaseRef.current?.();
    indexJobReleaseRef.current = null;
  }, []);

  const armIndexWatchdog = useCallback(() => {
    if (indexWatchdogRef.current !== null) window.clearTimeout(indexWatchdogRef.current);
    indexWatchdogRef.current = window.setTimeout(releaseIndexJob, INDEX_JOB_WATCHDOG_MS);
  }, [releaseIndexJob]);

  useEffect(() => {
    let cancelled = false;
    let dispose: (() => void) | null = null;
    void api
      .onIndexProgress(() => {
        if (cancelled || !indexJobReleaseRef.current) return;
        // 只喂狗、不放锁。index-progress 不带发起方：sync_data / import_zip
        // 完成后，后端会在自己的线程里自动重建索引并发同样的事件，而那段
        // 时间前端任务锁是空闲的、本页「重新建立索引」可以点。若把
        // 「current >= total」当作自己那次重建的终态，先收场的会是后台
        // 自动重建——锁被提前释放，排队等锁的同步 / 更新安装立刻抢入，
        // 与仍在跑的重建并发读写数据目录。有索引活动就给看门狗续期，
        // 真正的放锁交给终态广播（主路径）与看门狗超时（兜底），
        // 宁可晚放 30s，不可误放。
        armIndexWatchdog();
      })
      .then((unlisten) => {
        if (cancelled) {
          unlisten();
          return;
        }
        dispose = unlisten;
      })
      .catch((err) => devLog("[Settings] 监听索引进度失败", err));
    return () => {
      cancelled = true;
      dispose?.();
      releaseIndexJob();
    };
  }, [armIndexWatchdog, releaseIndexJob]);

  // 主放锁路径：搜索面板的 runBuildIndex 无论成败都会在收场时广播
  // `app:story-index-updated`，reason 标出成败。只认这两个终态 reason——
  // useAutoIndex 的常规状态广播（startup / data-updated）可能恰好赶在
  // 我们发起的重建中途到达，那时放锁会让同步 / 导入趁虚而入。
  useEffect(() => {
    const handler = (event: Event) => {
      if (!indexJobReleaseRef.current) return;
      const reason = (event as CustomEvent<{ reason?: string } | null>).detail?.reason;
      if (reason === "rebuilt" || reason === "rebuild-failed") releaseIndexJob();
    };
    window.addEventListener("app:story-index-updated", handler);
    return () => window.removeEventListener("app:story-index-updated", handler);
  }, [releaseIndexJob]);

  const handleRebuildIndex = useCallback(() => {
    setError(null);
    const release = acquireDataJob("index");
    if (!release) {
      toast.warn(dataJobConflictMessage("重建索引"));
      return;
    }
    indexJobReleaseRef.current = release;
    armIndexWatchdog();
    window.dispatchEvent(new Event("app:rebuild-story-index"));
    // 完成提示由搜索面板给（它才知道结果），这里只确认「已经开跑」，
    // 避免同一件事在同一屏上提示两遍。
    toast.show("已开始重新建立全文索引，可在搜索页查看进度");
  }, [armIndexWatchdog, setError, toast]);

  const handleRefreshCharacters = useCallback(() => {
    setError(null);
    if (getActiveDataJob() !== null) {
      toast.warn(dataJobConflictMessage("刷新人物统计"));
      return;
    }
    window.dispatchEvent(new Event("app:refresh-character-stats"));
    toast.show("已请求刷新人物统计");
  }, [setError, toast]);

  useEffect(() => {
    if (runtimePlatform === "unknown") return;
    let cancelled = false;
    getAppVersion()
      .then((version) => {
        if (!cancelled) setAppVersion(version);
      })
      .catch(() => {
        if (!cancelled) setAppVersion("");
      });
    return () => {
      cancelled = true;
    };
  }, [runtimePlatform]);

  const handleCheckAppUpdate = useCallback(async () => {
    setUpdateStatus("checking");
    setUpdateMessage("正在向更新源查询最新版本…");
    setUpdateIssue(null);
    setAvailableUpdate(null);
    try {
      if (runtimePlatform === "unknown") {
        throw new Error("当前环境并非 Tauri 应用，无法检查更新。");
      }

      const result =
        runtimePlatform === "android"
          ? await checkAndroidUpdate(appVersion || undefined)
          : await checkDesktopUpdate(appVersion || undefined);

      if (!result) {
        setUpdateStatus("up-to-date");
        setUpdateMessage(null);
        return;
      }
      setAvailableUpdate(result);
      setUpdateStatus("available");
      setUpdateMessage(null);
    } catch (error) {
      // 检查更新失败几乎都是打包配置或网络问题，说清楚就行，别用报错语气吓人。
      devLog("[Settings] 检查更新失败", error);
      setUpdateStatus("error");
      setUpdateMessage(null);
      setUpdateIssue(describeUpdateError(error));
    }
  }, [runtimePlatform, appVersion]);

  const handleInstallAppUpdate = useCallback(async () => {
    if (!availableUpdate) return;
    // 桌面端装完立刻重启进程，安卓端会拉起系统安装器：这期间数据目录不能有人写。
    const releaseJob = acquireDataJob("update");
    if (!releaseJob) {
      setUpdateIssue({ tone: "warning", kind: "unknown", message: dataJobConflictMessage("安装更新") });
      return;
    }
    setUpdateStatus("installing");
    setUpdateIssue(null);
    setDownloadProgress(null);
    setUpdateMessage(
      availableUpdate.platform === "desktop"
        ? "正在下载并安装最新版本，请保持网络连接…"
        : "正在下载最新安装包，请保持网络连接…"
    );
    try {
      if (availableUpdate.platform === "desktop") {
        await installDesktopUpdate(availableUpdate, setDownloadProgress, { relaunch: true });
        setUpdateStatus("installed");
        setUpdateMessage("更新已安装，应用即将重启");
        setAvailableUpdate(null);
      } else {
        const response = await installAndroidUpdate(availableUpdate);
        if (response?.needsPermission) {
          await openAndroidInstallPermissionSettings();
          setUpdateStatus("needs-permission");
          // 指引统一由 needs-permission 状态的固定段落给出，这里必须清掉
          // 下载中提示，否则同一件事会在卡片里连着念两遍。
          setUpdateMessage(null);
          return;
        }
        setUpdateStatus("installed");
        setUpdateMessage("安装程序已启动，请按照系统提示完成安装。");
        setAvailableUpdate(null);
      }
    } catch (error) {
      devLog("[Settings] 安装更新失败", error);
      const issue = describeUpdateError(error, "更新安装未完成，可稍后重试。");
      setUpdateMessage(null);
      // 用户自己点了取消（含 Windows UAC 拒绝）不是故障：退回「可更新」状态，
      // 「立即更新」按钮留着，也不摆出红色报错。
      setUpdateStatus(issue.kind === "cancelled" ? "available" : "error");
      setUpdateIssue(issue);
    } finally {
      releaseJob();
      setDownloadProgress(null);
    }
  }, [availableUpdate]);

  const isCheckingUpdate = updateStatus === "checking";
  const isInstallingUpdate = updateStatus === "installing";
  /** 更新安装要等数据任务收工，否则重启/覆盖会打断正在写盘的同步。 */
  const installBlocked = activeJob !== null && activeJob !== "update";
  const dataProgressPercent =
    progress && progress.total > 0
      ? Math.min(Math.round((progress.current / progress.total) * 100), 100)
      : null;
  const updateIssueClass =
    updateIssue?.tone === "error"
      ? "text-[hsl(var(--color-destructive))]"
      : updateIssue?.tone === "warning"
      ? "text-[hsl(var(--color-warning))]"
      : "text-[hsl(var(--color-muted-foreground))]";

  const renderStatusBadge = () => {
    if (status === "not-installed") {
      return (
        <span className="inline-flex items-center gap-1 rounded-full bg-[hsl(var(--color-primary)/0.15)] px-2 py-1 text-xs font-medium text-[hsl(var(--color-primary))]">
          <AlertCircle className="h-3 w-3" />
          未安装
        </span>
      );
    }
    if (status === "update-available") {
      return (
        <span className="inline-flex items-center gap-1 rounded-full bg-[hsl(var(--color-primary)/0.15)] px-2 py-1 text-xs font-medium text-[hsl(var(--color-primary))]">
          <AlertCircle className="h-3 w-3" />
          有更新
        </span>
      );
    }
    if (status === "up-to-date") {
      return (
        <span className="inline-flex items-center gap-1 rounded-full bg-[hsl(var(--color-success)/0.15)] px-2 py-1 text-xs font-medium text-[hsl(var(--color-success))]">
          <CheckCircle className="h-3 w-3" />
          最新
        </span>
      );
    }
    return null;
  };

  return (
    <div className="h-full flex flex-col overflow-hidden">
      <main className="flex-1 overflow-hidden">
        <CustomScrollArea
          className="h-full"
          viewportClassName="reader-scroll"
          trackOffsetTop="calc(3.5rem + 10px)"
          trackOffsetBottom="calc(4.5rem + env(safe-area-inset-bottom, 0px))"
        >
          <div className="container py-6 pb-24 space-y-6 motion-safe:animate-in motion-safe:fade-in-0 motion-safe:duration-700">
            <Card className="motion-safe:animate-in motion-safe:fade-in-0 motion-safe:duration-500">
              <CardHeader>
                <CardTitle>外观</CardTitle>
                <CardDescription>自定义应用的显示效果</CardDescription>
              </CardHeader>
              <CardContent>
                <div className="flex items-center justify-between">
                  <div>
                    <div className="font-medium">主题</div>
                    <div className="text-sm text-[hsl(var(--color-muted-foreground))]">
                      浅色 / 深色 / 跟随系统
                    </div>
                  </div>
                  <ThemeToggle />
                </div>

                <div className="mt-6 space-y-3">
                  <div className="font-medium">主题色</div>
                  <div className="text-sm text-[hsl(var(--color-muted-foreground))]">
                    在亮/暗色模式下自动匹配的主色调
                  </div>
                  <div className="grid gap-2 grid-cols-2">
                    {THEME_COLOR_OPTIONS.map((option) => {
                      const active = option.value === themeColor;
                      return (
                        <button
                          key={option.value}
                          type="button"
                          aria-pressed={active}
                          onClick={() => setThemeColor(option.value)}
                          className={cn(
                            // ring/offset 颜色必须写死主题变量：默认 offset 是 #fff，
                            // 深色主题下键盘焦点会围出一圈刺眼的白边。
                            "w-full rounded-lg border p-3 text-left transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-[hsl(var(--color-ring))] focus-visible:ring-offset-2 focus-visible:ring-offset-[hsl(var(--color-card))]",
                            active
                              ? "border-[hsl(var(--color-primary))] bg-[hsl(var(--color-accent))]"
                              : "border-[hsl(var(--color-border))] hover:bg-[hsl(var(--color-accent)/0.7)]"
                          )}
                        >
                          <div className="flex items-center gap-3">
                            <div className="flex flex-col gap-1">
                              <span
                                className="h-6 w-6 rounded-full border border-black/5 shadow-sm"
                                style={{ backgroundColor: option.lightSwatch }}
                              />
                              <span
                                className="h-6 w-6 rounded-full border border-black/15 shadow-sm"
                                style={{ backgroundColor: option.darkSwatch }}
                              />
                            </div>
                            <div>
                              <div className="font-medium leading-snug">{option.label}</div>
                              <div className="text-xs text-[hsl(var(--color-muted-foreground))]">
                                {option.description}
                              </div>
                            </div>
                          </div>
                        </button>
                      );
                    })}
                  </div>
                </div>
              </CardContent>
            </Card>

            <Card
              className="motion-safe:animate-in motion-safe:fade-in-0 motion-safe:duration-500"
              style={{ animationDelay: "60ms" }}
            >
            <CardHeader>
              <CardTitle>数据管理</CardTitle>
              <CardDescription>同步或导入剧情数据集</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
                <div className="flex flex-wrap items-center gap-4">
                  <div>
                    <div className="text-xs text-[hsl(var(--color-muted-foreground))]">当前版本</div>
                    {/* 空串 = 版本还没加载出来或读取失败（status 为 unknown），不能写成
                        「未安装」——真正未安装时后端返回的就是「未安装」字样。 */}
                    <div className="font-mono text-sm">
                      {currentVersion || (loadingInfo ? "读取中..." : "未知")}
                    </div>
                  </div>
                  <div>
                    <div className="text-xs text-[hsl(var(--color-muted-foreground))]">最新版本</div>
                    <div className="font-mono text-sm">{remoteVersion || "未知"}</div>
                  </div>
                  {renderStatusBadge()}
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={handleRefreshInfo}
                    disabled={loadingInfo || dataActionsDisabled}
                    className="sm:ml-auto"
                  >
                    {loadingInfo ? (
                      <span className="inline-flex items-center gap-2">
                        <Loader2 className="h-4 w-4 animate-spin" />
                        刷新中
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-2">
                        <RefreshCw className="h-4 w-4" />
                        刷新
                      </span>
                    )}
                  </Button>
                </div>

                {blockedBy && (
                  <div
                    role="status"
                    className="flex items-center gap-2 text-xs text-[hsl(var(--color-muted-foreground))]"
                  >
                    <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                    <span>正在{describeDataJob(blockedBy)}，完成后即可继续其他数据操作。</span>
                  </div>
                )}

                {(progress || dataBusy) && (
                  <div className="space-y-2" aria-live="polite">
                    {progress ? (
                      <>
                        <div className="flex justify-between text-sm">
                          <span className="text-[hsl(var(--color-muted-foreground))]">{progress.phase}</span>
                          <span className="font-mono">
                            {progress.current}/{progress.total}
                          </span>
                        </div>
                        <div
                          role="progressbar"
                          aria-label="剧情数据处理进度"
                          aria-valuemin={0}
                          aria-valuemax={100}
                          aria-valuenow={dataProgressPercent ?? undefined}
                          aria-valuetext={`${progress.phase}：${progress.message || `${progress.current}/${progress.total}`}`}
                          className="w-full bg-[hsl(var(--color-secondary))] rounded-full h-2 overflow-hidden"
                        >
                          <div
                            className="bg-[hsl(var(--color-primary))] h-full transition-all duration-300"
                            style={{ width: `${dataProgressPercent ?? 0}%` }}
                          />
                        </div>
                        <p className="text-xs text-[hsl(var(--color-muted-foreground))]">{progress.message}</p>
                      </>
                    ) : (
                      <>
                        <div className="flex justify-between text-sm">
                          <span className="text-[hsl(var(--color-muted-foreground))]">
                            {syncing ? "连接中" : preparingImport && !importing ? "等待选择文件" : "正在导入"}
                          </span>
                          <span className="font-mono" aria-hidden="true">
                            …
                          </span>
                        </div>
                        <div
                          role="progressbar"
                          aria-label="剧情数据处理进度"
                          aria-valuetext={
                            syncing ? "正在开始同步" : preparingImport && !importing ? "等待选择文件" : "正在导入"
                          }
                          className="w-full bg-[hsl(var(--color-secondary))] rounded-full h-2 overflow-hidden"
                        >
                          <div className="bg-[hsl(var(--color-primary))] h-full animate-pulse" style={{ width: "30%" }} />
                        </div>
                        <p className="text-xs text-[hsl(var(--color-muted-foreground))]">
                          {syncing
                            ? "正在开始同步…"
                            : preparingImport && !importing
                            ? "请在系统对话框中选择 ZIP 压缩包"
                            : "请稍候"}
                        </p>
                      </>
                    )}
                  </div>
                )}

                {error && (
                  <div
                    role="alert"
                    className="flex items-start justify-between gap-3 rounded-md border border-[hsl(var(--color-destructive))] bg-[hsl(var(--color-destructive)/0.08)] px-3 py-2"
                  >
                    <span className="text-sm text-[hsl(var(--color-destructive))] break-words">{error}</span>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="flex-shrink-0"
                      onClick={() => setError(null)}
                    >
                      知道了
                    </Button>
                  </div>
                )}

                {statusNotice && !error && (
                  <div className="text-xs text-[hsl(var(--color-success))]">{statusNotice.text}</div>
                )}

                <div className="flex flex-wrap gap-3">
                  <Button onClick={handleSyncClick} disabled={dataActionsDisabled}>
                    {syncing ? (
                      <span className="inline-flex items-center gap-2">
                        <Loader2 className="h-4 w-4 animate-spin" />
                        同步中...
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-2">
                        <Download className="h-4 w-4" />
                        开始同步
                      </span>
                    )}
                  </Button>
                  <Button
                    variant="outline"
                    onClick={handleImportClick}
                    disabled={dataActionsDisabled}
                  >
                    {importBusy ? (
                      <span className="inline-flex items-center gap-2">
                        <Loader2 className="h-4 w-4 animate-spin" />
                        {importing ? "导入中..." : "等待选择..."}
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-2">
                        <Upload className="h-4 w-4" />
                        导入 ZIP
                      </span>
                    )}
                  </Button>
                </div>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".zip"
                  className="hidden"
                  onChange={handleFileSelected}
                />
            </CardContent>
          </Card>

            <Card
              className="motion-safe:animate-in motion-safe:fade-in-0 motion-safe:duration-500"
              style={{ animationDelay: "120ms" }}
            >
              <CardHeader>
                <CardTitle>应用更新</CardTitle>
                <CardDescription>检测更新并触发客户端安装</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="flex flex-wrap items-center gap-4">
                  <div>
                    <div className="text-xs text-[hsl(var(--color-muted-foreground))]">当前版本</div>
                    <div className="font-mono text-sm">
                      {appVersion || (runtimePlatform === "unknown" ? "非 Tauri 环境" : "读取中...")}
                    </div>
                  </div>
                  <div>
                    <div className="text-xs text-[hsl(var(--color-muted-foreground))]">运行平台</div>
                    <div className="text-sm font-medium">
                      {runtimePlatform === "android"
                        ? "Android"
                        : runtimePlatform === "desktop"
                        ? "桌面端"
                        : "未知"}
                    </div>
                  </div>
                </div>

                {runtimePlatform === "unknown" ? (
                  <p className="text-sm text-[hsl(var(--color-muted-foreground))]">
                    当前环境并非 Tauri 应用，无法检查或安装更新。
                  </p>
                ) : null}

                {updateStatus === "available" && availableUpdate ? (
                  <div className="rounded-lg border border-dashed border-[hsl(var(--color-border))] bg-[hsl(var(--color-accent)/0.35)] p-3 space-y-2">
                    <div className="font-medium">
                      {availableUpdate.platform === "desktop" ? "桌面端" : "Android"} 新版本
                      {" "}
                      {availableUpdate.platform === "desktop"
                        ? availableUpdate.availableVersion
                        : availableUpdate.manifest.version}
                    </div>
                    {availableUpdate.platform === "desktop" && availableUpdate.notes ? (
                      <p className="text-xs leading-relaxed text-[hsl(var(--color-muted-foreground))] whitespace-pre-wrap">
                        {availableUpdate.notes}
                      </p>
                    ) : null}
                    {availableUpdate.platform === "android" && availableUpdate.manifest.notes ? (
                      <p className="text-xs leading-relaxed text-[hsl(var(--color-muted-foreground))] whitespace-pre-wrap">
                        {availableUpdate.manifest.notes}
                      </p>
                    ) : null}
                  </div>
                ) : null}

                {updateStatus === "up-to-date" ? (
                  <p className="text-sm text-[hsl(var(--color-success))]">当前已是最新版本。</p>
                ) : null}

                {updateStatus === "needs-permission" ? (
                  <p className="text-sm text-[hsl(var(--color-warning))]">
                    已打开系统授权界面，请允许安装未知来源应用，然后返回并重新点击“立即更新”。
                  </p>
                ) : null}

                {isInstallingUpdate ? (
                  <div className="space-y-2" aria-live="polite">
                    <div className="flex justify-between text-sm">
                      <span className="text-[hsl(var(--color-muted-foreground))]">
                        {downloadProgress?.done ? "准备安装" : "下载中"}
                      </span>
                      <span className="font-mono text-xs">
                        {downloadProgress
                          ? downloadProgress.totalBytes
                            ? `${formatMegabytes(downloadProgress.downloadedBytes)} / ${formatMegabytes(
                                downloadProgress.totalBytes
                              )}`
                            : formatMegabytes(downloadProgress.downloadedBytes)
                          : "…"}
                      </span>
                    </div>
                    <div
                      role="progressbar"
                      aria-label="更新包下载进度"
                      aria-valuemin={0}
                      aria-valuemax={100}
                      aria-valuenow={downloadProgress?.percent ?? undefined}
                      aria-valuetext={
                        downloadProgress?.percent != null
                          ? `已下载 ${downloadProgress.percent}%`
                          : downloadProgress
                          ? `已下载 ${formatMegabytes(downloadProgress.downloadedBytes)}`
                          : "正在准备下载"
                      }
                      className="w-full bg-[hsl(var(--color-secondary))] rounded-full h-2 overflow-hidden"
                    >
                      {downloadProgress?.percent != null ? (
                        <div
                          className="bg-[hsl(var(--color-primary))] h-full transition-all duration-300"
                          style={{ width: `${downloadProgress.percent}%` }}
                        />
                      ) : (
                        <div
                          className="bg-[hsl(var(--color-primary))] h-full animate-pulse"
                          style={{ width: "30%" }}
                        />
                      )}
                    </div>
                  </div>
                ) : null}

                {updateMessage && updateStatus !== "available" ? (
                  <p className="text-sm text-[hsl(var(--color-muted-foreground))]">{updateMessage}</p>
                ) : null}

                {updateIssue ? (
                  <div className="space-y-1">
                    <p className={cn("text-sm", updateIssueClass)}>{updateIssue.message}</p>
                    {updateIssue.tone !== "error" ? (
                      <p className="text-xs text-[hsl(var(--color-muted-foreground))]">
                        这不影响继续使用当前版本。
                      </p>
                    ) : null}
                  </div>
                ) : null}

                {/* 禁用态的按钮吃不到 hover，占用原因必须直接写出来。 */}
                {installBlocked && activeJob ? (
                  <p role="status" className="text-sm text-[hsl(var(--color-muted-foreground))]">
                    正在{describeDataJob(activeJob)}，完成后即可安装更新。
                  </p>
                ) : null}

                <div className="flex flex-wrap gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    onClick={handleCheckAppUpdate}
                    disabled={runtimePlatform === "unknown" || isCheckingUpdate || isInstallingUpdate}
                  >
                    {isCheckingUpdate ? (
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    ) : (
                      <RefreshCw className="mr-2 h-4 w-4" />
                    )}
                    {/* 「重试检查」只在检查本身失败时出现；安装失败的重试入口是旁边的「立即更新」。 */}
                    {isCheckingUpdate ? "检查中..." : updateIssue && !availableUpdate ? "重试检查" : "检查更新"}
                  </Button>
                  {availableUpdate ? (
                    <Button
                      type="button"
                      onClick={handleInstallAppUpdate}
                      disabled={isInstallingUpdate || installBlocked}
                    >
                      {isInstallingUpdate ? (
                        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                      ) : (
                        <Download className="mr-2 h-4 w-4" />
                      )}
                      {isInstallingUpdate ? "更新中..." : "立即更新"}
                    </Button>
                  ) : null}
                </div>
              </CardContent>
            </Card>

          <Card className="motion-safe:animate-in motion-safe:fade-in-0 motion-safe:duration-500" style={{ animationDelay: "180ms" }}>
            <CardHeader>
              <CardTitle>素材与外观</CardTitle>
              <CardDescription>控制封面、头像、插画等装饰性素材</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <SettingsRow
                title="极简模式"
                subtitle="隐藏全部封面、头像与插画，回到纯文本阅读"
                control={
                  <Toggle
                    on={minimalMode}
                    onChange={(v) => setMinimalMode(v)}
                    label={minimalMode ? "已开启" : "未开启"}
                  />
                }
              />
              <SettingsRow
                title="阅读器内插画"
                subtitle="剧情中 [Image] 段落是否渲染；关闭可降低流量消耗"
                control={
                  <Toggle
                    on={inlineImages}
                    onChange={(v) => setInlineImages(v)}
                    label={inlineImages ? "已启用" : "已关闭"}
                  />
                }
              />
              <div className="text-xs text-[hsl(var(--color-muted-foreground))] leading-relaxed">
                素材来自公开社区镜像：
                <span className="ml-1">
                  yuanyan3060/ArknightsGameResource · fexli/ArknightsResource · PuppiizSunniiz/Arknight-Images
                </span>
              </div>
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setMinimalMode(!minimalMode)}
                >
                  {minimalMode ? <Eye className="h-4 w-4 mr-1.5" /> : <EyeOff className="h-4 w-4 mr-1.5" />}
                  {minimalMode ? "显示全部素材" : "切换极简模式"}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setInlineImages(false)}
                  disabled={!inlineImages}
                >
                  <ImageOff className="h-4 w-4 mr-1.5" />
                  关闭插画
                </Button>
              </div>
            </CardContent>
          </Card>

          <Card className="motion-safe:animate-in motion-safe:fade-in-0 motion-safe:duration-500" style={{ animationDelay: "240ms" }}>
            <CardHeader>
              <CardTitle>缓存与索引</CardTitle>
              <CardDescription>统一管理本地索引与人物统计</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2 text-sm text-[hsl(var(--color-muted-foreground))]">
                <p>
                  若搜索结果或人物统计与最新数据不符，可在此重新构建相关索引。
                </p>
                {blockedBy && (
                  <p role="status" className="text-xs">
                    正在{describeDataJob(blockedBy)}，完成后即可继续。
                  </p>
                )}
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <Button
                  variant="outline"
                  onClick={handleRebuildIndex}
                  disabled={dataActionsDisabled}
                >
                  <RefreshCw className="h-4 w-4 mr-2" aria-hidden="true" /> 重新建立全文索引
                </Button>
                <Button
                  variant="outline"
                  onClick={handleRefreshCharacters}
                  disabled={dataActionsDisabled}
                >
                  <RefreshCw className="h-4 w-4 mr-2" aria-hidden="true" /> 刷新人物统计
                </Button>
              </div>
            </CardContent>
          </Card>

            <Card className="motion-safe:animate-in motion-safe:fade-in-0 motion-safe:duration-500" style={{ animationDelay: "300ms" }}>
              <CardHeader>
                <CardTitle>关于</CardTitle>
                <CardDescription>应用信息</CardDescription>
              </CardHeader>
              <CardContent className="space-y-2">
                <div className="flex justify-between">
                  <span className="text-[hsl(var(--color-muted-foreground))]">版本</span>
                  <span className="font-mono text-sm">{appVersion || "—"}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-[hsl(var(--color-muted-foreground))]">作者</span>
                  <span className="text-sm">helix</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-[hsl(var(--color-muted-foreground))]">数据来源</span>
                  <span className="text-sm">ArknightsGameData</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-[hsl(var(--color-muted-foreground))]">交流群</span>
                  <span className="text-sm">罗德岛重建管理委员会 994121470</span>
                </div>
              </CardContent>
            </Card>
          </div>
        </CustomScrollArea>
      </main>
    </div>
  );
}

function SettingsRow({
  title,
  subtitle,
  control,
}: {
  title: string;
  subtitle?: string;
  control: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-4">
      <div className="min-w-0">
        <div className="text-sm font-medium">{title}</div>
        {subtitle && (
          <div className="text-xs text-[hsl(var(--color-muted-foreground))] mt-0.5">{subtitle}</div>
        )}
      </div>
      <div className="flex-shrink-0">{control}</div>
    </div>
  );
}

function Toggle({
  on,
  onChange,
  label,
}: {
  on: boolean;
  onChange: (v: boolean) => void;
  label?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      onClick={() => onChange(!on)}
      className={cn(
        "relative inline-flex h-6 w-11 flex-shrink-0 items-center rounded-full border transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[hsl(var(--color-ring))] focus-visible:ring-offset-2 focus-visible:ring-offset-[hsl(var(--color-card))]",
        on
          ? "bg-[hsl(var(--color-primary))] border-[hsl(var(--color-primary))]"
          : "bg-[hsl(var(--color-secondary))] border-[hsl(var(--color-border))]"
      )}
      aria-label={label}
    >
      <span
        className={cn(
          "inline-block h-5 w-5 transform rounded-full bg-[hsl(var(--color-card))] shadow transition-transform",
          on ? "translate-x-5" : "translate-x-0.5"
        )}
      />
    </button>
  );
}
