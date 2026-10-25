import Foundation
import CookieProtocol

public struct PopupChatSnapshot: Equatable, Sendable {
    public var popupOpen: Bool
    public var conversation: PopupConversation
    public var runtime: RuntimeState
    public var sendControl: PopupSendControl

    public init(
        popupOpen: Bool,
        conversation: PopupConversation,
        runtime: RuntimeState,
        sendControl: PopupSendControl
    ) {
        self.popupOpen = popupOpen
        self.conversation = conversation
        self.runtime = runtime
        self.sendControl = sendControl
    }
}

public struct PopupSendFailure: Sendable {
    public var text: String
    public var code: Int?
    public var description: String

    public init(text: String, code: Int?, description: String) {
        self.text = text
        self.code = code
        self.description = description
    }
}

/// Popup send / stop / escape. Return while a reply is arriving sends one
/// `chat.cancel`. Escape does the same and leaves the panel open. Escape
/// closes the panel only when nothing is arriving. A cancel result is matched
/// to its message id, so a late `cancelled: false` does not settle the next reply.
public final class PopupChatSession: @unchecked Sendable {
    public let conversationID: String
    public var onChange: @Sendable () -> Void = {}
    public var onSendFailure: @Sendable (PopupSendFailure) -> Void = { _ in }
    public var onCancelFailure: @Sendable (String) -> Void = { _ in }

    private let lock = NSLock()
    private var state = PopupChatState()
    private var supervisor: CoreSupervisor?

    public init(conversationID: String) {
        self.conversationID = conversationID
    }

    public func attach(_ supervisor: CoreSupervisor) {
        lock.lock()
        self.supervisor = supervisor
        lock.unlock()
    }

    public var snapshot: PopupChatSnapshot {
        lock.lock()
        defer { lock.unlock() }
        return PopupChatSnapshot(
            popupOpen: state.popupOpen,
            conversation: state.conversation,
            runtime: state.runtime,
            sendControl: popupSendControl(
                runtime: state.runtime,
                replyInFlight: state.conversation.replyInFlight
            )
        )
    }

    public func setDraft(_ text: String) {
        mutate { state in
            state.conversation.draft = text
            return .none
        }
    }

    public func setRuntime(_ state: RuntimeState) {
        noteRuntime(state)
    }

    public func noteRuntime(_ runtime: RuntimeState) {
        mutate { state in
            state.runtime = runtime
            state.conversation.noteRuntime(runtime)
            return .none
        }
    }

    public func open(at date: Date = Date()) {
        mutate { state in
            state.popupOpen = true
            state.conversation.noteOpen(at: date)
            return .none
        }
    }

    /// Click outside and the hotkey. Does not cancel an in-flight reply.
    public func close(at date: Date = Date()) {
        mutate { state in
            guard state.popupOpen else { return .none }
            state.conversation.noteClose(at: date)
            state.popupOpen = false
            return .none
        }
    }

    public func recallLast() {
        mutate { state in
            state.conversation.recallLastUserText()
            return .none
        }
    }

    public func setRefusal(_ refusal: SendRefusal?) {
        mutate { state in
            state.conversation.refusal = refusal
            return .none
        }
    }

    public func clearRefusal() {
        setRefusal(nil)
    }

    /// Return, the send/stop button, and AXConfirm.
    public func pressReturn() {
        mutate { $0.pressReturn() }
    }

    /// Escape. Stops a reply that is still arriving. Closes only when idle.
    public func pressEscape() {
        mutate { $0.pressEscape() }
    }

    public func ingest(_ event: CoreEvent) {
        switch event {
        case .runtime(let status):
            noteRuntime(status.state)
        case .delta(let delta):
            ingestDelta(delta)
        case .done(let done):
            ingestDone(done)
        case .rpcError, .decodeFailed:
            break
        }
    }

    public func ingestDelta(_ delta: ChatDeltaParams) {
        mutate { $0.ingestDelta(delta) }
    }

    public func ingestDone(_ done: ChatDoneParams) {
        mutate { $0.ingestDone(done) }
    }

    private func mutate(_ body: (inout PopupChatState) -> PopupEffect) {
        lock.lock()
        let effect = body(&state)
        lock.unlock()
        onChange()
        perform(effect)
    }

    private func perform(_ effect: PopupEffect) {
        switch effect {
        case .none:
            return
        case .send(let text):
            let supervisor = currentSupervisor()
            let conversationID = self.conversationID
            guard let supervisor else {
                mutate { state in
                    state.rollbackSend(restoredText: text)
                    return .none
                }
                return
            }
            Task {
                do {
                    let ack = try await supervisor.sendChat(
                        conversationId: conversationID,
                        text: text
                    )
                    self.mutate { $0.noteAck(messageID: ack.messageId) }
                } catch {
                    let failure = popupSendFailure(text: text, error: error)
                    self.mutate { state in
                        state.rollbackSend(restoredText: text)
                        return .none
                    }
                    self.onSendFailure(failure)
                }
            }
        case .cancel(let messageID):
            let supervisor = currentSupervisor()
            let conversationID = self.conversationID
            guard let supervisor else {
                mutate { state in
                    state.noteCancelFailed(messageID: messageID)
                    state.settleIfStill(messageID)
                    return .none
                }
                return
            }
            Task {
                do {
                    _ = try await supervisor.cancelChat(
                        conversationId: conversationID,
                        messageId: messageID
                    )
                    self.mutate { state in
                        state.noteCancelResult(messageID: messageID)
                        return .none
                    }
                } catch {
                    self.mutate { state in
                        state.noteCancelFailed(messageID: messageID)
                        return .none
                    }
                    self.onCancelFailure(String(describing: error))
                }
            }
        }
    }

    private func currentSupervisor() -> CoreSupervisor? {
        lock.lock()
        defer { lock.unlock() }
        return supervisor
    }
}

private enum PopupEffect {
    case none
    case send(String)
    case cancel(String)
}

private struct PopupChatState {
    var popupOpen = false
    var conversation = PopupConversation()
    var runtime = RuntimeState.down
    /// `chat.cancel` already handed to the supervisor for this message.
    var cancelForMessageID: String?
    /// Stop was asked before the ack or the first delta provided a message id.
    var cancelWhenAcked = false

    mutating func pressReturn() -> PopupEffect {
        if conversation.replyInFlight {
            return requestStop()
        }
        cancelForMessageID = nil
        cancelWhenAcked = false
        switch conversation.prepareSend(runtime: runtime) {
        case .send(let text):
            return .send(text)
        case .ignore, .refused:
            return .none
        }
    }

    mutating func pressEscape() -> PopupEffect {
        guard popupOpen else { return .none }
        if conversation.replyInFlight {
            return requestStop()
        }
        conversation.noteClose(at: Date())
        popupOpen = false
        return .none
    }

    mutating func ingestDelta(_ delta: ChatDeltaParams) -> PopupEffect {
        conversation.applyDelta(delta)
        return cancelIfQueued()
    }

    mutating func ingestDone(_ done: ChatDoneParams) -> PopupEffect {
        let wasInFlight = conversation.replyInFlight
        conversation.applyDone(done)
        if wasInFlight, !conversation.replyInFlight {
            cancelWhenAcked = false
        }
        return .none
    }

    mutating func noteAck(messageID: String) -> PopupEffect {
        guard conversation.replyInFlight else {
            cancelWhenAcked = false
            return .none
        }
        conversation.noteAck(messageID: messageID)
        return cancelIfQueued()
    }

    /// Either the stream ended or this result says the core is no longer
    /// streaming that message. A result for a different id is ignored.
    mutating func noteCancelResult(messageID: String) {
        if cancelForMessageID == messageID {
            cancelForMessageID = nil
        }
        settleIfStill(messageID)
    }

    mutating func noteCancelFailed(messageID: String) {
        if cancelForMessageID == messageID {
            cancelForMessageID = nil
        }
    }

    mutating func rollbackSend(restoredText: String) {
        conversation.rollbackSend(restoredText: restoredText)
        cancelWhenAcked = false
        cancelForMessageID = nil
    }

    mutating func settleIfStill(_ messageID: String) {
        guard conversation.replyInFlight, conversation.inflightMessageID == messageID else {
            return
        }
        conversation.settleInFlightReply()
    }

    private mutating func requestStop() -> PopupEffect {
        if cancelWhenAcked || cancelForMessageID != nil {
            return .none
        }
        if let messageID = conversation.inflightMessageID {
            cancelForMessageID = messageID
            return .cancel(messageID)
        }
        cancelWhenAcked = true
        return .none
    }

    private mutating func cancelIfQueued() -> PopupEffect {
        guard cancelWhenAcked, cancelForMessageID == nil, conversation.replyInFlight else {
            return .none
        }
        guard let messageID = conversation.inflightMessageID else { return .none }
        cancelWhenAcked = false
        cancelForMessageID = messageID
        return .cancel(messageID)
    }
}

private func popupSendFailure(text: String, error: Error) -> PopupSendFailure {
    let code: Int?
    if let core = error as? CoreError, case .rpc(let body) = core {
        code = body.code
    } else {
        code = nil
    }
    return PopupSendFailure(text: text, code: code, description: String(describing: error))
}
