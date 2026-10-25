# Chat streaming

John sends a message from the popup and sees Cookie's reply arrive in more than one piece, labelled on-device. He can stop a reply that is still arriving.

## Sub-features

- `chat-send-stream` sends one message and receives the reply as more than one `chat.delta`, then `chat.done` with `finishReason` `stop`. `status: verified (verify-evidence/m0-real-chat-streaming/transcript.jsonl)`
- `chat-cancel` stops an in-flight reply. `chat.done` uses `finishReason` `cancelled` and no further deltas arrive. `status: verified (verify-evidence/m0-real-chat-streaming/transcript.jsonl)`
- `chat-popup-reply` shows the `you` turn, the `cookie` turn arriving in chunks, and the badge `on-device` on the reply. `status: planned`
- `chat-real-runtime` runs the Mac app against the real core and `llama-server`, waits until the runtime is up, and shows a non-empty reply that is not the fake-core sentence. `status: planned`
- `chat-talking-pose` shows Cookie in the Talking pose while chunks arrive, or the static mouth-open pose when Reduce Motion is on. `status: planned`

## How to get to it (user POV)

- Open the popup (⌥Space or `Ask Cookie…`).
- Type in the field labelled `Ask Cookie…` and press Return.
- Watch the reply grow before it finishes.
- Stop an in-flight reply with `chat.cancel` on the core. The UI spec names no cancel control, so there is no menu label for this yet.

## Driving it with verify-cookie

Preconditions:

- `pnpm install` has been run at the repository root.
- For the real core, `.cursor/skills/verify-cookie/bin/drive-core doctor --core real` printed `ok`, `protocolVersion 0.1`, `server cookie-core`, `runtime up Qwen3.6-35B-A3B`, `llamaPort 18080`, and `sockets loopback`.
- For the fake-core regression, `.cursor/skills/verify-cookie/bin/drive-core doctor` printed `ok`, `protocolVersion 0.1`, `runtime up fake-local`, `llamaPort 18080`, and `sockets none`.
- Evidence directory `verify-evidence/m0-real-chat-streaming` is the proof location for the statuses above. `verify-evidence/m0-chat-streaming` is the fake-core regression. Cleanup must not delete either.

- **Real core stream.** Run `.cursor/skills/verify-cookie/bin/drive-core drive chat-streaming --evidence verify-evidence/m0-real-chat-streaming --core real`. Exit code is 0. Stdout contains `deltas 3`, `finishReason stop`, `cancelled true`, and `modelAborted true`. `transcript.jsonl` contains, in order, `initialize` with result server `cookie-core`, a `runtime.status` notification `up` / `Qwen3.6-35B-A3B`, `chat.send` for `hello from verify-cookie`, an ack `msg-1`, three `chat.delta` messages whose text joins to `Hello. This reply is from the local stub, on device.`, `chat.done` with `finishReason` `stop` and usage `inputTokens` 20 / `outputTokens` 11, a second `chat.send` (`cancel this reply`) acked as `msg-2`, one `chat.delta`, `chat.cancel`, `chat.done` with `finishReason` `cancelled` and usage `inputTokens` 0 / `outputTokens` 0, then the cancel result `cancelled` true, then `shutdown` with result `ok`. `command.txt` records `--core real` and `COOKIE_LLAMA_PORT=18080`.
- **Fake core stream.** Run `.cursor/skills/verify-cookie/bin/drive-core drive chat-streaming --evidence verify-evidence/m0-chat-streaming`. Exit code is 0. Stdout contains `deltas 3`, `finishReason stop`, and `cancelled true`. `transcript.jsonl` contains, in order, `initialize`, a `runtime.status` notification `up` / `fake-local`, `chat.send` for `hello from verify-cookie`, three `chat.delta` messages whose text joins to `I'm here. This reply is from the fake core, with no model loaded.`, `chat.done` with `finishReason` `stop`, a second `chat.send`, one `chat.delta`, `chat.cancel`, and `chat.done` with `finishReason` `cancelled`, then `shutdown` with result `ok`. `command.txt` records the command and `COOKIE_LLAMA_PORT=18080`. This recipe does not replace the real-core transcript cited on `chat-send-stream` and `chat-cancel`.
- **Popup reply. Mac proof is pending.** `.cursor/skills/verify-cookie/bin/drive-core drive hotkey-popup` on Linux exits 2 with `verified-unreachable on Linux: requires macOS`. `.cursor/skills/verify-cookie/bin/drive-mac chat` does the same on Linux. On a Mac, `.cursor/skills/verify-cookie/bin/drive-mac chat --evidence verify-evidence/m0-chat-popup` opens the popup from `Ask Cookie…`, sets `cookie.popup.input` to `hello from drive-mac`, and confirms that field (System Events keystrokes go to the frontmost app, not this panel). The first cookie turn is `cookie.turn.cookie.0` (cookie turns count from zero). Its accessibility value must be non-empty. The script writes `chat.txt` and `popup.png` from `screencapture -x` into `--evidence`, and exits non-zero if either file is missing. Each identifier is on exactly one element. A `you` line uses `cookie.turn.you.<n>` and the label `you`. The reply badge reads `on-device` and uses `cookie.badge.on-device.<n>`. While chunks arrive, the menu-bar VoiceOver label is `Cookie, thinking` and the popup mascot (`cookie.popup.mascot`) is `Cookie, talking`, or the static mouth-open pose if Reduce Motion is on. The placeholder does not swap frames. A failed step exits non-zero. Leave `chat-popup-reply` and `chat-talking-pose` `planned` until that Mac evidence exists. The core transcript does not prove them.
- **Real runtime on the Mac. Proof is pending.** `.cursor/skills/verify-cookie/bin/drive-mac chat --runtime real --evidence verify-evidence/m0-chat-real-runtime` does not start the stub and does not set `COOKIE_CORE_COMMAND`. It still requires a fresh `COOKIE_DATA_DIR`. It does not require port `18080`. The app launches `llama-server` (or reuses a healthy `GET /health` on its port) and the real core. The script waits until the menu status contains `🐾 Cookie · on-device · ` and does not contain `fake-local`, `starting model`, or `model offline`, with a timeout of at least 120 seconds. It then sends one chat. The reply text must be non-empty and must not be the fake-core sentence or the real-core stub sentence. It writes `chat.txt` and `popup.png` and exits non-zero if either file is missing, the wait times out, or the reply check fails. Leave `chat-real-runtime` `planned` until that evidence exists. The default `drive-mac` mode stays on the fake core and port `18080`.
- **Second send while a reply is in flight.** The draft stays. No second `you` turn is added. One quiet line under the field (`cookie.popup.refusal`) reads `Cookie's still answering.` That sentence is placeholder copy pending John's review. It goes away when `chat.done` arrives. Leave this `planned` until the Principal Engineer captures it on a Mac.
- **Cancel on screen.** No button label is specified. Do not invent one. The core proof above is the cancel check until the UI spec names a control.

## Gotchas

- The fake reply and the real-core stub reply are canned text, not a model answer. Assert the chunks and `finishReason`, not that the words answer the question. The real-core joined text is `Hello. This reply is from the local stub, on device.` The fake joined text is the canned fake sentence.
- A cancelled real-core reply reports usage `{ inputTokens: 0, outputTokens: 0 }`. The stub closes the HTTP request (`modelAborted true`) and does not return a partial token count. Usage after a cancel is best-effort and may be zero. Do not require an estimated token count.
- A model completion with no text is `chat.done` with `finishReason` `stop` and no `chat.delta`. Delta `text` still has minLength 1, so the core does not emit an empty chunk and does not use `finishReason` `error` for that case.
- `on-device` is the badge text in the popup wireframe. Do not require the longer privacy sentence `On-device. Nothing left your Mac.` on this surface.
- The wireframe labels the turns `you` and `cookie` in lowercase.
- One in-flight reply. A second `chat.send` before `chat.done` is an error, not a second stream.
- Escape closes the popup. It is not the cancel gesture.
- Do not mark the popup sub-features verified from this transcript. The transcript never opened a window.
