import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { resolveEmbedder } from "./embed-config.ts";
import { FakeEmbedder } from "./embedder.ts";
import {
  DEFAULT_EMBED_TIMEOUT_MS,
  DEFAULT_QUERY_EMBED_TIMEOUT_MS,
  DOCUMENT_PREFIX,
  HttpEmbedder,
  l2Norm,
  prefixDocument,
  QUERY_PREFIX,
  readEmbedPort,
  readEmbedTimeoutMs,
  readIndexEmbedTimeoutMs,
  readQueryEmbedTimeoutMs,
} from "./http-embedder.ts";
import { EMBEDDING_DIMENSIONS } from "./types.ts";

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          server.close((error) => {
            if (error !== undefined) {
              reject(error);
              return;
            }
            resolve();
          });
        }),
    ),
  );
});

describe("embed port", () => {
  it("defaults to 8081 and rejects a bad port", () => {
    expect(readEmbedPort({})).toBe(8081);
    expect(readEmbedPort({ COOKIE_EMBED_PORT: "8081" })).toBe(8081);
    expect(() => readEmbedPort({ COOKIE_EMBED_PORT: "nope" })).toThrow(
      /COOKIE_EMBED_PORT/,
    );
    expect(readQueryEmbedTimeoutMs({})).toBe(DEFAULT_QUERY_EMBED_TIMEOUT_MS);
    expect(readQueryEmbedTimeoutMs({ COOKIE_EMBED_TIMEOUT_MS: "250" })).toBe(
      250,
    );
    expect(
      readQueryEmbedTimeoutMs({
        COOKIE_EMBED_QUERY_TIMEOUT_MS: "120",
        COOKIE_EMBED_TIMEOUT_MS: "250",
      }),
    ).toBe(120);
    expect(readIndexEmbedTimeoutMs({})).toBe(DEFAULT_EMBED_TIMEOUT_MS);
    expect(
      readIndexEmbedTimeoutMs({ COOKIE_EMBED_INDEX_TIMEOUT_MS: "1500" }),
    ).toBe(1500);
    expect(readIndexEmbedTimeoutMs({ COOKIE_EMBED_TIMEOUT_MS: "50" })).toBe(
      DEFAULT_EMBED_TIMEOUT_MS,
    );
    expect(readEmbedTimeoutMs({})).toBe(DEFAULT_EMBED_TIMEOUT_MS);
    expect(DEFAULT_QUERY_EMBED_TIMEOUT_MS).toBe(400);
    expect(() =>
      readQueryEmbedTimeoutMs({ COOKIE_EMBED_QUERY_TIMEOUT_MS: "nope" }),
    ).toThrow(/COOKIE_EMBED_QUERY_TIMEOUT_MS/);
    expect(() =>
      readIndexEmbedTimeoutMs({ COOKIE_EMBED_INDEX_TIMEOUT_MS: "nope" }),
    ).toThrow(/COOKIE_EMBED_INDEX_TIMEOUT_MS/);
  });
});

describe("HTTP embedder", () => {
  it("L2-normalizes a batch and sends the text unchanged", async () => {
    const seen: unknown[] = [];
    const server = await startEmbedServer((body) => {
      seen.push(body);
      const input = Array.isArray(body.input) ? body.input : [];
      return input.map((text, index) => ({
        index,
        embedding: axis(index, text === `${DOCUMENT_PREFIX}notes`),
      }));
    });
    const embedder = new HttpEmbedder({
      port: server.port,
      batchSize: 2,
      fetch: globalThis.fetch,
    });
    expect(await embedder.health()).toBe("up");
    const vectors = await embedder.embedMany([
      prefixDocument("notes"),
      "plain",
      "third",
    ]);
    expect(seen).toHaveLength(2);
    expect(vectors).toHaveLength(3);
    const first = vectors[0];
    if (first === undefined) {
      throw new Error("missing vector");
    }
    expect(first.length).toBe(EMBEDDING_DIMENSIONS);
    expect(l2Norm(first)).toBeCloseTo(1, 5);
    expect(first[0]).toBeCloseTo(0.6, 5);
    expect(first[1]).toBeCloseTo(0.8, 5);
    const posted = JSON.stringify(seen);
    expect(posted).toContain(`${DOCUMENT_PREFIX}notes`);
    expect(posted).not.toContain(QUERY_PREFIX);
    expect(await embedder.embedMany([])).toEqual([]);
  });

  it("rejects a short vector and a timed-out server", async () => {
    const server = await startEmbedServer(() => [
      { index: 0, embedding: [1, 2, 3] },
    ]);
    const embedder = new HttpEmbedder({ port: server.port, timeoutMs: 50 });
    await expect(embedder.embed("hello")).rejects.toThrow(/768/);

    const hung = await startEmbedServer(() => [], { hang: true });
    const slow = new HttpEmbedder({
      port: hung.port,
      timeoutMs: 40,
      healthTimeoutMs: 40,
    });
    await expect(slow.embed("hello")).rejects.toThrow(/unreachable/);
    expect(await slow.health()).toBe("down");
  });

  it("reports health down when nothing is listening", async () => {
    const embedder = new HttpEmbedder({
      port: await closedPort(),
      healthTimeoutMs: 50,
    });
    expect(await embedder.health()).toBe("down");
  });
});

describe("resolveEmbedder", () => {
  it("uses HTTP when health is up and the fake otherwise", async () => {
    const server = await startEmbedServer((body) => {
      const input = Array.isArray(body.input) ? body.input : [];
      return input.map((_, index) => ({ index, embedding: axis(0, false) }));
    });
    const live = await resolveEmbedder(
      { COOKIE_EMBED_PORT: String(server.port) },
      { healthTimeoutMs: 200 },
    );
    expect(live).toBeInstanceOf(HttpEmbedder);
    expect((await live.embed("x")).length).toBe(EMBEDDING_DIMENSIONS);

    const forced = await resolveEmbedder({ COOKIE_EMBEDDER: "fake" });
    expect(forced).toBeInstanceOf(FakeEmbedder);

    const down = await resolveEmbedder(
      { COOKIE_EMBED_PORT: String(await closedPort()) },
      { healthTimeoutMs: 50 },
    );
    expect(down).toBeInstanceOf(FakeEmbedder);
  });
});

function axis(slot: number, marked: boolean): number[] {
  const values = new Array<number>(EMBEDDING_DIMENSIONS).fill(0);
  values[0] = 3;
  values[1] = marked ? 4 : 0;
  values[2] = slot;
  return values;
}

function startEmbedServer(
  embeddings: (body: Record<string, unknown>) => Array<{
    index: number;
    embedding: number[];
  }>,
  options: { hang?: boolean } = {},
): Promise<{ port: number }> {
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (request.method === "GET" && url.pathname === "/health") {
      if (options.hang) {
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ status: "ok" }));
      return;
    }
    if (request.method === "POST" && url.pathname === "/v1/embeddings") {
      if (options.hang) {
        return;
      }
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => {
        chunks.push(chunk);
      });
      request.on("end", () => {
        const body = JSON.parse(
          Buffer.concat(chunks).toString("utf8"),
        ) as Record<string, unknown>;
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({ object: "list", data: embeddings(body) }),
        );
      });
      return;
    }
    response.writeHead(404);
    response.end();
  });
  servers.push(server);
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("embed server did not bind"));
        return;
      }
      resolve({ port: (address as AddressInfo).port });
    });
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
