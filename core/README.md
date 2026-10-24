# core

TypeScript agent core for Cookie (Node 22+, AI SDK 7). Not implemented.

The process will speak newline-delimited JSON-RPC 2.0 on stdio and call `llama-server` on 127.0.0.1. Mac tools stay in the Swift shell. This package has to build and test on Linux, against a fake model and fake Mac tools.

## Commands

From the repository root:

```bash
pnpm install
pnpm --filter @cookie-agent/core lint
pnpm --filter @cookie-agent/core typecheck
pnpm --filter @cookie-agent/core test
```

`src/index.ts` starts and exits 0. It is not an agent loop. See [AGENTS.md](../AGENTS.md).
