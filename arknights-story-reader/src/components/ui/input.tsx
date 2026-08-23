import * as React from "react"
import { cn } from "@/lib/utils"

export interface InputProps
  extends React.InputHTMLAttributes<HTMLInputElement> {}

const Input = React.forwardRef<HTMLInputElement, InputProps>(
  ({ className, type, ...props }, ref) => {
    return (
      <input
        type={type}
        className={cn(
          "flex h-10 w-full rounded-md border border-[hsl(var(--color-input))] bg-[hsl(var(--color-background))] px-3 py-2",
          // iOS Safari 会给文本框加一层自带的内阴影/圆角，叠在我们的边框上
          // 看着像双层描边；search 类型还会强行塞一个原生取消按钮。
          "appearance-none",
          // 移动端字号必须 ≥16px：小于 16 时 iOS Safari/WKWebView 会在聚焦
          // 输入框时自动放大整页，退出后还回不到原缩放，体验非常跳。
          // 桌面端（md+）仍用 14px 保持原有密度。
          "text-base md:text-sm",
          // 同理，触摸端把点击区域抬到 44px 的推荐值，桌面端保持 40px。
          "min-h-[2.75rem] md:min-h-[2.5rem]",
          "file:border-0 file:bg-transparent file:text-sm file:font-medium",
          "placeholder:text-[hsl(var(--color-muted-foreground))]",
          "transition-[box-shadow,border-color] duration-150",
          // 焦点环与全局基线（index.css 的 :focus-visible）保持同宽同色：
          // 这里显式关掉 outline 换成 ring，是为了让环贴着圆角边框而不是
          // 在外面再套一圈。
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[hsl(var(--color-ring))]",
          "disabled:cursor-not-allowed disabled:opacity-50",
          className
        )}
        ref={ref}
        {...props}
      />
    )
  }
)
Input.displayName = "Input"

export { Input }

