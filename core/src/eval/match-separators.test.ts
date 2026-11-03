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

  it("joins a thousands group after a word and keeps clock times", () => {
    expect(
      answerMatches({ expectedFact: "170 g" }, "She eats 1 170 g a day"),
    ).toBe(false);
    expect(answerMatches({ expectedFact: "170 g" }, "about 1\u2009170 g")).toBe(
      false,
    );
    expect(answerMatches({ expectedFact: "170 g" }, "target is 1 170 g.")).toBe(
      false,
    );
    expect(
      answerMatches({ expectedFact: "1 170 g" }, "She eats 1 170 g a day"),
    ).toBe(true);
    expect(answerMatches({ expectedFact: "10:30" }, "Nov 7 10:30")).toBe(true);
    expect(
      answerMatches(
        { expectedFact: "10:30 am" },
        "Saturday, November 7 10:30 am",
      ),
    ).toBe(true);
    expect(
      answerMatches({ expectedFact: "10:30" }, "Saturday, November 7 10:30 am"),
    ).toBe(true);
    expect(
      answerMatches({ expectedFact: "170 g" }, "Day 3 170 g of protein"),
    ).toBe(false);
  });

  it("treats a hyphen as a boundary and a thousands space as 1170", () => {
    expect(answerMatches({ expectedFact: "170 g" }, "-170 g")).toBe(true);
    expect(answerMatches({ expectedFact: "170 g" }, "150-170 g")).toBe(true);
    expect(answerMatches({ expectedFact: "170 g" }, "1170 g")).toBe(false);
    expect(answerMatches({ expectedFact: "1170 g" }, "1 170 g")).toBe(true);
    expect(answerMatches({ expectedFact: "1 170 g" }, "1170 g")).toBe(true);
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
