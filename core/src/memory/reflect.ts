/** Runs after a session goes idle. Extraction and writes are a later step. */
export interface Reflector {
  reflect(sessionId: string): Promise<void>;
}

export class InMemoryReflector implements Reflector {
  readonly calls: string[] = [];

  async reflect(sessionId: string): Promise<void> {
    this.calls.push(sessionId);
  }
}
