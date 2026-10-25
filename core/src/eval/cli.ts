/**
 * `pnpm eval memory --fake` and `pnpm eval memory --real`.
 *
 * `--fake` exits 1 below 8 of the 9 lexical tasks.
 * `--real` exits 1 when the score is under 8/10.
 * Egress off loopback exits 1 in either mode.
 */

import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  evalExitCode,
  type RunMemoryEvalOptions,
  runMemoryEval,
  scoredTaskIds,
} from "./runner.ts";

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const parsed = readArgs(args);
  if (parsed === null) {
    process.stderr.write(
      "usage: pnpm eval memory --fake|--real [--llama-port N] [--embed-port N]\n",
    );
    process.stderr.write(
      "--real needs --llama-port and --embed-port, or COOKIE_LLAMA_PORT and COOKIE_EMBED_PORT. It does not default to 8080 or 8081.\n",
    );
    process.exit(2);
  }
  const report = await runMemoryEval({
    mode: parsed.mode,
    llamaPort: parsed.llamaPort,
    embedPort: parsed.embedPort,
    tasksDir: join(repoRoot, "evals/memory-recall/tasks"),
    evidenceDir: join(repoRoot, "verify-evidence/m1-recall"),
    expectIds: scoredTaskIds(),
  });
  process.stdout.write(report.text);
  process.exit(evalExitCode(report));
}

function readArgs(args: readonly string[]): {
  mode: RunMemoryEvalOptions["mode"];
  llamaPort?: number;
  embedPort?: number;
} | null {
  if (args[0] !== "memory") {
    return null;
  }
  const fake = args.includes("--fake");
  const real = args.includes("--real");
  if (fake === real) {
    return null;
  }
  const llamaPort = readFlagPort(args, "--llama-port");
  const embedPort = readFlagPort(args, "--embed-port");
  if (llamaPort === "invalid" || embedPort === "invalid") {
    return null;
  }
  return {
    mode: real ? "real" : "fake",
    ...(llamaPort === undefined ? {} : { llamaPort }),
    ...(embedPort === undefined ? {} : { embedPort }),
  };
}

function readFlagPort(
  args: readonly string[],
  flag: string,
): number | undefined | "invalid" {
  const exact = args.indexOf(flag);
  const inline = args.find((arg) => arg.startsWith(`${flag}=`));
  let raw: string | undefined;
  if (exact >= 0) {
    raw = args[exact + 1];
  } else if (inline !== undefined) {
    raw = inline.slice(flag.length + 1);
  }
  if (raw === undefined) {
    return undefined;
  }
  if (!/^\d+$/.test(raw)) {
    return "invalid";
  }
  const port = Number(raw);
  if (port < 1 || port > 65535) {
    return "invalid";
  }
  return port;
}

void main().catch((error: unknown) => {
  const detail = error instanceof Error ? error.message : "eval failed";
  process.stderr.write(`cookie-eval: ${detail}\n`);
  process.exit(1);
});
