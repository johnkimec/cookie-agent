import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SqliteMemoryStore } from "../memory/sqlite-store.ts";
import { forgottenProbeFor } from "./runner.ts";
import { FORGET_TASK_ID } from "./tasks.ts";

const dirs: string[] = [];

const proto = SqliteMemoryStore.prototype as {
  forgottenTurnIds?: () => unknown;
};
const originalForgottenTurnIds = Object.getOwnPropertyDescriptor(
  proto,
  "forgottenTurnIds",
);

function restoreForgottenTurnIds(): void {
  if (originalForgottenTurnIds === undefined) {
    delete proto.forgottenTurnIds;
    return;
  }
  Object.defineProperty(proto, "forgottenTurnIds", originalForgottenTurnIds);
}

afterEach(() => {
  restoreForgottenTurnIds();
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("recall probe", () => {
  it("treats a corrupt cookie.db as an error, not known-blocked", () => {
    const dir = mkdtempSync(join(tmpdir(), "cookie-probe-corrupt-"));
    dirs.push(dir);
    writeFileSync(join(dir, "cookie.db"), "this is not a sqlite database");
    expect(() => forgottenProbeFor(FORGET_TASK_ID, dir)).toThrow(
      /forgotten probe failed/,
    );
  });

  it("treats a non-array forgottenTurnIds result as an error", () => {
    const dir = mkdtempSync(join(tmpdir(), "cookie-probe-array-"));
    dirs.push(dir);
    const store = SqliteMemoryStore.open(join(dir, "cookie.db"));
    store.close();
    proto.forgottenTurnIds = () => "nope";
    expect(() => forgottenProbeFor(FORGET_TASK_ID, dir)).toThrow(
      /forgotten probe failed: forgottenTurnIds\(\) did not return an array/,
    );
  });

  it("stays known-blocked when the method is missing", () => {
    const dir = mkdtempSync(join(tmpdir(), "cookie-probe-missing-"));
    dirs.push(dir);
    const store = SqliteMemoryStore.open(join(dir, "cookie.db"));
    store.close();
    delete (SqliteMemoryStore.prototype as { forgottenTurnIds?: () => unknown })
      .forgottenTurnIds;
    expect(forgottenProbeFor(FORGET_TASK_ID, dir)).toBeNull();
  });
});
