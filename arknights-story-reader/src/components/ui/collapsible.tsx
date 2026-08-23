import * as React from "react"
import { ChevronDown } from "lucide-react"
import { cn } from "@/lib/utils"

interface CollapsibleProps {
  title: string
  /** 非受控初始展开状态；传了 `open` 时忽略。 */
  defaultOpen?: boolean
  /** 受控展开状态。传入后组件不再自己维护 open。 */
  open?: boolean
  onOpenChange?: (open: boolean) => void
  /** 折叠时也能看到的条目数量，搜索状态下就是命中数。 */
  count?: number
  /** 数量后缀，默认「篇」。 */
  countUnit?: string
  children: React.ReactNode
  actions?: React.ReactNode
}

export function Collapsible({
  title,
  defaultOpen = false,
  open: openProp,
  onOpenChange,
  count,
  countUnit = "篇",
  children,
  actions,
}: CollapsibleProps) {
  const [uncontrolledOpen, setUncontrolledOpen] = React.useState(defaultOpen)
  const controlled = openProp !== undefined
  const open = controlled ? openProp : uncontrolledOpen

  const reactId = React.useId()
  const triggerId = `collapsible-trigger-${reactId}`
  const contentId = `collapsible-content-${reactId}`

  const toggle = React.useCallback(() => {
    const next = !open
    if (!controlled) setUncontrolledOpen(next)
    onOpenChange?.(next)
  }, [controlled, onOpenChange, open])

  const hasCount = typeof count === "number" && Number.isFinite(count)

  return (
    <div
      data-state={open ? "open" : "closed"}
      className="border border-[hsl(var(--color-border))] rounded-lg overflow-hidden motion-safe:animate-in motion-safe:fade-in-0 motion-safe:duration-500"
    >
      <div className="group flex items-center justify-between gap-2 bg-[hsl(var(--color-card))] transition-all duration-200 hover:bg-[hsl(var(--color-accent))] hover:-translate-y-0.5 px-4 py-2">
        <button
          id={triggerId}
          type="button"
          onClick={toggle}
          aria-expanded={open}
          aria-controls={open ? contentId : undefined}
          className="flex min-h-[44px] flex-1 items-center justify-between gap-2 bg-transparent p-0 text-left font-semibold text-[hsl(var(--color-foreground))] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-[hsl(var(--color-primary))]"
        >
          <span className="flex min-w-0 items-center gap-2">
            <span className="truncate">{title}</span>
            {hasCount && (
              <span className="flex-shrink-0 rounded-full bg-[hsl(var(--color-secondary))] px-2 py-0.5 text-[11px] font-normal tabular-nums text-[hsl(var(--color-muted-foreground))]">
                {count} {countUnit}
              </span>
            )}
          </span>
          <ChevronDown
            className={cn(
              "h-5 w-5 flex-shrink-0 transition-transform duration-200",
              open && "transform rotate-180"
            )}
          />
        </button>
        {actions ? <div className="ml-1 flex items-center gap-2">{actions}</div> : null}
      </div>
      {open && (
        <div
          id={contentId}
          role="region"
          aria-labelledby={triggerId}
          className="p-2 space-y-2 bg-[hsl(var(--color-card)/0.5)] motion-safe:animate-in motion-safe:fade-in-0 motion-safe:slide-in-from-top-2 motion-safe:duration-300"
        >
          {children}
        </div>
      )}
    </div>
  )
}
