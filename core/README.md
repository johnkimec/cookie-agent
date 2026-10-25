# core

TypeScript agent core for Cookie (Node 22.6+, AI SDK 7). `src/index.ts` speaks protocol 0.1 on stdio and dials a local OpenAI-compatible runtime. Mac tools stay in the Swift shell. This package builds and tests on Linux with no model weights.

`src/fake-core.ts` is the canned stand-in. Keep it working: the Swift shell is built against it. It does not dial llama-server.

The real core keeps the model behind `src/model/provider.ts`. M0 constructs only the llama-server provider (`COOKIE_LLAMA_PORT`, default `8080`, model id `Qwen3.6-35B-A3B`). Thinking stays off unless `COOKIE_THINKING=1`. With thinking off, every chat request sends `chat_template_kwargs.enable_thinking` false. While the core is ready it probes llama-server about every 500 ms and announces `runtime.status` when that state changes. A shell push is left alone for 5 seconds. There is no hosted provider and no tools. Conversation history is in memory. `chat.cancel` and `shutdown` abort the model request. A chat in flight when the runtime connection dies ends with `chat.done` `finishReason` `error`.

## Commands

From the repository root:

```bash
pnpm install
pnpm --filter @cookie-agent/core lint
pnpm --filter @cookie-agent/core typecheck
pnpm --filter @cookie-agent/core test
pnpm --filter @cookie-agent/core fake-core
pnpm --filter @cookie-agent/core start
```

`pnpm core` is the same start command. Protocol types are in `src/protocol/`. The contract is [protocol/README.md](../protocol/README.md). See [AGENTS.md](../AGENTS.md).
