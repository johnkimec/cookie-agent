import { readFileSync } from "node:fs";

/**
 * `COOKIE_CLOCK_FILE` is a test hook. Each call reads the file so a
 * replay can stamp fixture instants onto turns. Unset means `Date.now`.
 * Protocol 0.1 has no timestamp on `chat.send`.
 */
export function clockFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): () => number {
  const file = env.COOKIE_CLOCK_FILE;
  if (file === undefined || file === "") {
    return () => Date.now();
  }
  return () => readClockFile(file);
}

export function readClockFile(file: string): number {
  try {
    const value = Number(readFileSync(file, "utf8").trim());
    if (Number.isFinite(value)) {
      return value;
    }
  } catch {
    // A missing file falls back. The eval creates the file before spawn.
  }
  return Date.now();
}
