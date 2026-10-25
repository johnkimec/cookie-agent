import { readFileSync } from "node:fs";
import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";

const MIGRATIONS: ReadonlyArray<{ version: number; sql: string }> = [
  {
    version: 1,
    sql: readFileSync(
      new URL("./migrations/001_initial.sql", import.meta.url),
      "utf8",
    ),
  },
  {
    version: 2,
    sql: readFileSync(
      new URL("./migrations/002_embed_index.sql", import.meta.url),
      "utf8",
    ),
  },
  {
    version: 3,
    sql: readFileSync(
      new URL("./migrations/003_meta.sql", import.meta.url),
      "utf8",
    ),
  },
];

/** Latest `PRAGMA user_version` this process knows how to open. */
export const SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1]?.version ?? 0;

/**
 * Open a file database, turn on WAL and foreign keys, load sqlite-vec, and
 * apply any migration whose version is above `PRAGMA user_version`.
 * A second open of the same file does not run the SQL again.
 * Migration 001 is never edited. Later schema lives in later files.
 * Version 2 is the embed index. Version 3 is memory_meta and forgotten_turns.
 */
export function openMemoryDatabase(path: string): Database.Database {
  const db = new Database(path);
  const journalMode = db.pragma("journal_mode = WAL", { simple: true });
  if (journalMode !== "wal") {
    db.close();
    throw new Error(`journal_mode ${String(journalMode)}`);
  }
  db.pragma("foreign_keys = ON");
  try {
    db.loadExtension(sqliteVec.getLoadablePath());
  } catch (error) {
    db.close();
    throw error;
  }

  const version = Number(db.pragma("user_version", { simple: true }));
  if (!Number.isInteger(version) || version < 0) {
    db.close();
    throw new Error(`unsupported schema user_version ${String(version)}`);
  }
  if (version > SCHEMA_VERSION) {
    db.close();
    throw new Error(`unsupported schema user_version ${version}`);
  }
  const pending = MIGRATIONS.filter((migration) => migration.version > version);
  if (pending.length === 0) {
    return db;
  }
  const apply = db.transaction(() => {
    for (const migration of pending) {
      db.exec(migration.sql);
      db.pragma(`user_version = ${migration.version}`);
    }
  });
  try {
    apply();
  } catch (error) {
    db.close();
    throw error;
  }
  return db;
}
