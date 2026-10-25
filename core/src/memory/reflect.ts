import type Database from "better-sqlite3";

/**
 * Optional abort for the idle reflect job. Chat cancels that signal.
 * The synchronous checkpoint must not pass it.
 */
export interface ReflectOptions {
  signal?: AbortSignal;
}

/** Runs after a session goes idle. Same shape as #18's `Reflector`. */
export interface Reflector {
  reflect(sessionId: string, opts?: ReflectOptions): Promise<void>;
}

export class InMemoryReflector implements Reflector {
  readonly calls: string[] = [];

  async reflect(sessionId: string, _opts?: ReflectOptions): Promise<void> {
    this.calls.push(sessionId);
  }
}

/**
 * Ten minutes. Same value as #18's `DEFAULT_REFLECT_IDLE_MS`.
 * When #18 is on main, delete this constant and `readReflectIdleMs`
 * and import both from `./schedule.ts`.
 */
export const DEFAULT_REFLECT_IDLE_MS = 10 * 60 * 1000;

/**
 * Always a number. Unset or empty is {@link DEFAULT_REFLECT_IDLE_MS}.
 * `"0"` is 0. A bad value throws before the database opens.
 * Installing the hook is separate: only a non-empty
 * `COOKIE_REFLECT_IDLE_MS` string installs it. See
 * {@link reflectHookRequested}.
 */
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

/** True when the env string is set. Unset stays off, including the default. */
export function reflectHookRequested(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const raw = env.COOKIE_REFLECT_IDLE_MS;
  return typeof raw === "string" && raw !== "";
}

/**
 * Durable marker for the eval hook. One row per session.
 * When #18 is on main, drop this class. `createMemoryRuntime` already
 * builds one `LocalReflector`; pass `runtime.reflector` into `ChatLog`
 * and do not construct a second one.
 */
export class JournalReflector implements Reflector {
  private readonly db: Database.Database;
  private readonly now: () => number;

  constructor(db: Database.Database, now: () => number) {
    this.db = db;
    this.now = now;
  }

  async reflect(sessionId: string, _opts?: ReflectOptions): Promise<void> {
    const createdAt = this.now();
    const day = new Date(createdAt).toISOString().slice(0, 10);
    this.db
      .prepare(
        `INSERT OR IGNORE INTO journal
          (id, day, entry, session_id, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        `reflect-${sessionId}`,
        day,
        `reflected ${sessionId}`,
        sessionId,
        createdAt,
      );
  }
}
