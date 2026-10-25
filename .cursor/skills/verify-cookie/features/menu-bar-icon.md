# Menu bar icon

The menu bar shows Cookie. The status line says whether the on-device model is the one answering, and the menu can open the popup or quit.

## Sub-features

- `menu-icon-present` shows a Cookie menu-bar item while the app is running. Verified by Sergey on the Mac, 2026-10-25, commit c89adc6. `status: verified (verify-evidence/m0-mac-real/)`
- `menu-status-up` shows the disabled status line `🐾 Cookie · on-device · Qwen3.6` when the runtime is up and `modelId` is `Qwen3.6-35B-A3B`. Verified by Sergey on the Mac, 2026-10-25, commit c89adc6. `status: verified (verify-evidence/m0-mac-real/)`
- `menu-ask` shows `Ask Cookie…` with the shortcut ⌥Space. Verified by Sergey on the Mac, 2026-10-25, commit c89adc6. `status: verified (verify-evidence/m0-mac-real/)`
- `menu-local-only` shows `Local-only mode` checked. That is the M0 default. `status: planned`
- `menu-quit` shows `Quit Cookie` with ⌘Q, and choosing it exits the app. Verified by Sergey on the Mac, 2026-10-25, commit c89adc6. `status: verified (verify-evidence/m0-mac-real/)`
- `menu-option-click` opens the popup when the icon is option-clicked. `status: planned`
- `menu-thinking` shows the Thinking glyph and the VoiceOver label `Cookie, thinking` while a reply is streaming. `status: planned`

## How to get to it (user POV)

- Look at the menu bar for the Cookie icon.
- Click the icon to open the menu.
- Option-click the icon to open the popup.
- Choose `Ask Cookie…`.
- Choose `Quit Cookie`.

## Driving it with verify-cookie

Preconditions:

- Doctor has printed `ok` for this run, or this command is the reachability check itself.
- `COOKIE_LLAMA_PORT` is not `8080`.
- The Mac app is not running from a previous session.

- **Linux today.** Run `.cursor/skills/verify-cookie/bin/drive-core drive menu-bar-icon`. Exit code is 2. Stdout is `verified-unreachable on Linux: requires macOS`. `.cursor/skills/verify-cookie/bin/drive-mac menu-bar-icon` exits 2 with that same line on Linux.
- **Mac proof.** The app is in `app/`. Do not mark these verified from a core transcript. Sergey ran `.cursor/skills/verify-cookie/bin/drive-mac chat --runtime real` on the Mac on 2026-10-25 at commit c89adc6, with a fresh temp `COOKIE_DATA_DIR`. Exit code was 0. Evidence is `verify-evidence/m0-mac-real/` (gitignored). That run verified `menu-icon-present`, `menu-status-up`, `menu-ask`, and `menu-quit`. `menu-local-only`, `menu-option-click`, and `menu-thinking` stay `planned`.
- **Identifiers.** Menu bar icon `cookie.menu.icon` (VoiceOver `Cookie`, `Cookie, listening`, `Cookie, thinking`, `Cookie, loading`, or `Cookie, offline`). Status line `cookie.menu.status`. `Ask Cookie…` is `cookie.menu.ask`. `Local-only mode` is `cookie.menu.local-only`. `Quit Cookie` is `cookie.menu.quit`.
- **Mac recipe.** Package with `app/Scripts/package-app.sh`. Use a fresh `COOKIE_DATA_DIR`, `COOKIE_LLAMA_PORT=18080`, and `COOKIE_APP` pointing at `dist/Cookie Agent.app`. Run `.cursor/skills/verify-cookie/bin/drive-mac menu-bar-icon`. Launch the binary inside the bundle, not `open`. The menu contains `Ask Cookie…` (shortcut ⌥Space), a checked `Local-only mode`, and `Quit Cookie` (⌘Q). Against the fake core the disabled status line is `🐾 Cookie · on-device · fake-local`. It reads `🐾 Cookie · on-device · Qwen3.6` only when `runtime.status` is `up` and `modelId` is `Qwen3.6-35B-A3B`. `.cursor/skills/verify-cookie/bin/drive-mac chat --runtime real` waits at least 120 seconds for that on-device line (a model name after `🐾 Cookie · on-device · `) and does not accept `fake-local`. Choosing `Quit Cookie` leaves no Cookie menu-bar item. After that quit, if this launch wrote `<COOKIE_DATA_DIR>/logs/llama-server.pid`, that pid is not a live `llama-server` and nothing is listening on the port the app used (`18080` for the fake core, `8080` when `COOKIE_LLAMA_PORT` is unset). A server the app did not launch is still listening. `drive-mac` also `kill -9`s the app, relaunches it, and checks there are at most two `llama-server` processes, chat and embeddings (each old pid is gone or reused). It waits until no `CookieAgent` is running, then launches with `open -n` and no `COOKIE_*` variables. The new pid is the one that was not running before that `open`. The core's working directory must be the repo (`core/package.json`). It sends `kill -TERM` to that pid only after `<dataDir>/logs/cookie-shell.log` contains `signals installed pid=<that pid>`. Both ports must be clear and the pids from `llama-server.pid` and `llama-embed.pid` dead. The app must not still be running. A missing repo shows `🐾 Cookie · core not found`. A missing `pnpm` shows `🐾 Cookie · pnpm not found`. Any other missing command shows `🐾 Cookie · core can't start`. The 2026-10-25 real-runtime run also passed kill -9 orphan reap, Quit reap, `open -n` with no `COOKIE_*` variables, and a targeted SIGTERM reap. Those checks have no separate sub-feature id. `menu-local-only` stays `planned` because the drive reads menu-item names and does not read the check mark. `menu-option-click` stays `planned` because `drive-mac chat` does not option-click. `menu-thinking` stays `planned` because the drive does not read the Thinking VoiceOver label.
- **Option-click.** Option-click the icon (`cookie.menu.icon`). The popup opens. Its field is labelled `Ask Cookie…` (`cookie.popup.input`). `drive-mac menu-bar-icon` checks this after the menu strings and exits non-zero if the window does not appear. The primary open for a chat drive is the `Ask Cookie…` menu item.
- **Thinking.** Send a message (see chat streaming). While deltas are arriving, VoiceOver on the menu-bar item is `Cookie, thinking`, and the glyph is the head plus a small 2-dot mark. After `chat.done`, with the popup still open, the glyph is Listening (ears raised), not Thinking.

## Gotchas

- The full menu in the UI spec also lists `Ask about this window…`, `Today's brief`, `Memory…`, and `Settings…`. Those are later milestones. M0's menu is the status line, `Ask Cookie…`, `Local-only mode`, and `Quit Cookie`.
- `Local-only mode` is the item's name. The check mark is state, not part of the label.
- The status line uses the ellipsis character in neighbouring items (`Ask Cookie…`), and the middle dot in `Cookie · on-device · Qwen3.6`. Do not accept three ASCII dots or a hyphen as the same string. While loading, the status item reads `🐾 Cookie · starting model…`. While down, it reads `🐾 Cookie · model offline`. Both are placeholder copy pending John's review. The glyph and VoiceOver label do not change with that copy.
- Do not drive a Cookie that was already in the menu bar. Start the app under test with a fresh `COOKIE_DATA_DIR` and `COOKIE_LLAMA_PORT=18080`.
- Template images only. The menu bar does not run the Rive animation.
- A status line that never reaches `on-device`, or a port other than the one the recipe set, usually means a `COOKIE_*` variable leaked from an earlier shell. Read `dataDirSource` and `port` in `<COOKIE_DATA_DIR>/logs/cookie-shell.log` before calling it a product bug.
- After `Quit Cookie`, the owned `llama-server` can take about 5 seconds to die. It ignores SIGTERM until the SIGKILL. Poll the pid and the port; do not check once.
- Reading the menu leaves the app in event-tracking run-loop mode. A quit or SIGTERM sent while that mode is active must still end the app. If it does not, `sample <pid>` before killing it.
