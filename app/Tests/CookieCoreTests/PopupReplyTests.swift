import AppKit
import XCTest
@testable import CookieCore
@testable import CookieProtocol

/// The visible one-line replies are the start of the answer. These tests
/// show the model keeps every `chat.delta`, and that applying `chat.done`
/// before a still-buffered tail drops that tail.
final class PopupReplyTests: XCTestCase {
    func testDeltasAreNotDroppedBeforeChatDone() throws {
        let chunks = replyChunks(longReply)
        XCTAssertGreaterThan(chunks.count, 2)
        XCTAssertEqual(chunks.joined(), longReply)

        var conversation = PopupConversation()
        conversation.draft = "who is einstein"
        XCTAssertEqual(conversation.prepareSend(runtime: .up), .send(text: "who is einstein"))
        let deltas = deltas(chunks, messageId: "msg-1")
        for delta in deltas {
            conversation.applyDelta(delta)
        }
        XCTAssertEqual(ReplyStream.cookieText(in: conversation), longReply)
        XCTAssertEqual(conversation.turns.filter { $0.role == .cookie }.count, 1)
        XCTAssertTrue(conversation.replyInFlight)

        let done = stopDone(messageId: "msg-1")
        var head = deltas
        let tail = try XCTUnwrap(head.popLast())
        var lost = PopupConversation()
        lost.draft = "who is einstein"
        _ = lost.prepareSend(runtime: .up)
        for delta in head {
            lost.applyDelta(delta)
        }
        lost.applyDone(done)
        lost.applyDelta(tail)
        XCTAssertEqual(ReplyStream.cookieText(in: lost), head.map(\.text).joined())
        XCTAssertNotEqual(ReplyStream.cookieText(in: lost), longReply)

        var kept = PopupConversation()
        kept.draft = "who is einstein"
        _ = kept.prepareSend(runtime: .up)
        let full = ReplyStream.finish(pending: deltas, done: done, conversation: &kept)
        XCTAssertEqual(full, longReply)
        XCTAssertFalse(kept.replyInFlight)
        XCTAssertEqual(kept.turns.filter { $0.role == .cookie }.count, 1)
        XCTAssertTrue(full.contains("Einstein is best known for"))
        XCTAssertTrue(full.contains("Einstein is famous for the theory of"))
        XCTAssertTrue(full.contains("I can't repeat it 100 times"))
        XCTAssertTrue(full.contains("END-OF-REPLY-m1-popup"))

        let logged = ReplyStream.doneLog(messageId: "msg-1", accumulated: full)
        XCTAssertTrue(logged.hasPrefix("chat.done messageId=msg-1 accumulated="))
        XCTAssertFalse(logged.contains("\n"))
        XCTAssertTrue(logged.contains("\\n"))
        XCTAssertTrue(logged.contains("END-OF-REPLY-m1-popup"))
        XCTAssertTrue(logged.contains("Einstein is best known for"))
        XCTAssertEqual(ReplyStream.flushInterval, 1.0 / 30, accuracy: 0.000_001)
    }

    /// Two deltas stay buffered. `chat.done` must apply both before it settles.
    func testDeltaDeltaDoneFlushesTheLastBufferedChunk() throws {
        var conversation = PopupConversation()
        conversation.draft = "who is einstein"
        XCTAssertEqual(conversation.prepareSend(runtime: .up), .send(text: "who is einstein"))
        var buffer = ReplyDeltaBuffer()
        let first = ChatDeltaParams(
            conversationId: "conv-1",
            messageId: "msg-1",
            index: 0,
            text: "Einstein is best known for"
        )
        let second = ChatDeltaParams(
            conversationId: "conv-1",
            messageId: "msg-1",
            index: 1,
            text: " the theory of relativity."
        )
        buffer.append(first)
        buffer.append(second)
        XCTAssertEqual(buffer.pending.map(\.text), [first.text, second.text])
        XCTAssertEqual(ReplyStream.cookieText(in: conversation), "")

        let full = buffer.finish(stopDone(messageId: "msg-1"), conversation: &conversation)
        XCTAssertEqual(full, "Einstein is best known for the theory of relativity.")
        XCTAssertTrue(buffer.pending.isEmpty)
        XCTAssertFalse(conversation.replyInFlight)
        XCTAssertEqual(ReplyStream.cookieText(in: conversation), full)
        XCTAssertEqual(conversation.turns.filter { $0.role == .cookie }.count, 1)
    }

    func testAckThenSameIdAppendsAndOtherIdIsIgnored() {
        var conversation = PopupConversation()
        conversation.draft = "hi"
        _ = conversation.prepareSend(runtime: .up)
        conversation.noteAck(messageID: "msg-1")
        conversation.applyDelta(ChatDeltaParams(
            conversationId: "conv-1",
            messageId: "msg-1",
            index: 0,
            text: "Einstein is best known for"
        ))
        conversation.applyDelta(ChatDeltaParams(
            conversationId: "conv-1",
            messageId: "msg-other",
            index: 1,
            text: "SHOULD-NOT-APPEAR"
        ))
        conversation.applyDelta(ChatDeltaParams(
            conversationId: "conv-1",
            messageId: "msg-1",
            index: 2,
            text: " the theory of relativity."
        ))
        XCTAssertEqual(
            ReplyStream.cookieText(in: conversation),
            "Einstein is best known for the theory of relativity."
        )
        XCTAssertEqual(conversation.turns.filter { $0.role == .cookie }.count, 1)
        XCTAssertFalse(ReplyStream.cookieText(in: conversation).contains("SHOULD-NOT-APPEAR"))
    }

    func testSessionKeepsEveryDeltaTheWireDelivered() async throws {
        let chunks = replyChunks(longReply)
        let transport = ChunkTransport(chunks: chunks)
        let supervisor = CoreSupervisor(transport: transport)
        let session = PopupChatSession(conversationID: "conv-long")
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

        session.open()
        session.setRuntime(.up)
        session.setDraft("who is einstein")
        session.pressReturn()

        let deadline = Date().addingTimeInterval(5)
        while Date() < deadline {
            let snap = session.snapshot
            let text = ReplyStream.cookieText(in: snap.conversation)
            if text == longReply && !snap.conversation.replyInFlight {
                break
            }
            try? await Task.sleep(nanoseconds: 20_000_000)
        }
        let snap = session.snapshot
        XCTAssertEqual(ReplyStream.cookieText(in: snap.conversation), longReply)
        XCTAssertFalse(snap.conversation.replyInFlight)
        XCTAssertEqual(snap.conversation.turns.filter { $0.role == .cookie }.count, 1)
        XCTAssertEqual(snap.sendControl.identifier, CookieAX.popupSend)
        let partial = await supervisor.partialText(messageId: "msg-1")
        XCTAssertEqual(partial, longReply)
    }

    func testCoalescedPublishesDoNotSkipTheDoneFlush() {
        var coalescer = ReplyUICoalescer()
        XCTAssertTrue(coalescer.noteDelta())
        XCTAssertFalse(coalescer.noteDelta())
        XCTAssertFalse(coalescer.noteDelta())
        XCTAssertTrue(coalescer.flushPending)
        coalescer.noteDone()
        XCTAssertFalse(coalescer.flushPending)
        XCTAssertFalse(coalescer.noteFlush())

        var again = ReplyUICoalescer()
        XCTAssertTrue(again.noteDelta())
        XCTAssertTrue(again.noteFlush())
        XCTAssertFalse(again.dirty)
        XCTAssertTrue(again.noteDelta())
        XCTAssertTrue(again.noteFlush())
    }

    func testLongReplyIsMoreThanOneLineAndTheFieldStaysCompact() {
        let paragraph = "Einstein is best known for the theory of relativity. "
            + String(repeating: "Relativity describes space and time. ", count: 8)
        XCTAssertFalse(paragraph.contains("\n"))
        XCTAssertGreaterThan(PopupMetrics.estimatedLines(paragraph, width: 360), 1)
        XCTAssertEqual(PopupMetrics.inputLineCount(""), 1)
        let twelve = Array(repeating: "line", count: 12).joined(separator: "\n")
        XCTAssertEqual(PopupMetrics.inputLineCount(twelve), PopupMetrics.inputMaxLines)
        XCTAssertEqual(PopupMetrics.inputMaxLines, 8)
        let oneLine = PopupMetrics.clampedInputHeight(lineCount: 1)
        XCTAssertEqual(oneLine, PopupMetrics.inputLineHeight)
        XCTAssertLessThan(oneLine, 40)
        XCTAssertNotEqual(oneLine, 120)
        XCTAssertEqual(
            PopupMetrics.clampedInputHeight(lineCount: 12),
            CGFloat(PopupMetrics.inputMaxLines) * PopupMetrics.inputLineHeight
        )
    }

    func testTranscriptFollowsOnlyWhenAlreadyNearTheBottom() {
        var pin = TranscriptPin()
        XCTAssertFalse(pin.note(contentHeight: 80, viewportHeight: 200, contentMinY: 0))
        XCTAssertTrue(pin.pinnedToBottom)

        XCTAssertTrue(pin.note(contentHeight: 400, viewportHeight: 100, contentMinY: 0))
        XCTAssertTrue(pin.pinnedToBottom)

        XCTAssertFalse(pin.note(contentHeight: 400, viewportHeight: 100, contentMinY: -300))
        XCTAssertTrue(pin.pinnedToBottom)

        XCTAssertFalse(pin.note(contentHeight: 400, viewportHeight: 100, contentMinY: -100))
        XCTAssertFalse(pin.pinnedToBottom)

        XCTAssertFalse(pin.note(contentHeight: 520, viewportHeight: 100, contentMinY: -100))
        XCTAssertFalse(pin.pinnedToBottom)

        XCTAssertFalse(pin.note(contentHeight: 520, viewportHeight: 100, contentMinY: -420))
        XCTAssertTrue(pin.pinnedToBottom)

        var following = TranscriptPin()
        _ = following.note(contentHeight: 400, viewportHeight: 100, contentMinY: 0)
        XCTAssertTrue(following.note(contentHeight: 400, viewportHeight: 100, contentMinY: -40))
        XCTAssertTrue(following.pinnedToBottom)
    }

    func testDisplayMathBecomesDollarsAndInlineMathStays() {
        XCTAssertEqual(prepareReplyMarkdown("\\[E=mc^2\\]"), "$$E=mc^2$$")
        XCTAssertEqual(prepareReplyMarkdown("\\(a^2\\)"), "\\(a^2\\)")
        let fenced = "```\n\\[x\\]\n```"
        XCTAssertEqual(prepareReplyMarkdown(fenced), fenced)
        XCTAssertEqual(prepareReplyMarkdown("\\[E=mc"), "\\[E=mc")
        let mixed = "tail END-OF-REPLY-m1-popup"
        XCTAssertTrue(prepareReplyMarkdown(mixed).contains("END-OF-REPLY-m1-popup"))
        XCTAssertEqual(
            prepareReplyMarkdown("before \\[E = mc^2\\] after"),
            "before $$E = mc^2$$ after"
        )
    }

    @MainActor
    func testReplyFieldBesideAHalfWidthBadgeStaysOneLineUntilTheBadgeIsGone() {
        let text = "Einstein is best known for the theory of relativity. "
            + String(repeating: "Relativity describes space and time. ", count: 12)
        let field = NSTextField(wrappingLabelWithString: text)
        field.font = .systemFont(ofSize: NSFont.systemFontSize)
        field.lineBreakMode = .byWordWrapping
        field.maximumNumberOfLines = 0
        field.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        let line = field.font?.boundingRectForFont.height ?? 17
        XCTAssertEqual(field.preferredMaxLayoutWidth, 0)
        let collapsed = field.intrinsicContentSize.height
        XCTAssertLessThan(
            collapsed,
            line * 1.8,
            "wrapping label with preferredMaxLayoutWidth 0 stays one line high even when stringValue holds the full reply"
        )

        let row: CGFloat = 480
        field.preferredMaxLayoutWidth = row / 2
        field.invalidateIntrinsicContentSize()
        let half = field.intrinsicContentSize.height
        field.preferredMaxLayoutWidth = row
        field.invalidateIntrinsicContentSize()
        let full = field.intrinsicContentSize.height
        XCTAssertGreaterThan(half, line * 1.8)
        XCTAssertGreaterThan(full, line * 1.8)
        XCTAssertGreaterThanOrEqual(half + 0.5, full)
    }
}

private let longReply = """
Einstein is best known for the theory of relativity.
Einstein is famous for the theory of relativity. I can't repeat it 100 times, but I can say "Hi" a few times: Hi Hi Hi.
END-OF-REPLY-m1-popup
"""

private func replyChunks(_ text: String, size: Int = 48) -> [String] {
    var chunks: [String] = []
    var index = text.startIndex
    while index < text.endIndex {
        let end = text.index(index, offsetBy: size, limitedBy: text.endIndex) ?? text.endIndex
        let chunk = String(text[index..<end])
        if !chunk.isEmpty {
            chunks.append(chunk)
        }
        index = end
    }
    return chunks
}

private func deltas(_ chunks: [String], messageId: String) -> [ChatDeltaParams] {
    chunks.enumerated().map { index, text in
        ChatDeltaParams(
            conversationId: "conv-1",
            messageId: messageId,
            index: index,
            text: text
        )
    }
}

private func stopDone(messageId: String) -> ChatDoneParams {
    ChatDoneParams(
        conversationId: "conv-1",
        messageId: messageId,
        finishReason: .stop,
        usage: Usage(inputTokens: 1, outputTokens: chunksCount(longReply))
    )
}

private func chunksCount(_ text: String) -> Int {
    replyChunks(text).count
}

private final class ChunkTransport: CoreTransport, @unchecked Sendable {
    private let continuation: AsyncStream<String>.Continuation
    let lines: AsyncStream<String>
    private let chunks: [String]

    init(chunks: [String]) {
        self.chunks = chunks
        let pair = AsyncStream<String>.makeStream(bufferingPolicy: .unbounded)
        lines = pair.stream
        continuation = pair.continuation
    }

    func start() throws {}

    func writeLine(_ text: String) throws {
        let trimmed = text.trimmingCharacters(in: .newlines)
        guard let message = try? decodeWireLine(trimmed) else { return }
        guard case .chatSendRequest(let request) = message else { return }
        var replies = [
            wire(WireMessage.chatSendResult(RpcResult(
                id: request.id,
                result: ChatSendResult(
                    conversationId: request.params.conversationId,
                    messageId: "msg-1"
                )
            ))),
        ]
        for (index, chunk) in chunks.enumerated() {
            replies.append(wire(WireMessage.chatDelta(RpcNotification(
                method: "chat.delta",
                params: ChatDeltaParams(
                    conversationId: request.params.conversationId,
                    messageId: "msg-1",
                    index: index,
                    text: chunk
                )
            ))))
        }
        replies.append(wire(WireMessage.chatDone(RpcNotification(
            method: "chat.done",
            params: ChatDoneParams(
                conversationId: request.params.conversationId,
                messageId: "msg-1",
                finishReason: .stop,
                usage: Usage(inputTokens: 1, outputTokens: chunks.count)
            )
        ))))
        for reply in replies where !reply.isEmpty {
            continuation.yield(reply)
        }
    }

    func closeInput() {}

    func stop() {
        continuation.finish()
    }
}

private func wire(_ message: WireMessage) -> String {
    (try? encodeLine(message)) ?? ""
}
