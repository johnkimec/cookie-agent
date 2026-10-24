/**
 * Stdio entry for the real core.
 * Run: node --experimental-strip-types src/stdio-core.ts
 * Logs go to stderr. stdout is protocol only.
 */

import { createInterface } from "node:readline";
import { AgentCore } from "./agent-core.ts";
import { createLlamaServerProvider, readLlamaPort } from "./model/llama.ts";

export function startStdioCore(
  env: NodeJS.ProcessEnv = process.env,
): AgentCore {
  let port: number;
  try {
    port = readLlamaPort(env);
  } catch (error) {
    const detail = error instanceof Error ? error.message : "bad port";
    process.stderr.write(`cookie-core: ${detail}\n`);
    process.exit(1);
  }
  const core = new AgentCore({
    provider: createLlamaServerProvider({ port }),
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
