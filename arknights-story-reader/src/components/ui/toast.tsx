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
import { CheckCircle2, Info, XCircle, AlertTriangle } from "lucide-react";

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

const ICONS: Record<ToastKind, typeof CheckCircle2> = {
  default: Info,
  success: CheckCircle2,
  warning: AlertTriangle,
  error: XCircle,
};

const KIND_CLASSES: Record<ToastKind, string> = {
  default: "border-[hsl(var(--color-border))] bg-[hsl(var(--color-card))]",
  success:
    "border-[hsl(var(--color-success)/0.4)] bg-[hsl(var(--color-success)/0.12)] text-[hsl(var(--color-success-foreground))]",
  warning:
    "border-[hsl(var(--color-warning)/0.4)] bg-[hsl(var(--color-warning)/0.12)] text-[hsl(var(--color-warning-foreground))]",
  error:
    "border-[hsl(var(--color-destructive)/0.45)] bg-[hsl(var(--color-destructive)/0.12)] text-[hsl(var(--color-destructive))]",
};

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastPayload[]>([]);
  const nextId = useRef(1);

  const remove = useCallback((id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const show = useCallback(
    (message: string, options?: { kind?: ToastKind; duration?: number }) => {
      const id = nextId.current++;
      const payload: ToastPayload = {
        id,
        message,
        kind: options?.kind ?? "default",
        duration: options?.duration ?? 2000,
      };
      setToasts((prev) => [...prev, payload]);
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
      <div
        aria-live="polite"
        aria-atomic="true"
        className="pointer-events-none fixed inset-x-0 z-[100] flex flex-col items-center gap-2 px-4"
        style={{
          bottom: "calc(5rem + env(safe-area-inset-bottom, 0px))",
        }}
      >
        {toasts.map((t) => (
          <ToastItem key={t.id} toast={t} onDismiss={() => remove(t.id)} />
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
  onDismiss: () => void;
}) {
  useEffect(() => {
    const timer = window.setTimeout(onDismiss, toast.duration);
    return () => window.clearTimeout(timer);
  }, [toast.duration, onDismiss]);

  const Icon = ICONS[toast.kind];

  return (
    <div
      role="status"
      className={cn(
        "pointer-events-auto w-full max-w-sm rounded-xl border px-4 py-3 text-sm shadow-lg backdrop-blur",
        "motion-safe:animate-in motion-safe:fade-in-0 motion-safe:slide-in-from-bottom-4 motion-safe:duration-200",
        KIND_CLASSES[toast.kind]
      )}
      onClick={onDismiss}
    >
      <div className="flex items-start gap-3">
        <Icon className="h-4 w-4 mt-0.5 flex-shrink-0" />
        <div className="flex-1 break-words whitespace-pre-line">{toast.message}</div>
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
