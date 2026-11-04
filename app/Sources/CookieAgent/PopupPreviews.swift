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
        let box = PreviewBox(height)
        let host = NSHostingView(rootView: PreviewPanel(model: model, box: box))
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
        // The SwiftUI frame is what cacheDisplay records. Leaving it at the
        // line estimate made popup-three.png 303 pt after the panel had
        // already settled near 248.
        box.height = fitted
        host.frame = NSRect(x: 0, y: 0, width: PopupLayout.width, height: fitted)
        window.setContentSize(NSSize(width: PopupLayout.width, height: fitted))
        let settleBy = Date().addingTimeInterval(1)
        while Date() < settleBy {
            host.layoutSubtreeIfNeeded()
            ReplyTextLayout.constrain(host)
            if abs(host.bounds.height - fitted) < 2 { break }
            RunLoop.main.run(mode: .default, before: Date().addingTimeInterval(0.05))
        }
        host.display()
        window.displayIfNeeded()
        guard let rep = host.bitmapImageRepForCachingDisplay(in: host.bounds) else {
            throw PreviewError("no bitmap for \(kind)")
        }
        host.cacheDisplay(in: host.bounds, to: rep)
        let scale = max(1, CGFloat(rep.pixelsWide) / max(host.bounds.width, 1))
        let bitmapHeight = CGFloat(rep.pixelsHigh) / scale
        guard abs(bitmapHeight - fitted) < 2 else {
            throw PreviewError("\(kind) bitmap \(bitmapHeight)pt wanted \(fitted)pt")
        }
        guard let png = rep.representation(using: .png, properties: [:]) else {
            throw PreviewError("could not encode \(kind)")
        }
        try png.write(to: url)
        print("popup preview \(kind) \(Int(bitmapHeight.rounded()))pt \(url.path)")
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
        let deadline = Date().addingTimeInterval(8)
        while Date() < deadline {
            host.layoutSubtreeIfNeeded()
            ReplyTextLayout.constrain(host)
            let field = view(identified: CookieAX.popupInput, in: host) != nil
            let button = view(identified: CookieAX.popupSend, in: host) != nil
            let textReady = needle == nil || containsText(needle ?? "", in: host)
            let copies = occurrenceCount("The transcript grows", in: host)
            if field, button, textReady, heightReady(kind: kind, model: model, copies: copies) {
                return
            }
            // `.common` is kCFRunLoopCommonModes, which CFRunLoopRunSpecific
            // rejects, so MarkdownView's parse task never runs.
            RunLoop.main.run(mode: .default, before: Date().addingTimeInterval(0.05))
        }
        throw PreviewError(
            "\(kind) preview did not draw (measured \(model.measuredTranscriptHeight))"
        )
    }

    /// The long reply's first line is enough to leave the wait, and that
    /// measurement is still one short block. Wait until every repeated line
    /// is in a text view and the panel is at the cap.
    private static func heightReady(kind: String, model: AppModel, copies: Int) -> Bool {
        if kind == "empty" { return true }
        guard model.measuredTranscriptHeight > 1 else { return false }
        guard kind == "long" else { return true }
        guard copies >= 16 else { return false }
        let fitted = PopupMetrics.panelHeight(
            turnTexts: model.conversation.turns.map(\.text),
            draft: model.conversation.draft,
            showsNotice: false,
            measuredTranscript: model.measuredTranscriptHeight
        )
        return abs(fitted - PopupLayout.maxHeight) <= 1
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

    private static func occurrenceCount(_ needle: String, in view: NSView) -> Int {
        var count = 0
        if let text = view as? NSTextView {
            var search = text.string.startIndex
            while let found = text.string[search...].range(of: needle) {
                count += 1
                search = found.upperBound
            }
        }
        for subview in view.subviews {
            count += occurrenceCount(needle, in: subview)
        }
        return count
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

@MainActor
private final class PreviewBox: ObservableObject {
    @Published var height: CGFloat
    init(_ height: CGFloat) { self.height = height }
}

private struct PreviewPanel: View {
    var model: AppModel
    @ObservedObject var box: PreviewBox

    var body: some View {
        PopupRoot(model: model)
            .frame(width: PopupLayout.width, height: box.height, alignment: .bottom)
            .background(Color(nsColor: .windowBackgroundColor))
    }
}

private struct PreviewError: Error, CustomStringConvertible {
    var description: String
    init(_ description: String) { self.description = description }
}
