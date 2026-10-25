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
    version: 3,
    sql: readFileSync(
      new URL("./migrations/003_meta.sql", import.meta.url),
      "utf8",
    ),
  },
];

const SCHEMA_VERSION = 3;

/**
 * Open a file database, turn on WAL and foreign keys, load sqlite-vec, and
 * apply any migration newer than PRAGMA user_version.
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
  if (version > SCHEMA_VERSION) {
    db.close();
    throw new Error(`unsupported schema user_version ${version}`);
  }
  const pending = MIGRATIONS.filter((migration) => migration.version > version);
  if (pending.length > 0) {
    const apply = db.transaction(() => {
      for (const migration of pending) {
        db.exec(migration.sql);
        db.pragma(`user_version = ${migration.version}`);
      }
    });
    apply();
  }
  return db;
}
