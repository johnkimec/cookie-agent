import AppKit
import CookieCore
import SwiftUI

@main
struct CookieApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var delegate

    init() {
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

final class AppDelegate: NSObject, NSApplicationDelegate {
    let model = AppModel()
    private var popup: PopupController?
    private var hotkey: HotkeyCenter?

    func applicationDidFinishLaunching(_ notification: Notification) {
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
}
