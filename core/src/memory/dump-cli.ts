/**
 * `pnpm memory dump`. Read-only. Never creates or migrates cookie.db.
 *
 *   pnpm memory dump
 *   pnpm memory dump --db /path/to/cookie.db
 *
 * The default path is `<COOKIE_DATA_DIR>/cookie.db`, or the product data
 * directory when that variable is unset.
 */

import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { dumpMemory } from "./dump.ts";
import { memoryDatabasePath } from "./path.ts";

function isDirectRun(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) {
    return false;
  }
  return import.meta.url === pathToFileURL(resolve(entry)).href;
}

export function runMemoryDump(argv: string[]): number {
  const args = argv.filter((arg) => arg !== "--");
  if (args[0] !== "dump") {
    process.stderr.write("usage: pnpm memory dump [--db <cookie.db>]\n");
    return 2;
  }
  let dbPath: string | undefined;
  for (let index = 1; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--db") {
      const value = args[index + 1];
      if (value === undefined || value.startsWith("--")) {
        process.stderr.write("usage: pnpm memory dump [--db <cookie.db>]\n");
        return 2;
      }
      dbPath = value;
      index += 1;
      continue;
    }
    process.stderr.write("usage: pnpm memory dump [--db <cookie.db>]\n");
    return 2;
  }
  const path = dbPath ?? memoryDatabasePath();
  try {
    process.stdout.write(dumpMemory(path));
    return 0;
  } catch (error) {
    const detail = error instanceof Error ? error.message : "dump failed";
    process.stderr.write(`${detail}\n`);
    return 1;
  }
}

if (isDirectRun()) {
  process.exit(runMemoryDump(process.argv.slice(2)));
}
