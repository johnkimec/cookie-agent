# AGENTS.md

Instructions for coding agents working in this repository. Cookie, the product, is a menu-bar app. This file is for the agents that write its code.

## Project

Cookie is an open-source, local-first Mac companion. A non-sandboxed Swift 6 / SwiftUI app owns the UI, macOS permissions, and Mac tools. It spawns a TypeScript agent core (Node 22+, AI SDK 7) as a child process. They talk newline-delimited JSON-RPC 2.0 over stdio. A local llama.cpp `llama-server` on 127.0.0.1 serves Qwen3.6-35B-A3B. Memory is SQLite. Local-only is the default. Hosted escalation is opt-in.

The mascot is an animated white maltipoo named Cookie, animated with Rive. Inside the app the name is Cookie. The repository is `johnkimec/cookie-agent`. The app file is `Cookie Agent.app`.

Read [docs/cookie-agent.md](docs/cookie-agent.md) before changing product behavior. UI, branding, and packaging are in [docs/cookie-agent-ui-spec.md](docs/cookie-agent-ui-spec.md). Do not reopen a logged decision. Supersede it in the decision log.

## Approval gate

The Status line at the top of `docs/cookie-agent.md` is the gate. It reads `approved (John Kim, 2026-10-24)`.

Implementation is allowed, one milestone task per pull request.

## Repo map

| Path | What it is |
| --- | --- |
| `docs/cookie-agent.md` | Project doc and decision log. Source of truth once approved. |
| `docs/cookie-agent-ui-spec.md` | UI, branding, and packaging spec. |
| `docs/lessons.md` | Append-only lessons. |
| `core/` | TypeScript agent core. Builds and tests on Linux. |
| `app/` | Swift shell. macOS only. Menu bar, hotkey popup, and the core supervisor. |
| `protocol/` | JSON-RPC 2.0 schemas, examples, and the M0 spec. Shared by Swift (Codable, not written yet) and TypeScript (`core/src/protocol/`). |
| `.cursor/skills/verify-cookie/` | Verification skill and M0 feature map. Linux drives the fake core over stdio. The Mac app drive stays unreachable until the shell exists. |
| `evals/` | Evaluation tasks from the project doc. Not written yet. |
| `assets/` | Rive file and pose exports. Not covered by Apache-2.0. See `BRAND.md`. |
| `BRAND.md` | Reservation of Cookie's name and mascot art. |
| `LICENSE` | Apache-2.0 for the code. |

The UI spec also sketches `apps/mac/`, `brand/`, `runtime/`, `scripts/`, and `core/test/evals/`. This table is the foundation layout. Do not move directories while the project doc is unapproved. When it is approved, reconcile the two layouts in the decision log before scattering code.

## Commands

From the repository root, with Node 22 and pnpm 10:

```bash
pnpm install
pnpm --filter @cookie-agent/core lint
pnpm --filter @cookie-agent/core typecheck
pnpm --filter @cookie-agent/core test
```

`pnpm lint`, `pnpm typecheck`, and `pnpm test` run the same three commands.

`pnpm fake-core` speaks the M0 protocol on stdio with a canned reply and no model. `.cursor/skills/verify-cookie/bin/drive-core` is the scripted driver. See [protocol/README.md](protocol/README.md).

On a Mac, build and test the shell, then launch it against the fake core. `open` drops the shell environment, so run the executable. Linux CI does not build `app/`. macOS CI does.

```bash
swift test --package-path app
app/Scripts/package-app.sh
export COOKIE_DATA_DIR="$(mktemp -d /tmp/cookie-m0.XXXXXX)"
export COOKIE_LLAMA_PORT=18080
export COOKIE_CORE_CWD="$(pwd)"
"dist/Cookie Agent.app/Contents/MacOS/CookieAgent"
```

## Conventions

- Small pull requests. One milestone task from the project doc per PR. Put the milestone id in the title, for example `M0: spawn the core over stdio`.
- Every pull request from M0 onward updates the feature file it touches under `.cursor/skills/verify-cookie/features/`. Set a sub-feature to `status: verified (evidence path)` only when that pull request captured evidence with the verify-cookie skill. Otherwise leave `status: planned`. Do not mark a feature verified from a different feature's transcript.
- Tests are required for every behavior change. A core change needs a vitest test that fails before the change and passes after it.
- Never commit model weights (`*.gguf`, or any file a future model manifest would download), API keys, `.env` files, or Keychain exports.
- Never commit Cookie's name or mascot art as if Apache-2.0 covered them. Art stays under `BRAND.md`.
- Prefer the decision log over a silent change of plan. Append a superseding entry. Never delete an old one.
- The core reaches Mac capabilities only through `protocol/`. It does not embed Swift, shell out to `osascript`, or call Apple frameworks.

## Linux and Mac

The TypeScript core builds and tests on Linux. Mac-only behavior stays in `app/`, or behind an interface the core can fake.

- Tests use a fake model: an OpenAI-compatible stub, or recorded responses. They do not start `llama-server` and they do not download weights.
- Tests use fake Mac tools: in-memory calendar, reminders, files, and screen. They do not call EventKit, ScreenCaptureKit, or AppleScript.
- A change that only matters on a Mac still has a Linux test for the core's half: the request, the response, and the failure path, all against the fakes.
- `app/` may use Apple APIs. Do not import `app/` from `core/`.

## Lessons

When a task teaches something the next agent would otherwise rediscover, append it to [docs/lessons.md](docs/lessons.md).

- One row, dated `YYYY-MM-DD`, with an id like `L-2026-10-24-01`.
- Say what happened, what to do instead, and which path it applies to.
- Append only. To correct a lesson, add a new row whose Supersedes column names the old id. Do not delete the old row.
