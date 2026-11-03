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

Normalize by trimming, lowercasing, collapsing whitespace, and removing a space before a known unit (`g`, `kg`, `lb`, `ml`, `am`, `pm`, `%`). `170 g` and `170g` are the same string. A space before any other word stays, so `10:30 in the morning`, `at 3 Bahen`, `170 grams`, and `10:30 a.m.` keep their boundaries. A comma or dot between digits is not a boundary, so `170 g` does not match `1,170 g` or `1.170 g`, and `2 kg` does not match `4.2 kg`. A `.` or `,` directly before a digit is not a boundary either, so `5 kg` does not match `.5 kg` or `0.5 kg`. A space, NBSP (U+00A0), thin space (U+2009), or narrow no-break space (U+202F) joins a digit to a following group of exactly three digits, so `1 170` is `1170` and `170 g` does not match inside `1 170 g` or `1170 g`. `10:30` still matches `Nov 7 10:30`, `10:30 am` still matches `Saturday, November 7 10:30 am`, `Day 3 170 g` is also joined, so `170 g` does not match `Day 3 170 g of protein`. `10:30` still matches `10:30 am`. A hyphen is a boundary, so `-170 g` and `150-170 g` contain `170 g`. A plain `170 g` and `170 g.` still match. A task passes when the answer contains `expectedFact` or any `accept` string, and contains no `mustNotContain` string. The runner also prints the retrieved memory ids for the question turn.

The bar is 8 of 10 on `pnpm eval memory --real`. That command needs an explicit llama port and embed port: `--llama-port` and `--embed-port`, or `COOKIE_LLAMA_PORT` and `COOKIE_EMBED_PORT`. It does not default to 8080 or 8081. Fixture assistant lines are replayed by a scripted stub. A reflect prompt is answered with empty JSON, so `--real` does not test fact extraction. The final question goes to the real model at temperature 0. The evidence directory stores each server's `/props` and `/v1/models` response. `pnpm eval memory --fake` scores retrieval, not the echoed answer. Vector weight is 0, so the rank is BM25. A task passes when an `expectedIds` turn is in the top 8, every `requiredIds` turn is in that top 8, and no `distractorIds` turn ranks above the best expected id or above a required id. That cutoff is fixed. `04-knee-squat-swap` is real-only and is not in the fake denominator, so the score is out of 9. The stub answers a reflect prompt with empty JSON (`journal`, `summary`, `facts`, `profile`). The command exits 1 below 8/9. Listed ids are the user turn and the assistant turn that carry the fact or the distractor, and the loader checks those ids with the same stored-turn counter the runner uses. An expected id must carry `expectedFact` or an accept entry. A required id must carry its own `requiredFacts` string, not `expectedFact`. Task 11 lists only the turns that carry the string: its assistant replies do not contain Open Farm or "keeps getting slow", so they are not listed.

`06-forget-debt-to-daniel` still runs and still counts in the 10. It passes only when `store.forgottenTurnIds()` includes the debt turn. Until that method exists it is labeled `known-blocked` and it is not skipped. A throw from the probe is an error on that task, not `known-blocked`.

## Runner

`pnpm eval memory --fake` and `pnpm eval memory --real` replay every scored task through the real core: `chat.send` on stdio, with `ChatLog` and the memory tools that exist in this tree. Each fixture session is its own `conversationId`. The question is a new conversation. Each task gets a new `COOKIE_DATA_DIR`.

`COOKIE_REFLECT_IDLE_MS=0` makes the core call `Reflector` when a new conversation ends the previous session, before that turn is retrieved. The call is the session id only. Protocol 0.1 has no reflect message. The current reflector records a journal row. When #18 is on main, that body becomes `runtime.reflector` (the same `LocalReflector` the idle scheduler uses) and this runner drops its copy of `readReflectIdleMs`.

`COOKIE_LOOPBACK_ONLY=1` refuses a TCP connect whose host is not `127.0.0.1` or `::1`. After that patch refuses a connect to `192.0.2.1`, the core prints `cookie-core: loopback guard active <COOKIE_LOOPBACK_NONCE>` as one stderr line. The runner requires that exact line. A missing line fails the task, and so does a blocked connect. A reflect error is logged and does not fail the chat turn. A throw from `forgottenTurnIds()` fails only task 06.

Evidence is written under `verify-evidence/m1-recall/` (gitignored): `summary.txt`, `report.json`, and one JSON file per task. That directory is not feature-verification evidence. `memory-recall` stays `planned` until a verify-cookie drive records it.
