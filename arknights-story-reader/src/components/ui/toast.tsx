import {
  createContext,
  useCallback,
  useContext,
  useEffect,
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

/** 同屏最多堆叠的条数；溢出的紧急提示排队，绝不挤掉仍在计时的错误。 */
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

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastPayload[]>([]);
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
      setToasts((prev) => {
        if (prev.length < MAX_VISIBLE) return [...prev, payload];
        // 只从当前可见的三条里挤普通/成功提示。数组尾部可能已有排队中的
        // 错误；把搜索范围扩到整列会误删一条尚未展示、计时器都没启动的提示。
        const evict = prev
          .slice(0, MAX_VISIBLE)
          .findIndex((t) => t.kind !== "error" && t.kind !== "warning");
        if (evict !== -1) return [...prev.filter((_, i) => i !== evict), payload];
        // 三个可见位全是错误/警告时，新紧急提示留在队尾；前面的提示关闭或
        // 到期后它才挂载并开始自己的完整倒计时。普通/成功提示直接丢弃，
        // 避免一句迟到数秒的「已复制」在故障提示读完后反而冒出来误导用户。
        return kind === "error" || kind === "warning" ? [...prev, payload] : prev;
      });
    },
    []
  );

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
      {/* 抬升高度由 `.toast-viewport` 读 BottomNav 发布的 --bottom-nav-inset
          决定：底栏在就贴着它上沿，阅读器全屏时自动落回只避开 home indicator
          的安全间距，不需要在这里测量布局。 */}
      <div className="toast-viewport">
        {toasts.slice(0, MAX_VISIBLE).map((t) => (
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
  // 悬停与聚焦分开记账：鼠标划过再移开时，如果关闭键仍持有键盘焦点，
  // 倒计时必须继续暂停——否则 toast 会在键盘用户按下 Enter 前消失，
  // 焦点跌落到 body，用户彻底迷失位置。
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const paused = hovered || focused;
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
      onPointerEnter={() => setHovered(true)}
      onPointerLeave={() => setHovered(false)}
      onFocusCapture={() => setFocused(true)}
      onBlurCapture={() => setFocused(false)}
      onClick={(event) => {
        // 划选正文松手也会触发 click：用户是在复制长错误信息，不是点击
        // 关闭，别把他刚选中的文字连着 toast 一起收走。
        const selection = window.getSelection();
        if (
          selection &&
          !selection.isCollapsed &&
          selection.anchorNode &&
          event.currentTarget.contains(selection.anchorNode)
        ) {
          return;
        }
        dismiss();
      }}
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
