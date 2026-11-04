/**
 * One llama-server slot (`-np 1`).
 * Chat always proceeds and aborts whatever idle job holds the slot.
 * Reflect and consolidation wait until chat is idle, and only one of
 * them holds the slot at a time.
 */

export class ModelSlot {
  private chats = 0;
  private closed = false;
  private holder: { purpose: string; controller: AbortController } | null =
    null;
  private readonly waiters: Array<() => void> = [];

  get chatActive(): boolean {
    return this.chats > 0;
  }

  get idlePurpose(): string | null {
    return this.holder?.purpose ?? null;
  }

  chatStarted(): void {
    this.chats += 1;
    this.holder?.controller.abort();
  }

  chatFinished(): void {
    if (this.chats === 0) {
      return;
    }
    this.chats -= 1;
    if (this.chats === 0) {
      this.wake();
    }
  }

  /**
   * Resolves when no chat is in flight and no other idle job holds the
   * slot. The signal aborts if a chat starts or the slot closes.
   * `release` must run when the job stops, including after an abort.
   */
  acquireIdle(purpose: string): Promise<IdleHold> {
    return new Promise((resolve) => {
      const attempt = (): void => {
        if (this.closed) {
          resolve(abortedHold());
          return;
        }
        if (this.chats > 0 || this.holder !== null) {
          this.waiters.push(attempt);
          return;
        }
        const controller = new AbortController();
        this.holder = { purpose, controller };
        let released = false;
        resolve({
          signal: controller.signal,
          release: () => {
            if (released) {
              return;
            }
            released = true;
            if (this.holder?.controller === controller) {
              this.holder = null;
            }
            this.wake();
          },
        });
      };
      attempt();
    });
  }

  close(): void {
    this.closed = true;
    this.holder?.controller.abort();
    this.wake();
  }

  private wake(): void {
    const pending = this.waiters.splice(0);
    for (const attempt of pending) {
      attempt();
    }
  }
}

export type IdleHold = {
  signal: AbortSignal;
  release: () => void;
};

export interface TimerHandle {
  clear: () => void;
}

export interface TimerQueue {
  set: (delayMs: number, fn: () => void) => TimerHandle;
}

export function systemTimers(): TimerQueue {
  return {
    set(delayMs, fn) {
      const handle = setTimeout(fn, delayMs);
      handle.unref();
      return {
        clear() {
          clearTimeout(handle);
        },
      };
    },
  };
}

export function abortError(): Error {
  const error = new Error("The operation was aborted");
  error.name = "AbortError";
  return error;
}

export function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function abortedHold(): IdleHold {
  const controller = new AbortController();
  controller.abort();
  return { signal: controller.signal, release() {} };
}
