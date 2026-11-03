import { execFileSync } from "node:child_process";
import { lstatSync, readlinkSync, statSync } from "node:fs";
import { homedir, userInfo } from "node:os";
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
 * A path is that default when it matches the directory under `HOME` or
 * under the account home (`os.userInfo().homedir`, and on macOS the
 * `dscl` `NFSHomeDirectory`). When the folder is missing, the nearest
 * existing parents must share device and inode and the remaining path
 * segments must match, case-insensitively on darwin.
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
  for (const home of guardHomes(env)) {
    const fallback = join(home, "Library", "Application Support", PRODUCT_DIR);
    if (sameDirectory(dir, fallback) || sameByExistingParent(dir, fallback)) {
      return true;
    }
  }
  return false;
}

const PRODUCT_DIR = "com.johnkimec.cookie-agent";

/**
 * `HOME` from the env, otherwise `os.homedir()`, plus the account home.
 * A spoofed `HOME` must not hide the directory-service home.
 */
function guardHomes(env: NodeJS.ProcessEnv): string[] {
  const homes: string[] = [];
  const add = (value: string | undefined) => {
    if (typeof value === "string" && value !== "" && !homes.includes(value)) {
      homes.push(value);
    }
  };
  add(env.HOME);
  if (homes.length === 0) {
    add(homedir());
  }
  for (const home of accountHomes()) {
    add(home);
  }
  return homes;
}

let cachedAccountHomes: string[] | null = null;

/** Password-database home, plus `dscl` on darwin. Independent of `HOME`. */
function accountHomes(): readonly string[] {
  if (cachedAccountHomes !== null) {
    return cachedAccountHomes;
  }
  const found: string[] = [];
  const add = (value: string | null) => {
    if (value !== null && value !== "" && !found.includes(value)) {
      found.push(value);
    }
  };
  try {
    add(userInfo().homedir);
  } catch {
    // This uid has no passwd entry.
  }
  if (process.platform === "darwin") {
    add(darwinNfsHome());
  }
  cachedAccountHomes = found;
  return found;
}

/** `dscl . -read /Users/<user> NFSHomeDirectory`. macOS only. */
function darwinNfsHome(): string | null {
  let username: string;
  try {
    username = userInfo().username;
  } catch {
    return null;
  }
  try {
    const output = execFileSync(
      "dscl",
      [".", "-read", `/Users/${username}`, "NFSHomeDirectory"],
      { encoding: "utf8", timeout: 2000 },
    );
    const line = output.split("\n")[0] ?? "";
    const home = line.replace(/^[^ ]+ /, "").trim();
    return home === "" ? null : home;
  } catch {
    return null;
  }
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
 * Missing leaves match when their nearest existing parents share device
 * and inode and the remaining segments match. A symlink parent is the
 * directory it points at. Darwin compares segments case-insensitively.
 */
function sameByExistingParent(left: string, right: string): boolean {
  const a = anchor(left);
  const b = anchor(right);
  if (a === null || b === null) {
    return false;
  }
  if (a.dev !== b.dev || a.ino !== b.ino) {
    return false;
  }
  if (a.segments.length !== b.segments.length) {
    return false;
  }
  return a.segments.every((segment, index) =>
    segmentEqual(segment, b.segments[index] ?? ""),
  );
}

interface Anchor {
  dev: number;
  ino: number;
  segments: string[];
}

function anchor(path: string): Anchor | null {
  let current = resolveLeaf(path);
  const segments: string[] = [];
  while (current !== dirname(current)) {
    try {
      const stat = statSync(current);
      if (stat.isDirectory()) {
        return { dev: stat.dev, ino: stat.ino, segments };
      }
    } catch {
      // This component is missing. Keep walking up.
    }
    segments.unshift(basename(current));
    current = dirname(current);
  }
  return null;
}

function resolveLeaf(path: string): string {
  const resolved = resolve(path);
  try {
    if (lstatSync(resolved).isSymbolicLink()) {
      return resolve(dirname(resolved), readlinkSync(resolved));
    }
  } catch {
    // The path is missing and is not a symlink.
  }
  return resolved;
}

function segmentEqual(left: string, right: string): boolean {
  if (process.platform === "darwin") {
    return left.toLowerCase() === right.toLowerCase();
  }
  return left === right;
}
