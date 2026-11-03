import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync } from "node:fs";
import { mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { TYPE_STRIP_NODE_ARGS } from "./node-launch.ts";
import { protocolErrors } from "./protocol/errors.ts";
import {
  countWords,
  FAKE_MODEL_ID,
  FAKE_REPLY_CHUNKS,
  fakeReplyText,
} from "./protocol/text.ts";
import {
  isCookieMessage,
  isRecord,
  messageErrors,
} from "./protocol/validate.ts";

const coreDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const fakeCore = join(coreDir, "src/fake-core.ts");
const dataDirs: string[] = [];

class CoreClient {
  readonly notes: unknown[] = [];
  private readonly child: ChildProcess;
  private readonly pending: unknown[] = [];
  private readonly waiters: Array<(message: unknown) => void> = [];

  constructor(deltaMs: string, entry = fakeCore) {
    const dataDir = mkdtempSync(join(tmpdir(), "cookie-fake-core-"));
    dataDirs.push(dataDir);
    this.child = spawn(process.execPath, [...TYPE_STRIP_NODE_ARGS, entry], {
      cwd: coreDir,
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        COOKIE_DATA_DIR: dataDir,
        COOKIE_FAKE_DELTA_MS: deltaMs,
        COOKIE_LLAMA_PORT: "18080",
      },
    });
    if (this.child.stdout === null || this.child.stdin === null) {
      throw new Error("stdio was not piped");
    }
    const lines = createInterface({
      input: this.child.stdout,
      crlfDelay: Infinity,
    });
    lines.on("line", (line) => {
      if (line.trim() === "") {
        return;
      }
      const message = JSON.parse(line) as unknown;
      expect(isCookieMessage(message), messageErrors(message)).toBe(true);
      const waiter = this.waiters.shift();
      if (waiter === undefined) {
        this.pending.push(message);
        return;
      }
      waiter(message);
    });
  }

  send(message: unknown): void {
    this.child.stdin?.write(`${JSON.stringify(message)}\n`);
  }

  sendRaw(line: string): void {
    this.child.stdin?.write(`${line}\n`);
  }

  async next(): Promise<unknown> {
    const queued = this.pending.shift();
    if (queued !== undefined) {
      return queued;
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error("timed out waiting for fake core"));
      }, 8000);
      this.waiters.push((message) => {
        clearTimeout(timer);
        resolve(message);
      });
    });
  }

  async response(id: string): Promise<Record<string, unknown>> {
    for (;;) {
      const message = await this.next();
      if (
        isRecord(message) &&
        message.id === id &&
        ("result" in message || "error" in message)
      ) {
        return message;
      }
      this.notes.push(message);
    }
  }

  async exitCode(): Promise<number | null> {
    if (this.child.exitCode !== null || this.child.signalCode !== null) {
      return this.child.exitCode;
    }
    const [code] = (await once(this.child, "exit")) as [number | null];
    return code;
  }

  async close(): Promise<void> {
    if (this.child.exitCode === null && this.child.signalCode === null) {
      this.child.kill("SIGKILL");
      await once(this.child, "exit").catch(() => undefined);
    }
  }
}

const clients: CoreClient[] = [];

afterEach(async () => {
  const open = clients.splice(0);
  await Promise.all(open.map((client) => client.close()));
  await Promise.all(
    dataDirs
      .splice(0)
      .map(async (dir) => rm(dir, { recursive: true, force: true })),
  );
});

function open(deltaMs = "0"): CoreClient {
  const client = new CoreClient(deltaMs);
  clients.push(client);
  return client;
}

function initialize(id = "1"): unknown {
  return {
    jsonrpc: "2.0",
    id,
    method: "initialize",
    params: {
      protocolVersion: "0.1",
      clientInfo: { name: "cookie-test", version: "0.0.0" },
      capabilities: { chatCancel: true },
    },
  };
}

describe("fake core", () => {
  it("streams a reply and shuts down", async () => {
    const client = open();
    client.send(initialize());
    const ready = await client.response("1");
    expect(ready.result).toMatchObject({
      protocolVersion: "0.1",
      serverInfo: { name: "cookie-fake-core" },
      capabilities: {
        chat: { stream: true, cancel: true },
        runtime: { status: true },
      },
    });
    const status = await client.next();
    expect(status).toMatchObject({
      method: "runtime.status",
      params: { state: "up", modelId: FAKE_MODEL_ID },
    });

    client.send({
      jsonrpc: "2.0",
      id: "2",
      method: "chat.send",
      params: { conversationId: "conv-1", text: "hi" },
    });
    const ack = await client.response("2");
    expect(ack.result).toMatchObject({
      conversationId: "conv-1",
      messageId: "msg-1",
    });

    const deltas: string[] = [];
    let done: unknown;
    for (;;) {
      const message = await client.next();
      if (isRecord(message) && message.method === "chat.delta") {
        const params = message.params as { index: number; text: string };
        expect(params.index).toBe(deltas.length);
        deltas.push(params.text);
        continue;
      }
      done = message;
      break;
    }
    expect(deltas).toEqual([...FAKE_REPLY_CHUNKS]);
    expect(done).toMatchObject({
      method: "chat.done",
      params: {
        conversationId: "conv-1",
        messageId: "msg-1",
        finishReason: "stop",
        usage: {
          inputTokens: countWords("hi"),
          outputTokens: countWords(fakeReplyText()),
        },
      },
    });

    client.send({ jsonrpc: "2.0", id: "3", method: "shutdown", params: {} });
    const shutdown = await client.response("3");
    expect(shutdown.result).toEqual({ ok: true });
    expect(await client.exitCode()).toBe(0);
  });

  it("cancels an in-flight reply", async () => {
    const client = open("1000");
    client.send(initialize());
    await client.response("1");
    await client.next();
    client.send({
      jsonrpc: "2.0",
      id: "2",
      method: "chat.send",
      params: { conversationId: "conv-1", text: "cancel please" },
    });
    const ack = await client.response("2");
    const messageId = (ack.result as { messageId: string }).messageId;
    const delta = await client.next();
    expect(delta).toMatchObject({ method: "chat.delta", params: { index: 0 } });
    client.send({
      jsonrpc: "2.0",
      id: "3",
      method: "chat.cancel",
      params: { conversationId: "conv-1", messageId },
    });
    const done = await client.next();
    expect(done).toMatchObject({
      method: "chat.done",
      params: {
        finishReason: "cancelled",
        messageId,
        usage: { outputTokens: countWords(FAKE_REPLY_CHUNKS[0] ?? "") },
      },
    });
    const cancel = await client.response("3");
    expect(cancel.result).toEqual({ cancelled: true });
    client.send({
      jsonrpc: "2.0",
      id: "4",
      method: "chat.cancel",
      params: { conversationId: "conv-1", messageId },
    });
    const again = await client.response("4");
    expect(again.result).toEqual({ cancelled: false });
  });

  it("returns the error table cases", async () => {
    const client = open("1000");
    client.send({
      jsonrpc: "2.0",
      id: "9",
      method: "chat.send",
      params: { conversationId: "conv-1", text: "early" },
    });
    expect(await client.response("9")).toMatchObject({
      error: {
        code: protocolErrors.notInitialized.code,
        message: protocolErrors.notInitialized.message,
      },
    });

    client.send({ jsonrpc: "not-jsonrpc" });
    expect(await client.next()).toMatchObject({
      id: null,
      error: { code: protocolErrors.invalidRequest.code },
    });

    client.sendRaw("{");
    expect(await client.next()).toMatchObject({
      id: null,
      error: {
        code: protocolErrors.parseError.code,
        message: protocolErrors.parseError.message,
      },
    });

    client.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    expect(await client.next()).toMatchObject({
      id: null,
      error: {
        code: protocolErrors.invalidRequest.code,
        data: { reason: "id must be a string" },
      },
    });

    client.send({
      jsonrpc: "2.0",
      id: "1",
      method: "initialize",
      params: {
        protocolVersion: "9.9",
        clientInfo: { name: "cookie-test", version: "0.0.0" },
        capabilities: {},
      },
    });
    expect(await client.response("1")).toMatchObject({
      error: {
        code: protocolErrors.protocolMismatch.code,
        message: protocolErrors.protocolMismatch.message,
      },
    });

    client.send(initialize());
    await client.response("1");
    await client.next();

    client.send(initialize("again"));
    expect(await client.response("again")).toMatchObject({
      error: {
        code: protocolErrors.invalidRequest.code,
        data: { reason: "already initialized" },
      },
    });

    client.send({ jsonrpc: "2.0", id: "2", method: "nope", params: {} });
    expect(await client.response("2")).toMatchObject({
      error: {
        code: protocolErrors.methodNotFound.code,
        data: { method: "nope" },
      },
    });

    client.send({
      jsonrpc: "2.0",
      id: "3",
      method: "chat.send",
      params: { conversationId: "conv-1" },
    });
    expect(await client.response("3")).toMatchObject({
      error: {
        code: protocolErrors.invalidParams.code,
        data: { reason: "params failed schema" },
      },
    });

    client.send({
      jsonrpc: "2.0",
      method: "runtime.status",
      params: { state: "down", modelId: null },
    });
    client.send({
      jsonrpc: "2.0",
      id: "4",
      method: "chat.send",
      params: { conversationId: "conv-1", text: "offline" },
    });
    expect(await client.response("4")).toMatchObject({
      error: {
        code: protocolErrors.runtimeUnavailable.code,
        message: protocolErrors.runtimeUnavailable.message,
      },
    });

    client.send({
      jsonrpc: "2.0",
      method: "runtime.status",
      params: { state: "up", modelId: FAKE_MODEL_ID },
    });
    client.send({
      jsonrpc: "2.0",
      id: "5",
      method: "chat.send",
      params: { conversationId: "conv-1", text: "one" },
    });
    await client.response("5");
    expect(await client.next()).toMatchObject({
      method: "chat.delta",
      params: { index: 0 },
    });
    client.send({
      jsonrpc: "2.0",
      id: "6",
      method: "chat.send",
      params: { conversationId: "conv-1", text: "two" },
    });
    expect(await client.response("6")).toMatchObject({
      error: {
        code: protocolErrors.chatInProgress.code,
        message: protocolErrors.chatInProgress.message,
      },
    });

    client.send({ jsonrpc: "2.0", id: "7", method: "shutdown", params: {} });
    const done = await client.next();
    expect(done).toMatchObject({
      method: "chat.done",
      params: { finishReason: "cancelled" },
    });
    expect(await client.response("7")).toMatchObject({ result: { ok: true } });
  });

  it("starts through a symlinked path", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cookie-fake-link-"));
    const link = join(dir, "fake-core.ts");
    await symlink(fakeCore, link);
    const client = new CoreClient("0", link);
    clients.push(client);
    try {
      client.send(initialize());
      const ready = await client.response("1");
      expect(ready.result).toMatchObject({
        serverInfo: { name: "cookie-fake-core" },
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
