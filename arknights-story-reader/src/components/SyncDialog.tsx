import { ChangeEvent, useEffect, useRef } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { AlertCircle, CheckCircle, Download, Loader2, Upload } from "lucide-react";
import { useDataSyncManager } from "@/hooks/useDataSyncManager";

interface SyncDialogProps {
  open: boolean;
  onClose: () => void;
  onSuccess: () => void;
}

export function SyncDialog({ open, onClose, onSuccess }: SyncDialogProps) {
  const {
    syncing,
    importing,
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

  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const handleFileSelected = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    await importFromFile(file);
  };

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 motion-safe:animate-in motion-safe:fade-in-0 motion-safe:duration-300">
      <Card className="w-full max-w-md mx-4 motion-safe:animate-in motion-safe:zoom-in-95 motion-safe:duration-300">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Download className="h-5 w-5" />
            数据同步
          </CardTitle>
          <CardDescription>管理剧情数据版本</CardDescription>
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
                <AlertCircle className="h-4 w-4" />
                <span>需要首次安装</span>
              </div>
            )}
            {status === "update-available" && (
              <div className="flex items-center gap-2 text-sm text-[hsl(var(--color-primary))]">
                <AlertCircle className="h-4 w-4" />
                <span>有新版本可用</span>
              </div>
            )}
            {status === "up-to-date" && (
              <div className="flex items-center gap-2 text-sm text-[hsl(var(--color-success))]">
                <CheckCircle className="h-4 w-4" />
                <span>已是最新版本</span>
              </div>
            )}
          </div>

          {(progress || syncing || importing) && (
            <div className="space-y-2">
              {progress ? (
                <>
                  <div className="flex justify-between text-sm">
                    <span className="text-[hsl(var(--color-muted-foreground))]">{progress.phase}</span>
                    <span className="font-mono">
                      {progress.current}/{progress.total}
                    </span>
                  </div>
                  <div className="w-full bg-[hsl(var(--color-secondary))] rounded-full h-2 overflow-hidden">
                    <div
                      className="bg-[hsl(var(--color-primary))] h-full transition-all duration-300"
                      style={{
                        width: `${progress.total > 0 ? Math.min((progress.current / progress.total) * 100, 100) : 0}%`,
                      }}
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
                    <span className="font-mono">…</span>
                  </div>
                  <div className="w-full bg-[hsl(var(--color-secondary))] rounded-full h-2 overflow-hidden">
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
            <div className="p-3 bg-[hsl(var(--color-destructive)/0.1)] border border-[hsl(var(--color-destructive))] rounded-md">
              <p className="text-sm text-[hsl(var(--color-destructive))]">{error}</p>
            </div>
          )}

          <div className="flex gap-2">
            <Button
              variant="outline"
              onClick={() => {
                resetProgress();
                setError(null);
                onClose();
              }}
              disabled={syncing || importing}
              className="flex-1"
            >
              关闭
            </Button>
            <Button onClick={() => void handleSync()} disabled={syncing || importing} className="flex-1">
              {syncing ? (
                <span className="inline-flex items-center gap-2">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  同步中...
                </span>
              ) : status === "up-to-date" ? (
                "已是最新"
              ) : (
                "开始同步"
              )}
            </Button>
            <Button
              variant="outline"
              onClick={() => fileInputRef.current?.click()}
              disabled={syncing || importing}
              className="flex-1"
            >
              {importing ? (
                <span className="inline-flex items-center gap-2">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  导入中...
                </span>
              ) : (
                <span className="inline-flex items-center gap-2">
                  <Upload className="h-4 w-4" />
                  导入 ZIP
                </span>
              )}
            </Button>
            <input
              ref={fileInputRef}
              type="file"
              accept=".zip"
              className="hidden"
              onChange={handleFileSelected}
            />
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
