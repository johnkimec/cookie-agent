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
        Image(nsImage: GlyphImage.make(glyph))
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

enum GlyphImage {
    static func make(_ glyph: MenuGlyph) -> NSImage {
        let image = NSImage(size: NSSize(width: 18, height: 18), flipped: false) { _ in
            NSColor.black.set()
            let head = NSRect(x: 4.5, y: 3.5, width: 9, height: 9)
            let path = NSBezierPath(ovalIn: head)
            path.lineWidth = 1.35
            switch glyph {
            case .loading:
                path.setLineDash([1.15, 1.35], count: 2, phase: 0)
                path.stroke()
            case .down:
                path.stroke()
                ears(raised: false)
                let slash = NSBezierPath()
                slash.move(to: NSPoint(x: 3, y: 2))
                slash.line(to: NSPoint(x: 15, y: 16))
                slash.lineWidth = 1.35
                slash.stroke()
            case .listening:
                path.stroke()
                ears(raised: true)
            case .thinking:
                path.stroke()
                ears(raised: false)
                NSBezierPath(ovalIn: NSRect(x: 12.2, y: 13.2, width: 2.1, height: 2.1)).fill()
                NSBezierPath(ovalIn: NSRect(x: 15, y: 14.6, width: 1.7, height: 1.7)).fill()
            case .idle:
                path.stroke()
                ears(raised: false)
            }
            return true
        }
        image.isTemplate = true
        return image
    }

    private static func ears(raised: Bool) {
        let y: CGFloat = raised ? 8.5 : 1.6
        let left = NSBezierPath(ovalIn: NSRect(x: 2.2, y: y, width: 3.2, height: 6.4))
        let right = NSBezierPath(ovalIn: NSRect(x: 12.6, y: y, width: 3.2, height: 6.4))
        left.lineWidth = 1.2
        right.lineWidth = 1.2
        left.stroke()
        right.stroke()
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
