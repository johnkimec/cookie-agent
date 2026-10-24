import Foundation

/// Codable mirrors of `core/src/protocol/types.ts` for protocol 0.1.
/// JSON keys match the TypeScript names so synthesized Codable lines up
/// with `protocol/schema/cookie-rpc.schema.json`.

public let protocolVersion = "0.1"
public let defaultModelID = "Qwen3.6-35B-A3B"
public let shellClientName = "cookie-shell"
public let shellClientVersion = "0.0.0"

public enum RuntimeState: String, Codable, Equatable, Sendable {
    case up
    case down
    case loading
}

public enum FinishReason: String, Codable, Equatable, Sendable {
    case stop
    case cancelled
    case length
    case error
}

public struct PeerInfo: Codable, Equatable, Sendable {
    public var name: String
    public var version: String

    public init(name: String, version: String) {
        self.name = name
        self.version = version
    }
}

public struct ClientCapabilities: Codable, Equatable, Sendable {
    public var chatCancel: Bool?

    public init(chatCancel: Bool? = nil) {
        self.chatCancel = chatCancel
    }
}

public struct ServerCapabilities: Codable, Equatable, Sendable {
    public var chat: Chat
    public var runtime: Runtime

    public struct Chat: Codable, Equatable, Sendable {
        public var stream: Bool
        public var cancel: Bool

        public init(stream: Bool, cancel: Bool) {
            self.stream = stream
            self.cancel = cancel
        }
    }

    public struct Runtime: Codable, Equatable, Sendable {
        public var status: Bool

        public init(status: Bool) {
            self.status = status
        }
    }

    public init(chat: Chat, runtime: Runtime) {
        self.chat = chat
        self.runtime = runtime
    }
}

public struct Usage: Codable, Equatable, Sendable {
    public var inputTokens: Int
    public var outputTokens: Int

    public init(inputTokens: Int, outputTokens: Int) {
        self.inputTokens = inputTokens
        self.outputTokens = outputTokens
    }
}

public struct InitializeParams: Codable, Equatable, Sendable {
    public var protocolVersion: String
    public var clientInfo: PeerInfo
    public var capabilities: ClientCapabilities

    public init(
        protocolVersion: String,
        clientInfo: PeerInfo,
        capabilities: ClientCapabilities
    ) {
        self.protocolVersion = protocolVersion
        self.clientInfo = clientInfo
        self.capabilities = capabilities
    }
}

public struct InitializeResult: Codable, Equatable, Sendable {
    public var protocolVersion: String
    public var serverInfo: PeerInfo
    public var capabilities: ServerCapabilities

    public init(
        protocolVersion: String,
        serverInfo: PeerInfo,
        capabilities: ServerCapabilities
    ) {
        self.protocolVersion = protocolVersion
        self.serverInfo = serverInfo
        self.capabilities = capabilities
    }
}

public struct ShutdownParams: Codable, Equatable, Sendable {
    public var reason: String?

    public init(reason: String? = nil) {
        self.reason = reason
    }
}

public struct ShutdownResult: Codable, Equatable, Sendable {
    public var ok: Bool

    public init(ok: Bool) {
        self.ok = ok
    }
}

public struct ChatSendParams: Codable, Equatable, Sendable {
    public var conversationId: String
    public var text: String

    public init(conversationId: String, text: String) {
        self.conversationId = conversationId
        self.text = text
    }
}

public struct ChatSendResult: Codable, Equatable, Sendable {
    public var conversationId: String
    public var messageId: String

    public init(conversationId: String, messageId: String) {
        self.conversationId = conversationId
        self.messageId = messageId
    }
}

public struct ChatCancelParams: Codable, Equatable, Sendable {
    public var conversationId: String
    public var messageId: String

    public init(conversationId: String, messageId: String) {
        self.conversationId = conversationId
        self.messageId = messageId
    }
}

public struct ChatCancelResult: Codable, Equatable, Sendable {
    public var cancelled: Bool

    public init(cancelled: Bool) {
        self.cancelled = cancelled
    }
}

public struct ChatDeltaParams: Codable, Equatable, Sendable {
    public var conversationId: String
    public var messageId: String
    public var index: Int
    public var text: String

    public init(conversationId: String, messageId: String, index: Int, text: String) {
        self.conversationId = conversationId
        self.messageId = messageId
        self.index = index
        self.text = text
    }
}

public struct ChatDoneParams: Codable, Equatable, Sendable {
    public var conversationId: String
    public var messageId: String
    public var finishReason: FinishReason
    public var usage: Usage

    public init(
        conversationId: String,
        messageId: String,
        finishReason: FinishReason,
        usage: Usage
    ) {
        self.conversationId = conversationId
        self.messageId = messageId
        self.finishReason = finishReason
        self.usage = usage
    }
}

/// `modelId` is required on the wire for `up` and `loading`. For `down` it
/// may be omitted or null. Synthesized Codable omits nil and decodes both.
public struct RuntimeStatus: Codable, Equatable, Sendable {
    public var state: RuntimeState
    public var modelId: String?

    public init(state: RuntimeState, modelId: String?) {
        self.state = state
        self.modelId = modelId
    }
}

public struct EmptyParams: Codable, Equatable, Sendable {
    public init() {}
}

public struct ErrorData: Codable, Equatable, Sendable {
    public var reason: String?
    public var method: String?

    public init(reason: String? = nil, method: String? = nil) {
        self.reason = reason
        self.method = method
    }
}

public struct ProtocolErrorBody: Codable, Equatable, Sendable {
    public var code: Int
    public var message: String
    public var data: ErrorData?

    public init(code: Int, message: String, data: ErrorData? = nil) {
        self.code = code
        self.message = message
        self.data = data
    }
}

public struct RpcRequest<Params: Codable & Equatable & Sendable>: Codable, Equatable, Sendable {
    public var jsonrpc: String
    public var id: String
    public var method: String
    public var params: Params

    public init(id: String, method: String, params: Params) {
        self.jsonrpc = "2.0"
        self.id = id
        self.method = method
        self.params = params
    }
}

public struct RpcNotification<Params: Codable & Equatable & Sendable>: Codable, Equatable, Sendable {
    public var jsonrpc: String
    public var method: String
    public var params: Params

    public init(method: String, params: Params) {
        self.jsonrpc = "2.0"
        self.method = method
        self.params = params
    }
}

public struct RpcResult<Result: Codable & Equatable & Sendable>: Codable, Equatable, Sendable {
    public var jsonrpc: String
    public var id: String
    public var result: Result

    public init(id: String, result: Result) {
        self.jsonrpc = "2.0"
        self.id = id
        self.result = result
    }
}

/// Parse errors use JSON `null` for `id`. Synthesized optional encoding would
/// omit the key, which is a different message (a notification), so this type
/// writes null explicitly.
public struct RpcErrorMessage: Equatable, Sendable {
    public var jsonrpc: String
    public var id: String?
    public var error: ProtocolErrorBody

    public init(id: String?, error: ProtocolErrorBody) {
        self.jsonrpc = "2.0"
        self.id = id
        self.error = error
    }
}

extension RpcErrorMessage: Codable {
    enum CodingKeys: String, CodingKey {
        case jsonrpc
        case id
        case error
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        jsonrpc = try container.decode(String.self, forKey: .jsonrpc)
        if try container.decodeNil(forKey: .id) {
            id = nil
        } else {
            id = try container.decode(String.self, forKey: .id)
        }
        error = try container.decode(ProtocolErrorBody.self, forKey: .error)
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(jsonrpc, forKey: .jsonrpc)
        if let id {
            try container.encode(id, forKey: .id)
        } else {
            try container.encodeNil(forKey: .id)
        }
        try container.encode(error, forKey: .error)
    }
}

public enum WireMessage: Equatable, Sendable {
    case initializeRequest(RpcRequest<InitializeParams>)
    case shutdownRequest(RpcRequest<ShutdownParams>)
    case chatSendRequest(RpcRequest<ChatSendParams>)
    case chatCancelRequest(RpcRequest<ChatCancelParams>)
    case runtimeStatusRequest(RpcRequest<EmptyParams>)
    case initializeResult(RpcResult<InitializeResult>)
    case shutdownResult(RpcResult<ShutdownResult>)
    case chatSendResult(RpcResult<ChatSendResult>)
    case chatCancelResult(RpcResult<ChatCancelResult>)
    case runtimeStatusResult(RpcResult<RuntimeStatus>)
    case chatDelta(RpcNotification<ChatDeltaParams>)
    case chatDone(RpcNotification<ChatDoneParams>)
    case runtimeStatus(RpcNotification<RuntimeStatus>)
    case error(RpcErrorMessage)

    public var requestID: String? {
        switch self {
        case .initializeRequest(let message): message.id
        case .shutdownRequest(let message): message.id
        case .chatSendRequest(let message): message.id
        case .chatCancelRequest(let message): message.id
        case .runtimeStatusRequest(let message): message.id
        case .initializeResult(let message): message.id
        case .shutdownResult(let message): message.id
        case .chatSendResult(let message): message.id
        case .chatCancelResult(let message): message.id
        case .runtimeStatusResult(let message): message.id
        case .error(let message): message.id
        case .chatDelta, .chatDone, .runtimeStatus:
            nil
        }
    }
}

public enum WireError: Error, Equatable, Sendable {
    case lineTooLong
    case invalidRequest
    case unknownField(String)
    case unknownMethod(String)
}
