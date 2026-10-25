import type Database from "better-sqlite3";

/**
 * Runs after a session goes idle. Extraction of facts is #18.
 * `JournalReflector` only records that the hook ran.
 */
export interface Reflector {
  reflect(sessionId: string): Promise<void>;
}

export class InMemoryReflector implements Reflector {
  readonly calls: string[] = [];

  async reflect(sessionId: string): Promise<void> {
    this.calls.push(sessionId);
  }
}

/**
 * `COOKIE_REFLECT_IDLE_MS` unset means the core does not reflect.
 * `0` is the eval: reflect as soon as a new conversation ends the
 * previous one. A bad value throws so stdio exits before protocol.
 */
export function readReflectIdleMs(
  env: NodeJS.ProcessEnv = process.env,
): number | null {
  const raw = env.COOKIE_REFLECT_IDLE_MS;
  if (raw === undefined || raw === "") {
    return null;
  }
  if (!/^\d+$/.test(raw)) {
    throw new Error("COOKIE_REFLECT_IDLE_MS must be a non-negative integer");
  }
  return Number(raw);
}

/**
 * Durable marker for the eval hook. One row per session.
 * #18 replaces this body with journal text, facts, and supersede.
 */
export class JournalReflector implements Reflector {
  private readonly db: Database.Database;
  private readonly now: () => number;

  constructor(db: Database.Database, now: () => number) {
    this.db = db;
    this.now = now;
  }

  async reflect(sessionId: string): Promise<void> {
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
