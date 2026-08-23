import { useEffect, useState } from "react";

interface UseSidePanelOptions {
  /** Controlled open flag from the parent. */
  open: boolean;
  /**
   * 兼容占位，本 hook 不再消费。关闭手段（Esc、scrim 点击、焦点看守）
   * 全部由 `SheetShell` 统一负责：它的 Esc 监听在捕获阶段处理并
   * `preventDefault`，且在面板被 KeepAlive 置为 inert 时按兵不动。这里
   * 若再挂一份 window 级监听，同一次按键会触发两次 onClose，甚至把
   * 后台 inert 面板悄悄关掉。字段保留是为了不动现有调用方的签名。
   */
  onClose?: () => void;
  /**
   * Duration (ms) of the closing animation. The panel stays mounted for this
   * long after `open` flips to false so the exit animation can play before we
   * unmount. 默认值与 `SheetShell` 的 `duration-300` 过渡对齐——提前卸载
   * 会把滑出动画和 scrim 淡出拦腰截断。
   */
  exitDurationMs?: number;
}

interface UseSidePanelResult {
  /** Whether the panel DOM should be rendered (true during open + exit). */
  rendered: boolean;
  /** Data-state string — drives enter/exit animation via Tailwind data variants. */
  state: "open" | "closed";
}

/**
 * 侧边抽屉的两阶段挂载状态机——这是它唯一的职责：
 *
 * - 打开：先挂载，下一帧再把 data-state 翻成 "open"，让 CSS 过渡生效
 * - 关闭：立刻翻成 "closed"，等退场动画播完再卸载
 *
 * 模态行为（Esc、焦点圈禁/归还、背景滚动锁、inert 感知）全部住在
 * `SheetShell` 里。三个调用方（阅读设置 / 剧情导览 / 分享图）在
 * `rendered` 为真时挂载的都是 SheetShell，这里再各留一份 Esc 监听和
 * body 滚动锁只会双开双关：两把锁先后往 body 写恢复值会互相覆盖
 * （sheet-shell 里那段微任务延迟解锁的注释记录过这笔账），window 级
 * Esc 还会绕过 inert 检查把后台面板关掉。
 *
 * Returns a `state` string ("open" / "closed") that consumers should spread
 * to `data-state` on their animated container so Tailwind's
 * `data-[state=closed]:*` variants can drive the exit animation.
 */
export function useSidePanel({
  open,
  exitDurationMs = 300,
}: UseSidePanelOptions): UseSidePanelResult {
  const [rendered, setRendered] = useState(open);
  const [state, setState] = useState<"open" | "closed">(open ? "open" : "closed");

  // Two-phase render: when opening, mount first, then flip data-state to
  // "open" on the next frame so the CSS transition is triggered. When closing,
  // flip to "closed" immediately and unmount after the exit animation.
  useEffect(() => {
    if (open) {
      setRendered(true);
      const id = requestAnimationFrame(() => setState("open"));
      return () => cancelAnimationFrame(id);
    }

    setState("closed");
    const id = window.setTimeout(() => setRendered(false), exitDurationMs);
    return () => window.clearTimeout(id);
  }, [open, exitDurationMs]);

  return { rendered, state };
}
