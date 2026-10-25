# app

Swift shell for Cookie. macOS 14 or later. Swift 6.

The shell is a non-sandboxed menu-bar app. It owns the popup, spawns the core, and supervises `llama-server` when the core is the real one. The default core command is `pnpm --filter @cookie-agent/core start`. `COOKIE_CORE_COMMAND` can still select the fake core, and that path does not launch `llama-server`.

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

`COOKIE_CORE_COMMAND` is optional. When it is unset, the shell runs `pnpm --filter @cookie-agent/core start` (the `start` script in `core/package.json`, `src/index.ts`). The shell resolves `pnpm` to an absolute path and adds `/opt/homebrew/bin`, `/usr/local/bin`, `~/Library/pnpm`, and `~/.local/share/pnpm` to `PATH`, because Finder and `open` only provide `/usr/bin:/bin:/usr/sbin:/sbin`. Set `COOKIE_CORE_COMMAND` to `pnpm --filter @cookie-agent/core fake-core` for the canned core. `COOKIE_CORE_CWD` still overrides the working directory. Without it, the shell uses Info.plist `CookieRepoRoot` (written by `package-app.sh`), then `<bundle>/../..`, then a walk up from the current directory. The chosen directory must contain `core/package.json`. If it does not, the menu status is `🐾 Cookie · core not found`. If `pnpm` cannot be resolved, the status is `🐾 Cookie · pnpm not found`. Any other missing command is `🐾 Cookie · core can't start`. These lines are placeholder copy pending John's review. A `SIGTERM` or `SIGINT` (`kill -TERM` on the app's pid) calls `NSApp.terminate` from the main run loop, including while a status menu is tracking events, so Quit's reap path runs. The reply to `.terminateLater` is also a run-loop block in the modal-panel mode. A main-queue block cannot deliver that reply: the queue does not drain while `terminate` is still inside it, and the app stays up after the server is already gone. The same `cookie-shell:` lines are appended to `<dataDir>/logs/cookie-shell.log`, because `open` discards stderr. After the signal sources are installed the log contains `signals installed pid=<pid>`, and that pid is written to `<dataDir>/logs/cookie-agent.pid`.

If `COOKIE_DATA_DIR` is unset, the shell uses `~/Library/Application Support/com.johnkimec.cookie-agent`. The startup log names that path, `dataDirSource=default`, and the resolved port (`8080` when `COOKIE_LLAMA_PORT` is unset). An inherited `COOKIE_DATA_DIR` is `dataDirSource=environment`. The shell still leaves `COOKIE_LLAMA_PORT` unset for the core when it was unset, so the core applies `8080` itself. Verification that uses the fake core must export `18080` and a fresh `COOKIE_DATA_DIR`. An explicit port, including `8080`, is passed through. `/tmp/cookie-m0.*` is only the `mktemp` in the launch recipe above. It is not a saved default.

With the real core, the shell launches `llama-server` unless `GET http://127.0.0.1:$port/health` is already healthy. The command is `llama-server -m <model> --host 127.0.0.1 --port <port> -c 32768 -np 1 -ngl 99 -fa on --jinja --metrics`. The binary defaults to `/opt/homebrew/bin/llama-server` (`COOKIE_LLAMA_SERVER` overrides it). The model defaults to `~/cookie-runtime/models/Qwen3.6-35B-A3B-Q4_K_M.gguf` (`COOKIE_MODEL_PATH` overrides it). Stdout and stderr append to `<dataDir>/logs/llama-server.log`. The pid and process group are recorded in `<dataDir>/logs/llama-server.pid`, and that path is logged. When `COOKIE_DATA_DIR` was unset, the same record is also written to `~/cookie-runtime/run/llama-server-<port>.pid`. A live pid from that file is reused when the port is healthy, or killed before a new server starts. A crash restarts with backoff (1s, then 2s). The third failure in a row sets runtime status to `down`. Quit sends SIGTERM to a server this app started, waits about 5 seconds, then SIGKILL, and deletes the pid file only after the process has exited. The app does not finish terminating until then. A healthy server it did not start is left running.

`swift test --package-path app` builds the tests. `swift run --package-path app CookieAgent` runs the same executable without the bundle. The bundle's display name is Cookie. The file name is `Cookie Agent.app`.

The same supervisor also starts an embedding `llama-server` when the model file is present. The command is `llama-server --embeddings --pooling mean -m <model> --host 127.0.0.1 --port <port> -ngl 99 -c 8192 -np 4 -b 2048 -ub 2048`. The binary is the same `COOKIE_LLAMA_SERVER` override. The model defaults to `~/cookie-runtime/models/nomic-embed-text-v1.5.Q8_0.gguf` (`COOKIE_EMBED_MODEL_PATH` overrides it). The port defaults to `8081` (`COOKIE_EMBED_PORT`). The shell writes that resolved port into the core child's environment even when the parent left `COOKIE_EMBED_PORT` unset. Logs go to `<dataDir>/logs/llama-embed.log`. Pid files are `<dataDir>/logs/llama-embed.pid` and, when `COOKIE_DATA_DIR` was unset, `~/cookie-runtime/run/llama-server-<port>.pid`. A missing model file is logged and skipped. Embedder crashes do not change the menu status or block Send. Quit and SIGTERM wait until both owned servers have exited, then delete each pid file.

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
| Stop (same control, while a reply is arriving) | `cookie.popup.stop` | `Stop` |
| Refusal line | `cookie.popup.refusal` | `Cookie's model isn't ready yet.` or `Cookie's still answering.` |
| Loading line | `cookie.popup.loading` | `Loading the model…` |
| You turn | `cookie.turn.you.<n>` | `you` |
| Cookie turn | `cookie.turn.cookie.<n>` | `cookie` |
| Badge | `cookie.badge.on-device.<n>` | `on-device` |

Turn indexes start at 0 for each role, so the first reply is `cookie.turn.cookie.0`. Each identifier is on exactly one AppKit element: the text view, a reply field, the send button, or the mascot box. The hosting view does not publish those views again. A SwiftUI modifier on `Text` is not what System Events reads.

The Mac recipe is `.cursor/skills/verify-cookie/bin/drive-mac`. It does not run in CI. Feature statuses stay `planned` until that recipe's evidence is captured on a Mac.

## M0 scope

The menu is the status line, `Ask Cookie…`, a checked `Local-only mode`, and `Quit Cookie`. The mascot is a static SwiftUI drawing, not Rive. There is no screen chip. While `runtime.status` is `loading` and no reply is arriving, Send is disabled and the popup shows `Loading the model…` (`cookie.popup.loading`) instead of the refusal line. A `chat.send` error `-32002` while the runtime is not `down` is that loading state. Once the runtime is `up`, the menu status line includes the model name (`Qwen3.6` for `Qwen3.6-35B-A3B`). While a reply is arriving, that same control is Stop (`cookie.popup.stop`, label `Stop`) and stays enabled. Return and Stop send one `chat.cancel`. The partial reply stays. The control returns to `⏎` (`cookie.popup.send`) when `chat.done` arrives or the cancel result arrives. Escape during a reply stops it and leaves the panel open. Escape when nothing is streaming closes the panel. Clicking outside closes the panel and does not cancel. `Loading the model…` and `Stop` are placeholder copy pending John's review.
