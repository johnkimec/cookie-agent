# Memory recall eval

Tasks for the design doc's "Chat + memory recall" row. Step 0 lands the file format and two samples. The runner, `pnpm eval memory`, and the other eight tasks are later (Step 1 E0, drafted with John).

## Task file

Each file in `tasks/` is one JSON object matching [`task.schema.json`](./task.schema.json) (draft-07). The file name is `<id>.json`.

| Field | Meaning |
| --- | --- |
| `id` | Stable task id. Matches the file name without `.json`. |
| `question` | What John asks in a new session, after the fixture history is loaded. |
| `expectedFact` | The fact the answer must contain. |
| `sessions` | At least two dated sessions, oldest context included. `startedAt` and each turn's `createdAt` are UTC instants, `YYYY-MM-DDTHH:MM:SSZ`. `surface` is `popup`, `menubar`, `checkin`, or `widget`. |

## Pass check

Pass is programmatic: the answer contains `expectedFact` as a case-sensitive substring. The runner also reports recall@8 of retrieval (the expected fact's source is inside the top 8 retrieved memories). This directory does not run a model. CI checks that every `tasks/*.json` file validates against the schema.
