import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync } from "node:fs";
import { mkdtemp, rm, symlink } from "node:fs/promises";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { afterEach, describe, expect, it } from "vitest";
import { defaultMemoryDataDir, MEMORY_DB_FILENAME } from "./memory/path.ts";
import { SqliteMemoryStore } from "./memory/sqlite-store.ts";
import { TYPE_STRIP_NODE_ARGS } from "./node-launch.ts";
import { protocolErrors } from "./protocol/errors.ts";
import {
  isCookieMessage,
  isRecord,
  messageErrors,
} from "./protocol/validate.ts";

const entry = new URL("./index.ts", import.meta.url);
const children: ChildProcess[] = [];
const dataDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    children.splice(0).map(async (child) => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
        await once(child, "exit").catch(() => undefined);
      }
    }),
  );
  await Promise.all(
    dataDirs
      .splice(0)
      .map(async (dir) => rm(dir, { recursive: true, force: true })),
  );
});

function isolated(extra: NodeJS.ProcessEnv = {}): {
  env: NodeJS.ProcessEnv;
  dataDir: string;
} {
  const dataDir = mkdtempSync(join(tmpdir(), "cookie-stdio-"));
  dataDirs.push(dataDir);
  return { env: { ...extra, COOKIE_DATA_DIR: dataDir }, dataDir };
}

class StdioClient {
  readonly messages: unknown[] = [];
  private readonly child: ChildProcess;
  private readonly pending: unknown[] = [];
  private readonly waiters: Array<(message: unknown) => void> = [];
  private readonly stderrChunks: Buffer[] = [];
  private stderrEnded = false;
  private readonly stderrWaiters: Array<() => void> = [];

  constructor(env: NodeJS.ProcessEnv, entryPath = entry.pathname) {
    this.child = spawn(process.execPath, [...TYPE_STRIP_NODE_ARGS, entryPath], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...env },
    });
    children.push(this.child);
    if (
      this.child.stdout === null ||
      this.child.stdin === null ||
      this.child.stderr === null
    ) {
      throw new Error("stdio was not piped");
    }
    this.child.stderr.on("data", (chunk: Buffer) => {
      this.stderrChunks.push(chunk);
    });
    this.child.stderr.on("end", () => {
      this.stderrEnded = true;
      const pending = this.stderrWaiters.splice(0);
      for (const waiter of pending) {
        waiter();
      }
    });
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

  async stderrText(): Promise<string> {
    if (!this.stderrEnded) {
      await new Promise<void>((resolve) => {
        this.stderrWaiters.push(resolve);
      });
    }
    return Buffer.concat(this.stderrChunks).toString("utf8");
  }

  async next(): Promise<unknown> {
    const queued = this.pending.shift();
    if (queued !== undefined) {
      return queued;
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error("timed out waiting for core"));
      }, 4000);
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
      this.messages.push(message);
    }
  }

  async exitCode(): Promise<number | null> {
    if (this.child.exitCode !== null || this.child.signalCode !== null) {
      return this.child.exitCode;
    }
    const [code] = (await once(this.child, "exit")) as [number | null];
    return code;
  }
}

describe("stdio core", () => {
  it("reports down and returns runtime unavailable when llama-server is closed", async () => {
    const port = await closedPort();
    const dataDir = await mkdtemp(join(tmpdir(), "cookie-stdio-"));
    try {
      const client = new StdioClient({
        COOKIE_LLAMA_PORT: String(port),
        COOKIE_DATA_DIR: dataDir,
      });
      const started = Date.now();
      client.send({
        jsonrpc: "2.0",
        id: "1",
        method: "initialize",
        params: {
          protocolVersion: "0.1",
          clientInfo: { name: "cookie-test", version: "0.0.0" },
          capabilities: {},
        },
      });
      const ready = await client.response("1");
      expect(ready.result).toMatchObject({
        protocolVersion: "0.1",
        serverInfo: { name: "cookie-core", version: "0.0.0" },
      });
      const status = client.messages[0] ?? (await client.next());
      expect(status).toMatchObject({
        method: "runtime.status",
        params: { state: "down", modelId: null },
      });
      client.send({
        jsonrpc: "2.0",
        id: "2",
        method: "chat.send",
        params: { conversationId: "conv-1", text: "hello" },
      });
      const error = await client.response("2");
      expect(Date.now() - started).toBeLessThan(2000);
      expect(error.error).toMatchObject({
        code: protocolErrors.runtimeUnavailable.code,
        message: protocolErrors.runtimeUnavailable.message,
      });
      expect(client.messages.every((message) => isCookieMessage(message))).toBe(
        true,
      );
      expect(existsSync(join(dataDir, "cookie.db"))).toBe(true);
      client.send({ jsonrpc: "2.0", id: "3", method: "shutdown", params: {} });
      const shutdown = await client.response("3");
      expect(shutdown.result).toMatchObject({ ok: true });
      expect(await client.exitCode()).toBe(0);
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it("exits on a bad COOKIE_LLAMA_PORT without speaking protocol", async () => {
    const client = new StdioClient(isolated({ COOKIE_LLAMA_PORT: "nope" }).env);
    expect(await client.exitCode()).toBe(1);
    const stderr = await client.stderrText();
    expect(stderr).toContain("COOKIE_LLAMA_PORT");
  });

  it("exits on a bad COOKIE_EMBED_PORT without speaking protocol", async () => {
    const client = new StdioClient(isolated({ COOKIE_EMBED_PORT: "nope" }).env);
    expect(await client.exitCode()).toBe(1);
    const stderr = await client.stderrText();
    expect(stderr).toContain("COOKIE_EMBED_PORT");
  });

  it("exits on a bad COOKIE_RRF_VECTOR without speaking protocol", async () => {
    const client = new StdioClient(isolated({ COOKIE_RRF_VECTOR: "nope" }).env);
    expect(await client.exitCode()).toBe(1);
    const stderr = await client.stderrText();
    expect(stderr).toContain("COOKIE_RRF_VECTOR");
  });

  it("exits on a bad COOKIE_EMBED_TIMEOUT_MS without speaking protocol", async () => {
    const { env, dataDir } = isolated({ COOKIE_EMBED_TIMEOUT_MS: "nope" });
    const client = new StdioClient(env);
    expect(await client.exitCode()).toBe(1);
    const stderr = await client.stderrText();
    expect(stderr).toContain("COOKIE_EMBED_TIMEOUT_MS");
    expect(existsSync(join(dataDir, "cookie.db"))).toBe(false);
  });

  it("exits on a bad query or index embed timeout without speaking protocol", async () => {
    const query = isolated({ COOKIE_EMBED_QUERY_TIMEOUT_MS: "nope" });
    const queryClient = new StdioClient(query.env);
    expect(await queryClient.exitCode()).toBe(1);
    expect(await queryClient.stderrText()).toContain(
      "COOKIE_EMBED_QUERY_TIMEOUT_MS",
    );
    expect(existsSync(join(query.dataDir, "cookie.db"))).toBe(false);
    const index = isolated({ COOKIE_EMBED_INDEX_TIMEOUT_MS: "nope" });
    const indexClient = new StdioClient(index.env);
    expect(await indexClient.exitCode()).toBe(1);
    expect(await indexClient.stderrText()).toContain(
      "COOKIE_EMBED_INDEX_TIMEOUT_MS",
    );
    expect(existsSync(join(index.dataDir, "cookie.db"))).toBe(false);
  });

  it("aborts the rerank request when chat.cancel arrives during rerank", async () => {
    const llama = await hangRerankServer();
    const embedPort = await closedPort();
    const dataDir = await mkdtemp(join(tmpdir(), "cookie-stdio-rerank-"));
    try {
      const store = SqliteMemoryStore.open(join(dataDir, "cookie.db"));
      store.appendSession({
        id: "old",
        surface: "popup",
        startedAt: 1,
        endedAt: null,
        summary: null,
      });
      store.appendTurn(seedTurn("t1", "picnic alpha", 1));
      store.appendTurn(seedTurn("t2", "picnic beta", 2));
      store.close();
      const client = new StdioClient({
        COOKIE_LLAMA_PORT: String(llama.port),
        COOKIE_EMBED_PORT: String(embedPort),
        COOKIE_DATA_DIR: dataDir,
        COOKIE_RERANK: "1",
        COOKIE_RERANK_TIMEOUT_MS: "5000",
      });
      client.send({
        jsonrpc: "2.0",
        id: "1",
        method: "initialize",
        params: {
          protocolVersion: "0.1",
          clientInfo: { name: "cookie-test", version: "0.0.0" },
          capabilities: {},
        },
      });
      await client.response("1");
      const status =
        client.messages.find(isRuntimeStatus) ?? (await client.next());
      expect(status).toMatchObject({
        method: "runtime.status",
        params: { state: "up" },
      });
      client.send({
        jsonrpc: "2.0",
        id: "2",
        method: "chat.send",
        params: { conversationId: "ask", text: "picnic" },
      });
      const ack = await client.response("2");
      const result = ack.result;
      const messageId =
        isRecord(result) && typeof result.messageId === "string"
          ? result.messageId
          : "";
      expect(messageId).toMatch(/^msg-/);
      await llama.untilRerank();
      client.send({
        jsonrpc: "2.0",
        id: "3",
        method: "chat.cancel",
        params: { conversationId: "ask", messageId },
      });
      await llama.untilAborted();
      expect(llama.rerankCount).toBe(1);
      expect(llama.otherChats).toBe(0);
      const cancel = await client.response("3");
      expect(cancel.result).toMatchObject({ cancelled: true });
      const done = await nextDone(client);
      expect(done).toMatchObject({
        method: "chat.done",
        params: { finishReason: "cancelled", messageId },
      });
      client.send({ jsonrpc: "2.0", id: "4", method: "shutdown", params: {} });
      expect((await client.response("4")).result).toMatchObject({ ok: true });
      expect(await client.exitCode()).toBe(0);
    } finally {
      await llama.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it("exits on a bad COOKIE_RERANK without speaking protocol", async () => {
    const client = new StdioClient(isolated({ COOKIE_RERANK: "yes" }).env);
    expect(await client.exitCode()).toBe(1);
    const stderr = await client.stderrText();
    expect(stderr).toContain("COOKIE_RERANK");
  });

  it("exits on a bad COOKIE_THINKING without speaking protocol", async () => {
    const client = new StdioClient(isolated({ COOKIE_THINKING: "yes" }).env);
    expect(await client.exitCode()).toBe(1);
    const stderr = await client.stderrText();
    expect(stderr).toContain("COOKIE_THINKING");
  });

  it("refuses the default data directory under test", async () => {
    const db = join(defaultMemoryDataDir(), MEMORY_DB_FILENAME);
    const before = existsSync(db);
    const client = new StdioClient({
      VITEST: "true",
      NODE_ENV: "test",
      COOKIE_LLAMA_PORT: "9",
      COOKIE_DATA_DIR: "",
    });
    expect(await client.exitCode()).toBe(1);
    const stderr = await client.stderrText();
    expect(stderr).toContain("refusing to open the default data directory");
    expect(stderr).toContain("COOKIE_DATA_DIR");
    expect(existsSync(db)).toBe(before);
  });

  it("starts through a symlinked path", async () => {
    const port = await closedPort();
    const dataDir = await mkdtemp(join(tmpdir(), "cookie-stdio-"));
    const linkDir = await mkdtemp(join(tmpdir(), "cookie-index-link-"));
    const link = join(linkDir, "index.ts");
    await symlink(entry.pathname, link);
    try {
      const client = new StdioClient(
        {
          COOKIE_LLAMA_PORT: String(port),
          COOKIE_DATA_DIR: dataDir,
        },
        link,
      );
      client.send({
        jsonrpc: "2.0",
        id: "1",
        method: "initialize",
        params: {
          protocolVersion: "0.1",
          clientInfo: { name: "cookie-test", version: "0.0.0" },
          capabilities: {},
        },
      });
      const ready = await client.response("1");
      expect(ready.result).toMatchObject({
        serverInfo: { name: "cookie-core", version: "0.0.0" },
      });
    } finally {
      await rm(dataDir, { recursive: true, force: true });
      await rm(linkDir, { recursive: true, force: true });
    }
  });
});

function isRuntimeStatus(message: unknown): boolean {
  return isRecord(message) && message.method === "runtime.status";
}

function isChatDone(message: unknown): boolean {
  return isRecord(message) && message.method === "chat.done";
}

async function nextDone(client: StdioClient): Promise<unknown> {
  const queued = client.messages.find(isChatDone);
  if (queued !== undefined) {
    return queued;
  }
  for (;;) {
    const message = await client.next();
    if (isChatDone(message)) {
      return message;
    }
  }
}

function seedTurn(id: string, content: string, createdAt: number) {
  return {
    id,
    sessionId: "old",
    role: "user" as const,
    content,
    tainted: false,
    model: null,
    egress: false,
    escalatedFrom: null,
    tokensIn: null,
    tokensCached: null,
    tokensOut: null,
    costUsd: null,
    latencyMs: null,
    createdAt,
  };
}

function hangRerankServer(): Promise<{
  port: number;
  rerankCount: number;
  otherChats: number;
  untilRerank: () => Promise<void>;
  untilAborted: () => Promise<void>;
  close: () => Promise<void>;
}> {
  const reranks: Array<{ aborted: boolean }> = [];
  let otherChats = 0;
  const sockets = new Set<Socket>();
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      handleLlama(req, res, reranks, () => {
        otherChats += 1;
      });
    });
    server.on("connection", (socket) => {
      sockets.add(socket);
      socket.on("close", () => {
        sockets.delete(socket);
      });
    });
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("rerank stub has no port"));
        return;
      }
      const state = {
        port: address.port,
        get rerankCount() {
          return reranks.length;
        },
        get otherChats() {
          return otherChats;
        },
        untilRerank: () => poll(() => reranks.length > 0, "rerank request"),
        untilAborted: () =>
          poll(() => reranks.some((row) => row.aborted), "rerank abort"),
        close: () =>
          new Promise<void>((done) => {
            for (const socket of sockets) {
              socket.destroy();
            }
            server.close(() => done());
          }),
      };
      resolve(state);
    });
  });
}

function handleLlama(
  req: IncomingMessage,
  res: ServerResponse,
  reranks: Array<{ aborted: boolean }>,
  countOther: () => void,
): void {
  const url = req.url ?? "";
  if (url.startsWith("/health")) {
    res.writeHead(200, { "content-type": "application/json" });
    res.end('{"status":"ok"}');
    return;
  }
  if (url.startsWith("/v1/models")) {
    res.writeHead(200, { "content-type": "application/json" });
    res.end('{"data":[]}');
    return;
  }
  const chunks: Buffer[] = [];
  req.on("data", (chunk: Buffer) => {
    chunks.push(chunk);
  });
  req.on("end", () => {
    const body = Buffer.concat(chunks).toString("utf8");
    if (!body.includes("Choose the memories")) {
      countOther();
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(
        'data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
      );
      return;
    }
    const record = { aborted: false };
    reranks.push(record);
    req.on("close", () => {
      record.aborted = true;
    });
  });
}

function poll(ready: () => boolean, label: string): Promise<void> {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const timer = setInterval(() => {
      if (ready()) {
        clearInterval(timer);
        resolve();
        return;
      }
      if (Date.now() - started > 4000) {
        clearInterval(timer);
        reject(new Error(`timed out waiting for ${label}`));
      }
    }, 20);
  });
}

async function closedPort(): Promise<number> {
  const server = createServer();
  const port = await new Promise<number>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("did not bind"));
        return;
      }
      resolve((address as AddressInfo).port);
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error !== undefined) {
        reject(error);
        return;
      }
      resolve();
    });
  });
  return port;
}
