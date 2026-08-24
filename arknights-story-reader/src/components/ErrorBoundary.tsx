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
  if (!document.body) return false;
  const previousFocus = document.activeElement instanceof HTMLElement
    ? document.activeElement
    : null;
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  textarea.setAttribute("aria-hidden", "true");
  textarea.style.position = "fixed";
  textarea.style.left = "-9999px";
  textarea.style.top = "0";
  // iOS 会对聚焦的 <16px 表单控件缩放视口；复制兜底不该让崩溃页再跳一下。
  textarea.style.fontSize = "16px";
  textarea.style.opacity = "0";
  let ok = false;
  try {
    document.body.appendChild(textarea);
    textarea.focus({ preventScroll: true });
    textarea.select();
    // iOS WebView 里 select() 常常不产生实际选区，execCommand("copy") 会静默
    // 失败（按钮点了没反应）。显式设置选区是这条兜底路径在 iOS 上能用的前提。
    textarea.setSelectionRange(0, textarea.value.length);
    ok = document.execCommand("copy");
  } catch {
    ok = false;
  } finally {
    textarea.remove();
    if (previousFocus && document.contains(previousFocus)) {
      try {
        previousFocus.focus({ preventScroll: true });
      } catch {
        previousFocus.focus();
      }
    }
  }
  return ok;
}

/**
 * 「主题类由 ThemeProvider 挂在根元素上、崩溃后依然生效」只对成功渲染过至少
 * 一帧的情况成立。如果应用在首帧渲染就崩溃，被丢弃的子树里的 ThemeProvider
 * 根本没执行过副作用，根元素上没有 light/dark 类——深色环境的用户会看到
 * 刺眼的纯白兜底页。这里按「用户显式选择 > 系统偏好」补一个解析结果；
 * 类名已存在（正常崩溃路径）时什么也不做。storage key 与 App.tsx 传给
 * ThemeProvider 的一致，读不到（受限 WebView / key 变更）就落回系统偏好。
 */
function ensureThemeClass() {
  const root = document.documentElement;
  if (root.classList.contains("light") || root.classList.contains("dark")) return;
  let stored: string | null = null;
  try {
    stored = localStorage.getItem("story-teller-theme");
  } catch {
    stored = null;
  }
  let systemDark = false;
  try {
    systemDark = window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false;
  } catch {
    systemDark = false;
  }
  const dark = stored === "dark" || (stored !== "light" && systemDark);
  root.classList.add(dark ? "dark" : "light");
  // 原生控件（错误详情 pre 的滚动条等）的明暗也要跟上，否则深色页里是白色滚动条。
  root.style.colorScheme = dark ? "dark" : "light";
}

/**
 * 顶层错误边界：接住渲染期的未捕获异常，避免整个应用白屏。
 *
 * 放在 main.tsx 的最外层而不是 App 内部：主题类（light/dark 与配色）由
 * ThemeProvider 以副作用挂在 documentElement 上，React 子树崩掉后依然生效，
 * 所以兜底页照常能拿到主题色；放最外层还能连 provider 自身的崩溃一起接住。
 * （首帧渲染就崩、主题类根本没挂上的例外由 ensureThemeClass 兜底。）
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
    // componentDidCatch 在提交阶段、浏览器绘制之前运行，此时补主题类
    // 兜底页第一帧就是正确的明暗，不会闪白。
    ensureThemeClass();
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
      if (!navigator.clipboard?.writeText) throw new Error("Clipboard API unavailable");
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
          /*
           * 崩溃页必须自己能滚：html/body 是 overflow:hidden 的，而错误消息
           * 长度不可控，加上展开的「错误详情」，横屏矮视口里内容很容易超出
           * 一屏。此前根节点直接 justify-center 且无滚动容器——flex 居中的
           * 溢出会向上下两端裁切，「重载 / 回首页 / 复制」都可能被裁到视口外
           * 且无法够到。改成外层滚动、内层 min-h-full 居中：装得下时照旧
           * 居中，装不下时内层随内容撑高、整页可滚。
           */
          className="h-full overflow-y-auto overscroll-y-contain bg-[hsl(var(--color-background))] text-[hsl(var(--color-foreground))]"
        >
          <div className="min-h-full flex flex-col items-center justify-center gap-3 px-6 text-center pt-[max(env(safe-area-inset-top,0px),12px)] pb-[max(env(safe-area-inset-bottom,0px),12px)]">
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
        </div>
      );
    }

    return <Fragment key={resetCount}>{this.props.children}</Fragment>;
  }
}
