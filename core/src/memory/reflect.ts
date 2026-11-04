/** Optional abort for the idle reflect job. Chat cancels that signal. */
export interface ReflectOptions {
  signal?: AbortSignal;
}

/** Runs after a session goes idle. The checkpoint passes this shape. */
export interface Reflector {
  reflect(sessionId: string, opts?: ReflectOptions): Promise<void>;
}

export class InMemoryReflector implements Reflector {
  readonly calls: string[] = [];

  async reflect(sessionId: string, _opts?: ReflectOptions): Promise<void> {
    this.calls.push(sessionId);
  }
}

/**
 * True when the env string is set. Unset stays off, including the default.
 * The parsed number lives in `schedule.ts` as `readReflectIdleMs`.
 */
export function reflectHookRequested(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const raw = env.COOKIE_REFLECT_IDLE_MS;
  return typeof raw === "string" && raw !== "";
}
