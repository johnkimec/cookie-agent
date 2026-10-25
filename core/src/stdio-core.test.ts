import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { mkdtemp, rm, symlink } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { afterEach, describe, expect, it } from "vitest";
import { TYPE_STRIP_NODE_ARGS } from "./node-launch.ts";
import { protocolErrors } from "./protocol/errors.ts";
import {
  isCookieMessage,
  isRecord,
  messageErrors,
} from "./protocol/validate.ts";

const entry = new URL("./index.ts", import.meta.url);
const children: ChildProcess[] = [];

afterEach(async () => {
  await Promise.all(
    children.splice(0).map(async (child) => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
        await once(child, "exit").catch(() => undefined);
      }
    }),
  );
});

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
    const client = new StdioClient({ COOKIE_LLAMA_PORT: "nope" });
    expect(await client.exitCode()).toBe(1);
    const stderr = await client.stderrText();
    expect(stderr).toContain("COOKIE_LLAMA_PORT");
  });

  it("exits on a bad COOKIE_THINKING without speaking protocol", async () => {
    const client = new StdioClient({ COOKIE_THINKING: "yes" });
    expect(await client.exitCode()).toBe(1);
    const stderr = await client.stderrText();
    expect(stderr).toContain("COOKIE_THINKING");
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
