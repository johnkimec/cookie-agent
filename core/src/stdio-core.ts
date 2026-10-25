/**
 * Stdio entry for the real core.
 * Run: node --experimental-strip-types --disable-warning=ExperimentalWarning src/stdio-core.ts
 * Logs go to stderr. stdout is protocol only.
 */

import { createInterface } from "node:readline";
import { AgentCore, RUNTIME_WATCH_MS } from "./agent-core.ts";
import { ChatLog } from "./memory/chat-log.ts";
import { HttpEmbedder, readEmbedPort } from "./memory/http-embedder.ts";
import { ContentIndexer } from "./memory/index-content.ts";
import { memoryDatabasePath } from "./memory/path.ts";
import { SqliteMemoryStore } from "./memory/sqlite-store.ts";
import { SqliteVecIndex } from "./memory/sqlite-vec-index.ts";
import {
  createLlamaServerProvider,
  readLlamaPort,
  readThinking,
} from "./model/llama.ts";

export function startStdioCore(
  env: NodeJS.ProcessEnv = process.env,
): AgentCore {
  let port: number;
  let thinking: boolean;
  let history: ChatLog;
  try {
    port = readLlamaPort(env);
    thinking = readThinking(env);
    const embedPort = readEmbedPort(env);
    const store = SqliteMemoryStore.open(memoryDatabasePath(env));
    const embedder = new HttpEmbedder({ port: embedPort });
    const vectors = new SqliteVecIndex(store.database());
    const indexer = new ContentIndexer({
      db: store.database(),
      embedder,
      vectors,
      available: async () => (await embedder.health()) === "up",
    });
    history = new ChatLog(store, indexer);
  } catch (error) {
    const detail = error instanceof Error ? error.message : "bad config";
    process.stderr.write(`cookie-core: ${detail}\n`);
    process.exit(1);
  }
  const core = new AgentCore({
    provider: createLlamaServerProvider({ port, thinking }),
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
