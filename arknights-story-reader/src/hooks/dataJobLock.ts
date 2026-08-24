export type DataJobKind = "sync" | "import" | "index" | "update";

export interface DataJobLockStore {
  getSnapshot: () => DataJobKind | null;
  subscribe: (listener: () => void) => () => void;
  acquire: (kind: DataJobKind) => (() => void) | null;
  acquireWhenIdle: (kind: DataJobKind, timeoutMs: number) => Promise<(() => void) | null>;
}

/**
 * Process-local exclusive lock. The factory makes ownership races testable
 * without sharing the application's singleton between test cases.
 */
export function createDataJobLockStore(): DataJobLockStore {
  let active: DataJobKind | null = null;
  const listeners = new Set<() => void>();

  const notify = () => {
    for (const listener of [...listeners]) listener();
  };

  const subscribe = (listener: () => void) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  };

  const acquire = (kind: DataJobKind): (() => void) | null => {
    if (active !== null) return null;
    active = kind;
    notify();
    let released = false;
    return () => {
      if (released) return;
      released = true;
      if (active === kind) {
        active = null;
        notify();
      }
    };
  };

  const acquireWhenIdle = (
    kind: DataJobKind,
    timeoutMs: number
  ): Promise<(() => void) | null> => {
    const immediate = acquire(kind);
    if (immediate) return Promise.resolve(immediate);

    return new Promise((resolve) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout>;
      const finish = (release: (() => void) | null) => {
        if (settled) {
          // A timeout and release notification may race. Never leak a lock
          // acquired by the losing callback.
          release?.();
          return;
        }
        settled = true;
        unsubscribe();
        clearTimeout(timer);
        resolve(release);
      };
      const unsubscribe = subscribe(() => {
        if (settled || active !== null) return;
        finish(acquire(kind));
      });
      timer = setTimeout(() => finish(null), Math.max(0, timeoutMs));
    });
  };

  return {
    getSnapshot: () => active,
    subscribe,
    acquire,
    acquireWhenIdle,
  };
}

export const dataJobLock = createDataJobLockStore();
