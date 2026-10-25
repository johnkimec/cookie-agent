import { describe, expect, it } from "vitest";
import { answerMatches } from "./match.ts";

describe("recall answer match", () => {
  it("accepts a case and whitespace variant, and an alternate", () => {
    expect(
      answerMatches({ expectedFact: "170 g" }, "Daily target is 170   G now."),
    ).toBe(true);
    expect(
      answerMatches({ expectedFact: "170 g", accept: ["170g"] }, "It is 170g."),
    ).toBe(true);
  });

  it("fails when a forbidden string appears, even if the fact is present", () => {
    expect(
      answerMatches(
        { expectedFact: "Priya", mustNotContain: ["$40", "Raptors"] },
        "Priya has the probes and you owe Daniel $40.",
      ),
    ).toBe(false);
    expect(
      answerMatches(
        { expectedFact: "Priya", mustNotContain: ["Raptors"] },
        "Priya has your probes.",
      ),
    ).toBe(true);
  });

  it("fails when nothing accepted appears", () => {
    expect(answerMatches({ expectedFact: "Kovacs" }, "Jordan Park")).toBe(
      false,
    );
  });
});
