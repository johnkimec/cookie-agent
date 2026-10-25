import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { EMBEDDING_DIMENSIONS } from "../memory/types.ts";

/**
 * Loopback stand-in for the embedding llama-server.
 * Vectors are deterministic and 768-d so the real HTTP client accepts them.
 */
export function startFakeEmbedder(
  port = 0,
): Promise<{ port: number; close: () => Promise<void> }> {
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (request.method === "GET" && url.pathname === "/health") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ status: "ok" }));
      return;
    }
    if (request.method === "POST" && url.pathname === "/v1/embeddings") {
      void readBody(request).then((raw) => {
        const embedding = embeddingsFor(raw);
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ data: embedding }));
      });
      return;
    }
    response.writeHead(404, { "content-type": "text/plain" });
    response.end("not found");
  });
  return listen(server, port);
}

function embeddingsFor(
  raw: string,
): Array<{ index: number; embedding: number[] }> {
  let input: string[] = [];
  try {
    const parsed = JSON.parse(raw) as { input?: unknown };
    if (
      Array.isArray(parsed.input) &&
      parsed.input.every((item) => typeof item === "string")
    ) {
      input = parsed.input;
    }
  } catch {
    input = [];
  }
  return input.map((text, index) => ({ index, embedding: hashEmbed(text) }));
}

function hashEmbed(text: string): number[] {
  const out: number[] = [];
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  for (let index = 0; index < EMBEDDING_DIMENSIONS; index += 1) {
    hash ^= index + text.length;
    hash = Math.imul(hash, 16777619);
    out.push(((hash >>> 0) % 2000) / 1000 - 1);
  }
  return out;
}

function readBody(
  request: import("node:http").IncomingMessage,
): Promise<string> {
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

function listen(
  server: Server,
  port: number,
): Promise<{ port: number; close: () => Promise<void> }> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("embed stub did not bind"));
        return;
      }
      resolve({
        port: (address as AddressInfo).port,
        close: () =>
          new Promise((done, fail) => {
            server.close((error) => {
              if (error !== undefined) {
                fail(error);
                return;
              }
              done();
            });
          }),
      });
    });
  });
}
