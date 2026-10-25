import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Ajv } from "ajv";
import { describe, expect, it } from "vitest";
import { listedTurnIssue } from "../eval/tasks.ts";

const evalDir = join(
  fileURLToPath(new URL(".", import.meta.url)),
  "../../../evals/memory-recall",
);

const SCORED = [
  "03-digikey-part-number.json",
  "04-knee-squat-swap.json",
  "05-protein-target-updated.json",
  "06-forget-debt-to-daniel.json",
  "07-meal-preference-cilantro.json",
  "08-lab-partner-meeting.json",
  "09-cookie-grooming-time.json",
  "10-capstone-supervisor.json",
  "11-buried-dog-food.json",
  "12-dog-weight-distractor.json",
];

interface TaskFile {
  id: string;
  question: string;
  expectedFact: string;
  tests?: string;
  setup?: string;
  mustNotContain?: unknown;
  accept?: unknown;
  sessions: Array<{
    id: string;
    startedAt: string;
    turns: Array<{ content: string; createdAt: string }>;
  }>;
}

describe("memory recall eval tasks", () => {
  const schema = JSON.parse(
    readFileSync(join(evalDir, "task.schema.json"), "utf8"),
  ) as Record<string, unknown>;
  const validate = new Ajv({ allErrors: true, strict: true }).compile(schema);

  it("scores tasks 03-12 and leaves 01 and 02 out of the score", () => {
    expect(jsonFiles(join(evalDir, "tasks"))).toEqual(SCORED);
    expect(jsonFiles(join(evalDir, "examples"))).toEqual([
      "01-ece-midterm.json",
      "02-office-hours.json",
    ]);
  });

  it("validates scored tasks, including tests, setup, and mustNotContain", () => {
    for (const file of SCORED) {
      const task = readTask(join(evalDir, "tasks", file));
      expect(validate(task)).toBe(true);
      expect(validate.errors ?? []).toEqual([]);
      expect(task.id).toBe(file.replace(/\.json$/, ""));
      expect(task.sessions.length).toBeGreaterThanOrEqual(2);
      expect(typeof task.tests).toBe("string");
      expect((task.tests ?? "").length).toBeGreaterThan(0);
      expect(typeof task.setup).toBe("string");
      expect(Array.isArray(task.mustNotContain)).toBe(true);
      const ids = task as TaskFile & {
        expectedIds?: unknown;
        distractorIds?: unknown;
        realOnly?: unknown;
      };
      expect(Array.isArray(ids.expectedIds)).toBe(true);
      expect(Array.isArray(ids.distractorIds)).toBe(true);
      expect(listedTurnIssue(task as never)).toBeNull();
      expect(ids.realOnly === true).toBe(task.id === "04-knee-squat-swap");
      assertHistory(task);
    }
  });

  it("validates the two unscored samples", () => {
    for (const file of ["01-ece-midterm.json", "02-office-hours.json"]) {
      const task = readTask(join(evalDir, "examples", file));
      expect(validate(task)).toBe(true);
      expect(validate.errors ?? []).toEqual([]);
      expect(task.id).toBe(file.replace(/\.json$/, ""));
      assertHistory(task);
    }
  });

  it("accepts accept, and still rejects unknown fields", () => {
    const task = readTask(join(evalDir, "examples", "01-ece-midterm.json"));
    expect(
      validate({
        ...task,
        accept: ["Friday"],
        mustNotContain: ["Monday"],
        tests: "sample",
        setup: "two sessions",
      }),
    ).toBe(true);
    expect(validate({ ...task, notes: "no" })).toBe(false);
  });
});

function jsonFiles(dir: string): string[] {
  return readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .sort();
}

function readTask(path: string): TaskFile {
  return JSON.parse(readFileSync(path, "utf8")) as TaskFile;
}

function assertHistory(task: TaskFile): void {
  const times = task.sessions.flatMap((session) => [
    session.startedAt,
    ...session.turns.map((turn) => turn.createdAt),
  ]);
  expect(
    times.every(
      (value, index) => index === 0 || value >= (times[index - 1] ?? ""),
    ),
  ).toBe(true);
  const ids = task.sessions.map((session) => session.id);
  expect(new Set(ids).size).toBe(ids.length);
  const history = task.sessions
    .flatMap((session) => session.turns.map((turn) => turn.content))
    .join("\n");
  expect(history.includes(task.expectedFact)).toBe(true);
  expect(task.question.includes(task.expectedFact)).toBe(false);
}
