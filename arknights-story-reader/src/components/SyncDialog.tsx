import { ChangeEvent, useCallback, useEffect, useRef } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { AlertCircle, CheckCircle, Download, Loader2, Upload } from "lucide-react";
import { describeDataJob, useDataSyncManager } from "@/hooks/useDataSyncManager";
import { safeConfirm } from "@/hooks/useAppUpdater";

interface SyncDialogProps {
  open: boolean;
  onClose: () => void;
  onSuccess: () => void;
}

/** 焦点圈进对话框用的选择器；隐藏的 <input type="file"> 会在下面按可见性筛掉。 */
const FOCUSABLE_SELECTOR =
  'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

export function SyncDialog({ open, onClose, onSuccess }: SyncDialogProps) {
  const {
    syncing,
    importing,
    busy,
    blockedBy,
    progress,
    error,
    setError,
    currentVersion,
    remoteVersion,
    status,
    handleSync,
    importFromFile,
    resetProgress,
  } = useDataSyncManager({ active: open, onSuccess });

  useEffect(() => {
    if (!open) {
      resetProgress();
      setError(null);
    }
  }, [open, resetProgress, setError]);

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
      if (event.key === "Escape") {
        handleClose();
        return;
      }
      if (event.key !== "Tab") return;
      const card = cardRef.current;
      if (!card) return;
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

  const handleFileSelected = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    // 选完再确认：先弹确认框会丢掉用户手势，部分 WebView 就打不开文件选择器了。
    const confirmed = await safeConfirm(
      `导入 ${file.name} 会覆盖本机已有的剧情数据，确定继续？`,
      { title: "导入 ZIP", kind: "warning" }
    );
    if (!confirmed) return;
    await importFromFile(file);
  };

  if (!open) return null;

  const actionsDisabled = busy || blockedBy !== null;
  const percent =
    progress && progress.total > 0
      ? Math.min(Math.round((progress.current / progress.total) * 100), 100)
      : null;

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
              <span className="text-sm font-mono">{currentVersion || "未安装"}</span>
            </div>
            <div className="flex justify-between items-center">
              <span className="text-sm text-[hsl(var(--color-muted-foreground))]">最新版本</span>
              <span className="text-sm font-mono">{remoteVersion || "未知"}</span>
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

          {/* 别处（设置页 / 自动索引 / 更新安装）占着任务锁时，说清在等谁。 */}
          {blockedBy && (
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
                    <span className="font-mono">
                      {progress.current}/{progress.total}
                    </span>
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
                    <div
                      className="bg-[hsl(var(--color-primary))] h-full transition-all duration-300"
                      style={{ width: `${percent ?? 0}%` }}
                    />
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
                  const ok = await safeConfirm(
                    "当前已是最新。再次同步会重新下载并覆盖本机数据，确定继续？",
                    { title: "重新同步", kind: "warning" }
                  );
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
              onClick={() => fileInputRef.current?.click()}
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
