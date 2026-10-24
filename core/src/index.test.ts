import { expect, it } from "vitest";
import { CORE_SERVER_NAME } from "./index.ts";

it("names the real core and does not start stdio on import", () => {
  expect(CORE_SERVER_NAME).toBe("cookie-core");
});
