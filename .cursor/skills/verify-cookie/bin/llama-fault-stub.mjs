#!/usr/bin/env node
// Fault injection for drive-mac. Not llama-server.
// loading: listen and answer GET /health with 503, slowly, and never 200.
// down: exit immediately so the supervisor's three start attempts fail.
// up: healthy loopback chat the real core can finish with no network egress.

import { createServer } from "node:http";

const STUB_CHUNKS = [
  "Hello. ",
  "This reply is from the local stub, ",
  "on device.",
];

function argValue(flag) {
  const index = process.argv.indexOf(flag);
  if (index >= 0 && index + 1 < process.argv.length) {
    return process.argv[index + 1];
  }
  return "";
}

const mode = argValue("--mode") || process.env.COOKIE_LLAMA_FAULT || "";
const portText = argValue("--port");
const port = Number(portText);

if (mode === "down") {
  process.exit(1);
}

if (mode !== "loading" && mode !== "up") {
  process.stderr.write(
    `llama-fault-stub: mode must be loading, down, or up (got ${mode || "unset"})\n`,
  );
  process.exit(1);
}

if (!Number.isInteger(port) || port < 1 || port > 65535) {
  process.stderr.write("llama-fault-stub: missing --port\n");
  process.exit(1);
}

function pause(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

const server = createServer((request, response) => {
  void handle(request, response).catch((error) => {
    const detail = error instanceof Error ? error.message : "stub failed";
    if (!response.headersSent) {
      response.writeHead(500, { "content-type": "text/plain" });
    }
    response.end(detail);
  });
});

server.listen(port, "127.0.0.1", () => {
  process.stderr.write(`llama-fault-stub ${mode} 127.0.0.1:${port}\n`);
});

async function handle(request, response) {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  if (mode === "loading") {
    await pause(800);
    response.writeHead(503, { "content-type": "application/json" });
    response.end(JSON.stringify({ status: "loading" }));
    return;
  }
  if (request.method === "GET" && url.pathname === "/health") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ status: "ok" }));
    return;
  }
  if (request.method === "GET" && url.pathname === "/v1/models") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ object: "list", data: [] }));
    return;
  }
  if (request.method === "POST" && url.pathname === "/v1/chat/completions") {
    await readBody(request);
    response.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
    });
    for (const text of STUB_CHUNKS) {
      response.write(`data: ${JSON.stringify(contentChunk(text))}\n\n`);
      await pause(40);
    }
    response.write(`data: ${JSON.stringify(stopChunk())}\n\n`);
    response.write("data: [DONE]\n\n");
    response.end();
    return;
  }
  response.writeHead(404, { "content-type": "text/plain" });
  response.end("not found");
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    request.on("data", (chunk) => {
      chunks.push(chunk);
    });
    request.on("end", () => {
      resolve(Buffer.concat(chunks).toString("utf8"));
    });
    request.on("error", reject);
  });
}

function contentChunk(text) {
  return {
    id: "chatcmpl-cookie",
    object: "chat.completion.chunk",
    created: 0,
    model: "Qwen3.6-35B-A3B",
    choices: [{ index: 0, delta: { content: text }, finish_reason: null }],
  };
}

function stopChunk() {
  return {
    id: "chatcmpl-cookie",
    object: "chat.completion.chunk",
    created: 0,
    model: "Qwen3.6-35B-A3B",
    choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    usage: { prompt_tokens: 20, completion_tokens: 11, total_tokens: 31 },
  };
}
