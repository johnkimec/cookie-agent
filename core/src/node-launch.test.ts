import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import {
  MIN_NODE_VERSION,
  nodeSupportsTypeStripping,
  TYPE_STRIP_NODE_ARGS,
} from "./node-launch.ts";

const exec = promisify(execFile);
const repoRoot = join(fileURLToPath(new URL(".", import.meta.url)), "../..");
const flags = TYPE_STRIP_NODE_ARGS.join(" ");

describe("node launch", () => {
  it("accepts Node 22.6 and newer, including later majors", () => {
    expect(MIN_NODE_VERSION).toBe("22.6.0");
    expect(nodeSupportsTypeStripping("v22.5.0")).toBe(false);
    expect(nodeSupportsTypeStripping("22.5.9")).toBe(false);
    expect(nodeSupportsTypeStripping("v22.6.0")).toBe(true);
    expect(nodeSupportsTypeStripping("v22.13.0")).toBe(true);
    expect(nodeSupportsTypeStripping("v22.23.4")).toBe(true);
    expect(nodeSupportsTypeStripping("v21.7.3")).toBe(false);
    expect(nodeSupportsTypeStripping("v23.0.0")).toBe(true);
    expect(nodeSupportsTypeStripping("not-a-version")).toBe(false);
    expect(nodeSupportsTypeStripping(process.version)).toBe(true);
  });

  it("uses the same type-stripping flags in every core launch", () => {
    expect([...TYPE_STRIP_NODE_ARGS]).toEqual([
      "--experimental-strip-types",
      "--disable-warning=ExperimentalWarning",
    ]);
    const corePkg = JSON.parse(
      readFileSync(join(repoRoot, "core/package.json"), "utf8"),
    ) as { engines: { node: string }; scripts: Record<string, string> };
    expect(corePkg.engines.node).toBe(">=22.6");
    expect(corePkg.scripts.start).toBe(`node ${flags} src/index.ts`);
    expect(corePkg.scripts["fake-core"]).toBe(`node ${flags} src/fake-core.ts`);
    const rootPkg = JSON.parse(
      readFileSync(join(repoRoot, "package.json"), "utf8"),
    ) as { engines: { node: string } };
    expect(rootPkg.engines.node).toBe(">=22.6");
    expect(readFileSync(join(repoRoot, ".nvmrc"), "utf8").trim()).toBe("22");
    const drive = readFileSync(
      join(repoRoot, ".cursor/skills/verify-cookie/bin/drive-core"),
      "utf8",
    );
    expect(drive).toContain(`exec node ${flags} `);
    const ci = readFileSync(join(repoRoot, ".github/workflows/ci.yml"), "utf8");
    expect(ci).toContain("node-version-file: .nvmrc");
    expect(ci).toContain("node-version: 22.13.0");
    expect(ci).toContain("COOKIE_EXPECT_TYPE_STRIP_WARNING");
    const script = readFileSync(
      join(repoRoot, "core/scripts/check-type-strip-stderr.mjs"),
      "utf8",
    );
    expect(script).toContain("--disable-warning=ExperimentalWarning");
    expect(script).not.toContain("--no-warnings");
  });

  it("keeps type-stripping stderr empty and leaves a real error in place", async () => {
    const result = await exec(
      process.execPath,
      ["core/scripts/check-type-strip-stderr.mjs"],
      { cwd: repoRoot, encoding: "utf8" },
    );
    expect(result.stderr).toBe("");
    expect(result.stdout).toMatch(/flagged stderr is empty|reproduced/);
  });
});
