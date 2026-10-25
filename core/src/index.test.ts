import { execFile } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { CORE_SERVER_NAME } from "./index.ts";
import { TYPE_STRIP_NODE_ARGS } from "./node-launch.ts";

const exec = promisify(execFile);
const coreDir = join(fileURLToPath(new URL(".", import.meta.url)), "..");

it("names the real core and does not start stdio on import", () => {
  expect(CORE_SERVER_NAME).toBe("cookie-core");
});

it("does not start index, fake-core, or dump-cli on import", async () => {
  const result = await exec(
    process.execPath,
    [
      ...TYPE_STRIP_NODE_ARGS,
      "--input-type=module",
      "-e",
      `import "./src/index.ts";
       import "./src/fake-core.ts";
       import { runMemoryDump } from "./src/memory/dump-cli.ts";
       if (typeof runMemoryDump !== "function") process.exit(2);
       process.stdout.write("imported\\n");`,
    ],
    { cwd: coreDir, encoding: "utf8", timeout: 8000 },
  );
  expect(result.stdout).toBe("imported\n");
  expect(result.stderr).toBe("");
});
