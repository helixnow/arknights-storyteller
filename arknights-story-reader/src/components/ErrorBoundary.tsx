import { Component, Fragment, type ErrorInfo, type ReactNode } from "react";
import { Home, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";

interface ErrorBoundaryProps {
  children: ReactNode;
}

interface ErrorBoundaryState {
  error: Error | null;
  /** 软恢复计数：作为子树的 key，+1 会把整棵子树重新挂载，回到初始状态（首页）。 */
  resetCount: number;
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
  state: ErrorBoundaryState = { error: null, resetCount: 0 };

  static getDerivedStateFromError(error: unknown): Partial<ErrorBoundaryState> {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("[ErrorBoundary] 渲染崩溃:", error, info.componentStack);
  }

  handleReload = () => {
    window.location.reload();
  };

  /** 软恢复：丢掉出错的子树重新挂载。App 的初始 tab 就是首页，等价于「回首页」。 */
  handleGoHome = () => {
    this.setState((prev) => ({ error: null, resetCount: prev.resetCount + 1 }));
  };

  render() {
    const { error, resetCount } = this.state;

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
        </div>
      );
    }

    return <Fragment key={resetCount}>{this.props.children}</Fragment>;
  }
}
