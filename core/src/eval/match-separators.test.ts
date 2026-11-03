import { describe, expect, it } from "vitest";
import { answerMatches } from "./match.ts";

describe("match separators", () => {
  it("does not match a digit needle after a dot or comma", () => {
    expect(answerMatches({ expectedFact: "5 kg" }, ".5 kg")).toBe(false);
    expect(answerMatches({ expectedFact: "5 kg" }, "0.5 kg")).toBe(false);
    expect(answerMatches({ expectedFact: "5 kg" }, ",5 kg")).toBe(false);
  });

  it("treats a space or thin space between digits as a thousands separator", () => {
    expect(answerMatches({ expectedFact: "170 g" }, "1 170 g")).toBe(false);
    expect(answerMatches({ expectedFact: "170 g" }, "1\u2009170 g")).toBe(
      false,
    );
    expect(answerMatches({ expectedFact: "170 g" }, "1\u202f170 g")).toBe(
      false,
    );
    expect(answerMatches({ expectedFact: "170 g" }, "1\u00a0170 g")).toBe(
      false,
    );
  });

  it("still matches a plain amount and a sentence-final period", () => {
    expect(answerMatches({ expectedFact: "170 g" }, "170 g")).toBe(true);
    expect(
      answerMatches({ expectedFact: "170 g" }, "The target is 170 g."),
    ).toBe(true);
    expect(answerMatches({ expectedFact: "5 kg" }, "She lifted 5 kg.")).toBe(
      true,
    );
  });
});
