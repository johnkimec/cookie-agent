import Foundation
import XCTest
@testable import CookieCore
@testable import CookieProtocol

final class PresentationTests: XCTestCase {
    func testDecision11Glyphs() {
        XCTAssertEqual(menuGlyph(runtime: .up, popupOpen: false, replyInFlight: false), .idle)
        XCTAssertEqual(menuGlyph(runtime: .up, popupOpen: true, replyInFlight: false), .listening)
        XCTAssertEqual(menuGlyph(runtime: .up, popupOpen: true, replyInFlight: true), .thinking)
        XCTAssertEqual(menuGlyph(runtime: .up, popupOpen: false, replyInFlight: true), .thinking)
        XCTAssertEqual(menuGlyph(runtime: .loading, popupOpen: true, replyInFlight: true), .loading)
        XCTAssertEqual(menuGlyph(runtime: .down, popupOpen: true, replyInFlight: false), .down)
        XCTAssertEqual(menuGlyph(runtime: .down, popupOpen: false, replyInFlight: true), .down)
        XCTAssertEqual(menuVoiceOver(.thinking), "Cookie, thinking")
        XCTAssertEqual(menuVoiceOver(.idle), "Cookie")
        XCTAssertEqual(menuVoiceOver(.loading), "Cookie, loading")
        XCTAssertEqual(menuVoiceOver(.down), "Cookie, offline")
    }

    func testPopupPoseWhileStreaming() {
        XCTAssertEqual(popupPose(runtime: .up, replyInFlight: false, cookieTextStarted: false), .listening)
        XCTAssertEqual(popupPose(runtime: .up, replyInFlight: true, cookieTextStarted: false), .thinking)
        XCTAssertEqual(popupPose(runtime: .up, replyInFlight: true, cookieTextStarted: true), .talking)
        XCTAssertEqual(popupPoseVoiceOver(.talking), "Cookie, talking")
        XCTAssertEqual(popupPose(runtime: .down, replyInFlight: true, cookieTextStarted: true), .offline)
        XCTAssertEqual(popupPose(runtime: .loading, replyInFlight: false, cookieTextStarted: false), .thinking)
    }

    func testStatusLine() {
        XCTAssertEqual(
            statusLine(runtime: .up, modelID: "Qwen3.6-35B-A3B"),
            "🐾 Cookie · on-device · Qwen3.6"
        )
        XCTAssertEqual(statusLine(runtime: .up, modelID: "fake-local"), "🐾 Cookie · on-device · fake-local")
        XCTAssertEqual(statusLine(runtime: .up, modelID: nil), "🐾 Cookie · on-device")
        XCTAssertEqual(statusLine(runtime: .up, modelID: ""), "🐾 Cookie · on-device")
        XCTAssertEqual(statusLine(runtime: .loading, modelID: "Qwen3.6-35B-A3B"), "🐾 Cookie · starting model…")
        XCTAssertEqual(statusLine(runtime: .loading, modelID: nil), "🐾 Cookie · starting model…")
        XCTAssertEqual(statusLine(runtime: .down, modelID: nil), "🐾 Cookie · model offline")
        XCTAssertEqual(statusLine(runtime: .down, modelID: "fake-local"), "🐾 Cookie · model offline")
    }

    func testAccessibilityIdentifiersAndLayout() {
        XCTAssertEqual(CookieAX.menuIcon, "cookie.menu.icon")
        XCTAssertEqual(CookieAX.menuStatus, "cookie.menu.status")
        XCTAssertEqual(CookieAX.menuAsk, "cookie.menu.ask")
        XCTAssertEqual(CookieAX.menuLocalOnly, "cookie.menu.local-only")
        XCTAssertEqual(CookieAX.menuQuit, "cookie.menu.quit")
        XCTAssertEqual(CookieAX.popup, "cookie.popup")
        XCTAssertEqual(CookieAX.popupInput, "cookie.popup.input")
        XCTAssertEqual(CookieAX.popupMascot, "cookie.popup.mascot")
        XCTAssertEqual(CookieAX.popupSend, "cookie.popup.send")
        XCTAssertEqual(CookieAX.popupRefusal, "cookie.popup.refusal")
        XCTAssertEqual(CookieAX.turnYou(0), "cookie.turn.you.0")
        XCTAssertEqual(CookieAX.turnCookie(1), "cookie.turn.cookie.1")
        XCTAssertEqual(CookieAX.badge(0), "cookie.badge.on-device.0")
        XCTAssertEqual(CookieCopy.ask, "Ask Cookie…")
        XCTAssertEqual(CookieCopy.localOnly, "Local-only mode")
        XCTAssertEqual(CookieCopy.quit, "Quit Cookie")
        XCTAssertEqual(CookieCopy.onDevice, "on-device")
        XCTAssertEqual(PopupLayout.width, 560)
        XCTAssertEqual(PopupLayout.maxHeight, 520)
        XCTAssertEqual(PopupLayout.collapsedHeight, 64)
        XCTAssertEqual(PopupLayout.mascot, 40)
        XCTAssertEqual(PopupLayout.draftTTL, 600)
    }
}

final class ConversationTests: XCTestCase {
    func testRefusedSendAddsNoTurn() {
        var chat = PopupConversation(draft: "hello")
        XCTAssertEqual(chat.prepareSend(runtime: .down), .refused(.notReady))
        XCTAssertEqual(chat.refusalLine(runtime: .down), "Cookie's model isn't ready yet.")
        XCTAssertEqual(chat.prepareSend(runtime: .loading), .refused(.notReady))
        XCTAssertEqual(chat.refusalLine(runtime: .loading), "Cookie's model isn't ready yet.")
        XCTAssertEqual(chat.draft, "hello")
        XCTAssertTrue(chat.turns.isEmpty)
        chat.noteRuntime(.up)
        XCTAssertNil(chat.refusalLine(runtime: .up))
        XCTAssertEqual(chat.draft, "hello")
        var empty = PopupConversation()
        XCTAssertEqual(empty.prepareSend(runtime: .up), .ignore)
    }

    func testStreamRendersYouAndCookieWithBadge() {
        var chat = PopupConversation(draft: "hello")
        XCTAssertEqual(chat.prepareSend(runtime: .up), .send(text: "hello"))
        XCTAssertEqual(chat.turns.map(\.role), [.you])
        XCTAssertTrue(chat.replyInFlight)
        chat.draft = "second"
        XCTAssertEqual(chat.prepareSend(runtime: .up), .refused(.inFlight))
        XCTAssertEqual(chat.draft, "second")
        XCTAssertEqual(chat.refusalLine(runtime: .up), "Cookie's still answering.")
        XCTAssertEqual(chat.turns.map(\.role), [.you])

        chat.applyDelta(ChatDeltaParams(
            conversationId: "conv-1",
            messageId: "msg-1",
            index: 0,
            text: "I'm here. "
        ))
        chat.applyDelta(ChatDeltaParams(
            conversationId: "conv-1",
            messageId: "msg-1",
            index: 1,
            text: "with no model loaded."
        ))
        XCTAssertEqual(chat.turns[1].role, .cookie)
        XCTAssertEqual(chat.turns[1].text, "I'm here. with no model loaded.")
        XCTAssertEqual(chat.turns[1].badge, CookieCopy.onDevice)
        XCTAssertTrue(chat.cookieTextStarted)

        chat.applyDone(ChatDoneParams(
            conversationId: "conv-1",
            messageId: "msg-1",
            finishReason: .stop,
            usage: Usage(inputTokens: 1, outputTokens: 2)
        ))
        XCTAssertFalse(chat.replyInFlight)
        XCTAssertFalse(chat.turns[1].streaming)
        XCTAssertEqual(chat.turns[1].badge, CookieCopy.onDevice)
        XCTAssertNil(chat.refusalLine(runtime: .up))

        chat.draft = ""
        chat.recallLastUserText()
        XCTAssertEqual(chat.draft, "hello")
    }

    func testRollbackRestoresDraft() {
        var chat = PopupConversation(draft: "hello")
        _ = chat.prepareSend(runtime: .up)
        chat.rollbackSend(restoredText: "hello")
        XCTAssertTrue(chat.turns.isEmpty)
        XCTAssertEqual(chat.draft, "hello")
        XCTAssertFalse(chat.replyInFlight)
    }

    func testDraftLastsTenMinutes() {
        var chat = PopupConversation(draft: "keep me")
        let saved = Date(timeIntervalSince1970: 1_000)
        chat.noteClose(at: saved)
        chat.noteOpen(at: saved.addingTimeInterval(600))
        XCTAssertEqual(chat.draft, "keep me")
        chat.noteOpen(at: saved.addingTimeInterval(601))
        XCTAssertEqual(chat.draft, "")
    }
}

final class LaunchTests: XCTestCase {
    func testUnsetDataDirStaysOutOfApplicationSupport() {
        let temp = URL(fileURLWithPath: "/tmp/cookie-launch-test", isDirectory: true)
        let launch = CoreLaunch.resolve(
            environment: [:],
            currentDirectory: URL(fileURLWithPath: "/tmp/not-a-repo", isDirectory: true),
            temporaryDirectory: temp,
            pid: 42
        )
        let dataDir = launch.environment["COOKIE_DATA_DIR"] ?? ""
        XCTAssertEqual(dataDir, temp.appendingPathComponent("cookie-agent-42", isDirectory: true).path)
        XCTAssertFalse(dataDir.contains("Application Support"))
        XCTAssertNil(launch.environment["COOKIE_LLAMA_PORT"])
        XCTAssertEqual(launch.arguments, ["pnpm", "--filter", "@cookie-agent/core", "fake-core"])
        XCTAssertEqual(launch.workingDirectory.path, "/tmp/not-a-repo")
    }

    func testExplicitDataDirAndCommandAreHonoured() {
        let launch = CoreLaunch.resolve(
            environment: [
                "COOKIE_DATA_DIR": "/tmp/cookie-isolated",
                "COOKIE_LLAMA_PORT": "18080",
                "COOKIE_CORE_COMMAND": "node --experimental-strip-types src/fake-core.ts",
                "COOKIE_CORE_CWD": "/tmp/cookie-repo",
            ],
            currentDirectory: URL(fileURLWithPath: "/tmp/ignored", isDirectory: true),
            temporaryDirectory: URL(fileURLWithPath: "/tmp", isDirectory: true),
            pid: 7
        )
        XCTAssertEqual(launch.environment["COOKIE_DATA_DIR"], "/tmp/cookie-isolated")
        XCTAssertEqual(launch.environment["COOKIE_LLAMA_PORT"], "18080")
        XCTAssertEqual(
            launch.arguments,
            ["node", "--experimental-strip-types", "src/fake-core.ts"]
        )
        XCTAssertEqual(launch.workingDirectory.path, "/tmp/cookie-repo")
    }

    func testUnsetAndEmptyPortStayUnset() {
        let temp = URL(fileURLWithPath: "/tmp", isDirectory: true)
        let cwd = URL(fileURLWithPath: "/tmp/not-a-repo", isDirectory: true)
        let unset = CoreLaunch.resolve(
            environment: ["OTHER": "kept"],
            currentDirectory: cwd,
            temporaryDirectory: temp,
            pid: 1
        )
        XCTAssertNil(unset.environment["COOKIE_LLAMA_PORT"])
        XCTAssertEqual(unset.environment["OTHER"], "kept")

        let empty = CoreLaunch.resolve(
            environment: ["COOKIE_LLAMA_PORT": ""],
            currentDirectory: cwd,
            temporaryDirectory: temp,
            pid: 2
        )
        XCTAssertNil(empty.environment["COOKIE_LLAMA_PORT"])
    }

    func testProductPortIsPassedThrough() {
        let launch = CoreLaunch.resolve(
            environment: ["COOKIE_LLAMA_PORT": "8080"],
            currentDirectory: URL(fileURLWithPath: "/tmp/not-a-repo", isDirectory: true),
            temporaryDirectory: URL(fileURLWithPath: "/tmp", isDirectory: true),
            pid: 3
        )
        XCTAssertEqual(launch.environment["COOKIE_LLAMA_PORT"], "8080")
    }

    func testFindRepoWalksToWorkspace() {
        let here = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        let repo = CoreLaunch.findRepo(from: here)
        XCTAssertNotNil(repo)
        XCTAssertTrue(
            FileManager.default.fileExists(atPath: repo!.appendingPathComponent("protocol/README.md").path)
        )
    }
}

final class SupervisorTests: XCTestCase {
    func testScriptedHandshakeStreamAndRefusal() async throws {
        let transport = ScriptedTransport()
        let mode = Mode()
        transport.autoReply = { line in
            scriptedReply(line: line, mode: mode)
        }
        let supervisor = CoreSupervisor(transport: transport)
        try await supervisor.start()
        let (initialized, status) = try await supervisor.initialize()
        XCTAssertEqual(initialized.serverInfo.name, "cookie-fake-core")
        XCTAssertEqual(initialized.protocolVersion, protocolVersion)
        XCTAssertEqual(status.state, .up)
        XCTAssertEqual(status.modelId, "fake-local")

        let ack = try await supervisor.sendChat(conversationId: "conv-1", text: "hi")
        XCTAssertEqual(ack.messageId, "msg-1")
        let done = try await supervisor.waitForDone(messageId: "msg-1")
        XCTAssertEqual(done.finishReason, .stop)
        let partial = await supervisor.partialText(messageId: "msg-1")
        XCTAssertEqual(
            partial,
            "I'm here. This reply is from the fake core, with no model loaded."
        )

        transport.push(try encodeLine(WireMessage.runtimeStatus(RpcNotification(
            method: "runtime.status",
            params: RuntimeStatus(state: .down, modelId: nil)
        ))))
        let down = try await supervisor.waitForState(.down)
        XCTAssertEqual(down.state, .down)
        XCTAssertNil(down.modelId)

        mode.value = "down"
        do {
            _ = try await supervisor.sendChat(conversationId: "conv-1", text: "nope")
            XCTFail("expected runtime unavailable")
        } catch let error as CoreError {
            guard case .rpc(let body) = error else {
                return XCTFail("unexpected \(error)")
            }
            XCTAssertEqual(body.code, -32002)
            XCTAssertEqual(body.message, "Runtime unavailable")
        }

        try await supervisor.shutdown()
        transport.stop()
    }
}

final class FakeCoreSpawnTests: XCTestCase {
    func testSpawnFakeCore() async throws {
        guard commandExists("pnpm"), commandExists("node") else {
            if ProcessInfo.processInfo.environment["COOKIE_REQUIRE_FAKE_CORE"] == "1" {
                XCTFail("pnpm and node are required for the fake-core spawn test")
            }
            return
        }
        let repo = repoRoot()
        let dataDir = FileManager.default.temporaryDirectory
            .appendingPathComponent("cookie-spawn-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: dataDir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dataDir) }
        XCTAssertFalse(dataDir.path.contains("Application Support"))

        var environment = ProcessInfo.processInfo.environment
        environment["COOKIE_DATA_DIR"] = dataDir.path
        environment["COOKIE_LLAMA_PORT"] = "18080"
        environment["COOKIE_FAKE_DELTA_MS"] = "0"
        let launch = CoreLaunch(
            executable: "/usr/bin/env",
            arguments: ["pnpm", "--filter", "@cookie-agent/core", "fake-core"],
            workingDirectory: repo,
            environment: environment
        )
        let transport = ProcessTransport(launch: launch)
        let supervisor = CoreSupervisor(transport: transport)
        do {
            try await supervisor.start()
            let (initialized, status) = try await supervisor.initialize()
            XCTAssertEqual(initialized.protocolVersion, "0.1")
            XCTAssertEqual(initialized.serverInfo.name, "cookie-fake-core")
            XCTAssertEqual(initialized.serverInfo.version, "0.0.0")
            XCTAssertEqual(status.state, .up)
            XCTAssertEqual(status.modelId, "fake-local")

            let ack = try await supervisor.sendChat(conversationId: "conv-1", text: "hi")
            XCTAssertEqual(ack.conversationId, "conv-1")
            XCTAssertEqual(ack.messageId, "msg-1")
            let done = try await supervisor.waitForDone(messageId: ack.messageId)
            XCTAssertEqual(done.finishReason, .stop)
            let partial = await supervisor.partialText(messageId: ack.messageId)
            XCTAssertEqual(
                partial,
                "I'm here. This reply is from the fake core, with no model loaded."
            )
            try await supervisor.shutdown()
            let code = await transport.waitForExit(timeout: 15)
            XCTAssertEqual(code, 0, transport.stderrText())
        } catch {
            XCTFail("spawn failed: \(error)\nstderr: \(transport.stderrText())")
            transport.stop()
        }
    }
}

private final class Mode: @unchecked Sendable {
    var value = "up"
}

private final class ScriptedTransport: CoreTransport, @unchecked Sendable {
    private let continuation: AsyncStream<String>.Continuation
    let lines: AsyncStream<String>
    var autoReply: ((String) -> [String])?

    init() {
        let pair = AsyncStream<String>.makeStream(bufferingPolicy: .unbounded)
        lines = pair.stream
        continuation = pair.continuation
    }

    func start() throws {}

    func writeLine(_ text: String) throws {
        let replies = autoReply?(text) ?? []
        for line in replies {
            continuation.yield(line)
        }
    }

    func push(_ text: String) {
        continuation.yield(text)
    }

    func closeInput() {}

    func stop() {
        continuation.finish()
    }
}

private func scriptedReply(line: String, mode: Mode) -> [String] {
    let trimmed = line.trimmingCharacters(in: .newlines)
    guard let message = try? decodeWireLine(trimmed) else { return [] }
    switch message {
    case .initializeRequest(let request):
        let result = WireMessage.initializeResult(RpcResult(
            id: request.id,
            result: InitializeResult(
                protocolVersion: protocolVersion,
                serverInfo: PeerInfo(name: "cookie-fake-core", version: "0.0.0"),
                capabilities: ServerCapabilities(
                    chat: ServerCapabilities.Chat(stream: true, cancel: true),
                    runtime: ServerCapabilities.Runtime(status: true)
                )
            )
        ))
        let status = WireMessage.runtimeStatus(RpcNotification(
            method: "runtime.status",
            params: RuntimeStatus(state: .up, modelId: "fake-local")
        ))
        return [encode(result), encode(status)]
    case .chatSendRequest(let request):
        if mode.value == "down" {
            let error = WireMessage.error(RpcErrorMessage(
                id: request.id,
                error: ProtocolErrorBody(
                    code: -32002,
                    message: "Runtime unavailable",
                    data: ErrorData(reason: "runtime is down")
                )
            ))
            return [encode(error)]
        }
        let ack = WireMessage.chatSendResult(RpcResult(
            id: request.id,
            result: ChatSendResult(
                conversationId: request.params.conversationId,
                messageId: "msg-1"
            )
        ))
        let chunks = [
            "I'm here. ",
            "This reply is from the fake core, ",
            "with no model loaded.",
        ]
        var lines = [encode(ack)]
        for (index, chunk) in chunks.enumerated() {
            lines.append(encode(WireMessage.chatDelta(RpcNotification(
                method: "chat.delta",
                params: ChatDeltaParams(
                    conversationId: request.params.conversationId,
                    messageId: "msg-1",
                    index: index,
                    text: chunk
                )
            ))))
        }
        lines.append(encode(WireMessage.chatDone(RpcNotification(
            method: "chat.done",
            params: ChatDoneParams(
                conversationId: request.params.conversationId,
                messageId: "msg-1",
                finishReason: .stop,
                usage: Usage(inputTokens: 1, outputTokens: 13)
            )
        ))))
        return lines
    case .shutdownRequest(let request):
        return [encode(WireMessage.shutdownResult(RpcResult(
            id: request.id,
            result: ShutdownResult(ok: true)
        )))]
    default:
        return []
    }
}

private func encode(_ message: WireMessage) -> String {
    (try? encodeLine(message)) ?? ""
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
