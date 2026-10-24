/**
 * Hand-written types for protocol/schema/cookie-rpc.schema.json.
 * Keep this file aligned with that schema. schema.test.ts checks the
 * golden messages; fake-core refuses to emit a message the schema rejects.
 */

export const PROTOCOL_VERSION = "0.1" as const;

/** Design-doc default. The menu status line shortens this to "Qwen3.6". */
export const DEFAULT_MODEL_ID = "Qwen3.6-35B-A3B";

export type ProtocolVersion = typeof PROTOCOL_VERSION;

export type RuntimeState = "up" | "down" | "loading";

export type FinishReason = "stop" | "cancelled" | "length" | "error";

export interface PeerInfo {
  name: string;
  version: string;
}

export interface ClientCapabilities {
  chatCancel?: boolean;
}

export interface ServerCapabilities {
  chat: {
    stream: boolean;
    cancel: boolean;
  };
  runtime: {
    status: boolean;
  };
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
}

export interface InitializeParams {
  protocolVersion: string;
  clientInfo: PeerInfo;
  capabilities: ClientCapabilities;
}

export interface InitializeResult {
  protocolVersion: ProtocolVersion;
  serverInfo: PeerInfo;
  capabilities: ServerCapabilities;
}

export interface ShutdownParams {
  reason?: string;
}

export interface ShutdownResult {
  ok: true;
}

export interface ChatSendParams {
  conversationId: string;
  text: string;
}

export interface ChatSendResult {
  conversationId: string;
  messageId: string;
}

export interface ChatCancelParams {
  conversationId: string;
  messageId: string;
}

export interface ChatCancelResult {
  cancelled: boolean;
}

export interface ChatDeltaParams {
  conversationId: string;
  messageId: string;
  index: number;
  text: string;
}

export interface ChatDoneParams {
  conversationId: string;
  messageId: string;
  finishReason: FinishReason;
  usage: Usage;
}

/**
 * `modelId` is required for `up` and `loading`. For `down` it may be
 * omitted, null, or the last id the runtime was asked to serve.
 * Swift synthesized Codable omits nil; readers treat omit and null alike.
 */
export interface RuntimeStatus {
  state: RuntimeState;
  modelId?: string | null;
}

export interface ErrorData {
  reason?: string;
  method?: string;
}

export interface ProtocolErrorBody {
  code: number;
  message: string;
  data?: ErrorData;
}

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: string;
  method: string;
  params: unknown;
}

export interface JsonRpcResult {
  jsonrpc: "2.0";
  id: string;
  result: unknown;
}

export interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params: unknown;
}

export interface JsonRpcError {
  jsonrpc: "2.0";
  id: string | null;
  error: ProtocolErrorBody;
}
