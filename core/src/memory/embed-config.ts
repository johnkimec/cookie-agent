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
 * Embedder for `createMemoryRuntime`.
 *
 * `startStdioCore` passes `await resolveEmbedder(process.env)` as
 * `options.embedder`. Tests that omit it still get `FakeEmbedder`.
 * Do not change `Embedder`.
 *
 * HTTP when `COOKIE_EMBED_PORT` (default 8081) answers `GET /health`.
 * `COOKIE_EMBEDDER=fake`, and a port that does not answer, return
 * `FakeEmbedder` so tests and a down server still construct a runtime.
 * Do not point that fake at sqlite-vec. `ContentIndexer` skips the write
 * when health is down so cookie.db does not fill with fake vectors.
 * `embed` does not add nomic prefixes. Callers that need
 * `search_query: ` or `search_document: ` add them before `embed`.
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
