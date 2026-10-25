import { spawn } from "node:child_process";
import { once } from "node:events";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { TYPE_STRIP_NODE_ARGS } from "../node-launch.ts";
import { dumpMemory, openReadonlyDatabase } from "./dump.ts";
import { runMemoryDump } from "./dump-cli.ts";
import { SqliteMemoryStore } from "./sqlite-store.ts";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "cookie-memory-dump-"));
  dirs.push(dir);
  return dir;
}

function snapshot(dir: string): Map<string, Buffer> {
  const files = new Map<string, Buffer>();
  for (const name of readdirSync(dir)) {
    files.set(name, readFileSync(join(dir, name)));
  }
  return files;
}

function expectUnchanged(dir: string, before: Map<string, Buffer>): void {
  const after = snapshot(dir);
  expect([...after.keys()].sort()).toEqual([...before.keys()].sort());
  for (const [name, bytes] of before) {
    expect(after.get(name)?.equals(bytes)).toBe(true);
  }
}

function userTurn(dir: string): string {
  const path = join(dir, "cookie.db");
  const store = SqliteMemoryStore.open(path, { now: () => 10 });
  store.beginConversation("conv-1");
  store.appendTurn({
    id: "t1",
    sessionId: "conv-1",
    role: "user",
    content: "ECE midterm is Friday",
    tainted: false,
    model: null,
    egress: false,
    escalatedFrom: null,
    tokensIn: null,
    tokensCached: null,
    tokensOut: null,
    costUsd: null,
    latencyMs: null,
    createdAt: 10,
  });
  store.close();
  return path;
}

describe("memory dump", () => {
  it("prints sessions and turns without writing the database", () => {
    const dir = tempDir();
    const path = userTurn(dir);
    const before = snapshot(dir);

    const text = dumpMemory(path);
    expectUnchanged(dir, before);
    expect(text).toContain("cookie.db read-only");
    expect(text).toContain("turns 1");
    expect(text).toContain("ECE midterm is Friday");
    expect(text).toContain('"egress":0');

    const db = openReadonlyDatabase(path);
    expect(db.readonly).toBe(true);
    expect(() => {
      db.prepare(
        "INSERT INTO sessions (id, surface, started_at) VALUES (?, ?, ?)",
      ).run("conv-2", "popup", 11);
    }).toThrow();
    db.close();
    expectUnchanged(dir, before);
  });

  it("does not create a missing database", () => {
    const dir = tempDir();
    const missing = join(dir, "missing.db");
    expect(() => dumpMemory(missing)).toThrow();
    expect(existsSync(missing)).toBe(false);
    expect(readdirSync(dir)).toEqual([]);
  });

  it("does not migrate an empty sqlite file", () => {
    const dir = tempDir();
    const path = join(dir, "plain.db");
    const created = new Database(path);
    created.close();
    const before = snapshot(dir);
    expect(() => dumpMemory(path)).toThrow();
    expectUnchanged(dir, before);
  });

  it("answers pnpm memory dump without writing", async () => {
    const dir = tempDir();
    const path = userTurn(dir);
    const before = snapshot(dir);
    const cli = new URL("./dump-cli.ts", import.meta.url);
    const child = spawn(
      process.execPath,
      [...TYPE_STRIP_NODE_ARGS, cli.pathname, "dump", "--db", path],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    const [code] = (await once(child, "exit")) as [number | null];
    expect(stderr).toBe("");
    expect(code).toBe(0);
    expect(stdout).toContain("ECE midterm is Friday");
    expectUnchanged(dir, before);

    const logged: string[] = [];
    const written: string[] = [];
    const originalErr = process.stderr.write.bind(process.stderr);
    const originalOut = process.stdout.write.bind(process.stdout);
    process.stderr.write = ((chunk: string | Uint8Array) => {
      logged.push(typeof chunk === "string" ? chunk : chunk.toString());
      return true;
    }) as typeof process.stderr.write;
    process.stdout.write = ((chunk: string | Uint8Array) => {
      written.push(typeof chunk === "string" ? chunk : chunk.toString());
      return true;
    }) as typeof process.stdout.write;
    try {
      expect(runMemoryDump(["dump", "--db", path])).toBe(0);
      expect(runMemoryDump(["nope"])).toBe(2);
    } finally {
      process.stderr.write = originalErr;
      process.stdout.write = originalOut;
    }
    expect(logged.join("")).toContain("usage: pnpm memory dump");
    expect(written.join("")).toContain("ECE midterm is Friday");
    expectUnchanged(dir, before);
  });

  it("dumps through a symlinked path", async () => {
    const dir = tempDir();
    const path = userTurn(dir);
    const linkDir = tempDir();
    const link = join(linkDir, "dump-cli.ts");
    symlinkSync(fileURLToPath(new URL("./dump-cli.ts", import.meta.url)), link);
    const child = spawn(
      process.execPath,
      [...TYPE_STRIP_NODE_ARGS, link, "dump", "--db", path],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    const [code] = (await once(child, "exit")) as [number | null];
    expect(stderr).toBe("");
    expect(code).toBe(0);
    expect(stdout).toContain("ECE midterm is Friday");
  });
});
