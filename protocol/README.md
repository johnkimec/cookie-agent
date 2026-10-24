# Protocol

M0 contract between the Swift shell and the TypeScript core. Newline-delimited JSON-RPC 2.0 on stdio. Version `0.1`.

The schema is [`schema/cookie-rpc.schema.json`](schema/cookie-rpc.schema.json). Golden messages are in [`examples/`](examples/). Hand-written TypeScript types live in [`core/src/protocol/types.ts`](../core/src/protocol/types.ts). Swift mirrors them with Codable when task B lands. This directory does not contain Swift.

The core is the JSON-RPC server. The shell spawns it and is the client. Either side may send `runtime.status` notifications. The core's stdout is protocol only. Logs go to stderr. There is no port on this channel. The core reaches `llama-server` over HTTP on `127.0.0.1`, which is a different channel and is not framed here.

## Framing

- UTF-8. One JSON value per line. Writers end lines with `\n` only. Readers accept `\n` and `\r\n`.
- No Content-Length headers. No JSON-RPC batches. A JSON array is an invalid request.
- A line longer than 1 MiB (1,048,576 bytes) is an invalid request and is not parsed.
- Blank lines are ignored.
- Request ids are strings matching `^[A-Za-z0-9._:-]+$`, length 1–128. Numbers are rejected. Parse errors and other failures that have no usable id use `"id": null`.
- Notifications omit `id`. `"id": null` on a notification is an invalid request, not a notification.
- Unknown fields are rejected (`additionalProperties: false`). Version `0.1` does not ignore them.
- `initialize` is the first request, except that `shutdown` is also valid before it so the shell can always tear the process down. Any other request before a successful `initialize` returns "Not initialized". Notifications before `initialize` are ignored.
- EOF on stdin ends the process with exit code 0 and no response. A successful `shutdown` writes its result and then exits 0.

`protocol/examples/session.jsonl` is a full happy-path trace in wire form. Pretty-printed files next to it are the same messages, one per file.

## Versioning

`protocolVersion` is a `MAJOR.MINOR` string. The only version this schema accepts in a result is `0.1`. A well-formed different version fails `initialize` with code `-32000` and does not complete the handshake. Adding or renaming a field or method requires a new version and a schema change.

## Methods

| Method | Direction | Kind |
| --- | --- | --- |
| `initialize` | shell → core | request |
| `shutdown` | shell → core | request |
| `chat.send` | shell → core | request |
| `chat.cancel` | shell → core | request |
| `chat.delta` | core → shell | notification |
| `chat.done` | core → shell | notification |
| `runtime.status` | either direction | notification, and shell → core query |

Later design-doc methods are not in this schema: `tool.call`, `tool.list`, `fm.classify`, `ui.approval_request`, `ui.stream_delta`, `ui.egress_notice`, `approval.respond`, `checkin.trigger`, `power.state`, `config.set`.

### `initialize`

Params:

| Field | Type | Notes |
| --- | --- | --- |
| `protocolVersion` | string | `^[0-9]+\.[0-9]+$`. Only `0.1` succeeds. |
| `clientInfo.name` | string | For example `cookie-shell`. |
| `clientInfo.version` | string | |
| `capabilities.chatCancel` | boolean, optional | Shell can send `chat.cancel` and show a cancelled reply. |

Result:

| Field | Type | Notes |
| --- | --- | --- |
| `protocolVersion` | `"0.1"` | |
| `serverInfo` | name and version | The fake core sends `cookie-fake-core` / `0.0.0`. The real core will send `cookie-core`. |
| `capabilities.chat.stream` | boolean | |
| `capabilities.chat.cancel` | boolean | |
| `capabilities.runtime.status` | boolean | |

After the result, the core sends one `runtime.status` notification for its current view. The fake core's view is `up` / `fake-local`.

A second `initialize` is an invalid request (`data.reason` is `already initialized`).

### `shutdown`

Params are `{}` or `{ "reason": string }`. Result is `{ "ok": true }`. If a reply is in flight, the core first sends `chat.done` with `finishReason: "cancelled"`, then the shutdown result, then exits 0.

### `chat.send`

Params: `conversationId` (`^[A-Za-z0-9_-]+$`, 1–128) and `text` (1–100,000 characters). This id is the design doc's session id. M0 has no separate session field.

The result is an ack, `{ "conversationId", "messageId" }`, written before any delta. `messageId` is chosen by the core (`msg-1`, `msg-2`, … on the fake core). The shell correlates later notifications with that id, not with the request id.

Then the core sends one or more `chat.delta` notifications and one `chat.done`. Delta `index` starts at 0 and increases by 1. `text` is the next chunk, not the whole reply.

The fake core allows one in-flight reply. A second `chat.send` gets `-32003`. A send while `runtime.status` is `down` or `loading` gets `-32002` and does not start a reply.

### `chat.delta` and `chat.done`

Both are notifications.

`chat.done` carries `finishReason` and `usage`.

| `finishReason` | When |
| --- | --- |
| `stop` | The reply completed. |
| `cancelled` | `chat.cancel` or `shutdown` stopped it. |
| `length` | The model hit its output limit. The fake core does not emit this. |
| `error` | The reply failed after it had started. The fake core does not emit this. |

`usage.inputTokens` and `usage.outputTokens` are non-negative integers. The real core reports the model's counts. The fake core counts whitespace-separated words. On cancel, `outputTokens` counts only chunks already sent.

### `chat.cancel`

Params: `conversationId` and `messageId`. Result: `{ "cancelled": true }` if that reply was in flight, otherwise `{ "cancelled": false }`. Cancelling a finished reply is not an error and does not send a second `chat.done`.

When it does cancel, the core sends `chat.done` with `finishReason: "cancelled"` and then the `chat.cancel` result. No further deltas follow.

The UI spec does not name a cancel control. Esc closes the popup. It is not specified as cancel.

### `runtime.status`

Params and the query result share one shape.

| Field | Type | Notes |
| --- | --- | --- |
| `state` | `up`, `down`, or `loading` | `up` is the design doc's warm runtime. `down` is unloaded, crashed, or not started. `loading` is a reload. |
| `modelId` | string or null | Required for `up` and `loading`. For `down`, the key may be omitted, null, or the last id. Readers treat omit and null the same. |

A notification updates the receiver and is not echoed. A request with empty params `{}` is a query. The shell sends it to read the core's view. The core answers with the status object. The shell does not answer queries.

The product model id is `Qwen3.6-35B-A3B`. The menu status line in the UI spec shows that id as `Qwen3.6`. Any other id, including the fake core's `fake-local`, is shown as the raw `modelId`.

Order after `initialize`: the result line, then the core's `runtime.status` notification.

## Errors

| Code | Message | When |
| --- | --- | --- |
| `-32700` | Parse error | The line is not JSON. `id` is null. |
| `-32600` | Invalid Request | Not a Cookie JSON-RPC request. Includes a non-string id, a line over 1 MiB, and a second `initialize`. |
| `-32601` | Method not found | The method is not in version `0.1`. |
| `-32602` | Invalid params | Params fail the schema. `data.reason` is `params failed schema`. Detail goes to stderr, not the wire. |
| `-32603` | Internal error | The core failed unexpectedly. |
| `-32000` | Protocol version not supported | `initialize` version is not `0.1`. |
| `-32001` | Not initialized | Any request other than `initialize` or `shutdown` before a successful handshake. |
| `-32002` | Runtime unavailable | `chat.send` while state is `down` or `loading`. |
| `-32003` | Chat in progress | `chat.send` while a reply is already streaming. |
| `-32004` | Shutting down | A request arrives after `shutdown` has started. |

`error.data` may include `reason` and `method`. No other data keys.

## Environment

These are process environment variables, not JSON-RPC fields.

| Variable | Meaning |
| --- | --- |
| `COOKIE_LLAMA_PORT` | Port of `llama-server`. The product default is `8080` (`http://127.0.0.1:8080/v1` in the design doc). Verification sets `18080` and must not use `8080`. |
| `COOKIE_DATA_DIR` | Isolated data directory. Verification sets a fresh temp directory. The fake core does not read or write it. |
| `COOKIE_FAKE_DELTA_MS` | Fake core only. Milliseconds to wait between deltas so `chat.cancel` can land. `0`–`10000`. Default `0`. |

The fake core opens no sockets and does not dial `llama-server`, whatever the port is.

## Fake core

```bash
pnpm --filter @cookie-agent/core fake-core
```

From the repo root, `pnpm fake-core` is the same command. It reads stdin and writes protocol lines to stdout until `shutdown` or EOF.

It streams three chunks and then `chat.done` / `stop`:

```text
I'm here. This reply is from the fake core, with no model loaded.
```

That text is a stub so task B can render a stream. It is not a model reply. `serverInfo.name` is `cookie-fake-core`. The first `runtime.status` is `up` / `fake-local`. Task A replaces this process and must report the real runtime instead of copying `fake-local`.

## TypeScript

`core/src/protocol/types.ts` is hand-written from the schema. `core/src/protocol/validate.ts` loads the schema with Ajv and checks messages. Tests in `core/src/protocol/schema.test.ts` check `protocol/examples/`. `core/src/fake-core.test.ts` spawns the fake core and checks every live message against the schema.

## Swift

Task B adds Codable types under `app/`. No generator and no Swift code in this milestone. Mirror the JSON keys so synthesized Codable matches, with these exceptions:

- Request `id` is a `String`. Do not send an `Int`. Error responses need `id` to decode as `String?` because parse errors use JSON `null`.
- Notifications omit `id`. Decode them as a separate type, or as a request type whose `id` is optional and absent.
- `RuntimeStatus.modelId` is `String?`. For `down`, synthesized Codable may omit nil. The schema allows that. For `up` and `loading`, encode a non-empty string. The fake core still sends `"modelId": null` when it records down, and readers accept both.
- `finishReason` and `state` are `String` enums with the raw values in the tables above.
- `protocolVersion` on the result is the string `0.1`, not a number.

```swift
struct RuntimeStatus: Codable {
    var state: RuntimeState
    var modelId: String?
}

enum RuntimeState: String, Codable {
    case up, down, loading
}
```

## Decisions to review

1. Streamed text is `chat.delta` and completion is `chat.done`. The design doc's later name `ui.stream_delta` stays unused until a milestone needs a non-chat UI stream.
2. `conversationId` is the design doc's session id. M0 has no second id.
3. Request ids are strings, not JSON numbers, so Swift can use one `String` field.
4. Runtime states on the wire are `up`, `down`, and `loading`. The shell's "warm" is `up`. "Unloaded" is `down`.
5. `runtime.status` is a notification either side may send, and a query the shell sends with `{}`. The shell supervises `llama-server` and pushes status. The core also announces its own view. A push is not echoed.
6. Unknown fields and unknown methods fail in `0.1`. Extending the contract is a schema change, not a silent extra key.
7. Framing is newline-delimited JSON only. No batches and no LSP `Content-Length` headers.
8. The llama-server port is not a protocol field. Product default `8080`. Verification uses `COOKIE_LLAMA_PORT=18080` and a private `COOKIE_DATA_DIR`.
9. `modelId` is the full id (`Qwen3.6-35B-A3B`). The menu line displays `Qwen3.6` only for that id. `fake-local` stays `fake-local` on screen.
10. No cancel control is named in the UI spec. `chat.cancel` has no button label yet. Esc still means close the popup.
11. The menu-bar slash follows `runtime.status === down` (the model is not serving). A warm local model still chats with no network, and the status line stays `🐾 Cookie · on-device · Qwen3.6`. The character sheet's "no network (local still works)" is that promise, not a second glyph. Loading uses the dotted outline while state is `loading`. While a reply is in flight the glyph is Thinking (`Cookie, thinking`), including when the popup is open. When the popup is open and nothing is streaming, the glyph is Listening. Down and loading override both.
12. `chat.send` acks with `messageId` before the stream. `chat.done` is a notification, not that ack.
13. One in-flight chat per core in the fake core. A second send gets `-32003`. Task A can keep or relax that when it replaces the fake.
14. The fake core announces `up` / `fake-local` so the shell can render the warm path with no model. The real core must not copy that default.
