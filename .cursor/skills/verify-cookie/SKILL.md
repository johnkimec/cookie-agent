---
name: verify-cookie
description: "Drive Cookie the way John does and capture proof. The TypeScript core is newline-delimited JSON-RPC on stdio (Linux: fake core by default, real core with --core real). The Mac menu-bar app is macOS only. drive-core does not launch it; drive-mac is the recipe. drive-mac chat --runtime real is verified at verify-evidence/m0-mac-real/ (Sergey, Mac, 2026-10-25, commit c89adc6). Other Mac sub-features stay planned. Use when proving M0 behavior, marking a verify-cookie feature verified, or checking a core change against the protocol."
---

# verify-cookie

Drive Cookie and keep the evidence. The core surface works on Linux. The default drive is the fake core. `--core real` drives the real core against a stub OpenAI-compatible server on `127.0.0.1:18080`. The Mac app is `app/`. `drive-core` does not launch it, so the menu and hotkey drives stay `verified-unreachable on Linux: requires macOS`. `drive-mac chat --runtime real` is verified at `verify-evidence/m0-mac-real/` (Sergey, Mac, 2026-10-25, commit c89adc6). Leave every other Mac sub-feature `planned` until its own evidence exists.

Keep this map honest with `/maintain-verification-skill` when the shell or the real core lands. A passing vitest run is not feature evidence. Evidence is a transcript this skill wrote under `verify-evidence/`.

## Launch

There is no long-running server. Each drive starts its own core and that process exits on `shutdown`. `--core real` also starts a stub on port `18080` for that drive and stops it when the drive returns.

From the repository root, with Node 22.6 or newer and pnpm 10. `.nvmrc` is `22` (current Node 22). `engines` is `>=22.6`, which is the first release that can strip TypeScript. CI installs the `.nvmrc` line. Node 22.13 prints a type-stripping `ExperimentalWarning` on stderr; the launch flags below hide that warning and nothing else.

```bash
pnpm install
```

Readiness is not a log line. `.cursor/skills/verify-cookie/bin/drive-core doctor` must print a first line `ok`, then `protocolVersion 0.1`, `server cookie-fake-core`, `runtime up fake-local`, `llamaPort 18080`, and `sockets none`. The doctor spawns a core, completes `initialize`, checks that the process has no socket besides stdio, sends `shutdown`, and exits.

`.cursor/skills/verify-cookie/bin/drive-core doctor --core real` is the same handshake against the real core and the stub. It must print `server cookie-core`, `runtime up Qwen3.6-35B-A3B`, `llamaPort 18080`, and `sockets loopback`. `sockets loopback` means every non-stdio socket, if any remain open, is `127.0.0.1:18080`. The real core does dial that port. It must not dial `8080`.

The fake core never dials `llama-server`. Verification still sets `COOKIE_LLAMA_PORT=18080` and a fresh `COOKIE_DATA_DIR` so neither core can touch John's port `8080` or his data. Do not point either variable at his home directory or at port `8080`.

Teardown is `drive-core cleanup`. It does not need a running server.

## Doctor

Run this before the first drive, and again after any drive that behaved oddly.

```bash
.cursor/skills/verify-cookie/bin/drive-core doctor
```

Exit 0 and stdout:

```text
ok
node v22...
protocolVersion 0.1
server cookie-fake-core
runtime up fake-local
llamaPort 18080
sockets none
```

The `node` line is whatever Node 22 the machine is running. Any other first line is `not-ok` and the next line says why. Exit code is 1. Do not drive that instance.

`--core real` doctor stdout is the same shape with these lines changed:

```text
server cookie-core
runtime up Qwen3.6-35B-A3B
sockets loopback
```

Doctor does not write evidence. Capture it yourself when a proof needs it (see Evidence). It does leave a scratch data directory under `/tmp/cookie-verify/` for cleanup to remove.

## Drive

The helper is `.cursor/skills/verify-cookie/bin/drive-core`. It speaks the M0 protocol in `protocol/schema/cookie-rpc.schema.json`. Stable handles are the JSON-RPC method names and the UI strings in the feature files, not screen coordinates.

Core, on Linux or macOS:

```bash
.cursor/skills/verify-cookie/bin/drive-core drive chat-streaming --evidence verify-evidence/m0-chat-streaming
.cursor/skills/verify-cookie/bin/drive-core drive model-status --evidence verify-evidence/m0-model-status
.cursor/skills/verify-cookie/bin/drive-core drive chat-streaming --evidence verify-evidence/m0-real-chat-streaming --core real
.cursor/skills/verify-cookie/bin/drive-core drive model-status --evidence verify-evidence/m0-real-model-status --core real
```

`--core` is `fake` (the default) or `real`. Place it after the subcommand. `fake` spawns `core/src/fake-core.ts`. `real` spawns `core/src/index.ts` and a stub that speaks `/health` and `/v1/chat/completions` on `127.0.0.1:18080`.

`chat-streaming` sends `initialize`, reads `runtime.status` `up`, sends `chat.send` with text `hello from verify-cookie`, requires three `chat.delta` lines and `chat.done` `stop`, then sends a second `chat.send` and `chat.cancel`, requires `chat.done` `cancelled`, then `shutdown`. Stdout ends with `ok`, `deltas 3`, `finishReason stop`, and `cancelled true`. The fake core's model id is `fake-local` and the joined text is the canned fake reply. The real core's model id is `Qwen3.6-35B-A3B`, the joined text is `Hello. This reply is from the local stub, on device.`, usage is `inputTokens` 20 and `outputTokens` 11, and stdout also contains `modelAborted true` (the stub saw the HTTP request close).

`model-status` pushes `loading` with `modelId` `Qwen3.6-35B-A3B`, expects `chat.send` to fail with code `-32002`, pushes `down`, expects the same refusal, pushes `up`, and expects a recovered `chat.done` `stop`. The fake core's `up` id is `fake-local`. The real core's `up` id is `Qwen3.6-35B-A3B`. On Linux its stdout also contains `verified-unreachable on Linux: requires macOS` for the menu-bar half of that feature. Exit 0 means the core half passed. It does not mean the glyphs were seen.

Mac app:

```bash
.cursor/skills/verify-cookie/bin/drive-core drive menu-bar-icon
.cursor/skills/verify-cookie/bin/drive-core drive hotkey-popup
```

On Linux both exit 2 and stdout is exactly `verified-unreachable on Linux: requires macOS`. On macOS, `drive-core` still exits 2 with `verified-unreachable: requires the Mac app from task B`. That stub does not launch the GUI.

The recipe is `.cursor/skills/verify-cookie/bin/drive-mac`. On Linux it exits 2 with the same unreachable line. On a Mac, package the app, then run the executable yourself or let the script launch it. The script copies that app to a per-run bundle with its own executable name and bundle id, then launches that binary so a shell's `COOKIE_*` variables are kept. John's installed `CookieAgent` cannot share that identity. `open` and Finder drop those variables and use cwd `/` with a minimal `PATH`. The default mode keeps the fake core and port `18080`. `drive-mac chat --runtime real` skips that stub, leaves `COOKIE_CORE_COMMAND` unset so the app starts the real core and `llama-server`, and waits at least 120 seconds for the on-device status before one chat. The product default data directory, when `COOKIE_DATA_DIR` is unset, is `~/Library/Application Support/com.johnkimec.cookie-agent`. `drive-mac` still requires a fresh `COOKIE_DATA_DIR` and will not use Application Support. After the drive it `kill -9`s the app and relaunches to check orphaned chat and embedding `llama-server` processes are reused or gone, never doubled, then quits and checks both servers this launch started are not still listening. It then waits until that per-run executable is gone. The drive bundle sets Info.plist `CookieApplicationSupportFolder` to its bundle id and `CookieSkipHotkey`, so the copy does not register ⌥Space and open-clean uses that folder instead of the product Application Support directory. If any process whose executable basename is `CookieAgent` is already running, it still does not `open` and does not signal those pids, because the default llama port can still be John's server. macOS reports that comm as the full executable path, and `Cookie Agent.app` contains a space, so the basename is what identifies it. That skip exits 3, prints `skipped`, and does not print `ok`. When `--evidence` is set it writes `open-clean-skip.txt` in that directory. Otherwise it `open -n`s the per-run copy with no `COOKIE_*` variables and a minimal `PATH`, takes the one new pid whose process name is that copy's executable, checks the path and bundle id, and `kill -TERM`s that pid after the log line `signals installed pid=<that pid>`. Both the chat port and the embed port must be clear, and the pids from both pid files dead. `--runtime real` also waits for the on-device line on that `open` launch. Sergey captured that real-runtime drive on the Mac on 2026-10-25 at commit c89adc6. Evidence is `verify-evidence/m0-mac-real/`. Sub-features that drive does not assert stay `planned`.

```bash
export COOKIE_DATA_DIR="$(mktemp -d /tmp/cookie-m0.XXXXXX)"
export COOKIE_LLAMA_PORT=18080
export COOKIE_CORE_CWD="$(pwd)"
export COOKIE_APP="$PWD/dist/Cookie Agent.app"
.cursor/skills/verify-cookie/bin/drive-mac all
```

Real runtime on the Mac, from a clean shell. This is the drive cited on `chat-real-runtime`:

```bash
for v in $(env | sed -n 's/^\(COOKIE_[A-Z_]*\)=.*/\1/p'); do unset "$v"; done
unset NODE_OPTIONS
app/Scripts/package-app.sh
export COOKIE_DATA_DIR="$(mktemp -d /tmp/cookie-m0.XXXXXX)"
.cursor/skills/verify-cookie/bin/drive-mac chat --runtime real --evidence verify-evidence/m0-mac-real
```

Real model, core only. This aims at the product port `8080` on purpose. First check `lsof -nP -iTCP:8080 -sTCP:LISTEN`. If John's own server is already listening, drive against it and do not start or stop anything. Otherwise start one, drive, and stop only the pid you started:

```bash
/opt/homebrew/bin/llama-server -m ~/cookie-runtime/models/Qwen3.6-35B-A3B-Q4_K_M.gguf --host 127.0.0.1 --port 8080 -c 32768 -np 1 -ngl 99 -fa on --jinja --metrics > /tmp/cookie-llama.log 2>&1 &
llama_pid=$!
.cursor/skills/verify-cookie/bin/drive-core drive chat-history --evidence verify-evidence/m0-chat-history --core real --llama external
kill -TERM "$llama_pid"; sleep 6; kill -0 "$llama_pid" 2>/dev/null && kill -KILL "$llama_pid"
```

### Mac preflight

Each of these cost a failed run on 2026-10-25. Check them before the first Mac drive.

- **Accessibility belongs to the parent app.** `drive-mac` reads the menu and popup through System Events. macOS grants Accessibility to the app at the top of the process tree that runs `osascript`, not to `osascript` or the script. From Terminal that is Terminal. When an agent drives through Grok Bot's shell on the Mac, it is `Grok Bot.app`. If System Events says the process is not allowed assistive access, add that parent app under System Settings › Privacy & Security › Accessibility and rerun. Granting Terminal does not help an agent-driven run. This is a permission problem, not a Cookie bug.
- **Unset leaked environment.** A shell that ran an earlier drive still exports `COOKIE_DATA_DIR`, `COOKIE_LLAMA_PORT`, `COOKIE_CORE_COMMAND`, `COOKIE_CORE_CWD`, `COOKIE_APP`, and maybe `NODE_OPTIONS`. A stale `COOKIE_DATA_DIR` points the app at an old run's pid files and logs. An empty `COOKIE_LLAMA_PORT` leaves the app with no usable port, and the launch line reads `port=invalid`. Unset every `COOKIE_*` and `NODE_OPTIONS` first (the loop above), then export only what the recipe names. The app logs one launch line with `dataDir=`, `dataDirSource=`, and `port=` to `<COOKIE_DATA_DIR>/logs/cookie-shell.log`. Require `dataDirSource=environment`, `dataDir` equal to the directory you just made, and `port=18080` for the fake mode or `port=8080` for `--runtime real`. Anything else: run cleanup, open a fresh shell, start over.
- **A fresh data directory per run.** `drive-mac` refuses to start unless `COOKIE_DATA_DIR` is already set, and it will not use Application Support. It does not create the directory. Run `mktemp -d /tmp/cookie-m0.XXXXXX` for every run. Do not reuse the last run's directory; its pid files name processes that are gone.
- **llama-server exits slowly.** It ignores SIGTERM for about 5 seconds. Quit and SIGTERM send SIGTERM to the server's process group, wait 5 seconds, then SIGKILL. The app exits only after that: up to 5 seconds of core `shutdown`, 5 seconds of grace, a 2 second SIGKILL wait, and a 15 second reply backstop. Poll for the server to go away. A server alive 3 seconds after Quit is normal. One alive after 15 seconds is a failure.
- **Diagnose a hang with `sample`.** If `CookieAgent` is still running after Quit or SIGTERM, run `sample <pid> 5 -file verify-evidence/<run>/hang-sample.txt` before you kill it. A main thread parked under `_shouldTerminate` in a modal run loop is the `.terminateLater` deadlock (`docs/lessons.md` L-2026-10-25-10). A main thread in the status-item tracking loop is the event-tracking hop (L-2026-10-25-12). Then `kill -9` that pid only and stop the server named in `<COOKIE_DATA_DIR>/logs/llama-server.pid`.
- **Target the pid and the per-run identity, never the product name.** `drive-mac` copies the packaged app to a per-run bundle. The executable name is `CDrv` plus random hex and the bundle id is `com.johnkimec.cookie-agent.drive.<hex>`. `CFBundleName` stays `Cookie`. The product `Cookie Agent.app` is not modified. Every System Events call goes through `cookieDriveProcess()`, which requires that copy's unix id, process name, and bundle id, and errors if any of the three does not match. The product name `CookieAgent` and the bundle id `com.johnkimec.cookie-agent` are refused. Do not `tell process` by name, `tell application "Cookie Agent"`, or `quit app`. Do not `pkill`, `killall`, or `pgrep -x` `CookieAgent` or `llama-server`. Signals use only the pid this drive launched. A direct launch's pid is `$!`. An `open -n` launch is the one new pid with that per-run process name, verified before any input. The drive sends no keystrokes. A status menu left in event-tracking mode is dismissed with AXCancel and a click while AXSelected is set. Option-click posts one mouse event to the drive pid with the Option flag on that event. `drive-mac self-check` launches two copies and clicks only its own. The status menu is open only when AXSelected is yes, or that copy's menu has an on-screen position and a positive size. A closed menu still exposes its items, so an item count is not an open signal. Self-check deletes its own `/tmp/cookie-m0.*` data directory on the way out. A harness step that reads the status menu leaves the app's main thread in event-tracking run-loop mode, so a signal or quit sent right after it must still work in that mode.
- **Finder and `open` launches.** They start the app with cwd `/` and `PATH=/usr/bin:/bin:/usr/sbin:/sbin`. The app finds the repo from Info.plist `CookieRepoRoot`, which `app/Scripts/package-app.sh` writes, and then adds the Homebrew and pnpm directories to `PATH`. Repackage after moving the checkout. `🐾 Cookie · core not found` or `🐾 Cookie · pnpm not found` means that lookup failed.
- **Leave the Mac idle.** After the last drive, `lsof -nP -iTCP:8080 -sTCP:LISTEN` and `lsof -nP -iTCP:18080 -sTCP:LISTEN` show nothing this run started.

Never attach to a Cookie already running in John's session. The process name is `CookieAgent`. The input's accessibility label is `Ask Cookie…`. Identifiers are listed in `app/README.md` and the feature files. Read them with `osascript` and System Events, not a click coordinate. `drive-mac` opens the popup from the menu item `Ask Cookie…`, then reads each element's `AXIdentifier`. It does not coerce `entire contents` to a string, and it asks for the frontmost process from System Events outside the process tell. It never targets a process by name. Handlers that read `AXIdentifier` tell System Events themselves. A top-level handler does not inherit that tell, and `attribute` is then a syntax error (`-2741`). Inside that tell, `name of elem as text` is the same error, because `text` is a property; coerce with `as string` outside the tell. macOS CI compiles every embedded script with `osacompile`. Each identifier is on exactly one element. A chat drive sets `AXValue` on `cookie.popup.input` and performs `AXConfirm`. Keystrokes go to the frontmost app, not this panel. The first cookie turn is `cookie.turn.cookie.0`. `--evidence` receives `chat.txt` and `popup.png` from `screencapture -l` of the Ask Cookie window, and a chat drive exits non-zero when either file is missing. Option-click is a second open check. Any failed step exits non-zero. The menu bar's VoiceOver label while a reply streams is `Cookie, thinking`. Quit with the menu item `Quit Cookie`. Then run cleanup. Do not mark a Mac sub-feature verified from a core transcript, or from a different drive. `drive-mac chat --runtime real` on commit c89adc6 is verified by Sergey on the Mac, 2026-10-25, at `verify-evidence/m0-mac-real/`. Sub-features that drive does not assert stay `planned`.

## Evidence

Proof goes in `verify-evidence/` at the repository root. That directory is gitignored. Cleanup does not delete it.

Every core `drive` (`chat-streaming`, `model-status`, `chat-history`, `memory-persist`, `runtime-restart`) requires `--evidence <dir>`. Without it `drive-core` prints its usage, writes nothing, and exits 2. A drive that returns success exits 1 when any file below is missing or older than the start of that run. `chat-history` also requires `timings.txt`. `memory-persist` also requires `db.txt`. stderr is `drive-core: no evidence written`.

A drive writes these files into `--evidence`:

| File | What it is |
| --- | --- |
| `command.txt` | The `drive-core` invocation plus `COOKIE_DATA_DIR`, `COOKIE_LLAMA_PORT`, and `COOKIE_FAKE_DELTA_MS`. |
| `transcript.jsonl` | One JSON object per line: `seq`, `direction` (`client` or `server`), and `message` (the raw JSON-RPC value). |
| `stderr.txt` | The core's stderr. Empty on success. Node 22.13's `ExperimentalWarning: Type Stripping is an experimental feature and might change at any time` is stderr and fails the drive. Launch flags pass `--disable-warning=ExperimentalWarning` so this file stays empty. Any other stderr still fails, except the runtime-restart drive's stream error. |
| `summary.txt` | The same text the command printed. |

Doctor output is not one of those files. Record it beside them:

```bash
mkdir -p verify-evidence/m0-chat-streaming
{
  printf '%s\n' '.cursor/skills/verify-cookie/bin/drive-core doctor'
  .cursor/skills/verify-cookie/bin/drive-core doctor
} | tee verify-evidence/m0-chat-streaming/doctor.txt
```

A written claim that the reply looked right is not proof. The transcript is the command's output. For the Mac app, add the `osascript` transcript and the `screencapture` file under the same evidence directory, and keep the command that produced each file.

If a drive shows the core doing the wrong thing, `core/` has a vitest suite. Add one test that fails on that captured output and run it before changing product code. A test that already passes does not count. The product fix is a separate change.

Set a feature sub-feature to `status: verified (verify-evidence/...)` only when this skill wrote that file in the pull request. Otherwise leave `status: planned`. Do not mark a feature verified from a different feature's transcript.

## Cleanup

```bash
.cursor/skills/verify-cookie/bin/drive-core cleanup
```

Stdout is `ok`. Cleanup reads `/tmp/cookie-verify/pids/` (or `COOKIE_VERIFY_RUNTIME` if set) and signals only pids whose `/proc/<pid>/cmdline` contains `fake-core.ts` or `core/src/index.ts`. It never signals pid 1 or its own pid. It deletes scratch data directories recorded under that runtime root and nothing else. A path outside the runtime root is left alone, including `verify-evidence/` and any `COOKIE_DATA_DIR` that was not created there. The `--core real` stub runs inside the drive process and exits with it.

Run cleanup after a failed drive too, so a core is not left running. Then confirm the evidence files are still on disk.

## Helpers

`.cursor/skills/verify-cookie/bin/drive-core` is executable. It runs `node --experimental-strip-types --disable-warning=ExperimentalWarning` on `core/src/verify-drive-entry.ts` from the repository root. That file calls the exported `main()` in `core/src/verify-drive.ts` and exits with the result. Importing `verify-drive.ts` does not start a drive. The entry does not compare `import.meta.url` with `process.argv[1]`. A checkout reached through a symlink, including macOS `/tmp` → `/private/tmp`, still runs. The same two flags are on `pnpm core` and `pnpm fake-core`. The Swift app's default command is `pnpm --filter @cookie-agent/core fake-core`, so that script covers the app without a change under `app/`. Do not replace the flag with `--no-warnings`.

Exit 0 means the command ran. Doctor and cleanup do not write evidence files, and they stay exit 0 when they succeed. A core `drive` that requires `--evidence` exits 1 when `command.txt`, `transcript.jsonl`, `stderr.txt`, or `summary.txt` is missing or older than the start of that run, even if the drive reported success. `chat-history` also requires a fresh `timings.txt`. `memory-persist` also requires a fresh `db.txt`. stderr is `drive-core: no evidence written`. Executing `core/src/verify-drive.ts` directly does not run a drive: stderr is `run bin/drive-core (or verify-drive-entry.ts)` and the exit code is 1. Importing that module does not print the line. Usage, a missing `--evidence`, and the unreachable Mac drives stay exit 2.

```bash
.cursor/skills/verify-cookie/bin/drive-core doctor
.cursor/skills/verify-cookie/bin/drive-core doctor --core real
.cursor/skills/verify-cookie/bin/drive-core drive chat-streaming --evidence verify-evidence/m0-chat-streaming
.cursor/skills/verify-cookie/bin/drive-core drive model-status --evidence verify-evidence/m0-model-status
.cursor/skills/verify-cookie/bin/drive-core drive chat-streaming --evidence verify-evidence/m0-real-chat-streaming --core real
.cursor/skills/verify-cookie/bin/drive-core drive model-status --evidence verify-evidence/m0-real-model-status --core real
.cursor/skills/verify-cookie/bin/drive-core drive runtime-restart --evidence verify-evidence/m0-runtime-restart --core real
.cursor/skills/verify-cookie/bin/drive-core drive chat-history --evidence verify-evidence/m0-chat-history --core real --llama external
.cursor/skills/verify-cookie/bin/drive-core drive memory-persist --evidence verify-evidence/m1-memory-persist --core real
.cursor/skills/verify-cookie/bin/drive-core drive menu-bar-icon
.cursor/skills/verify-cookie/bin/drive-core drive hotkey-popup
.cursor/skills/verify-cookie/bin/drive-mac all
.cursor/skills/verify-cookie/bin/drive-mac self-check
.cursor/skills/verify-cookie/bin/drive-mac chat --runtime real --evidence verify-evidence/m0-mac-real
.cursor/skills/verify-cookie/bin/drive-core cleanup
```

`pnpm fake-core` starts the fake core on stdio with no scripted dialogue. `pnpm core` starts the real core. Use `drive-core` when you need a transcript.
