/**
 * Stdio entry for the real core.
 * Run: node --experimental-strip-types --disable-warning=ExperimentalWarning src/stdio-core.ts
 * Logs go to stderr. stdout is protocol only.
 */

import { createInterface } from "node:readline";
import { AgentCore, RUNTIME_WATCH_MS } from "./agent-core.ts";
import { ChatLog } from "./memory/chat-log.ts";
import { cachedProbe, resolveEmbedder } from "./memory/embed-config.ts";
import {
  DEFAULT_EMBED_TIMEOUT_MS,
  HttpEmbedder,
  readEmbedPort,
  readQueryEmbedTimeoutMs,
} from "./memory/http-embedder.ts";
import { HybridRetriever, readRrfWeights } from "./memory/hybrid-retrieve.ts";
import { ContentIndexer } from "./memory/index-content.ts";
import { memoryDatabasePath } from "./memory/path.ts";
import {
  completeText,
  ModelReranker,
  RERANK_MAX_TOKENS,
  RERANK_RESPONSE_FORMAT,
  readRerankConfig,
} from "./memory/rerank.ts";
import { createMemoryRuntime } from "./memory/runtime.ts";
import { readReflectIdleMs, readTimeZone } from "./memory/schedule.ts";
import { SqliteMemoryStore } from "./memory/sqlite-store.ts";
import { SqliteVecIndex } from "./memory/sqlite-vec-index.ts";
import {
  createLlamaServerProvider,
  readLlamaPort,
  readThinking,
} from "./model/llama.ts";
import type { ModelProvider } from "./model/provider.ts";

export async function startStdioCore(
  env: NodeJS.ProcessEnv = process.env,
): Promise<AgentCore> {
  let port: number;
  let thinking: boolean;
  let idleMs: number;
  let timeZone: string;
  let store: SqliteMemoryStore;
  let provider: ModelProvider;
  let history: ChatLog;
  let vectors: SqliteVecIndex;
  try {
    port = readLlamaPort(env);
    thinking = readThinking(env);
    const embedPort = readEmbedPort(env);
    idleMs = readReflectIdleMs(env);
    timeZone = readTimeZone(env);
    const weights = readRrfWeights(env);
    const rerankConfig = readRerankConfig(env);
    store = SqliteMemoryStore.open(memoryDatabasePath(env));
    // One index for the indexer, retrieval, and forget. A down embed
    // server must not leave forget deleting a different in-memory index.
    vectors = new SqliteVecIndex(store.database());
    const queryEmbedder = new HttpEmbedder({
      port: embedPort,
      timeoutMs: readQueryEmbedTimeoutMs(env),
    });
    const indexEmbedder = new HttpEmbedder({
      port: embedPort,
      timeoutMs: DEFAULT_EMBED_TIMEOUT_MS,
    });
    const embedUp = cachedProbe(
      async () => (await queryEmbedder.health()) === "up",
    );
    const indexer = new ContentIndexer({
      db: store.database(),
      embedder: indexEmbedder,
      vectors,
      available: embedUp,
    });
    provider = createLlamaServerProvider({ port, thinking });
    const reranker = new ModelReranker({
      complete: (prompt, signal) =>
        completeText(provider, prompt, signal, {
          maxOutputTokens: RERANK_MAX_TOKENS,
          responseFormat: RERANK_RESPONSE_FORMAT,
        }),
      timeoutMs: rerankConfig.timeoutMs,
      enabled: rerankConfig.enabled,
    });
    const retriever = new HybridRetriever({
      db: store.database(),
      vectors,
      embedder: queryEmbedder,
      weights,
      available: embedUp,
      store,
      rerank: (query, candidates) => reranker.rerank(query, candidates),
    });
    history = new ChatLog(store, indexer, retriever);
  } catch (error) {
    const detail = error instanceof Error ? error.message : "bad config";
    process.stderr.write(`cookie-core: ${detail}\n`);
    process.exit(1);
  }
  const embedder = await resolveEmbedder(env);
  const memory = createMemoryRuntime({
    provider,
    idleMs,
    timeZone,
    store,
    derived: store,
    recordTurns: false,
    embedder,
    vectors,
  });
  const core = new AgentCore({
    provider,
    watchIntervalMs: RUNTIME_WATCH_MS,
    memoryHost: memory.host,
    history,
  });
  memory.start();
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  process.stdout.on("error", () => {
    process.exit(0);
  });
  process.on("SIGTERM", () => {
    core.onStdinClose();
  });
  lines.on("line", (line) => {
    core.handleLine(line);
  });
  lines.on("close", () => {
    core.onStdinClose();
  });
  return core;
}
