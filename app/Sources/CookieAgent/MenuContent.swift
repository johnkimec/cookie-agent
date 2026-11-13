import AppKit
import CookieCore
import SwiftUI

struct MenuContent: View {
    @ObservedObject var model: AppModel

    var body: some View {
        let _ = model.runtime
        let _ = model.conversation.replyInFlight
        Button(model.statusText) {}
            .disabled(true)
            .accessibilityIdentifier(CookieAX.menuStatus)
            .accessibilityLabel(model.statusText)
        Divider()
        Button(CookieCopy.ask) {
            model.openPopup()
        }
        .keyboardShortcut(.space, modifiers: .option)
        .accessibilityIdentifier(CookieAX.menuAsk)
        .accessibilityLabel(CookieCopy.ask)
        Divider()
        Button(CookieCopy.localOnly) {}
            .accessibilityIdentifier(CookieAX.menuLocalOnly)
            .accessibilityLabel(CookieCopy.localOnly)
        Divider()
        Button(CookieCopy.quit) {
            model.quit()
        }
        .keyboardShortcut("q", modifiers: .command)
        .accessibilityIdentifier(CookieAX.menuQuit)
        .accessibilityLabel(CookieCopy.quit)
    }
}

struct MenuGlyphLabel: View {
    @ObservedObject var model: AppModel

    var body: some View {
        let glyph = menuGlyph(
            runtime: model.runtime.state,
            popupOpen: model.popupOpen,
            replyInFlight: model.conversation.replyInFlight
        )
        let label = menuVoiceOver(glyph)
        Image(nsImage: CookieGlyph.image(for: CookiePose(menu: glyph)))
            .resizable()
            .frame(width: 18, height: 18)
            .accessibilityLabel(label)
            .accessibilityIdentifier(CookieAX.menuIcon)
            .onAppear {
                StatusItemAccess.apply(label: label)
            }
            .onChange(of: label) { _, _ in
                StatusItemAccess.apply(label: label)
            }
    }
}

enum StatusItemAccess {
    static func apply(label: String) {
        DispatchQueue.main.async {
            guard let button = findButton() else { return }
            button.setAccessibilityIdentifier(CookieAX.menuIcon)
            button.setAccessibilityLabel(label)
        }
    }

    static func findButton() -> NSStatusBarButton? {
        for window in NSApp.windows {
            let name = String(describing: type(of: window))
            guard name.contains("StatusBar") else { continue }
            if let button = findButton(in: window.contentView) {
                return button
            }
        }
        return nil
    }

    private static func findButton(in view: NSView?) -> NSStatusBarButton? {
        guard let view else { return nil }
        if let button = view as? NSStatusBarButton { return button }
        for subview in view.subviews {
            if let button = findButton(in: subview) { return button }
        }
        return nil
    }
}
