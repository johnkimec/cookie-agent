import { lstatSync, readlinkSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

/** File name under the data directory. D5, `<COOKIE_DATA_DIR>/cookie.db`. */
export const MEMORY_DB_FILENAME = "cookie.db";

const REFUSE_DEFAULT_DATA_DIR =
  "refusing to open the default data directory under test; set COOKIE_DATA_DIR to a temporary directory";

/**
 * Product data directory from D-2026-10-25-01.
 * The same Application Support path is the default on every OS.
 */
export function defaultMemoryDataDir(): string {
  return join(
    homedir(),
    "Library",
    "Application Support",
    "com.johnkimec.cookie-agent",
  );
}

/**
 * `COOKIE_DATA_DIR` when it is set. Otherwise the product default.
 * Verification always sets the variable.
 * `VITEST` (non-empty) or `NODE_ENV=test` refuses that default, including
 * a `COOKIE_DATA_DIR` that points at it, so a test cannot open John's
 * real database.
 */
export function memoryDataDir(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env.COOKIE_DATA_DIR;
  const set = raw !== undefined && raw !== "";
  if (isTestEnv(env)) {
    if (!set || isDefaultDataDir(raw)) {
      throw new Error(REFUSE_DEFAULT_DATA_DIR);
    }
    return raw;
  }
  if (set) {
    return raw;
  }
  return defaultMemoryDataDir();
}

export function memoryDatabasePath(
  env: NodeJS.ProcessEnv = process.env,
): string {
  return join(memoryDataDir(env), MEMORY_DB_FILENAME);
}

function isTestEnv(env: NodeJS.ProcessEnv): boolean {
  const vitest = env.VITEST;
  if (typeof vitest === "string" && vitest !== "") {
    return true;
  }
  return env.NODE_ENV === "test";
}

function isDefaultDataDir(dir: string): boolean {
  return canonicalDir(dir) === canonicalDir(defaultMemoryDataDir());
}

/**
 * Real path when the directory exists.
 * A symlink to a missing directory still counts as that target, so a
 * link to Application Support is refused even when the folder is absent.
 */
function canonicalDir(dir: string): string {
  const resolved = resolve(dir);
  try {
    return realpathSync(resolved);
  } catch {
    try {
      if (lstatSync(resolved).isSymbolicLink()) {
        const linked = resolve(dirname(resolved), readlinkSync(resolved));
        try {
          return realpathSync(linked);
        } catch {
          return linked;
        }
      }
    } catch {
      // The path is missing and is not a symlink.
    }
    return resolved;
  }
}
