/**
 * Stdio entry for the real core.
 * Run: node --experimental-strip-types --disable-warning=ExperimentalWarning src/stdio-core.ts
 * Logs go to stderr. stdout is protocol only.
 */

import { createInterface } from "node:readline";
import { AgentCore, RUNTIME_WATCH_MS } from "./agent-core.ts";
import { installLoopbackGuard } from "./loopback-guard.ts";
import { ChatLog } from "./memory/chat-log.ts";
import { clockFromEnv } from "./memory/clock.ts";
import { cachedProbe } from "./memory/embed-config.ts";
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
  JournalReflector,
  readReflectIdleMs,
  reflectHookRequested,
} from "./memory/reflect.ts";
import {
  completeText,
  ModelReranker,
  RERANK_MAX_TOKENS,
  RERANK_RESPONSE_FORMAT,
  readRerankConfig,
} from "./memory/rerank.ts";
import { SqliteMemoryStore } from "./memory/sqlite-store.ts";
import { SqliteVecIndex } from "./memory/sqlite-vec-index.ts";
import {
  createLlamaServerProvider,
  readLlamaPort,
  readThinking,
} from "./model/llama.ts";
import type { ModelProvider } from "./model/provider.ts";

export function startStdioCore(
  env: NodeJS.ProcessEnv = process.env,
): AgentCore {
  installLoopbackGuard(env);
  let port: number;
  let thinking: boolean;
  let history: ChatLog;
  let provider: ModelProvider;
  try {
    port = readLlamaPort(env);
    thinking = readThinking(env);
    const embedPort = readEmbedPort(env);
    const weights = readRrfWeights(env);
    const rerankConfig = readRerankConfig(env);
    // Always a number. The hook is installed only when the variable is
    // a non-empty string, so the default 600000 does not reflect.
    readReflectIdleMs(env);
    const reflect = reflectHookRequested(env);
    // Every env read stays above the open. A bad timeout must not create
    // cookie.db, and a test must not fall through to the product directory.
    const queryTimeoutMs = readQueryEmbedTimeoutMs(env);
    const store = SqliteMemoryStore.open(memoryDatabasePath(env), {
      now: clockFromEnv(env),
    });
    const queryEmbedder = new HttpEmbedder({
      port: embedPort,
      timeoutMs: queryTimeoutMs,
    });
    const indexEmbedder = new HttpEmbedder({
      port: embedPort,
      timeoutMs: DEFAULT_EMBED_TIMEOUT_MS,
    });
    const vectors = new SqliteVecIndex(store.database());
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
    const trace = env.COOKIE_RETRIEVAL_TRACE;
    history = new ChatLog(store, indexer, retriever, {
      reflector: reflect
        ? new JournalReflector(store.database(), () => store.currentTime())
        : null,
      tracePath: trace === undefined || trace === "" ? null : trace,
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : "bad config";
    process.stderr.write(`cookie-core: ${detail}\n`);
    process.exit(1);
  }
  const core = new AgentCore({
    provider,
    watchIntervalMs: RUNTIME_WATCH_MS,
    history,
  });
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
