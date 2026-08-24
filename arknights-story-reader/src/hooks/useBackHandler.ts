import { useEffect, useRef } from "react";
import {
  createBackDispatcher,
  INITIAL_HISTORY_GUARD_STATE,
  reduceHistoryGuard,
  type BackDispatchEntry,
  type HistoryGuardEvent,
  type HistoryGuardState,
} from "@/lib/appShellLogic";

/**
 * Register a handler for Android hardware back button and browser popstate.
 *
 * The handler should return `true` when the back event has been consumed
 * (i.e. some in-app UI was dismissed) and the default exit behavior should be
 * suppressed. Returning `false` lets the system perform its default action
 * (on Android: exit the app; in a browser: navigate history).
 *
 * Handlers are asked in **priority order** (see `BACK_PRIORITY`), and within
 * the same priority the most recently registered one goes first (LIFO).
 * Priority matters because registration order does not match nesting order:
 * React runs child effects before parent effects, so when a view and the
 * overlay inside it become active in the same commit (e.g. the reader is
 * re-shown with a drawer still open), the inner overlay registers *first*.
 * A pure LIFO stack would then close the outer view and leave the drawer
 * hanging.
 */
export type BackHandler = () => boolean;

/**
 * 返回键优先级。数字越大越先被询问；同级按注册顺序倒序（后注册的先问）。
 *
 * 语义上就是导航层级：覆盖层 > 全屏次级视图 > tab 兜底。默认值是
 * `overlay`，因为绝大多数调用点都是抽屉 / 菜单 / 选择模式这类临时浮层。
 */
export const BACK_PRIORITY = {
  /** 盖在当前视图之上的抽屉、弹窗、菜单、选择模式。 */
  overlay: 30,
  /** 占满整屏的次级视图，例如阅读器。 */
  view: 20,
  /** tab 级兜底，例如「回到首页」。 */
  tab: 10,
} as const;

interface BackEntry extends BackDispatchEntry {}

const entries: BackEntry[] = [];
let seqCounter = 0;

function hasAvailableHandlers(): boolean {
  return entries.some((entry) => !entry.consumed);
}

/**
 * 当前注册的 overlay 级处理器数量（只读探针）。
 *
 * 边缘返回手势在 pointerdown **捕获阶段**采样它：阅读器 ⋯ 菜单这类浮层把
 * 「点外部关闭」挂在 window 冒泡的 pointerdown 上，而 React 18 会把 discrete
 * 输入事件触发的 setState 连同 effect 注销在 touchstart 派发前同步 flush 完
 * ——touchstart 再采样看到的已经是关完之后的栈。只有捕获阶段跑在那个关闭
 * 器之前，采到的才是「手指按下那一刻」的真实状态。见 useEdgeSwipeBack。
 */
export function getOverlayHandlerCount(): number {
  let count = 0;
  for (const entry of entries) {
    if (!entry.consumed && entry.priority >= BACK_PRIORITY.overlay) count += 1;
  }
  return count;
}

interface RequestBackOptions {
  /**
   * 只询问优先级不低于这个值的处理器。用于「手势只想关掉更上层的东西」
   * 这类场景：边缘返回手势自己就代表阅读器那一层，所以它只让 overlay
   * 级别的处理器先消费，剩下的走自己的 `onBack`。
   */
  minPriority?: number;
}

/**
 * 兜底：呈现在用户面前、却没有在返回栈里注册处理器的模态框。
 *
 * SyncDialog（数据同步）这类弹窗自己管理 Esc / 遮罩点击，但不走
 * `useBackHandler`。没有这层兜底时，Android 硬返回 / 浏览器手势返回会越过
 * 它落到 tab 级兜底——应用当着一个开着的模态框切回首页，弹窗连同所在面板
 * 一起被藏进 inert 子树，切回来它还开着。这里拿不到弹窗的 onClose，只能借
 * 用它已有的关闭通道：从对话框节点派发一次会冒泡的 Escape keydown，让它
 * 自己的键盘监听执行关闭。忙碌中拒绝关闭的弹窗会原地留下——返回被消费但
 * 不发生导航，这正是模态框该有的行为（同步进行中不能被一次返回打断）。
 *
 * 只认「确实呈现着」的 aria-modal 对话框：inert 祖先（KeepAlive 隐藏的
 * 面板、阅读器盖住的 tab 层）里的不算；正在播退场动画（data-state=closed
 * 的 sheet）的也不算——那 300ms 里用户的返回应该照常落到下一层。
 */
function dismissPresentedModal(): boolean {
  if (typeof document === "undefined") return false;
  const dialogs = document.querySelectorAll<HTMLElement>('[role="dialog"][aria-modal="true"]');
  for (let i = dialogs.length - 1; i >= 0; i -= 1) {
    const dialog = dialogs[i];
    if (dialog.closest("[inert]")) continue;
    if (dialog.closest('[data-state="closed"]')) continue;
    if (dialog.getClientRects().length === 0) continue;
    dialog.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })
    );
    return true;
  }
  return false;
}

const dispatchRegisteredBack = createBackDispatcher<BackEntry>({
  getEntries: () => entries,
  overlayPriority: BACK_PRIORITY.overlay,
  dismissFallback: dismissPresentedModal,
  onError: (error) => console.warn("[useBackHandler] handler threw", error),
});

/**
 * Ask the registered handlers to consume a back intent. Returns `true` when
 * one of them did.
 *
 * Exported so gesture-driven back (edge swipe) can go through exactly the
 * same priority chain as the hardware back button instead of hard-wiring
 * itself to one particular dismiss callback.
 */
export function requestBack({ minPriority = 0 }: RequestBackOptions = {}): boolean {
  return dispatchRegisteredBack(minPriority);
}

/*
 * 浏览器 / WebView 的手势返回只能靠 popstate 感知，而 popstate 需要历史里有
 * 东西可弹。只 replaceState 的话第一次返回会直接离开页面，处理器根本没机会
 * 跑，所以要垫一层哨兵条目。
 *
 * 哨兵是「按需」上的：只有存在处理器时才 push，而且一次只留一个。最后一个
 * 处理器注销时主动把哨兵弹掉，首页稳定态没有多余历史项。若某个残留处理器
 * 抛错或明确返回 false，哨兵被用户弹掉后会继续执行原本那次 history.back，
 * 而不是让用户在首页再按一次。
 *
 * 主动弹哨兵和继续默认导航都会再产生一次 popstate；状态机用 disarming /
 * continuing 标记压住这次回声。React 同一提交里「关阅读器、注册 tab 返回」
 * 会短暂经过零处理器，rearmAfterNavigation 会在回声到达后重新补一层，不会
 * 因 effect 清理/挂载顺序丢掉返回栈。
 */
let historyGuardState: HistoryGuardState = { ...INITIAL_HISTORY_GUARD_STATE };

function transitionHistoryGuard(event: HistoryGuardEvent) {
  if (typeof window === "undefined") return;
  const transition = reduceHistoryGuard(historyGuardState, event);
  historyGuardState = transition.state;
  for (const effect of transition.effects) {
    if (effect === "push-guard") {
      try {
        window.history.pushState({ __appBack: true }, "");
      } catch {
        transitionHistoryGuard({ type: "push-failed" });
      }
      continue;
    }
    if (effect === "history-back") {
      try {
        window.history.back();
      } catch {
        transitionHistoryGuard({ type: "history-back-failed" });
      }
      continue;
    }
    const consumed = requestBack();
    transitionHistoryGuard({
      type: "back-dispatched",
      consumed,
      hasHandlers: hasAvailableHandlers(),
    });
  }
}

let globalListenerInstalled = false;
function installGlobalListener() {
  if (globalListenerInstalled || typeof window === "undefined") return;
  globalListenerInstalled = true;

  // Android：MainActivity 把硬件返回键桥接成这个事件，preventDefault 表示
  // 前端已经消费；没消费时原生侧会走默认的退出逻辑。
  window.addEventListener("app-back", (event) => {
    if (requestBack()) event.preventDefault();
  });

  try {
    window.history.replaceState({ __appRoot: true }, "");
  } catch {
    // 同上：history 不可用时只依赖 app-back 事件。
  }

  window.addEventListener("popstate", () => {
    transitionHistoryGuard({
      type: "popstate",
      hasHandlers: hasAvailableHandlers(),
    });
  });
}

function registerBackHandler(entry: BackEntry): () => void {
  installGlobalListener();
  entries.push(entry);
  transitionHistoryGuard({
    type: "handlers-changed",
    hasHandlers: hasAvailableHandlers(),
  });
  return () => {
    const idx = entries.indexOf(entry);
    if (idx >= 0) entries.splice(idx, 1);
    transitionHistoryGuard({
      type: "handlers-changed",
      hasHandlers: hasAvailableHandlers(),
    });
  };
}

/**
 * Hook variant: keeps a ref to the latest handler so React state updates
 * inside the handler don't force the effect to re-run. Only `active` (and
 * `priority`, which is normally a constant) toggles registration.
 *
 * Pass `active: false` whenever the owning UI is not on screen — a hidden but
 * still-mounted view (KeepAlive) must not keep sitting in the back stack.
 */
export function useBackHandler(
  active: boolean,
  handler: BackHandler,
  priority: number = BACK_PRIORITY.overlay
): void {
  const ref = useRef<BackHandler>(handler);
  useEffect(() => {
    ref.current = handler;
  }, [handler]);

  useEffect(() => {
    if (!active) return;
    return registerBackHandler({
      handler: () => ref.current(),
      priority,
      seq: (seqCounter += 1),
      consumed: false,
    });
  }, [active, priority]);
}
