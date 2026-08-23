import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "@/lib/utils"

const buttonVariants = cva(
  [
    "inline-flex items-center justify-center whitespace-nowrap rounded-md text-sm font-medium select-none",
    // Tailwind v4 的 preflight 让 <button> 回到 cursor: default，桌面端要手动要回指针。
    "cursor-pointer disabled:cursor-not-allowed touch-manipulation",
    "transition-[transform,background-color,color,opacity,box-shadow] duration-200",
    // 焦点环：2px 环 + 与页面同色的 2px 偏移，深浅色主题都能看清。
    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[hsl(var(--color-ring))] focus-visible:ring-offset-2 focus-visible:ring-offset-[hsl(var(--color-background))]",
    "disabled:pointer-events-none disabled:opacity-50",
    // 图标不吃点击事件，也不会在窄按钮里被压扁。
    "[&_svg]:pointer-events-none [&_svg]:shrink-0",
    // 全局 reduced-motion 只把动画时长压到 0，按下缩放会变成生硬的跳变。
    "active:scale-[0.97] motion-reduce:transition-none motion-reduce:active:scale-100",
    // 触屏（coarse pointer）上用 ::after 把命中区域垫到 ≥44×44
    //（iOS HIG / WCAG 2.5.8），sm、icon-pill 等小尺寸的视觉不变。
    // 鼠标场景不扩，避免紧凑工具栏里相邻按钮的热区互相叠压。
    "relative pointer-coarse:after:absolute pointer-coarse:after:left-1/2 pointer-coarse:after:top-1/2 pointer-coarse:after:h-full pointer-coarse:after:min-h-11 pointer-coarse:after:w-full pointer-coarse:after:min-w-11 pointer-coarse:after:-translate-x-1/2 pointer-coarse:after:-translate-y-1/2",
  ],
  {
    variants: {
      variant: {
        default: "bg-[hsl(var(--color-primary))] text-[hsl(var(--color-primary-foreground))] hover:opacity-90",
        destructive:
          "bg-[hsl(var(--color-destructive))] text-[hsl(var(--color-destructive-foreground))] hover:opacity-90",
        outline:
          "border border-[hsl(var(--color-input))] bg-[hsl(var(--color-background))] hover:bg-[hsl(var(--color-accent))] hover:text-[hsl(var(--color-accent-foreground))]",
        secondary:
          "bg-[hsl(var(--color-secondary))] text-[hsl(var(--color-secondary-foreground))] hover:opacity-80",
        ghost: "hover:bg-[hsl(var(--color-accent))] hover:text-[hsl(var(--color-accent-foreground))]",
        link: "text-[hsl(var(--color-primary))] underline-offset-4 hover:underline",
        // Liquid Glass variant — a translucent pill that sits on top of a
        // glass sheet / toolbar. Use `glass` for the secondary action in a
        // sheet footer so it doesn't compete with the primary fill.
        glass:
          "glass glass-thin text-[hsl(var(--color-foreground))] hover:bg-[hsl(var(--color-foreground)/0.06)]",
      },
      size: {
        default: "h-10 px-4 py-2",
        sm: "h-9 rounded-md px-3",
        lg: "h-11 rounded-md px-8",
        // Pill / capsule sizing for primary actions in iOS-26 style sheets.
        // Taller target + full radius so it reads like a floating chip.
        pill: "h-12 px-5 rounded-full text-[15px]",
        icon: "h-11 w-11",
        // A 9×9 squircle for header-only icons (close, reset) that want
        // to look like an iOS tappable circle rather than a shadcn square.
        "icon-pill": "h-9 w-9 rounded-full",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  /**
   * 兼容 shadcn 的调用签名。本项目没有引入 Radix Slot，这里只是把它吃掉，
   * 免得它作为未知属性被透传到 DOM 上引发 React 警告。
   */
  asChild?: boolean
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, type, asChild: _asChild, ...props }, ref) => {
    return (
      <button
        // 不写 type 的按钮在 <form> 里默认是 submit，会意外提交表单。
        type={type ?? "button"}
        className={cn(buttonVariants({ variant, size, className }))}
        ref={ref}
        {...props}
      />
    )
  }
)
Button.displayName = "Button"

export { Button, buttonVariants }

