import AppKit
import CookieCore
import CookieProtocol
import Foundation
import SwiftUI

/// Offscreen popup renders for the macOS CI artifact. Set
/// `COOKIE_RENDER_POPUP_PREVIEWS` to a directory and the app writes
/// `popup-empty.png`, `popup-short.png`, and `popup-long.png`, then exits
/// before the core starts.
@MainActor
enum PopupPreviewRenderer {
    static func write(to directory: URL) throws {
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        try render(kind: "empty", model: emptyModel(), to: directory.appendingPathComponent("popup-empty.png"))
        try render(kind: "short", model: shortModel(), to: directory.appendingPathComponent("popup-short.png"))
        try render(kind: "long", model: longModel(), to: directory.appendingPathComponent("popup-long.png"))
    }

    private static func render(kind: String, model: AppModel, to url: URL) throws {
        let height = PopupMetrics.panelHeight(
            turnTexts: model.conversation.turns.map(\.text),
            draft: model.conversation.draft,
            showsNotice: false
        )
        let view = PopupRoot(model: model)
            .frame(width: PopupLayout.width, height: height, alignment: .bottom)
            .background(Color(nsColor: .windowBackgroundColor))
        let renderer = ImageRenderer(content: view)
        renderer.scale = 2
        guard let image = renderer.nsImage else {
            throw PreviewError("ImageRenderer produced no image for \(kind)")
        }
        guard let tiff = image.tiffRepresentation,
              let rep = NSBitmapImageRep(data: tiff),
              let png = rep.representation(using: .png, properties: [:]) else {
            throw PreviewError("could not encode \(kind)")
        }
        try png.write(to: url)
        print("popup preview \(kind) \(Int(height.rounded()))pt \(url.path)")
    }

    private static func emptyModel() -> AppModel {
        let model = AppModel()
        model.runtime = RuntimeStatus(state: .up, modelId: "preview")
        return model
    }

    private static func shortModel() -> AppModel {
        let model = emptyModel()
        model.conversation = PopupConversation(turns: [
            ChatTurn(index: 0, role: .you, text: "what's the setup time?", streaming: false, badge: nil),
            ChatTurn(index: 0, role: .cookie, text: "2.1 ns min at 3.3 V.", streaming: false, badge: nil),
        ])
        return model
    }

    private static func longModel() -> AppModel {
        let model = emptyModel()
        let line = "The transcript grows until the panel reaches its maximum height and then scrolls.\n"
        model.conversation = PopupConversation(turns: [
            ChatTurn(index: 0, role: .you, text: "tell me more", streaming: false, badge: nil),
            ChatTurn(index: 0, role: .cookie, text: String(repeating: line, count: 16), streaming: false, badge: nil),
        ])
        return model
    }
}

private struct PreviewError: Error, CustomStringConvertible {
    var description: String
    init(_ description: String) { self.description = description }
}
