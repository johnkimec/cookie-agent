# M1 plan: Memory

**Status:** approved by John on 2026-10-25. He accepted all recommendations (see "John's answers" below).

This is the build plan for M1. It adds no scope to [cookie-agent.md](./cookie-agent.md). It turns that doc's M1 row into tasks, feature-map entries and checks. Nothing in M1 is built until John merges this doc. The decisions below go into the design doc's decision log as `D-2026-10-2x-NN` entries once John picks them.

## Progress

Draft. Open: John's picks on D1–D5 and the open questions at the end.

## Goal

From the design doc's [Milestones](./cookie-agent.md#milestones) table:

| | |
| --- | --- |
| Scope | SQLite schema, local embeddings, local reflect job, hybrid retrieval, profile cap |
| Exit criteria | Recall evals at 80% or higher with zero egress |
| Story | #2: ask "what did I say about the ECE midterm last week?" and get the right answer |
| Estimate | 2 weeks |

In one line: Cookie remembers across restarts and sessions, and finds the right old turn or fact when asked, without anything leaving the Mac.

### Sub-track: M0 polish and verification debt

Not M1 scope in the design doc, but it runs alongside because it is Swift-side and doesn't block memory:

- drive-mac recipes for the 16 app sub-features still `planned`.
- A Stop control for `chat.cancel`, if John says yes (Q2).
- Popup polish from John's answer to Q1, and his copy review (Q3).

## Non-goals for M1

- No Mac tools, approval cards or trust ledger (M2). The only tools M1 might add are the core-only `memory.*` tools (D3).
- No hosted model. Memory is local-only by routing rule, not just by default.
- No Settings → Memory editor or weekly memory review UI (Q6).
- No power-state gating of background jobs (M5, Q8).
- No change to the model, runtime flags or the 32K context cap.

## Constraints

- Everything runs on 127.0.0.1. Zero egress is checked, not assumed: every memory drive asserts `sockets loopback` and `egress = 0` on every stored turn.
- Linux CI runs every core test against a fake model and a fake embedder. No weights in CI.
- Warm first token stays under 2 s (M0 goal). Retrieval and reranking have to fit inside it.
- `cookie.db` lives under `COOKIE_DATA_DIR`. The shell already resolves that and passes it to the core in the environment. Verification always uses a fresh `mktemp -d /tmp/cookie-m0.XXXXXX`, never John's Application Support folder.
- Raw turns are append-only ground truth. Profile, journal and facts are derived and rebuildable.

## Breakdown

| Component | Lives in | Responsibility | Interface |
| --- | --- | --- | --- |
| Store | `core/src/memory/store.ts` | Open `cookie.db` (WAL), run migrations, append sessions/turns, read recent turns | `MemoryStore` |
| Lexical index | same DB | FTS5 over `facts_fts`, `turns_fts` | SQL triggers on insert |
| Embedder | `core/src/memory/embedder.ts` | Text → 768-d vector via local `/v1/embeddings` | `Embedder` (fake in CI) |
| Vector index | `core/src/memory/vectors.ts` | kNN over `vec_facts`, `vec_chunks`; sqlite-vec or brute-force cosine | `VectorIndex` |
| Retriever | `core/src/memory/retrieve.ts` | BM25 + kNN, reciprocal-rank fusion, local rerank top 20 → 6–8 | `retrieve(query) → Memory[]` |
| Context assembly | `core/src/context.ts` | Persona, profile, recent turns, retrieved memories, within the local token budgets | replaces `ConversationMemory` |
| Reflect job | `core/src/memory/reflect.ts` | After 10 min idle: journal entry, candidate facts, dedupe, supersede | `Reflector` |
| Consolidation | `core/src/memory/consolidate.ts` | Expire, merge, profile regen under 800 tokens, re-chunk + embed | `consolidate()` |
| Embedding runtime | `app/` RuntimeSupervisor | Start, health-check and reap the embedding server | env `COOKIE_EMBED_PORT` |
| Evals | `evals/memory-recall/` | 10 recall tasks, fixture history, runner | `pnpm eval memory` |

## Protocol

**No protocol change is planned.** M1 stays on `0.1`:

- The DB path reaches the core through `COOKIE_DATA_DIR`, which the shell already sets on spawn.
- The embedding server is a dependency the core degrades around (BM25-only), not a status the UI shows. `runtime.status` keeps describing the chat model.
- The Stop control uses the existing `chat.cancel`.

If John wants any memory UI in M1 (Q6), that needs `memory.list` / `memory.forget` methods. That would be protocol `0.2`, with a schema change, golden examples, and Swift Codable types, landed contract-first before either side builds against it.

## Decisions for John

Each one changes what a later task builds. Options, then my recommendation. John fills in his pick and reasoning, and it gets logged in the design doc.

### D1: SQLite library for the core

1. **`node:sqlite`** (built into Node). No native addon, so the single-binary packaging (Node SEA) stays simple. Still marked experimental. FTS5 and extension loading on Node 22.13 have to be confirmed by the spike.
2. **`better-sqlite3`**. Mature and fast, but a native addon that has to be rebuilt per Node version and complicates SEA packaging.

Recommendation: 1, if the spike in Step 0 passes on macOS and on Linux CI. It probably means raising `engines` from `>=22.6`. The existing `--disable-warning=ExperimentalWarning` flag already covers its warning.

### D2: Embedding model and how it runs

The design doc says "under 1 GB, served by the same runtime, 768 dimensions" but names no model. llama-server serves one model per process.

1. **A second `llama-server --embeddings` process** on another loopback port, supervised like the chat server. Candidates: `nomic-embed-text-v1.5` and `embeddinggemma-300m` (both 768-d GGUF), picked by a small recall bake-off on the eval fixtures.
2. **Embed in-process in the core** (an ONNX/transformers runtime). One fewer process, but a new native dependency and a second inference stack.

Recommendation: 1. It is the same runtime, the same reap rules we already proved, and keeps the core free of native inference code.

### D3: How "remember…" and "forget…" work

1. **Core-only tools** `memory.remember`, `memory.forget`, `memory.search` (T0, already in the design doc's tool catalog), run through `ToolLoopAgent`. First real tool calling on the local model, ahead of M2.
2. **Rules**: the core detects "remember …" / "forget …" itself and writes the fact. No tool calling in M1.

Recommendation: 1. It is what the design doc describes, it gives the M2 tool loop an early, low-risk proof, and retrieval for normal questions still happens in context assembly, so recall does not depend on the model choosing to search.

### D4: Reflect job vs chat on one model slot

llama-server runs with `-np 1`, so a reflect job and a chat cannot run at once, and a reflect prompt evicts the chat's cached prefix.

1. **Yield**: reflect runs only when idle and is cancelled by any `chat.send`, then resumes later.
2. **Two slots** (`-np 2`): both run, but each slot gets half of the 32K context and memory use goes up.

Recommendation: 1. It keeps the M0 runtime flags and first-token numbers unchanged.

### D5: `cookie.db` location

The design doc's schema comment says `~/Library/Application Support/Cookie/cookie.db`. D-2026-10-25-01 later made the data dir `~/Library/Application Support/com.johnkimec.cookie-agent`.

Recommendation: `<COOKIE_DATA_DIR>/cookie.db`, logged as a superseding entry so the comment and the decision agree.

## Feature map

New file `.cursor/skills/verify-cookie/features/memory.md`, with the usual four sections. Every sub-feature starts `status: planned`. Evidence goes in `verify-evidence/m1-<sub-feature>/`: `command.txt`, `transcript.jsonl`, and a read-only dump of the relevant tables (`db.txt`).

| Sub-feature | What John sees | How it gets verified |
| --- | --- | --- |
| `memory-persist` | Quit and relaunch, and the same conversation still knows what he said | `drive-core drive memory-persist --core real`: chat, `shutdown`, new core on the same data dir, ask again. `db.txt` shows the `turns` rows. |
| `memory-recall` | Story #2 answers from a past session | Drive against a seeded fixture DB. The stub records the request body, and the drive asserts the seeded turn is in the prompt. On the Mac it runs against real Qwen and the answer contains the fact. |
| `memory-remember` | "Remember my ECE midterm is Friday" is recalled in a new session | Drive: remember, new conversation, ask. `db.txt` shows a pinned fact with `source_turn`. |
| `memory-forget` | "Forget the midterm" makes it stop coming up | Drive: forget, ask. Fact is superseded and absent from the retrieved block. |
| `memory-reflect` | A journal line and facts appear after a session goes quiet | Drive with a short test idle (`COOKIE_REFLECT_IDLE_MS`). `db.txt` shows one journal row and facts with `source_turn`. |
| `memory-profile-cap` | Profile never crowds out the conversation | Consolidation on a large fixture. Profile is ≤ 800 tokens and pinned keys survive. |
| `memory-rebuild` | Derived memory can be thrown away and rebuilt | Drop derived tables, rebuild from `turns`, and recall still passes. |
| `memory-embed-down` | Chat still works and still recalls if the embedding server is gone | Drive with no embedding server. BM25-only retrieval, no stderr error, reply arrives. |
| `memory-no-egress` | Nothing leaves the Mac | Every drive above asserts `sockets loopback` and `egress = 0`. The real-Qwen eval run checks the same. |

Changes to existing files:

- `model-status-offline.md`: add `runtime-embeddings` (the shell starts, health-checks and reaps the embedding server; crash, Quit and SIGTERM reap like the chat server). Verified with a new `drive-mac` step.
- `chat-streaming.md`: add `chat-stop` if John approves the Stop control. Verified with `drive-mac`: send a long prompt, press Stop, and `chat.done` is `cancelled`.
- The 16 `planned` app sub-features get `drive-mac` recipes in the polish sub-track, each verified only by its own drive.

### Recall eval

`evals/memory-recall/`: 10 tasks, per the design doc's "Chat + memory recall" row. Each task is a fixture history (several dated sessions), a question, and the expected fact. Pass is programmatic: the answer contains the fact. The runner also reports recall@8 of retrieval. The exit bar is 8 of 10 on real Qwen on John's Mac, with zero egress. CI runs the same runner against the stub and fake embedder to check the plumbing, not the score.

## Implementation plan

Contract first, then parallel work, then one integration run on the Mac. One task per PR, titled `M1: …`, and every PR updates the feature file it touches.

### Step 0: contract and spike (one PR, Sergey with Engineer 1)

- Spike: on Node 22.13 (Mac) and CI's Node 22, confirm `node:sqlite` opens WAL, has FTS5, and can load sqlite-vec. Record the result as a lesson.
- Land the SQL migration `001` matching the design doc schema, the TypeScript interfaces above with fakes, `features/memory.md` (all `planned`), and the eval task format with two sample tasks.
- **Depends on:** D1, D5, and this doc merged.
- **Verify:** CI green. Migration test opens a temp DB and lists the tables. The spike output is in the PR.

### Step 1: in parallel

| Task | Owner | Depends on | Verify |
| --- | --- | --- | --- |
| A. Store + persistence. Replace `ConversationMemory` with the SQLite store and append-only turns. FTS5 on turns. | Engineer 1 | Step 0 | `memory-persist` drive; vitest: turns survive a reopen |
| B1. Embedding model bake-off on the fixtures, pick a model, pin its file and port. | Sergey | D2 | Bake-off table in the PR (recall@8, ms per embed, RSS) |
| B2. Supervisor starts and reaps the embedding server with the M0 reap rules. | Engineer 2 | B1 (model path and flags only) | `runtime-embeddings` drive-mac step |
| C. Polish sub-track: drive-mac recipes for the 16 planned sub-features, Stop control, copy fixes, John's top popup issues. | Engineer 2 | Q1–Q3 answers | Each sub-feature flips only with its own evidence |
| E0. Write the 10 recall tasks with John. | Sergey + John | Q7 | Tasks reviewed by John |

### Step 2: retrieval and writing memory

| Task | Owner | Depends on | Verify |
| --- | --- | --- | --- |
| D. Embedder, vector index (sqlite-vec or brute-force fallback), hybrid retrieval with RRF and rerank, context assembly within the local budgets. | Engineer 1 | A, B1 (endpoint shape) | `memory-recall`, `memory-embed-down` drives; first-token check on the stub |
| E. Reflect job, write policy, `remember` / `forget`, consolidation and profile cap. | Engineer 1, or a cloud agent in parallel with D | A, D3, D4 | `memory-remember`, `memory-forget`, `memory-reflect`, `memory-profile-cap`, `memory-rebuild` drives |

### Step 3: integration on the Mac (Sergey)

- Run every memory drive and the recall eval on real Qwen and the real embedding server, from a fresh temp data dir with all `COOKIE_*` unset.
- Check warm first token is still under 2 s with retrieval on.
- Mark sub-features verified in a docs-only PR, run `/maintain-verification-skill`, write scilla notes, and do a walkthrough.
- **Depends on:** all of Step 1 and Step 2.
- **Verify:** recall eval ≥ 8/10, every drive's `sockets loopback`, every stored turn `egress = 0`, evidence under `verify-evidence/m1-*`.

## What John gets to learn along the way

M1 is the memory and retrieval milestone, so these come up at implementation time, each tied to a PR:

- Why the model is stateless and the prompt *is* its memory (Step 1A).
- What an embedding is, and why BM25 and vectors miss different things (Step 1 B1, Step 2D).
- Reciprocal-rank fusion and reranking, with real numbers from the eval (Step 2D).
- The KV prefix cache: why stable content goes first and what a reflect job does to it (D4, Step 2D).
- A model writing its own memory: extraction, dedupe, supersede instead of delete (Step 2E).

## Risks

| Risk | Mitigation |
| --- | --- |
| Reranking the top 20 with Qwen adds several thousand fresh tokens and blows the 2 s first-token goal | Measure in Step 2D. If it's over, I bring John options (smaller rerank set, rerank only when fusion is unsure) instead of quietly dropping it. |
| `node:sqlite` or sqlite-vec doesn't work on Node 22.13 | Step 0 spike runs before anything builds on it. Fallbacks: D1 option 2, and the brute-force cosine path the design doc already requires. |
| Reflect writes wrong facts | Every fact keeps `source_turn` and confidence, contradictions supersede, and derived tables are rebuildable. |
| Local tool calls in D3 are unreliable | Schema validation and one local repair, as in the design doc's escalation path. Recall does not depend on the tool. |

## Open questions

1. What bugs you most about the popup right now? Name up to three, and they go first in the polish sub-track.
2. Should the popup get a Stop control for a reply that is still arriving? My proposal: the ⏎ send button becomes Stop while a reply streams, and Esc stops the reply first and closes the panel on a second press. Yes, no, or something different?
3. Are these strings OK as written: "Loading the model…", "🐾 Cookie · core not found", "🐾 Cookie · pnpm not found", "🐾 Cookie · core can't start"? Edit any you want changed.
4. D1–D5 above: which option for each? My recommendations are 1, 1, 1, 1, and `<COOKIE_DATA_DIR>/cookie.db`.
5. When does a conversation end and a new session start? My proposal: after ⌘K, or after the popup has been closed for 10 minutes (the same window the draft is kept).
6. The UI spec has a Settings → Memory editor, a `Memory…` menu item and a weekly memory review, but the design doc's M1 scope doesn't. Leave them out of M1, so forgetting is done by asking Cookie and you get a read-only `pnpm memory dump` to see what it stored? Or pull a minimal viewer into M1 (that needs protocol `0.2`)?
7. The design doc says the eval tasks come from two weeks of your own use, which doesn't exist yet. OK to write 10 fixture tasks now (I draft, you edit), swap in real ones later, and set the bar at 8 of 10 answers containing the fact, with recall@8 reported alongside?
8. Nightly consolidation is meant to run on AC power, but power state is M5. OK to run it on demand and once a day at the first idle in M1, and add the AC check in M5?
9. The design doc's open question 4 matters now, because M1 creates `cookie.db`: encrypt it at rest beyond FileVault, or not? My recommendation is FileVault only for M1, and revisit before packaging.

## John's answers (2026-10-25)

John approved every recommendation as written:

- **D1:** `node:sqlite`, as long as the step 0 spike confirms it supports WAL, FTS5 and loading sqlite-vec.
- **D2:** a second `llama-server --embeddings` process.
- **D3:** "remember" and "forget" are `memory.*` tools.
- **D4:** the reflect job waits until chat is idle.
- **D5:** the database lives at `<COOKIE_DATA_DIR>/cookie.db`.
- **Stop control:** ⏎ becomes Stop while a reply is arriving. Esc stops the reply first and closes the panel on a second press.
- **Copy:** the strings stay as written.
- **Session boundary:** a new session starts after ⌘K or once the popup has been closed for 10 minutes.
- **Memory viewer:** none in M1. Use the read-only `pnpm memory dump` instead, and stay on protocol 0.1.
- **Eval:** 10 fixture tasks, drafted by Sergey and edited by John. The bar is 8 of 10, with recall@8 reported alongside.
- **Consolidation:** on demand, plus once a day at the first idle. The AC-power check waits for M5.
- **Encryption:** FileVault only in M1. Revisit before packaging.

Still open: John's top popup issues for the polish sub-track.

## Change history

- 2026-10-25 — Created from the design doc's M1 row after M0 finished (main `e5570a8`).
- 2026-10-25 — Popup polish, stacked on the Stop control. Replies wrap with no line limit. The per-message on-device pill is one dot in the existing input row (same `on-device` string, no new copy). The field grows from 1 to 8 lines, then scrolls; Return still sends and ⌘K is unchanged. Textual 0.5.0 needs macOS 15, so markdown is SwiftStreamingMarkdown 0.7.0 on the macOS 14 target, with `\[ ... \]` rewritten to `$$ ... $$`. The UI spec's five-line draft and per-reply badge stay as written there; this note is the polish difference. The bar-that-grows redesign is not in this change.
