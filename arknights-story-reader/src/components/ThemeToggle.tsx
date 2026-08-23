import { Moon, Sun, MonitorSmartphone } from "lucide-react";
import { useTheme } from "@/components/theme-provider";
import { Button } from "@/components/ui/button";

/**
 * Cycles between light → dark → system → light. The system mode respects the
 * OS-level appearance preference and updates live as it changes (handled by
 * ThemeProvider). The previous version hard-flipped between light/dark only,
 * which conflicted with the `defaultTheme="system"` setting in App.tsx.
 */
export function ThemeToggle() {
  const { theme, setTheme } = useTheme();

  const handleToggle = () => {
    const next = theme === "light" ? "dark" : theme === "dark" ? "system" : "light";
    setTheme(next);
  };

  const current =
    theme === "light" ? "浅色模式" : theme === "dark" ? "深色模式" : "跟随系统";
  const label =
    theme === "light" ? "切换到深色模式" : theme === "dark" ? "切换到跟随系统" : "切换到浅色模式";

  return (
    <>
      <Button
        variant="ghost"
        size="icon"
        onClick={handleToggle}
        aria-label={label}
        title={label}
      >
        {theme === "light" && <Sun className="h-[1.2rem] w-[1.2rem]" aria-hidden="true" />}
        {theme === "dark" && <Moon className="h-[1.2rem] w-[1.2rem]" aria-hidden="true" />}
        {theme === "system" && (
          <MonitorSmartphone className="h-[1.2rem] w-[1.2rem]" aria-hidden="true" />
        )}
      </Button>
      {/* 按钮本身的 aria-label 描述的是「下一步动作」，再补一个 live region
          播报切换后的当前状态，读屏用户才知道点完落在了哪一档。
          放在按钮外面：ARIA 里 button 的子节点是 presentational，塞在里面的
          live region 部分读屏会直接忽略。sr-only 是绝对定位，不影响布局。
          aria-atomic 让读屏播报整句「当前主题：X」，否则只会念变化的
          那个文本节点（"深色模式"），缺了上下文。 */}
      <span className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        当前主题：{current}
      </span>
    </>
  );
}
