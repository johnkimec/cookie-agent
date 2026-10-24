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

- **Linux today.** Run `.cursor/skills/verify-cookie/bin/drive-core drive hotkey-popup`. Exit code is 2. Stdout is `verified-unreachable on Linux: requires macOS`.
- **Open, once the app exists on macOS.** The same command is the one to extend. The unmet precondition is macOS and the NSPanel from task B. Press ⌥Space. A panel appears in the upper third of the active screen. The text field's accessibility label is `Ask Cookie…`. The previously frontmost app is still frontmost.
- **Send.** Type a line and press Return. The field submits. Shift-Return does not submit. It adds a line. ⌘K leaves the field empty.
- **Close.** Press Escape. The panel is gone. Press ⌥Space again within 10 minutes. An unsent draft is still in the field. Click outside the panel. The panel closes. Option-click the menu-bar icon. The panel opens.
- **Screenshot.** `screencapture -x` of that panel shows the 40 pt Cookie at the left of the input row and the label `Ask Cookie…`.

## Gotchas

- ⌥Space is the default in the UI spec and it is rebindable later. M0's check is the default binding.
- Escape closes the popup. The UI spec does not define Escape as cancel. A streaming reply is not proven cancelled by closing the panel until a later decision says so.
- The panel is non-activating, so it may not be the frontmost accessibility app. Target the label `Ask Cookie…`, not "the frontmost window".
- Clicking outside does not close the panel when an action card is pending. M0 has no action cards, so a click outside closes it.
- Another app may already own ⌥Space. If the popup does not open, say which app took the hotkey. Do not remap John's shortcut to force the check.
