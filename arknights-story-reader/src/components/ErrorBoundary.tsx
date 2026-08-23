import { Component, Fragment, type ErrorInfo, type ReactNode } from "react";
import { Check, Copy, Home, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";

interface ErrorBoundaryProps {
  children: ReactNode;
}

interface ErrorBoundaryState {
  error: Error | null;
  /** componentDidCatch 拿到的组件栈，供「复制错误详情」一起带走，方便反馈时定位。 */
  componentStack: string | null;
  /** 复制成功后的短暂反馈（按钮文案切成「已复制」，2 秒后还原）。 */
  copied: boolean;
  /** 软恢复计数：作为子树的 key，+1 会把整棵子树重新挂载，回到初始状态（首页）。 */
  resetCount: number;
}

/** execCommand 兜底：部分 WebView（非安全上下文/无权限）拿不到 navigator.clipboard。 */
function copyViaTextarea(text: string): boolean {
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  textarea.select();
  let ok = false;
  try {
    ok = document.execCommand("copy");
  } catch {
    ok = false;
  }
  textarea.remove();
  return ok;
}

/**
 * 顶层错误边界：接住渲染期的未捕获异常，避免整个应用白屏。
 *
 * 放在 main.tsx 的最外层而不是 App 内部：主题类（light/dark 与配色）由
 * ThemeProvider 以副作用挂在 documentElement 上，React 子树崩掉后依然生效，
 * 所以兜底页照常能拿到主题色；放最外层还能连 provider 自身的崩溃一起接住。
 *
 * 注意：错误边界只覆盖渲染/生命周期里的异常，事件回调与异步错误仍由
 * main.tsx 里的 window `error` / `unhandledrejection` 监听器负责记录。
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null, componentStack: null, copied: false, resetCount: 0 };

  private copyResetTimer: number | undefined;

  static getDerivedStateFromError(error: unknown): Partial<ErrorBoundaryState> {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("[ErrorBoundary] 渲染崩溃:", error, info.componentStack);
    this.setState({ componentStack: info.componentStack ?? null });
  }

  componentWillUnmount() {
    window.clearTimeout(this.copyResetTimer);
  }

  handleReload = () => {
    window.location.reload();
  };

  /** 软恢复：丢掉出错的子树重新挂载。App 的初始 tab 就是首页，等价于「回首页」。 */
  handleGoHome = () => {
    this.setState((prev) => ({
      error: null,
      componentStack: null,
      copied: false,
      resetCount: prev.resetCount + 1,
    }));
  };

  /** 拼出可供反馈粘贴的纯文本：错误消息 + 组件栈。 */
  buildErrorDetails(): string {
    const { error, componentStack } = this.state;
    if (!error) return "";
    const message = `${error.name}: ${error.message || "未知错误"}`;
    return componentStack ? `${message}\n\n组件栈:${componentStack}` : message;
  }

  handleCopyDetails = async () => {
    const text = this.buildErrorDetails();
    if (!text) return;
    let copied = false;
    try {
      await navigator.clipboard.writeText(text);
      copied = true;
    } catch {
      copied = copyViaTextarea(text);
    }
    if (!copied) return;
    this.setState({ copied: true });
    window.clearTimeout(this.copyResetTimer);
    this.copyResetTimer = window.setTimeout(() => this.setState({ copied: false }), 2000);
  };

  render() {
    const { error, copied, resetCount } = this.state;

    if (error) {
      return (
        <div
          role="alert"
          className="h-full flex flex-col items-center justify-center gap-3 px-6 text-center pt-[max(env(safe-area-inset-top,0px),12px)] bg-[hsl(var(--color-background))] text-[hsl(var(--color-foreground))]"
        >
          <div className="text-base font-medium text-[hsl(var(--color-destructive))]">
            页面出错了
          </div>
          <p className="max-w-[28rem] text-sm text-[hsl(var(--color-muted-foreground))] break-words">
            {error.message || "发生了未知错误"}
          </p>
          <p className="max-w-[28rem] text-xs text-[hsl(var(--color-muted-foreground))]">
            可以先回首页继续使用；如果仍然报错，请重载应用。
          </p>
          <div className="mt-2 flex flex-wrap items-center justify-center gap-2">
            <Button onClick={this.handleReload} className="min-h-[44px]">
              <RefreshCw className="mr-2 h-4 w-4" />
              重载
            </Button>
            <Button onClick={this.handleGoHome} variant="outline" className="min-h-[44px]">
              <Home className="mr-2 h-4 w-4" />
              回首页
            </Button>
          </div>
          <details className="group mt-1 w-full max-w-[28rem] rounded-lg border border-[hsl(var(--color-border))] bg-[hsl(var(--color-muted)/0.1)] text-left">
            <summary className="flex min-h-[44px] cursor-pointer list-none items-center justify-between px-4 py-3 text-sm text-[hsl(var(--color-foreground))]">
              <span>复制错误详情</span>
              <span className="text-xs text-[hsl(var(--color-muted-foreground))] transition-transform group-open:rotate-180">
                ▾
              </span>
            </summary>
            <div className="space-y-2 border-t border-[hsl(var(--color-border))] px-4 py-3">
              <pre className="max-h-40 select-text overflow-auto whitespace-pre-wrap break-words font-mono text-xs leading-relaxed text-[hsl(var(--color-muted-foreground))]">
                {this.buildErrorDetails()}
              </pre>
              <Button
                onClick={this.handleCopyDetails}
                variant="outline"
                size="sm"
                className="w-full"
                aria-live="polite"
              >
                {copied ? <Check className="mr-2 h-4 w-4" /> : <Copy className="mr-2 h-4 w-4" />}
                {copied ? "已复制" : "复制"}
              </Button>
            </div>
          </details>
        </div>
      );
    }

    return <Fragment key={resetCount}>{this.props.children}</Fragment>;
  }
}
