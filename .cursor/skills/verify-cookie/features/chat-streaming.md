# Chat streaming

John sends a message from the popup and sees Cookie's reply arrive in more than one piece, labelled on-device. He can stop a reply that is still arriving.

## Sub-features

- `chat-send-stream` sends one message and receives the reply as more than one `chat.delta`, then `chat.done` with `finishReason` `stop`. `status: verified (verify-evidence/m0-chat-streaming/transcript.jsonl)`
- `chat-cancel` stops an in-flight reply. `chat.done` uses `finishReason` `cancelled` and no further deltas arrive. `status: verified (verify-evidence/m0-chat-streaming/transcript.jsonl)`
- `chat-popup-reply` shows the `you` turn, the `cookie` turn arriving in chunks, and the badge `on-device` on the reply. `status: planned`
- `chat-talking-pose` shows Cookie in the Talking pose while chunks arrive, or the static mouth-open pose when Reduce Motion is on. `status: planned`

## How to get to it (user POV)

- Open the popup (⌥Space or `Ask Cookie…`).
- Type in the field labelled `Ask Cookie…` and press Return.
- Watch the reply grow before it finishes.
- Stop an in-flight reply with `chat.cancel` on the core. The UI spec names no cancel control, so there is no menu label for this yet.

## Driving it with verify-cookie

Preconditions:

- `pnpm install` has been run at the repository root.
- `.cursor/skills/verify-cookie/bin/drive-core doctor` printed `ok`, `protocolVersion 0.1`, `runtime up fake-local`, `llamaPort 18080`, and `sockets none`.
- Evidence directory `verify-evidence/m0-chat-streaming` is the proof location. Cleanup must not delete it.

- **Core stream.** Run `.cursor/skills/verify-cookie/bin/drive-core drive chat-streaming --evidence verify-evidence/m0-chat-streaming`. Exit code is 0. Stdout contains `deltas 3`, `finishReason stop`, and `cancelled true`. `transcript.jsonl` contains, in order, `initialize`, a `runtime.status` notification `up` / `fake-local`, `chat.send` for `hello from verify-cookie`, three `chat.delta` messages whose text joins to `I'm here. This reply is from the fake core, with no model loaded.`, `chat.done` with `finishReason` `stop`, a second `chat.send`, one `chat.delta`, `chat.cancel`, and `chat.done` with `finishReason` `cancelled`, then `shutdown` with result `ok`. `command.txt` records the command and `COOKIE_LLAMA_PORT=18080`.
- **Popup reply. Mac proof is pending.** `.cursor/skills/verify-cookie/bin/drive-core drive hotkey-popup` on Linux exits 2 with `verified-unreachable on Linux: requires macOS`. `.cursor/skills/verify-cookie/bin/drive-mac chat` does the same on Linux. On a Mac, package the app and type into `Ask Cookie…` (`cookie.popup.input`), then press Return. A `you` line uses `cookie.turn.you.<n>` and the label `you`. A `cookie` line uses `cookie.turn.cookie.<n>` and the label `cookie`. The `cookie` line grows across more than one paint before it stops. The reply badge reads `on-device` and uses `cookie.badge.on-device.<n>`. While chunks arrive, the menu-bar VoiceOver label is `Cookie, thinking` and the popup mascot (`cookie.popup.mascot`) is `Cookie, talking`, or the static mouth-open pose if Reduce Motion is on. The placeholder does not swap frames. Leave `chat-popup-reply` and `chat-talking-pose` `planned` until that Mac evidence exists. The core transcript does not prove them.
- **Cancel on screen.** No button label is specified. Do not invent one. The core proof above is the cancel check until the UI spec names a control.

## Gotchas

- The fake reply is a stub, not a model answer. Assert the chunks and `finishReason`, not that the words answer the question.
- `on-device` is the badge text in the popup wireframe. Do not require the longer privacy sentence `On-device. Nothing left your Mac.` on this surface.
- The wireframe labels the turns `you` and `cookie` in lowercase.
- One in-flight reply. A second `chat.send` before `chat.done` is an error, not a second stream.
- Escape closes the popup. It is not the cancel gesture.
- Do not mark the popup sub-features verified from this transcript. The transcript never opened a window.
