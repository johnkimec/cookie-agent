# Cookie verification map

This directory is the maintained source for verifying Cookie's user-facing M0 behavior. Read the index before driving, then use the matching feature file as the recipe.

M0 is the walking skeleton: menu bar, hotkey popup, a streamed reply from the local core, and an honest model status. Later milestones (memory, calendar, screen, tools, check-ins, widgets) are not features here yet.

## Baseline preconditions

- Repository root, Node 22.6 or newer (`.nvmrc` is `22`), pnpm 10, and `pnpm install` already run.
- The default core under test is the fake core (`pnpm fake-core`), which speaks protocol `0.1` and does not load a model. `--core real` selects the real core (`pnpm core`) and a stub on port `18080`.
- Set `COOKIE_DATA_DIR` to a new temporary directory for every run. The helper does this itself.
- Set `COOKIE_LLAMA_PORT=18080`. Never use `8080`. That is the product default and may be John's real `llama-server`.
- Run `.cursor/skills/verify-cookie/bin/drive-core doctor` and require `ok`, `protocolVersion 0.1`, `runtime up fake-local`, `llamaPort 18080`, and `sockets none`. For the real core, run `doctor --core real` and require `server cookie-core`, `runtime up Qwen3.6-35B-A3B`, and `sockets loopback`.
- Never drive a core or a Mac app this run did not start. Do not point `COOKIE_DATA_DIR` at John's Application Support folder.

## Driving conventions

- Start every recipe from the baseline unless its preconditions say otherwise.
- Treat every command as literal. Keep quoted names and flags unchanged.
- Drive the core with `.cursor/skills/verify-cookie/bin/drive-core`.
- On macOS, drive the menu and popup with `.cursor/skills/verify-cookie/bin/drive-mac` and the accessibility identifiers in the feature files (`cookie.menu.ask`, `cookie.popup.input`, and the labels `Ask Cookie…`, `Local-only mode`, `Quit Cookie`, `Cookie, thinking`). `drive-core` does not launch the GUI. The default `drive-mac` mode uses the fake core. `drive-mac chat --runtime real` drives the real core and `llama-server`. Sergey verified that drive on the Mac on 2026-10-25 at commit c89adc6. Evidence is `verify-evidence/m0-mac-real/`. Sub-features that drive does not assert stay `planned`. Do not click by coordinate.
- One short-lived core per drive. It exits on `shutdown`. `--core real` also stops its stub.
- Restore nothing in the user's home directory. Neither core writes files there in M0. The real core keeps history in memory.
- Do not remove proof artifacts during cleanup.

## Proof and skip reporting

- Capture the user action and the resulting state, not only the final screen.
- Every proof pairs the command that was run with the output it produced. A written claim about the result is not proof.
- A drive that shows wrong behavior becomes one new test in `core/` when the failure is in the core. Run that test and confirm it fails on the captured output before any product change. A test that already passes does not count. With no suite for that surface, the failing command and its captured output, kept in `verify-evidence/`, are the regression check.
- Core proof is `verify-evidence/<feature>/command.txt` plus `transcript.jsonl`. Every transcript message must match `protocol/schema/cookie-rpc.schema.json`.
- Mac proof, when that surface exists, includes the `osascript` transcript and a `screencapture -x` image that shows the UI string the feature names.
- A vitest run is not feature evidence. `status: verified` requires a path under `verify-evidence/` written by this skill.
- Record the feature file and the sub-feature id with every artifact.
- Report an unreachable path with the attempted command and the unmet precondition.
- Do not report a skipped entry point as verified through a different path. A `runtime.status` line inside the chat-streaming transcript does not verify model status.

## Feature entry contract

Each feature file starts with an H1 title and one paragraph describing the user-visible behavior. It then uses exactly four H2 sections in this order.

1. `Sub-features` lists short ids. Each one ends with `status: planned` or `status: verified (verify-evidence/...)`.
2. `How to get to it (user POV)` lists every user entry point.
3. `Driving it with verify-cookie` starts with `Preconditions:` and uses labeled bullets that pair each user action with an exact command and observable result.
4. `Gotchas` lists traps that can waste or invalidate a verification run.

Every pull request from M0 onward updates the feature file it touches. Leave a sub-feature `planned` when that pull request did not capture evidence for it.

Keep implementation details out of the map. Name only user paths, stable handles, required state, commands, and observable proof. UI strings are copied from `docs/cookie-agent-ui-spec.md`.

## Features

- [Menu bar icon](./menu-bar-icon.md) covers the Cookie menu-bar item, the status line, Ask Cookie, local-only, and Quit.
- [Hotkey popup](./hotkey-popup.md) covers ⌥Space, the `Ask Cookie…` field, and closing the panel.
- [Chat streaming](./chat-streaming.md) covers sending a message, seeing the reply arrive in chunks, and cancelling it.
- [Model status and offline](./model-status-offline.md) covers up, loading, and down, and chatting with no network while the model is up.
