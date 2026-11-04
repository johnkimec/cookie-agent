import AppKit
import CookieCore
import Darwin
import SwiftUI

@main
struct CookieApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var delegate

    init() {
        QuitSignals.install()
        NSApplication.shared.setActivationPolicy(.accessory)
    }

    var body: some Scene {
        MenuBarExtra {
            MenuContent(model: delegate.model)
        } label: {
            MenuGlyphLabel(model: delegate.model)
        }
        .menuBarExtraStyle(.menu)
    }
}

/// Retains the signal sources for the process lifetime. Installed from
/// `CookieApp.init`, before the delegate exists, so a SIGTERM during launch
/// is not delivered in the window where it would be ignored.
enum QuitSignals {
    private static let queue = DispatchQueue(label: "com.johnkimec.cookie-agent.signals")
    /// A class, not a `static var`: Swift 6 rejects nonisolated global
    /// mutable state. The instance is what keeps the sources alive.
    private final class Holder: @unchecked Sendable {
        var sources: [DispatchSourceSignal] = []
        var installed = false
    }
    private static let holder = Holder()

    static func install() {
        if holder.installed { return }
        holder.installed = true
        for sig in [SIGTERM, SIGINT] {
            signal(sig, SIG_IGN)
            let source = DispatchSource.makeSignalSource(signal: sig, queue: queue)
            source.setEventHandler {
                TerminationHop.perform {
                    NSApp.terminate(nil)
                }
            }
            source.resume()
            holder.sources.append(source)
        }
        let pid = ProcessInfo.processInfo.processIdentifier
        writeShellPid(pid)
        logShell("signals installed pid=\(pid)")
    }
}

final class AppDelegate: NSObject, NSApplicationDelegate {
    let model = AppModel()
    private var popup: PopupController?
    private var hotkey: HotkeyCenter?

    override init() {
        super.init()
        QuitSignals.install()
    }

    func applicationWillFinishLaunching(_ notification: Notification) {
        QuitSignals.install()
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        let renderingPreviews = MainActor.assumeIsolated {
            self.renderPopupPreviewsIfRequested()
        }
        if renderingPreviews {
            return
        }
        NSApp.setActivationPolicy(.accessory)
        let popup = PopupController(model: model)
        self.popup = popup
        popup.install()
        model.onPopup = { open in
            popup.apply(open: open)
        }
        model.onLayout = {
            popup.relayout()
        }
        let hotkey = HotkeyCenter { [weak model] in
            DispatchQueue.main.async {
                model?.togglePopup()
            }
        }
        self.hotkey = hotkey
        hotkey.install()
        model.start()
    }

    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        model.prepareTermination()
        return .terminateLater
    }

    func applicationWillTerminate(_ notification: Notification) {
        model.stopCore()
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        false
    }

    /// Writes the three popup PNGs and exits. Returns false when the
    /// environment variable is unset so a normal launch continues.
    @MainActor
    private func renderPopupPreviewsIfRequested() -> Bool {
        guard let raw = ProcessInfo.processInfo.environment["COOKIE_RENDER_POPUP_PREVIEWS"],
              !raw.isEmpty else {
            return false
        }
        let directory = URL(fileURLWithPath: raw, isDirectory: true)
        do {
            try PopupPreviewRenderer.write(to: directory)
        } catch {
            fputs("popup previews: \(error)\n", stderr)
            exit(1)
        }
        exit(0)
    }
}
