import { ChangeEvent, useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { AlertCircle, CheckCircle, Download, Loader2, Upload } from "lucide-react";
import {
  acquireDataJob,
  dataJobConflictMessage,
  describeDataJob,
  useDataSyncManager,
} from "@/hooks/useDataSyncManager";
import { safeConfirm } from "@/hooks/useAppUpdater";

interface SyncDialogProps {
  open: boolean;
  onClose: () => void;
  onSuccess: () => void;
}

/** 焦点圈进对话框用的选择器；隐藏的 <input type="file"> 会在下面按可见性筛掉。 */
const FOCUSABLE_SELECTOR =
  'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

/**
 * 文件选择器取消侦测的宽限期：窗口回焦说明系统选择器已收场，但选中文件的
 * change 事件可能还在路上（Android 从选择器 activity 返回有延迟），等满
 * 宽限期仍没有 change 才按「用户取消」处理。取值与 Settings 的回退导入一致。
 */
const FILE_PICKER_CANCEL_GRACE_MS = 1500;

/**
 * 兜底超时：个别平台打开文件选择器不夺窗口焦点，「先失焦再回焦」的取消
 * 侦测永远布防不了，寄存的锁会一直占着。等这么久仍没有 change 就按取消
 * 放锁，保证不死锁；取 5 分钟而不是几秒，避免误伤慢慢挑文件的用户。
 */
const FILE_PICKER_STUCK_RELEASE_MS = 5 * 60_000;

export function SyncDialog({ open, onClose, onSuccess }: SyncDialogProps) {
  const {
    syncing,
    importing,
    busy,
    blockedBy,
    loadingInfo,
    progress,
    error,
    setError,
    currentVersion,
    remoteVersion,
    status,
    handleSync,
    importFromFile,
    loadVersionInfo,
    resetProgress,
  } = useDataSyncManager({ active: open, onSuccess });

  /** 「重新同步」确认框弹着的忙态；此时 "sync" 任务锁已被下面的点击流程预占。 */
  const [preparingSync, setPreparingSync] = useState(false);
  /**
   * 文件选择器 / 覆盖确认框弹着的忙态；此时 "import" 任务锁已被本对话框
   * 预占（寄存或已交到 handleFileSelected 手里）。与 preparingSync 同一
   * 用途：blockedBy 分不清「别处真在导入」和「自己预占」，靠它把那行
   * 「正在导入 ZIP」压下去。
   */
  const [preparingImport, setPreparingImport] = useState(false);

  useEffect(() => {
    if (!open) {
      resetProgress();
      setError(null);
    }
  }, [open, resetProgress, setError]);

  // 数据可能在别处被换掉（设置页的同步/导入）：本对话框在数据未安装时会
  // 自动弹出并跨 tab 常开，用户切去设置页装完数据再切回来，这里若不跟着
  // 刷新，就会顶着「当前版本 未安装 / 需要首次安装」的过期状态继续催用户
  // 重新下载。版本信息只在 open 变化时加载过一次，所以要单独听数据更新。
  useEffect(() => {
    if (!open) return;
    const handler = () => void loadVersionInfo({ silent: true });
    window.addEventListener("app:data-updated", handler);
    return () => window.removeEventListener("app:data-updated", handler);
  }, [open, loadVersionInfo]);

  const handleClose = useCallback(() => {
    if (busy) return;
    resetProgress();
    setError(null);
    onClose();
  }, [busy, onClose, resetProgress, setError]);

  const cardRef = useRef<HTMLDivElement | null>(null);

  // 打开期间锁住背景滚动：iOS/Android 上手指落在遮罩外仍会把列表滑走，
  // 关掉时恢复原值而不是硬写空字符串，免得踩掉别处设置的 overflow。
  useEffect(() => {
    if (!open) return;
    const { body } = document;
    const previousOverflow = body.style.overflow;
    body.style.overflow = "hidden";
    return () => {
      body.style.overflow = previousOverflow;
    };
  }, [open]);

  // 焦点管理：进来先落到对话框上（读屏会念出标题），离开时还给触发它的元素。
  useEffect(() => {
    if (!open) return;
    const previouslyFocused = document.activeElement as HTMLElement | null;
    cardRef.current?.focus();
    return () => {
      if (previouslyFocused && document.contains(previouslyFocused)) {
        previouslyFocused.focus();
      }
    };
  }, [open]);

  // Esc 关闭 + Tab 焦点环。同步/导入期间 handleClose 自己会拦住关闭动作，
  // 避免用户以为任务被取消了。
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      const card = cardRef.current;
      // 对话框挂在 StoryList 里，数据未安装时会在后台自动打开；此时所在的
      // KeepAlive 面板是 inert 的，对话框并没有呈现在用户面前，不能再吃
      // Esc/Tab——否则 Tab 被 preventDefault 而焦点又进不了 inert 子树，
      // 整个应用的 Tab 键就失灵了（同 SheetShell 的 isPresented 守卫）。
      if (!card || card.closest("[inert]")) return;
      if (event.key === "Escape") {
        handleClose();
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = Array.from(card.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
        (element) => element.getClientRects().length > 0
      );
      if (focusable.length === 0) {
        event.preventDefault();
        card.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement as HTMLElement | null;
      // 焦点跑到对话框外面（背景里的按钮）时也要拽回来，否则「模态」名不副实。
      const outside = !active || !card.contains(active);
      if (event.shiftKey) {
        if (outside || active === first || active === card) {
          event.preventDefault();
          last.focus();
        }
      } else if (outside || active === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, handleClose]);

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  /** 点击是否始于遮罩本身：从卡片里拖选文字松手落在遮罩上不该关掉对话框。 */
  const overlayPressRef = useRef(false);

  /**
   * 文件选择器开着期间寄存的 "import" 任务锁（与 Settings 的回退导入同一套
   * 纪律）。系统选择器可能开很久，这段时间锁必须占着：否则自动索引 / 自动
   * 更新安装会以为没人干活趁虚抢锁——更新装完直接重启进程，用户选完文件
   * 回来，导入也只会被「正在××」驳回。锁的去向只有两条：选到文件且用户
   * 确认，整把交棒给 importFromFile；其余情况（取消侦测命中、确认框点否、
   * 对话框被关掉）就地释放。
   */
  const pendingImportJobRef = useRef<(() => void) | null>(null);
  /** 撤掉取消侦测（blur / focus / visibility 监听 + 各计时器）；锁本身由调用方另行处置。 */
  const pendingImportWatchCleanupRef = useRef<(() => void) | null>(null);

  /** 取走寄存的锁并撤掉侦听；之后交棒还是释放由取走的人决定。 */
  const takePendingImportJob = useCallback(() => {
    pendingImportWatchCleanupRef.current?.();
    const job = pendingImportJobRef.current;
    pendingImportJobRef.current = null;
    return job;
  }, []);

  /**
   * 寄存锁并布防取消侦测（做法与 Settings 的 armPendingImportWatch 一致）：
   * 先等窗口失焦 / 页面隐藏，确认「选择器真的打开了」，之后的回焦才可信；
   * 回焦后等一个宽限期让可能在路上的 change 先到，等不到才按「用户取消」
   * 放锁。用户在选择器里泡多久都安全——期间窗口始终失焦，倒计时无从开始。
   * 个别平台打开选择器不夺焦点，由 5 分钟兜底超时保证最终放锁、不死锁。
   * 万一误判（change 姗姗来迟），importFromFile 会退回自己抢锁，行为与
   * 修复前一致，不会更糟。
   */
  const armPendingImportWatch = useCallback((releaseJob: () => void) => {
    pendingImportJobRef.current = releaseJob;
    /** 已确认选择器真正打开过（窗口失焦 / 页面隐藏），回焦事件才可信。 */
    let pickerSeen = false;
    let graceTimer: number | null = null;
    let stuckTimer: number | null = null;

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
      // 倒计时，绝不在用户看不见页面时放锁。
      stopGrace();
    };
    const onGotFocus = () => {
      if (!pickerSeen) return;
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

  /** 收尾：撤掉侦听并释放仍寄存的锁（释放函数幂等，重复调用无害）。 */
  const settleParkedImport = useCallback(() => {
    pendingImportWatchCleanupRef.current?.();
    pendingImportJobRef.current?.();
    pendingImportJobRef.current = null;
    setPreparingImport(false);
  }, []);

  // 对话框关掉后 <input type="file"> 随之卸载，change 再也不会来：寄存中的
  // 锁必须就地释放，否则得干等 5 分钟兜底，期间设置页的同步/导入入口全被
  // 这把幽灵锁禁用。（寄存期间 busy 为 false，handleClose 不拦关闭——比如
  // Android 返回键的 Escape 兜底，所以这条路真的走得到。）组件卸载同理。
  useEffect(() => {
    if (!open) settleParkedImport();
  }, [open, settleParkedImport]);
  useEffect(() => () => settleParkedImport(), [settleParkedImport]);

  const handleFileSelected = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    // 同步取走寄存的锁并撤掉取消侦测：选择器收场的回焦宽限可能已经在倒
    // 计时，晚一个 await 锁就会被当成「用户取消」放掉。
    const transferredJob = takePendingImportJob();
    if (!file) {
      transferredJob?.();
      setPreparingImport(false);
      return;
    }
    // 选完再确认：先弹确认框会丢掉用户手势，部分 WebView 就打不开文件选择器了。
    // 确认期间锁仍握在手里，排队等锁的自动更新安装抢不进来。
    const confirmed = await safeConfirm(
      `导入 ${file.name} 会覆盖本机已有的剧情数据，确定继续？`,
      { title: "导入 ZIP", kind: "warning" }
    );
    if (!confirmed) {
      transferredJob?.();
      setPreparingImport(false);
      return;
    }
    try {
      // 把锁整把交棒给 importFromFile，绝不能先放再让它重抢：释放会同步
      // 唤醒 acquireDataJobWhenIdle 的等待者（自动更新安装），同一个 tick
      // 里锁就被截走。侦测误判提前放了锁时 transferredJob 为 null，
      // importFromFile 退回自己抢锁，行为与修复前一致。
      await importFromFile(file, { transferredJob: transferredJob ?? undefined });
    } finally {
      // 释放函数幂等，这里兜底再放一次无害（正常已由导入流程释放）。
      transferredJob?.();
      setPreparingImport(false);
    }
  };

  if (!open) return null;

  const actionsDisabled = busy || preparingSync || preparingImport || blockedBy !== null;
  const percent =
    progress && progress.total > 0
      ? Math.min(Math.round((progress.current / progress.total) * 100), 100)
      : null;

  const handleImportClick = () => {
    // 连点第二下可能赶在重渲染禁用按钮之前：锁已寄存说明选择器正在打开，
    // 直接忽略，别对着用户自己的操作报「导入正在进行」。
    if (actionsDisabled || pendingImportJobRef.current) return;
    // 系统选择器可能开很久，先抢下 "import" 锁寄存给选择器流程，堵住这段
    // 时间自动索引 / 自动更新安装的空窗（后者拿到锁会直接重启进程）。
    const releaseJob = acquireDataJob("import");
    if (!releaseJob) {
      setError(dataJobConflictMessage("导入"));
      return;
    }
    setError(null);
    armPendingImportWatch(releaseJob);
    setPreparingImport(true);
    fileInputRef.current?.click();
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 motion-safe:animate-in motion-safe:fade-in-0 motion-safe:duration-300"
      onMouseDown={(event) => {
        overlayPressRef.current = event.target === event.currentTarget;
      }}
      onClick={(event) => {
        if (event.target !== event.currentTarget || !overlayPressRef.current) return;
        overlayPressRef.current = false;
        handleClose();
      }}
    >
      <Card
        ref={cardRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="sync-dialog-title"
        aria-describedby="sync-dialog-description"
        aria-busy={busy}
        tabIndex={-1}
        className="w-full max-w-md mx-4 outline-none motion-safe:animate-in motion-safe:zoom-in-95 motion-safe:duration-300"
      >
        <CardHeader>
          <CardTitle id="sync-dialog-title" className="flex items-center gap-2">
            <Download className="h-5 w-5" aria-hidden="true" />
            数据同步
          </CardTitle>
          <CardDescription id="sync-dialog-description">管理剧情数据版本</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <div className="flex justify-between items-center">
              <span className="text-sm text-[hsl(var(--color-muted-foreground))]">当前版本</span>
              {/* 空串 = 版本还没加载出来或读取失败（status 为 unknown），不能写成
                  「未安装」——真正未安装时后端返回的就是「未安装」字样。 */}
              <span className="text-sm font-mono">
                {currentVersion || (loadingInfo ? "读取中..." : "未知")}
              </span>
            </div>
            <div className="flex justify-between items-center">
              <span className="text-sm text-[hsl(var(--color-muted-foreground))]">最新版本</span>
              {/* 与「当前版本」同一纪律：请求还在途时不能抢答「未知」——
                  远程版本要走网络，是这几项里挂得最久的。 */}
              <span className="text-sm font-mono">
                {remoteVersion || (loadingInfo ? "读取中..." : "未知")}
              </span>
            </div>
            {status === "not-installed" && (
              <div className="flex items-center gap-2 text-sm text-[hsl(var(--color-primary))]">
                <AlertCircle className="h-4 w-4" aria-hidden="true" />
                <span>需要首次安装</span>
              </div>
            )}
            {status === "update-available" && (
              <div className="flex items-center gap-2 text-sm text-[hsl(var(--color-primary))]">
                <AlertCircle className="h-4 w-4" aria-hidden="true" />
                <span>有新版本可用</span>
              </div>
            )}
            {status === "up-to-date" && (
              <div className="flex items-center gap-2 text-sm text-[hsl(var(--color-success))]">
                <CheckCircle className="h-4 w-4" aria-hidden="true" />
                <span>已是最新版本</span>
              </div>
            )}
          </div>

          {/* 别处（设置页 / 自动索引 / 更新安装）占着任务锁时，说清在等谁。
              锁被本对话框自己预占时这行不该出来：重新同步确认框期间
              （preparingSync）说「正在同步剧情数据」、文件选择器 / 覆盖确认
              期间（preparingImport）说「正在导入 ZIP」，都会和用户还没点头
              的事实自相矛盾——导入根本没开始，也不存在「完成」可等。 */}
          {blockedBy && !preparingSync && !preparingImport && (
            <div className="flex items-center gap-2 text-xs text-[hsl(var(--color-muted-foreground))]" role="status">
              <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
              <span>正在{describeDataJob(blockedBy)}，完成后即可继续操作。</span>
            </div>
          )}

          {(progress || busy) && (
            <div className="space-y-2" aria-live="polite">
              {progress ? (
                <>
                  <div className="flex justify-between text-sm">
                    <span className="text-[hsl(var(--color-muted-foreground))]">{progress.phase}</span>
                    {/* total <= 0 是后端「还没有真实刻度」的约定（见 api.ts）：
                        下载无 Content-Length 时会一直发 (0, 0)，此时画确定态
                        0% 进度条和「0/0」计数是编的——像卡死了一样。 */}
                    {percent !== null ? (
                      <span className="font-mono">
                        {progress.current}/{progress.total}
                      </span>
                    ) : (
                      <span className="font-mono" aria-hidden="true">
                        …
                      </span>
                    )}
                  </div>
                  <div
                    role="progressbar"
                    aria-label="剧情数据处理进度"
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={percent ?? undefined}
                    aria-valuetext={`${progress.phase}：${progress.message || `${progress.current}/${progress.total}`}`}
                    className="w-full bg-[hsl(var(--color-secondary))] rounded-full h-2 overflow-hidden"
                  >
                    {percent !== null ? (
                      <div
                        className="bg-[hsl(var(--color-primary))] h-full transition-all duration-300"
                        style={{ width: `${percent}%` }}
                      />
                    ) : (
                      <div className="bg-[hsl(var(--color-primary))] h-full animate-pulse" style={{ width: "30%" }} />
                    )}
                  </div>
                  <p className="text-xs text-[hsl(var(--color-muted-foreground))]">{progress.message}</p>
                </>
              ) : (
                <>
                  <div className="flex justify-between text-sm">
                    <span className="text-[hsl(var(--color-muted-foreground))]">
                      {syncing ? "连接中" : "正在导入"}
                    </span>
                    <span className="font-mono" aria-hidden="true">
                      …
                    </span>
                  </div>
                  <div
                    role="progressbar"
                    aria-label="剧情数据处理进度"
                    aria-valuetext={syncing ? "正在开始同步" : "正在导入"}
                    className="w-full bg-[hsl(var(--color-secondary))] rounded-full h-2 overflow-hidden"
                  >
                    <div className="bg-[hsl(var(--color-primary))] h-full animate-pulse" style={{ width: "30%" }} />
                  </div>
                  <p className="text-xs text-[hsl(var(--color-muted-foreground))]">
                    {syncing ? "正在开始同步…" : "请稍候"}
                  </p>
                </>
              )}
            </div>
          )}

          {error && (
            <div
              role="alert"
              className="flex items-start justify-between gap-3 p-3 bg-[hsl(var(--color-destructive)/0.1)] border border-[hsl(var(--color-destructive))] rounded-md"
            >
              <p className="text-sm text-[hsl(var(--color-destructive))] break-words">{error}</p>
              <Button variant="ghost" size="sm" className="flex-shrink-0" onClick={() => setError(null)}>
                知道了
              </Button>
            </div>
          )}

          <div className="flex gap-2">
            <Button variant="outline" onClick={handleClose} disabled={busy} className="flex-1 min-h-[44px]">
              关闭
            </Button>
            <Button
              onClick={async () => {
                if (actionsDisabled) return;
                if (status === "up-to-date") {
                  // 与设置页 handleSyncClick 同一纪律：确认框是异步的，弹着的
                  // 这段时间锁必须先占住。空着的话，自动索引的重试定时器或排队
                  // 等锁的自动更新安装（拿到锁会直接重启进程）随时抢入，用户
                  // 点完「确定」只会收到一句冲突报错，刚给出的确认就被吞掉了。
                  const releaseJob = acquireDataJob("sync");
                  if (!releaseJob) {
                    setError(dataJobConflictMessage("同步"));
                    return;
                  }
                  setPreparingSync(true);
                  let ok = false;
                  try {
                    ok = await safeConfirm(
                      "当前已是最新。再次同步会重新下载并覆盖本机数据，确定继续？",
                      { title: "重新同步", kind: "warning" }
                    );
                  } finally {
                    // handleSync 自己抢锁，这里必须先放。放锁与它的抢锁在同一个
                    // 宏任务里，定时器插不进来；能截走锁的只有 acquireDataJobWhenIdle
                    // 的同步等待者（用户已点头的自动更新安装），那种情况下
                    // handleSync 会给出明确的冲突提示，而不是静默吞确认。
                    releaseJob();
                    setPreparingSync(false);
                  }
                  if (!ok) return;
                }
                void handleSync();
              }}
              disabled={actionsDisabled}
              className="flex-1 min-h-[44px]"
            >
              {syncing ? (
                <span className="inline-flex items-center gap-2">
                  <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                  同步中...
                </span>
              ) : status === "up-to-date" ? (
                "重新同步"
              ) : (
                "开始同步"
              )}
            </Button>
            <Button
              variant="outline"
              onClick={handleImportClick}
              disabled={actionsDisabled}
              className="flex-1 min-h-[44px]"
            >
              {importing ? (
                <span className="inline-flex items-center gap-2">
                  <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                  导入中...
                </span>
              ) : (
                <span className="inline-flex items-center gap-2">
                  <Upload className="h-4 w-4" aria-hidden="true" />
                  导入 ZIP
                </span>
              )}
            </Button>
            <input
              ref={fileInputRef}
              type="file"
              accept=".zip"
              className="hidden"
              tabIndex={-1}
              onChange={handleFileSelected}
            />
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
