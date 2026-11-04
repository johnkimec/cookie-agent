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
 * segments must match, case-insensitively on darwin. A path inside that
 * directory is the same refusal. A symlink chain longer than 40 hops is
 * refused.
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

const SYMLINK_HOP_CAP = 40;

function isDefaultDataDir(dir: string, env: NodeJS.ProcessEnv): boolean {
  try {
    for (const home of guardHomes(env)) {
      const fallback = join(
        home,
        "Library",
        "Application Support",
        PRODUCT_DIR,
      );
      if (
        sameDirectory(dir, fallback) ||
        sameByExistingParent(dir, fallback) ||
        isInsideDataDir(dir, fallback)
      ) {
        return true;
      }
    }
  } catch (error) {
    if (error instanceof SymlinkLimitError) {
      return true;
    }
    throw error;
  }
  return false;
}

class SymlinkLimitError extends Error {}

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
    return parseNfsHomeDirectory(output);
  } catch {
    return null;
  }
}

/**
 * `dscl` prints `NFSHomeDirectory: /Users/name`, or the value on the next
 * line when the path contains a space. Never return the bare key.
 */
export function parseNfsHomeDirectory(output: string): string | null {
  const lines = output
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
  const first = lines[0];
  if (first === undefined) {
    return null;
  }
  const inline = /^NFSHomeDirectory:\s*(.*)$/.exec(first);
  if (inline === null) {
    return null;
  }
  const captured = inline[1] ?? "";
  const value = captured === "" ? (lines[1] ?? "") : captured;
  if (value === "" || value.startsWith("NFSHomeDirectory:")) {
    return null;
  }
  return value;
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
  let current = resolvePath(path);
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

function isInsideDataDir(dir: string, fallback: string): boolean {
  const parentStat = tryStatDir(fallback);
  if (parentStat !== null) {
    const leaf = resolvePath(dir);
    let current = leaf;
    while (current !== dirname(current)) {
      try {
        const stat = statSync(current);
        if (
          stat.isDirectory() &&
          stat.dev === parentStat.dev &&
          stat.ino === parentStat.ino
        ) {
          return current !== leaf;
        }
      } catch {
        // A missing component is not this ancestor.
      }
      current = dirname(current);
    }
    return false;
  }
  const child = anchor(dir);
  const parent = anchor(fallback);
  if (child === null || parent === null) {
    return false;
  }
  if (child.dev !== parent.dev || child.ino !== parent.ino) {
    return false;
  }
  if (child.segments.length <= parent.segments.length) {
    return false;
  }
  return parent.segments.every((segment, index) =>
    segmentEqual(segment, child.segments[index] ?? ""),
  );
}

function tryStatDir(path: string): { dev: number; ino: number } | null {
  try {
    const stat = statSync(resolvePath(path));
    if (!stat.isDirectory()) {
      return null;
    }
    return { dev: stat.dev, ino: stat.ino };
  } catch {
    return null;
  }
}

/** Resolve every component, not only the final symlink. */
function resolvePath(path: string): string {
  const absolute = resolve(path);
  const parts = absolute
    .split("/")
    .filter((part) => part !== "" && part !== ".");
  let built = absolute.startsWith("/") ? "/" : "";
  let hops = 0;
  for (const part of parts) {
    if (part === "..") {
      built = dirname(built);
      if (absolute.startsWith("/") && built === "") {
        built = "/";
      }
      continue;
    }
    built = built === "/" ? `/${part}` : join(built, part);
    built = followSymlinkChain(built, () => {
      hops += 1;
      if (hops > SYMLINK_HOP_CAP) {
        throw new SymlinkLimitError("symlink chain exceeds 40 hops");
      }
    });
  }
  return built === "" ? "/" : built;
}

function followSymlinkChain(path: string, onHop: () => void): string {
  let current = path;
  const seen = new Set<string>();
  for (;;) {
    if (seen.has(current)) {
      throw new SymlinkLimitError("symlink loop");
    }
    seen.add(current);
    let stat: ReturnType<typeof lstatSync>;
    try {
      stat = lstatSync(current);
    } catch {
      return current;
    }
    if (!stat.isSymbolicLink()) {
      return current;
    }
    onHop();
    current = resolve(dirname(current), readlinkSync(current));
  }
}

function segmentEqual(left: string, right: string): boolean {
  if (process.platform === "darwin") {
    return left.toLowerCase() === right.toLowerCase();
  }
  return left === right;
}
