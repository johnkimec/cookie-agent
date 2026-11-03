import { describe, expect, it } from "vitest";
import { listedTurnIssue, type RecallTask } from "./tasks.ts";

function task(extra: Partial<RecallTask>): RecallTask {
  return {
    id: "08-lab-partner-meeting",
    question: "Where am I meeting Marcus this week?",
    expectedFact: "Bahen",
    sessions: [],
    ...extra,
  };
}

describe("r0633b requiredFacts", () => {
  it("rejects requiredFacts when requiredIds is missing", () => {
    expect(
      listedTurnIssue(
        task({
          requiredFacts: {
            "ses-2026-10-07-2040-popup-1-user": "Marcus Lee",
          },
        }),
      ),
    ).toBe("08-lab-partner-meeting requiredFacts without requiredIds");
  });

  it("rejects requiredFacts when requiredIds is empty", () => {
    expect(
      listedTurnIssue(
        task({
          requiredIds: [],
          requiredFacts: {
            "ses-2026-10-07-2040-popup-1-user": "Marcus Lee",
          },
        }),
      ),
    ).toBe("08-lab-partner-meeting requiredFacts without requiredIds");
  });
});
