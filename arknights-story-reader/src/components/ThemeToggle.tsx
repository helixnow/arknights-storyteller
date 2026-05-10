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

  const label =
    theme === "light" ? "切换到深色模式" : theme === "dark" ? "切换到跟随系统" : "切换到浅色模式";

  return (
    <Button
      variant="ghost"
      size="icon"
      onClick={handleToggle}
      aria-label={label}
      title={label}
      className="relative"
    >
      {theme === "light" && <Sun className="h-[1.2rem] w-[1.2rem]" />}
      {theme === "dark" && <Moon className="h-[1.2rem] w-[1.2rem]" />}
      {theme === "system" && <MonitorSmartphone className="h-[1.2rem] w-[1.2rem]" />}
      <span className="sr-only">切换主题</span>
    </Button>
  );
}
