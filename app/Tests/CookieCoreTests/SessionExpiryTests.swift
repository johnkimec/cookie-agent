import Foundation
import XCTest
@testable import CookieCore
@testable import CookieProtocol

/// A new conversation id after ⌘K, or on the next send once the popup has
/// been closed for at least the draft TTL. Reopening does not touch a reply
/// that is still arriving.
final class SessionExpiryTests: XCTestCase {
    func testResolvedDraftTTLOnlyShortensTheWindow() {
        XCTAssertEqual(resolvedDraftTTL(environment: [:]), PopupLayout.draftTTL)
        XCTAssertEqual(resolvedDraftTTL(environment: ["COOKIE_DRAFT_TTL_SECONDS": ""]), PopupLayout.draftTTL)
        XCTAssertEqual(resolvedDraftTTL(environment: ["COOKIE_DRAFT_TTL_SECONDS": "0"]), PopupLayout.draftTTL)
        XCTAssertEqual(resolvedDraftTTL(environment: ["COOKIE_DRAFT_TTL_SECONDS": "-3"]), PopupLayout.draftTTL)
        XCTAssertEqual(resolvedDraftTTL(environment: ["COOKIE_DRAFT_TTL_SECONDS": "nope"]), PopupLayout.draftTTL)
        XCTAssertEqual(resolvedDraftTTL(environment: ["COOKIE_DRAFT_TTL_SECONDS": "601"]), PopupLayout.draftTTL)
        XCTAssertEqual(resolvedDraftTTL(environment: ["COOKIE_DRAFT_TTL_SECONDS": "2"]), 2)
        XCTAssertEqual(resolvedDraftTTL(environment: ["COOKIE_DRAFT_TTL_SECONDS": "2.5"]), 2.5)
        XCTAssertEqual(PopupLayout.draftTTL, 600)
    }

    func testClosedShorterThanTheDraftTTLKeepsTheConversationID() async throws {
        let clock = ManualCookieClock(Date(timeIntervalSince1970: 1_000))
        let ids = ConversationIDs(["conv-b"])
        try await withSession(clock: clock, ids: ids, finish: true) { session, transport in
            session.open()
            session.setRuntime(.up)
            session.setDraft("one")
            session.pressReturn()
            let finished = await waitUntil(session: session) {
                !$0.conversation.replyInFlight && $0.conversation.turns.contains { $0.role == .cookie }
            }
            XCTAssertTrue(finished)

            session.close()
            clock.advance(by: 599)
            session.open()
            XCTAssertEqual(session.conversationID, "conv-a")
            session.setDraft("two")
            session.pressReturn()
            let second = await waitUntil(session: session) {
                $0.conversation.turns.filter { $0.role == .you }.count == 2
                    && !$0.conversation.replyInFlight
            }
            XCTAssertTrue(second)
            XCTAssertEqual(session.conversationID, "conv-a")
            XCTAssertEqual(transport.conversationIDs(), ["conv-a", "conv-a"])
        }
    }

    func testClosedForTheDraftTTLMintsAnIDOnTheNextSend() async throws {
        let clock = ManualCookieClock(Date(timeIntervalSince1970: 1_000))
        let ids = ConversationIDs(["conv-b"])
        try await withSession(clock: clock, ids: ids, ttl: 600, finish: true) { session, transport in
            session.open()
            session.setRuntime(.up)
            session.setDraft("one")
            session.pressReturn()
            let finished = await waitUntil(session: session) {
                !$0.conversation.replyInFlight && $0.conversation.turns.contains { $0.role == .cookie }
            }
            XCTAssertTrue(finished)

            session.close()
            clock.advance(by: 600)
            session.open()
            XCTAssertEqual(session.conversationID, "conv-a")
            session.setDraft("two")
            session.pressReturn()
            let second = await waitUntil(session: session) {
                $0.conversation.turns.filter { $0.role == .you }.count == 2
                    && !$0.conversation.replyInFlight
            }
            XCTAssertTrue(second)
            XCTAssertEqual(session.conversationID, "conv-b")
            XCTAssertEqual(transport.conversationIDs(), ["conv-a", "conv-b"])
        }
    }

    func testShortenedDraftTTLMintsAnIDOnTheNextSend() async throws {
        let clock = ManualCookieClock(Date(timeIntervalSince1970: 1_000))
        let ids = ConversationIDs(["conv-b"])
        let ttl = resolvedDraftTTL(environment: ["COOKIE_DRAFT_TTL_SECONDS": "2"])
        try await withSession(clock: clock, ids: ids, ttl: ttl, finish: true) { session, transport in
            session.open()
            session.setRuntime(.up)
            session.setDraft("one")
            session.pressReturn()
            let finished = await waitUntil(session: session) {
                !$0.conversation.replyInFlight && $0.conversation.turns.contains { $0.role == .cookie }
            }
            XCTAssertTrue(finished)
            session.close()
            clock.advance(by: ttl)
            session.open()
            XCTAssertEqual(session.conversationID, "conv-a")
            session.setDraft("two")
            session.pressReturn()
            let second = await waitUntil(session: session) {
                $0.conversation.turns.filter { $0.role == .you }.count == 2
                    && !$0.conversation.replyInFlight
            }
            XCTAssertTrue(second)
            XCTAssertEqual(session.conversationID, "conv-b")
            XCTAssertEqual(transport.conversationIDs(), ["conv-a", "conv-b"])
        }
    }

    func testCommandKMintsANewConversationID() async throws {
        let clock = ManualCookieClock(Date(timeIntervalSince1970: 1_000))
        let ids = ConversationIDs(["conv-b"])
        try await withSession(clock: clock, ids: ids, finish: true) { session, transport in
            session.open()
            session.setRuntime(.up)
            XCTAssertEqual(session.conversationID, "conv-a")
            session.pressCommandK()
            XCTAssertEqual(session.conversationID, "conv-b")
            session.setDraft("after clear")
            session.pressReturn()
            let sent = await waitUntil(session: session) {
                !$0.conversation.replyInFlight && $0.conversation.turns.contains { $0.role == .you }
            }
            XCTAssertTrue(sent)
            XCTAssertEqual(session.conversationID, "conv-b")
            XCTAssertEqual(transport.conversationIDs(), ["conv-b"])
            XCTAssertEqual(session.snapshot.conversation.turns.first { $0.role == .you }?.text, "after clear")
        }
    }

    func testReopeningDoesNotResetAnInFlightReply() async throws {
        let clock = ManualCookieClock(Date(timeIntervalSince1970: 1_000))
        let ids = ConversationIDs(["conv-b"])
        try await withSession(clock: clock, ids: ids, finish: false) { session, transport in
            session.open()
            session.setRuntime(.up)
            session.setDraft("still going")
            session.pressReturn()
            let sawChunk = await waitUntil(session: session) {
                $0.conversation.replyInFlight
                    && $0.conversation.turns.contains { $0.role == .cookie && $0.text == "partial" }
            }
            XCTAssertTrue(sawChunk)
            let before = session.snapshot
            XCTAssertEqual(session.conversationID, "conv-a")

            session.close()
            clock.advance(by: 600)
            session.open()

            let after = session.snapshot
            XCTAssertEqual(session.conversationID, "conv-a")
            XCTAssertTrue(after.popupOpen)
            XCTAssertTrue(after.conversation.replyInFlight)
            XCTAssertEqual(after.conversation.turns, before.conversation.turns)
            XCTAssertEqual(after.conversation.inflightMessageID, before.conversation.inflightMessageID)
            XCTAssertEqual(transport.conversationIDs(), ["conv-a"])
        }
    }

    func testCommandKDuringAReplyKeepsThatReplyOnTheOldID() async throws {
        let clock = ManualCookieClock(Date(timeIntervalSince1970: 1_000))
        let ids = ConversationIDs(["conv-b"])
        try await withSession(clock: clock, ids: ids, finish: false) { session, transport in
            session.open()
            session.setRuntime(.up)
            session.setDraft("still going")
            session.pressReturn()
            let sawChunk = await waitUntil(session: session) {
                $0.conversation.replyInFlight
                    && $0.conversation.turns.contains { $0.role == .cookie && $0.text == "partial" }
            }
            XCTAssertTrue(sawChunk)
            session.pressCommandK()
            XCTAssertEqual(session.conversationID, "conv-b")
            XCTAssertTrue(session.snapshot.conversation.replyInFlight)
            XCTAssertEqual(session.snapshot.conversation.turns.last { $0.role == .cookie }?.text, "partial")
            session.pressReturn()
            let idle = await waitUntil(session: session) { !$0.conversation.replyInFlight }
            XCTAssertTrue(idle)
            XCTAssertEqual(transport.conversationIDs(), ["conv-a"])
            XCTAssertEqual(transport.cancelledIDs(), ["conv-a"])
            XCTAssertEqual(session.conversationID, "conv-b")
            XCTAssertEqual(session.snapshot.conversation.turns.last { $0.role == .cookie }?.text, "partial")
        }
    }
}

private final class ConversationIDs: @unchecked Sendable {
    private let lock = NSLock()
    private var pending: [String]

    init(_ pending: [String]) {
        self.pending = pending
    }

    func next() -> String {
        lock.lock()
        defer { lock.unlock() }
        if pending.isEmpty { return "conv-extra" }
        return pending.removeFirst()
    }
}

private func withSession(
    clock: ManualCookieClock,
    ids: ConversationIDs,
    ttl: TimeInterval = PopupLayout.draftTTL,
    finish: Bool,
    body: (PopupChatSession, RecordingTransport) async throws -> Void
) async throws {
    let transport = RecordingTransport(finish: finish)
    let supervisor = CoreSupervisor(transport: transport)
    let session = PopupChatSession(
        conversationID: "conv-a",
        clock: clock,
        draftTTL: ttl,
        makeConversationID: { ids.next() }
    )
    session.attach(supervisor)
    try await supervisor.start()
    let events = Task {
        for await event in supervisor.events {
            session.ingest(event)
        }
    }
    defer {
        events.cancel()
        transport.stop()
    }
    try await body(session, transport)
}

private func waitUntil(
    session: PopupChatSession,
    _ ok: (PopupChatSnapshot) -> Bool
) async -> Bool {
    let deadline = Date().addingTimeInterval(2)
    while Date() < deadline {
        if ok(session.snapshot) { return true }
        try? await Task.sleep(nanoseconds: 10_000_000)
    }
    return false
}

private final class RecordingTransport: CoreTransport, @unchecked Sendable {
    private let finish: Bool
    private let lock = NSLock()
    private var sent: [String] = []
    private var cancelled: [String] = []
    private var nextMessage = 1
    private let continuation: AsyncStream<String>.Continuation
    let lines: AsyncStream<String>

    init(finish: Bool) {
        self.finish = finish
        let pair = AsyncStream<String>.makeStream(bufferingPolicy: .unbounded)
        lines = pair.stream
        continuation = pair.continuation
    }

    func start() throws {}

    func writeLine(_ text: String) throws {
        let trimmed = text.trimmingCharacters(in: .newlines)
        guard let message = try? decodeWireLine(trimmed) else { return }
        if case .chatCancelRequest(let request) = message {
            lock.lock()
            cancelled.append(request.params.conversationId)
            lock.unlock()
            emit(WireMessage.chatCancelResult(RpcResult(
                id: request.id,
                result: ChatCancelResult(cancelled: true)
            )))
            return
        }
        guard case .chatSendRequest(let request) = message else { return }
        lock.lock()
        sent.append(request.params.conversationId)
        let messageID = "msg-\(nextMessage)"
        nextMessage += 1
        lock.unlock()
        let conversationID = request.params.conversationId
        emit(WireMessage.chatSendResult(RpcResult(
            id: request.id,
            result: ChatSendResult(conversationId: conversationID, messageId: messageID)
        )))
        emit(WireMessage.chatDelta(RpcNotification(
            method: "chat.delta",
            params: ChatDeltaParams(
                conversationId: conversationID,
                messageId: messageID,
                index: 0,
                text: "partial"
            )
        )))
        if finish {
            emit(WireMessage.chatDone(RpcNotification(
                method: "chat.done",
                params: ChatDoneParams(
                    conversationId: conversationID,
                    messageId: messageID,
                    finishReason: .stop,
                    usage: Usage(inputTokens: 1, outputTokens: 1)
                )
            )))
        }
    }

    func conversationIDs() -> [String] {
        lock.lock()
        defer { lock.unlock() }
        return sent
    }

    func cancelledIDs() -> [String] {
        lock.lock()
        defer { lock.unlock() }
        return cancelled
    }

    func closeInput() {}

    func stop() {
        continuation.finish()
    }

    private func emit(_ message: WireMessage) {
        guard let data = try? encodeWire(message), let line = String(data: data, encoding: .utf8) else { return }
        continuation.yield(line)
    }
}
