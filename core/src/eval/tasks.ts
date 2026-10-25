import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { acceptIssue } from "./match.ts";

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
