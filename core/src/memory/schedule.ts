import type { DerivedMemoryStore } from "./derived.ts";
import {
  isAbortError,
  type ModelSlot,
  systemTimers,
  type TimerQueue,
} from "./slot.ts";

/** Ten minutes, from the design doc. Tests set `COOKIE_REFLECT_IDLE_MS`. */
export const DEFAULT_REFLECT_IDLE_MS = 10 * 60 * 1000;

export const CONSOLIDATION_DAY_META = "consolidation.localDay";

/**
 * TODO(M5): read the shell's `power.state`. M1 does not check the Mac.
 * A false result skips consolidation until the next idle. The default
 * always reports AC power so the job still runs.
 */
export interface AcPower {
  onAcPower(): boolean;
}

export const m1AcPower: AcPower = {
  onAcPower() {
    return true;
  },
};

export interface ReflectCandidate {
  sessionId: string;
  lastTurnAt: number | null;
}

export interface IdleSchedulerOptions {
  slot: ModelSlot;
  derived: DerivedMemoryStore;
  reflect: (sessionId: string, signal: AbortSignal) => Promise<void>;
  consolidate: (signal: AbortSignal) => Promise<void>;
  now: () => number;
  idleMs: number;
  timeZone: string;
  localDay: (epochMs: number, timeZone: string) => string;
  timers?: TimerQueue;
  power?: AcPower;
  onError?: (error: unknown) => void;
  /**
   * Sessions from earlier runs that still need reflect.
   * The timer does not end those sessions.
   */
  sessionsToReflect?: () => readonly ReflectCandidate[];
}

/**
 * Reflect waits `idleMs` after the last turn of a session.
 * That wait does not end the session. A new `conversationId` does.
 * Consolidation runs on demand and on the first idle of each local day.
 * Neither runs while a chat holds the slot. A chat aborts the idle job.
 */
export class IdleScheduler {
  private readonly slot: ModelSlot;
  private readonly derived: DerivedMemoryStore;
  private readonly reflectJob: IdleSchedulerOptions["reflect"];
  private readonly consolidateJob: IdleSchedulerOptions["consolidate"];
  private readonly now: () => number;
  private readonly idleMs: number;
  private readonly timeZone: string;
  private readonly localDay: IdleSchedulerOptions["localDay"];
  private readonly timers: TimerQueue;
  private readonly power: AcPower;
  private readonly onError: (error: unknown) => void;
  private readonly sessionsToReflect: () => readonly ReflectCandidate[];
  private readonly pendingTimers = new Map<string, { clear: () => void }>();
  private readonly dueSessions = new Set<string>();
  private chain: Promise<void> = Promise.resolve();
  private demand = false;
  private stopped = false;

  constructor(options: IdleSchedulerOptions) {
    this.slot = options.slot;
    this.derived = options.derived;
    this.reflectJob = options.reflect;
    this.consolidateJob = options.consolidate;
    this.now = options.now;
    this.idleMs = options.idleMs;
    this.timeZone = options.timeZone;
    this.localDay = options.localDay;
    this.timers = options.timers ?? systemTimers();
    this.power = options.power ?? m1AcPower;
    this.onError = options.onError ?? (() => undefined);
    this.sessionsToReflect = options.sessionsToReflect ?? (() => []);
  }

  /** First idle of this process. Runs the daily job when it is due. */
  start(): void {
    this.catchUpReflect();
    this.enqueue(() => this.runConsolidation());
  }

  onChatStarted(sessionId: string): void {
    this.pendingTimers.get(sessionId)?.clear();
    this.pendingTimers.delete(sessionId);
    this.dueSessions.delete(sessionId);
  }

  onChatSettled(sessionId: string): void {
    if (this.stopped) {
      return;
    }
    const due = [...this.dueSessions];
    this.dueSessions.clear();
    this.arm(sessionId);
    for (const id of due) {
      if (id !== sessionId) {
        this.arm(id);
      }
    }
    this.enqueue(() => this.runConsolidation());
  }

  requestConsolidation(): void {
    if (this.stopped) {
      return;
    }
    this.demand = true;
    this.enqueue(() => this.runConsolidation());
  }

  stop(): void {
    this.stopped = true;
    for (const timer of this.pendingTimers.values()) {
      timer.clear();
    }
    this.pendingTimers.clear();
    this.dueSessions.clear();
    this.slot.close();
  }

  drained(): Promise<void> {
    return this.chain;
  }

  private catchUpReflect(): void {
    for (const session of this.sessionsToReflect()) {
      if (session.lastTurnAt === null) {
        continue;
      }
      const wait = this.idleMs - (this.now() - session.lastTurnAt);
      if (wait <= 0) {
        this.enqueue(() => this.runReflect(session.sessionId));
      } else {
        this.arm(session.sessionId, wait);
      }
    }
  }

  private arm(sessionId: string, delay = this.idleMs): void {
    this.pendingTimers.get(sessionId)?.clear();
    const handle = this.timers.set(delay, () => {
      this.pendingTimers.delete(sessionId);
      if (this.stopped) {
        return;
      }
      if (this.slot.chatActive) {
        this.dueSessions.add(sessionId);
        return;
      }
      this.enqueue(() => this.runReflect(sessionId));
    });
    this.pendingTimers.set(sessionId, handle);
  }

  private enqueue(task: () => Promise<void>): void {
    this.chain = this.chain.then(task, task).then(
      () => undefined,
      (error: unknown) => {
        if (!isAbortError(error)) {
          this.onError(error);
        }
      },
    );
  }

  private async runReflect(sessionId: string): Promise<void> {
    if (this.stopped) {
      return;
    }
    if (this.slot.chatActive) {
      this.dueSessions.add(sessionId);
      return;
    }
    const held = await this.slot.acquireIdle("reflect");
    try {
      if (held.signal.aborted || this.stopped || this.slot.chatActive) {
        return;
      }
      await this.reflectJob(sessionId, held.signal);
    } catch (error) {
      if (!isAbortError(error)) {
        this.onError(error);
      }
    } finally {
      held.release();
    }
  }

  private async runConsolidation(): Promise<void> {
    if (this.stopped || this.slot.chatActive || !this.due()) {
      return;
    }
    if (!this.power.onAcPower()) {
      return;
    }
    const held = await this.slot.acquireIdle("consolidate");
    try {
      if (
        held.signal.aborted ||
        this.stopped ||
        this.slot.chatActive ||
        !this.power.onAcPower()
      ) {
        return;
      }
      await this.consolidateJob(held.signal);
      if (held.signal.aborted || this.slot.chatActive) {
        return;
      }
      this.demand = false;
      this.derived.setMeta(
        CONSOLIDATION_DAY_META,
        this.localDay(this.now(), this.timeZone),
      );
    } catch (error) {
      if (!isAbortError(error)) {
        this.onError(error);
      }
    } finally {
      held.release();
    }
  }

  private due(): boolean {
    if (this.demand) {
      return true;
    }
    const today = this.localDay(this.now(), this.timeZone);
    return this.derived.getMeta(CONSOLIDATION_DAY_META) !== today;
  }
}

export function readReflectIdleMs(
  env: NodeJS.ProcessEnv = process.env,
): number {
  const raw = env.COOKIE_REFLECT_IDLE_MS;
  if (raw === undefined || raw === "") {
    return DEFAULT_REFLECT_IDLE_MS;
  }
  if (!/^\d+$/.test(raw)) {
    throw new Error(
      "COOKIE_REFLECT_IDLE_MS must be an integer number of milliseconds",
    );
  }
  return Number(raw);
}

export function readTimeZone(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env.COOKIE_LOCAL_TZ;
  if (raw === undefined || raw === "") {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  }
  try {
    Intl.DateTimeFormat("en-US", { timeZone: raw });
  } catch {
    throw new Error("COOKIE_LOCAL_TZ must be an IANA time zone");
  }
  return raw;
}

export function localDay(epochMs: number, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(epochMs));
  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  const day = parts.find((part) => part.type === "day")?.value;
  if (year === undefined || month === undefined || day === undefined) {
    throw new Error(`could not format a day in ${timeZone}`);
  }
  return `${year}-${month}-${day}`;
}
