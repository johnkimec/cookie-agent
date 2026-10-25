import { homedir } from "node:os";
import { join } from "node:path";

/** File name under the data directory. D5, `<COOKIE_DATA_DIR>/cookie.db`. */
export const MEMORY_DB_FILENAME = "cookie.db";

/**
 * `COOKIE_DATA_DIR` when it is set. Otherwise the product default from
 * D-2026-10-25-01. Verification always sets the variable.
 */
export function memoryDataDir(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env.COOKIE_DATA_DIR;
  if (raw !== undefined && raw !== "") {
    return raw;
  }
  return join(
    homedir(),
    "Library",
    "Application Support",
    "com.johnkimec.cookie-agent",
  );
}

export function memoryDatabasePath(
  env: NodeJS.ProcessEnv = process.env,
): string {
  return join(memoryDataDir(env), MEMORY_DB_FILENAME);
}
