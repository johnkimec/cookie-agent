import { createInterface } from "node:readline";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
let reply = readFileSync(join(here, "popup-long-reply.txt"), "utf8");
if (reply.endsWith("\n")) {
  reply = reply.slice(0, -1);
}
if (!reply.includes("END-OF-REPLY-m1-popup") || !reply.includes("Einstein is best known for")) {
  process.stderr.write("popup-long-reply fixture missing sentinel\n");
  process.exit(1);
}

const shortReply = "Einstein is best known for relativity. END-OF-REPLY-m1-popup";
if (!shortReply.includes("END-OF-REPLY-m1-popup") || !shortReply.includes("Einstein is best known for")) {
  process.stderr.write("popup short reply is missing the sentinel\n");
  process.exit(1);
}

const chunks = [];
for (let index = 0; index < reply.length; index += 48) {
  const text = reply.slice(index, index + 48);
  if (text.length === 0) {
    process.stderr.write("popup-long-reply fixture emitted an empty chunk\n");
    process.exit(1);
  }
  chunks.push(text);
}
if (chunks.join("") !== reply) {
  process.stderr.write("popup-long-reply fixture dropped a chunk\n");
  process.exit(1);
}

function emit(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

let sendCount = 0;

const input = createInterface({ input: process.stdin });
input.on("line", (line) => {
  if (!line.trim()) {
    return;
  }
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  if (message.id === undefined || message.id === null) {
    return;
  }
  const method = message.method;
  if (method === "initialize") {
    emit({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        protocolVersion: "0.1",
        serverInfo: { name: "cookie-fake-core", version: "0.0.0" },
        capabilities: {
          chat: { stream: true, cancel: true },
          runtime: { status: true },
        },
      },
    });
    emit({
      jsonrpc: "2.0",
      method: "runtime.status",
      params: { state: "up", modelId: "fake-local" },
    });
    return;
  }
  if (method === "runtime.status") {
    emit({
      jsonrpc: "2.0",
      id: message.id,
      result: { state: "up", modelId: "fake-local" },
    });
    return;
  }
  if (method === "chat.send") {
    sendCount += 1;
    const messageId = `msg-${sendCount}`;
    const pieces = sendCount === 1 ? [shortReply] : chunks;
    const conversationId = message.params?.conversationId ?? "conv-1";
    emit({
      jsonrpc: "2.0",
      id: message.id,
      result: { conversationId, messageId },
    });
    pieces.forEach((text, index) => {
      emit({
        jsonrpc: "2.0",
        method: "chat.delta",
        params: { conversationId, messageId, index, text },
      });
    });
    emit({
      jsonrpc: "2.0",
      method: "chat.done",
      params: {
        conversationId,
        messageId,
        finishReason: "stop",
        usage: { inputTokens: 1, outputTokens: pieces.length },
      },
    });
    return;
  }
  if (method === "chat.cancel") {
    emit({
      jsonrpc: "2.0",
      id: message.id,
      result: { cancelled: false },
    });
    return;
  }
  if (method === "shutdown") {
    emit({ jsonrpc: "2.0", id: message.id, result: { ok: true } });
    process.exit(0);
  }
});
