import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const exec = promisify(execFile);
const repoRoot = join(fileURLToPath(new URL(".", import.meta.url)), "../..");

describe("node:sqlite spike", () => {
  it("pins the 22.13 launch flags, both CI runners, and the vec package", () => {
    const script = readFileSync(
      join(repoRoot, "core/scripts/spike-sqlite.mjs"),
      "utf8",
    );
    expect(script).toContain("--disable-warning=ExperimentalWarning");
    expect(script).not.toContain("--no-warnings");
    expect(script).toContain("v22.13.0");
    expect(script).toContain("PRAGMA journal_mode = WAL");
    expect(script).toContain("USING fts5");
    expect(script).toContain("allowExtension: true");
    expect(script).toContain("USING vec0");

    const corePkg = JSON.parse(
      readFileSync(join(repoRoot, "core/package.json"), "utf8"),
    ) as {
      scripts: Record<string, string>;
      devDependencies: Record<string, string>;
    };
    expect(corePkg.scripts["spike-sqlite"]).toBe(
      "node scripts/spike-sqlite.mjs",
    );
    expect(corePkg.devDependencies["sqlite-vec"]).toBe("0.1.9");

    const rootPkg = JSON.parse(
      readFileSync(join(repoRoot, "package.json"), "utf8"),
    ) as { scripts: Record<string, string> };
    expect(rootPkg.scripts["spike-sqlite"]).toBe(
      "pnpm --filter @cookie-agent/core spike-sqlite",
    );

    const ci = readFileSync(join(repoRoot, ".github/workflows/ci.yml"), "utf8");
    expect(ci).toContain("sqlite-spike:");
    expect(ci).toContain("node-version: 22.13.0");
    expect(ci).toContain("os: ubuntu-latest");
    expect(ci).toContain("arch: x64");
    expect(ci).toContain("os: macos-26");
    expect(ci).toContain("arch: arm64");
    expect(ci).toContain("pnpm spike-sqlite");
    expect(ci).not.toContain("continue-on-error");
  });

  it.skipIf(process.version === "v22.13.0")(
    "refuses any Node other than 22.13.0 before opening a database",
    async () => {
      const result = await exec(
        process.execPath,
        ["core/scripts/spike-sqlite.mjs"],
        { cwd: repoRoot, encoding: "utf8" },
      ).then(
        () => {
          throw new Error("spike exited 0 on a node other than v22.13.0");
        },
        (error: { code?: number; stdout?: string; stderr?: string }) => error,
      );
      expect(result.code).toBe(1);
      expect(result.stdout).toBe(
        `node: FAIL ${process.version} (this spike requires v22.13.0)\n`,
      );
      expect(result.stderr).toBe("");
    },
  );
});
