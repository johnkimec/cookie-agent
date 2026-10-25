import { execFile } from "node:child_process";
import {
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { TYPE_STRIP_NODE_ARGS } from "./node-launch.ts";
import { isCookieMessage, messageErrors } from "./protocol/validate.ts";
import {
  type DriveInvocation,
  decodeProcAddress,
  HISTORY_CODE_WORD,
  resolveDriveExit,
} from "./verify-drive.ts";
import { startLlamaStub } from "./verify-llama-stub.ts";

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

function run(
  args: string[],
  runtimeDir: string,
  extraEnv: NodeJS.ProcessEnv = {},
  timeout = 20000,
) {
  return exec(script, args, {
    cwd: repoRoot,
    env: { ...process.env, COOKIE_VERIFY_RUNTIME: runtimeDir, ...extraEnv },
    encoding: "utf8",
    timeout,
  });
}

function nodeEval(source: string) {
  return exec(
    process.execPath,
    [...TYPE_STRIP_NODE_ARGS, "--input-type=module", "-e", source],
    { cwd: repoRoot, encoding: "utf8", timeout: 20000 },
  );
}

function capturedFailure(error: unknown): {
  code?: number;
  stdout?: string;
  stderr?: string;
} {
  return error as { code?: number; stdout?: string; stderr?: string };
}

function exitForEvidence(
  evidenceDir: string,
  startedAt: number,
  evidenceFiles: readonly string[],
) {
  const run: DriveInvocation = {
    code: 0,
    evidenceDir,
    startedAt,
    evidenceFiles,
  };
  return nodeEval(
    `import { resolveDriveExit } from "./core/src/verify-drive.ts";
     process.exit(await resolveDriveExit(${JSON.stringify(run)}));`,
  ).then(
    (result) => ({ code: 0, stderr: result.stderr }),
    (error: unknown) => capturedFailure(error),
  );
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

  it("doctors an external llama server without binding 18080", async () => {
    const stub = await startLlamaStub(0);
    const root = await runtime();
    try {
      const doctor = await run(
        ["doctor", "--core", "real", "--llama", "external"],
        root,
        { COOKIE_LLAMA_PORT: String(stub.port) },
      );
      expect(doctor.stderr).toBe("");
      expect(doctor.stdout).toContain("ok\n");
      expect(doctor.stdout).toContain("server cookie-core\n");
      expect(doctor.stdout).toContain("runtime up Qwen3.6-35B-A3B\n");
      expect(doctor.stdout).toContain(`llamaPort ${stub.port}\n`);
      expect(doctor.stdout).toContain("sockets loopback\n");
      expect(stub.healthHits).toBeGreaterThan(0);
    } finally {
      await stub.close();
    }
  });

  it("drives two history turns against an external llama server", async () => {
    const stub = await startLlamaStub(0, { recallWord: HISTORY_CODE_WORD });
    const root = await runtime();
    const evidence = await mkdtemp(join(tmpdir(), "cookie-evidence-"));
    try {
      const result = await run(
        [
          "drive",
          "chat-history",
          "--evidence",
          evidence,
          "--core",
          "real",
          "--llama",
          "external",
        ],
        root,
        { COOKIE_LLAMA_PORT: String(stub.port) },
      );
      expect(result.stdout).toContain("history true\n");
      expect(result.stdout).toContain("chat 1 ttftMs ");
      expect(result.stdout).toContain("chat 2 ttftMs ");
      expect(result.stdout).toContain("inputTokens ");
      expect(result.stdout).toContain("outputTokens ");
      const timings = await readFile(join(evidence, "timings.txt"), "utf8");
      expect(timings).toContain(`codeWord ${HISTORY_CODE_WORD}`);
      expect(timings).toContain("ttftMs ");
      expect(timings).toContain("totalMs ");
      expect(timings).toContain("inputTokens ");
      const transcript = await readFile(
        join(evidence, "transcript.jsonl"),
        "utf8",
      );
      expect(transcript).toContain(HISTORY_CODE_WORD);
      expect(transcript).toContain("What code word");
      const command = await readFile(join(evidence, "command.txt"), "utf8");
      expect(command).toContain("--llama external");
      expect(command).toContain(`COOKIE_LLAMA_PORT=${stub.port}`);
      expect(stub.chats).toHaveLength(2);
      const secondBody = JSON.stringify(stub.chats[1]?.messages);
      expect(secondBody.toLowerCase()).toContain(
        HISTORY_CODE_WORD.toLowerCase(),
      );
      const secondMessages = stub.chats[1]?.messages;
      expect(Array.isArray(secondMessages)).toBe(true);
      const lastUser = [...(secondMessages as unknown[])]
        .reverse()
        .find(
          (message) =>
            typeof message === "object" &&
            message !== null &&
            "role" in message &&
            message.role === "user",
        ) as { content?: unknown } | undefined;
      const lastText = JSON.stringify(lastUser?.content ?? "");
      expect(lastText.toLowerCase()).not.toContain(
        HISTORY_CODE_WORD.toLowerCase(),
      );
    } finally {
      await stub.close();
      await rm(evidence, { recursive: true, force: true });
    }
  }, 20000);

  it("drives memory persist across a core restart on the stub", async () => {
    const root = await runtime();
    const evidence = await mkdtemp(join(tmpdir(), "cookie-evidence-"));
    try {
      const result = await run(
        ["drive", "memory-persist", "--evidence", evidence, "--core", "real"],
        root,
      );
      expect(result.stdout).toContain("persist true\n");
      expect(result.stdout).toContain("egress 0\n");
      const transcript = await readFile(
        join(evidence, "transcript.jsonl"),
        "utf8",
      );
      const initializes = transcript
        .split("\n")
        .filter((line) => line.includes('"method":"initialize"')).length;
      expect(initializes).toBe(2);
      expect(transcript).toContain(HISTORY_CODE_WORD);
      const dbText = await readFile(join(evidence, "db.txt"), "utf8");
      expect(dbText).toContain(HISTORY_CODE_WORD);
      expect(dbText).toContain('"egress":0');
      expect(dbText).not.toContain('"egress":1');
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
    } finally {
      await rm(evidence, { recursive: true, force: true });
    }
  }, 20000);

  it("drives memory remember into a pinned fact and a new conversation", async () => {
    const root = await runtime();
    const evidence = await mkdtemp(join(tmpdir(), "cookie-evidence-"));
    try {
      const result = await run(
        ["drive", "memory-remember", "--evidence", evidence, "--core", "real"],
        root,
        {},
        30000,
      );
      expect(result.stdout).toContain("remember true\n");
      expect(result.stdout).toContain("pinned true\n");
      expect(result.stdout).toContain("egress 0\n");
      const dbText = await readFile(join(evidence, "db.txt"), "utf8");
      expect(dbText).toContain("ECE midterm is Friday");
      expect(dbText).toContain('"pinned":1');
      const transcript = await readFile(
        join(evidence, "transcript.jsonl"),
        "utf8",
      );
      expect(transcript).toContain("conv-remember-next");
    } finally {
      await rm(evidence, { recursive: true, force: true });
    }
  }, 30000);

  it("drives memory forget so only the raw turn keeps the code", async () => {
    const root = await runtime();
    const evidence = await mkdtemp(join(tmpdir(), "cookie-evidence-"));
    try {
      const result = await run(
        ["drive", "memory-forget", "--evidence", evidence, "--core", "real"],
        root,
        {},
        60000,
      );
      expect(result.stdout).toContain("forget true\n");
      expect(result.stdout).toContain("profile dropped\n");
      expect(result.stdout).toContain("vectors cleared\n");
      expect(result.stdout).toContain("prompt clean\n");
      const dbText = await readFile(join(evidence, "db.txt"), "utf8");
      expect(dbText).toContain("Remember the locker code is 4417");
      expect(dbText).toContain("Saved: your locker code is 4417.");
      expect(dbText).not.toMatch(/^fact .*"4417"/m);
      expect(dbText).toContain("vec_facts ");
      expect(dbText).toContain("embed_index ");
      const command = await readFile(join(evidence, "command.txt"), "utf8");
      expect(command).toContain("COOKIE_REFLECT_IDLE_MS=250");
      const stderr = await readFile(join(evidence, "stderr.txt"), "utf8");
      expect(stderr).not.toContain("4417");
      expect(stderr).toMatch(/^memory\.forget facts=\S+ turns=\S+$/m);
    } finally {
      await rm(evidence, { recursive: true, force: true });
    }
  }, 60000);

  it("drives memory reflect to abort on chat.send and then write a fact", async () => {
    const root = await runtime();
    const evidence = await mkdtemp(join(tmpdir(), "cookie-evidence-"));
    try {
      const result = await run(
        ["drive", "memory-reflect", "--evidence", evidence, "--core", "real"],
        root,
        {},
        30000,
      );
      expect(result.stdout).toContain("reflect aborted\n");
      expect(result.stdout).toContain("journal 1\n");
      const dbText = await readFile(join(evidence, "db.txt"), "utf8");
      expect(dbText).toMatch(/^journal /m);
      expect(dbText).toMatch(/^fact .*"source_turn":"conv-/m);
    } finally {
      await rm(evidence, { recursive: true, force: true });
    }
  }, 30000);

  it("drives the profile cap and keeps the pinned name", async () => {
    const root = await runtime();
    const evidence = await mkdtemp(join(tmpdir(), "cookie-evidence-"));
    try {
      const result = await run(
        [
          "drive",
          "memory-profile-cap",
          "--evidence",
          evidence,
          "--core",
          "real",
        ],
        root,
        {},
        30000,
      );
      expect(result.stdout).toContain("profile capped\n");
      expect(result.stdout).toContain("pinned kept\n");
      const dbText = await readFile(join(evidence, "db.txt"), "utf8");
      expect(dbText).toContain('"key":"name"');
      expect(dbText).not.toContain('"key":"note_15"');
    } finally {
      await rm(evidence, { recursive: true, force: true });
    }
  }, 30000);

  it("drives memory rebuild from turns and recalls the turn", async () => {
    const root = await runtime();
    const evidence = await mkdtemp(join(tmpdir(), "cookie-evidence-"));
    try {
      const result = await run(
        ["drive", "memory-rebuild", "--evidence", evidence, "--core", "real"],
        root,
        {},
        45000,
      );
      expect(result.stdout).toContain("rebuild true\n");
      expect(result.stdout).toContain("recall true\n");
      const dbText = await readFile(join(evidence, "db.txt"), "utf8");
      expect(dbText).toContain("amber marker for the rebuild check");
      const transcript = await readFile(
        join(evidence, "transcript.jsonl"),
        "utf8",
      );
      expect(transcript).toContain("conv-rebuild-ask");
    } finally {
      await rm(evidence, { recursive: true, force: true });
    }
  }, 45000);

  it("still rejects memory-recall because that drive is not written", async () => {
    const root = await runtime();
    const evidence = await mkdtemp(join(tmpdir(), "cookie-evidence-"));
    try {
      const failed = await run(
        ["drive", "memory-recall", "--evidence", evidence, "--core", "real"],
        root,
      ).then(
        () => ({ code: 0, stdout: "", stderr: "" }),
        (error: unknown) => capturedFailure(error),
      );
      expect(failed.code).toBe(2);
      expect(failed.stderr).toContain("usage:");
    } finally {
      await rm(evidence, { recursive: true, force: true });
    }
  });

  it("drives BM25 recall when the embedder port is closed", async () => {
    const root = await runtime();
    const evidence = await mkdtemp(join(tmpdir(), "cookie-evidence-"));
    try {
      const result = await run(
        [
          "drive",
          "memory-embed-down",
          "--evidence",
          evidence,
          "--core",
          "real",
        ],
        root,
      );
      expect(result.stdout).toContain("embedDown true\n");
      expect(result.stdout).toContain("recall true\n");
      expect(result.stdout).toContain("egress 0\n");
      const transcript = await readFile(
        join(evidence, "transcript.jsonl"),
        "utf8",
      );
      expect(transcript).toContain(HISTORY_CODE_WORD);
      expect(transcript).toContain("conv-ask");
      expect(transcript).toContain(
        "What did I say about the ECE midterm last week?",
      );
      const askSend = transcript.split("\n").find((line) => {
        return (
          line.includes('"method":"chat.send"') && line.includes("conv-ask")
        );
      });
      expect(askSend).toBeDefined();
      expect(askSend?.toLowerCase()).not.toContain(
        HISTORY_CODE_WORD.toLowerCase(),
      );
      const dbText = await readFile(join(evidence, "db.txt"), "utf8");
      expect(dbText).toContain(HISTORY_CODE_WORD);
      expect(dbText).toContain('"egress":0');
      expect(dbText).not.toContain('"egress":1');
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
    } finally {
      await rm(evidence, { recursive: true, force: true });
    }
  }, 20000);

  it("drives a llama stub restart through up, down, loading, and up", async () => {
    const root = await runtime();
    const evidence = await mkdtemp(join(tmpdir(), "cookie-evidence-"));
    try {
      const result = await run(
        ["drive", "runtime-restart", "--evidence", evidence, "--core", "real"],
        root,
      );
      expect(result.stdout).toContain("status up down loading up\n");
      expect(result.stdout).toContain("inflight error\n");
      expect(result.stdout).toContain("recovered stop\n");
      const transcript = await readFile(
        join(evidence, "transcript.jsonl"),
        "utf8",
      );
      expect(transcript).toContain('"finishReason":"error"');
      expect(transcript).toContain('"state":"loading"');
      expect(transcript).toContain('"state":"down"');
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

  it("drives through a symlinked checkout and writes evidence", async () => {
    const root = await runtime();
    const linkParent = await mkdtemp(join(tmpdir(), "cookie-link-"));
    const link = join(linkParent, "cookie");
    const evidence = await mkdtemp(join(tmpdir(), "cookie-evidence-"));
    await symlink(repoRoot, link);
    const linked = join(link, ".cursor/skills/verify-cookie/bin/drive-core");
    try {
      const doctor = await exec(linked, ["doctor"], {
        cwd: link,
        env: { ...process.env, COOKIE_VERIFY_RUNTIME: root },
        encoding: "utf8",
        timeout: 20000,
      });
      expect(doctor.stdout).toContain("ok\n");
      expect(doctor.stdout).toContain("server cookie-fake-core\n");
      expect(doctor.stderr).toBe("");

      const result = await exec(
        linked,
        ["drive", "chat-streaming", "--evidence", evidence],
        {
          cwd: link,
          env: { ...process.env, COOKIE_VERIFY_RUNTIME: root },
          encoding: "utf8",
          timeout: 20000,
        },
      );
      expect(result.stdout).toContain("deltas 3\n");
      expect(result.stdout).toContain("finishReason stop\n");
      expect(result.stdout).toContain("cancelled true\n");
      expect(result.stderr).toBe("");
      expect(await readFile(join(evidence, "summary.txt"), "utf8")).toContain(
        "deltas 3\n",
      );
      expect(
        await readFile(join(evidence, "transcript.jsonl"), "utf8"),
      ).toContain("chat.delta");
      expect(await readFile(join(evidence, "command.txt"), "utf8")).toContain(
        "drive chat-streaming --evidence",
      );
      expect(await readFile(join(evidence, "stderr.txt"), "utf8")).toBe("");
    } finally {
      await rm(evidence, { recursive: true, force: true });
      await rm(linkParent, { recursive: true, force: true });
    }
  }, 20000);

  it("exits 1 when verify-drive.ts is executed directly", async () => {
    const evidence = await mkdtemp(join(tmpdir(), "cookie-evidence-"));
    try {
      const failed = await exec(
        process.execPath,
        [
          ...TYPE_STRIP_NODE_ARGS,
          join(repoRoot, "core/src/verify-drive.ts"),
          "drive",
          "chat-streaming",
          "--evidence",
          evidence,
        ],
        { cwd: repoRoot, encoding: "utf8", timeout: 20000 },
      ).then(
        () => ({ code: 0, stdout: "", stderr: "" }),
        (error: unknown) => capturedFailure(error),
      );
      expect(failed.code).toBe(1);
      expect(failed.stdout ?? "").toBe("");
      expect(failed.stderr).toContain(
        "run bin/drive-core (or verify-drive-entry.ts)\n",
      );
      await expect(stat(join(evidence, "summary.txt"))).rejects.toThrow();
    } finally {
      await rm(evidence, { recursive: true, force: true });
    }
  });

  it("rejects stale evidence and a missing db.txt or timings.txt", async () => {
    const baseFiles = [
      "command.txt",
      "transcript.jsonl",
      "stderr.txt",
      "summary.txt",
    ];
    expect(
      await resolveDriveExit({
        code: 0,
        evidenceDir: null,
        startedAt: null,
        evidenceFiles: [],
      }),
    ).toBe(0);

    const staleDir = await mkdtemp(join(tmpdir(), "cookie-evidence-"));
    const missingDir = await mkdtemp(join(tmpdir(), "cookie-evidence-"));
    const freshDir = await mkdtemp(join(tmpdir(), "cookie-evidence-"));
    try {
      const staleAt = new Date(Date.now() - 60_000);
      for (const name of baseFiles) {
        const path = join(staleDir, name);
        await writeFile(path, "stale\n");
        await utimes(path, staleAt, staleAt);
      }
      const stale = await exitForEvidence(staleDir, Date.now(), baseFiles);
      expect(stale.code).toBe(1);
      expect(stale.stderr).toContain("drive-core: no evidence written\n");

      const startedAt = Date.now();
      for (const name of baseFiles) {
        await writeFile(join(missingDir, name), "fresh\n");
      }
      const missingDb = await exitForEvidence(missingDir, startedAt, [
        ...baseFiles,
        "db.txt",
      ]);
      expect(missingDb.code).toBe(1);
      expect(missingDb.stderr).toContain("drive-core: no evidence written\n");
      const missingTimings = await exitForEvidence(missingDir, startedAt, [
        ...baseFiles,
        "timings.txt",
      ]);
      expect(missingTimings.code).toBe(1);
      expect(missingTimings.stderr).toContain(
        "drive-core: no evidence written\n",
      );

      const freshStart = Date.now();
      for (const name of [...baseFiles, "db.txt", "timings.txt"]) {
        await writeFile(join(freshDir, name), "fresh\n");
      }
      const fresh = await exitForEvidence(freshDir, freshStart, [
        ...baseFiles,
        "db.txt",
        "timings.txt",
      ]);
      expect(fresh.code).toBe(0);
      expect(fresh.stderr).toBe("");
    } finally {
      await rm(staleDir, { recursive: true, force: true });
      await rm(missingDir, { recursive: true, force: true });
      await rm(freshDir, { recursive: true, force: true });
    }
  });

  it("does not start a drive when verify-drive.ts is imported", async () => {
    const result = await nodeEval(
      `import { HISTORY_CODE_WORD } from "./core/src/verify-drive.ts";
       if (HISTORY_CODE_WORD !== "marmalade417") process.exit(2);
       process.stdout.write("imported\\n");`,
    );
    expect(result.stdout).toBe("imported\n");
    expect(result.stderr).toBe("");
  });
});
