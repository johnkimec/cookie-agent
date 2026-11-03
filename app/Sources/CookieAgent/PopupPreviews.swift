import AppKit
import CookieCore
import CookieProtocol
import Foundation
import SwiftUI

/// Offscreen popup renders for the macOS CI artifact. Set
/// `COOKIE_RENDER_POPUP_PREVIEWS` to a directory and the app writes
/// `popup-empty.png`, `popup-short.png`, `popup-three.png`, and `popup-long.png`, then exits
/// before the core starts.
///
/// `ImageRenderer` draws every `NSViewRepresentable` as a yellow prohibited
/// sign, so the field, the send button, and the markdown transcript never
/// appeared. These renders host `PopupRoot` in an offscreen window and
/// snapshot it with `cacheDisplay`, which draws the AppKit views.
@MainActor
enum PopupPreviewRenderer {
    static func write(to directory: URL) throws {
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        try render(kind: "empty", model: emptyModel(), to: directory.appendingPathComponent("popup-empty.png"))
        try render(kind: "short", model: shortModel(), to: directory.appendingPathComponent("popup-short.png"))
        try render(kind: "three", model: threeModel(), to: directory.appendingPathComponent("popup-three.png"))
        try render(kind: "long", model: longModel(), to: directory.appendingPathComponent("popup-long.png"))
    }

    private static func render(kind: String, model: AppModel, to url: URL) throws {
        let height = PopupMetrics.panelHeight(
            turnTexts: model.conversation.turns.map(\.text),
            draft: model.conversation.draft,
            showsNotice: false
        )
        let host = NSHostingView(rootView: PreviewPanel(model: model, height: height))
        host.sizingOptions = []
        host.frame = NSRect(x: 0, y: 0, width: PopupLayout.width, height: height)
        let window = NSWindow(
            contentRect: host.frame,
            styleMask: [.borderless],
            backing: .buffered,
            defer: false
        )
        window.isReleasedWhenClosed = false
        window.setFrameOrigin(NSPoint(x: -20_000, y: -20_000))
        window.contentView = host
        defer { window.close() }
        window.orderBack(nil)
        window.displayIfNeeded()
        try waitUntilDrawn(kind: kind, in: host, model: model)
        let measured = model.measuredTranscriptHeight
        let fitted = PopupMetrics.panelHeight(
            turnTexts: model.conversation.turns.map(\.text),
            draft: model.conversation.draft,
            showsNotice: false,
            measuredTranscript: measured > 1 ? measured : nil
        )
        host.frame = NSRect(x: 0, y: 0, width: PopupLayout.width, height: fitted)
        window.setContentSize(NSSize(width: PopupLayout.width, height: fitted))
        host.layoutSubtreeIfNeeded()
        ReplyTextLayout.constrain(host)
        host.display()
        window.displayIfNeeded()
        guard let rep = host.bitmapImageRepForCachingDisplay(in: host.bounds) else {
            throw PreviewError("no bitmap for \(kind)")
        }
        host.cacheDisplay(in: host.bounds, to: rep)
        guard let png = rep.representation(using: .png, properties: [:]) else {
            throw PreviewError("could not encode \(kind)")
        }
        try png.write(to: url)
        print("popup preview \(kind) \(Int(fitted.rounded()))pt \(url.path)")
    }

    /// Markdown parses in `.task`. A single layout pass snapshots an empty
    /// transcript, so spin the run loop until the cookie text is in a text view.
    private static func waitUntilDrawn(kind: String, in host: NSView, model: AppModel) throws {
        let needle: String? = switch kind {
        case "empty": nil
        case "short": "END-OF-REPLY-m1-popup"
        case "three": "pass that along"
        default: "The transcript grows"
        }
        let deadline = Date().addingTimeInterval(5)
        while Date() < deadline {
            host.layoutSubtreeIfNeeded()
            ReplyTextLayout.constrain(host)
            let field = view(identified: CookieAX.popupInput, in: host) != nil
            let button = view(identified: CookieAX.popupSend, in: host) != nil
            let measured = kind == "empty" || model.measuredTranscriptHeight > 1
            let textReady = needle == nil || containsText(needle ?? "", in: host)
            if field, button, measured, textReady {
                return
            }
            // `.common` is kCFRunLoopCommonModes, which CFRunLoopRunSpecific
            // rejects, so MarkdownView's parse task never runs.
            RunLoop.main.run(mode: .default, before: Date().addingTimeInterval(0.05))
        }
        throw PreviewError("\(kind) preview did not draw its controls")
    }

    private static func view(identified identifier: String, in root: NSView) -> NSView? {
        if root.accessibilityIdentifier() == identifier { return root }
        for subview in root.subviews {
            if let found = view(identified: identifier, in: subview) { return found }
        }
        return nil
    }

    private static func containsText(_ needle: String, in view: NSView) -> Bool {
        if let text = view as? NSTextView, text.string.contains(needle) { return true }
        return view.subviews.contains { containsText(needle, in: $0) }
    }

    private static func emptyModel() -> AppModel {
        let model = AppModel()
        model.runtime = RuntimeStatus(state: .up, modelId: "preview")
        return model
    }

    private static func shortModel() -> AppModel {
        let model = emptyModel()
        model.conversation = PopupConversation(turns: [
            ChatTurn(index: 0, role: .you, text: "hello from drive-mac", streaming: false, badge: nil),
            ChatTurn(
                index: 0,
                role: .cookie,
                text: "Einstein is best known for relativity. END-OF-REPLY-m1-popup",
                streaming: false,
                badge: CookieCopy.onDevice
            ),
        ])
        return model
    }

    private static func threeModel() -> AppModel {
        let model = emptyModel()
        model.conversation = PopupConversation(turns: [
            ChatTurn(index: 0, role: .you, text: "hey cookie!", streaming: false, badge: nil),
            ChatTurn(index: 0, role: .cookie, text: "Hi! How can I help you?", streaming: false, badge: CookieCopy.onDevice),
            ChatTurn(index: 1, role: .you, text: "say something long", streaming: false, badge: nil),
            ChatTurn(
                index: 1,
                role: .cookie,
                text: "The concept of TPS (Transactions per second) is how many commits a database finishes.",
                streaming: false,
                badge: CookieCopy.onDevice
            ),
            ChatTurn(index: 2, role: .you, text: "this ui is kinda chopped", streaming: false, badge: nil),
            ChatTurn(
                index: 2,
                role: .cookie,
                text: "I'm sorry to hear that. I'll pass that along.",
                streaming: false,
                badge: CookieCopy.onDevice
            ),
        ])
        return model
    }

    private static func longModel() -> AppModel {
        let model = emptyModel()
        let line = "The transcript grows until the panel reaches its maximum height and then scrolls.\n"
        model.conversation = PopupConversation(turns: [
            ChatTurn(index: 0, role: .you, text: "tell me more", streaming: false, badge: nil),
            ChatTurn(index: 0, role: .cookie, text: String(repeating: line, count: 16), streaming: false, badge: CookieCopy.onDevice),
        ])
        return model
    }
}

private struct PreviewPanel: View {
    var model: AppModel
    var height: CGFloat

    var body: some View {
        PopupRoot(model: model)
            .frame(width: PopupLayout.width, height: height, alignment: .bottom)
            .background(Color(nsColor: .windowBackgroundColor))
    }
}

private struct PreviewError: Error, CustomStringConvertible {
    var description: String
    init(_ description: String) { self.description = description }
}
