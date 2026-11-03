import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { RERANK_MAX_TOKENS, RERANK_RESPONSE_FORMAT } from "./memory/rerank.ts";
import {
  createLlamaServerProvider,
  readLlamaPort,
  readThinking,
} from "./model/llama.ts";
import { DEFAULT_MODEL_ID } from "./protocol/types.ts";
import {
  STUB_INPUT_TOKENS,
  STUB_OUTPUT_TOKENS,
  STUB_REPLY_CHUNKS,
  startLlamaStub,
} from "./verify-llama-stub.ts";

const closers: Array<() => Promise<void>> = [];

afterEach(async () => {
  const pending = closers.splice(0);
  await Promise.all(pending.map((close) => close()));
});

describe("llama-server provider", () => {
  it("reads COOKIE_LLAMA_PORT and rejects a bad value", () => {
    expect(readLlamaPort({})).toBe(8080);
    expect(readLlamaPort({ COOKIE_LLAMA_PORT: "18080" })).toBe(18080);
    expect(() => readLlamaPort({ COOKIE_LLAMA_PORT: "nope" })).toThrow(
      /COOKIE_LLAMA_PORT/,
    );
    expect(() => readLlamaPort({ COOKIE_LLAMA_PORT: "0" })).toThrow(
      /COOKIE_LLAMA_PORT/,
    );
  });

  it("probes health without hanging when nothing is listening", async () => {
    const port = await closedPort();
    const provider = createLlamaServerProvider({ port });
    const started = Date.now();
    const state = await provider.probe(AbortSignal.timeout(500));
    expect(state).toBe("down");
    expect(Date.now() - started).toBeLessThan(500);
  });

  it("maps /health 200, 503, and a stalled socket", async () => {
    const up = await listenJson(200, { status: "ok" });
    const loading = await listenJson(503, { status: "loading" });
    const stalled = await listenStalled();
    const upState = await createLlamaServerProvider({ port: up.port }).probe(
      AbortSignal.timeout(500),
    );
    const loadingState = await createLlamaServerProvider({
      port: loading.port,
    }).probe(AbortSignal.timeout(500));
    const started = Date.now();
    const downState = await createLlamaServerProvider({
      port: stalled.port,
    }).probe(AbortSignal.timeout(150));
    expect(upState).toBe("up");
    expect(loadingState).toBe("loading");
    expect(downState).toBe("down");
    expect(Date.now() - started).toBeLessThan(500);
  });

  it("streams from an OpenAI-compatible stub and aborts the request", async () => {
    const stub = await startLlamaStub(0);
    closers.push(stub.close);
    const provider = createLlamaServerProvider({ port: stub.port });
    expect(await provider.probe(AbortSignal.timeout(500))).toBe("up");
    const stream = provider.streamChat({
      system: "Be brief.",
      messages: [{ role: "user", content: "hello" }],
      abortSignal: new AbortController().signal,
    });
    const parts: string[] = [];
    for await (const part of stream.textDeltas) {
      parts.push(part);
    }
    const completion = await stream.completion;
    expect(parts).toEqual([...STUB_REPLY_CHUNKS]);
    expect(completion).toEqual({
      finishReason: "stop",
      usage: {
        inputTokens: STUB_INPUT_TOKENS,
        outputTokens: STUB_OUTPUT_TOKENS,
      },
    });
    const body = stub.chats[0]?.body;
    expect(stub.chats[0]?.model).toBe(DEFAULT_MODEL_ID);
    expect(body?.chat_template_kwargs).toMatchObject({
      enable_thinking: false,
    });
    expect(body?.reasoning_effort).toBe("none");

    const abort = new AbortController();
    const slow = provider.streamChat({
      system: "Be brief.",
      messages: [{ role: "user", content: "cancel this reply" }],
      abortSignal: abort.signal,
    });
    let saw = 0;
    const reading = (async () => {
      for await (const _part of slow.textDeltas) {
        saw += 1;
        abort.abort();
      }
    })();
    await expect(slow.completion).rejects.toThrow(/abort/i);
    await reading.catch(() => undefined);
    expect(saw).toBeGreaterThan(0);
    await waitFor(() => stub.chats.some((chat) => chat.aborted));
    expect(stub.chats.some((chat) => chat.aborted)).toBe(true);
  });

  it("sends enable_thinking false on every request when thinking is off", async () => {
    expect(readThinking({})).toBe(false);
    const stub = await startLlamaStub(0);
    closers.push(stub.close);
    const provider = createLlamaServerProvider({
      port: stub.port,
      thinking: readThinking({}),
    });
    for (const text of ["first", "second"]) {
      const stream = provider.streamChat({
        system: "Be brief.",
        messages: [{ role: "user", content: text }],
        abortSignal: new AbortController().signal,
      });
      for await (const _part of stream.textDeltas) {
        // Drain so the request body is recorded.
      }
      await stream.completion;
    }
    expect(stub.chats).toHaveLength(2);
    for (const chat of stub.chats) {
      expect(chat.body.chat_template_kwargs).toMatchObject({
        enable_thinking: false,
      });
    }
  });

  it("reads COOKIE_THINKING and sends it on the chat request", async () => {
    expect(readThinking({})).toBe(false);
    expect(readThinking({ COOKIE_THINKING: "" })).toBe(false);
    expect(readThinking({ COOKIE_THINKING: "0" })).toBe(false);
    expect(readThinking({ COOKIE_THINKING: "1" })).toBe(true);
    expect(() => readThinking({ COOKIE_THINKING: "yes" })).toThrow(
      /COOKIE_THINKING/,
    );

    const stub = await startLlamaStub(0);
    closers.push(stub.close);
    const provider = createLlamaServerProvider({
      port: stub.port,
      thinking: readThinking({ COOKIE_THINKING: "1" }),
    });
    const stream = provider.streamChat({
      system: "Be brief.",
      messages: [{ role: "user", content: "hello" }],
      abortSignal: new AbortController().signal,
    });
    for await (const _part of stream.textDeltas) {
      // Drain so the request body is recorded.
    }
    await stream.completion;
    const body = stub.chats[0]?.body;
    expect(body?.chat_template_kwargs).toMatchObject({
      enable_thinking: true,
    });
    expect(body?.reasoning_effort).toBeUndefined();
  });

  it("sends rerank as json_schema indices with a short max_tokens", async () => {
    const stub = await startLlamaStub(0);
    closers.push(stub.close);
    const provider = createLlamaServerProvider({ port: stub.port });
    const stream = provider.streamChat({
      system: "Reply with JSON only.",
      messages: [{ role: "user", content: "rank these" }],
      abortSignal: new AbortController().signal,
      maxOutputTokens: RERANK_MAX_TOKENS,
      responseFormat: RERANK_RESPONSE_FORMAT,
    });
    try {
      for await (const _part of stream.textDeltas) {
        // The stub does not return the schema. The request body is enough.
      }
      await stream.completion;
    } catch {
      // Structured output may reject the stub's plain text.
    }
    const body = stub.chats[0]?.body;
    expect(body?.max_tokens).toBe(RERANK_MAX_TOKENS);
    expect(body?.response_format).toMatchObject({
      type: "json_schema",
      json_schema: {
        name: "rerank",
        schema: {
          required: ["indices"],
          properties: {
            indices: { maxItems: 8 },
          },
        },
      },
    });
    expect(body?.chat_template_kwargs).toMatchObject({
      enable_thinking: false,
    });
  });
});

function waitFor(ready: () => boolean): Promise<void> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const timer = setInterval(() => {
      if (ready()) {
        clearInterval(timer);
        resolve();
        return;
      }
      if (Date.now() - started > 2000) {
        clearInterval(timer);
        reject(new Error("timed out"));
      }
    }, 10);
  });
}

async function listenJson(
  status: number,
  body: unknown,
): Promise<{ port: number }> {
  const server = createServer((_request, response) => {
    response.writeHead(status, { "content-type": "application/json" });
    response.end(JSON.stringify(body));
  });
  const port = await bind(server);
  closers.push(
    () =>
      new Promise((resolve, reject) => {
        server.close((error) => {
          if (error !== undefined) {
            reject(error);
            return;
          }
          resolve();
        });
      }),
  );
  return { port };
}

async function listenStalled(): Promise<{ port: number }> {
  const server = createServer(() => {
    // Accept and never answer, so the probe has to time out.
  });
  const port = await bind(server);
  closers.push(
    () =>
      new Promise((resolve, reject) => {
        server.closeAllConnections?.();
        server.close((error) => {
          if (error !== undefined) {
            reject(error);
            return;
          }
          resolve();
        });
      }),
  );
  return { port };
}

async function closedPort(): Promise<number> {
  const server = createServer();
  const port = await bind(server);
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

function bind(server: ReturnType<typeof createServer>): Promise<number> {
  return new Promise((resolve, reject) => {
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
}
