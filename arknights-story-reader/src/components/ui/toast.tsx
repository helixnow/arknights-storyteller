import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { cn } from "@/lib/utils";
import { CheckCircle2, Info, X, XCircle, AlertTriangle } from "lucide-react";

export type ToastKind = "default" | "success" | "warning" | "error";

interface ToastPayload {
  id: number;
  message: string;
  kind: ToastKind;
  duration: number;
}

interface ToastContextValue {
  show: (message: string, options?: { kind?: ToastKind; duration?: number }) => void;
  success: (message: string, duration?: number) => void;
  warn: (message: string, duration?: number) => void;
  error: (message: string, duration?: number) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

/** 同屏最多堆叠的条数，再多就挤掉最旧的一条。 */
const MAX_VISIBLE = 3;

/* 失败信息通常更长、也更需要用户读完再决定下一步，所以给它明显更长的停留
   时间；成功/普通提示只是确认动作，快速消失反而不打扰。 */
const DEFAULT_DURATION: Record<ToastKind, number> = {
  default: 2200,
  success: 2200,
  warning: 4000,
  error: 6000,
};

const ICONS: Record<ToastKind, typeof CheckCircle2> = {
  default: Info,
  success: CheckCircle2,
  warning: AlertTriangle,
  error: XCircle,
};

/* 正文一律用卡片前景色：语义色只出现在图标和描边上。
   早先的写法是「语义色 12% 底 + 语义前景色文字」，浅色主题下
   success/warning 的前景色是白字，落在近乎白色的底上几乎看不见；
   深色主题下 destructive 是暗红，暗红字压在暗底上同样不可读。 */
const KIND_CLASSES: Record<ToastKind, string> = {
  default: "border-[hsl(var(--color-border))]",
  success: "border-[hsl(var(--color-status-success)/0.5)]",
  warning: "border-[hsl(var(--color-status-warning)/0.5)]",
  error: "border-[hsl(var(--color-status-error)/0.55)]",
};

const ICON_CLASSES: Record<ToastKind, string> = {
  default: "text-[hsl(var(--color-muted-foreground))]",
  success: "text-[hsl(var(--color-status-success))]",
  warning: "text-[hsl(var(--color-status-warning))]",
  error: "text-[hsl(var(--color-status-error))]",
};

/* 阅读器里没有底部导航岛，按 5rem 抬起来会让提示悬在半空。改成实测：
   底栏存在就贴着它上沿放，不存在就退回一个只避开 home indicator 的
   安全间距。 */
const FALLBACK_BOTTOM = "calc(env(safe-area-inset-bottom, 0px) + 1.25rem)";
const NAV_GAP_PX = 12;

function measureBottomInset(): string {
  if (typeof document === "undefined") return FALLBACK_BOTTOM;
  const nav = document.querySelector<HTMLElement>(".bottom-nav-glass");
  if (!nav) return FALLBACK_BOTTOM;
  const rect = nav.getBoundingClientRect();
  const inset = Math.round(window.innerHeight - rect.top) + NAV_GAP_PX;
  return inset > 0 ? `${inset}px` : FALLBACK_BOTTOM;
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastPayload[]>([]);
  const [bottomInset, setBottomInset] = useState(FALLBACK_BOTTOM);
  const nextId = useRef(1);

  const remove = useCallback((id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const show = useCallback(
    (message: string, options?: { kind?: ToastKind; duration?: number }) => {
      const kind = options?.kind ?? "default";
      const payload: ToastPayload = {
        id: nextId.current++,
        message,
        kind,
        duration: options?.duration ?? DEFAULT_DURATION[kind],
      };
      setToasts((prev) => [...prev, payload].slice(-MAX_VISIBLE));
    },
    []
  );

  // 只在有提示时才测量/监听窗口变化，平时不挂任何监听器。
  const hasToasts = toasts.length > 0;
  useLayoutEffect(() => {
    if (!hasToasts) return;
    const sync = () => setBottomInset(measureBottomInset());
    sync();
    window.addEventListener("resize", sync);
    window.addEventListener("orientationchange", sync);
    return () => {
      window.removeEventListener("resize", sync);
      window.removeEventListener("orientationchange", sync);
    };
  }, [hasToasts]);

  const value = useMemo<ToastContextValue>(
    () => ({
      show,
      success: (msg, duration) => show(msg, { kind: "success", duration }),
      warn: (msg, duration) => show(msg, { kind: "warning", duration }),
      error: (msg, duration) => show(msg, { kind: "error", duration }),
    }),
    [show]
  );

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div
        className="pointer-events-none fixed inset-x-0 z-[100] flex flex-col items-center gap-2 px-4"
        style={{ bottom: bottomInset }}
      >
        {toasts.map((t) => (
          <ToastItem key={t.id} toast={t} onDismiss={remove} />
        ))}
      </div>
    </ToastContext.Provider>
  );
}

function ToastItem({
  toast,
  onDismiss,
}: {
  toast: ToastPayload;
  onDismiss: (id: number) => void;
}) {
  const [paused, setPaused] = useState(false);
  const remainingRef = useRef(toast.duration);

  const dismiss = useCallback(() => onDismiss(toast.id), [onDismiss, toast.id]);

  // 指针悬停 / 键盘聚焦时暂停倒计时（WCAG 2.2.1），移开后接着剩余时间走完，
  // 这样长文案的错误提示不会在用户读到一半时消失。
  useEffect(() => {
    if (paused) return;
    const startedAt = Date.now();
    const timer = window.setTimeout(dismiss, Math.max(remainingRef.current, 0));
    return () => {
      window.clearTimeout(timer);
      remainingRef.current -= Date.now() - startedAt;
    };
  }, [paused, dismiss]);

  const Icon = ICONS[toast.kind];
  const urgent = toast.kind === "error" || toast.kind === "warning";

  return (
    <div
      role={urgent ? "alert" : "status"}
      aria-live={urgent ? "assertive" : "polite"}
      aria-atomic="true"
      className={cn(
        "pointer-events-auto w-full max-w-sm rounded-xl border px-4 py-3 text-sm shadow-lg backdrop-blur",
        "bg-[hsl(var(--color-card)/0.92)] text-[hsl(var(--color-card-foreground))]",
        "motion-safe:animate-in motion-safe:fade-in-0 motion-safe:slide-in-from-bottom-4 motion-safe:duration-200",
        KIND_CLASSES[toast.kind]
      )}
      onPointerEnter={() => setPaused(true)}
      onPointerLeave={() => setPaused(false)}
      onFocusCapture={() => setPaused(true)}
      onBlurCapture={() => setPaused(false)}
      onClick={dismiss}
    >
      <div className="flex items-start gap-3">
        <Icon
          className={cn("h-4 w-4 mt-0.5 flex-shrink-0", ICON_CLASSES[toast.kind])}
          aria-hidden="true"
        />
        <div className="flex-1 break-words whitespace-pre-line">{toast.message}</div>
        <button
          type="button"
          onClick={dismiss}
          aria-label="关闭提示"
          className={cn(
            "-mr-1 -mt-1 flex-shrink-0 rounded-full p-1 text-[hsl(var(--color-muted-foreground))]",
            "transition-colors hover:bg-[hsl(var(--color-foreground)/0.08)] hover:text-[hsl(var(--color-foreground))]",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[hsl(var(--color-ring))]"
          )}
        >
          <X className="h-3.5 w-3.5" aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}

export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext);
  if (!ctx) {
    // Graceful fallback so callers don't blow up if the provider is missing.
    return {
      show: (msg) => console.log("[toast]", msg),
      success: (msg) => console.log("[toast/success]", msg),
      warn: (msg) => console.warn("[toast/warn]", msg),
      error: (msg) => console.error("[toast/error]", msg),
    };
  }
  return ctx;
}
