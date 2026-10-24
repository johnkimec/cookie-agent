# Lessons

Append-only notes for people and coding agents. How to add a row is in [AGENTS.md](../AGENTS.md).

Supersede a wrong lesson with a new row. Do not delete the old row.

| ID | Date | Applies to | Lesson | Supersedes |
| --- | --- | --- | --- | --- |
| L-2026-10-24-01 | 2026-10-24 | `core/` files run with `node --experimental-strip-types` | Node 22 resolves a relative import from a stripped TypeScript file only when the specifier ends in `.ts`. `moduleResolution: NodeNext` accepts that specifier when `allowImportingTsExtensions` is true (`noEmit` is already set). A `.js` specifier typechecks and vitest can rewrite it, but `node --experimental-strip-types` cannot find the file. Entry files the process actually executes, and anything they import, should use `.ts` specifiers. | |
| L-2026-10-24-02 | 2026-10-24 | `core/` process checks and `.cursor/skills/verify-cookie/` | On Linux, Node's piped stdio shows up as `socket:` on fds 0, 1, and 2. A check that the fake core opened no `llama-server` socket has to skip those three fds. Any other `socket:` fd means the process dialed or listened. Do not connect to port 8080 to find out. | |
| L-2026-10-24-03 | 2026-10-24 | `core/` model streaming | AI SDK 7 `streamText` rejects `finishReason` and `usage` with `AbortError` when the signal aborts, and it does not resolve a partial token count. A cancelled `chat.done` reports `{ inputTokens: 0, outputTokens: 0 }` unless a usage payload arrived before the abort. Attach a handler to that promise even when the text iterator returns early, or Node treats the rejection as fatal. | |
| L-2026-10-24-04 | 2026-10-24 | `.cursor/skills/verify-cookie/` | `drive-core --core real` binds an OpenAI-compatible stub on `127.0.0.1:$COOKIE_LLAMA_PORT` (verification uses `18080`) and spawns `core/src/index.ts`. Doctor allows a non-stdio socket only when its peer is that loopback port (`sockets loopback`). `/proc/net/tcp` IPv4 addresses are little-endian (`0100007F:46A0` is `127.0.0.1:18080`). Cleanup may signal a pid only when cmdline contains `fake-core.ts` or `core/src/index.ts`. Do not probe port `8080`. | |
| L-2026-10-24-05 | 2026-10-24 | `core/` chat deltas | `chat.delta` `text` has minLength 1, so the real core drops empty model chunks. A completion that yields no text is `chat.done` with `finishReason` `error` and no deltas. | |
