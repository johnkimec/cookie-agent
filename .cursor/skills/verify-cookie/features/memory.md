# Memory

John quits and comes back, and Cookie still knows what he said. He can ask about an old session, tell Cookie to remember or forget something, and nothing from that memory leaves the Mac.

## Sub-features

- `memory-persist` keeps the conversation after quit and relaunch. `status: verified (verify-evidence/m1-memory-persist/transcript.jsonl)`
- `memory-recall` answers story #2 from a past session. `status: planned`
- `memory-remember` stores "Remember my ECE midterm is Friday" and recalls it in a new session. `status: planned`
- `memory-forget` drops "Forget the midterm" from later answers. `status: planned`
- `memory-reflect` writes a journal line and facts after a session goes quiet. `status: planned`
- `memory-profile-cap` keeps the profile at or under 800 tokens, with pinned keys kept. `status: planned`
- `memory-rebuild` rebuilds derived memory from turns and still passes recall. `status: planned`
- `memory-embed-down` still chats and still recalls when the embedding server is gone. `status: verified (verify-evidence/m1-memory-embed-down/transcript.jsonl)`
- `memory-no-egress` keeps every memory drive on loopback with `egress = 0`. `status: planned`

## How to get to it (user POV)

- Quit Cookie and open it again, then ask about something said in the earlier conversation.
- Ask "what did I say about the ECE midterm last week?"
- Say "Remember my ECE midterm is Friday", start a new conversation, and ask about the midterm.
- Say "Forget the midterm", then ask about it again.
- Leave a session quiet long enough for a journal line to appear.
- Keep talking after a lot of memory has been stored. The profile must not crowd out the conversation.
- Throw away derived memory. Asking again still finds the fact from the raw turns.
- Chat while the embedding server is not running. A reply still arrives, and a lexical match can still be recalled.
- Use any of the paths above. Nothing from the turn leaves the Mac.

## Driving it with verify-cookie

Preconditions:

- `pnpm install` has been run at the repository root.
- `.cursor/skills/verify-cookie/bin/drive-core doctor --core real` printed `ok`, `protocolVersion 0.1`, `server cookie-core`, `runtime up Qwen3.6-35B-A3B`, `llamaPort 18080`, and `sockets loopback`.
- `COOKIE_DATA_DIR` is a new `mktemp -d /tmp/cookie-m0.XXXXXX` for the run. Never point it at John's Application Support folder.
- Evidence for a sub-feature goes in `verify-evidence/m1-<sub-feature>/`: `command.txt`, `transcript.jsonl`, and `db.txt` (a read-only dump of the relevant tables).
- Every drive below asserts `sockets loopback` and `egress = 0` on every stored turn. That assertion is `memory-no-egress`. The real-Qwen eval run checks the same.

- **Persist.** Run `.cursor/skills/verify-cookie/bin/drive-core drive memory-persist --evidence verify-evidence/m1-memory-persist --core real`. The drive uses the built-in stub on port `18080`. It sends a code word, shuts the core down, starts a new core on the same data dir, and asks for the word. The second prompt does not contain the word. Exit code is 0. Stdout contains `persist true` and `egress 0`. `db.txt` shows the `turns` rows, every `egress` is 0, and `ended_at` is null. `transcript.jsonl` has two `initialize` requests. Verified on Linux against the stub. The Mac relaunch of the app is still a later drive.
- **Recall.** Run `.cursor/skills/verify-cookie/bin/drive-core drive memory-recall --evidence verify-evidence/m1-memory-recall --core real` against a seeded fixture database. The stub records the request body, and the drive asserts the seeded turn is in the prompt. On the Mac the same drive runs against real Qwen and the answer contains the fact. Leave `memory-recall` `planned` until that evidence exists.
- **Remember.** Run `.cursor/skills/verify-cookie/bin/drive-core drive memory-remember --evidence verify-evidence/m1-memory-remember --core real`. The drive says to remember, starts a new conversation, and asks. Exit code is 0. `db.txt` shows a pinned fact with `source_turn`. Leave `memory-remember` `planned` until that evidence exists.
- **Forget.** Run `.cursor/skills/verify-cookie/bin/drive-core drive memory-forget --evidence verify-evidence/m1-memory-forget --core real`. The drive forgets, then asks. The fact is superseded and absent from the retrieved block. Leave `memory-forget` `planned` until that evidence exists.
- **Reflect.** Run `.cursor/skills/verify-cookie/bin/drive-core drive memory-reflect --evidence verify-evidence/m1-memory-reflect --core real` with a short test idle (`COOKIE_REFLECT_IDLE_MS`). `db.txt` shows one journal row and facts with `source_turn`. Leave `memory-reflect` `planned` until that evidence exists.
- **Profile cap.** Run `.cursor/skills/verify-cookie/bin/drive-core drive memory-profile-cap --evidence verify-evidence/m1-memory-profile-cap --core real` on a large fixture. The profile is at or under 800 tokens and pinned keys survive. Leave `memory-profile-cap` `planned` until that evidence exists.
- **Rebuild.** Run `.cursor/skills/verify-cookie/bin/drive-core drive memory-rebuild --evidence verify-evidence/m1-memory-rebuild --core real`. Derived tables are dropped, rebuilt from `turns`, and recall still passes. Leave `memory-rebuild` `planned` until that evidence exists.
- **Embeddings down.** Run `.cursor/skills/verify-cookie/bin/drive-core drive memory-embed-down --evidence verify-evidence/m1-memory-embed-down --core real`. The drive uses the built-in stub on port `18080` and sets `COOKIE_EMBED_PORT` to a loopback port it binds and then closes, so it does not dial `8081` or `8080`. It stores a code word in one conversation, then asks from a different conversation id. The question does not contain the word. Exit code is 0. Stdout contains `embedDown true`, `recall true`, and `egress 0`. The reply contains the word, which the stub returns only when an earlier message has it and the latest user text does not. `db.txt` shows both sessions and `egress` 0. Stderr is empty. Verified on Linux against the stub. Qwen rerank milliseconds and time to first token are not in that transcript. `pnpm --filter @cookie-agent/core bench-retrieval` prints those as `unmeasured` until a Mac chat server is already up.

## Gotchas

- `memory-persist` and `memory-embed-down` are the drives above. The other memory drives are not in `drive-core` yet. `.cursor/skills/verify-cookie/bin/drive-core drive memory-recall --evidence /tmp/cookie-memory-evidence --core real` prints usage and exits 2. A vitest run is not feature evidence. Do not mark a sub-feature `verified` from this file alone, or from the `chat-history` transcript.
- `memory-persist` does not accept `--llama external`. It needs the built-in stub so the second reply contains the code word only when the new process loaded the stored turns.
- `drive-core` does not launch the Mac app. The Mac half of recall, against real Qwen, is a later `drive-mac` or real-core run from a fresh temp data dir.
- Do not use port `8080`. Verification uses `COOKIE_LLAMA_PORT=18080`.
- Do not point `COOKIE_DATA_DIR` at `~/Library/Application Support/com.johnkimec.cookie-agent`. Under `VITEST` or `NODE_ENV=test` the core throws instead of opening that default directory, on every OS. A test that starts a core sets its own temp directory and deletes it afterwards. Env is read before `cookie.db` is opened.
- `memory-no-egress` is not a separate drive. It is the loopback and `egress = 0` assertion on every drive above, plus the real-Qwen eval run.
- `pnpm eval memory --fake` replays `evals/memory-recall/tasks/` (03–12) through the real core over stdio and scores BM25 retrieval: an `expectedIds` turn in the top 8, with no `distractorIds` turn above it. `04-knee-squat-swap` is real-only and is left out of that denominator. CI runs that command. It does not mark `memory-recall` verified. Samples 01 and 02 are in `evals/memory-recall/examples/` and are not scored. `pnpm eval memory --real` is the Mac score and requires `--llama-port` and `--embed-port`, or `COOKIE_LLAMA_PORT` and `COOKIE_EMBED_PORT`. It does not default to 8080 or 8081. Fixture assistant lines go through the scripted stub. A reflect prompt gets empty JSON. The final question goes to the real model at temperature 0. The bar is 8/10. `06-forget-debt-to-daniel` still runs and still counts in the 10. It passes only when `forgottenTurnIds()` includes the debt turn, and it is known-blocked while that method is missing. The core prints `cookie-core: loopback guard active` when the guard is on. Evidence under `verify-evidence/m1-recall/` is gitignored and is not a drive transcript.
- `COOKIE_REFLECT_IDLE_MS` (the eval sets `0`) makes `ChatLog` call `Reflector` when a new `conversationId` ends the previous session, before that turn is retrieved. The body in this tree writes one `journal` row per ended session. It does not extract facts. `memory-reflect` stays `planned`. `COOKIE_LOOPBACK_ONLY=1` fails a TCP connect whose host is not `127.0.0.1` or `::1`.
- Protocol stays `0.1`. There is no memory viewer in M1. Forgetting is something John says. `pnpm memory dump` is the read-only look at `cookie.db`. It is not a drive. `db.txt` in the persist evidence is that dump.
- A new chat is a different `conversationId` on `chat.send`. The app also mints a new id after the popup has been closed for 10 minutes. The core does not time that window and protocol 0.1 has no message for it. `shutdown` does not end the session.
- Turns and facts are embedded after a turn is stored, and only when the embedding server's `/health` on `127.0.0.1:$COOKIE_EMBED_PORT` (default 8081) is up. A down server writes no new vectors and prints no stderr. Retrieval then uses BM25 only. One pass embeds about 64 chunks and commits each batch on its own. A fact with `superseded_by` set, or `valid_until` at or before now, is not embedded, and `VectorIndex.delete` removes its vector. `pnpm --filter @cookie-agent/core check-embed` is the Mac check against a real nomic server. The model file is `nomic-embed-text-v1.5.Q8_0.gguf`. The documented llama-server command includes `--embeddings --pooling mean`. `pnpm --filter @cookie-agent/core bench-retrieval` times local retrieval and prints Qwen rerank and time-to-first-token as `unmeasured` unless chat `/health` is already up. Neither script is CI, and neither starts `llama-server`.
- Default RRF weights are vector 1 and BM25 1. `COOKIE_RRF_VECTOR` and `COOKIE_RRF_BM25` override them. When the store exposes `forgottenTurnIds()`, retrieval drops those turns and the chunks and session summaries derived from them before fusion. The method is not on `MemoryStore` until #18. `memory-forget` stays `planned`.
- Query embeds use `COOKIE_EMBED_TIMEOUT_MS` (default 400 ms) and fall back to BM25 if that elapses. Indexing keeps a 10 s timeout. `COOKIE_RERANK` is off unless set to `1`. Rerank then asks for candidate indices under a JSON schema, with `max_tokens` 32 and 100-character previews. Chunk hits `${turnId}#n` are fused as `turnId`. kNN `k` stays at or below 4096.
