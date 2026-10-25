import Foundation
import CookieProtocol

/// Streaming reply text. `applyDelta` ignores a chunk once the reply is no
/// longer in flight, so a buffer has to be applied before `chat.done`.
public enum ReplyStream {
    /// About 30 Hz. The popup publishes at this rate instead of once per token.
    public static let flushInterval: TimeInterval = 1.0 / 30.0

    @discardableResult
    public static func apply(
        _ deltas: [ChatDeltaParams],
        to conversation: inout PopupConversation
    ) -> String {
        for delta in deltas {
            conversation.applyDelta(delta)
        }
        return cookieText(in: conversation)
    }

    /// Apply every pending delta, then `chat.done`.
    @discardableResult
    public static func finish(
        pending deltas: [ChatDeltaParams],
        done: ChatDoneParams,
        conversation: inout PopupConversation
    ) -> String {
        apply(deltas, to: &conversation)
        conversation.applyDone(done)
        return cookieText(in: conversation)
    }

    public static func cookieText(in conversation: PopupConversation) -> String {
        conversation.turns.last(where: { $0.role == .cookie })?.text ?? ""
    }

    /// One log line. Newlines in the reply become the two characters `\n`.
    public static func escapeForLog(_ text: String) -> String {
        var out = ""
        out.reserveCapacity(text.count)
        for scalar in text.unicodeScalars {
            switch scalar.value {
            case 10:
                out += "\\n"
            case 13:
                out += "\\r"
            case 92:
                out += "\\\\"
            default:
                out.unicodeScalars.append(scalar)
            }
        }
        return out
    }

    public static func doneLog(messageId: String, accumulated: String) -> String {
        "chat.done messageId=\(messageId) accumulated=\(escapeForLog(accumulated))"
    }
}

/// Holds `chat.delta` until a flush or `chat.done`.
/// `finish` applies the buffer and then `chat.done`. Applying `chat.done`
/// first drops the tail, because `applyDelta` no-ops once the reply is settled.
public struct ReplyDeltaBuffer: Equatable, Sendable {
    public private(set) var pending: [ChatDeltaParams] = []

    public init() {}

    public mutating func append(_ delta: ChatDeltaParams) {
        pending.append(delta)
    }

    public mutating func takePending() -> [ChatDeltaParams] {
        let batch = pending
        pending = []
        return batch
    }

    @discardableResult
    public mutating func finish(
        _ done: ChatDoneParams,
        conversation: inout PopupConversation
    ) -> String {
        let text = ReplyStream.finish(pending: pending, done: done, conversation: &conversation)
        pending = []
        return text
    }
}

/// Decides when a burst of `chat.delta` should reach the session and SwiftUI.
/// The shell keeps those deltas in `ReplyDeltaBuffer` and delivers the whole
/// buffer before `chat.done`.
public struct ReplyUICoalescer: Equatable, Sendable {
    public private(set) var dirty = false
    public private(set) var flushPending = false

    public init() {}

    /// A delta was applied. Returns whether the caller should schedule one flush.
    public mutating func noteDelta() -> Bool {
        dirty = true
        if flushPending { return false }
        flushPending = true
        return true
    }

    /// The flush timer fired. Returns whether the view should publish.
    public mutating func noteFlush() -> Bool {
        flushPending = false
        let publish = dirty
        dirty = false
        return publish
    }

    /// `chat.done` publishes immediately. A timer that fires afterwards does not.
    public mutating func noteDone() {
        flushPending = false
        dirty = false
    }
}
