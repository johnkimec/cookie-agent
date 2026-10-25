import { existsSync, statSync, unlinkSync } from "node:fs";
import Database from "better-sqlite3";

/**
 * Open `cookie.db` without writing it.
 *
 * Do not call `openMemoryDatabase` here. That sets `journal_mode = WAL`
 * and may apply migration 001. Both write. This connection is readonly
 * and `query_only`, and it does not load sqlite-vec.
 */
export function openReadonlyDatabase(path: string): Database.Database {
  const walBefore = existsSync(`${path}-wal`);
  const shmBefore = existsSync(`${path}-shm`);
  const db = new Database(path, { readonly: true, fileMustExist: true });
  db.pragma("query_only = ON");
  const original = db.close.bind(db);
  db.close = () => {
    try {
      return original();
    } finally {
      removeSidecarsWeCreated(path, walBefore, shmBefore);
    }
  };
  return db;
}

/**
 * Text dump of sessions and turns. One header, then `session` and `turn`
 * lines whose payload is JSON. Missing files throw and are not created.
 */
export function dumpMemory(path: string): string {
  const db = openReadonlyDatabase(path);
  try {
    const sessions = db
      .prepare("SELECT * FROM sessions ORDER BY started_at, id")
      .all() as Array<Record<string, unknown>>;
    const turns = db
      .prepare("SELECT * FROM turns ORDER BY created_at, id")
      .all() as Array<Record<string, unknown>>;
    const lines = [
      "cookie.db read-only",
      `sessions ${sessions.length}`,
      `turns ${turns.length}`,
      ...sessions.map((row) => `session ${JSON.stringify(row)}`),
      ...turns.map((row) => `turn ${JSON.stringify(row)}`),
      "",
    ];
    return lines.join("\n");
  } finally {
    db.close();
  }
}

/**
 * A readonly open of a checkpointed WAL file still creates an empty
 * `-wal` and a `-shm`. Those are not database writes. Remove them only
 * when this open created them and the `-wal` is still 0 bytes. A `-wal`
 * that already existed, or one that gained frames, stays.
 */
function removeSidecarsWeCreated(
  path: string,
  walBefore: boolean,
  shmBefore: boolean,
): void {
  const wal = `${path}-wal`;
  const shm = `${path}-shm`;
  if (walBefore || !existsSync(wal) || statSync(wal).size !== 0) {
    return;
  }
  unlinkSync(wal);
  if (!shmBefore && existsSync(shm)) {
    unlinkSync(shm);
  }
}
