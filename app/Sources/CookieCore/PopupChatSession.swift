import Foundation
import CookieProtocol

/// Time source for draft expiry and the session boundary. Tests pass a clock
/// they can move. The app uses `SystemCookieClock`.
public protocol CookieClock: Sendable {
    func now() -> Date
}

public struct SystemCookieClock: CookieClock {
    public init() {}

    public func now() -> Date { Date() }
}

public final class ManualCookieClock: CookieClock, @unchecked Sendable {
    private let lock = NSLock()
    private var instant: Date

    public init(_ instant: Date) {
        self.instant = instant
    }

    public func now() -> Date {
        lock.lock()
        defer { lock.unlock() }
        return instant
    }

    public func advance(by interval: TimeInterval) {
        lock.lock()
        instant = instant.addingTimeInterval(interval)
        lock.unlock()
    }
}

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
    public var onChange: @Sendable () -> Void = {}
    public var onSendFailure: @Sendable (PopupSendFailure) -> Void = { _ in }
    public var onCancelFailure: @Sendable (String) -> Void = { _ in }
    /// Runs on the main queue before a cancel result settles the reply.
    /// The shell delivers buffered `chat.delta` here. `applyDelta` drops a
    /// tail once the reply is no longer in flight.
    public var onBeforeCancelSettle: @Sendable () -> Void = {}

    private let lock = NSLock()
    private var state: PopupChatState
    private var supervisor: CoreSupervisor?
    private let clock: any CookieClock
    private let makeConversationID: @Sendable () -> String

    public init(
        conversationID: String,
        clock: any CookieClock = SystemCookieClock(),
        draftTTL: TimeInterval = PopupLayout.draftTTL,
        makeConversationID: @escaping @Sendable () -> String = { "conv-\(UUID().uuidString)" }
    ) {
        self.clock = clock
        self.makeConversationID = makeConversationID
        self.state = PopupChatState(conversationID: conversationID, draftTTL: draftTTL)
    }

    public var conversationID: String {
        lock.lock()
        defer { lock.unlock() }
        return state.conversationID
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

    public func open(at date: Date? = nil) {
        let now = date ?? clock.now()
        mutate { state in
            state.noteOpen(at: now)
            return .none
        }
    }

    /// Click outside and the hotkey. Does not cancel an in-flight reply.
    public func close(at date: Date? = nil) {
        let now = date ?? clock.now()
        mutate { state in
            _ = state.noteClose(at: now)
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
        let makeID = makeConversationID
        mutate { state in
            state.pressReturn(makeID: makeID)
        }
    }

    /// ⌘K. Clears nothing in the transcript. The field clears itself.
    /// The next `chat.send` uses the new conversation id.
    public func pressCommandK() {
        let freshID = makeConversationID()
        mutate { state in
            state.beginNewConversation(id: freshID)
            return .none
        }
    }

    /// Escape. Stops a reply that is still arriving. Closes only when idle.
    public func pressEscape() {
        let now = clock.now()
        mutate { $0.pressEscape(at: now) }
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
        case .send(let text, let conversationID):
            let supervisor = currentSupervisor()
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
        case .cancel(let messageID, let conversationID):
            let supervisor = currentSupervisor()
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
                    self.settleCancelOnMain(messageID: messageID)
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

    /// Deltas and `chat.done` are applied on the main queue. A cancel result
    /// that settles from the request task drops a tail still sitting in the
    /// shell's buffer. Flush that buffer, then settle, both on main.
    private func settleCancelOnMain(messageID: String) {
        let work = {
            self.onBeforeCancelSettle()
            self.mutate { state in
                state.noteCancelResult(messageID: messageID)
                return .none
            }
        }
        if Thread.isMainThread {
            work()
        } else {
            DispatchQueue.main.sync(execute: work)
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
    case send(text: String, conversationID: String)
    case cancel(messageID: String, conversationID: String)
}

private struct PopupChatState {
    var conversationID: String
    var draftTTL: TimeInterval
    var popupOpen = false
    var conversation = PopupConversation()
    var runtime = RuntimeState.down
    /// When the popup last went from open to closed.
    var closedAt: Date?
    /// The last close lasted at least `draftTTL`. The next send, or ⌘K, consumes it.
    var sessionExpired = false
    /// Conversation id of the reply that is in flight. Cancel keeps this id
    /// after ⌘K mints a new one.
    var inflightConversationID: String?
    /// `chat.cancel` already handed to the supervisor for this message.
    var cancelForMessageID: String?
    /// Stop was asked before the ack or the first delta provided a message id.
    var cancelWhenAcked = false

    mutating func beginNewConversation(id: String) {
        conversationID = id
        sessionExpired = false
    }

    mutating func noteOpen(at date: Date) {
        if !popupOpen, let closedAt, date.timeIntervalSince(closedAt) >= draftTTL {
            sessionExpired = true
        }
        popupOpen = true
        conversation.noteOpen(at: date, ttl: draftTTL)
    }

    mutating func noteClose(at date: Date) -> PopupEffect {
        guard popupOpen else { return .none }
        conversation.noteClose(at: date)
        closedAt = date
        popupOpen = false
        return .none
    }

    mutating func pressReturn(makeID: () -> String) -> PopupEffect {
        if conversation.replyInFlight {
            return requestStop()
        }
        cancelForMessageID = nil
        cancelWhenAcked = false
        switch conversation.prepareSend(runtime: runtime) {
        case .send(let text):
            if sessionExpired {
                beginNewConversation(id: makeID())
            }
            inflightConversationID = conversationID
            return .send(text: text, conversationID: conversationID)
        case .ignore, .refused:
            return .none
        }
    }

    mutating func pressEscape(at now: Date) -> PopupEffect {
        guard popupOpen else { return .none }
        if conversation.replyInFlight {
            return requestStop()
        }
        return noteClose(at: now)
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
            let id = inflightConversationID ?? conversationID
            return .cancel(messageID: messageID, conversationID: id)
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
        let id = inflightConversationID ?? conversationID
        return .cancel(messageID: messageID, conversationID: id)
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
