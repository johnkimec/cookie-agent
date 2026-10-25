/**
 * Spawn a type-stripped entry and require stderr to stay empty.
 *
 * Node 22.13 prints an ExperimentalWarning for type stripping. The flagged
 * spawn must not. A real stderr write must still show up. Set
 * COOKIE_EXPECT_TYPE_STRIP_WARNING=1 on a Node that emits the warning
 * (22.13) so this fails if the unflagged spawn goes quiet.
 */

import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TYPE_STRIP_WARNING =
  "ExperimentalWarning: Type Stripping is an experimental feature";

const flags = [
  "--experimental-strip-types",
  "--disable-warning=ExperimentalWarning",
];

function run(args, file) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [...args, file], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.once("error", reject);
    child.once("exit", (code) => {
      resolve({ code, stdout, stderr });
    });
  });
}

const dir = await mkdtemp(join(tmpdir(), "cookie-type-strip-"));
try {
  const entry = join(dir, "entry.ts");
  const noisy = join(dir, "noisy.ts");
  await writeFile(entry, 'process.stdout.write("ok\\n");\n');
  await writeFile(noisy, 'process.stderr.write("real-error\\n");\n');

  const bare = await run(["--experimental-strip-types"], entry);
  const quiet = await run(flags, entry);
  const real = await run(flags, noisy);
  const failures = [];

  if (quiet.code !== 0) {
    failures.push(`flagged entry exited ${String(quiet.code)}`);
  }
  if (quiet.stderr !== "") {
    failures.push(`flagged stderr was not empty:\n${quiet.stderr}`);
  }
  if (quiet.stdout !== "ok\n") {
    failures.push(`flagged stdout was ${JSON.stringify(quiet.stdout)}`);
  }
  if (real.stderr !== "real-error\n") {
    failures.push(
      `a real stderr line did not survive the flag:\n${JSON.stringify(real.stderr)}`,
    );
  }

  const emitted = bare.stderr.includes(TYPE_STRIP_WARNING);
  if (process.env.COOKIE_EXPECT_TYPE_STRIP_WARNING === "1" && !emitted) {
    failures.push(
      `node ${process.version} did not emit the type-stripping warning:\n${bare.stderr}`,
    );
  }
  if (emitted) {
    process.stdout.write(
      `reproduced type-stripping ExperimentalWarning on ${process.version}\n`,
    );
  } else {
    process.stdout.write(
      `node ${process.version} did not emit the type-stripping warning; flagged stderr is empty\n`,
    );
  }

  if (failures.length > 0) {
    process.stderr.write(`${failures.join("\n")}\n`);
    process.exitCode = 1;
  }
} finally {
  await rm(dir, { recursive: true, force: true });
}
