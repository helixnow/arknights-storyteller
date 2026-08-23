import { useEffect, useRef } from "react";

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

interface BackEntry {
  handler: BackHandler;
  priority: number;
  seq: number;
}

const entries: BackEntry[] = [];
let seqCounter = 0;
let dispatching = false;

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

/**
 * Ask the registered handlers to consume a back intent. Returns `true` when
 * one of them did.
 *
 * Exported so gesture-driven back (edge swipe) can go through exactly the
 * same priority chain as the hardware back button instead of hard-wiring
 * itself to one particular dismiss callback.
 */
export function requestBack({ minPriority = 0 }: RequestBackOptions = {}): boolean {
  // 处理器内部再次触发返回（比如关闭抽屉时又派发了一次 app-back）不应该
  // 连锁关掉整条导航栈。
  if (dispatching) return false;
  dispatching = true;
  try {
    const ordered = entries
      .filter((entry) => entry.priority >= minPriority)
      .sort((a, b) => b.priority - a.priority || b.seq - a.seq);
    const ask = (entry: BackEntry): boolean => {
      // 上一个处理器可能已经把它卸载了（快照是询问开始时拍的）。
      if (!entries.includes(entry)) return false;
      try {
        return entry.handler();
      } catch (err) {
        console.warn("[useBackHandler] handler threw", err);
        return false;
      }
    };
    // overlay 及以上先问：注册过的浮层永远比 DOM 兜底更清楚怎么关掉自己。
    for (const entry of ordered) {
      if (entry.priority < BACK_PRIORITY.overlay) break;
      if (ask(entry)) return true;
    }
    // 未注册的模态框排在 overlay 之后、view/tab 之前：它盖在视图之上，
    // 返回不该越过它去关阅读器或切 tab。
    if (minPriority <= BACK_PRIORITY.overlay && dismissPresentedModal()) return true;
    for (const entry of ordered) {
      if (entry.priority >= BACK_PRIORITY.overlay) continue;
      if (ask(entry)) return true;
    }
    return false;
  } finally {
    dispatching = false;
  }
}

/*
 * 浏览器 / WebView 的手势返回只能靠 popstate 感知，而 popstate 需要历史里有
 * 东西可弹。只 replaceState 的话第一次返回会直接离开页面，处理器根本没机会
 * 跑，所以要垫一层哨兵条目。
 *
 * 哨兵是「按需」上的：只有存在处理器时才 push，而且一次只留一个。这样在
 * 首页（没有任何处理器注册）按返回会原样落到系统，不会被我们吞掉。哨兵被
 * 弹掉后如果没人消费这次返回，就不再补回去 —— 那次返回本来就该退出。
 *
 * 代价是浏览器里可能多按一次：上一次消费返回时补的哨兵会一直留到下一次
 * 返回。真正的退出路径在 Android，那边走的是原生 `app-back` 通道，不经过
 * history，所以「该退出的那一下」永远是一按即出。history 里不做补偿性的
 * `history.back()`：在提交期间反向导航很容易和正在进行的返回撞车。
 */
let guardArmed = false;

function armHistoryGuard() {
  if (guardArmed || typeof window === "undefined") return;
  try {
    window.history.pushState({ __appBack: true }, "");
    guardArmed = true;
  } catch {
    // 某些 WebView 会限制 pushState 次数，失败就退回默认返回行为。
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
    // 走到这里哨兵已经被浏览器弹掉了。
    guardArmed = false;
    if (requestBack()) armHistoryGuard();
  });
}

function registerBackHandler(entry: BackEntry): () => void {
  installGlobalListener();
  entries.push(entry);
  // 有人能消费返回了，才值得垫哨兵。
  armHistoryGuard();
  return () => {
    const idx = entries.indexOf(entry);
    if (idx >= 0) entries.splice(idx, 1);
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
    });
  }, [active, priority]);
}
