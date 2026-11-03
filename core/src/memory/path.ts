import {
  existsSync,
  lstatSync,
  readlinkSync,
  realpathSync,
  statSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

/** File name under the data directory. D5, `<COOKIE_DATA_DIR>/cookie.db`. */
export const MEMORY_DB_FILENAME = "cookie.db";

const REFUSE_DEFAULT_DATA_DIR =
  "refusing to open the default data directory under test; set COOKIE_DATA_DIR to a temporary directory";

/**
 * Product data directory from D-2026-10-25-01.
 * The same Application Support path is the default on every OS.
 */
export function defaultMemoryDataDir(
  env: NodeJS.ProcessEnv = process.env,
): string {
  return join(
    homeDirectory(env),
    "Library",
    "Application Support",
    "com.johnkimec.cookie-agent",
  );
}

function homeDirectory(env: NodeJS.ProcessEnv): string {
  const home = env.HOME;
  if (typeof home === "string" && home !== "") {
    return home;
  }
  return homedir();
}

/**
 * `COOKIE_DATA_DIR` when it is set. Otherwise the product default.
 * Verification always sets the variable.
 * `VITEST` (non-empty) or `NODE_ENV=test` (any case) refuses that default,
 * including a `COOKIE_DATA_DIR` that points at it, so a test cannot open
 * John's real database. A path with the same device and inode counts.
 * `HOME` on that env is the home directory. When the default folder is
 * missing, the nearest existing parent is canonicalized, and darwin
 * compares that path case-insensitively.
 */
export function memoryDataDir(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env.COOKIE_DATA_DIR;
  const set = raw !== undefined && raw !== "";
  if (isTestEnv(env)) {
    if (!set || isDefaultDataDir(raw, env)) {
      throw new Error(REFUSE_DEFAULT_DATA_DIR);
    }
    return raw;
  }
  if (set) {
    return raw;
  }
  return defaultMemoryDataDir(env);
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
  const nodeEnv = env.NODE_ENV;
  return typeof nodeEnv === "string" && nodeEnv.toLowerCase() === "test";
}

function isDefaultDataDir(dir: string, env: NodeJS.ProcessEnv): boolean {
  const fallback = defaultMemoryDataDir(env);
  if (sameDirectory(dir, fallback)) {
    return true;
  }
  return sameCanonical(canonicalDir(dir), canonicalDir(fallback));
}

function sameCanonical(left: string, right: string): boolean {
  if (process.platform === "darwin") {
    return left.toLowerCase() === right.toLowerCase();
  }
  return left === right;
}

/**
 * True when both paths exist and are the same directory.
 * `statSync` follows links, so a symlink alias matches, and so do
 * case-folded APFS paths and `/System/Volumes/Data` firmlinks whose
 * realpath strings still differ.
 */
function sameDirectory(left: string, right: string): boolean {
  try {
    const a = statSync(left);
    const b = statSync(right);
    return (
      a.isDirectory() && b.isDirectory() && a.dev === b.dev && a.ino === b.ino
    );
  } catch {
    return false;
  }
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
          return canonicalFromParent(linked);
        }
      }
    } catch {
      // The path is missing and is not a symlink.
    }
    return canonicalFromParent(resolved);
  }
}

/**
 * Realpath the nearest existing parent and keep the missing tail.
 * A missing Application Support folder still compares as that folder.
 * On darwin the caller compares the result case-insensitively.
 */
function canonicalFromParent(resolved: string): string {
  const missing: string[] = [];
  let current = resolved;
  while (current !== dirname(current)) {
    if (existsSync(current)) {
      try {
        return join(realpathSync(current), ...missing);
      } catch {
        return join(current, ...missing);
      }
    }
    missing.unshift(basename(current));
    current = dirname(current);
  }
  return resolved;
}
