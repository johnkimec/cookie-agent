import type { ErrorData, JsonRpcError } from "./types.ts";

export const protocolErrors = {
  parseError: { code: -32700, message: "Parse error" },
  invalidRequest: { code: -32600, message: "Invalid Request" },
  methodNotFound: { code: -32601, message: "Method not found" },
  invalidParams: { code: -32602, message: "Invalid params" },
  internalError: { code: -32603, message: "Internal error" },
  protocolMismatch: {
    code: -32000,
    message: "Protocol version not supported",
  },
  notInitialized: { code: -32001, message: "Not initialized" },
  runtimeUnavailable: { code: -32002, message: "Runtime unavailable" },
  chatInProgress: { code: -32003, message: "Chat in progress" },
  shuttingDown: { code: -32004, message: "Shutting down" },
} as const;

export type ProtocolErrorName = keyof typeof protocolErrors;

export const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]+$/;

export function rpcError(
  id: string | null,
  name: ProtocolErrorName,
  data?: ErrorData,
): JsonRpcError {
  const body = protocolErrors[name];
  if (data === undefined) {
    return {
      jsonrpc: "2.0",
      id,
      error: { code: body.code, message: body.message },
    };
  }
  return {
    jsonrpc: "2.0",
    id,
    error: { code: body.code, message: body.message, data },
  };
}
