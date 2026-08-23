import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react"

type Theme = "dark" | "light" | "system"
type ThemeColor = "default" | "book" | "emerald" | "noctilucent"

const THEMES: Theme[] = ["dark", "light", "system"]
const THEME_COLORS: ThemeColor[] = ["default", "book", "emerald", "noctilucent"]

type ThemeProviderProps = {
  children: React.ReactNode
  defaultTheme?: Theme
  storageKey?: string
}

type ThemeProviderState = {
  theme: Theme
  setTheme: (theme: Theme) => void
  themeColor: ThemeColor
  setThemeColor: (color: ThemeColor) => void
}

const initialState: ThemeProviderState = {
  theme: "system",
  themeColor: "default",
  setTheme: () => null,
  setThemeColor: () => null,
}

const ThemeProviderContext = createContext<ThemeProviderState>(initialState)

/* localStorage 在隐私模式 / 受限 WebView 里可能直接抛异常，读写都要兜底，
   否则整个 App 会在首帧就崩掉。 */
function readStorage(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

function writeStorage(key: string, value: string) {
  try {
    localStorage.setItem(key, value)
  } catch {
    /* 存不下就只在本次会话生效 */
  }
}

/**
 * 把当前主题同步给浏览器/系统 UI：
 *   - `color-scheme` 决定原生滚动条、表单控件、输入法候选框的明暗，
 *     不设的话深色下会弹出刺眼的白色原生控件。
 *   - `theme-color` 决定移动端浏览器地址栏 / 状态栏底色，直接读实际生效的
 *     `--color-background`，这样四套配色都不用在这里再抄一遍色值。
 */
function syncBrowserChrome(root: HTMLElement, resolved: "light" | "dark") {
  root.style.colorScheme = resolved

  const background = getComputedStyle(root)
    .getPropertyValue("--color-background")
    .trim()
  if (!background) return

  const color = `hsl(${background})`
  root.style.backgroundColor = color
  const meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')
  if (meta) meta.content = color
}

function applyResolvedTheme(root: HTMLElement, resolved: "light" | "dark") {
  root.classList.remove("light", "dark")
  root.classList.add(resolved)
  syncBrowserChrome(root, resolved)
}

function resolvedThemeOf(root: HTMLElement): "light" | "dark" {
  return root.classList.contains("dark") ? "dark" : "light"
}

export function ThemeProvider({
  children,
  defaultTheme = "system",
  storageKey = "vite-ui-theme",
  ...props
}: ThemeProviderProps) {
  const [theme, setThemeState] = useState<Theme>(() => {
    const stored = readStorage(storageKey) as Theme | null
    return stored && THEMES.includes(stored) ? stored : defaultTheme
  })
  const [themeColor, setThemeColorState] = useState<ThemeColor>(() => {
    const stored = readStorage(`${storageKey}-color`) as ThemeColor | null
    return stored && THEME_COLORS.includes(stored) ? stored : "default"
  })

  useEffect(() => {
    const root = window.document.documentElement

    if (theme !== "system") {
      applyResolvedTheme(root, theme)
      return
    }

    const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)")
    applyResolvedTheme(root, mediaQuery.matches ? "dark" : "light")

    const handleChange = (event: MediaQueryListEvent) => {
      applyResolvedTheme(root, event.matches ? "dark" : "light")
    }
    mediaQuery.addEventListener("change", handleChange)
    return () => mediaQuery.removeEventListener("change", handleChange)
  }, [theme])

  useEffect(() => {
    const root = window.document.documentElement
    root.dataset.themeColor = themeColor
    writeStorage(`${storageKey}-color`, themeColor)
    syncBrowserChrome(root, resolvedThemeOf(root))
  }, [storageKey, themeColor])

  const setTheme = useCallback(
    (next: Theme) => {
      writeStorage(storageKey, next)
      setThemeState(next)
    },
    [storageKey]
  )

  const setThemeColor = useCallback((color: ThemeColor) => {
    setThemeColorState(color)
  }, [])

  const value = useMemo<ThemeProviderState>(
    () => ({ theme, setTheme, themeColor, setThemeColor }),
    [theme, setTheme, themeColor, setThemeColor]
  )

  return (
    <ThemeProviderContext.Provider {...props} value={value}>
      {children}
    </ThemeProviderContext.Provider>
  )
}

export const useTheme = () => {
  const context = useContext(ThemeProviderContext)

  if (context === undefined)
    throw new Error("useTheme must be used within a ThemeProvider")

  return context
}
