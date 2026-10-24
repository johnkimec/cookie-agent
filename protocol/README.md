# protocol

JSON-RPC message schemas for Cookie will live here, shared by the Swift shell and the TypeScript core.

Framing is newline-delimited JSON-RPC 2.0 over stdio. The shell spawns the core and owns the process. There is no port on this channel. Schemas are not written yet. Product work waits until [docs/cookie-agent.md](../docs/cookie-agent.md) is approved.

Planned methods, names only, from the technical design:

| Direction | Methods |
| --- | --- |
| Core to shell | `tool.call`, `tool.list`, `fm.classify`, `ui.approval_request`, `ui.stream_delta`, `ui.egress_notice` |
| Shell to core | `chat.send`, `approval.respond`, `checkin.trigger`, `power.state`, `config.set` |

The core talks to `llama-server` separately, over HTTP on 127.0.0.1. That is not this protocol.

A Unix-domain socket with the same JSON-RPC framing is the documented fallback if the core ever has to outlive the app. It is not the default.
