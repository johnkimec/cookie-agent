import AppKit
import SwiftUI
import XCTest
@testable import CookieAgent
@testable import CookieCore
@testable import CookieProtocol

/// Hosts the real popup. A tall proposal used to stretch the input row and
/// the send button; a long single line used to stay one line tall and clip.
@MainActor
final class PopupInputRowTests: XCTestCase {
    func testInputRowStaysCollapsedWhenThePanelIsTall() throws {
        for (name, model) in [
            ("empty", previewModel(turns: [])),
            ("short", previewModel(turns: shortTurns)),
            ("long", previewModel(turns: longTurns)),
        ] {
            let measured = try layout(model: model, height: 1200)
            XCTAssertGreaterThan(measured.row, 40, name)
            XCTAssertLessThanOrEqual(measured.row, 72, name)
            XCTAssertLessThanOrEqual(measured.buttonHeight, 36, name)
            XCTAssertLessThan(measured.buttonWidth, 80, name)
        }
    }

    func testYouReplyWrapsTheSentinel() throws {
        let text = "Einstein is best known for relativity. END-OF-REPLY-m1-popup"
        let one = try turnHeight(role: .you, text: "Hi")
        let wrapped = try turnHeight(role: .you, text: text)
        XCTAssertGreaterThan(wrapped, one + 8)
        XCTAssertLessThan(wrapped, 120)
    }

    func testCookieMarkdownAndInlineMathWrap() throws {
        let plain = "Einstein is best known for relativity. END-OF-REPLY-m1-popup"
        let math = "Einstein is best known for relativity, and \\(a^2 + b^2\\) still holds. END-OF-REPLY-m1-popup"
        let one = try turnHeight(role: .cookie, text: "Hi")
        let wrapped = try turnHeight(role: .cookie, text: plain)
        let withMath = try turnHeight(role: .cookie, text: math)
        XCTAssertGreaterThan(wrapped, one + 8, "markdown paragraph wraps a long line")
        XCTAssertGreaterThan(withMath, one + 8, "inline LaTeX stays in the wrapping paragraph")
        XCTAssertLessThan(wrapped, 160)
        XCTAssertLessThan(withMath, 200)
    }

    private func previewModel(turns: [ChatTurn]) -> AppModel {
        let model = AppModel()
        model.runtime = RuntimeStatus(state: .up, modelId: "preview")
        model.conversation = PopupConversation(turns: turns)
        return model
    }

    private var shortTurns: [ChatTurn] {
        [
            ChatTurn(index: 0, role: .you, text: "hello from drive-mac", streaming: false, badge: nil),
            ChatTurn(
                index: 0,
                role: .cookie,
                text: "Einstein is best known for relativity. END-OF-REPLY-m1-popup",
                streaming: false,
                badge: nil
            ),
        ]
    }

    private var longTurns: [ChatTurn] {
        let line = "The transcript grows until the panel reaches its maximum height and then scrolls.\n"
        return [
            ChatTurn(index: 0, role: .you, text: "tell me more", streaming: false, badge: nil),
            ChatTurn(index: 0, role: .cookie, text: String(repeating: line, count: 16), streaming: false, badge: nil),
        ]
    }

    private struct Measured {
        var row: CGFloat
        var buttonHeight: CGFloat
        var buttonWidth: CGFloat
    }

    private final class Probe {
        var row: CGFloat = 0
    }

    private struct Hosted: View {
        var model: AppModel
        var height: CGFloat
        var probe: Probe

        var body: some View {
            PopupRoot(model: model)
                .frame(width: PopupLayout.width, height: height, alignment: .bottom)
                .onPreferenceChange(InputRowHeightKey.self) { probe.row = $0 }
        }
    }

    private func layout(model: AppModel, height: CGFloat) throws -> Measured {
        let probe = Probe()
        let host = NSHostingView(rootView: Hosted(model: model, height: height, probe: probe))
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
        let deadline = Date().addingTimeInterval(1.5)
        var button: NSView?
        while Date() < deadline {
            host.layoutSubtreeIfNeeded()
            button = find(CookieAX.popupSend, in: host)
            if probe.row > 1, button != nil { break }
            RunLoop.main.run(mode: .common, before: Date().addingTimeInterval(0.05))
        }
        let control = try XCTUnwrap(button, "send button did not appear")
        XCTAssertGreaterThan(probe.row, 1)
        return Measured(row: probe.row, buttonHeight: control.bounds.height, buttonWidth: control.bounds.width)
    }

    private func turnHeight(role: TurnRole, text: String) throws -> CGFloat {
        // The transcript pads 16 pt, so the reply column is the same width
        // that clipped the sentinel at 452×20 on the Mac.
        let row = TurnRow(turn: ChatTurn(index: 0, role: role, text: text, streaming: false, badge: nil))
            .padding(.horizontal, 16)
            .frame(width: PopupLayout.width, alignment: .topLeading)
        let host = NSHostingView(rootView: row)
        host.sizingOptions = [.intrinsicContentSize]
        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: PopupLayout.width, height: 400),
            styleMask: [.borderless],
            backing: .buffered,
            defer: false
        )
        window.isReleasedWhenClosed = false
        window.contentView = host
        host.frame = window.contentView?.bounds ?? .zero
        defer { window.close() }
        window.orderBack(nil)
        let deadline = Date().addingTimeInterval(3)
        var height = host.fittingSize.height
        while Date() < deadline {
            host.layoutSubtreeIfNeeded()
            height = host.fittingSize.height
            if role == .you || (height > 1 && contains(text, in: host)) { break }
            RunLoop.main.run(mode: .common, before: Date().addingTimeInterval(0.05))
        }
        XCTAssertGreaterThan(height, 1)
        return height
    }

    private func contains(_ needle: String, in view: NSView) -> Bool {
        if let text = view as? NSTextView, text.string.contains(needle) { return true }
        return view.subviews.contains { contains(needle, in: $0) }
    }

    private func find(_ identifier: String, in view: NSView) -> NSView? {
        if view.accessibilityIdentifier() == identifier { return view }
        for subview in view.subviews {
            if let found = find(identifier, in: subview) { return found }
        }
        return nil
    }
}
