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

/**
 * `forgottenTurnIds()` is #18. Until that method is on the store,
 * task 06 fails with this label. It is not skipped.
 */
export const KNOWN_BLOCKED_REASON =
  "SqliteMemoryStore.forgottenTurnIds() is not in this tree (#18); task 06 counts in the 10 and is expected to fail";

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
