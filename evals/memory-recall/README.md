# Memory recall eval

Tasks for the design doc's "Chat + memory recall" row. Ten scored tasks live in `tasks/` (ids 03–12). Two Step 0 samples live in `examples/` and are not scored.

## Task file

Each file in `tasks/` and `examples/` is one JSON object matching [`task.schema.json`](./task.schema.json) (draft-07). The file name is `<id>.json`.

| Field | Meaning |
| --- | --- |
| `id` | Stable task id. Matches the file name without `.json`. |
| `question` | What John asks in a new session, after the fixture history is replayed. |
| `expectedFact` | One accepted answer. The match is a normalized substring. |
| `accept` | Optional alternate answers. Any one of these, or `expectedFact`, satisfies the positive check. |
| `mustNotContain` | Optional strings that fail the task when any of them appears in the answer. |
| `tests` | Optional one-line description of what the task is checking. |
| `setup` | Optional one-line description of the session layout. |
| `sessions` | At least two dated sessions, oldest context included. `startedAt` and each turn's `createdAt` are UTC instants, `YYYY-MM-DDTHH:MM:SSZ`. `surface` is `popup`, `menubar`, `checkin`, or `widget`. |

## Pass check

Normalize by trimming, lowercasing, and collapsing whitespace. A task passes when the answer contains `expectedFact` or any `accept` string, and contains no `mustNotContain` string. The runner also prints the retrieved memory ids for the question turn.

The bar is 8 of 10 on `pnpm eval memory --real` (llama-server on `127.0.0.1:${COOKIE_LLAMA_PORT:-8080}`, embedder on `127.0.0.1:${COOKIE_EMBED_PORT:-8081}`). `pnpm eval memory --fake` uses a scripted model and a fake embedder. It proves the plumbing. A score under 8 does not fail that command.

`06-forget-debt-to-daniel` is known-blocked until `memory.forget` lands (#18). The runner still executes it, still counts it in the 10, and labels the result `known-blocked`. It is not skipped.

## Runner

`pnpm eval memory --fake` and `pnpm eval memory --real` replay every scored task through the real core: `chat.send` on stdio, with `ChatLog` and the memory tools that exist in this tree. Each fixture session is its own `conversationId`. The question is a new conversation. Each task gets a new `COOKIE_DATA_DIR`.

`COOKIE_REFLECT_IDLE_MS=0` makes the core call `Reflector` when a new conversation ends the previous session, before that turn is retrieved. That is the idle hook. Protocol 0.1 has no reflect message. The current reflector records a journal row. Fact extraction and `memory.forget` are still #18.

`COOKIE_LOOPBACK_ONLY=1` refuses a TCP connect whose host is not `127.0.0.1` or `::1`. A violation fails the run.

Evidence is written under `verify-evidence/m1-recall/` (gitignored): `summary.txt`, `report.json`, and one JSON file per task. That directory is not feature-verification evidence. `memory-recall` stays `planned` until a verify-cookie drive records it.
