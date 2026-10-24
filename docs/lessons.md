# Lessons

Append-only notes for people and coding agents. How to add a row is in [AGENTS.md](../AGENTS.md).

Supersede a wrong lesson with a new row. Do not delete the old row.

| ID | Date | Applies to | Lesson | Supersedes |
| --- | --- | --- | --- | --- |
| L-2026-10-24-01 | 2026-10-24 | `core/` files run with `node --experimental-strip-types` | Node 22 resolves a relative import from a stripped TypeScript file only when the specifier ends in `.ts`. `moduleResolution: NodeNext` accepts that specifier when `allowImportingTsExtensions` is true (`noEmit` is already set). A `.js` specifier typechecks and vitest can rewrite it, but `node --experimental-strip-types` cannot find the file. Entry files the process actually executes, and anything they import, should use `.ts` specifiers. | |
| L-2026-10-24-02 | 2026-10-24 | `core/` process checks and `.cursor/skills/verify-cookie/` | On Linux, Node's piped stdio shows up as `socket:` on fds 0, 1, and 2. A check that the fake core opened no `llama-server` socket has to skip those three fds. Any other `socket:` fd means the process dialed or listened. Do not connect to port 8080 to find out. | |
