import Foundation
import CookieProtocol

public enum CoreEvent: Equatable, Sendable {
    case runtime(RuntimeStatus)
    case delta(ChatDeltaParams)
    case done(ChatDoneParams)
    case rpcError(id: String?, ProtocolErrorBody)
    case decodeFailed(String)
}

public enum CoreError: Error, Equatable, Sendable {
    case timeout
    case disconnected
    case rpc(ProtocolErrorBody)
    case unexpected(String)
}

private final class ReplyWait<Value>: @unchecked Sendable {
    var continuation: CheckedContinuation<Value, Error>?
}

public actor CoreSupervisor {
    private let transport: any CoreTransport
    private var nextID = 0
    private var reader: Task<Void, Never>?
    private var requestWaits: [String: ReplyWait<WireMessage>] = [:]
    private var doneWaits: [String: ReplyWait<ChatDoneParams>] = [:]
    private var stateWaits: [ReplyWait<RuntimeStatus>] = []
    private var partials: [String: String] = [:]
    private var finished: [String: ChatDoneParams] = [:]
    public private(set) var runtime = RuntimeStatus(state: .down, modelId: nil)
    private var runtimeGeneration = 0
    private let eventsContinuation: AsyncStream<CoreEvent>.Continuation
    public nonisolated let events: AsyncStream<CoreEvent>

    public init(transport: any CoreTransport) {
        self.transport = transport
        let pair = AsyncStream<CoreEvent>.makeStream(bufferingPolicy: .unbounded)
        self.events = pair.stream
        self.eventsContinuation = pair.continuation
    }

    public func start() throws {
        if reader != nil { return }
        try transport.start()
        let lines = transport.lines
        reader = Task {
            for await line in lines {
                await self.ingest(line)
            }
            await self.failAll(CoreError.disconnected)
        }
    }

    public func initialize(timeout seconds: Double = 20) async throws -> (InitializeResult, RuntimeStatus) {
        let id = nextRequestID()
        let message = WireMessage.initializeRequest(RpcRequest(
            id: id,
            method: "initialize",
            params: InitializeParams(
                protocolVersion: protocolVersion,
                clientInfo: PeerInfo(name: shellClientName, version: shellClientVersion),
                capabilities: ClientCapabilities(chatCancel: true)
            )
        ))
        let generation = runtimeGeneration
        let response = try await request(message, id: id, seconds: seconds)
        guard case .initializeResult(let result) = response else {
            throw CoreError.unexpected("initialize result")
        }
        let status = try await waitForGeneration(after: generation, seconds: seconds)
        return (result.result, status)
    }

    public func sendChat(
        conversationId: String,
        text: String,
        timeout seconds: Double = 20
    ) async throws -> ChatSendResult {
        let id = nextRequestID()
        let message = WireMessage.chatSendRequest(RpcRequest(
            id: id,
            method: "chat.send",
            params: ChatSendParams(conversationId: conversationId, text: text)
        ))
        let response = try await request(message, id: id, seconds: seconds)
        guard case .chatSendResult(let result) = response else {
            throw CoreError.unexpected("chat.send result")
        }
        return result.result
    }

    /// Shell → core notification. The core does not echo it. `loading` and
    /// `up` include `modelId`. `down` omits it.
    public func pushRuntime(_ status: RuntimeStatus) throws {
        let message = WireMessage.runtimeStatus(RpcNotification(
            method: "runtime.status",
            params: status
        ))
        let line = try encodeLine(message)
        try transport.writeLine(line)
    }

    public func shutdown(timeout seconds: Double = 5) async throws {
        let id = nextRequestID()
        let message = WireMessage.shutdownRequest(RpcRequest(
            id: id,
            method: "shutdown",
            params: ShutdownParams()
        ))
        let response = try await request(message, id: id, seconds: seconds)
        guard case .shutdownResult(let result) = response, result.result.ok else {
            throw CoreError.unexpected("shutdown result")
        }
        transport.closeInput()
        eventsContinuation.finish()
    }

    public func partialText(messageId: String) -> String {
        partials[messageId] ?? ""
    }

    public func waitForDone(messageId: String, seconds: Double = 20) async throws -> ChatDoneParams {
        if let done = finished[messageId] { return done }
        let wait = ReplyWait<ChatDoneParams>()
        return try await withCheckedThrowingContinuation { continuation in
            wait.continuation = continuation
            doneWaits[messageId] = wait
            Task {
                try? await Task.sleep(for: .seconds(seconds))
                await self.timeoutDone(messageId, wait)
            }
        }
    }

    public func waitForState(_ state: RuntimeState, seconds: Double = 5) async throws -> RuntimeStatus {
        if runtime.state == state { return runtime }
        let wait = ReplyWait<RuntimeStatus>()
        return try await withCheckedThrowingContinuation { continuation in
            wait.continuation = continuation
            stateWaits.append(wait)
            Task {
                try? await Task.sleep(for: .seconds(seconds))
                await self.timeoutState(wait, expected: state)
            }
        }
    }

    /// The first `runtime.status` can be `down` with no `modelId`, which matches
    /// the supervisor's initial value. A generation counter is the signal that
    /// a notification arrived. Recheck inside the continuation so a status that
    /// landed between the request returning and the waiter registering is kept.
    private func waitForGeneration(after generation: Int, seconds: Double) async throws -> RuntimeStatus {
        if runtimeGeneration != generation { return runtime }
        let wait = ReplyWait<RuntimeStatus>()
        return try await withCheckedThrowingContinuation { continuation in
            if runtimeGeneration != generation {
                continuation.resume(returning: runtime)
                return
            }
            wait.continuation = continuation
            stateWaits.append(wait)
            Task {
                try? await Task.sleep(for: .seconds(seconds))
                await self.timeoutState(wait, expected: nil)
            }
        }
    }

    private func request(
        _ message: WireMessage,
        id: String,
        seconds: Double
    ) async throws -> WireMessage {
        let line = try encodeLine(message)
        let wait = ReplyWait<WireMessage>()
        return try await withCheckedThrowingContinuation { continuation in
            wait.continuation = continuation
            requestWaits[id] = wait
            do {
                try transport.writeLine(line)
            } catch {
                requestWaits[id] = nil
                wait.continuation = nil
                continuation.resume(throwing: error)
                return
            }
            Task {
                try? await Task.sleep(for: .seconds(seconds))
                await self.timeoutRequest(id, wait)
            }
        }
    }

    private func nextRequestID() -> String {
        nextID += 1
        return "req-\(nextID)"
    }

    private func ingest(_ line: String) {
        if line.isEmpty { return }
        let message: WireMessage
        do {
            message = try decodeWireLine(line)
        } catch {
            eventsContinuation.yield(.decodeFailed(String(describing: error)))
            return
        }
        switch message {
        case .runtimeStatus(let note):
            applyRuntime(note.params)
        case .chatDelta(let note):
            partials[note.params.messageId, default: ""] += note.params.text
            eventsContinuation.yield(.delta(note.params))
        case .chatDone(let note):
            finished[note.params.messageId] = note.params
            if let wait = doneWaits.removeValue(forKey: note.params.messageId),
               let continuation = wait.continuation {
                wait.continuation = nil
                continuation.resume(returning: note.params)
            }
            eventsContinuation.yield(.done(note.params))
        case .error(let error):
            if let id = error.id, let wait = requestWaits.removeValue(forKey: id) {
                resume(wait, throwing: CoreError.rpc(error.error))
            } else {
                eventsContinuation.yield(.rpcError(id: error.id, error.error))
            }
        case .initializeResult, .shutdownResult, .chatSendResult, .chatCancelResult, .runtimeStatusResult:
            guard let id = message.requestID, let wait = requestWaits.removeValue(forKey: id) else {
                return
            }
            resume(wait, returning: message)
        case .initializeRequest, .shutdownRequest, .chatSendRequest, .chatCancelRequest, .runtimeStatusRequest:
            eventsContinuation.yield(.decodeFailed("core sent a request"))
        }
    }

    private func applyRuntime(_ status: RuntimeStatus) {
        runtimeGeneration += 1
        runtime = status
        let waiting = stateWaits
        stateWaits.removeAll()
        for wait in waiting {
            guard let continuation = wait.continuation else { continue }
            wait.continuation = nil
            continuation.resume(returning: status)
        }
        eventsContinuation.yield(.runtime(status))
    }

    private func resume(
        _ wait: ReplyWait<WireMessage>,
        returning message: WireMessage
    ) {
        guard let continuation = wait.continuation else { return }
        wait.continuation = nil
        continuation.resume(returning: message)
    }

    private func resume(
        _ wait: ReplyWait<WireMessage>,
        throwing error: Error
    ) {
        guard let continuation = wait.continuation else { return }
        wait.continuation = nil
        continuation.resume(throwing: error)
    }

    private func timeoutRequest(_ id: String, _ wait: ReplyWait<WireMessage>) {
        guard requestWaits[id] === wait else { return }
        requestWaits[id] = nil
        resume(wait, throwing: CoreError.timeout)
    }

    private func timeoutDone(_ messageId: String, _ wait: ReplyWait<ChatDoneParams>) {
        guard doneWaits[messageId] === wait, let continuation = wait.continuation else { return }
        doneWaits[messageId] = nil
        wait.continuation = nil
        continuation.resume(throwing: CoreError.timeout)
    }

    private func timeoutState(_ wait: ReplyWait<RuntimeStatus>, expected: RuntimeState?) {
        guard let index = stateWaits.firstIndex(where: { $0 === wait }),
              let continuation = wait.continuation else { return }
        if expected == nil || runtime.state != expected {
            stateWaits.remove(at: index)
            wait.continuation = nil
            continuation.resume(throwing: CoreError.timeout)
        }
    }

    private func failAll(_ error: CoreError) {
        for (_, wait) in requestWaits {
            resume(wait, throwing: error)
        }
        requestWaits.removeAll()
        for (_, wait) in doneWaits {
            if let continuation = wait.continuation {
                wait.continuation = nil
                continuation.resume(throwing: error)
            }
        }
        doneWaits.removeAll()
        for wait in stateWaits {
            if let continuation = wait.continuation {
                wait.continuation = nil
                continuation.resume(throwing: error)
            }
        }
        stateWaits.removeAll()
    }
}
