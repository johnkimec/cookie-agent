import { describe, expect, it } from "vitest";
import { answerMatches } from "./match.ts";

describe("match boundaries", () => {
  it("does not match across a comma or dot between digits", () => {
    expect(answerMatches({ expectedFact: "170 g" }, "1,170 g")).toBe(false);
    expect(answerMatches({ expectedFact: "170 g" }, "1.170 g")).toBe(false);
    expect(answerMatches({ expectedFact: "2 kg" }, "4.2 kg")).toBe(false);
    expect(answerMatches({ expectedFact: "5 kg" }, "0.5 kg")).toBe(false);
    expect(
      answerMatches(
        { expectedFact: "protein", mustNotContain: ["170 g"] },
        "It was 1,170 g of protein.",
      ),
    ).toBe(true);
  });

  it("still treats sentence punctuation as a boundary", () => {
    expect(
      answerMatches({ expectedFact: "170 g" }, "The target is 170 g."),
    ).toBe(true);
    expect(answerMatches({ expectedFact: "170 g" }, "170 g, then rest.")).toBe(
      true,
    );
    expect(answerMatches({ expectedFact: "4.2 kg" }, "Cookie is 4.2 kg.")).toBe(
      true,
    );
    expect(answerMatches({ expectedFact: "1,170 g" }, "Lifted 1,170 g.")).toBe(
      true,
    );
  });
});
