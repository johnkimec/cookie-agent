import Foundation
import XCTest
@testable import CookieCore
@testable import CookieProtocol

/// Joined fake-core chunks. File scope so the async tests do not capture the case.
private let fakeCoreReply = "I'm here. This reply is from the fake core, with no model loaded."

/// Stop against the fake core. `COOKIE_FAKE_DELTA_MS` pauses between chunks,
/// not before the first, so a streaming test waits for that first chunk.
final class PopupStopTests: XCTestCase {
    func testReturnWhileIdleSends() async throws {
        try await withFakeCore(deltaMs: 0) { harness in
            harness.session.open()
            harness.session.setRuntime(.up)
            harness.session.setDraft("hello")
            harness.session.pressReturn()
            let first = await harness.waitForDone(messageId: "msg-1")
            XCTAssertEqual(first?.finishReason, .stop)
            let sent = harness.session.snapshot
            XCTAssertFalse(sent.conversation.replyInFlight)
            XCTAssertEqual(sent.sendControl.identifier, CookieAX.popupSend)
            XCTAssertEqual(sent.sendControl.title, "⏎")
            XCTAssertFalse(sent.sendControl.stopsReply)
            XCTAssertTrue(sent.popupOpen)
            XCTAssertEqual(sent.conversation.turns.map(\.role), [.you, .cookie])
            XCTAssertEqual(sent.conversation.turns[0].text, "hello")
            XCTAssertEqual(sent.conversation.turns[1].text, fakeCoreReply)
            XCTAssertEqual(harness.transport.count("chat.send"), 1)
            XCTAssertEqual(harness.transport.count("chat.cancel"), 0)

            harness.session.setDraft("again")
            harness.session.pressReturn()
            let second = await harness.waitForDone(messageId: "msg-2")
            XCTAssertEqual(second?.finishReason, .stop)
            XCTAssertEqual(harness.transport.count("chat.send"), 2)
            XCTAssertEqual(harness.transport.count("chat.cancel"), 0)
            XCTAssertEqual(harness.session.snapshot.sendControl.identifier, CookieAX.popupSend)
            XCTAssertTrue(harness.session.snapshot.popupOpen)
        }
    }

    func testReturnWhileStreamingCancelsOnce() async throws {
        try await withFakeCore(deltaMs: 4000) { harness in
            harness.session.open()
            harness.session.setRuntime(.up)
            harness.session.setDraft("hello from stop")
            harness.session.pressReturn()
            let sawChunk = await harness.waitUntil("first chunk") {
                $0.conversation.turns.contains { $0.role == .cookie && !$0.text.isEmpty }
                    && $0.conversation.replyInFlight
            }
            XCTAssertTrue(sawChunk)
            guard sawChunk else { return }
            let mid = harness.session.snapshot
            XCTAssertEqual(mid.sendControl.identifier, CookieAX.popupStop)
            XCTAssertEqual(mid.sendControl.title, CookieCopy.stop)
            XCTAssertTrue(mid.sendControl.stopsReply)
            XCTAssertTrue(mid.sendControl.enabled)
            XCTAssertTrue(mid.popupOpen)

            harness.session.pressReturn()
            harness.session.pressReturn()
            harness.session.pressReturn()

            let idle = await harness.waitUntil("send control after cancel") {
                !$0.conversation.replyInFlight && $0.sendControl.identifier == CookieAX.popupSend
            }
            XCTAssertTrue(idle)
            let done = await harness.waitForDone(messageId: "msg-1")
            XCTAssertEqual(done?.finishReason, .cancelled, harness.transport.methods().joined(separator: ","))
            XCTAssertEqual(harness.transport.count("chat.send"), 1)
            XCTAssertEqual(harness.transport.count("chat.cancel"), 1, harness.transport.methods().joined(separator: ","))

            let after = harness.session.snapshot
            XCTAssertEqual(after.sendControl.title, "⏎")
            XCTAssertFalse(after.sendControl.stopsReply)
            XCTAssertTrue(after.popupOpen)
            XCTAssertEqual(after.conversation.turns.filter { $0.role == .you }.map(\.text), ["hello from stop"])
            let cookie = try XCTUnwrap(after.conversation.turns.last { $0.role == .cookie })
            XCTAssertFalse(cookie.text.isEmpty)
            XCTAssertTrue(fakeCoreReply.hasPrefix(cookie.text), cookie.text)
            XCTAssertFalse(cookie.streaming)
            XCTAssertEqual(cookie.badge, CookieCopy.onDevice)

            harness.session.setDraft("after")
            harness.session.pressReturn()
            let next = await harness.waitForDone(messageId: "msg-2")
            XCTAssertEqual(next?.finishReason, .stop)
            XCTAssertEqual(harness.transport.count("chat.send"), 2)
            XCTAssertEqual(harness.transport.count("chat.cancel"), 1)
        }
    }

    func testEscapeDuringStreamingCancelsAndLaterEscapeCloses() async throws {
        try await withFakeCore(deltaMs: 4000) { harness in
            harness.session.open()
            harness.session.setRuntime(.up)
            harness.session.setDraft("hello")
            harness.session.pressReturn()
            let sawChunk = await harness.waitUntil("first chunk") {
                $0.conversation.replyInFlight
                    && $0.conversation.turns.contains { $0.role == .cookie && !$0.text.isEmpty }
            }
            XCTAssertTrue(sawChunk)
            guard sawChunk else { return }

            harness.session.pressEscape()
            let idle = await harness.waitUntil("idle after escape") {
                if $0.conversation.replyInFlight && !$0.popupOpen {
                    XCTFail("escape closed the panel while a reply was arriving")
                }
                return !$0.conversation.replyInFlight && $0.popupOpen
            }
            XCTAssertTrue(idle)
            let done = await harness.waitForDone(messageId: "msg-1")
            XCTAssertEqual(done?.finishReason, .cancelled)
            XCTAssertEqual(harness.transport.count("chat.cancel"), 1)
            XCTAssertEqual(harness.transport.count("chat.send"), 1)
            let kept = try XCTUnwrap(harness.session.snapshot.conversation.turns.last { $0.role == .cookie })
            XCTAssertTrue(fakeCoreReply.hasPrefix(kept.text))
            XCTAssertFalse(kept.text.isEmpty)
            XCTAssertEqual(harness.session.snapshot.sendControl.identifier, CookieAX.popupSend)

            harness.session.pressEscape()
            XCTAssertFalse(harness.session.snapshot.popupOpen)
            XCTAssertEqual(harness.transport.count("chat.cancel"), 1)
        }
    }

    func testStopAsFastStreamEndsDoesNotStick() async throws {
        try await withFakeCore(deltaMs: 0) { harness in
            harness.session.open()
            harness.session.setRuntime(.up)
            harness.session.setDraft("race")
            harness.session.pressReturn()
            harness.session.pressReturn()
            harness.session.pressReturn()
            let idle = await harness.waitUntil("idle after race") {
                !$0.conversation.replyInFlight && $0.sendControl.identifier == CookieAX.popupSend
            }
            XCTAssertTrue(idle)
            XCTAssertLessThanOrEqual(harness.transport.count("chat.cancel"), 1)
            XCTAssertEqual(harness.transport.count("chat.send"), 1)
            let snap = harness.session.snapshot
            XCTAssertTrue(snap.popupOpen)
            XCTAssertEqual(snap.conversation.turns.first { $0.role == .you }?.text, "race")
            if let cookie = snap.conversation.turns.last(where: { $0.role == .cookie }) {
                XCTAssertTrue(fakeCoreReply.hasPrefix(cookie.text))
            }
            XCTAssertFalse(snap.conversation.replyInFlight)
            XCTAssertEqual(snap.sendControl.title, "⏎")

            harness.session.setDraft("after")
            harness.session.pressReturn()
            let next = await harness.waitForDone(messageId: "msg-2")
            XCTAssertEqual(next?.finishReason, .stop)
            XCTAssertEqual(harness.transport.count("chat.send"), 2)
            XCTAssertLessThanOrEqual(harness.transport.count("chat.cancel"), 1)
            XCTAssertTrue(harness.session.snapshot.popupOpen)
        }
    }

    /// The reply finishes in the same turn as `chat.cancel`, and the core
    /// answers `cancelled: false` with no second `chat.done`.
    func testCancelOfFinishedReplyDoesNotStick() async throws {
        let transport = RaceTransport()
        let supervisor = CoreSupervisor(transport: transport)
        let session = PopupChatSession(conversationID: "conv-race")
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
        session.setDraft("hello")
        session.pressReturn()
        let sawChunk = await waitUntil("scripted chunk") {
            session.snapshot.conversation.turns.contains { $0.role == .cookie && $0.text == "I'm here. " }
        }
        XCTAssertTrue(sawChunk)
        guard sawChunk else { return }
        XCTAssertEqual(session.snapshot.sendControl.identifier, CookieAX.popupStop)

        session.pressReturn()
        session.pressReturn()
        let idle = await waitUntil("scripted idle") {
            !session.snapshot.conversation.replyInFlight
                && session.snapshot.sendControl.identifier == CookieAX.popupSend
        }
        XCTAssertTrue(idle)
        XCTAssertEqual(transport.counts().sends, 1)
        XCTAssertEqual(transport.counts().cancels, 1)
        XCTAssertTrue(session.snapshot.popupOpen)
        XCTAssertEqual(
            session.snapshot.conversation.turns.last { $0.role == .cookie }?.text,
            "I'm here. "
        )
        XCTAssertEqual(session.snapshot.sendControl.title, "⏎")

        session.setDraft("next")
        session.pressReturn()
        let sentAgain = await waitUntil("second send idle") {
            session.snapshot.conversation.turns.filter { $0.role == .you }.count == 2
                && !session.snapshot.conversation.replyInFlight
        }
        XCTAssertTrue(sentAgain)
        XCTAssertEqual(transport.counts().sends, 2)
        XCTAssertEqual(transport.counts().cancels, 1)
        XCTAssertTrue(session.snapshot.popupOpen)
        session.pressEscape()
        XCTAssertFalse(session.snapshot.popupOpen)
    }

    func testSecondEscapeWhileStreamingStaysOpen() async throws {
        let transport = RaceTransport()
        transport.setHoldCancels(true)
        let supervisor = CoreSupervisor(transport: transport)
        let session = PopupChatSession(conversationID: "conv-esc")
        session.attach(supervisor)
        try await supervisor.start()
        let events = Task {
            for await event in supervisor.events {
                session.ingest(event)
            }
        }
        defer {
            transport.releaseCancels()
            events.cancel()
            transport.stop()
        }

        session.open()
        session.setRuntime(.up)
        session.setDraft("hello")
        session.pressReturn()
        let sawChunk = await waitUntil("held chunk") {
            session.snapshot.conversation.replyInFlight
                && session.snapshot.conversation.turns.contains { $0.role == .cookie }
        }
        XCTAssertTrue(sawChunk)
        guard sawChunk else { return }

        session.pressEscape()
        session.pressEscape()
        let wrote = await waitUntil("one cancel") { transport.counts().cancels == 1 }
        XCTAssertTrue(wrote)
        XCTAssertEqual(transport.counts().cancels, 1)
        XCTAssertTrue(session.snapshot.popupOpen)
        XCTAssertTrue(session.snapshot.conversation.replyInFlight)
        XCTAssertEqual(session.snapshot.sendControl.identifier, CookieAX.popupStop)

        transport.releaseCancels()
        let idle = await waitUntil("idle still open") {
            !session.snapshot.conversation.replyInFlight && session.snapshot.popupOpen
        }
        XCTAssertTrue(idle)
        XCTAssertEqual(transport.counts().cancels, 1)
        XCTAssertEqual(
            session.snapshot.conversation.turns.last { $0.role == .cookie }?.text,
            "I'm here. "
        )

        session.pressEscape()
        XCTAssertFalse(session.snapshot.popupOpen)
        XCTAssertEqual(transport.counts().cancels, 1)
    }

    private func waitUntil(
        _ label: String,
        timeout: TimeInterval = 8,
        _ ready: () -> Bool
    ) async -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if ready() { return true }
            try? await Task.sleep(nanoseconds: 20_000_000)
        }
        XCTFail("timed out: \(label)")
        return false
    }

    private func withFakeCore(
        deltaMs: Int,
        _ body: (StopHarness) async throws -> Void
    ) async throws {
        guard commandExists("pnpm"), commandExists("node") else {
            if ProcessInfo.processInfo.environment["COOKIE_REQUIRE_FAKE_CORE"] == "1" {
                XCTFail("pnpm and node are required for the fake-core stop tests")
            }
            return
        }
        let harness = try await StopHarness.make(deltaMs: deltaMs)
        do {
            try await body(harness)
            await harness.shutdown()
        } catch {
            await harness.shutdown()
            throw error
        }
    }
}

private final class StopHarness: @unchecked Sendable {
    let transport: RecordingTransport
    let process: ProcessTransport
    let supervisor: CoreSupervisor
    let session: PopupChatSession
    let events: Task<Void, Never>
    private let log: StreamLog
    private let dataDir: URL

    private init(
        transport: RecordingTransport,
        process: ProcessTransport,
        supervisor: CoreSupervisor,
        session: PopupChatSession,
        events: Task<Void, Never>,
        log: StreamLog,
        dataDir: URL
    ) {
        self.transport = transport
        self.process = process
        self.supervisor = supervisor
        self.session = session
        self.events = events
        self.log = log
        self.dataDir = dataDir
    }

    static func make(deltaMs: Int) async throws -> StopHarness {
        let repo = repoRoot()
        let dataDir = FileManager.default.temporaryDirectory
            .appendingPathComponent("cookie-stop-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: dataDir, withIntermediateDirectories: true)
        var environment = ProcessInfo.processInfo.environment
        environment["COOKIE_DATA_DIR"] = dataDir.path
        environment["COOKIE_LLAMA_PORT"] = "18080"
        environment["COOKIE_FAKE_DELTA_MS"] = String(deltaMs)
        let launch = CoreLaunch(
            executable: "/usr/bin/env",
            arguments: ["pnpm", "--filter", "@cookie-agent/core", "fake-core"],
            workingDirectory: repo,
            environment: environment
        )
        let process = ProcessTransport(launch: launch)
        let transport = RecordingTransport(process)
        let supervisor = CoreSupervisor(transport: transport)
        let session = PopupChatSession(conversationID: "conv-stop")
        session.attach(supervisor)
        let log = StreamLog()
        let events = Task {
            for await event in supervisor.events {
                if case .done(let done) = event {
                    log.note(done)
                }
                session.ingest(event)
            }
        }
        do {
            try await supervisor.start()
            _ = try await supervisor.initialize()
        } catch {
            events.cancel()
            process.stop()
            try? FileManager.default.removeItem(at: dataDir)
            throw error
        }
        return StopHarness(
            transport: transport,
            process: process,
            supervisor: supervisor,
            session: session,
            events: events,
            log: log,
            dataDir: dataDir
        )
    }

    func shutdown() async {
        try? await supervisor.shutdown()
        events.cancel()
        let code = await process.waitForExit(timeout: 15)
        if code != 0 {
            XCTFail("fake core exit \(String(describing: code)): \(process.stderrText())")
        }
        try? FileManager.default.removeItem(at: dataDir)
    }

    func waitForDone(messageId: String) async -> ChatDoneParams? {
        let deadline = Date().addingTimeInterval(20)
        while Date() < deadline {
            if let done = log.done(messageId: messageId) { return done }
            try? await Task.sleep(nanoseconds: 20_000_000)
        }
        return nil
    }

    func waitUntil(
        _ label: String,
        timeout: TimeInterval = 20,
        _ ready: (PopupChatSnapshot) -> Bool
    ) async -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if ready(session.snapshot) { return true }
            try? await Task.sleep(nanoseconds: 20_000_000)
        }
        XCTFail("timed out: \(label) stderr=\(process.stderrText()) methods=\(transport.methods())")
        return false
    }
}

/// `chat.cancel` is answered as a finished reply: `chat.done` `stop`, then
/// `{ cancelled: false }`. No second `chat.done`.
private final class RaceTransport: CoreTransport, @unchecked Sendable {
    private let continuation: AsyncStream<String>.Continuation
    let lines: AsyncStream<String>
    private let lock = NSLock()
    private(set) var sends = 0
    private(set) var cancels = 0
    /// When set, `chat.cancel` is counted but the reply is held so the
    /// session stays in flight until `releaseCancels`.
    private var holdCancels = false
    private var held: [String] = []

    init() {
        let pair = AsyncStream<String>.makeStream(bufferingPolicy: .unbounded)
        lines = pair.stream
        continuation = pair.continuation
    }

    func start() throws {}

    func writeLine(_ text: String) throws {
        let trimmed = text.trimmingCharacters(in: .newlines)
        guard let message = try? decodeWireLine(trimmed) else { return }
        var replies: [String] = []
        lock.lock()
        switch message {
        case .chatSendRequest(let request):
            sends += 1
            let messageID = "msg-\(sends)"
            replies = [
                wire(WireMessage.chatSendResult(RpcResult(
                    id: request.id,
                    result: ChatSendResult(
                        conversationId: request.params.conversationId,
                        messageId: messageID
                    )
                ))),
                wire(WireMessage.chatDelta(RpcNotification(
                    method: "chat.delta",
                    params: ChatDeltaParams(
                        conversationId: request.params.conversationId,
                        messageId: messageID,
                        index: 0,
                        text: "I'm here. "
                    )
                ))),
            ]
            if sends > 1 {
                replies.append(wire(WireMessage.chatDone(RpcNotification(
                    method: "chat.done",
                    params: ChatDoneParams(
                        conversationId: request.params.conversationId,
                        messageId: messageID,
                        finishReason: .stop,
                        usage: Usage(inputTokens: 1, outputTokens: 2)
                    )
                ))))
            }
        case .chatCancelRequest(let request):
            cancels += 1
            let cancelReplies = [
                wire(WireMessage.chatDone(RpcNotification(
                    method: "chat.done",
                    params: ChatDoneParams(
                        conversationId: request.params.conversationId,
                        messageId: request.params.messageId,
                        finishReason: .stop,
                        usage: Usage(inputTokens: 1, outputTokens: 2)
                    )
                ))),
                wire(WireMessage.chatCancelResult(RpcResult(
                    id: request.id,
                    result: ChatCancelResult(cancelled: false)
                ))),
            ]
            if holdCancels {
                held.append(contentsOf: cancelReplies)
            } else {
                replies = cancelReplies
            }
        default:
            break
        }
        lock.unlock()
        for reply in replies where !reply.isEmpty {
            continuation.yield(reply)
        }
    }

    func setHoldCancels(_ hold: Bool) {
        lock.lock()
        holdCancels = hold
        lock.unlock()
    }

    func counts() -> (sends: Int, cancels: Int) {
        lock.lock()
        defer { lock.unlock() }
        return (sends, cancels)
    }

    func releaseCancels() {
        lock.lock()
        holdCancels = false
        let pending = held
        held = []
        lock.unlock()
        for reply in pending where !reply.isEmpty {
            continuation.yield(reply)
        }
    }

    func closeInput() {}

    func stop() {
        continuation.finish()
    }
}

private final class RecordingTransport: CoreTransport, @unchecked Sendable {
    private let inner: ProcessTransport
    private let lock = NSLock()
    private var sent: [String] = []

    init(_ inner: ProcessTransport) {
        self.inner = inner
    }

    func start() throws {
        try inner.start()
    }

    var lines: AsyncStream<String> { inner.lines }

    func writeLine(_ text: String) throws {
        if let name = methodName(text) {
            lock.lock()
            sent.append(name)
            lock.unlock()
        }
        try inner.writeLine(text)
    }

    func closeInput() {
        inner.closeInput()
    }

    func stop() {
        inner.stop()
    }

    func count(_ method: String) -> Int {
        lock.lock()
        defer { lock.unlock() }
        return sent.filter { $0 == method }.count
    }

    func methods() -> [String] {
        lock.lock()
        defer { lock.unlock() }
        return sent
    }
}

private final class StreamLog: @unchecked Sendable {
    private let lock = NSLock()
    private var dones: [ChatDoneParams] = []

    func note(_ done: ChatDoneParams) {
        lock.lock()
        dones.append(done)
        lock.unlock()
    }

    func done(messageId: String) -> ChatDoneParams? {
        lock.lock()
        defer { lock.unlock() }
        return dones.first { $0.messageId == messageId }
    }
}

private func wire(_ message: WireMessage) -> String {
    (try? encodeLine(message)) ?? ""
}

private func methodName(_ text: String) -> String? {
    guard let message = try? decodeWireLine(text) else { return nil }
    switch message {
    case .chatSendRequest:
        return "chat.send"
    case .chatCancelRequest:
        return "chat.cancel"
    default:
        return nil
    }
}

private func commandExists(_ name: String) -> Bool {
    let process = Process()
    process.executableURL = URL(fileURLWithPath: "/usr/bin/which")
    process.arguments = [name]
    process.standardOutput = Pipe()
    process.standardError = Pipe()
    do {
        try process.run()
    } catch {
        return false
    }
    process.waitUntilExit()
    return process.terminationStatus == 0
}

private func repoRoot() -> URL {
    var url = URL(fileURLWithPath: #filePath)
    while url.path != "/" {
        if FileManager.default.fileExists(atPath: url.appendingPathComponent("pnpm-workspace.yaml").path) {
            return url
        }
        url.deleteLastPathComponent()
    }
    fatalError("repo root not found from \(#filePath)")
}
