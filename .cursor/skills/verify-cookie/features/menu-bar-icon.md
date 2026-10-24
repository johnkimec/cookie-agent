# Menu bar icon

The menu bar shows Cookie. The status line says whether the on-device model is the one answering, and the menu can open the popup or quit.

## Sub-features

- `menu-icon-present` shows a Cookie menu-bar item while the app is running. `status: planned`
- `menu-status-up` shows the disabled status line `🐾 Cookie · on-device · Qwen3.6` when the runtime is up and `modelId` is `Qwen3.6-35B-A3B`. `status: planned`
- `menu-ask` shows `Ask Cookie…` with the shortcut ⌥Space. `status: planned`
- `menu-local-only` shows `Local-only mode` checked. That is the M0 default. `status: planned`
- `menu-quit` shows `Quit Cookie` with ⌘Q, and choosing it exits the app. `status: planned`
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

- **Linux today.** Run `.cursor/skills/verify-cookie/bin/drive-core drive menu-bar-icon`. Exit code is 2. Stdout is `verified-unreachable on Linux: requires macOS`.
- **Status line, once the app exists on macOS.** The same command is the one to extend. Until then the unmet precondition is macOS and the MenuBarExtra from task B. The disabled status item reads `🐾 Cookie · on-device · Qwen3.6` when `runtime.status` is `up` and `modelId` is `Qwen3.6-35B-A3B`. Against the fake core the id is `fake-local`, and the status line shows `fake-local`, not `Qwen3.6`.
- **Ask and quit.** The menu contains `Ask Cookie…` (shortcut ⌥Space), a checked `Local-only mode`, and `Quit Cookie` (⌘Q). Choosing `Quit Cookie` leaves no Cookie menu-bar item.
- **Option-click.** Option-click the icon. The popup opens. Its field is labelled `Ask Cookie…`.
- **Thinking.** Send a message (see chat streaming). While deltas are arriving, VoiceOver on the menu-bar item is `Cookie, thinking`, and the glyph is the head plus a small 2-dot mark. After `chat.done`, with the popup still open, the glyph is Listening (ears raised), not Thinking.

## Gotchas

- The full menu in the UI spec also lists `Ask about this window…`, `Today's brief`, `Memory…`, and `Settings…`. Those are later milestones. M0's menu is the status line, `Ask Cookie…`, `Local-only mode`, and `Quit Cookie`.
- `Local-only mode` is the item's name. The check mark is state, not part of the label.
- The status line uses the ellipsis character in neighbouring items (`Ask Cookie…`), and the middle dot in `Cookie · on-device · Qwen3.6`. Do not accept three ASCII dots or a hyphen as the same string.
- Do not drive a Cookie that was already in the menu bar. Start the app under test with a fresh `COOKIE_DATA_DIR` and `COOKIE_LLAMA_PORT=18080`.
- Template images only. The menu bar does not run the Rive animation.
