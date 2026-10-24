# Model status and offline

The menu bar tells John whether the on-device model is up, loading, or down. With the model up, a reply still completes with no network. Cookie does not switch to a cloud model.

## Sub-features

- `status-up` shows `🐾 Cookie · on-device · Qwen3.6` and answers a chat while `runtime.status` is `up` for `Qwen3.6-35B-A3B`. `status: planned`
- `status-loading` shows the dotted-outline glyph while the runtime is `loading`, and a send does not start a reply. `status: planned`
- `status-down` shows the head-with-a-slash glyph while the runtime is `down`, and a send does not start a reply. `status: planned`
- `status-offline-chat` still completes an on-device reply when the Mac has no network and the runtime is `up`. The status line stays `🐾 Cookie · on-device · Qwen3.6`. `status: planned`
- `status-local-only` keeps `Local-only mode` checked in every one of those states. `status: planned`
- `status-core` makes the core report `up`, accept a push to `loading` and `down`, refuse `chat.send` with `Runtime unavailable` in those states, and answer again after `up`. `status: verified (verify-evidence/m0-real-model-status/transcript.jsonl)`

## How to get to it (user POV)

- Look at the menu-bar glyph and the disabled status line.
- Open the menu and read `Local-only mode`.
- Press ⌥Space and send a message while the model is up, including with the network off.
- Send a message while the glyph is the dotted outline, or the head with a slash, and see that no reply starts.

## Driving it with verify-cookie

Preconditions:

- For the real core, `doctor --core real` has printed `ok`, `server cookie-core`, `runtime up Qwen3.6-35B-A3B`, `llamaPort 18080`, and `sockets loopback`.
- For the fake-core regression, doctor has printed `ok`, `runtime up fake-local`, and `llamaPort 18080`.
- The drive uses a fresh `COOKIE_DATA_DIR` and port `18080`.
- Do not open a connection to `127.0.0.1:8080`.

- **Real core states.** Run `.cursor/skills/verify-cookie/bin/drive-core drive model-status --evidence verify-evidence/m0-real-model-status --core real`. Exit code is 0. Stdout contains `loading refused`, `down refused`, `recovered stop`, and on Linux `verified-unreachable on Linux: requires macOS`. The transcript shows server `cookie-core`, then `runtime.status` `up` / `Qwen3.6-35B-A3B` after `initialize`, a query that echoes that state, a push to `loading` with `modelId` `Qwen3.6-35B-A3B`, a `chat.send` error code `-32002` and message `Runtime unavailable` with reason `runtime is loading`, a push to `down` with `modelId` null, the same error with reason `runtime is down`, a push back to `up` / `Qwen3.6-35B-A3B`, and a `chat.done` `stop` with usage `inputTokens` 20 / `outputTokens` 11. This command's core half can pass without the menu bar being visible. It does not verify the glyph sub-features.
- **Fake core states.** Run `.cursor/skills/verify-cookie/bin/drive-core drive model-status --evidence verify-evidence/m0-model-status`. Exit code is 0. Stdout contains `loading refused`, `down refused`, and `recovered stop`. The transcript shows `runtime.status` `up` / `fake-local` after `initialize`, then a push to `loading` with `modelId` `Qwen3.6-35B-A3B`, a `chat.send` error code `-32002` and message `Runtime unavailable`, a push to `down` with `modelId` null, the same error, a push back to `up` / `fake-local`, and a `chat.done` `stop`. On Linux the stdout also contains `verified-unreachable on Linux: requires macOS`. This recipe does not replace the real-core transcript cited on `status-core`.
- **Glyphs. Mac proof is pending.** On Linux, `.cursor/skills/verify-cookie/bin/drive-core drive menu-bar-icon` exits 2 and stdout is `verified-unreachable on Linux: requires macOS`. `.cursor/skills/verify-cookie/bin/drive-mac menu-bar-icon` does the same. `drive-mac` does not itself push `loading` or `down`. That push stays the core `model-status` drive. On a Mac, `up` with `modelId` `Qwen3.6-35B-A3B` shows the status line `🐾 Cookie · on-device · Qwen3.6` (`cookie.menu.status`) and the badge `on-device` on a reply. Any other id, including `fake-local`, is shown raw. A missing `modelId` shortens the line to `🐾 Cookie · on-device`. `loading` shows the dotted-outline glyph, VoiceOver `Cookie, loading` (`cookie.menu.icon`), and the status line `🐾 Cookie · starting model…`. `down` shows the head with a slash, VoiceOver `Cookie, offline`, and the status line `🐾 Cookie · model offline`. Those two status strings are placeholder copy pending John's review. Glyphs and VoiceOver labels stay as above. Return does not add a `cookie` turn. The draft stays in the field. One quiet line under the field (`cookie.popup.refusal`) reads `Cookie's model isn't ready yet.` That sentence is placeholder copy pending John's review. The badge is not `cloud`. `Local-only mode` (`cookie.menu.local-only`) stays checked in all three states. Down and loading override an open popup and an in-flight reply. Leave the glyph sub-features `planned` until the Principal Engineer captures that evidence.
- **No network, model up.** With the runtime `up`, turn the network off and send from `Ask Cookie…`. The reply finishes and the badge reads `on-device`. The status line does not change to a slash. The slash is for `down`, not for a missing network.

## Gotchas

- The fake core starts at `up` / `fake-local`. That string is not `Qwen3.6`. The real core's cited transcript starts at `up` / `Qwen3.6-35B-A3B`. The menu shows `Qwen3.6` only for `modelId` `Qwen3.6-35B-A3B`.
- The character sheet says the offline pose covers "no network (local still works)" and "the model isn't loaded". For M0 the slash means the model is `down`. No network with the model `up` still chats and keeps the on-device status line.
- Loading in the design doc is about 9 s warm and 27 s cold on the M1 Max. The check is the glyph and the refused send, not those durations.
- A `runtime.status` line inside the chat-streaming transcript does not verify this feature. The chat drive never enters `loading` or `down`.
- Do not curl or open port `8080` to see if John's model is up. The fake-core doctor checks that process's own file descriptors (`sockets none`). The real-core doctor allows a socket only when its peer is `127.0.0.1:18080` (`sockets loopback`).
