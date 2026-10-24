import Foundation
import CookieProtocol

public enum TurnRole: String, Equatable, Sendable {
    case you
    case cookie
}

public struct ChatTurn: Equatable, Sendable, Identifiable {
    public var index: Int
    public var role: TurnRole
    public var text: String
    public var streaming: Bool
    public var badge: String?

    public var id: String { "\(role.rawValue).\(index)" }

    public init(
        index: Int,
        role: TurnRole,
        text: String,
        streaming: Bool,
        badge: String?
    ) {
        self.index = index
        self.role = role
        self.text = text
        self.streaming = streaming
        self.badge = badge
    }
}

public enum SendPreparation: Equatable, Sendable {
    case ignore
    case refused
    case send(text: String)
}

public struct PopupConversation: Equatable, Sendable {
    public var turns: [ChatTurn]
    public var draft: String
    public var draftSavedAt: Date?
    public var replyInFlight: Bool
    public var inflightMessageID: String?
    public var cookieTextStarted: Bool

    public init(
        turns: [ChatTurn] = [],
        draft: String = "",
        draftSavedAt: Date? = nil,
        replyInFlight: Bool = false,
        inflightMessageID: String? = nil,
        cookieTextStarted: Bool = false
    ) {
        self.turns = turns
        self.draft = draft
        self.draftSavedAt = draftSavedAt
        self.replyInFlight = replyInFlight
        self.inflightMessageID = inflightMessageID
        self.cookieTextStarted = cookieTextStarted
    }

    public mutating func prepareSend(runtime: RuntimeState) -> SendPreparation {
        if draft.isEmpty { return .ignore }
        if draft.count > 100_000 { return .refused }
        if runtime != .up || replyInFlight { return .refused }
        let text = draft
        draft = ""
        draftSavedAt = nil
        let index = turns.filter { $0.role == .you }.count
        turns.append(ChatTurn(
            index: index,
            role: .you,
            text: text,
            streaming: false,
            badge: nil
        ))
        replyInFlight = true
        inflightMessageID = nil
        cookieTextStarted = false
        return .send(text: text)
    }

    public mutating func noteAck(messageID: String) {
        if inflightMessageID == nil {
            inflightMessageID = messageID
        }
    }

    public mutating func applyDelta(_ delta: ChatDeltaParams) {
        guard replyInFlight else { return }
        if inflightMessageID == nil {
            inflightMessageID = delta.messageId
        } else if delta.messageId != inflightMessageID {
            return
        }
        cookieTextStarted = true
        if let index = turns.lastIndex(where: { $0.role == .cookie && $0.streaming }) {
            turns[index].text += delta.text
            return
        }
        let cookieIndex = turns.filter { $0.role == .cookie }.count
        turns.append(ChatTurn(
            index: cookieIndex,
            role: .cookie,
            text: delta.text,
            streaming: true,
            badge: CookieCopy.onDevice
        ))
    }

    public mutating func applyDone(_ done: ChatDoneParams) {
        guard replyInFlight else { return }
        if let inflightMessageID, done.messageId != inflightMessageID { return }
        replyInFlight = false
        cookieTextStarted = false
        inflightMessageID = nil
        if let index = turns.lastIndex(where: { $0.role == .cookie && $0.streaming }) {
            turns[index].streaming = false
            if !turns[index].text.isEmpty {
                turns[index].badge = CookieCopy.onDevice
            }
        }
    }

    /// A refused or failed send adds no `cookie` turn and puts the text back.
    public mutating func rollbackSend(restoredText: String) {
        guard !cookieTextStarted else { return }
        replyInFlight = false
        inflightMessageID = nil
        if let index = turns.lastIndex(where: { $0.role == .you }) {
            turns.remove(at: index)
        }
        if draft.isEmpty {
            draft = restoredText
        }
    }

    public mutating func recallLastUserText() {
        guard let last = turns.last(where: { $0.role == .you }) else { return }
        draft = last.text
    }

    public mutating func noteClose(at date: Date) {
        draftSavedAt = draft.isEmpty ? nil : date
    }

    public mutating func noteOpen(at date: Date, ttl: TimeInterval = PopupLayout.draftTTL) {
        guard let saved = draftSavedAt else { return }
        if date.timeIntervalSince(saved) > ttl {
            draft = ""
            draftSavedAt = nil
        }
    }
}
