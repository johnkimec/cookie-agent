import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

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

/**
 * Forget is not implemented until #18. The task still runs and still
 * counts in the 10. A fail here is expected and labeled, not skipped.
 */
export const KNOWN_BLOCKED_REASON =
  "memory.forget is #18 and is not in this tree; this task counts in the 10 and is expected to fail";

export function isKnownBlocked(id: string): boolean {
  return id === "06-forget-debt-to-daniel";
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
    return task;
  });
}
