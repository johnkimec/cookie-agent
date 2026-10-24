# Lessons

Append-only notes for people and coding agents. How to add a row is in [AGENTS.md](../AGENTS.md).

Supersede a wrong lesson with a new row. Do not delete the old row.

| ID | Date | Applies to | Lesson | Supersedes |
| --- | --- | --- | --- | --- |
| L-2026-10-24-01 | 2026-10-24 | `core/` files run with `node --experimental-strip-types` | Node 22 resolves a relative import from a stripped TypeScript file only when the specifier ends in `.ts`. `moduleResolution: NodeNext` accepts that specifier when `allowImportingTsExtensions` is true (`noEmit` is already set). A `.js` specifier typechecks and vitest can rewrite it, but `node --experimental-strip-types` cannot find the file. Entry files the process actually executes, and anything they import, should use `.ts` specifiers. | |
| L-2026-10-24-02 | 2026-10-24 | `core/` process checks and `.cursor/skills/verify-cookie/` | On Linux, Node's piped stdio shows up as `socket:` on fds 0, 1, and 2. A check that the fake core opened no `llama-server` socket has to skip those three fds. Any other `socket:` fd means the process dialed or listened. Do not connect to port 8080 to find out. | |
| L-2026-10-24-03 | 2026-10-24 | `app/Sources/CookieProtocol` | Synthesized `Codable` omits a nil optional. Protocol parse errors need the key `"id": null`, and a `down` status may send `"modelId": null` or omit it. Encode error ids with `encodeNil`. Treat a missing `modelId` and a null `modelId` as the same value when comparing golden files. A notification must not gain an `id` key. | |
| L-2026-10-24-04 | 2026-10-24 | launching `app/` on a Mac | `open Cookie Agent.app` goes through LaunchServices and does not keep the shell's `COOKIE_DATA_DIR` or `PATH`. Run `Cookie Agent.app/Contents/MacOS/CookieAgent` so the fake core inherits the temp data dir, port `18080`, and `pnpm`. The default data dir when the variable is unset is under the temporary directory, not `~/Library/Application Support/Cookie`. | |
| L-2026-10-24-05 | 2026-10-24 | `app/Sources/CookieProtocol/Wire.swift` | Inside a function, a parameter hides a function of the same name. `object(object["params"])` does not call a helper named `object` when `object` is the JSON dictionary parameter. Swift reports `cannot call value of non-function type`. Name the helper so the parameter cannot shadow it. | |
