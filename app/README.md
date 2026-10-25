# app

Swift shell for Cookie. macOS 14 or later. Swift 6.

The shell is a non-sandboxed menu-bar app. It owns the popup and spawns the core. It does not supervise `llama-server`. The core today is the fake core.

| Target | What it is |
| --- | --- |
| `CookieProtocol` | Codable JSON-RPC 0.1 types and the newline codec. |
| `CookieCore` | Glyph rules, draft and transcript state, process launch, supervisor. |
| `CookieAgent` | `MenuBarExtra`, the ⌥Space `NSPanel`, and the placeholder mascot. |

Tests are XCTest. They round-trip `protocol/examples/` and, when `pnpm` and Node are on `PATH`, spawn the fake core. Set `COOKIE_REQUIRE_FAKE_CORE=1` to fail instead of skip when those tools are missing. macOS CI does that.

## Launch on a Mac

From the repository root, with Node 22 and pnpm 10. Run the executable. `open` starts the app through LaunchServices and drops `COOKIE_DATA_DIR`.

```bash
pnpm install
app/Scripts/package-app.sh
export COOKIE_DATA_DIR="$(mktemp -d /tmp/cookie-m0.XXXXXX)"
export COOKIE_LLAMA_PORT=18080
export COOKIE_CORE_CWD="$(pwd)"
export COOKIE_CORE_COMMAND="pnpm --filter @cookie-agent/core fake-core"
"dist/Cookie Agent.app/Contents/MacOS/CookieAgent"
```

`COOKIE_CORE_COMMAND` is optional. The default is that same `pnpm` invocation, split on whitespace, run via `/usr/bin/env`. `COOKIE_CORE_CWD` defaults to the repo root when `pnpm-workspace.yaml` can be found by walking up from the working directory.

If `COOKIE_DATA_DIR` is unset, the shell creates a directory under the temporary directory and passes that to the child. It does not create `~/Library/Application Support/Cookie`. That temporary default moves to Application Support when memory lands. If `COOKIE_LLAMA_PORT` is unset or empty, the shell leaves it unset. The core then uses the product default `8080`. Verification must export `18080` itself. An explicit port, including `8080`, is passed through.

`swift test --package-path app` builds the tests. `swift run --package-path app CookieAgent` runs the same executable without the bundle. The bundle's display name is Cookie. The file name is `Cookie Agent.app`.

Quit with the menu item `Quit Cookie`. The global hotkey is ⌥Space. Another app may already own that key; the shell logs `RegisterEventHotKey failed` when registration loses.

## Accessibility identifiers

| Control | Identifier | Label |
| --- | --- | --- |
| Menu bar icon | `cookie.menu.icon` | `Cookie`, `Cookie, listening`, `Cookie, thinking`, `Cookie, loading`, or `Cookie, offline` |
| Status line | `cookie.menu.status` | `🐾 Cookie · on-device · …` |
| Ask Cookie… | `cookie.menu.ask` | `Ask Cookie…` |
| Local-only mode | `cookie.menu.local-only` | `Local-only mode` |
| Quit Cookie | `cookie.menu.quit` | `Quit Cookie` |
| Popup panel | `cookie.popup` | `Ask Cookie…` |
| Input | `cookie.popup.input` | `Ask Cookie…` |
| Mascot | `cookie.popup.mascot` | `Cookie, listening`, `Cookie, thinking`, `Cookie, talking`, or `Cookie, offline` |
| Send mark | `cookie.popup.send` | `⏎` |
| Refusal line | `cookie.popup.refusal` | `Cookie's model isn't ready yet.` or `Cookie's still answering.` |
| You turn | `cookie.turn.you.<n>` | `you` |
| Cookie turn | `cookie.turn.cookie.<n>` | `cookie` |
| Badge | `cookie.badge.on-device.<n>` | `on-device` |

Turn indexes start at 0 for each role, so the first reply is `cookie.turn.cookie.0`. Each identifier is on exactly one AppKit element: the text view, a reply field, the send button, or the mascot box. The hosting view does not publish those views again. A SwiftUI modifier on `Text` is not what System Events reads.

The Mac recipe is `.cursor/skills/verify-cookie/bin/drive-mac`. It does not run in CI. Feature statuses stay `planned` until that recipe's evidence is captured on a Mac.

## M0 scope

The menu is the status line, `Ask Cookie…`, a checked `Local-only mode`, and `Quit Cookie`. The mascot is a static SwiftUI drawing, not Rive. There is no cancel control, no screen chip, and no llama-server supervisor. Escape closes the popup and does not cancel a stream.
