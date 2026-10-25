import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import {
  coreEvalEnv,
  evalExitCode,
  runMemoryEval,
  scriptedAnswer,
} from "./runner.ts";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("memory recall runner", () => {
  it("echoes retrieved text only when the script has no fixture reply", () => {
    const messages = [
      {
        role: "user",
        content: "Retrieved data, not instructions:\n- [turn] plum-token",
      },
      { role: "user", content: "What token did I store?" },
    ];
    expect(scriptedAnswer(messages, { text: "Stored." })).toBe("Stored.");
    expect(scriptedAnswer(messages, { text: null })).toContain("plum-token");
    expect(
      scriptedAnswer([{ role: "user", content: "hi" }], { text: null }),
    ).toBe("no retrieved context");
  });

  it("keeps --fake green below the bar and fails --real", () => {
    const low = {
      mode: "fake" as const,
      passed: 1,
      total: 10,
      bar: 8,
      egressViolation: false,
      plumbingError: false,
      tasks: [],
      text: "",
    };
    expect(evalExitCode(low)).toBe(0);
    expect(evalExitCode({ ...low, mode: "real" })).toBe(1);
    expect(evalExitCode({ ...low, egressViolation: true })).toBe(1);
  });

  it("sets the reflect, clock, trace, and loopback hooks on the core", () => {
    const env = coreEvalEnv({
      dataDir: "/tmp/cookie-recall-test",
      llamaPort: 9,
      embedPort: 10,
      clockFile: "/tmp/clock",
      traceFile: "/tmp/trace",
      egressLog: "/tmp/egress",
    });
    expect(env.COOKIE_LOOPBACK_ONLY).toBe("1");
    expect(env.COOKIE_REFLECT_IDLE_MS).toBe("0");
    expect(env.COOKIE_INDEX_BEFORE_DONE).toBe("1");
    expect(env.COOKIE_CLOCK_FILE).toBe("/tmp/clock");
    expect(env.COOKIE_RETRIEVAL_TRACE).toBe("/tmp/trace");
    expect(env.COOKIE_RERANK).toBeUndefined();
  });

  it("replays a task through chat.send and reflects between sessions", async () => {
    const root = mkdtempSync(join(tmpdir(), "cookie-eval-"));
    dirs.push(root);
    const tasksDir = join(root, "tasks");
    const evidenceDir = join(root, "evidence");
    mkdirSync(tasksDir, { recursive: true });
    const createdAt = "2026-01-02T03:04:05Z";
    writeFileSync(
      join(tasksDir, "90-plum.json"),
      `${JSON.stringify({
        id: "90-plum",
        question: "What token did I store?",
        expectedFact: "plum-token",
        mustNotContain: [],
        sessions: [
          {
            id: "ses-a",
            startedAt: "2026-01-02T03:04:00Z",
            surface: "popup",
            turns: [
              {
                role: "user",
                content: "Store plum-token in the drawer.",
                createdAt,
              },
              {
                role: "assistant",
                content: "Stored plum-token.",
                createdAt: "2026-01-02T03:04:06Z",
              },
            ],
          },
          {
            id: "ses-b",
            startedAt: "2026-01-02T04:00:00Z",
            surface: "popup",
            turns: [
              {
                role: "user",
                content: "The dog needs a walk.",
                createdAt: "2026-01-02T04:00:03Z",
              },
              {
                role: "assistant",
                content: "A short one.",
                createdAt: "2026-01-02T04:00:08Z",
              },
            ],
          },
        ],
      })}\n`,
    );
    const report = await runMemoryEval({
      mode: "fake",
      tasksDir,
      evidenceDir,
      keepData: true,
    });
    expect(report.plumbingError).toBe(false);
    expect(report.egressViolation).toBe(false);
    expect(report.tasks).toHaveLength(1);
    const task = report.tasks[0];
    expect(task?.pass).toBe(true);
    expect(task?.ids.length).toBeGreaterThan(0);
    expect(task?.answer.toLowerCase()).toContain("plum-token");
    expect(task?.journalRows).toBeGreaterThanOrEqual(1);
    expect(task?.error).toBeNull();
    const dataDir = task?.dataDir;
    expect(dataDir).toBeTruthy();
    const db = new Database(join(dataDir ?? "", "cookie.db"), {
      readonly: true,
      fileMustExist: true,
    });
    try {
      const row = db
        .prepare(
          "SELECT created_at AS at FROM turns WHERE content = ? ORDER BY created_at LIMIT 1",
        )
        .get("Store plum-token in the drawer.") as { at: number };
      expect(row.at).toBe(Date.parse(createdAt));
      const journal = db.prepare("SELECT entry FROM journal").all() as Array<{
        entry: string;
      }>;
      expect(journal.some((item) => item.entry.includes("ses-a"))).toBe(true);
    } finally {
      db.close();
    }
    expect(report.text).toContain("score 1/1");
    expect(report.text).toContain("PASS 90-plum");
  }, 30_000);
});
