import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { protocolErrors } from "./errors.ts";
import { isCookieMessage, messageErrors, paramsAreValid } from "./validate.ts";

const examplesDir = join(
  fileURLToPath(new URL(".", import.meta.url)),
  "../../../protocol/examples",
);

function loadJson(name: string): unknown {
  return JSON.parse(readFileSync(join(examplesDir, name), "utf8")) as unknown;
}

describe("protocol golden messages", () => {
  const files = readdirSync(examplesDir)
    .filter((name) => name.endsWith(".json"))
    .sort();

  it("has a golden file for every M0 message kind", () => {
    expect(files).toEqual([
      "chat.cancel.request.json",
      "chat.cancel.result.false.json",
      "chat.cancel.result.true.json",
      "chat.delta.json",
      "chat.done.cancelled.json",
      "chat.done.error.json",
      "chat.done.length.json",
      "chat.done.stop.json",
      "chat.send.request.json",
      "chat.send.result.json",
      "error.chat_in_progress.json",
      "error.internal.json",
      "error.invalid_params.json",
      "error.invalid_request.json",
      "error.method_not_found.json",
      "error.not_initialized.json",
      "error.parse.json",
      "error.protocol.json",
      "error.runtime_unavailable.json",
      "error.shutting_down.json",
      "initialize.request.json",
      "initialize.result.json",
      "runtime.status.notification.down-omit.json",
      "runtime.status.notification.down.json",
      "runtime.status.notification.loading.json",
      "runtime.status.notification.up.json",
      "runtime.status.request.json",
      "runtime.status.result.json",
      "shutdown.request.json",
      "shutdown.result.json",
    ]);
  });

  it.each(files)("%s matches the schema", (name) => {
    const message = loadJson(name);
    expect(isCookieMessage(message), messageErrors(message)).toBe(true);
  });

  it("accepts the golden wire session in order", () => {
    const lines = readFileSync(join(examplesDir, "session.jsonl"), "utf8")
      .split("\n")
      .filter((line) => line.trim() !== "");
    const kinds = lines.map((line) => {
      const message = JSON.parse(line) as {
        method?: string;
        result?: unknown;
        error?: unknown;
      };
      expect(isCookieMessage(message), messageErrors(message)).toBe(true);
      if (typeof message.method === "string") {
        return message.method;
      }
      if (message.result !== undefined) {
        return "result";
      }
      return "error";
    });
    expect(kinds).toEqual([
      "initialize",
      "result",
      "runtime.status",
      "chat.send",
      "result",
      "chat.delta",
      "chat.delta",
      "chat.delta",
      "chat.done",
      "shutdown",
      "result",
    ]);
  });
});

describe("protocol schema boundaries", () => {
  it("rejects a numeric request id", () => {
    const message = {
      jsonrpc: "2.0",
      id: 1,
      method: "shutdown",
      params: {},
    };
    expect(isCookieMessage(message)).toBe(false);
  });

  it("rejects unknown fields", () => {
    const message = loadJson("shutdown.request.json") as Record<
      string,
      unknown
    >;
    expect(isCookieMessage({ ...message, extra: true })).toBe(false);
  });

  it("accepts a well-formed unsupported protocol version as params", () => {
    expect(
      paramsAreValid("initializeParams", {
        protocolVersion: "9.9",
        clientInfo: { name: "cookie-shell", version: "0.0.0" },
        capabilities: {},
      }),
    ).toBe(true);
  });

  it("rejects an up runtime with no model id", () => {
    expect(paramsAreValid("runtimeStatusParams", { state: "up" })).toBe(false);
    expect(
      paramsAreValid("runtimeStatusParams", { state: "up", modelId: null }),
    ).toBe(false);
  });

  it("accepts a down runtime with the model id omitted or null", () => {
    expect(paramsAreValid("runtimeStatusParams", { state: "down" })).toBe(true);
    expect(
      paramsAreValid("runtimeStatusParams", { state: "down", modelId: null }),
    ).toBe(true);
  });

  it("accepts every standard error code with its message", () => {
    for (const body of Object.values(protocolErrors)) {
      const message = { jsonrpc: "2.0", id: "1", error: body };
      expect(isCookieMessage(message), messageErrors(message)).toBe(true);
    }
    const parseError = {
      jsonrpc: "2.0",
      id: null,
      error: protocolErrors.parseError,
    };
    expect(isCookieMessage(parseError), messageErrors(parseError)).toBe(true);
  });
});
