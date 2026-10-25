/**
 * OpenAI-compatible stand-in for llama-server.
 * drive-core --core real points the real core at this. Tests may use it too.
 * It is not a model and it does not bind port 8080 unless asked.
 */

import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";

export const STUB_REPLY_CHUNKS = [
  "Hello. ",
  "This reply is from the local stub, ",
  "on device.",
] as const;

export const STUB_INPUT_TOKENS = 20;
export const STUB_OUTPUT_TOKENS = 11;

/** User text that makes the stub pause between chunks so chat.cancel can land. */
export const STUB_SLOW_USER_TEXT = "cancel this reply";

const SLOW_GAP_MS = 800;

export interface StubChatRequest {
  model: string;
  messages: unknown;
  body: Record<string, unknown>;
  aborted: boolean;
}

export interface LlamaStubOptions {
  /**
   * When set, each completion is one chunk. If an earlier message contains
   * this word and the latest user text does not, the chunk is the word.
   * Otherwise the chunk is `remembered`.
   */
  recallWord?: string;
}

export interface LlamaStub {
  port: number;
  healthHits: number;
  chats: StubChatRequest[];
  close: () => Promise<void>;
  /** Destroy sockets and stop listening. `resume` binds the same port. */
  kill: () => Promise<void>;
  resume: () => Promise<void>;
  /** `loading` is HTTP 503. `up` is HTTP 200. Call this before `resume`. */
  setHealth: (state: "up" | "loading") => void;
  /** After the first content chunk, wait until the socket closes. */
  holdAfterFirstChunk: (hold: boolean) => void;
}

interface StubControl {
  healthStatus: number;
  healthBody: unknown;
  holdAfterFirst: boolean;
}

export function startLlamaStub(
  port = 0,
  options: LlamaStubOptions = {},
): Promise<LlamaStub> {
  const chats: StubChatRequest[] = [];
  let healthHits = 0;
  let boundPort = port;
  const control: StubControl = {
    healthStatus: 200,
    healthBody: { status: "ok" },
    holdAfterFirst: false,
  };
  const server = createServer((request, response) => {
    void handle(request, response, chats, control, options, () => {
      healthHits += 1;
    }).catch((error: unknown) => {
      const detail = error instanceof Error ? error.message : "stub failed";
      if (!response.headersSent) {
        response.writeHead(500, { "content-type": "text/plain" });
      }
      response.end(detail);
    });
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("llama stub did not bind"));
        return;
      }
      boundPort = (address as AddressInfo).port;
      resolve({
        get port() {
          return boundPort;
        },
        get healthHits() {
          return healthHits;
        },
        chats,
        close: () => shutdownServer(server),
        kill: () => shutdownServer(server),
        resume: () => listenAgain(server, boundPort),
        setHealth: (state) => {
          if (state === "loading") {
            control.healthStatus = 503;
            control.healthBody = { status: "loading" };
            return;
          }
          control.healthStatus = 200;
          control.healthBody = { status: "ok" };
        },
        holdAfterFirstChunk: (hold) => {
          control.holdAfterFirst = hold;
        },
      });
    });
  });
}

function shutdownServer(server: Server): Promise<void> {
  server.closeAllConnections();
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (
        error !== undefined &&
        (error as NodeJS.ErrnoException).code !== "ERR_SERVER_NOT_RUNNING"
      ) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

function listenAgain(server: Server, port: number): Promise<void> {
  if (server.listening) {
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    const onError = (error: Error): void => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = (): void => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, "127.0.0.1");
  });
}

async function handle(
  request: IncomingMessage,
  response: ServerResponse,
  chats: StubChatRequest[],
  control: StubControl,
  options: LlamaStubOptions,
  countHealth: () => void,
): Promise<void> {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  if (request.method === "GET" && url.pathname === "/health") {
    countHealth();
    response.writeHead(control.healthStatus, {
      "content-type": "application/json",
    });
    response.end(JSON.stringify(control.healthBody));
    return;
  }
  if (request.method === "GET" && url.pathname === "/v1/models") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ object: "list", data: [] }));
    return;
  }
  if (request.method === "POST" && url.pathname === "/v1/chat/completions") {
    const raw = await readBody(request);
    let body: Record<string, unknown> = {};
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (
        typeof parsed === "object" &&
        parsed !== null &&
        !Array.isArray(parsed)
      ) {
        body = parsed as Record<string, unknown>;
      }
    } catch {
      response.writeHead(400, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "invalid json" }));
      return;
    }
    const record: StubChatRequest = {
      model: typeof body.model === "string" ? body.model : "",
      messages: body.messages,
      body,
      aborted: false,
    };
    chats.push(record);
    response.on("close", () => {
      if (!response.writableEnded) {
        record.aborted = true;
      }
    });
    await writeChat(response, record, control, options);
    return;
  }
  response.writeHead(404, { "content-type": "text/plain" });
  response.end("not found");
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
    });
    request.on("end", () => {
      resolve(Buffer.concat(chunks).toString("utf8"));
    });
    request.on("error", reject);
  });
}

async function writeChat(
  response: ServerResponse,
  record: StubChatRequest,
  control: StubControl,
  options: LlamaStubOptions,
): Promise<void> {
  response.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  response.socket?.setNoDelay(true);
  const recall = options.recallWord;
  const chunks =
    recall === undefined
      ? STUB_REPLY_CHUNKS
      : [recallReply(record.messages, recall)];
  const slow = lastUserText(record.messages) === STUB_SLOW_USER_TEXT;
  for (let index = 0; index < chunks.length; index += 1) {
    if (index > 0 && slow) {
      const closed = await pauseOrClose(response, SLOW_GAP_MS);
      if (closed || record.aborted) {
        if (!response.writableEnded) {
          response.end();
        }
        return;
      }
    }
    const text = chunks[index] ?? "";
    response.write(`data: ${JSON.stringify(contentChunk(text))}\n\n`);
    if (control.holdAfterFirst && index === 0) {
      await waitUntilClosed(response);
      return;
    }
  }
  const usage = usageFor(
    record.messages,
    chunks.join(""),
    recall !== undefined,
  );
  response.write(
    `data: ${JSON.stringify(stopChunk(usage.input, usage.output))}\n\n`,
  );
  response.write("data: [DONE]\n\n");
  response.end();
}

function recallReply(messages: unknown, word: string): string {
  const last = lastUserText(messages).toLowerCase();
  const blob = JSON.stringify(messages).toLowerCase();
  const needle = word.toLowerCase();
  if (blob.includes(needle) && !last.includes(needle)) {
    return word;
  }
  return "remembered";
}

function usageFor(
  messages: unknown,
  text: string,
  recall: boolean,
): { input: number; output: number } {
  if (!recall) {
    return { input: STUB_INPUT_TOKENS, output: STUB_OUTPUT_TOKENS };
  }
  const count = Array.isArray(messages) ? messages.length : 1;
  const words = text.split(/\s+/).filter((part) => part.length > 0).length;
  return { input: 8 + count * 6, output: Math.max(1, words) };
}

function waitUntilClosed(response: ServerResponse): Promise<void> {
  if (response.destroyed || response.writableEnded) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    response.on("close", () => {
      resolve();
    });
  });
}

function pauseOrClose(response: ServerResponse, ms: number): Promise<boolean> {
  if (response.destroyed || response.writableEnded) {
    return Promise.resolve(true);
  }
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      response.off("close", onClose);
      resolve(false);
    }, ms);
    const onClose = (): void => {
      clearTimeout(timer);
      resolve(true);
    };
    response.on("close", onClose);
  });
}

function lastUserText(messages: unknown): string {
  if (!Array.isArray(messages)) {
    return "";
  }
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (typeof message !== "object" || message === null) {
      continue;
    }
    const record = message as { role?: unknown; content?: unknown };
    if (record.role !== "user") {
      continue;
    }
    if (typeof record.content === "string") {
      return record.content;
    }
    if (Array.isArray(record.content)) {
      return record.content
        .map((part) => {
          if (typeof part === "object" && part !== null && "text" in part) {
            const text = (part as { text?: unknown }).text;
            return typeof text === "string" ? text : "";
          }
          return "";
        })
        .join("");
    }
  }
  return "";
}

function contentChunk(text: string): unknown {
  return {
    id: "chatcmpl-cookie",
    object: "chat.completion.chunk",
    created: 0,
    model: "Qwen3.6-35B-A3B",
    choices: [
      {
        index: 0,
        delta: { content: text },
        finish_reason: null,
      },
    ],
  };
}

function stopChunk(inputTokens: number, outputTokens: number): unknown {
  return {
    id: "chatcmpl-cookie",
    object: "chat.completion.chunk",
    created: 0,
    model: "Qwen3.6-35B-A3B",
    choices: [
      {
        index: 0,
        delta: {},
        finish_reason: "stop",
      },
    ],
    usage: {
      prompt_tokens: inputTokens,
      completion_tokens: outputTokens,
      total_tokens: inputTokens + outputTokens,
    },
  };
}
