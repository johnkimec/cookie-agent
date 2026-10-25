# Hotkey popup

⌥Space opens a non-activating panel. John types in `Ask Cookie…` and presses Return to send. Escape closes the panel.

## Sub-features

- `popup-hotkey` toggles the popup with ⌥Space. `status: planned`
- `popup-escape` closes the popup with Escape. `status: planned`
- `popup-click-outside` closes the popup when the user clicks outside it. `status: planned`
- `popup-option-click` opens the popup from an option-click on the menu-bar icon. `status: planned`
- `popup-input` shows the field `Ask Cookie…`. Return sends. Shift-Return inserts a newline. ⌘K clears the field. Up edits the last message. `status: planned`
- `popup-input-grow` shows one line when the field is empty, grows with the draft up to 8 lines, then scrolls inside the field. Return still sends. ⌘K still clears. `status: planned`
- `popup-on-device-dot` shows one `on-device` indicator in the input row while the runtime is up (`cookie.badge.on-device`). It is not a pill beside each reply. `status: planned`
- `popup-nonactivating` leaves the previously frontmost app frontmost. Verified by Sergey on the Mac, 2026-10-25, commit c89adc6. `status: verified (verify-evidence/m0-mac-real/)`
- `popup-draft` keeps an unsent draft for 10 minutes after the popup closes. `status: planned`
- `popup-layout` is 560 pt wide, centred in the upper third of the active screen, with a 40 pt Cookie at the left of the input row. `status: planned`

## How to get to it (user POV)

- Press ⌥Space.
- Press ⌥Space again, or press Escape, or click outside the panel, to close it.
- Choose `Ask Cookie…` in the menu bar, or option-click the menu-bar icon.
- Type in the field labelled `Ask Cookie…`.

## Driving it with verify-cookie

Preconditions:

- Doctor has printed `ok` for this run, or this command is the reachability check itself.
- No Cookie popup from a previous session is on screen.
- `COOKIE_DATA_DIR` is a fresh temp directory and `COOKIE_LLAMA_PORT` is `18080`.

- **Linux today.** Run `.cursor/skills/verify-cookie/bin/drive-core drive hotkey-popup`. Exit code is 2. Stdout is `verified-unreachable on Linux: requires macOS`. `.cursor/skills/verify-cookie/bin/drive-mac hotkey-popup` exits 2 with that same line on Linux.
- **Mac proof.** The panel is in `app/`. Sergey ran `.cursor/skills/verify-cookie/bin/drive-mac chat --runtime real` on the Mac on 2026-10-25 at commit c89adc6. Exit code was 0. Evidence is `verify-evidence/m0-mac-real/`. That run opens the panel from `Ask Cookie…` and requires the previously frontmost app to stay frontmost, which verifies `popup-nonactivating`. Popup AX identifiers were unique and `cookie.popup.input` was present. `popup-hotkey`, `popup-escape`, `popup-click-outside`, `popup-option-click`, `popup-input`, `popup-draft`, and `popup-layout` stay `planned`. The drive does not press ⌥Space, Escape, click outside, option-click, Shift-Return, ⌘K, or Up, and it does not measure the panel.
- **Identifiers.** Panel `cookie.popup`. Field `cookie.popup.input`, label `Ask Cookie…`. Mascot `cookie.popup.mascot` (40 pt; VoiceOver `Cookie, listening`, `Cookie, thinking`, `Cookie, talking`, or `Cookie, offline`). Send mark `cookie.popup.send`, label `⏎`. While a reply is arriving that same control is `cookie.popup.stop`, label `Stop` (`chat-stop` in chat-streaming.md). While the runtime is `loading`, the popup shows `cookie.popup.loading` (`Loading the model…`) and does not show `cookie.popup.refusal`. Send is disabled in that state, unless a reply is already arriving, in which case the control is Stop and stays enabled. Each identifier is on exactly one element.
- **Open.** Package with `app/Scripts/package-app.sh`. Fresh `COOKIE_DATA_DIR`, `COOKIE_LLAMA_PORT=18080`, `COOKIE_APP` pointing at `dist/Cookie Agent.app`. Run `.cursor/skills/verify-cookie/bin/drive-mac hotkey-popup`. The primary open is the menu item `Ask Cookie…`, not a synthetic ⌥Space. A panel titled `Ask Cookie…` appears, subrole `AXSystemDialog`, and the previously frontmost app stays frontmost. Read elements by `AXIdentifier`. Do not coerce `entire contents` to a string. `cookie.popup.input` must be present. Ask for the frontmost process from System Events, outside `tell process "CookieAgent"`. Option-click is a second check and must also open that window. A synthetic ⌥Space may not reach the global hotkey. If a physical ⌥Space leaves the panel closed, say which app owns it. Do not remap the shortcut. A failed step exits non-zero. `popup-nonactivating` is already verified from `verify-evidence/m0-mac-real/`. The other popup sub-features stay `planned`.
- **Send.** Type a line and press Return. The field submits. Shift-Return does not submit. It adds a line. The field is one line tall, grows to 8, then scrolls. ⌘K leaves the field empty. Up at the start of the field recalls the last `you` text into the draft and does not delete the turn. The same `drive-mac popup-reply` command in chat-streaming.md checks the empty field is shorter than 48 pt and that one `cookie.badge.on-device` dot is in the input row. Leave `popup-input-grow` and `popup-on-device-dot` `planned` until that Mac evidence exists.
- **Close.** Press Escape when nothing is streaming. The panel is gone and the draft is kept. Press ⌥Space again within 10 minutes. The unsent draft is still in the field. After 10 minutes it is cleared. Click outside the panel. The panel closes. Option-click the menu-bar icon. The panel opens.
- **Screenshot.** `screencapture -x` of that panel shows the 40 pt Cookie at the left of the input row and the label `Ask Cookie…`.

## Gotchas

- ⌥Space is the default in the UI spec and it is rebindable later. M0's check is the default binding.
- Escape closes the popup when nothing is streaming. While a reply is arriving, Escape stops that reply and leaves the panel open (`chat-stop` in chat-streaming.md). Closing the panel by clicking outside does not cancel the reply.
- The panel is non-activating, so it may not be the frontmost accessibility app. Target the label `Ask Cookie…`, not "the frontmost window".
- An `osascript` handler does not inherit `tell application "System Events"`. `value of attribute "AXIdentifier"` in that handler is a compile error (`-2741`). The handler tells System Events itself. Inside that tell, `name of elem as text` is the same error: `text` is a property there. Read the property, then coerce it with `as string` outside the tell.
- Clicking outside does not close the panel when an action card is pending. M0 has no action cards, so a click outside closes it.
- An `osascript` error saying assistive access is not allowed is a permission on the parent app (Terminal, or `Grok Bot.app` for an agent run). It is not a popup bug.
- Another app may already own ⌥Space. If the popup does not open, say which app took the hotkey. Do not remap John's shortcut to force the check.
