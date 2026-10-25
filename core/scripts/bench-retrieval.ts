/**
 * Local retrieval timing and rerank token estimates.
 * Rerank milliseconds and time to first token stay `unmeasured`
 * unless `GET /health` on `127.0.0.1:$COOKIE_LLAMA_PORT` (default 8080)
 * answers within 200 ms. This script does not start llama-server and
 * does not download weights. Exit 0 when the chat server is absent.
 *
 * On a Mac, with Qwen already serving 8080 (do not start a second one)
 * and, for embeddings, nomic already serving 8081:
 *
 *   export COOKIE_DATA_DIR="$(mktemp -d /tmp/cookie-m1.XXXXXX)"
 *   export COOKIE_LLAMA_PORT=8080
 *   export COOKIE_EMBED_PORT=8081
 *   pnpm --filter @cookie-agent/core bench-retrieval
 *
 * `retrievalMs` is sqlite-vec plus FakeEmbedder on this machine.
 * It is not a Qwen number. `check-embed` is the nomic round trip.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { renderRetrieved } from "../src/context.ts";
import { estimateTokens } from "../src/memory/chunk.ts";
import { FakeEmbedder } from "../src/memory/embedder.ts";
import { prefixDocument } from "../src/memory/http-embedder.ts";
import { HybridRetriever } from "../src/memory/hybrid-retrieve.ts";
import {
  completeText,
  ModelReranker,
  RERANK_PREVIEW_CHARS,
  rerankPromptTokens,
} from "../src/memory/rerank.ts";
import { SqliteMemoryStore } from "../src/memory/sqlite-store.ts";
import { SqliteVecIndex } from "../src/memory/sqlite-vec-index.ts";
import type { Memory } from "../src/memory/types.ts";
import {
  createLlamaServerProvider,
  readLlamaPort,
} from "../src/model/llama.ts";

const CANDIDATES = 20;
const QUERY = "What did I say about the ECE midterm?";
const HEALTH_TIMEOUT_MS = 200;

function report(key: string, value: string | number): void {
  process.stdout.write(`${key} ${value}\n`);
}

async function llamaHealth(port: number): Promise<"up" | "down"> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/health`, {
      redirect: "manual",
      signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
    });
    if (response.ok) {
      return "up";
    }
    return "down";
  } catch {
    return "down";
  }
}

async function firstTokenMs(
  provider: ReturnType<typeof createLlamaServerProvider>,
  messages: Array<{ role: "user"; content: string }>,
): Promise<number> {
  const started = performance.now();
  const stream = provider.streamChat({
    system: "Reply with one short sentence.",
    messages,
    abortSignal: AbortSignal.timeout(60_000),
  });
  const done = stream.completion.then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error }),
  );
  for await (const delta of stream.textDeltas) {
    if (delta.length > 0) {
      const elapsed = performance.now() - started;
      await done;
      return elapsed;
    }
  }
  const outcome = await done;
  if (!outcome.ok) {
    throw outcome.error;
  }
  return performance.now() - started;
}

const dir = mkdtempSync(join(tmpdir(), "cookie-bench-"));
const store = SqliteMemoryStore.open(join(dir, "cookie.db"));
try {
  store.appendSession({
    id: "ses",
    surface: "popup",
    startedAt: 1,
    endedAt: null,
    summary: null,
  });
  const embedder = new FakeEmbedder();
  const vectors = new SqliteVecIndex(store.database());
  const memories: Memory[] = [];
  for (let index = 0; index < CANDIDATES; index += 1) {
    const text =
      `ECE midterm note ${index}. Picnic on Friday. ${"detail ".repeat(30)}`.slice(
        0,
        RERANK_PREVIEW_CHARS,
      );
    const id = `turn-${index}`;
    store.appendTurn({
      id,
      sessionId: "ses",
      role: "user",
      content: text,
      tainted: false,
      model: null,
      egress: false,
      escalatedFrom: null,
      tokensIn: null,
      tokensCached: null,
      tokensOut: null,
      costUsd: null,
      latencyMs: null,
      createdAt: index + 2,
    });
    const chunkId = `${id}#0`;
    store
      .database()
      .prepare(
        "INSERT INTO chunks (chunk_id, session_id, first_turn, last_turn, text) VALUES (?, ?, ?, ?, ?)",
      )
      .run(chunkId, "ses", id, id, text);
    await vectors.upsert(
      "vec_chunks",
      chunkId,
      await embedder.embed(prefixDocument(text)),
    );
    memories.push({ id: chunkId, text, source: "chunk" });
  }
  const retriever = new HybridRetriever({
    db: store.database(),
    vectors,
    embedder,
    available: async () => true,
  });
  await retriever.retrieve(QUERY);
  const started = performance.now();
  await retriever.retrieve(QUERY);
  const retrievalMs = (performance.now() - started).toFixed(1);
  const bm25 = new HybridRetriever({
    db: store.database(),
    vectors,
    embedder,
    available: async () => false,
  });
  const bm25Started = performance.now();
  await bm25.retrieve(QUERY);
  const bm25Ms = (performance.now() - bm25Started).toFixed(1);

  const full = memories.map((row) => ({
    ...row,
    text: "m".repeat(512 * 4),
  }));
  report("retrievalMs", retrievalMs);
  report("bm25Ms", bm25Ms);
  report("rerankPreviewTokens", rerankPromptTokens(QUERY, memories));
  report(
    "rerankFullChunkTokens",
    estimateTokens(full.map((row) => row.text).join("\n")),
  );
  report("candidates", CANDIDATES);

  const port = readLlamaPort();
  const health = await llamaHealth(port);
  report("llamaHealth", health);
  report("llamaPort", port);
  if (health !== "up") {
    report("rerankMs", "unmeasured");
    report("ttftWithoutRetrievalMs", "unmeasured");
    report("ttftWithRetrievalMs", "unmeasured");
    report(
      "note",
      "Qwen rerank and TTFT need the Mac. This process did not start llama-server.",
    );
  } else {
    const provider = createLlamaServerProvider({ port, thinking: false });
    const reranker = new ModelReranker({
      enabled: true,
      timeoutMs: 60_000,
      complete: (prompt, signal) => completeText(provider, prompt, signal),
    });
    const rerankStarted = performance.now();
    await reranker.rerank(QUERY, memories);
    report("rerankMs", Math.round(performance.now() - rerankStarted));
    const question = [{ role: "user" as const, content: QUERY }];
    report(
      "ttftWithoutRetrievalMs",
      Math.round(await firstTokenMs(provider, question)),
    );
    const block = renderRetrieved(memories);
    const withMemory = [
      { role: "user" as const, content: block },
      { role: "user" as const, content: QUERY },
    ];
    report(
      "ttftWithRetrievalMs",
      Math.round(await firstTokenMs(provider, withMemory)),
    );
  }
} finally {
  store.close();
  rmSync(dir, { recursive: true, force: true });
}
