import Foundation

private struct KeyTree {
    var keys: Set<String>
    var children: [String: KeyTree] = [:]
}

public func encodeWire(_ message: WireMessage) throws -> Data {
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
    switch message {
    case .initializeRequest(let value):
        return try encoder.encode(value)
    case .shutdownRequest(let value):
        return try encoder.encode(value)
    case .chatSendRequest(let value):
        return try encoder.encode(value)
    case .chatCancelRequest(let value):
        return try encoder.encode(value)
    case .runtimeStatusRequest(let value):
        return try encoder.encode(value)
    case .initializeResult(let value):
        return try encoder.encode(value)
    case .shutdownResult(let value):
        return try encoder.encode(value)
    case .chatSendResult(let value):
        return try encoder.encode(value)
    case .chatCancelResult(let value):
        return try encoder.encode(value)
    case .runtimeStatusResult(let value):
        return try encoder.encode(value)
    case .chatDelta(let value):
        return try encoder.encode(value)
    case .chatDone(let value):
        return try encoder.encode(value)
    case .runtimeStatus(let value):
        return try encoder.encode(value)
    case .error(let value):
        return try encoder.encode(value)
    }
}

public func encodeLine(_ message: WireMessage) throws -> String {
    let data = try encodeWire(message)
    return String(decoding: data, as: UTF8.self) + "\n"
}

public func decodeWire(data: Data) throws -> WireMessage {
    if data.count > LineFramer.maxLineBytes {
        throw WireError.lineTooLong
    }
    let trimmed = trimmingJSONSpace(data)
    if trimmed.isEmpty {
        throw WireError.invalidRequest
    }
    let parsed: Any
    do {
        parsed = try JSONSerialization.jsonObject(with: trimmed)
    } catch {
        throw WireError.invalidRequest
    }
    guard let object = parsed as? [String: Any] else {
        throw WireError.invalidRequest
    }
    try allow(object, envelopeKeys)
    guard (object["jsonrpc"] as? String) == "2.0" else {
        throw WireError.invalidRequest
    }
    if object["error"] != nil {
        return .error(try decodeError(object))
    }
    if object.keys.contains("method") {
        guard let method = object["method"] as? String else {
            throw WireError.invalidRequest
        }
        switch try readID(object) {
        case .absent:
            return try decodeNotification(object, method: method)
        case .null:
            throw WireError.invalidRequest
        case .string(let id):
            guard validRequestID(id) else { throw WireError.invalidRequest }
            return try decodeRequest(object, method: method)
        }
    }
    guard object["result"] != nil else {
        throw WireError.invalidRequest
    }
    guard case .string(let id) = try readID(object), validRequestID(id) else {
        throw WireError.invalidRequest
    }
    return try decodeResult(object)
}

public func decodeWireLine(_ line: String) throws -> WireMessage {
    guard let data = line.data(using: .utf8) else {
        throw WireError.invalidRequest
    }
    return try decodeWire(data: data)
}

private func trimmingJSONSpace(_ data: Data) -> Data {
    let space: Set<UInt8> = [0x20, 0x09, 0x0A, 0x0D]
    var start = data.startIndex
    var end = data.endIndex
    while start < end, space.contains(data[start]) {
        start = data.index(after: start)
    }
    while end > start, space.contains(data[data.index(before: end)]) {
        end = data.index(before: end)
    }
    return data.subdata(in: start..<end)
}

private let envelopeKeys: Set<String> = ["jsonrpc", "id", "method", "params", "result", "error"]

private let peerTree = KeyTree(keys: ["name", "version"])
private let clientCapsTree = KeyTree(keys: ["chatCancel"])
private let serverCapsTree = KeyTree(
    keys: ["chat", "runtime"],
    children: [
        "chat": KeyTree(keys: ["stream", "cancel"]),
        "runtime": KeyTree(keys: ["status"]),
    ]
)
private let usageTree = KeyTree(keys: ["inputTokens", "outputTokens"])
private let errorDataTree = KeyTree(keys: ["reason", "method"])
private let errorBodyTree = KeyTree(
    keys: ["code", "message", "data"],
    children: ["data": errorDataTree]
)
private let runtimeTree = KeyTree(keys: ["state", "modelId"])

private enum IDField {
    case absent
    case null
    case string(String)
}

private func readID(_ object: [String: Any]) throws -> IDField {
    guard object.keys.contains("id") else { return .absent }
    let value = object["id"] as Any
    if value is NSNull { return .null }
    if let string = value as? String { return .string(string) }
    throw WireError.invalidRequest
}

private func validRequestID(_ id: String) -> Bool {
    guard (1...128).contains(id.count) else { return false }
    return id.range(of: "^[A-Za-z0-9._:-]+$", options: .regularExpression) != nil
}

private func allow(_ object: [String: Any], _ keys: Set<String>) throws {
    for key in object.keys where !keys.contains(key) {
        throw WireError.unknownField(key)
    }
}

private func check(_ value: Any?, tree: KeyTree) throws {
    guard let object = value as? [String: Any] else {
        throw WireError.invalidRequest
    }
    for key in object.keys {
        guard tree.keys.contains(key) else { throw WireError.unknownField(key) }
        if let child = tree.children[key] {
            if object[key] is NSNull { continue }
            try check(object[key], tree: child)
        }
    }
}

private func asDictionary(_ value: Any?) throws -> [String: Any] {
    guard let dictionary = value as? [String: Any] else {
        throw WireError.invalidRequest
    }
    return dictionary
}

private func decodeJSON<T: Decodable>(_ type: T.Type, from object: [String: Any]) throws -> T {
    let data = try JSONSerialization.data(withJSONObject: object)
    do {
        return try JSONDecoder().decode(T.self, from: data)
    } catch {
        throw WireError.invalidRequest
    }
}

private func decodeError(_ object: [String: Any]) throws -> RpcErrorMessage {
    switch try readID(object) {
    case .absent:
        throw WireError.invalidRequest
    case .null:
        break
    case .string(let id):
        guard validRequestID(id) else { throw WireError.invalidRequest }
    }
    try check(object["error"], tree: errorBodyTree)
    let message = try decodeJSON(RpcErrorMessage.self, from: object)
    guard message.jsonrpc == "2.0" else { throw WireError.invalidRequest }
    return message
}

private func decodeRequest(_ object: [String: Any], method: String) throws -> WireMessage {
    let params = try asDictionary(object["params"])
    switch method {
    case "initialize":
        try check(params, tree: KeyTree(
            keys: ["protocolVersion", "clientInfo", "capabilities"],
            children: ["clientInfo": peerTree, "capabilities": clientCapsTree]
        ))
        let message = try decodeJSON(RpcRequest<InitializeParams>.self, from: object)
        guard message.method == "initialize" else { throw WireError.invalidRequest }
        return .initializeRequest(message)
    case "shutdown":
        try allow(params, ["reason"])
        let message = try decodeJSON(RpcRequest<ShutdownParams>.self, from: object)
        return .shutdownRequest(message)
    case "chat.send":
        try allow(params, ["conversationId", "text"])
        let message = try decodeJSON(RpcRequest<ChatSendParams>.self, from: object)
        return .chatSendRequest(message)
    case "chat.cancel":
        try allow(params, ["conversationId", "messageId"])
        let message = try decodeJSON(RpcRequest<ChatCancelParams>.self, from: object)
        return .chatCancelRequest(message)
    case "runtime.status":
        try allow(params, [])
        let message = try decodeJSON(RpcRequest<EmptyParams>.self, from: object)
        return .runtimeStatusRequest(message)
    default:
        throw WireError.unknownMethod(method)
    }
}

private func decodeNotification(_ object: [String: Any], method: String) throws -> WireMessage {
    let params = try asDictionary(object["params"])
    switch method {
    case "chat.delta":
        try allow(params, ["conversationId", "messageId", "index", "text"])
        let message = try decodeJSON(RpcNotification<ChatDeltaParams>.self, from: object)
        return .chatDelta(message)
    case "chat.done":
        try check(params, tree: KeyTree(
            keys: ["conversationId", "messageId", "finishReason", "usage"],
            children: ["usage": usageTree]
        ))
        let message = try decodeJSON(RpcNotification<ChatDoneParams>.self, from: object)
        return .chatDone(message)
    case "runtime.status":
        try allow(params, runtimeTree.keys)
        try requireModelID(params)
        let message = try decodeJSON(RpcNotification<RuntimeStatus>.self, from: object)
        return .runtimeStatus(message)
    default:
        throw WireError.unknownMethod(method)
    }
}

private func decodeResult(_ object: [String: Any]) throws -> WireMessage {
    let result = try asDictionary(object["result"])
    if result["protocolVersion"] != nil {
        try check(result, tree: KeyTree(
            keys: ["protocolVersion", "serverInfo", "capabilities"],
            children: ["serverInfo": peerTree, "capabilities": serverCapsTree]
        ))
        let message = try decodeJSON(RpcResult<InitializeResult>.self, from: object)
        guard message.result.protocolVersion == protocolVersion else {
            throw WireError.invalidRequest
        }
        return .initializeResult(message)
    }
    if result["ok"] != nil {
        try allow(result, ["ok"])
        let message = try decodeJSON(RpcResult<ShutdownResult>.self, from: object)
        return .shutdownResult(message)
    }
    if result["cancelled"] != nil {
        try allow(result, ["cancelled"])
        let message = try decodeJSON(RpcResult<ChatCancelResult>.self, from: object)
        return .chatCancelResult(message)
    }
    if result["state"] != nil {
        try allow(result, runtimeTree.keys)
        try requireModelID(result)
        let message = try decodeJSON(RpcResult<RuntimeStatus>.self, from: object)
        return .runtimeStatusResult(message)
    }
    if result["messageId"] != nil {
        try allow(result, ["conversationId", "messageId"])
        let message = try decodeJSON(RpcResult<ChatSendResult>.self, from: object)
        return .chatSendResult(message)
    }
    throw WireError.invalidRequest
}

private func requireModelID(_ params: [String: Any]) throws {
    guard let state = params["state"] as? String else {
        throw WireError.invalidRequest
    }
    guard state == "up" || state == "loading" || state == "down" else {
        throw WireError.invalidRequest
    }
    if state == "down" {
        return
    }
    guard let modelID = params["modelId"] as? String, !modelID.isEmpty else {
        throw WireError.invalidRequest
    }
}
