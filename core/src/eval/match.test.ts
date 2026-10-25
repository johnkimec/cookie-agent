import { describe, expect, it } from "vitest";
import { acceptIssue, answerMatches } from "./match.ts";

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

  it("treats a number and its unit as the same with or without a space", () => {
    expect(
      answerMatches({ expectedFact: "170 g" }, "Daily target is 170g."),
    ).toBe(true);
    expect(
      answerMatches(
        { expectedFact: "170 g", mustNotContain: ["150 g"] },
        "It is 170g, down from 150g.",
      ),
    ).toBe(false);
    expect(
      answerMatches(
        { expectedFact: "4.2 kg", mustNotContain: ["5.1 kg"] },
        "Cookie weighs 4.2kg.",
      ),
    ).toBe(true);
    expect(
      answerMatches(
        { expectedFact: "box squats", accept: ["box squat"] },
        "Switched to a box squat.",
      ),
    ).toBe(true);
    expect(answerMatches({ expectedFact: "170 g" }, "It is 1170 g.")).toBe(
      false,
    );
    expect(
      answerMatches(
        { expectedFact: "Priya", mustNotContain: ["170 g"] },
        "Priya lifted 1170 g.",
      ),
    ).toBe(true);
    expect(
      answerMatches(
        { expectedFact: "Priya", mustNotContain: ["170 g"] },
        "Priya lifted 170 g.",
      ),
    ).toBe(false);
  });

  it("rejects an accept entry that is too weak or already in the question", () => {
    const check = {
      expectedFact: "170 g",
      question: "What's my daily protein target right now?",
      mustNotContain: ["150 g"],
    };
    expect(acceptIssue(check, "170g")).toBeNull();
    expect(acceptIssue(check, "ab")).toMatch(/3 characters/);
    expect(acceptIssue(check, "xyz")).toMatch(/digit or a word/);
    expect(
      acceptIssue({ ...check, question: "Did I say 170g today?" }, "170g"),
    ).toMatch(/question/);
    expect(acceptIssue(check, "150g")).toMatch(/mustNotContain/);
    expect(acceptIssue(check, "box squat")).toBeNull();
  });
});
