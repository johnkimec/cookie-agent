import AppKit
import Combine
import CookieCore
import CookieProtocol
import Foundation

/// Main-thread UI model. `@unchecked Sendable` so the Carbon hotkey and
/// NSEvent monitors can hop back to the main queue. They do not touch it
/// from a background thread.
final class AppModel: ObservableObject, @unchecked Sendable {
    @Published var runtime = RuntimeStatus(state: .down, modelId: nil)
    @Published var popupOpen = false
    @Published var conversation = PopupConversation()
    @Published var launchFailure: ShellLaunchFailure?

    let localOnly = true
    let conversationID: String

    var onPopup: ((Bool) -> Void)?
    var onLayout: (() -> Void)?

    private let turns: PopupChatSession
    private var supervisor: CoreSupervisor?
    private var transport: ProcessTransport?
    private var runtimeSupervisor: RuntimeSupervisor?
    private var eventsTask: Task<Void, Never>?
    private var runtimeEventsTask: Task<Void, Never>?
    private var coreReady = false
    private var pendingPush: RuntimeStatus?
    private var lastToggle = Date.distantPast
    private var terminationStarted = false
    /// `chat.delta` waits here. `chat.done` delivers this buffer before
    /// `ingestDone`, because `applyDelta` no-ops once the reply is settled.
    private var replyBuffer = ReplyDeltaBuffer()
    private var uiCoalescer = ReplyUICoalescer()
    private var flushItem: DispatchWorkItem?

    var menuGlyphState: MenuGlyph {
        menuGlyph(
            runtime: runtime.state,
            popupOpen: popupOpen,
            replyInFlight: conversation.replyInFlight
        )
    }

    var menuVoiceOverText: String {
        CookieCore.menuVoiceOver(menuGlyphState)
    }

    var pose: PopupPose {
        popupPose(
            runtime: runtime.state,
            replyInFlight: conversation.replyInFlight,
            cookieTextStarted: conversation.cookieTextStarted
        )
    }

    var statusText: String {
        if let launchFailure {
            return launchFailure.statusLine
        }
        return CookieCore.statusLine(runtime: runtime.state, modelID: runtime.modelId)
    }

    init() {
        let id = "conv-\(UUID().uuidString)"
        conversationID = id
        let session = PopupChatSession(conversationID: id)
        turns = session
        session.onChange = { [weak self] in
            self?.publishTurns()
        }
        session.onSendFailure = { [weak self] failure in
            self?.handleSendFailure(failure)
        }
        session.onCancelFailure = { [weak self] description in
            DispatchQueue.main.async {
                self?.log("cancel: \(description)")
            }
        }
    }

    func start() {
        let plistRoot = Bundle.main.object(forInfoDictionaryKey: "CookieRepoRoot") as? String
        let launch = CoreLaunch.resolve(
            environment: ProcessInfo.processInfo.environment,
            currentDirectory: URL(fileURLWithPath: FileManager.default.currentDirectoryPath, isDirectory: true),
            homeDirectory: FileManager.default.homeDirectoryForCurrentUser,
            plistRepoRoot: plistRoot,
            bundleURL: Bundle.main.bundleURL
        )
        do {
            try launch.prepareDataDirectory()
        } catch {
            log("data dir: \(error)")
        }
        let dataDir = launch.environment["COOKIE_DATA_DIR"] ?? ""
        let inherited = !(ProcessInfo.processInfo.environment["COOKIE_DATA_DIR"]?.isEmpty ?? true)
        let portText = parseLlamaPort(launch.environment["COOKIE_LLAMA_PORT"]).map(String.init) ?? "invalid"
        let command = ([launch.executable] + launch.arguments).joined(separator: " ")
        log(
            "dataDir=\(dataDir) dataDirSource=\(inherited ? "environment" : "default") port=\(portText) core=\(command) cwd=\(launch.workingDirectory.path) coreRoot=\(launch.coreRootReady) commandReady=\(launch.commandReady) path=\(launch.environment["PATH"] ?? "")"
        )
        guard launch.coreRootReady, launch.commandReady else {
            if !launch.coreRootReady {
                launchFailure = .coreNotFound
            } else if (launch.executable as NSString).lastPathComponent == "pnpm" {
                launchFailure = .pnpmNotFound
            } else {
                launchFailure = .commandNotFound
            }
            log("core launch failed status=\(statusText)")
            return
        }
        let transport = ProcessTransport(launch: launch)
        let supervisor = CoreSupervisor(transport: transport)
        self.transport = transport
        self.supervisor = supervisor
        turns.attach(supervisor)
        let events = supervisor.events
        eventsTask = Task { [weak self] in
            for await event in events {
                self?.handle(event)
            }
        }
        if launch.supervisesRuntime {
            let providedData = !(ProcessInfo.processInfo.environment["COOKIE_DATA_DIR"]?.isEmpty ?? true)
            let runtimeLaunch = RuntimeLaunch.resolve(
                environment: launch.environment,
                homeDirectory: FileManager.default.homeDirectoryForCurrentUser,
                dataDirectory: launch.environment["COOKIE_DATA_DIR"] ?? "",
                recordsStablePid: !providedData
            )
            let runtime = RuntimeSupervisor.live(launch: runtimeLaunch)
            self.runtimeSupervisor = runtime
            self.runtime = RuntimeStatus(state: .loading, modelId: runtimeLaunch.modelId)
            self.turns.noteRuntime(.loading)
            log(
                "llama=\(runtimeLaunch.executable) \(runtimeLaunch.arguments.joined(separator: " ")) log=\(runtimeLaunch.logFile) pid=\(runtimeLaunch.pidFile)"
            )
            let runtimeEvents = runtime.events
            runtimeEventsTask = Task { [weak self] in
                for await status in runtimeEvents {
                    self?.applySupervisorStatus(status)
                }
            }
            Task {
                await runtime.start()
            }
        }
        Task { [weak self] in
            do {
                try await supervisor.start()
                _ = try await supervisor.initialize()
                self?.markCoreReady()
            } catch {
                self?.log("core: \(error)")
            }
        }
    }

    /// `applicationShouldTerminate` calls this and replies only after the
    /// owned server has exited. A second call (willTerminate) does not
    /// start another shutdown.
    ///
    /// The reply is scheduled on the main run loop in the modal-panel mode.
    /// `DispatchQueue.main.async` does not run while `terminate` is still
    /// inside the main-queue block that entered `.terminateLater`. Shutdown
    /// itself is detached so it cannot resume on the main actor and wait
    /// for that same queue.
    func prepareTermination() {
        if terminationStarted { return }
        terminationStarted = true
        let reply = TerminationReply()
        Task.detached { [weak self] in
            await self?.shutdownForExit()
            reply.send(reason: "stopped")
        }
        TerminationHop.performDuringTerminate(after: TerminationHop.replyBackstopSeconds) {
            reply.send(reason: "backstop")
        }
    }

    func stopCore() {
        if terminationStarted { return }
        terminationStarted = true
        let gate = ExitGate()
        // Detached so this wait on the main thread cannot stall the task
        // if the caller is the main actor.
        Task.detached { [weak self] in
            await self?.shutdownForExit()
            gate.signal()
        }
        gate.wait()
    }

    func togglePopup() {
        let now = Date()
        if now.timeIntervalSince(lastToggle) < 0.25 { return }
        lastToggle = now
        if popupOpen {
            closePopup()
        } else {
            openPopup()
        }
    }

    func openPopup() {
        lastToggle = Date()
        let wasOpen = popupOpen
        turns.open(at: Date())
        if wasOpen {
            onPopup?(true)
        }
    }

    func closePopup() {
        guard popupOpen else { return }
        turns.close(at: Date())
    }

    func setDraft(_ text: String) {
        turns.setDraft(text)
    }

    /// Return, the send button, and AXConfirm. Stops a reply that is still arriving.
    func submit() {
        turns.pressReturn()
    }

    /// Escape. Stops a reply that is still arriving and leaves the panel open.
    /// Closes the panel when nothing is arriving.
    func pressEscape() {
        turns.pressEscape()
    }

    func recallLast() {
        turns.recallLast()
    }

    func quit() {
        NSApp.terminate(nil)
    }

    private func shutdownForExit() async {
        try? await supervisor?.shutdown()
        transport?.stop()
        eventsTask?.cancel()
        runtimeEventsTask?.cancel()
        await runtimeSupervisor?.stop()
    }

    private func publishTurns() {
        publishTurnsNow()
    }

    private func publishTurnsNow() {
        let apply = { [weak self] in
            guard let self else { return }
            let snap = self.turns.snapshot
            self.conversation = snap.conversation
            if self.popupOpen != snap.popupOpen {
                self.popupOpen = snap.popupOpen
                self.onPopup?(self.popupOpen)
            }
            self.onLayout?()
        }
        if Thread.isMainThread {
            apply()
        } else {
            DispatchQueue.main.async(execute: apply)
        }
    }

    private func handle(_ event: CoreEvent) {
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            switch event {
            case .runtime(let status):
                if self.runtimeSupervisor == nil {
                    self.runtime = status
                    self.turns.noteRuntime(status.state)
                }
            case .delta(let delta):
                self.replyBuffer.append(delta)
                if self.uiCoalescer.noteDelta() {
                    self.scheduleReplyFlush()
                }
            case .done(let done):
                self.flushItem?.cancel()
                self.flushItem = nil
                self.uiCoalescer.noteDone()
                self.deliverBufferedDeltas()
                self.turns.ingestDone(done)
                let accumulated = ReplyStream.cookieText(in: self.conversation)
                self.log(ReplyStream.doneLog(messageId: done.messageId, accumulated: accumulated))
            case .rpcError, .decodeFailed:
                self.onLayout?()
            }
        }
    }

    private func deliverBufferedDeltas() {
        for delta in replyBuffer.takePending() {
            turns.ingestDelta(delta)
        }
    }

    private func scheduleReplyFlush() {
        let item = DispatchWorkItem { [weak self] in
            guard let self else { return }
            self.flushItem = nil
            guard self.uiCoalescer.noteFlush() else { return }
            self.deliverBufferedDeltas()
        }
        flushItem = item
        DispatchQueue.main.asyncAfter(deadline: .now() + ReplyStream.flushInterval, execute: item)
    }

    private func markCoreReady() {
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            self.coreReady = true
            self.flushPush()
        }
    }

    private func applySupervisorStatus(_ status: RuntimeStatus) {
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            self.runtime = status
            self.turns.noteRuntime(status.state)
            self.pendingPush = status
            self.flushPush()
        }
    }

    private func flushPush() {
        guard coreReady, let status = pendingPush, let supervisor else { return }
        pendingPush = nil
        Task {
            do {
                try await supervisor.pushRuntime(status)
            } catch {
                self.log("runtime push: \(error)")
            }
        }
    }

    /// The session has already restored the draft. This only sets the quiet line.
    private func handleSendFailure(_ failure: PopupSendFailure) {
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            switch presentChatSendFailure(code: failure.code, runtime: self.runtime.state) {
            case .stillLoading:
                self.turns.clearRefusal()
                if self.runtime.state != .loading {
                    self.runtime = RuntimeStatus(
                        state: .loading,
                        modelId: self.runtime.modelId ?? defaultModelID
                    )
                    self.turns.noteRuntime(.loading)
                }
                self.confirmRuntime()
            case .notReady:
                self.turns.setRefusal(.notReady)
            case .failed:
                self.log("send: \(failure.description)")
            }
        }
    }

    private func confirmRuntime() {
        guard let runtimeSupervisor else { return }
        Task { [weak self] in
            let status = await runtimeSupervisor.confirm()
            self?.applySupervisorStatus(status)
        }
    }

    private func log(_ message: String) {
        logShell(message)
    }
}

/// Replies to `.terminateLater` once. Both shutdown and the backstop call it.
private final class TerminationReply: @unchecked Sendable {
    private let lock = NSLock()
    private var sent = false

    func send(reason: String) {
        guard mark() else { return }
        logShell("termination reply \(reason)")
        TerminationHop.performDuringTerminate {
            NSApp.reply(toApplicationShouldTerminate: true)
        }
    }

    private func mark() -> Bool {
        lock.lock()
        defer { lock.unlock() }
        if sent { return false }
        sent = true
        return true
    }
}

/// `DispatchSemaphore` is not `Sendable`. Quit waits on the main thread
/// while the runtime actor stops the server.
private final class ExitGate: @unchecked Sendable {
    private let semaphore = DispatchSemaphore(value: 0)

    func signal() {
        semaphore.signal()
    }

    func wait() {
        _ = semaphore.wait(timeout: .now() + 15)
    }
}
