/**
 * Stdio entry for the real core.
 * Run: node --experimental-strip-types --disable-warning=ExperimentalWarning src/stdio-core.ts
 * Logs go to stderr. stdout is protocol only.
 */

import { createInterface } from "node:readline";
import { AgentCore, RUNTIME_WATCH_MS } from "./agent-core.ts";
import { createMemoryRuntime } from "./memory/runtime.ts";
import { readReflectIdleMs, readTimeZone } from "./memory/schedule.ts";
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
  let idleMs: number;
  let timeZone: string;
  try {
    port = readLlamaPort(env);
    thinking = readThinking(env);
    idleMs = readReflectIdleMs(env);
    timeZone = readTimeZone(env);
  } catch (error) {
    const detail = error instanceof Error ? error.message : "bad config";
    process.stderr.write(`cookie-core: ${detail}\n`);
    process.exit(1);
  }
  const provider = createLlamaServerProvider({ port, thinking });
  const memory = createMemoryRuntime({ provider, idleMs, timeZone });
  const core = new AgentCore({
    provider,
    watchIntervalMs: RUNTIME_WATCH_MS,
    memoryHost: memory.host,
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
