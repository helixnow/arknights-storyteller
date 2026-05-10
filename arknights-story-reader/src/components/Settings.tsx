import { ChangeEvent, useCallback, useEffect, useRef, useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ThemeToggle } from "@/components/ThemeToggle";
import { CustomScrollArea } from "@/components/ui/custom-scroll-area";
import { useTheme } from "@/components/theme-provider";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { AlertCircle, CheckCircle, Download, Eye, EyeOff, ImageOff, Loader2, RefreshCw, Upload } from "lucide-react";
import { useDataSyncManager } from "@/hooks/useDataSyncManager";
import { useAppPreferences } from "@/hooks/useAppPreferences";
import { getVersion as getAppVersion } from "@tauri-apps/api/app";
import {
  detectRuntimePlatform,
  checkDesktopUpdate,
  installDesktopUpdate,
  checkAndroidUpdate,
  installAndroidUpdate,
  openAndroidInstallPermissionSettings,
  type UpdateAvailability,
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

export function Settings() {
  const { themeColor, setThemeColor } = useTheme();
  const { minimalMode, setMinimalMode, inlineImages, setInlineImages } = useAppPreferences();
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
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
  const [availableUpdate, setAvailableUpdate] = useState<UpdateAvailability | null>(null);
  const runtimePlatform = detectRuntimePlatform();

  const {
    syncing,
    importing,
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
  } = useDataSyncManager({
    active: true,
    onSuccess: () => {
          setStatusMessage("数据版本信息已更新");
    },
  });

  const handleRefreshInfo = () => {
    setStatusMessage(null);
    setError(null);
    resetProgress();
    void loadVersionInfo();
  };

  const handleSyncClick = () => {
    setStatusMessage(null);
    setError(null);
    void handleSync();
  };

  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const handleImportClick = () => {
    setStatusMessage(null);
    setError(null);
    fileInputRef.current?.click();
  };

  const handleFileSelected = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    await importFromFile(file);
  };

  const toast = useToast();

  const handleRebuildIndex = useCallback(() => {
    setStatusMessage("已请求重新建立全文索引");
    setError(null);
    toast.show("已请求重新建立全文索引");
    window.dispatchEvent(new Event("app:rebuild-story-index"));
  }, [setError, toast]);

  const handleRefreshCharacters = useCallback(() => {
    setStatusMessage("已请求刷新人物统计");
    setError(null);
    toast.show("已请求刷新人物统计");
    window.dispatchEvent(new Event("app:refresh-character-stats"));
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
    setUpdateMessage(null);
    setAvailableUpdate(null);
    try {
      if (runtimePlatform === "unknown") {
        throw new Error("当前环境并非 Tauri 应用，无法检查更新。");
      }

      if (runtimePlatform === "android") {
        const result = await checkAndroidUpdate(appVersion || undefined);
        if (!result) {
          setUpdateStatus("up-to-date");
          setUpdateMessage("当前已是最新版本");
          return;
        }
        setAvailableUpdate(result);
        setUpdateStatus("available");
      } else {
        const result = await checkDesktopUpdate(appVersion || undefined);
        if (!result) {
          setUpdateStatus("up-to-date");
          setUpdateMessage("当前已是最新版本");
          return;
        }
        setAvailableUpdate(result);
        setUpdateStatus("available");
      }
    } catch (error) {
      setUpdateStatus("error");
      setUpdateMessage(error instanceof Error ? error.message : String(error));
    }
  }, [runtimePlatform, appVersion]);

  const handleInstallAppUpdate = useCallback(async () => {
    if (!availableUpdate) return;
    setUpdateStatus("installing");
    setUpdateMessage(
      availableUpdate.platform === "desktop"
        ? "正在下载并安装最新版本，请稍候..."
        : "正在下载最新安装包，请稍候..."
    );
    try {
      if (availableUpdate.platform === "desktop") {
        await installDesktopUpdate(availableUpdate, undefined, { relaunch: true });
        setUpdateStatus("installed");
        setUpdateMessage("更新已安装，应用即将重启");
        setAvailableUpdate(null);
      } else {
        const response = await installAndroidUpdate(availableUpdate);
        if (response?.needsPermission) {
          await openAndroidInstallPermissionSettings();
          setUpdateStatus("needs-permission");
          setUpdateMessage("请在系统设置中允许安装未知来源应用，然后返回应用重新点击“立即更新”。");
          return;
        }
        setUpdateStatus("installed");
        setUpdateMessage("安装程序已启动，请按照系统提示完成安装。");
        setAvailableUpdate(null);
      }
    } catch (error) {
      setUpdateStatus("error");
      setUpdateMessage(error instanceof Error ? error.message : String(error));
    }
  }, [availableUpdate]);

  const isCheckingUpdate = updateStatus === "checking";
  const isInstallingUpdate = updateStatus === "installing";

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
                            "w-full rounded-lg border p-3 text-left transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-2",
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
                    <div className="font-mono text-sm">{currentVersion || "未安装"}</div>
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
                    disabled={loadingInfo || syncing || importing}
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
                  <div className="flex items-center justify-between gap-3 rounded-md border border-[hsl(var(--color-destructive))] bg-[hsl(var(--color-destructive)/0.08)] px-3 py-2">
                    <span className="text-sm text-[hsl(var(--color-destructive))]">{error}</span>
                    <Button variant="ghost" size="sm" onClick={() => setError(null)}>
                      知道了
                    </Button>
                  </div>
                )}

                {statusMessage && !error && (
                  <div className="text-xs text-[hsl(var(--color-success))]">{statusMessage}</div>
                )}

                <div className="flex flex-wrap gap-3">
                  <Button onClick={handleSyncClick} disabled={syncing || importing}>
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
                    disabled={syncing || importing}
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
                    已打开系统授权界面，请允许安装未知来源应用后返回继续。
                  </p>
                ) : null}

                {updateMessage && updateStatus !== "available" ? (
                  <p
                    className={cn(
                      "text-sm",
                      updateStatus === "error"
                        ? "text-[hsl(var(--color-destructive))]"
                        : "text-[hsl(var(--color-muted-foreground))]"
                    )}
                  >
                    {updateMessage}
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
                    检查更新
                  </Button>
                  {availableUpdate ? (
                    <Button type="button" onClick={handleInstallAppUpdate} disabled={isInstallingUpdate}>
                      {isInstallingUpdate ? (
                        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                      ) : (
                        <Download className="mr-2 h-4 w-4" />
                      )}
                      立即更新
                    </Button>
                  ) : null}
                </div>
              </CardContent>
            </Card>

          <Card className="motion-safe:animate-in motion-safe:fade-in-0 motion-safe:duration-500" style={{ animationDelay: "70ms" }}>
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

          <Card className="motion-safe:animate-in motion-safe:fade-in-0 motion-safe:duration-500" style={{ animationDelay: "90ms" }}>
            <CardHeader>
              <CardTitle>缓存与索引</CardTitle>
              <CardDescription>统一管理本地索引与人物统计</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2 text-sm text-[hsl(var(--color-muted-foreground))]">
                <p>
                  若搜索结果或人物统计与最新数据不符，可在此重新构建相关索引。
                </p>
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <Button
                  variant="outline"
                  onClick={handleRebuildIndex}
                >
                  <RefreshCw className="h-4 w-4 mr-2" /> 重新建立全文索引
                </Button>
                <Button
                  variant="outline"
                  onClick={handleRefreshCharacters}
                >
                  <RefreshCw className="h-4 w-4 mr-2" /> 刷新人物统计
                </Button>
              </div>
            </CardContent>
          </Card>

            <Card className="motion-safe:animate-in motion-safe:fade-in-0 motion-safe:duration-500" style={{ animationDelay: "120ms" }}>
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
