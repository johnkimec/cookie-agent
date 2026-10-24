# Model status and offline

The menu bar tells John whether the on-device model is up, loading, or down. With the model up, a reply still completes with no network. Cookie does not switch to a cloud model.

## Sub-features

- `status-up` shows `🐾 Cookie · on-device · Qwen3.6` and answers a chat while `runtime.status` is `up` for `Qwen3.6-35B-A3B`. `status: planned`
- `status-loading` shows the dotted-outline glyph while the runtime is `loading`, and a send does not start a reply. `status: planned`
- `status-down` shows the head-with-a-slash glyph while the runtime is `down`, and a send does not start a reply. `status: planned`
- `status-offline-chat` still completes an on-device reply when the Mac has no network and the runtime is `up`. The status line stays `🐾 Cookie · on-device · Qwen3.6`. `status: planned`
- `status-local-only` keeps `Local-only mode` checked in every one of those states. `status: planned`
- `status-core` makes the core report `up`, accept a push to `loading` and `down`, refuse `chat.send` with `Runtime unavailable` in those states, and answer again after `up`. `status: planned`

## How to get to it (user POV)

- Look at the menu-bar glyph and the disabled status line.
- Open the menu and read `Local-only mode`.
- Press ⌥Space and send a message while the model is up, including with the network off.
- Send a message while the glyph is the dotted outline, or the head with a slash, and see that no reply starts.

## Driving it with verify-cookie

Preconditions:

- Doctor has printed `ok`, `runtime up fake-local`, and `llamaPort 18080`.
- The drive uses a fresh `COOKIE_DATA_DIR` and port `18080`.
- Do not open a connection to `127.0.0.1:8080`.

- **Core states.** Run `.cursor/skills/verify-cookie/bin/drive-core drive model-status --evidence verify-evidence/m0-model-status`. Exit code is 0. Stdout contains `loading refused`, `down refused`, and `recovered stop`. The transcript shows `runtime.status` `up` / `fake-local` after `initialize`, then a push to `loading` with `modelId` `Qwen3.6-35B-A3B`, a `chat.send` error code `-32002` and message `Runtime unavailable`, a push to `down` with `modelId` null, the same error, a push back to `up` / `fake-local`, and a `chat.done` `stop`. This command's core half can pass without the menu bar being visible. Leave `status-core` planned until a pull request cites that evidence path. On Linux the stdout also contains `verified-unreachable on Linux: requires macOS`.
- **Glyphs, once the app exists.** The unmet precondition on Linux is macOS. Run `.cursor/skills/verify-cookie/bin/drive-core drive menu-bar-icon`. Exit code is 2 and stdout is `verified-unreachable on Linux: requires macOS`. When the app exists: `up` with `modelId` `Qwen3.6-35B-A3B` shows the status line `🐾 Cookie · on-device · Qwen3.6` and the badge `on-device` on a reply. `loading` shows the dotted-outline glyph and Return does not add a `cookie` turn. `down` shows the head with a slash, Return does not add a `cookie` turn, and the badge is not `cloud`. `Local-only mode` stays checked in all three states.
- **No network, model up.** With the runtime `up`, turn the network off and send from `Ask Cookie…`. The reply finishes and the badge reads `on-device`. The status line does not change to a slash. The slash is for `down`, not for a missing network.

## Gotchas

- The fake core starts at `up` / `fake-local`. That string is not `Qwen3.6`. The menu shows `Qwen3.6` only for `modelId` `Qwen3.6-35B-A3B`.
- The character sheet says the offline pose covers "no network (local still works)" and "the model isn't loaded". For M0 the slash means the model is `down`. No network with the model `up` still chats and keeps the on-device status line.
- Loading in the design doc is about 9 s warm and 27 s cold on the M1 Max. The check is the glyph and the refused send, not those durations.
- A `runtime.status` line inside the chat-streaming transcript does not verify this feature. The chat drive never enters `loading` or `down`.
- Do not curl or open port `8080` to see if John's model is up. The doctor checks the fake core's own file descriptors instead.
