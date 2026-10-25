import Darwin
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
        XCTAssertEqual(popupLoadingLine(runtime: .loading), "Loading the model…")
        XCTAssertNil(popupLoadingLine(runtime: .up))
        XCTAssertNil(popupLoadingLine(runtime: .down))
        XCTAssertFalse(sendEnabled(runtime: .loading))
        XCTAssertTrue(sendEnabled(runtime: .up))
        XCTAssertTrue(sendEnabled(runtime: .down))
        XCTAssertEqual(presentChatSendFailure(code: -32002, runtime: .loading), .stillLoading)
        XCTAssertEqual(presentChatSendFailure(code: -32002, runtime: .up), .stillLoading)
        XCTAssertEqual(presentChatSendFailure(code: -32002, runtime: .down), .notReady)
        XCTAssertEqual(presentChatSendFailure(code: -32003, runtime: .up), .failed)
        XCTAssertEqual(presentChatSendFailure(code: nil, runtime: .loading), .failed)
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
        XCTAssertEqual(CookieAX.popupLoading, "cookie.popup.loading")
        XCTAssertEqual(CookieAX.turnYou(0), "cookie.turn.you.0")
        XCTAssertEqual(CookieAX.turnCookie(1), "cookie.turn.cookie.1")
        XCTAssertEqual(CookieAX.badge(0), "cookie.badge.on-device.0")
        XCTAssertEqual(CookieCopy.ask, "Ask Cookie…")
        XCTAssertEqual(CookieCopy.localOnly, "Local-only mode")
        XCTAssertEqual(CookieCopy.quit, "Quit Cookie")
        XCTAssertEqual(CookieCopy.onDevice, "on-device")
        XCTAssertEqual(CookieCopy.coreNotFound, "🐾 Cookie · core not found")
        XCTAssertEqual(CookieCopy.pnpmNotFound, "🐾 Cookie · pnpm not found")
        XCTAssertEqual(CookieCopy.commandNotFound, "🐾 Cookie · core can't start")
        XCTAssertEqual(ShellLaunchFailure.coreNotFound.statusLine, CookieCopy.coreNotFound)
        XCTAssertEqual(ShellLaunchFailure.pnpmNotFound.statusLine, CookieCopy.pnpmNotFound)
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
        XCTAssertNil(chat.refusalLine(runtime: .loading))
        XCTAssertEqual(popupLoadingLine(runtime: .loading), "Loading the model…")
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
    func testUnsetDataDirUsesApplicationSupport() {
        let home = URL(fileURLWithPath: "/Users/john", isDirectory: true)
        let launch = CoreLaunch.resolve(
            environment: [:],
            currentDirectory: URL(fileURLWithPath: "/tmp/not-a-repo", isDirectory: true),
            homeDirectory: home,
            toolSearchPaths: []
        )
        let dataDir = launch.environment["COOKIE_DATA_DIR"] ?? ""
        XCTAssertEqual(
            dataDir,
            "/Users/john/Library/Application Support/com.johnkimec.cookie-agent"
        )
        XCTAssertFalse(dataDir.contains("/tmp/cookie-m0"))
        XCTAssertFalse(dataDir.contains("cookie-agent-"))
        XCTAssertNil(launch.environment["COOKIE_LLAMA_PORT"])
        XCTAssertEqual(launch.executable, "pnpm")
        XCTAssertEqual(launch.arguments, ["--filter", "@cookie-agent/core", "start"])
        XCTAssertFalse(launch.commandReady)
        XCTAssertFalse(launch.coreRootReady)
        XCTAssertTrue(launch.supervisesRuntime)
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
            homeDirectory: URL(fileURLWithPath: "/Users/john", isDirectory: true),
            toolSearchPaths: []
        )
        XCTAssertEqual(launch.environment["COOKIE_DATA_DIR"], "/tmp/cookie-isolated")
        XCTAssertEqual(launch.environment["COOKIE_LLAMA_PORT"], "18080")
        XCTAssertEqual(launch.executable, "node")
        XCTAssertEqual(
            launch.arguments,
            ["--experimental-strip-types", "src/fake-core.ts"]
        )
        XCTAssertEqual(launch.workingDirectory.path, "/tmp/cookie-repo")
        XCTAssertFalse(launch.coreRootReady)
        XCTAssertFalse(launch.supervisesRuntime)
    }

    func testUnsetAndEmptyPortStayUnset() {
        let home = URL(fileURLWithPath: "/Users/john", isDirectory: true)
        let cwd = URL(fileURLWithPath: "/tmp/not-a-repo", isDirectory: true)
        let unset = CoreLaunch.resolve(
            environment: ["OTHER": "kept"],
            currentDirectory: cwd,
            homeDirectory: home,
            toolSearchPaths: []
        )
        XCTAssertNil(unset.environment["COOKIE_LLAMA_PORT"])
        XCTAssertEqual(unset.environment["OTHER"], "kept")

        let empty = CoreLaunch.resolve(
            environment: ["COOKIE_LLAMA_PORT": ""],
            currentDirectory: cwd,
            homeDirectory: home,
            toolSearchPaths: []
        )
        XCTAssertNil(empty.environment["COOKIE_LLAMA_PORT"])
        XCTAssertEqual(empty.environment["COOKIE_EMBED_PORT"], "8081")
    }

    func testEmbedPortIsPassedToCore() {
        let home = URL(fileURLWithPath: "/Users/john", isDirectory: true)
        let cwd = URL(fileURLWithPath: "/tmp/not-a-repo", isDirectory: true)
        let unset = CoreLaunch.resolve(
            environment: [:],
            currentDirectory: cwd,
            homeDirectory: home,
            toolSearchPaths: []
        )
        XCTAssertEqual(unset.environment["COOKIE_EMBED_PORT"], "8081")
        XCTAssertNil(unset.environment["COOKIE_LLAMA_PORT"])
        XCTAssertTrue(unset.supervisesRuntime)

        let override = CoreLaunch.resolve(
            environment: ["COOKIE_EMBED_PORT": "18081"],
            currentDirectory: cwd,
            homeDirectory: home,
            toolSearchPaths: []
        )
        XCTAssertEqual(override.environment["COOKIE_EMBED_PORT"], "18081")

        let fake = CoreLaunch.resolve(
            environment: [
                "COOKIE_CORE_COMMAND": "pnpm --filter @cookie-agent/core fake-core",
            ],
            currentDirectory: cwd,
            homeDirectory: home,
            toolSearchPaths: []
        )
        XCTAssertFalse(fake.supervisesRuntime)
        XCTAssertEqual(fake.environment["COOKIE_EMBED_PORT"], "8081")

        let invalid = CoreLaunch.resolve(
            environment: ["COOKIE_EMBED_PORT": "nope"],
            currentDirectory: cwd,
            homeDirectory: home,
            toolSearchPaths: []
        )
        XCTAssertEqual(invalid.environment["COOKIE_EMBED_PORT"], "nope")
    }

    func testProductPortIsPassedThrough() {
        let launch = CoreLaunch.resolve(
            environment: ["COOKIE_LLAMA_PORT": "8080"],
            currentDirectory: URL(fileURLWithPath: "/tmp/not-a-repo", isDirectory: true),
            homeDirectory: URL(fileURLWithPath: "/Users/john", isDirectory: true),
            toolSearchPaths: []
        )
        XCTAssertEqual(launch.environment["COOKIE_LLAMA_PORT"], "8080")
    }

    func testFakeCoreDoesNotSuperviseAndRealCoreDoes() {
        let fake = CoreLaunch.resolve(
            environment: ["COOKIE_CORE_COMMAND": "pnpm --filter @cookie-agent/core fake-core"],
            currentDirectory: URL(fileURLWithPath: "/tmp/not-a-repo", isDirectory: true),
            homeDirectory: URL(fileURLWithPath: "/Users/john", isDirectory: true),
            toolSearchPaths: []
        )
        XCTAssertFalse(fake.supervisesRuntime)
        let real = CoreLaunch.resolve(
            environment: [:],
            currentDirectory: URL(fileURLWithPath: "/tmp/not-a-repo", isDirectory: true),
            homeDirectory: URL(fileURLWithPath: "/Users/john", isDirectory: true),
            toolSearchPaths: []
        )
        XCTAssertTrue(real.supervisesRuntime)
    }

    func testPlistRepoRootAndBundleFallback() throws {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("cookie-root-\(UUID().uuidString)", isDirectory: true)
        let repo = root.appendingPathComponent("repo", isDirectory: true)
        let core = repo.appendingPathComponent("core", isDirectory: true)
        try FileManager.default.createDirectory(at: core, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        try Data("{}".utf8).write(to: core.appendingPathComponent("package.json"))
        let bundle = repo.appendingPathComponent("dist/Cookie Agent.app", isDirectory: true)
        try FileManager.default.createDirectory(at: bundle, withIntermediateDirectories: true)
        let home = URL(fileURLWithPath: "/Users/john", isDirectory: true)
        let slash = URL(fileURLWithPath: "/", isDirectory: true)

        let fromPlist = CoreLaunch.resolve(
            environment: [:],
            currentDirectory: slash,
            homeDirectory: home,
            plistRepoRoot: repo.path,
            toolSearchPaths: []
        )
        XCTAssertTrue(fromPlist.coreRootReady)
        XCTAssertEqual(fromPlist.workingDirectory.path, repo.path)

        let fromBundle = CoreLaunch.resolve(
            environment: [:],
            currentDirectory: slash,
            homeDirectory: home,
            plistRepoRoot: "/tmp/missing-cookie-repo",
            bundleURL: bundle,
            toolSearchPaths: []
        )
        XCTAssertTrue(fromBundle.coreRootReady)
        XCTAssertEqual(fromBundle.workingDirectory.path, repo.path)

        let missing = CoreLaunch.resolve(
            environment: [:],
            currentDirectory: slash,
            homeDirectory: home,
            plistRepoRoot: "/tmp/missing-cookie-repo",
            bundleURL: URL(fileURLWithPath: "/tmp/no-such/dist/Cookie Agent.app", isDirectory: true),
            toolSearchPaths: []
        )
        XCTAssertFalse(missing.coreRootReady)
        XCTAssertEqual(ShellLaunchFailure.coreNotFound.statusLine, "🐾 Cookie · core not found")

        let override = CoreLaunch.resolve(
            environment: ["COOKIE_CORE_CWD": "/tmp/cookie-override"],
            currentDirectory: slash,
            homeDirectory: home,
            plistRepoRoot: repo.path,
            toolSearchPaths: []
        )
        XCTAssertEqual(override.workingDirectory.path, "/tmp/cookie-override")
        XCTAssertFalse(override.coreRootReady)
    }

    func testAugmentedPathAndPnpmResolution() throws {
        let home = URL(fileURLWithPath: "/Users/john", isDirectory: true)
        let paths = CoreLaunch.toolSearchPaths(
            environment: ["PATH": "/usr/bin:/bin:/usr/sbin:/sbin"],
            homeDirectory: home
        )
        XCTAssertEqual(paths.first, "/usr/bin")
        XCTAssertTrue(paths.contains("/opt/homebrew/bin"))
        XCTAssertTrue(paths.contains("/usr/local/bin"))
        XCTAssertTrue(paths.contains("/Users/john/Library/pnpm"))
        XCTAssertTrue(paths.contains("/Users/john/.local/share/pnpm"))

        let bin = FileManager.default.temporaryDirectory
            .appendingPathComponent("cookie-pnpm-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: bin, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: bin) }
        let pnpm = bin.appendingPathComponent("pnpm")
        try Data("#!/bin/sh\nexit 0\n".utf8).write(to: pnpm)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: pnpm.path)

        let launch = CoreLaunch.resolve(
            environment: ["PATH": "/usr/bin:/bin"],
            currentDirectory: URL(fileURLWithPath: "/tmp/not-a-repo", isDirectory: true),
            homeDirectory: home,
            toolSearchPaths: [bin.path]
        )
        XCTAssertEqual(launch.executable, pnpm.path)
        XCTAssertEqual(launch.arguments, ["--filter", "@cookie-agent/core", "start"])
        XCTAssertTrue(launch.commandReady)
        XCTAssertEqual(launch.environment["PATH"], bin.path)
        XCTAssertTrue(launch.supervisesRuntime)

        let missingTool = CoreLaunch.resolve(
            environment: ["PATH": "/usr/bin:/bin"],
            currentDirectory: URL(fileURLWithPath: "/tmp/not-a-repo", isDirectory: true),
            homeDirectory: home,
            toolSearchPaths: ["/tmp/cookie-no-tools"]
        )
        XCTAssertFalse(missingTool.commandReady)
        XCTAssertEqual(missingTool.executable, "pnpm")
        XCTAssertEqual(ShellLaunchFailure.pnpmNotFound.statusLine, "🐾 Cookie · pnpm not found")
        XCTAssertEqual(ShellLaunchFailure.commandNotFound.statusLine, "🐾 Cookie · core can't start")
    }

    func testFindRepoWalksToWorkspace() {
        let here = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        let repo = CoreLaunch.findRepo(from: here)
        XCTAssertNotNil(repo)
        XCTAssertTrue(
            FileManager.default.fileExists(atPath: repo!.appendingPathComponent("protocol/README.md").path)
        )
        let launch = CoreLaunch.resolve(
            environment: [:],
            currentDirectory: here,
            homeDirectory: URL(fileURLWithPath: "/Users/john", isDirectory: true),
            toolSearchPaths: []
        )
        XCTAssertTrue(launch.coreRootReady)
        XCTAssertTrue(CoreLaunch.hasCorePackage(launch.workingDirectory))
    }

    /// The real launch is `pnpm --filter @cookie-agent/core start`. Node's
    /// `--disable-warning=ExperimentalWarning` lives on that script, not in
    /// the child's environment.
    func testDefaultCommandUsesStartScriptThatDisablesTypeStripWarning() throws {
        let here = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        let launch = CoreLaunch.resolve(
            environment: [:],
            currentDirectory: here,
            homeDirectory: URL(fileURLWithPath: "/Users/john", isDirectory: true),
            toolSearchPaths: []
        )
        XCTAssertEqual(launch.executable, "pnpm")
        XCTAssertEqual(launch.arguments, ["--filter", "@cookie-agent/core", "start"])
        XCTAssertNil(launch.environment["COOKIE_CORE_COMMAND"])
        XCTAssertNil(launch.environment["NODE_OPTIONS"])
        XCTAssertTrue(launch.supervisesRuntime)

        let repo = try XCTUnwrap(CoreLaunch.findRepo(from: here))
        let packageURL = repo
            .appendingPathComponent("core", isDirectory: true)
            .appendingPathComponent("package.json")
        let data = try Data(contentsOf: packageURL)
        let json = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        let scripts = try XCTUnwrap(json["scripts"] as? [String: String])
        let start = try XCTUnwrap(scripts["start"])
        XCTAssertEqual(
            start,
            "node --experimental-strip-types --disable-warning=ExperimentalWarning src/index.ts"
        )
        let fake = try XCTUnwrap(scripts["fake-core"])
        XCTAssertTrue(fake.contains("--disable-warning=ExperimentalWarning"))
    }
}

final class TerminationHopTests: XCTestCase {
    func testReplyBackstopOutlastsReap() {
        let reap =
            TerminationHop.coreShutdownSeconds
            + runtimeStopGraceSeconds
            + TerminationHop.sigkillWaitSeconds
        XCTAssertEqual(TerminationHop.replyBackstopSeconds, 15)
        XCTAssertGreaterThan(TerminationHop.replyBackstopSeconds, reap)
        XCTAssertEqual(TerminationHop.replyModes, [.common, TerminationHop.modalPanel])
        XCTAssertEqual(
            TerminationHop.signalModes,
            [.default, TerminationHop.eventTracking, TerminationHop.modalPanel]
        )
    }

    func testShellLogAndPidFileFollowTheDataDirectory() throws {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("cookie-shell-log-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let home = root.appendingPathComponent("home", isDirectory: true)
        logShell(
            "signals installed pid=42",
            environment: ["COOKIE_DATA_DIR": root.appendingPathComponent("data").path],
            homeDirectory: home
        )
        writeShellPid(42, environment: ["COOKIE_DATA_DIR": root.appendingPathComponent("data").path], homeDirectory: home)
        let log = root.appendingPathComponent("data/logs/cookie-shell.log")
        let pid = root.appendingPathComponent("data/logs/cookie-agent.pid")
        let text = try String(contentsOf: log, encoding: .utf8)
        XCTAssertTrue(text.contains("cookie-shell: signals installed pid=42"))
        XCTAssertEqual(try String(contentsOf: pid, encoding: .utf8), "42\n")

        logShell("signals installed pid=7", environment: [:], homeDirectory: home)
        let fallback = home
            .appendingPathComponent("Library/Application Support/com.johnkimec.cookie-agent/logs/cookie-shell.log")
        let fallbackText = try String(contentsOf: fallback, encoding: .utf8)
        XCTAssertTrue(fallbackText.contains("cookie-shell: signals installed pid=7"))
    }

    /// A signal source calls this from a background queue. The block has to
    /// run on the main run loop.
    func testSignalHopRunsFromABackgroundQueue() {
        let hopped = expectation(description: "main run loop")
        DispatchQueue.global(qos: .userInitiated).async {
            TerminationHop.perform {
                hopped.fulfill()
            }
        }
        wait(for: [hopped], timeout: 2)
    }

    /// `.terminateLater` spins `.modalPanel` inside the main-queue block that
    /// called `terminate`. A reply on that queue does not run. A run-loop
    /// block in `.modalPanel` does.
    func testReplyRunsInModalLoopWhileMainQueueIsBlocked() {
        let finished = expectation(description: "modal spin finished")
        let viaRunLoop = HopFlag()
        let viaMainQueue = HopFlag()
        DispatchQueue.main.async {
            TerminationHop.performDuringTerminate {
                viaRunLoop.value = true
            }
            DispatchQueue.main.async {
                viaMainQueue.value = true
            }
            let deadline = Date().addingTimeInterval(1)
            while !viaRunLoop.value && Date() < deadline {
                RunLoop.current.run(mode: TerminationHop.modalPanel, before: Date().addingTimeInterval(0.05))
            }
            XCTAssertTrue(viaRunLoop.value)
            XCTAssertFalse(viaMainQueue.value)
            finished.fulfill()
        }
        wait(for: [finished], timeout: 3)
    }
}

/// A class property, not a captured `var`, so a `@Sendable` run-loop block can set it.
private final class HopFlag: @unchecked Sendable {
    var value = false
}

final class RuntimeLaunchTests: XCTestCase {
    func testDefaultArgumentsAndStablePid() {
        let launch = RuntimeLaunch.resolve(
            environment: [:],
            homeDirectory: URL(fileURLWithPath: "/Users/john", isDirectory: true),
            dataDirectory: "/tmp/cookie-data",
            recordsStablePid: true
        )
        XCTAssertEqual(
            [launch.executable] + launch.arguments,
            [
                "/opt/homebrew/bin/llama-server",
                "-m", "/Users/john/cookie-runtime/models/Qwen3.6-35B-A3B-Q4_K_M.gguf",
                "--host", "127.0.0.1",
                "--port", "8080",
                "-c", "32768",
                "-np", "1",
                "-ngl", "99",
                "-fa", "on",
                "--jinja",
                "--metrics",
            ]
        )
        XCTAssertEqual(launch.port, 8080)
        XCTAssertEqual(launch.modelId, "Qwen3.6-35B-A3B")
        XCTAssertEqual(launch.logFile, "/tmp/cookie-data/logs/llama-server.log")
        XCTAssertEqual(launch.pidFile, "/tmp/cookie-data/logs/llama-server.pid")
        XCTAssertEqual(launch.stablePidFile, "/Users/john/cookie-runtime/run/llama-server-8080.pid")
    }

    func testEnvironmentOverrides() {
        let launch = RuntimeLaunch.resolve(
            environment: [
                "COOKIE_MODEL_PATH": "~/models/custom.gguf",
                "COOKIE_LLAMA_SERVER": "~/bin/llama-server",
                "COOKIE_LLAMA_PORT": "18080",
            ],
            homeDirectory: URL(fileURLWithPath: "/Users/john", isDirectory: true),
            dataDirectory: "/tmp/cookie-isolated",
            recordsStablePid: false
        )
        XCTAssertEqual(launch.executable, "/Users/john/bin/llama-server")
        XCTAssertEqual(launch.modelPath, "/Users/john/models/custom.gguf")
        XCTAssertEqual(launch.arguments[1], "/Users/john/models/custom.gguf")
        XCTAssertEqual(launch.port, 18080)
        XCTAssertEqual(launch.arguments[5], "18080")
        XCTAssertEqual(launch.logFile, "/tmp/cookie-isolated/logs/llama-server.log")
        XCTAssertNil(launch.stablePidFile)
    }

    func testEmbedDefaultArgumentsAndStablePid() {
        let launch = RuntimeLaunch.resolveEmbed(
            environment: [:],
            homeDirectory: URL(fileURLWithPath: "/Users/john", isDirectory: true),
            dataDirectory: "/tmp/cookie-data",
            recordsStablePid: true
        )
        XCTAssertEqual(
            [launch.executable] + launch.arguments,
            [
                "/opt/homebrew/bin/llama-server",
                "--embeddings",
                "--pooling", "mean",
                "-m", "/Users/john/cookie-runtime/models/nomic-embed-text-v1.5.Q8_0.gguf",
                "--host", "127.0.0.1",
                "--port", "8081",
                "-ngl", "99",
                "-c", "8192",
                "-np", "4",
                "-b", "2048",
                "-ub", "2048",
            ]
        )
        XCTAssertEqual(launch.port, 8081)
        XCTAssertEqual(launch.modelId, RuntimeLaunch.embedModelID)
        XCTAssertEqual(launch.logFile, "/tmp/cookie-data/logs/llama-embed.log")
        XCTAssertEqual(launch.pidFile, "/tmp/cookie-data/logs/llama-embed.pid")
        XCTAssertEqual(launch.stablePidFile, "/Users/john/cookie-runtime/run/llama-server-8081.pid")
    }

    func testEmbedEnvironmentOverrides() {
        let home = URL(fileURLWithPath: "/Users/john", isDirectory: true)
        let launch = RuntimeLaunch.resolveEmbed(
            environment: [
                "COOKIE_EMBED_MODEL_PATH": "~/models/nomic-embed-text-v1.5.Q8_0.gguf",
                "COOKIE_LLAMA_SERVER": "~/bin/llama-server",
                "COOKIE_EMBED_PORT": "18081",
            ],
            homeDirectory: home,
            dataDirectory: "/tmp/cookie-isolated",
            recordsStablePid: false
        )
        XCTAssertEqual(launch.executable, "/Users/john/bin/llama-server")
        XCTAssertEqual(launch.modelPath, "/Users/john/models/nomic-embed-text-v1.5.Q8_0.gguf")
        XCTAssertEqual(launch.port, 18081)
        XCTAssertEqual(
            launch.arguments,
            [
                "--embeddings",
                "--pooling", "mean",
                "-m", "/Users/john/models/nomic-embed-text-v1.5.Q8_0.gguf",
                "--host", "127.0.0.1",
                "--port", "18081",
                "-ngl", "99",
                "-c", "8192",
                "-np", "4",
                "-b", "2048",
                "-ub", "2048",
            ]
        )
        XCTAssertEqual(launch.logFile, "/tmp/cookie-isolated/logs/llama-embed.log")
        XCTAssertEqual(launch.pidFile, "/tmp/cookie-isolated/logs/llama-embed.pid")
        XCTAssertNil(launch.stablePidFile)

        let chat = RuntimeLaunch.resolve(
            environment: [
                "COOKIE_EMBED_PORT": "18081",
                "COOKIE_EMBED_MODEL_PATH": "~/models/nomic-embed-text-v1.5.Q8_0.gguf",
            ],
            homeDirectory: home,
            dataDirectory: "/tmp/cookie-isolated",
            recordsStablePid: false
        )
        XCTAssertEqual(chat.port, 8080)
        XCTAssertFalse(chat.arguments.contains("--embeddings"))
        XCTAssertEqual(chat.logFile, "/tmp/cookie-isolated/logs/llama-server.log")
    }

    func testEmptyEmbedOverridesUseDefaults() {
        let launch = RuntimeLaunch.resolveEmbed(
            environment: [
                "COOKIE_EMBED_MODEL_PATH": "",
                "COOKIE_LLAMA_SERVER": "",
                "COOKIE_EMBED_PORT": "",
            ],
            homeDirectory: URL(fileURLWithPath: "/Users/ada", isDirectory: true),
            dataDirectory: "/tmp/cookie-data",
            recordsStablePid: true
        )
        XCTAssertEqual(launch.executable, RuntimeLaunch.defaultBinary)
        XCTAssertTrue(launch.modelPath.hasSuffix("nomic-embed-text-v1.5.Q8_0.gguf"))
        XCTAssertEqual(launch.port, 8081)
        XCTAssertEqual(launch.stablePidFile, "/Users/ada/cookie-runtime/run/llama-server-8081.pid")
    }

    func testEmptyOverridesUseDefaultsAndInvalidPortDoesNotLaunch() {
        let launch = RuntimeLaunch.resolve(
            environment: [
                "COOKIE_MODEL_PATH": "",
                "COOKIE_LLAMA_SERVER": "",
                "COOKIE_LLAMA_PORT": "nope",
            ],
            homeDirectory: URL(fileURLWithPath: "/Users/ada", isDirectory: true),
            dataDirectory: "/tmp/cookie-data",
            recordsStablePid: true
        )
        XCTAssertEqual(launch.executable, RuntimeLaunch.defaultBinary)
        XCTAssertTrue(launch.modelPath.hasSuffix("Qwen3.6-35B-A3B-Q4_K_M.gguf"))
        XCTAssertNil(launch.port)
        XCTAssertNil(launch.stablePidFile)
        XCTAssertEqual(runtimeRestartBackoff(step: 1), 1)
        XCTAssertEqual(runtimeRestartBackoff(step: 2), 2)
        XCTAssertEqual(runtimeRestartBackoff(step: 3), 4)
    }

    func testHealthBody() {
        XCTAssertEqual(interpretHealth(status: 200, body: Data("{\"status\":\"ok\"}".utf8)), .up)
        XCTAssertEqual(interpretHealth(status: 200, body: Data()), .up)
        XCTAssertEqual(interpretHealth(status: 200, body: Data("{\"status\":\"loading\"}".utf8)), .loading)
        XCTAssertEqual(interpretHealth(status: 503, body: Data()), .loading)
        XCTAssertEqual(interpretHealth(status: 200, body: Data("{\"status\":\"error\"}".utf8)), .down)
        XCTAssertEqual(interpretHealth(status: 500, body: Data()), .down)
    }

    func testPidFileRoundTrip() throws {
        let dir = FileManager.default.temporaryDirectory
            .appendingPathComponent("cookie-pid-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dir) }
        let store = FileRuntimePidStore(path: dir.appendingPathComponent("llama-server.pid").path)
        XCTAssertNil(store.load())
        store.save(RuntimePidRecord(pid: 42, processGroup: 42, leadsGroup: true))
        XCTAssertEqual(store.load(), RuntimePidRecord(pid: 42, processGroup: 42, leadsGroup: true))
        store.remove()
        XCTAssertNil(store.load())
    }
}

final class RuntimeSupervisorTests: XCTestCase {
    func testReuseHealthyServerDoesNotSpawn() async {
        let launcher = ScriptedLauncher()
        let health = ScriptedHealth(results: [.up])
        let pids = MemoryPidStore()
        let clock = ScriptedClock()
        let supervisor = makeSupervisor(launcher: launcher, health: health, pids: pids, clock: clock)
        await supervisor.start()
        let status = await supervisor.status
        XCTAssertEqual(status.state, .up)
        XCTAssertEqual(status.modelId, "Qwen3.6-35B-A3B")
        XCTAssertTrue(launcher.started.isEmpty)
        let ownsProcess = await supervisor.isOwningProcess
        XCTAssertFalse(ownsProcess)
        await supervisor.stop()
        XCTAssertTrue(launcher.terminated.isEmpty)
    }

    func testExternalLoadingBecomesUpWithoutSpawn() async {
        let launcher = ScriptedLauncher()
        let health = ScriptedHealth(results: [.loading, .up])
        let supervisor = makeSupervisor(
            launcher: launcher,
            health: health,
            pids: MemoryPidStore(),
            clock: ScriptedClock()
        )
        await supervisor.start()
        let status = await supervisor.status
        XCTAssertEqual(status.state, .up)
        XCTAssertTrue(launcher.started.isEmpty)
        let ownsProcess = await supervisor.isOwningProcess
        XCTAssertFalse(ownsProcess)
    }

    func testBackoffThenHealthy() async {
        let launcher = ScriptedLauncher(deathsRemaining: 1)
        let health = LivingHealth(launcher: launcher)
        let clock = ScriptedClock()
        let supervisor = makeSupervisor(
            launcher: launcher,
            health: health,
            pids: MemoryPidStore(),
            clock: clock
        )
        await supervisor.start()
        let status = await supervisor.status
        XCTAssertEqual(status.state, .up)
        XCTAssertEqual(launcher.started.count, 2)
        XCTAssertEqual(clock.recorded(), [1])
        let ownsProcess = await supervisor.isOwningProcess
        XCTAssertTrue(ownsProcess)
        await supervisor.stop()
        XCTAssertEqual(launcher.terminated.count, 1)
    }

    func testGiveUpAfterThreeCrashes() async {
        let launcher = ScriptedLauncher(deathsRemaining: 9)
        let health = ScriptedHealth(results: [.down])
        let clock = ScriptedClock()
        let pids = MemoryPidStore()
        let supervisor = makeSupervisor(launcher: launcher, health: health, pids: pids, clock: clock)
        await supervisor.start()
        let status = await supervisor.status
        XCTAssertEqual(status.state, .down)
        XCTAssertNil(status.modelId)
        XCTAssertEqual(launcher.started.count, 3)
        XCTAssertEqual(launcher.started[0].executable, RuntimeLaunch.defaultBinary)
        XCTAssertEqual(launcher.started[0].arguments, sampleLaunch().arguments)
        XCTAssertEqual(launcher.started[0].logFile, "/tmp/cookie-data/logs/llama-server.log")
        XCTAssertEqual(clock.recorded(), [1, 2])
        XCTAssertNil(pids.record)
        let ownsProcess = await supervisor.isOwningProcess
        XCTAssertFalse(ownsProcess)
    }

    func testSpawnFailureGivesUp() async {
        let launcher = ScriptedLauncher(failStarts: 3)
        let health = ScriptedHealth(results: [.down])
        let clock = ScriptedClock()
        let supervisor = makeSupervisor(
            launcher: launcher,
            health: health,
            pids: MemoryPidStore(),
            clock: clock
        )
        await supervisor.start()
        let status = await supervisor.status
        XCTAssertEqual(status.state, .down)
        XCTAssertTrue(launcher.started.isEmpty)
        XCTAssertEqual(clock.recorded(), [1, 2])
    }

    func testInvalidPortDoesNotSpawn() async {
        var launch = sampleLaunch()
        launch.port = nil
        let launcher = ScriptedLauncher()
        let supervisor = RuntimeSupervisor(
            launch: launch,
            launcher: launcher,
            health: ScriptedHealth(results: [.down]),
            pidStore: MemoryPidStore(),
            clock: ScriptedClock(),
            pollInterval: 0
        )
        await supervisor.start()
        let status = await supervisor.status
        XCTAssertEqual(status.state, .down)
        XCTAssertTrue(launcher.started.isEmpty)
    }

    func testStalePidIsKilledBeforeReuseDecision() async {
        let launcher = ScriptedLauncher()
        launcher.alive.insert(42)
        launcher.ourPids.insert(42)
        let pids = MemoryPidStore()
        pids.record = RuntimePidRecord(pid: 42, processGroup: 42, leadsGroup: true)
        let health = ScriptedHealth(results: [.down, .down, .up])
        let supervisor = makeSupervisor(
            launcher: launcher,
            health: health,
            pids: pids,
            clock: ScriptedClock()
        )
        await supervisor.start()
        XCTAssertEqual(launcher.terminated, [42])
        XCTAssertNotEqual(pids.record?.pid, 42)
        XCTAssertEqual(launcher.started.count, 1)
        let status = await supervisor.status
        XCTAssertEqual(status.state, .up)
        await supervisor.stop()
    }

    func testForeignPidIsLeftAlone() async {
        let launcher = ScriptedLauncher()
        launcher.alive.insert(42)
        let pids = MemoryPidStore()
        pids.record = RuntimePidRecord(pid: 42, processGroup: 42, leadsGroup: true)
        let supervisor = makeSupervisor(
            launcher: launcher,
            health: ScriptedHealth(results: [.up]),
            pids: pids,
            clock: ScriptedClock()
        )
        await supervisor.start()
        XCTAssertTrue(launcher.terminated.isEmpty)
        XCTAssertTrue(launcher.started.isEmpty)
        XCTAssertNil(pids.record)
        let ownsProcess = await supervisor.isOwningProcess
        XCTAssertFalse(ownsProcess)
        await supervisor.stop()
        XCTAssertTrue(launcher.terminated.isEmpty)
    }

    func testDeadPidFileIsClearedAndHealthyPortIsReused() async {
        let launcher = ScriptedLauncher()
        let pids = MemoryPidStore()
        pids.record = RuntimePidRecord(pid: 77, processGroup: 77, leadsGroup: true)
        let supervisor = makeSupervisor(
            launcher: launcher,
            health: ScriptedHealth(results: [.up]),
            pids: pids,
            clock: ScriptedClock()
        )
        await supervisor.start()
        XCTAssertTrue(launcher.terminated.isEmpty)
        XCTAssertTrue(launcher.started.isEmpty)
        XCTAssertNil(pids.record)
        let status = await supervisor.status
        XCTAssertEqual(status.state, .up)
        let ownsProcess = await supervisor.isOwningProcess
        XCTAssertFalse(ownsProcess)
    }

    func testOwnedHealthyServerIsReused() async {
        let launcher = ScriptedLauncher()
        launcher.alive.insert(42)
        launcher.ourPids.insert(42)
        launcher.argumentsByPid[42] = ["--port", "8080"]
        let pids = MemoryPidStore()
        pids.record = RuntimePidRecord(pid: 42, processGroup: 42, leadsGroup: true)
        let supervisor = makeSupervisor(
            launcher: launcher,
            health: ScriptedHealth(results: [.up]),
            pids: pids,
            clock: ScriptedClock()
        )
        await supervisor.start()
        XCTAssertTrue(launcher.terminated.isEmpty)
        XCTAssertTrue(launcher.started.isEmpty)
        XCTAssertEqual(pids.record?.pid, 42)
        let ownsProcess = await supervisor.isOwningProcess
        XCTAssertTrue(ownsProcess)
        let status = await supervisor.status
        XCTAssertEqual(status.state, .up)
        await supervisor.stop()
        XCTAssertEqual(launcher.terminated, [42])
        XCTAssertTrue(launcher.killed.isEmpty)
        XCTAssertNil(pids.record)
    }

    func testRecordedServerOnAnotherPortIsNotAdopted() async {
        let launcher = ScriptedLauncher()
        launcher.alive.insert(42)
        launcher.ourPids.insert(42)
        launcher.argumentsByPid[42] = ["--port", "8081"]
        let pids = MemoryPidStore()
        pids.record = RuntimePidRecord(pid: 42, processGroup: 42, leadsGroup: true)
        let supervisor = makeSupervisor(
            launcher: launcher,
            health: ScriptedHealth(results: [.up]),
            pids: pids,
            clock: ScriptedClock()
        )
        await supervisor.start()
        let ownsProcess = await supervisor.isOwningProcess
        XCTAssertFalse(ownsProcess)
        XCTAssertNil(pids.record)
        XCTAssertTrue(launcher.started.isEmpty)
        XCTAssertTrue(launcher.terminated.isEmpty)
    }

    func testStopDuringProbeDoesNotSpawn() async {
        let launcher = ScriptedLauncher()
        let health = HoldProbe(holdAfter: 1)
        let supervisor = makeSupervisor(
            launcher: launcher,
            health: health,
            pids: MemoryPidStore(),
            clock: ScriptedClock()
        )
        let running = Task { await supervisor.start() }
        await health.waitUntilHeld()
        await supervisor.stop()
        health.releaseHold()
        await running.value
        XCTAssertTrue(launcher.started.isEmpty)
    }

    func testCommandArgumentsContainPort() {
        XCTAssertTrue(commandArgumentsContainPort(["--port", "8080"], port: 8080))
        XCTAssertTrue(commandArgumentsContainPort(["--embeddings", "--port", "8081", "-ngl", "99"], port: 8081))
        XCTAssertFalse(commandArgumentsContainPort(["--port", "8081"], port: 8080))
        XCTAssertFalse(commandArgumentsContainPort(["--port"], port: 8080))
        XCTAssertFalse(commandArgumentsContainPort(["--port=8080"], port: 8080))
    }

    func testLaunchWritesPidFileUnderDataDir() async throws {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("cookie-pid-launch-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let launch = RuntimeLaunch.resolve(
            environment: [:],
            homeDirectory: URL(fileURLWithPath: "/Users/john", isDirectory: true),
            dataDirectory: root.path,
            recordsStablePid: false
        )
        XCTAssertEqual(launch.pidFile, root.appendingPathComponent("logs/llama-server.pid").path)
        let store = FileRuntimePidStore(path: launch.pidFile)
        let launcher = ScriptedLauncher()
        let supervisor = RuntimeSupervisor(
            launch: launch,
            launcher: launcher,
            health: ScriptedHealth(results: [.down, .down, .up]),
            pidStore: store,
            clock: ScriptedClock(),
            pollInterval: 0
        )
        await supervisor.start()
        let record = store.load()
        let started = launcher.lastStartedPid
        XCTAssertEqual(record?.pid, started)
        XCTAssertEqual(record?.processGroup, started)
        XCTAssertEqual(record?.leadsGroup, true)
        let text = try String(contentsOfFile: launch.pidFile, encoding: .utf8)
        XCTAssertTrue(text.contains("\(started ?? 0) \(started ?? 0) 1"))
        await supervisor.stop()
        XCTAssertNil(store.load())
        XCTAssertFalse(FileManager.default.fileExists(atPath: launch.pidFile))
    }

    func testSigtermKeepsPidFileUntilSigkill() async throws {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("cookie-pid-kill-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let launch = RuntimeLaunch.resolve(
            environment: [:],
            homeDirectory: URL(fileURLWithPath: "/Users/john", isDirectory: true),
            dataDirectory: root.path,
            recordsStablePid: false
        )
        let store = FileRuntimePidStore(path: launch.pidFile)
        let launcher = ScriptedLauncher()
        launcher.termKills = false
        launcher.pidPath = launch.pidFile
        let clock = ScriptedClock()
        let supervisor = RuntimeSupervisor(
            launch: launch,
            launcher: launcher,
            health: ScriptedHealth(results: [.down, .down, .up]),
            pidStore: store,
            clock: clock,
            pollInterval: 0
        )
        await supervisor.start()
        guard let pid = launcher.lastStartedPid else {
            XCTFail("server was not started")
            return
        }
        XCTAssertEqual(store.load()?.pid, pid)
        XCTAssertTrue(FileManager.default.fileExists(atPath: launch.pidFile))
        await supervisor.stop()
        let slept = clock.recorded().reduce(0, +)
        XCTAssertGreaterThan(slept, 4.9)
        XCTAssertTrue(launcher.fileExistedAtKill)
        XCTAssertEqual(launcher.terminated, [pid])
        XCTAssertEqual(launcher.killed, [pid])
        XCTAssertNil(store.load())
        XCTAssertFalse(FileManager.default.fileExists(atPath: launch.pidFile))
        XCTAssertFalse(launcher.isAlive(pid))
    }

    func testLauncherWritesLogAndStopsSleep() throws {
        let dir = FileManager.default.temporaryDirectory
            .appendingPathComponent("cookie-launch-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dir) }
        let launcher = DarwinRuntimeLauncher()
        let log = dir.appendingPathComponent("llama-server.log").path
        let echoed = try launcher.start(RuntimeProcessSpec(
            executable: "/bin/echo",
            arguments: ["runtime-supervisor"],
            logFile: log
        ))
        let echoDeadline = Date().addingTimeInterval(3)
        while launcher.isAlive(echoed.pid), Date() < echoDeadline {
            Thread.sleep(forTimeInterval: 0.02)
        }
        XCTAssertFalse(launcher.isAlive(echoed.pid))
        var text = ""
        let logDeadline = Date().addingTimeInterval(2)
        repeat {
            text = (try? String(contentsOfFile: log, encoding: .utf8)) ?? ""
            if text.contains("runtime-supervisor") { break }
            Thread.sleep(forTimeInterval: 0.05)
        } while Date() < logDeadline
        XCTAssertTrue(text.contains("/bin/echo"))
        XCTAssertTrue(text.contains("runtime-supervisor"))

        let slept = try launcher.start(RuntimeProcessSpec(
            executable: "/bin/sleep",
            arguments: ["30"],
            logFile: log
        ))
        XCTAssertTrue(launcher.isAlive(slept.pid))
        XCTAssertFalse(launcher.isOurServer(pid: slept.pid, executable: "/bin/sleep", port: 8080))
        let ported = try launcher.start(RuntimeProcessSpec(
            executable: "/bin/sh",
            arguments: ["-c", "sleep 30", "--port", "8080"],
            logFile: log
        ))
        XCTAssertTrue(launcher.isOurServer(pid: ported.pid, executable: "/bin/sh", port: 8080))
        XCTAssertFalse(launcher.isOurServer(pid: ported.pid, executable: "/bin/sh", port: 8081))
        XCTAssertFalse(launcher.isOurServer(pid: ported.pid, executable: "/bin/sleep", port: 8080))
        launcher.terminate(
            pid: ported.pid,
            processGroup: ported.processGroup,
            leadsGroup: ported.leadsGroup
        )
        XCTAssertEqual(slept.processGroup, slept.pid)
        XCTAssertTrue(slept.leadsGroup)
        XCTAssertEqual(getpgid(slept.pid), slept.pid)
        launcher.terminate(pid: slept.pid, processGroup: slept.processGroup, leadsGroup: slept.leadsGroup)
        let sleepDeadline = Date().addingTimeInterval(3)
        while launcher.isAlive(slept.pid), Date() < sleepDeadline {
            Thread.sleep(forTimeInterval: 0.02)
        }
        XCTAssertFalse(launcher.isAlive(slept.pid))

        let stubborn = try launcher.start(RuntimeProcessSpec(
            executable: "/bin/sh",
            arguments: ["-c", "trap '' TERM; while true; do sleep 30; done"],
            logFile: log
        ))
        Thread.sleep(forTimeInterval: 0.3)
        launcher.terminate(
            pid: stubborn.pid,
            processGroup: stubborn.processGroup,
            leadsGroup: stubborn.leadsGroup
        )
        Thread.sleep(forTimeInterval: 0.3)
        XCTAssertTrue(launcher.isAlive(stubborn.pid))
        launcher.forceTerminate(
            pid: stubborn.pid,
            processGroup: stubborn.processGroup,
            leadsGroup: stubborn.leadsGroup
        )
        let killDeadline = Date().addingTimeInterval(3)
        while launcher.isAlive(stubborn.pid), Date() < killDeadline {
            Thread.sleep(forTimeInterval: 0.02)
        }
        XCTAssertFalse(launcher.isAlive(stubborn.pid))
    }
}

final class RuntimeServersTests: XCTestCase {
    func testBothServersLaunchWithExactFlags() async {
        let chatLauncher = ScriptedLauncher()
        let embedLauncher = ScriptedLauncher()
        let plan = makePlan(
            environment: [:],
            modelExists: true,
            chatLauncher: chatLauncher,
            embedLauncher: embedLauncher,
            chatHealth: [.down, .down, .up],
            embedHealth: [.down, .down, .up]
        )
        XCTAssertNil(plan.embedSkip)
        XCTAssertNotNil(plan.servers.embed)
        await plan.servers.start()
        XCTAssertEqual(chatLauncher.started.count, 1)
        XCTAssertEqual(embedLauncher.started.count, 1)
        XCTAssertEqual(
            [chatLauncher.started[0].executable] + chatLauncher.started[0].arguments,
            [plan.chatLaunch.executable] + plan.chatLaunch.arguments
        )
        XCTAssertEqual(chatLauncher.started[0].logFile, "/tmp/cookie-data/logs/llama-server.log")
        XCTAssertEqual(
            [embedLauncher.started[0].executable] + embedLauncher.started[0].arguments,
            [
                "/opt/homebrew/bin/llama-server",
                "--embeddings",
                "--pooling", "mean",
                "-m", "/Users/john/cookie-runtime/models/nomic-embed-text-v1.5.Q8_0.gguf",
                "--host", "127.0.0.1",
                "--port", "8081",
                "-ngl", "99",
                "-c", "8192",
                "-np", "4",
                "-b", "2048",
                "-ub", "2048",
            ]
        )
        XCTAssertEqual(embedLauncher.started[0].logFile, "/tmp/cookie-data/logs/llama-embed.log")
        let chatStatus = await plan.servers.chat.status
        XCTAssertEqual(chatStatus.state, .up)
        XCTAssertEqual(chatStatus.modelId, "Qwen3.6-35B-A3B")
        await plan.servers.stop()
    }

    func testEmbedOverridesReachTheLauncher() async {
        let chatLauncher = ScriptedLauncher()
        let embedLauncher = ScriptedLauncher()
        let plan = makePlan(
            environment: [
                "COOKIE_LLAMA_SERVER": "/opt/homebrew/bin/llama-server",
                "COOKIE_EMBED_PORT": "18081",
                "COOKIE_EMBED_MODEL_PATH": "/tmp/cookie-models/nomic-embed-text-v1.5.Q8_0.gguf",
                "COOKIE_LLAMA_PORT": "18080",
                "COOKIE_MODEL_PATH": "/tmp/cookie-models/Qwen3.6-35B-A3B-Q4_K_M.gguf",
            ],
            modelExists: true,
            chatLauncher: chatLauncher,
            embedLauncher: embedLauncher,
            chatHealth: [.down, .down, .up],
            embedHealth: [.down, .down, .up]
        )
        await plan.servers.start()
        XCTAssertEqual(chatLauncher.started[0].arguments[5], "18080")
        XCTAssertEqual(embedLauncher.started[0].arguments, [
            "--embeddings",
            "--pooling", "mean",
            "-m", "/tmp/cookie-models/nomic-embed-text-v1.5.Q8_0.gguf",
            "--host", "127.0.0.1",
            "--port", "18081",
            "-ngl", "99",
            "-c", "8192",
            "-np", "4",
            "-b", "2048",
            "-ub", "2048",
        ])
        await plan.servers.stop()
    }

    func testReuseHealthyEmbedderDoesNotSpawn() async throws {
        let chatLauncher = ScriptedLauncher()
        let embedLauncher = ScriptedLauncher()
        let plan = makePlan(
            environment: [:],
            modelExists: true,
            chatLauncher: chatLauncher,
            embedLauncher: embedLauncher,
            chatHealth: [.up],
            embedHealth: [.up]
        )
        await plan.servers.start()
        XCTAssertTrue(chatLauncher.started.isEmpty)
        XCTAssertTrue(embedLauncher.started.isEmpty)
        let chatOwns = await plan.servers.chat.isOwningProcess
        let embed = try XCTUnwrap(plan.servers.embed)
        let embedOwns = await embed.isOwningProcess
        XCTAssertFalse(chatOwns)
        XCTAssertFalse(embedOwns)
        let chatStatus = await plan.servers.chat.status
        XCTAssertEqual(chatStatus.state, .up)
        XCTAssertEqual(chatStatus.modelId, "Qwen3.6-35B-A3B")
        await plan.servers.stop()
        XCTAssertTrue(chatLauncher.terminated.isEmpty)
        XCTAssertTrue(embedLauncher.terminated.isEmpty)
    }

    func testEmbedFailureDoesNotBlockChat() async throws {
        let chatLauncher = ScriptedLauncher()
        let embedLauncher = ScriptedLauncher(failStarts: 3)
        let plan = makePlan(
            environment: [:],
            modelExists: true,
            chatLauncher: chatLauncher,
            embedLauncher: embedLauncher,
            chatHealth: [.up],
            embedHealth: [.down]
        )
        await plan.servers.start()
        let chatStatus = await plan.servers.chat.status
        let embed = try XCTUnwrap(plan.servers.embed)
        let embedStatus = await embed.status
        XCTAssertEqual(chatStatus.state, .up)
        XCTAssertEqual(chatStatus.modelId, "Qwen3.6-35B-A3B")
        XCTAssertEqual(embedStatus.state, .down)
        XCTAssertNil(embedStatus.modelId)
        XCTAssertTrue(chatLauncher.started.isEmpty)
        XCTAssertTrue(embedLauncher.started.isEmpty)
        XCTAssertTrue(chatLauncher.terminated.isEmpty)
        await plan.servers.stop()
        XCTAssertTrue(chatLauncher.terminated.isEmpty)
    }

    func testMissingEmbedModelSkipsWithoutBlockingChat() async {
        let chatLauncher = ScriptedLauncher()
        let embedLauncher = ScriptedLauncher()
        let calls = FactoryCalls()
        let plan = RuntimeServers.make(
            environment: [:],
            homeDirectory: URL(fileURLWithPath: "/Users/john", isDirectory: true),
            dataDirectory: "/tmp/cookie-data",
            recordsStablePid: false,
            modelExists: { _ in false },
            chatFactory: { launch in
                calls.noteChat()
                return RuntimeSupervisor(
                    launch: launch,
                    launcher: chatLauncher,
                    health: ScriptedHealth(results: [.up]),
                    pidStore: MemoryPidStore(),
                    clock: ScriptedClock(),
                    pollInterval: 0
                )
            },
            embedFactory: { launch in
                calls.noteEmbed()
                return RuntimeSupervisor(
                    launch: launch,
                    launcher: embedLauncher,
                    health: ScriptedHealth(results: [.down]),
                    pidStore: MemoryPidStore(),
                    clock: ScriptedClock(),
                    pollInterval: 0
                )
            }
        )
        XCTAssertEqual(calls.chat, 1)
        XCTAssertEqual(calls.embed, 0)
        XCTAssertNil(plan.servers.embed)
        XCTAssertEqual(
            plan.embedSkip,
            "embed model missing /Users/john/cookie-runtime/models/nomic-embed-text-v1.5.Q8_0.gguf; skipping llama-embed"
        )
        await plan.servers.start()
        let chatStatus = await plan.servers.chat.status
        XCTAssertEqual(chatStatus.state, .up)
        XCTAssertEqual(chatStatus.modelId, "Qwen3.6-35B-A3B")
        XCTAssertTrue(embedLauncher.started.isEmpty)
        await plan.servers.stop()
    }

    func testInvalidEmbedPortSkips() {
        let calls = FactoryCalls()
        let plan = RuntimeServers.make(
            environment: ["COOKIE_EMBED_PORT": "nope"],
            homeDirectory: URL(fileURLWithPath: "/Users/john", isDirectory: true),
            dataDirectory: "/tmp/cookie-data",
            recordsStablePid: false,
            modelExists: { _ in true },
            chatFactory: { launch in
                calls.noteChat()
                return RuntimeSupervisor(
                    launch: launch,
                    launcher: ScriptedLauncher(),
                    health: ScriptedHealth(results: [.up]),
                    pidStore: MemoryPidStore(),
                    clock: ScriptedClock(),
                    pollInterval: 0
                )
            },
            embedFactory: { launch in
                calls.noteEmbed()
                return RuntimeSupervisor(
                    launch: launch,
                    launcher: ScriptedLauncher(),
                    health: ScriptedHealth(results: [.down]),
                    pidStore: MemoryPidStore(),
                    clock: ScriptedClock(),
                    pollInterval: 0
                )
            }
        )
        XCTAssertEqual(calls.chat, 1)
        XCTAssertEqual(calls.embed, 0)
        XCTAssertNil(plan.servers.embed)
        XCTAssertEqual(plan.embedSkip, "embed port invalid nope; skipping llama-embed")
        XCTAssertEqual(plan.chatLaunch.port, 8080)
    }

    func testEmbedPortMatchingChatPortSkips() async {
        let chatLauncher = ScriptedLauncher()
        let calls = FactoryCalls()
        let plan = RuntimeServers.make(
            environment: [
                "COOKIE_LLAMA_PORT": "18080",
                "COOKIE_EMBED_PORT": "18080",
            ],
            homeDirectory: URL(fileURLWithPath: "/Users/john", isDirectory: true),
            dataDirectory: "/tmp/cookie-data",
            recordsStablePid: false,
            modelExists: { _ in true },
            chatFactory: { launch in
                calls.noteChat()
                return RuntimeSupervisor(
                    launch: launch,
                    launcher: chatLauncher,
                    health: ScriptedHealth(results: [.up]),
                    pidStore: MemoryPidStore(),
                    clock: ScriptedClock(),
                    pollInterval: 0
                )
            },
            embedFactory: { _ in
                calls.noteEmbed()
                return RuntimeSupervisor(
                    launch: sampleLaunch(),
                    launcher: ScriptedLauncher(),
                    health: ScriptedHealth(results: [.down]),
                    pidStore: MemoryPidStore(),
                    clock: ScriptedClock(),
                    pollInterval: 0
                )
            }
        )
        XCTAssertEqual(calls.chat, 1)
        XCTAssertEqual(calls.embed, 0)
        XCTAssertNil(plan.servers.embed)
        XCTAssertEqual(plan.embedSkip, "embed port 18080 matches chat port; skipping llama-embed")
        XCTAssertEqual(plan.chatLaunch.port, 18080)
        await plan.servers.start()
        let chatStatus = await plan.servers.chat.status
        XCTAssertEqual(chatStatus.state, .up)
        XCTAssertEqual(chatStatus.modelId, "Qwen3.6-35B-A3B")
        XCTAssertTrue(chatLauncher.started.isEmpty)
        await plan.servers.stop()
    }

    func testStopWaitsForBothServers() async throws {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("cookie-both-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let chatLaunch = RuntimeLaunch.resolve(
            environment: [:],
            homeDirectory: URL(fileURLWithPath: "/Users/john", isDirectory: true),
            dataDirectory: root.path,
            recordsStablePid: false
        )
        let embedLaunch = RuntimeLaunch.resolveEmbed(
            environment: [:],
            homeDirectory: URL(fileURLWithPath: "/Users/john", isDirectory: true),
            dataDirectory: root.path,
            recordsStablePid: false
        )
        let chatStore = FileRuntimePidStore(path: chatLaunch.pidFile)
        let embedStore = FileRuntimePidStore(path: embedLaunch.pidFile)
        let chatLauncher = ScriptedLauncher()
        chatLauncher.termKills = true
        let embedLauncher = ScriptedLauncher()
        embedLauncher.termKills = false
        embedLauncher.pidPath = embedLaunch.pidFile
        let embedClock = ScriptedClock()
        let chat = RuntimeSupervisor(
            launch: chatLaunch,
            launcher: chatLauncher,
            health: ScriptedHealth(results: [.down, .down, .up]),
            pidStore: chatStore,
            clock: ScriptedClock(),
            pollInterval: 0
        )
        let embed = RuntimeSupervisor(
            launch: embedLaunch,
            launcher: embedLauncher,
            health: ScriptedHealth(results: [.down, .down, .up]),
            pidStore: embedStore,
            clock: embedClock,
            pollInterval: 0
        )
        let servers = RuntimeServers(chat: chat, embed: embed)
        await servers.start()
        XCTAssertNotNil(chatStore.load())
        XCTAssertNotNil(embedStore.load())
        await servers.stop()
        XCTAssertEqual(chatLauncher.terminated.count, 1)
        XCTAssertTrue(chatLauncher.killed.isEmpty)
        XCTAssertEqual(embedLauncher.terminated.count, 1)
        XCTAssertEqual(embedLauncher.killed.count, 1)
        XCTAssertGreaterThan(embedClock.recorded().reduce(0, +), 4.9)
        XCTAssertTrue(embedLauncher.fileExistedAtKill)
        XCTAssertNil(chatStore.load())
        XCTAssertNil(embedStore.load())
        XCTAssertFalse(FileManager.default.fileExists(atPath: chatLaunch.pidFile))
        XCTAssertFalse(FileManager.default.fileExists(atPath: embedLaunch.pidFile))
    }
}

private final class FactoryCalls: @unchecked Sendable {
    private let lock = NSLock()
    private var chatCalls = 0
    private var embedCalls = 0

    func noteChat() {
        lock.lock()
        chatCalls += 1
        lock.unlock()
    }

    func noteEmbed() {
        lock.lock()
        embedCalls += 1
        lock.unlock()
    }

    var chat: Int {
        lock.lock()
        defer { lock.unlock() }
        return chatCalls
    }

    var embed: Int {
        lock.lock()
        defer { lock.unlock() }
        return embedCalls
    }
}

private func makePlan(
    environment: [String: String],
    modelExists: Bool,
    chatLauncher: ScriptedLauncher,
    embedLauncher: ScriptedLauncher,
    chatHealth: [RuntimeProbe],
    embedHealth: [RuntimeProbe]
) -> RuntimeServerPlan {
    RuntimeServers.make(
        environment: environment,
        homeDirectory: URL(fileURLWithPath: "/Users/john", isDirectory: true),
        dataDirectory: "/tmp/cookie-data",
        recordsStablePid: false,
        modelExists: { _ in modelExists },
        chatFactory: { launch in
            RuntimeSupervisor(
                launch: launch,
                launcher: chatLauncher,
                health: ScriptedHealth(results: chatHealth),
                pidStore: MemoryPidStore(),
                clock: ScriptedClock(),
                pollInterval: 0
            )
        },
        embedFactory: { launch in
            RuntimeSupervisor(
                launch: launch,
                launcher: embedLauncher,
                health: ScriptedHealth(results: embedHealth),
                pidStore: MemoryPidStore(),
                clock: ScriptedClock(),
                pollInterval: 0
            )
        }
    )
}

private func sampleLaunch() -> RuntimeLaunch {
    RuntimeLaunch.resolve(
        environment: [:],
        homeDirectory: URL(fileURLWithPath: "/Users/john", isDirectory: true),
        dataDirectory: "/tmp/cookie-data",
        recordsStablePid: false
    )
}

private func makeSupervisor(
    launcher: ScriptedLauncher,
    health: any RuntimeHealthChecking,
    pids: MemoryPidStore,
    clock: ScriptedClock
) -> RuntimeSupervisor {
    RuntimeSupervisor(
        launch: sampleLaunch(),
        launcher: launcher,
        health: health,
        pidStore: pids,
        clock: clock,
        pollInterval: 0
    )
}

private final class ScriptedClock: RuntimeClock, @unchecked Sendable {
    private let lock = NSLock()
    private var sleeps: [Double] = []

    func sleep(seconds: Double) async {
        if seconds > 0 {
            note(seconds)
        }
        await Task.yield()
    }

    private func note(_ seconds: Double) {
        lock.lock()
        sleeps.append(seconds)
        lock.unlock()
    }

    func recorded() -> [Double] {
        lock.lock()
        defer { lock.unlock() }
        return sleeps
    }
}

private final class ScriptedHealth: RuntimeHealthChecking, @unchecked Sendable {
    private let lock = NSLock()
    private var results: [RuntimeProbe]

    init(results: [RuntimeProbe]) {
        self.results = results
    }

    func probe(port: Int) async -> RuntimeProbe {
        nextProbe()
    }

    private func nextProbe() -> RuntimeProbe {
        lock.lock()
        defer { lock.unlock() }
        if results.isEmpty { return .down }
        if results.count == 1 { return results[0] }
        return results.removeFirst()
    }
}

private final class LivingHealth: RuntimeHealthChecking, @unchecked Sendable {
    let launcher: ScriptedLauncher

    init(launcher: ScriptedLauncher) {
        self.launcher = launcher
    }

    func probe(port: Int) async -> RuntimeProbe {
        living()
    }

    private func living() -> RuntimeProbe {
        launcher.hasLivingProcess ? .up : .down
    }
}

private final class MemoryPidStore: RuntimePidStoring, @unchecked Sendable {
    var record: RuntimePidRecord?

    func load() -> RuntimePidRecord? { record }

    func save(_ record: RuntimePidRecord) {
        self.record = record
    }

    func remove() {
        record = nil
    }
}

private final class ScriptedLauncher: RuntimeLaunching, @unchecked Sendable {
    private let lock = NSLock()
    private(set) var started: [RuntimeProcessSpec] = []
    private(set) var terminated: [Int32] = []
    private(set) var killed: [Int32] = []
    private(set) var lastStartedPid: Int32?
    var alive: Set<Int32> = []
    var ourPids: Set<Int32> = []
    var argumentsByPid: [Int32: [String]] = [:]
    var deathsRemaining: Int
    var failStarts: Int
    var termKills = true
    var pidPath: String?
    private(set) var fileExistedAtKill = false
    private var nextPid: Int32 = 100

    init(deathsRemaining: Int = 0, failStarts: Int = 0) {
        self.deathsRemaining = deathsRemaining
        self.failStarts = failStarts
    }

    var hasLivingProcess: Bool {
        lock.lock()
        defer { lock.unlock() }
        return !alive.isEmpty
    }

    func start(_ spec: RuntimeProcessSpec) throws -> OwnedProcess {
        lock.lock()
        defer { lock.unlock() }
        if failStarts > 0 {
            failStarts -= 1
            throw RuntimeSpawnError.failed("spawn")
        }
        let pid = nextPid
        nextPid += 1
        started.append(spec)
        lastStartedPid = pid
        ourPids.insert(pid)
        argumentsByPid[pid] = spec.arguments
        if deathsRemaining > 0 {
            deathsRemaining -= 1
        } else {
            alive.insert(pid)
        }
        return OwnedProcess(pid: pid, processGroup: pid, leadsGroup: true)
    }

    func isAlive(_ pid: Int32) -> Bool {
        lock.lock()
        defer { lock.unlock() }
        return alive.contains(pid)
    }

    func terminate(pid: Int32, processGroup: Int32, leadsGroup: Bool) {
        lock.lock()
        terminated.append(pid)
        let kills = termKills
        if kills {
            alive.remove(pid)
            alive.remove(processGroup)
        }
        lock.unlock()
    }

    func forceTerminate(pid: Int32, processGroup: Int32, leadsGroup: Bool) {
        let existed = pidPath.map { FileManager.default.fileExists(atPath: $0) } ?? false
        lock.lock()
        fileExistedAtKill = existed
        killed.append(pid)
        alive.remove(pid)
        alive.remove(processGroup)
        lock.unlock()
    }

    func reap(_ pid: Int32) -> Int32? {
        isAlive(pid) ? nil : 1
    }

    func isOurServer(pid: Int32, executable: String, port: Int) -> Bool {
        lock.lock()
        defer { lock.unlock() }
        guard ourPids.contains(pid), executable == RuntimeLaunch.defaultBinary else { return false }
        guard let arguments = argumentsByPid[pid] else { return true }
        return commandArgumentsContainPort(arguments, port: port)
    }
}

/// The first `holdAfter` probes return immediately. The next one waits
/// until `releaseHold`, so a test can call `stop` during that probe.
private final class HoldProbe: RuntimeHealthChecking, @unchecked Sendable {
    private let lock = NSLock()
    private var entered = 0
    private var released = false
    private var waiters: [CheckedContinuation<Void, Never>] = []
    private let holdAfter: Int

    init(holdAfter: Int) {
        self.holdAfter = holdAfter
    }

    func probe(port: Int) async -> RuntimeProbe {
        let shouldHold: Bool
        lock.lock()
        entered += 1
        shouldHold = entered > holdAfter && !released
        lock.unlock()
        if shouldHold {
            await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
                lock.lock()
                if released {
                    lock.unlock()
                    continuation.resume()
                } else {
                    waiters.append(continuation)
                    lock.unlock()
                }
            }
        }
        return .down
    }

    func waitUntilHeld() async {
        while true {
            lock.lock()
            let held = entered > holdAfter
            lock.unlock()
            if held { return }
            await Task.yield()
        }
    }

    func releaseHold() {
        lock.lock()
        released = true
        let pending = waiters
        waiters.removeAll()
        lock.unlock()
        for continuation in pending {
            continuation.resume()
        }
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
