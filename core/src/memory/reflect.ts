/** Optional abort for the idle reflect job. Chat cancels the signal. */
export interface ReflectOptions {
  signal?: AbortSignal;
}

/** Runs after a session goes idle. */
export interface Reflector {
  reflect(sessionId: string, opts?: ReflectOptions): Promise<void>;
}

export class InMemoryReflector implements Reflector {
  readonly calls: string[] = [];

  async reflect(sessionId: string, _opts?: ReflectOptions): Promise<void> {
    this.calls.push(sessionId);
  }
}
