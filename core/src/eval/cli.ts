/**
 * `pnpm eval memory --fake` and `pnpm eval memory --real`.
 *
 * `--fake` is CI plumbing. A score under 8/10 still exits 0.
 * `--real` exits 1 when the score is under 8/10.
 * Egress off loopback exits 1 in either mode.
 */

import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { evalExitCode, runMemoryEval, scoredTaskIds } from "./runner.ts";

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const mode = readMode(args);
  if (args[0] !== "memory" || mode === null) {
    process.stderr.write("usage: pnpm eval memory --fake|--real\n");
    process.exit(2);
  }
  const report = await runMemoryEval({
    mode,
    tasksDir: join(repoRoot, "evals/memory-recall/tasks"),
    evidenceDir: join(repoRoot, "verify-evidence/m1-recall"),
    expectIds: scoredTaskIds(),
  });
  process.stdout.write(report.text);
  process.exit(evalExitCode(report));
}

function readMode(args: readonly string[]): "fake" | "real" | null {
  const fake = args.includes("--fake");
  const real = args.includes("--real");
  if (fake === real) {
    return null;
  }
  return real ? "real" : "fake";
}

void main().catch((error: unknown) => {
  const detail = error instanceof Error ? error.message : "eval failed";
  process.stderr.write(`cookie-eval: ${detail}\n`);
  process.exit(1);
});
