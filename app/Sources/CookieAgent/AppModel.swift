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

    let localOnly = true
    let conversationID = "conv-\(UUID().uuidString)"

    var onPopup: ((Bool) -> Void)?
    var onLayout: (() -> Void)?

    private var supervisor: CoreSupervisor?
    private var transport: ProcessTransport?
    private var eventsTask: Task<Void, Never>?
    private var lastToggle = Date.distantPast

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
        CookieCore.statusLine(runtime: runtime.state, modelID: runtime.modelId)
    }

    func start() {
        let launch = CoreLaunch.resolve(
            environment: ProcessInfo.processInfo.environment,
            currentDirectory: URL(fileURLWithPath: FileManager.default.currentDirectoryPath, isDirectory: true),
            temporaryDirectory: FileManager.default.temporaryDirectory,
            pid: ProcessInfo.processInfo.processIdentifier
        )
        do {
            try launch.prepareDataDirectory()
        } catch {
            log("data dir: \(error)")
        }
        log(
            "dataDir=\(launch.environment["COOKIE_DATA_DIR"] ?? "") port=\(launch.environment["COOKIE_LLAMA_PORT"] ?? "") core=\(launch.arguments.joined(separator: " ")) cwd=\(launch.workingDirectory.path)"
        )
        let transport = ProcessTransport(launch: launch)
        let supervisor = CoreSupervisor(transport: transport)
        self.transport = transport
        self.supervisor = supervisor
        let events = supervisor.events
        eventsTask = Task { [weak self] in
            for await event in events {
                self?.handle(event)
            }
        }
        Task { [weak self] in
            do {
                try await supervisor.start()
                _ = try await supervisor.initialize()
            } catch {
                self?.log("core: \(error)")
            }
        }
    }

    func stopCore() {
        transport?.stop()
        eventsTask?.cancel()
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
        var next = conversation
        next.noteOpen(at: Date())
        conversation = next
        if !popupOpen {
            popupOpen = true
            onPopup?(true)
        } else {
            onPopup?(true)
        }
        onLayout?()
    }

    func closePopup() {
        guard popupOpen else { return }
        var next = conversation
        next.noteClose(at: Date())
        conversation = next
        popupOpen = false
        onPopup?(false)
    }

    func submit() {
        let text = conversation.draft
        var next = conversation
        let action = next.prepareSend(runtime: runtime.state)
        conversation = next
        onLayout?()
        guard case .send(let body) = action else { return }
        guard let supervisor else {
            rollback(body)
            return
        }
        let conversationID = self.conversationID
        Task { [weak self] in
            do {
                let ack = try await supervisor.sendChat(conversationId: conversationID, text: body)
                self?.noteAck(ack.messageId)
            } catch {
                self?.log("send: \(error)")
                self?.rollback(body)
            }
        }
    }

    func recallLast() {
        var next = conversation
        next.recallLastUserText()
        conversation = next
        onLayout?()
    }

    func quit() {
        Task { [weak self] in
            try? await self?.supervisor?.shutdown()
            self?.transport?.stop()
            DispatchQueue.main.async {
                NSApp.terminate(nil)
            }
        }
    }

    private func noteAck(_ messageID: String) {
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            var next = self.conversation
            next.noteAck(messageID: messageID)
            self.conversation = next
        }
    }

    private func rollback(_ text: String) {
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            var next = self.conversation
            next.rollbackSend(restoredText: text)
            self.conversation = next
            self.onLayout?()
        }
    }

    private func handle(_ event: CoreEvent) {
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            var next = self.conversation
            switch event {
            case .runtime(let status):
                next.noteRuntime(status.state)
                self.conversation = next
                self.runtime = status
            case .delta(let delta):
                next.applyDelta(delta)
                self.conversation = next
            case .done(let done):
                next.applyDone(done)
                self.conversation = next
            case .rpcError, .decodeFailed:
                break
            }
            self.onLayout?()
        }
    }

    private func log(_ message: String) {
        let line = "cookie-shell: \(message)\n"
        FileHandle.standardError.write(Data(line.utf8))
    }
}
