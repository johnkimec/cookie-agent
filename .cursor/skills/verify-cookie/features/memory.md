# Memory

John quits and comes back, and Cookie still knows what he said. He can ask about an old session, tell Cookie to remember or forget something, and nothing from that memory leaves the Mac.

## Sub-features

- `memory-persist` keeps the conversation after quit and relaunch. `status: verified (verify-evidence/m1-memory-persist/transcript.jsonl)`
- `memory-recall` answers story #2 from a past session. `status: planned`
- `memory-remember` stores "Remember my ECE midterm is Friday" as a pinned fact with `source_turn`, then asks in a new conversation. `status: verified (verify-evidence/m1-memory-remember/transcript.jsonl)`
- `memory-forget` drops "Forget the midterm" from later answers. `status: verified (verify-evidence/m1-memory-forget/transcript.jsonl)`
- `memory-reflect` writes a journal line and facts after a session goes quiet. `status: verified (verify-evidence/m1-memory-reflect/transcript.jsonl)`
- `memory-profile-cap` keeps the profile at or under 800 tokens, with pinned keys kept. `status: verified (verify-evidence/m1-memory-profile-cap/transcript.jsonl)`
- `memory-rebuild` rebuilds derived memory from turns and still passes recall. `status: verified (verify-evidence/m1-memory-rebuild/transcript.jsonl)`
- `memory-embed-down` still chats and still recalls when the embedding server is gone. `status: planned`
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
- **Remember.** Run `.cursor/skills/verify-cookie/bin/drive-core drive memory-remember --evidence verify-evidence/m1-memory-remember --core real`. The drive says to remember, starts a new conversation, and asks. Exit code is 0. Stdout contains `remember true`, `pinned true`, and `egress 0`. `db.txt` shows a pinned fact whose `source_turn` is that user turn. The second prompt is not required to contain the fact. Putting a remembered fact into a later prompt is `memory-recall`, and that drive is still planned.
- **Forget.** Run `.cursor/skills/verify-cookie/bin/drive-core drive memory-forget --evidence verify-evidence/m1-memory-forget --core real` with `COOKIE_REFLECT_IDLE_MS=250`. The drive remembers a locker code, waits until reflect has written that code into the journal and the summary, forgets it, then asks in a new conversation. The ask does not repeat the code. Exit code is 0. Stdout contains `forget true` and `retrieval dropped`. `db.txt` has the code in a raw turn and nowhere in facts, `facts_fts`, chunks, the summary, the journal, the profile, or `forgotten_turns`. A planted fact-source hit for that text is dropped by `withoutSuperseded`. stderr is only `memory.forget facts=<ids> turns=<ids>` lines, and those lines do not contain the code.
- **Reflect.** Run `.cursor/skills/verify-cookie/bin/drive-core drive memory-reflect --evidence verify-evidence/m1-memory-reflect --core real` with `COOKIE_REFLECT_IDLE_MS=250`. The first idle reflect is held open. The next `chat.send`, on a new conversation, aborts it. A later reflect then writes one journal row and a fact whose `source_turn` is a stored turn. Exit code is 0. Stdout contains `reflect aborted` and `journal 1`. `command.txt` records `COOKIE_REFLECT_IDLE_MS`.
- **Profile cap.** Run `.cursor/skills/verify-cookie/bin/drive-core drive memory-profile-cap --evidence verify-evidence/m1-memory-profile-cap --core real` with `COOKIE_REFLECT_IDLE_MS=250`. Reflect writes a pinned `name` and 16 unpinned notes. Exit code is 0. Stdout contains `profile capped` and `pinned kept`. The stored profile is longer than the visible list, the visible list is at or under 800 tokens, the pinned name is `John`, and `note_15` is still in the store.
- **Rebuild.** Run `.cursor/skills/verify-cookie/bin/drive-core drive memory-rebuild --evidence verify-evidence/m1-memory-rebuild --core real`. The drive stores a turn, shuts the core down, inserts a junk fact, and rebuilds derived memory from the turns through the same stub. The junk fact is gone. The rebuilt fact's `source_turn` is the user turn. A relaunch on that conversation still has the fact, and the stub's prompt contains the turn text. Exit code is 0. Stdout contains `rebuild true` and `recall true`.
- **Embeddings down.** Run `.cursor/skills/verify-cookie/bin/drive-core drive memory-embed-down --evidence verify-evidence/m1-memory-embed-down --core real` with no embedding server. Retrieval is BM25-only, stderr is empty, and a reply arrives. Leave `memory-embed-down` `planned` until that evidence exists.

## Gotchas

- `memory-persist`, `memory-remember`, `memory-forget`, `memory-reflect`, `memory-profile-cap`, and `memory-rebuild` are the drives above. `.cursor/skills/verify-cookie/bin/drive-core drive memory-recall --evidence /tmp/cookie-memory-evidence --core real` prints usage and exits 2. A vitest run is not feature evidence. Do not mark a sub-feature `verified` from this file alone, or from the `chat-history` transcript.
- `memory-persist` does not accept `--llama external`. It needs the built-in stub so the second reply contains the code word only when the new process loaded the stored turns.
- Core tests cover idle reflect, `memory.remember`, `memory.forget`, consolidation, and the profile cap against a fake model. They do not write `verify-evidence/`. The five drives above do. `memory-recall` and `memory-embed-down` stay `planned`.
- `COOKIE_REFLECT_IDLE_MS` arms the reflect job. It does not end a session and it is not the popup's 10-minute close window. Session end is a later `chat.send` whose `conversationId` differs.
- `drive-core` does not launch the Mac app. The Mac half of recall, against real Qwen, is a later `drive-mac` or real-core run from a fresh temp data dir.
- Do not use port `8080`. Verification uses `COOKIE_LLAMA_PORT=18080`.
- Do not point `COOKIE_DATA_DIR` at `~/Library/Application Support/com.johnkimec.cookie-agent`.
- `memory-no-egress` is not a separate drive. It is the loopback and `egress = 0` assertion on every drive above, plus the real-Qwen eval run.
- Protocol stays `0.1`. There is no memory viewer in M1. Forgetting is something John says. `pnpm memory dump` is the read-only look at `cookie.db`. It is not a drive. `db.txt` in the persist evidence is that dump.
- A new chat is a different `conversationId` on `chat.send`. The app also mints a new id after the popup has been closed for 10 minutes. The core does not time that window and protocol 0.1 has no message for it. `shutdown` does not end the session.
- Turns and facts are embedded after a turn is stored, and only when the embedding server's `/health` on `127.0.0.1:$COOKIE_EMBED_PORT` (default 8081) is up. A down server writes no vectors and prints no stderr. `memory-embed-down` stays `planned` until its drive exists. `pnpm --filter @cookie-agent/core check-embed` is the Mac check against a real nomic server. It is not CI.
