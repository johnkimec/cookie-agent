import { readFileSync } from "node:fs";
import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";

const MIGRATION_SQL = readFileSync(
  new URL("./migrations/001_initial.sql", import.meta.url),
  "utf8",
);

const SCHEMA_VERSION = 1;

/**
 * Open a file database, turn on WAL and foreign keys, load sqlite-vec, and
 * apply migration 001 when PRAGMA user_version is 0.
 * A second open of the same file does not run the SQL again.
 */
export function openMemoryDatabase(path: string): Database.Database {
  const db = new Database(path);
  const journalMode = db.pragma("journal_mode = WAL", { simple: true });
  if (journalMode !== "wal") {
    db.close();
    throw new Error(`journal_mode ${String(journalMode)}`);
  }
  db.pragma("foreign_keys = ON");
  db.loadExtension(sqliteVec.getLoadablePath());

  const version = Number(db.pragma("user_version", { simple: true }));
  if (version === 0) {
    const apply = db.transaction(() => {
      db.exec(MIGRATION_SQL);
      db.pragma(`user_version = ${SCHEMA_VERSION}`);
    });
    apply();
  } else if (version !== SCHEMA_VERSION) {
    db.close();
    throw new Error(`unsupported schema user_version ${version}`);
  }
  return db;
}
