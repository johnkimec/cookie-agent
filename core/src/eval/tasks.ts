import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { acceptIssue, textContains } from "./match.ts";

export interface RecallTurn {
  role: "user" | "assistant" | "tool";
  content: string;
  createdAt: string;
}

export interface RecallSession {
  id: string;
  startedAt: string;
  surface: string;
  turns: RecallTurn[];
}

export interface RecallTask {
  id: string;
  question: string;
  expectedFact: string;
  accept?: string[];
  mustNotContain?: string[];
  /** Turn ids that answer the question. `--fake` requires one in the top 8. */
  expectedIds?: string[];
  /**
   * Turn ids that must all be in the top 8.
   * Task 08 uses this for the lab-partner intro, which is a required step.
   */
  requiredIds?: string[];
  /** Turn ids that must not rank above the expected hit. */
  distractorIds?: string[];
  /** Scored on `--real` only. `--fake` still replays it. */
  realOnly?: boolean;
  tests?: string;
  setup?: string;
  sessions: RecallSession[];
}

/** Scored tasks. Samples 01 and 02 stay in examples/ and are not listed. */
export const SCORED_TASK_IDS = [
  "03-digikey-part-number",
  "04-knee-squat-swap",
  "05-protein-target-updated",
  "06-forget-debt-to-daniel",
  "07-meal-preference-cilantro",
  "08-lab-partner-meeting",
  "09-cookie-grooming-time",
  "10-capstone-supervisor",
  "11-buried-dog-food",
  "12-dog-weight-distractor",
] as const;

/** Task 06. It always counts in the 10. */
export const FORGET_TASK_ID = "06-forget-debt-to-daniel";

/** Semantic swap. Lexical `--fake` does not score it. */
export const REAL_ONLY_TASK_ID = "04-knee-squat-swap";

/**
 * `forgottenTurnIds()` is #18. Until that method is on the store,
 * task 06 fails with this label. It is not skipped.
 */
export const KNOWN_BLOCKED_REASON =
  "SqliteMemoryStore.forgottenTurnIds() is not in this tree (#18); task 06 counts in the score and is expected to fail";

function stringList(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((item) => typeof item === "string")
  );
}

export function loadTasks(tasksDir: string): RecallTask[] {
  const files = readdirSync(tasksDir)
    .filter((name) => name.endsWith(".json"))
    .sort();
  return files.map((file) => {
    const task = JSON.parse(
      readFileSync(join(tasksDir, file), "utf8"),
    ) as RecallTask;
    if (task.id !== file.replace(/\.json$/, "")) {
      throw new Error(`${file} id is ${task.id}`);
    }
    if ((SCORED_TASK_IDS as readonly string[]).includes(task.id)) {
      if (!stringList(task.expectedIds) || !stringList(task.distractorIds)) {
        throw new Error(`${task.id} needs expectedIds and distractorIds`);
      }
      if (task.requiredIds !== undefined && !stringList(task.requiredIds)) {
        throw new Error(`${task.id} requiredIds must be strings`);
      }
      const issue = listedTurnIssue(task);
      if (issue !== null) {
        throw new Error(issue);
      }
      if ((task.realOnly === true) !== (task.id === REAL_ONLY_TASK_ID)) {
        throw new Error(`${task.id} realOnly is only for ${REAL_ONLY_TASK_ID}`);
      }
    }
    for (const entry of task.accept ?? []) {
      const issue = acceptIssue(
        {
          expectedFact: task.expectedFact,
          question: task.question,
          mustNotContain: task.mustNotContain,
        },
        entry,
      );
      if (issue !== null) {
        throw new Error(`${task.id} accept ${JSON.stringify(entry)} ${issue}`);
      }
    }
    return task;
  });
}

/** Ids `ChatLog` writes. The counter matches replay: user, then assistant. */
export function storedTurns(
  sessions: readonly RecallSession[],
): Array<{ id: string; role: "user" | "assistant"; content: string }> {
  const out: Array<{
    id: string;
    role: "user" | "assistant";
    content: string;
  }> = [];
  for (const session of sessions) {
    let count = 0;
    for (let index = 0; index < session.turns.length; index += 1) {
      const turn = session.turns[index];
      if (turn === undefined || turn.role !== "user") {
        continue;
      }
      const next = session.turns[index + 1];
      count += 1;
      out.push({
        id: `${session.id}-${count}-user`,
        role: "user",
        content: turn.content,
      });
      if (next?.role === "assistant") {
        count += 1;
        index += 1;
        out.push({
          id: `${session.id}-${count}-assistant`,
          role: "assistant",
          content: next.content,
        });
      }
    }
  }
  return out;
}

/** Turn id `ChatLog` writes for a fixture user line. */
export function storedTurnId(
  sessions: readonly RecallSession[],
  userContent: string,
): string | null {
  for (const turn of storedTurns(sessions)) {
    if (turn.role === "user" && turn.content.includes(userContent)) {
      return turn.id;
    }
  }
  return null;
}

/**
 * Why a listed id is wrong, or null.
 * Expected and required turns must carry the fact or an accept entry.
 * A distractor must carry a `mustNotContain` string.
 * Ids are the ones {@link storedTurns} derives.
 */
export function listedTurnIssue(task: RecallTask): string | null {
  const byId = new Map(
    storedTurns(task.sessions).map((turn) => [turn.id, turn.content]),
  );
  const required = task.requiredIds ?? [];
  for (const id of [...(task.expectedIds ?? []), ...required]) {
    const text = byId.get(id);
    if (text === undefined) {
      return `${task.id} ${id} is not a stored turn`;
    }
    const carries =
      textContains(text, task.expectedFact) ||
      (task.accept ?? []).some((entry) => textContains(text, entry));
    if (!carries) {
      return `${task.id} ${id} does not carry the fact`;
    }
  }
  for (const id of task.distractorIds ?? []) {
    const text = byId.get(id);
    if (text === undefined) {
      return `${task.id} ${id} is not a stored turn`;
    }
    const carries = (task.mustNotContain ?? []).some((entry) =>
      textContains(text, entry),
    );
    if (!carries) {
      return `${task.id} ${id} does not carry a mustNotContain string`;
    }
  }
  return null;
}
