import AppKit
import SwiftUI
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

    @MainActor
    func testLongReplyIsMoreThanOneLineAndTheFieldStaysCompact() {
        let paragraph = "Einstein is best known for the theory of relativity. "
            + String(repeating: "Relativity describes space and time. ", count: 8)
        XCTAssertFalse(paragraph.contains("\n"))
        let oneLine = laidOutTurnHeight("Hi")
        let wrapped = laidOutTurnHeight(paragraph)
        XCTAssertGreaterThan(oneLine, 0)
        XCTAssertGreaterThan(
            wrapped,
            oneLine * 1.8,
            "a long cookie row hosted at the popup width is taller than one line"
        )
        XCTAssertEqual(PopupMetrics.inputLineCount(""), 1)
        let twelve = Array(repeating: "line", count: 12).joined(separator: "\n")
        XCTAssertEqual(PopupMetrics.inputLineCount(twelve), PopupMetrics.inputMaxLines)
        XCTAssertEqual(PopupMetrics.inputMaxLines, 8)
        let inputHeight = PopupMetrics.clampedInputHeight(lineCount: 1)
        XCTAssertEqual(inputHeight, PopupMetrics.inputLineHeight)
        XCTAssertLessThan(inputHeight, 40)
        XCTAssertNotEqual(inputHeight, 120)
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
        let fencedBlock = "```\n\\[\nE=mc^2\n\\]\n```"
        XCTAssertEqual(prepareReplyMarkdown(fencedBlock), fencedBlock)
        XCTAssertEqual(prepareReplyMarkdown("\\[E=mc"), "\\[E=mc")
        let unclosedBlock = "\\[\nE = mc^2\n"
        XCTAssertEqual(prepareReplyMarkdown(unclosedBlock), unclosedBlock)
        XCTAssertEqual(
            prepareReplyMarkdown("\\[\nE = mc^2\n\\]"),
            "$$\nE = mc^2\n$$"
        )
        let mixed = "tail END-OF-REPLY-m1-popup"
        XCTAssertTrue(prepareReplyMarkdown(mixed).contains("END-OF-REPLY-m1-popup"))
        XCTAssertEqual(
            prepareReplyMarkdown("before \\[E = mc^2\\] after"),
            "before $$E = mc^2$$ after"
        )
    }

    /// Settling first, then applying a buffered tail, drops that tail.
    /// Applying the buffer and then settling keeps the full text.
    func testSettlingBeforeBufferedDeltasDropsTheTail() {
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
        var dropped = PopupConversation()
        dropped.draft = "who is einstein"
        _ = dropped.prepareSend(runtime: .up)
        dropped.noteAck(messageID: "msg-1")
        dropped.settleInFlightReply()
        dropped.applyDelta(first)
        dropped.applyDelta(second)
        XCTAssertEqual(ReplyStream.cookieText(in: dropped), "")

        var kept = PopupConversation()
        kept.draft = "who is einstein"
        _ = kept.prepareSend(runtime: .up)
        kept.noteAck(messageID: "msg-1")
        var buffer = ReplyDeltaBuffer()
        buffer.append(first)
        buffer.append(second)
        for delta in buffer.takePending() {
            kept.applyDelta(delta)
        }
        XCTAssertTrue(kept.replyInFlight)
        kept.settleInFlightReply()
        XCTAssertEqual(
            ReplyStream.cookieText(in: kept),
            "Einstein is best known for the theory of relativity."
        )
        XCTAssertFalse(kept.replyInFlight)
        XCTAssertTrue(buffer.pending.isEmpty)
    }

    /// Two deltas are still buffered when the cancel result arrives.
    /// The result flushes them on the main queue before it settles.
    func testCancelResultKeepsDeltasThatWereStillBuffered() async throws {
        let transport = CancelBufferTransport()
        let supervisor = CoreSupervisor(transport: transport)
        let session = PopupChatSession(conversationID: "conv-cancel-buffer")
        session.attach(supervisor)
        let buffer = DeltaHold()
        session.onBeforeCancelSettle = {
            XCTAssertTrue(Thread.isMainThread)
            for delta in buffer.take() {
                session.ingestDelta(delta)
            }
        }
        try await supervisor.start()
        let events = Task {
            for await event in supervisor.events {
                if case .delta(let delta) = event {
                    buffer.append(delta)
                } else {
                    session.ingest(event)
                }
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
        let primed = await waitUntil("buffered tail") {
            buffer.count == 2 && session.snapshot.conversation.replyInFlight
        }
        XCTAssertTrue(primed)
        XCTAssertEqual(ReplyStream.cookieText(in: session.snapshot.conversation), "")

        session.pressReturn()
        let idle = await waitUntil("settled after cancel") {
            !session.snapshot.conversation.replyInFlight
        }
        XCTAssertTrue(idle)
        XCTAssertEqual(
            ReplyStream.cookieText(in: session.snapshot.conversation),
            "Einstein is best known for the theory of relativity."
        )
        XCTAssertEqual(buffer.count, 0)
        XCTAssertFalse(session.snapshot.conversation.turns.last?.streaming ?? true)
        XCTAssertEqual(session.snapshot.sendControl.identifier, CookieAX.popupSend)
    }

    @MainActor
    func testLoadingAndRefusalLabelsWrapWhenGivenAColumnWidth() {
        let notice = CookieCopy.modelNotReady
        let field = NSTextField(wrappingLabelWithString: notice)
        field.font = .systemFont(ofSize: NSFont.smallSystemFontSize)
        field.lineBreakMode = .byWordWrapping
        field.maximumNumberOfLines = 0
        field.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        field.setAccessibilityIdentifier(CookieAX.popupRefusal)
        field.setAccessibilityLabel(notice)
        field.setAccessibilityValue(notice)
        let line = field.font?.boundingRectForFont.height ?? 12
        XCTAssertEqual(field.preferredMaxLayoutWidth, 0)
        XCTAssertLessThan(field.intrinsicContentSize.height, line * 1.8)
        field.preferredMaxLayoutWidth = 80
        field.invalidateIntrinsicContentSize()
        XCTAssertGreaterThan(field.intrinsicContentSize.height, line * 1.8)
        XCTAssertEqual(field.accessibilityIdentifier(), CookieAX.popupRefusal)
        XCTAssertEqual(field.stringValue, CookieCopy.modelNotReady)
        XCTAssertEqual(CookieAX.popupLoading, "cookie.popup.loading")
        XCTAssertEqual(CookieCopy.modelLoading, "Loading the model…")
    }

    private func waitUntil(
        _ label: String,
        timeout: TimeInterval = 2,
        _ ready: () -> Bool
    ) async -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if ready() { return true }
            try? await Task.sleep(nanoseconds: 10_000_000)
        }
        XCTFail("timed out: \(label)")
        return false
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

/// Two deltas and no `chat.done`. The cancel result is the only settle.
private final class CancelBufferTransport: CoreTransport, @unchecked Sendable {
    private let continuation: AsyncStream<String>.Continuation
    let lines: AsyncStream<String>

    init() {
        let pair = AsyncStream<String>.makeStream(bufferingPolicy: .unbounded)
        lines = pair.stream
        continuation = pair.continuation
    }

    func start() throws {}

    func writeLine(_ text: String) throws {
        let trimmed = text.trimmingCharacters(in: .newlines)
        guard let message = try? decodeWireLine(trimmed) else { return }
        switch message {
        case .chatSendRequest(let request):
            let conversationID = request.params.conversationId
            emit(WireMessage.chatSendResult(RpcResult(
                id: request.id,
                result: ChatSendResult(conversationId: conversationID, messageId: "msg-1")
            )))
            emit(WireMessage.chatDelta(RpcNotification(
                method: "chat.delta",
                params: ChatDeltaParams(
                    conversationId: conversationID,
                    messageId: "msg-1",
                    index: 0,
                    text: "Einstein is best known for"
                )
            )))
            emit(WireMessage.chatDelta(RpcNotification(
                method: "chat.delta",
                params: ChatDeltaParams(
                    conversationId: conversationID,
                    messageId: "msg-1",
                    index: 1,
                    text: " the theory of relativity."
                )
            )))
        case .chatCancelRequest(let request):
            emit(WireMessage.chatCancelResult(RpcResult(
                id: request.id,
                result: ChatCancelResult(cancelled: true)
            )))
        default:
            break
        }
    }

    func closeInput() {}

    func stop() {
        continuation.finish()
    }

    private func emit(_ message: WireMessage) {
        let line = wire(message)
        if !line.isEmpty {
            continuation.yield(line)
        }
    }
}

private final class DeltaHold: @unchecked Sendable {
    private let lock = NSLock()
    private var items: [ChatDeltaParams] = []

    var count: Int {
        lock.lock()
        defer { lock.unlock() }
        return items.count
    }

    func append(_ delta: ChatDeltaParams) {
        lock.lock()
        items.append(delta)
        lock.unlock()
    }

    func take() -> [ChatDeltaParams] {
        lock.lock()
        defer { lock.unlock() }
        let batch = items
        items = []
        return batch
    }
}

/// The cookie turn at the popup width: role label, spacing, and 16 pt padding,
/// matching `TurnRow` inside the transcript.
@MainActor
private func laidOutTurnHeight(_ text: String) -> CGFloat {
    let row = HStack(alignment: .top, spacing: 12) {
        Text("cookie")
            .font(.body.monospaced())
            .frame(width: 64, alignment: .leading)
        Text(text)
            .font(.body)
            .fixedSize(horizontal: false, vertical: true)
            .frame(maxWidth: .infinity, alignment: .leading)
    }
    .padding(16)
    .frame(width: PopupLayout.width, alignment: .topLeading)

    let host = NSHostingView(rootView: row)
    host.sizingOptions = [.intrinsicContentSize]
    let fitted = host.fittingSize.height
    if fitted > 1 {
        return fitted
    }
    let window = NSWindow(
        contentRect: NSRect(x: 0, y: 0, width: PopupLayout.width, height: 800),
        styleMask: [.borderless],
        backing: .buffered,
        defer: false
    )
    window.contentView = host
    host.frame = NSRect(x: 0, y: 0, width: PopupLayout.width, height: 800)
    host.layoutSubtreeIfNeeded()
    return host.fittingSize.height
}

final class PopupSizingTests: XCTestCase {
    func testEmptyPanelIsTheInputRow() {
        let height = PopupMetrics.panelHeight(turnTexts: [], draft: "", showsNotice: false)
        XCTAssertEqual(height, PopupLayout.collapsedHeight)
        XCTAssertLessThan(height, 80)
        XCTAssertEqual(PopupMetrics.inputLineHeight, 22)
    }

    func testShortReplyGrowsAndStaysUnderTheCap() {
        let estimated = PopupMetrics.panelHeight(
            turnTexts: ["what's the setup time?", "2.1 ns min at 3.3 V."],
            draft: "",
            showsNotice: false
        )
        XCTAssertGreaterThan(estimated, PopupLayout.collapsedHeight)
        XCTAssertLessThan(estimated, PopupLayout.maxHeight)
        let measured = PopupMetrics.panelHeight(
            turnTexts: ["what's the setup time?", "2.1 ns min at 3.3 V."],
            draft: "",
            showsNotice: false,
            measuredTranscript: 72
        )
        XCTAssertEqual(measured, PopupLayout.collapsedHeight + 72 + 1)
        XCTAssertLessThan(measured, PopupLayout.maxHeight)
    }

    func testLongReplyCapsAtMaxHeight() {
        let line = String(repeating: "The transcript keeps going until it scrolls. ", count: 40)
        let texts = ["tell me more", line]
        XCTAssertEqual(
            PopupMetrics.panelHeight(turnTexts: texts, draft: "", showsNotice: false),
            PopupLayout.maxHeight
        )
        XCTAssertEqual(
            PopupMetrics.panelHeight(
                turnTexts: texts,
                draft: "",
                showsNotice: false,
                measuredTranscript: 4000
            ),
            PopupLayout.maxHeight
        )
        XCTAssertEqual(PopupLayout.maxHeight, 320)
        XCTAssertEqual(PopupLayout.transcriptBottomInset, 8)
        XCTAssertEqual(PopupLayout.inputRowVerticalPadding, 12)
        XCTAssertLessThanOrEqual(PopupLayout.transcriptBottomInset + 1, 16)
    }

    func testOneLineInputRowStaysCollapsed() {
        XCTAssertEqual(
            PopupMetrics.inputRowHeight(draft: "", showsNotice: false),
            PopupLayout.collapsedHeight
        )
        XCTAssertEqual(
            PopupMetrics.inputRowHeight(draft: "hello", showsNotice: false),
            PopupLayout.collapsedHeight
        )
        XCTAssertEqual(
            PopupMetrics.inputRowHeight(draft: "", showsNotice: true),
            PopupLayout.collapsedHeight
        )
        XCTAssertLessThanOrEqual(PopupLayout.collapsedHeight, 72)
        let eight = Array(repeating: "line", count: 8).joined(separator: "\n")
        XCTAssertGreaterThan(
            PopupMetrics.inputRowHeight(draft: eight, showsNotice: false),
            PopupLayout.collapsedHeight
        )
    }

    @MainActor
    func testSentinelReplyWrapsAtThePopupWidth() {
        let line = "Einstein is best known for relativity. END-OF-REPLY-m1-popup"
        let one = laidOutTurnHeight("Hi")
        let wrapped = laidOutTurnHeight(line)
        XCTAssertGreaterThan(one, 0)
        XCTAssertGreaterThan(
            wrapped,
            one + 8,
            "the one-line sentinel wraps inside the popup column"
        )
        XCTAssertLessThan(wrapped, 120)
    }
}
