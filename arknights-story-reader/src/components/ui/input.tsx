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
          // 不按 pointer:fine 降回 14px：接着妙控键盘/鼠标的 iPad 会报告
          // fine pointer，但用户仍能用手指点输入框，Safari 仍会触发整页缩放。
          "text-base",
          // 混合输入设备同样保留 44px，避免 pointer:fine 把 iPad 热区压回 40px。
          "min-h-[2.75rem]",
          // 去掉旧 WebView 等待双击缩放判定产生的约 300ms 点击延迟。
          "touch-manipulation",
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

