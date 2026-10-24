import { expect, it } from "vitest";
import { main } from "./index.js";

it("exits the skeleton entrypoint cleanly", () => {
  expect(main()).toBe(0);
});
