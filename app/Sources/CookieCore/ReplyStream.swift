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

/// Decides when a burst of `chat.delta` should publish to SwiftUI.
/// The session still applies every delta immediately, so Stop sees the first
/// chunk and its message id. This only coalesces the view update.
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
