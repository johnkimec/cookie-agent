/**
 * Stdio entry for the real core.
 * Run: node --experimental-strip-types --disable-warning=ExperimentalWarning src/stdio-core.ts
 * Logs go to stderr. stdout is protocol only.
 */

import { createInterface } from "node:readline";
import { AgentCore, RUNTIME_WATCH_MS } from "./agent-core.ts";
import { ChatLog } from "./memory/chat-log.ts";
import { resolveEmbedder } from "./memory/embed-config.ts";
import { HttpEmbedder, readEmbedPort } from "./memory/http-embedder.ts";
import { ContentIndexer } from "./memory/index-content.ts";
import { memoryDatabasePath } from "./memory/path.ts";
import { createMemoryRuntime } from "./memory/runtime.ts";
import { readReflectIdleMs, readTimeZone } from "./memory/schedule.ts";
import { SqliteMemoryStore } from "./memory/sqlite-store.ts";
import { SqliteVecIndex } from "./memory/sqlite-vec-index.ts";
import {
  createLlamaServerProvider,
  readLlamaPort,
  readThinking,
} from "./model/llama.ts";

export async function startStdioCore(
  env: NodeJS.ProcessEnv = process.env,
): Promise<AgentCore> {
  let port: number;
  let thinking: boolean;
  let idleMs: number;
  let timeZone: string;
  let store: SqliteMemoryStore;
  let embedPort: number;
  try {
    port = readLlamaPort(env);
    thinking = readThinking(env);
    embedPort = readEmbedPort(env);
    idleMs = readReflectIdleMs(env);
    timeZone = readTimeZone(env);
    store = SqliteMemoryStore.open(memoryDatabasePath(env));
  } catch (error) {
    const detail = error instanceof Error ? error.message : "bad config";
    process.stderr.write(`cookie-core: ${detail}\n`);
    process.exit(1);
  }
  const embedder = await resolveEmbedder(env);
  const provider = createLlamaServerProvider({ port, thinking });
  // The indexer keeps its own HTTP client and writes only when /health
  // is up, so a FakeEmbedder never lands in sqlite-vec. The runtime uses
  // the same sqlite index only when resolveEmbedder returned that client.
  const indexing = new HttpEmbedder({ port: embedPort });
  const vectors = new SqliteVecIndex(store.database());
  const indexer = new ContentIndexer({
    db: store.database(),
    embedder: indexing,
    vectors,
    available: async () => (await indexing.health()) === "up",
  });
  const memory = createMemoryRuntime({
    provider,
    idleMs,
    timeZone,
    store,
    derived: store,
    recordTurns: false,
    embedder,
    vectors: embedder instanceof HttpEmbedder ? vectors : undefined,
  });
  const core = new AgentCore({
    provider,
    watchIntervalMs: RUNTIME_WATCH_MS,
    memoryHost: memory.host,
    history: new ChatLog(store, indexer),
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
