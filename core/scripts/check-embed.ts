/**
 * Mac check for the embedding server. Not a CI test and not a model download.
 *
 * Start the chat server on 8080 the way M0 does, and the embedding server:
 *
 *   /opt/homebrew/bin/llama-server \
 *     -m ~/cookie-runtime/models/nomic-embed-text-v1.5.Q8_0.gguf \
 *     --host 127.0.0.1 --port 8081 --embeddings --pooling mean -ngl 99 -c 2048 \
 *     > /tmp/cookie-embed.log 2>&1 &
 *
 * Then, from the repo root, with a fresh data dir if you also chat:
 *
 *   export COOKIE_EMBED_PORT=8081
 *   pnpm --filter @cookie-agent/core check-embed
 *
 * Prints dimensions, the L2 norm, and the round-trip milliseconds.
 * Exit 1 when /health is down. Do not point this at port 8080.
 */

import {
  HttpEmbedder,
  l2Norm,
  prefixDocument,
  readEmbedPort,
} from "../src/memory/http-embedder.ts";
import { EMBEDDING_DIMENSIONS } from "../src/memory/types.ts";

const port = readEmbedPort();
const embedder = new HttpEmbedder({ port });
const health = await embedder.health();
if (health !== "up") {
  process.stderr.write(
    `embedder down on 127.0.0.1:${port}. Start llama-server --embeddings --pooling mean there.\n`,
  );
  process.exit(1);
}
const started = Date.now();
const vector = await embedder.embed(prefixDocument("ECE midterm is Friday"));
const elapsed = Date.now() - started;
const norm = l2Norm(vector);
process.stdout.write(
  `ok\nport ${port}\ndimensions ${vector.length}\nnorm ${norm.toFixed(6)}\nms ${elapsed}\n`,
);
if (vector.length !== EMBEDDING_DIMENSIONS || Math.abs(norm - 1) > 1e-3) {
  process.stderr.write("embedding was not a unit 768-d vector\n");
  process.exit(1);
}
