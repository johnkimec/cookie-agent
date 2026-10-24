import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { isCookieMessage, messageErrors } from "./protocol/validate.ts";
import { decodeProcAddress } from "./verify-drive.ts";

const exec = promisify(execFile);
const repoRoot = join(fileURLToPath(new URL(".", import.meta.url)), "../..");
const script = join(repoRoot, ".cursor/skills/verify-cookie/bin/drive-core");

const runtimes: string[] = [];

afterEach(async () => {
  await Promise.all(
    runtimes.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

async function runtime(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "cookie-verify-test-"));
  runtimes.push(dir);
  return dir;
}

function run(args: string[], runtimeDir: string) {
  return exec(script, args, {
    cwd: repoRoot,
    env: { ...process.env, COOKIE_VERIFY_RUNTIME: runtimeDir },
    encoding: "utf8",
    timeout: 20000,
  });
}

describe("verify-cookie drive-core", () => {
  it("decodes a little-endian /proc/net/tcp address", () => {
    expect(decodeProcAddress("0100007F:46A0")).toBe("127.0.0.1:18080");
  });

  it("doctors the fake core", async () => {
    const root = await runtime();
    const result = await run(["doctor"], root);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("ok\n");
    expect(result.stdout).toContain("protocolVersion 0.1\n");
    expect(result.stdout).toContain("server cookie-fake-core\n");
    expect(result.stdout).toContain("runtime up fake-local\n");
    expect(result.stdout).toContain("llamaPort 18080\n");
    expect(result.stdout).toContain("sockets none\n");
  });

  it("drives chat streaming, then cleanup leaves the transcript", async () => {
    const root = await runtime();
    const evidence = await mkdtemp(join(tmpdir(), "cookie-evidence-"));
    try {
      const result = await run(
        ["drive", "chat-streaming", "--evidence", evidence],
        root,
      );
      expect(result.stdout).toContain("deltas 3\n");
      expect(result.stdout).toContain("finishReason stop\n");
      expect(result.stdout).toContain("cancelled true\n");
      const transcript = await readFile(
        join(evidence, "transcript.jsonl"),
        "utf8",
      );
      const messages = transcript
        .split("\n")
        .filter((line) => line.trim() !== "")
        .map(
          (line) => JSON.parse(line) as { direction: string; message: unknown },
        );
      expect(messages.length).toBeGreaterThan(8);
      for (const entry of messages) {
        expect(
          isCookieMessage(entry.message),
          messageErrors(entry.message),
        ).toBe(true);
      }
      const methods = messages.map((entry) => {
        const message = entry.message as { method?: string };
        return message.method ?? entry.direction;
      });
      expect(methods).toContain("chat.delta");
      expect(methods).toContain("chat.done");
      const scratch = await readFile(join(root, "scratch-dirs.txt"), "utf8");
      const dataDirs = scratch
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line !== "");
      expect(dataDirs.length).toBeGreaterThan(0);
      const cleaned = await run(["cleanup"], root);
      expect(cleaned.stdout).toBe("ok\n");
      for (const dir of dataDirs) {
        await expect(stat(dir)).rejects.toThrow();
      }
      const survived = await readFile(
        join(evidence, "transcript.jsonl"),
        "utf8",
      );
      expect(survived).toBe(transcript);
      expect(await readFile(join(evidence, "command.txt"), "utf8")).toContain(
        "drive chat-streaming --evidence",
      );
    } finally {
      await rm(evidence, { recursive: true, force: true });
    }
  }, 20000);

  it("doctors and drives the real core against the llama stub", async () => {
    const root = await runtime();
    const doctor = await run(["doctor", "--core", "real"], root);
    expect(doctor.stderr).toBe("");
    expect(doctor.stdout).toContain("ok\n");
    expect(doctor.stdout).toContain("server cookie-core\n");
    expect(doctor.stdout).toContain("runtime up Qwen3.6-35B-A3B\n");
    expect(doctor.stdout).toContain("llamaPort 18080\n");
    expect(doctor.stdout).toContain("sockets loopback\n");

    const evidence = await mkdtemp(join(tmpdir(), "cookie-evidence-"));
    try {
      const chat = await run(
        ["drive", "chat-streaming", "--evidence", evidence, "--core", "real"],
        root,
      );
      expect(chat.stdout).toContain("deltas 3\n");
      expect(chat.stdout).toContain("finishReason stop\n");
      expect(chat.stdout).toContain("cancelled true\n");
      expect(chat.stdout).toContain("modelAborted true\n");
      const transcript = await readFile(
        join(evidence, "transcript.jsonl"),
        "utf8",
      );
      for (const line of transcript.split("\n")) {
        if (line.trim() === "") {
          continue;
        }
        const entry = JSON.parse(line) as { message: unknown };
        expect(
          isCookieMessage(entry.message),
          messageErrors(entry.message),
        ).toBe(true);
      }
      expect(await readFile(join(evidence, "command.txt"), "utf8")).toContain(
        "--core real",
      );
    } finally {
      await rm(evidence, { recursive: true, force: true });
    }
  }, 20000);

  it("drives model status through up, loading, and down", async () => {
    const root = await runtime();
    const evidence = await mkdtemp(join(tmpdir(), "cookie-evidence-"));
    try {
      const result = await run(
        ["drive", "model-status", "--evidence", evidence],
        root,
      );
      expect(result.stdout).toContain("loading refused\n");
      expect(result.stdout).toContain("down refused\n");
      expect(result.stdout).toContain("recovered stop\n");
      expect(result.stdout).toContain(
        "verified-unreachable on Linux: requires macOS\n",
      );
    } finally {
      await rm(evidence, { recursive: true, force: true });
    }
  }, 20000);

  it("reports the Mac surfaces unreachable on Linux", async () => {
    const root = await runtime();
    for (const feature of ["menu-bar-icon", "hotkey-popup"]) {
      const failed = await run(["drive", feature], root).then(
        () => null,
        (error: { code?: number; stdout?: string }) => error,
      );
      expect(failed).not.toBeNull();
      expect(failed?.code).toBe(2);
      expect(failed?.stdout).toBe(
        "verified-unreachable on Linux: requires macOS\n",
      );
    }
  });

  it("cleanup does not delete evidence or kill an unrelated pid", async () => {
    const root = await runtime();
    const evidence = await mkdtemp(join(tmpdir(), "cookie-evidence-"));
    const scratch = join(root, "scratch-data");
    try {
      await exec("mkdir", ["-p", join(root, "pids"), scratch]);
      await exec("bash", [
        "-c",
        `printf '%s\\n' '${JSON.stringify({ pid: process.pid, dataDir: evidence })}' > '${join(root, "pids", `${process.pid}.json`)}'`,
      ]);
      const { writeFile, appendFile } = await import("node:fs/promises");
      await writeFile(join(evidence, "transcript.jsonl"), '{"kept":true}\n');
      await appendFile(
        join(root, "scratch-dirs.txt"),
        `${evidence}\n${scratch}\n`,
      );
      const result = await run(["cleanup"], root);
      expect(result.stdout).toBe("ok\n");
      expect(
        await readFile(join(evidence, "transcript.jsonl"), "utf8"),
      ).toContain("kept");
      await expect(stat(scratch)).rejects.toThrow();
    } finally {
      await rm(evidence, { recursive: true, force: true });
    }
  });
});
