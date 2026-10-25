import type { Embedder } from "./embedder.ts";
import { FakeEmbedder } from "./embedder.ts";
import {
  HttpEmbedder,
  readEmbedPort,
  readEmbedTimeoutMs,
} from "./http-embedder.ts";

export interface ResolveEmbedderOptions {
  fetch?: typeof fetch;
  /** Health probe budget. The down path in tests stays short. */
  healthTimeoutMs?: number;
}

/**
 * Remember a probe for `ttlMs` so a closed embed port is not dialed
 * on every chat turn. The first call still probes.
 */
export function cachedProbe(
  probe: () => Promise<boolean>,
  ttlMs = 5000,
): () => Promise<boolean> {
  let checkedAt = 0;
  let up = false;
  return async () => {
    const now = Date.now();
    if (checkedAt !== 0 && now - checkedAt < ttlMs) {
      return up;
    }
    try {
      up = await probe();
    } catch {
      up = false;
    }
    checkedAt = Date.now();
    return up;
  };
}

/**
 * Embedder for `createMemoryRuntime`.
 *
 * `startStdioCore` passes `await resolveEmbedder(process.env)` as
 * `options.embedder` and always passes the same `SqliteVecIndex` the
 * indexer and the retriever use. Tests that omit the embedder still
 * get `FakeEmbedder`. Do not change `Embedder`.
 *
 * HTTP when `COOKIE_EMBED_PORT` (default 8081) answers `GET /health`.
 * `COOKIE_EMBEDDER=fake`, and a port that does not answer, return
 * `FakeEmbedder` so tests and a down server still construct a runtime.
 * `ContentIndexer` skips the write when health is down so cookie.db
 * does not fill with fake vectors. Forget still deletes through the
 * shared sqlite index. `embed` does not add nomic prefixes. Callers
 * that need `search_query: ` or `search_document: ` add them before
 * `embed`.
 */
export async function resolveEmbedder(
  env: NodeJS.ProcessEnv = process.env,
  options: ResolveEmbedderOptions = {},
): Promise<Embedder> {
  if (env.COOKIE_EMBEDDER === "fake") {
    return new FakeEmbedder();
  }
  const http = new HttpEmbedder({
    port: readEmbedPort(env),
    timeoutMs: readEmbedTimeoutMs(env),
    healthTimeoutMs: options.healthTimeoutMs,
    fetch: options.fetch,
  });
  if ((await http.health()) === "up") {
    return http;
  }
  return new FakeEmbedder();
}
