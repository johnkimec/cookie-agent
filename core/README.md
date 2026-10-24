# core

TypeScript agent core for Cookie (Node 22+, AI SDK 7). The agent loop is not implemented.

`src/fake-core.ts` speaks the M0 JSON-RPC contract on stdio with a canned stream and no model. The real loop replaces that process. Mac tools stay in the Swift shell. This package has to build and test on Linux, against the fake core.

## Commands

From the repository root:

```bash
pnpm install
pnpm --filter @cookie-agent/core lint
pnpm --filter @cookie-agent/core typecheck
pnpm --filter @cookie-agent/core test
pnpm --filter @cookie-agent/core fake-core
```

`src/index.ts` starts and exits 0. It is not an agent loop. Protocol types are in `src/protocol/`. The contract is [protocol/README.md](../protocol/README.md). See [AGENTS.md](../AGENTS.md).
