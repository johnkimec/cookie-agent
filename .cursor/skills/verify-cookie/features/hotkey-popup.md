# Hotkey popup

⌥Space opens a non-activating panel. John types in `Ask Cookie…` and presses Return to send. Escape closes the panel.

## Sub-features

- `popup-hotkey` toggles the popup with ⌥Space. `status: planned`
- `popup-escape` closes the popup with Escape. `status: planned`
- `popup-click-outside` closes the popup when the user clicks outside it. `status: planned`
- `popup-option-click` opens the popup from an option-click on the menu-bar icon. `status: planned`
- `popup-input` shows the field `Ask Cookie…`. Return sends. Shift-Return inserts a newline. ⌘K clears the field. Up edits the last message. `status: planned`
- `popup-nonactivating` leaves the previously frontmost app frontmost. `status: planned`
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
- **Mac proof is pending.** The panel is in `app/`. Every status below stays `planned` until the Principal Engineer runs the Mac recipe and writes `verify-evidence/`.
- **Identifiers.** Panel `cookie.popup`. Field `cookie.popup.input`, label `Ask Cookie…`. Mascot `cookie.popup.mascot` (40 pt; VoiceOver `Cookie, listening`, `Cookie, thinking`, `Cookie, talking`, or `Cookie, offline`). Send mark `cookie.popup.send`, label `⏎`.
- **Open.** Package with `app/Scripts/package-app.sh`. Fresh `COOKIE_DATA_DIR`, `COOKIE_LLAMA_PORT=18080`, `COOKIE_APP` pointing at `dist/Cookie Agent.app`. Run `.cursor/skills/verify-cookie/bin/drive-mac hotkey-popup`. The primary open is the menu item `Ask Cookie…`, not a synthetic ⌥Space. A panel titled `Ask Cookie…` appears, subrole `AXSystemDialog`, and the previously frontmost app stays frontmost. Read elements by `AXIdentifier`. Do not coerce `entire contents` to a string. `cookie.popup.input` must be present. Ask for the frontmost process from System Events, outside `tell process "CookieAgent"`. Option-click is a second check and must also open that window. A synthetic ⌥Space may not reach the global hotkey. If a physical ⌥Space leaves the panel closed, say which app owns it. Do not remap the shortcut. A failed step exits non-zero. Status stays `planned`.
- **Send.** Type a line and press Return. The field submits. Shift-Return does not submit. It adds a line, up to 5. ⌘K leaves the field empty. Up at the start of the field recalls the last `you` text into the draft and does not delete the turn.
- **Close.** Press Escape. The panel is gone and the draft is kept. Press ⌥Space again within 10 minutes. The unsent draft is still in the field. After 10 minutes it is cleared. Click outside the panel. The panel closes. Option-click the menu-bar icon. The panel opens.
- **Screenshot.** `screencapture -x` of that panel shows the 40 pt Cookie at the left of the input row and the label `Ask Cookie…`.

## Gotchas

- ⌥Space is the default in the UI spec and it is rebindable later. M0's check is the default binding.
- Escape closes the popup. The UI spec does not define Escape as cancel. A streaming reply is not proven cancelled by closing the panel until a later decision says so.
- The panel is non-activating, so it may not be the frontmost accessibility app. Target the label `Ask Cookie…`, not "the frontmost window".
- An `osascript` handler does not inherit `tell application "System Events"`. `value of attribute "AXIdentifier"` in that handler is a compile error (`-2741`). The handler tells System Events itself.
- Clicking outside does not close the panel when an action card is pending. M0 has no action cards, so a click outside closes it.
- Another app may already own ⌥Space. If the popup does not open, say which app took the hotkey. Do not remap John's shortcut to force the check.
