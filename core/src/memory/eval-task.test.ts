import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Ajv } from "ajv";
import { describe, expect, it } from "vitest";

const evalDir = join(
  fileURLToPath(new URL(".", import.meta.url)),
  "../../../evals/memory-recall",
);

describe("memory recall eval tasks", () => {
  it("validates every sample task against the schema", () => {
    const schema = JSON.parse(
      readFileSync(join(evalDir, "task.schema.json"), "utf8"),
    ) as Record<string, unknown>;
    const ajv = new Ajv({ allErrors: true, strict: true });
    const validate = ajv.compile(schema);
    const tasksDir = join(evalDir, "tasks");
    const files = readdirSync(tasksDir)
      .filter((name) => name.endsWith(".json"))
      .sort();
    expect(files.length).toBeGreaterThanOrEqual(2);
    expect(files).toEqual(["01-ece-midterm.json", "02-office-hours.json"]);

    for (const file of files) {
      const task = JSON.parse(readFileSync(join(tasksDir, file), "utf8")) as {
        id: string;
        sessions: unknown[];
      };
      const valid = validate(task);
      expect(validate.errors ?? []).toEqual([]);
      expect(valid).toBe(true);
      expect(task.id).toBe(file.replace(/\.json$/, ""));
      expect(task.sessions.length).toBeGreaterThanOrEqual(2);
    }
  });
});
