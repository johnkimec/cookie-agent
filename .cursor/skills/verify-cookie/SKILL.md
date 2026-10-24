---
name: verify-cookie
description: "Drive Cookie the way John does and capture proof. The TypeScript core is newline-delimited JSON-RPC on stdio (Linux, fake core today). The Mac menu-bar app is macOS only and unreachable until task B. Use when proving M0 behavior, marking a verify-cookie feature verified, or checking a core change against the protocol."
---

# verify-cookie

Drive Cookie and keep the evidence. The core surface works on Linux against the fake core. The Mac app does not exist yet: `app/` is a compile stub, and that surface is `verified-unreachable on Linux: requires macOS`.

Keep this map honest with `/maintain-verification-skill` when the shell or the real core lands. A passing vitest run is not feature evidence. Evidence is a transcript this skill wrote under `verify-evidence/`.

## Launch

There is no long-running server. Each drive starts its own fake core and that process exits on `shutdown`.

From the repository root, with Node 22 and pnpm 10:

```bash
pnpm install
```

Readiness is not a log line. `.cursor/skills/verify-cookie/bin/drive-core doctor` must print a first line `ok`, then `protocolVersion 0.1`, `server cookie-fake-core`, `runtime up fake-local`, `llamaPort 18080`, and `sockets none`. The doctor spawns a core, completes `initialize`, checks that the process has no socket besides stdio, sends `shutdown`, and exits.

The fake core never dials `llama-server`. Verification still sets `COOKIE_LLAMA_PORT=18080` and a fresh `COOKIE_DATA_DIR` so a later real core cannot touch John's port `8080` or his data. Do not point either variable at his home directory or at port `8080`.

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

Doctor does not write evidence. Capture it yourself when a proof needs it (see Evidence). It does leave a scratch data directory under `/tmp/cookie-verify/` for cleanup to remove.

## Drive

The helper is `.cursor/skills/verify-cookie/bin/drive-core`. It speaks the M0 protocol in `protocol/schema/cookie-rpc.schema.json`. Stable handles are the JSON-RPC method names and the UI strings in the feature files, not screen coordinates.

Core, on Linux or macOS:

```bash
.cursor/skills/verify-cookie/bin/drive-core drive chat-streaming --evidence verify-evidence/m0-chat-streaming
.cursor/skills/verify-cookie/bin/drive-core drive model-status --evidence verify-evidence/m0-model-status
```

`chat-streaming` sends `initialize`, reads `runtime.status` `up` / `fake-local`, sends `chat.send` with text `hello from verify-cookie`, requires three `chat.delta` lines and `chat.done` `stop`, then sends a second `chat.send` and `chat.cancel`, requires `chat.done` `cancelled`, then `shutdown`. Stdout ends with `ok`, `deltas 3`, `finishReason stop`, and `cancelled true`.

`model-status` pushes `loading` with `modelId` `Qwen3.6-35B-A3B`, expects `chat.send` to fail with code `-32002`, pushes `down`, expects the same refusal, pushes `up` / `fake-local`, and expects a recovered `chat.done` `stop`. On Linux its stdout also contains `verified-unreachable on Linux: requires macOS` for the menu-bar half of that feature. Exit 0 means the core half passed. It does not mean the glyphs were seen.

Mac app, not available in this checkout:

```bash
.cursor/skills/verify-cookie/bin/drive-core drive menu-bar-icon
.cursor/skills/verify-cookie/bin/drive-core drive hotkey-popup
```

On Linux both exit 2 and stdout is exactly `verified-unreachable on Linux: requires macOS`. On macOS, until task B adds the app, stdout is `verified-unreachable: requires the Mac app from task B` and the exit code is still 2.

When task B exists, drive that app only with a fresh `COOKIE_DATA_DIR` (a new temp directory) and `COOKIE_LLAMA_PORT=18080`. Never attach to a Cookie already running in John's session. Open the popup from the menu item `Ask Cookie…` or with ⌥Space. The input's accessibility label is `Ask Cookie…`. Read the accessibility tree with `osascript` and System Events, using those labels, not a click coordinate. Capture the popup with `screencapture -x`. The menu bar's VoiceOver label while a reply streams is `Cookie, thinking`. Quit with the menu item `Quit Cookie`. Then run cleanup. Do not mark a Mac sub-feature verified from a core transcript.

## Evidence

Proof goes in `verify-evidence/` at the repository root. That directory is gitignored. Cleanup does not delete it.

A drive writes these files into `--evidence`:

| File | What it is |
| --- | --- |
| `command.txt` | The `drive-core` invocation plus `COOKIE_DATA_DIR`, `COOKIE_LLAMA_PORT`, and `COOKIE_FAKE_DELTA_MS`. |
| `transcript.jsonl` | One JSON object per line: `seq`, `direction` (`client` or `server`), and `message` (the raw JSON-RPC value). |
| `stderr.txt` | The fake core's stderr. Empty on success. |
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

Stdout is `ok`. Cleanup reads `/tmp/cookie-verify/pids/` (or `COOKIE_VERIFY_RUNTIME` if set) and signals only pids whose `/proc/<pid>/cmdline` contains `fake-core.ts`. It never signals pid 1 or its own pid. It deletes scratch data directories recorded under that runtime root and nothing else. A path outside the runtime root is left alone, including `verify-evidence/` and any `COOKIE_DATA_DIR` that was not created there.

Run cleanup after a failed drive too, so a fake core is not left running. Then confirm the evidence files are still on disk.

## Helpers

`.cursor/skills/verify-cookie/bin/drive-core` is executable. It runs `node --experimental-strip-types core/src/verify-drive.ts` from the repository root.

```bash
.cursor/skills/verify-cookie/bin/drive-core doctor
.cursor/skills/verify-cookie/bin/drive-core drive chat-streaming --evidence verify-evidence/m0-chat-streaming
.cursor/skills/verify-cookie/bin/drive-core drive model-status --evidence verify-evidence/m0-model-status
.cursor/skills/verify-cookie/bin/drive-core drive menu-bar-icon
.cursor/skills/verify-cookie/bin/drive-core drive hotkey-popup
.cursor/skills/verify-cookie/bin/drive-core cleanup
```

`pnpm fake-core` starts the same fake core on stdio with no scripted dialogue. Use it to poke at the protocol by hand. Use `drive-core` when you need a transcript.
