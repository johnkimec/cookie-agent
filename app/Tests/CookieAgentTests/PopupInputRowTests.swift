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
        let text = "Einstein is best known for relativity. END-OF-REPLY-m1-popup. "
            + "This second sentence is wider than the popup column and has to wrap."
        let one = try turnHeight(role: .you, text: "Hi")
        let wrapped = try turnHeight(role: .you, text: text)
        XCTAssertGreaterThan(wrapped, one + 8)
        XCTAssertLessThan(wrapped, 180)
    }

    func testOnDeviceBadgeHugsItsLabel() throws {
        let text = "The concept of TPS (Transactions per second) is how many commits a database finishes."
        let turn = ChatTurn(index: 0, role: .cookie, text: text, streaming: false, badge: CookieCopy.onDevice)
        let row = TurnRow(turn: turn)
            .padding(.horizontal, 16)
            .frame(width: PopupLayout.width, alignment: .topLeading)
        let host = NSHostingView(rootView: row)
        host.sizingOptions = [.intrinsicContentSize]
        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: PopupLayout.width, height: 160),
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
        var badge: NSView?
        var reply: NSView?
        while Date() < deadline {
            host.layoutSubtreeIfNeeded()
            badge = find(CookieAX.badge(0), in: host)
            reply = find(CookieAX.turnCookie(0), in: host)
            if badge != nil, reply != nil { break }
            RunLoop.main.run(mode: .common, before: Date().addingTimeInterval(0.05))
        }
        let capsule = try XCTUnwrap(badge, "on-device badge did not appear")
        let replyBox = try XCTUnwrap(reply, "cookie reply did not appear")
        XCTAssertGreaterThan(capsule.bounds.width, 36, "the label is visible")
        XCTAssertLessThan(capsule.bounds.width, 140, "the capsule hugs the on-device label")
        XCTAssertLessThan(capsule.bounds.height, 32)
        XCTAssertGreaterThan(replyBox.bounds.width, capsule.bounds.width * 2, "the badge does not take the reply column")
    }

    func testThreeShortExchangesDoNotFillTheCap() throws {
        let lines = [
            "hey cookie!",
            "Hi! How can I help you?",
            "say something long",
            "The concept of TPS (Transactions per second) is how many commits a database finishes.",
            "this ui is kinda chopped",
            "I'm sorry to hear that. I'll pass that along.",
        ]
        var turns: [ChatTurn] = []
        for (offset, line) in lines.enumerated() {
            let role: TurnRole = offset.isMultiple(of: 2) ? .you : .cookie
            let index = offset / 2
            turns.append(ChatTurn(
                index: index,
                role: role,
                text: line,
                streaming: false,
                badge: role == .cookie ? CookieCopy.onDevice : nil
            ))
        }
        let model = previewModel(turns: turns)
        let probe = Probe()
        let host = NSHostingView(rootView: Hosted(model: model, height: 1200, probe: probe))
        host.sizingOptions = [.intrinsicContentSize]
        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: PopupLayout.width, height: 1200),
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
        while Date() < deadline {
            host.layoutSubtreeIfNeeded()
            if probe.row > 1, probe.transcript > 40 { break }
            RunLoop.main.run(mode: .common, before: Date().addingTimeInterval(0.05))
        }
        XCTAssertLessThanOrEqual(probe.row, 72)
        XCTAssertGreaterThan(probe.transcript, 40)
        XCTAssertLessThan(probe.transcript, 260, "three short exchanges do not stretch the transcript to the cap")
        let panel = probe.transcript + probe.row + 1
        XCTAssertLessThan(panel, PopupLayout.maxHeight - 20)
    }

    func testCookieMarkdownAndInlineMathWrap() throws {
        let plain = "Einstein is best known for relativity. END-OF-REPLY-m1-popup. "
            + "This second sentence is wider than the popup column and has to wrap."
        let math = "Einstein is best known for relativity, and \\(a^2 + b^2\\) still holds. "
            + "END-OF-REPLY-m1-popup. This second sentence is wider than the popup column and has to wrap."
        let one = try markdownHeight("Hi")
        let wrapped = try markdownHeight(plain)
        let withMath = try markdownHeight(math)
        XCTAssertGreaterThan(wrapped, one + 8, "markdown paragraph wraps a long line")
        XCTAssertGreaterThan(withMath, one + 8, "inline LaTeX stays in the wrapping paragraph")
        XCTAssertLessThan(wrapped, 280)
        XCTAssertLessThan(withMath, 320)
    }

    /// Hosts the real popup. An isolated `TurnRow` collapses `MarkdownView`
    /// before its `.task` parses, so the text view never appears.
    private func markdownHeight(_ text: String) throws -> CGFloat {
        let turns = [
            ChatTurn(index: 0, role: .you, text: "hello", streaming: false, badge: nil),
            ChatTurn(index: 0, role: .cookie, text: text, streaming: false, badge: CookieCopy.onDevice),
        ]
        let model = previewModel(turns: turns)
        let probe = Probe()
        let host = NSHostingView(rootView: Hosted(model: model, height: 800, probe: probe))
        host.sizingOptions = []
        host.frame = NSRect(x: 0, y: 0, width: PopupLayout.width, height: 800)
        let window = NSWindow(
            contentRect: host.frame,
            styleMask: [.borderless],
            backing: .buffered,
            defer: false
        )
        window.isReleasedWhenClosed = false
        window.contentView = host
        defer { window.close() }
        window.makeKeyAndOrderFront(nil)
        let needle = text.contains("END-OF-REPLY") ? "END-OF-REPLY" : text
        let deadline = Date().addingTimeInterval(5)
        var height: CGFloat = 0
        while Date() < deadline {
            host.layoutSubtreeIfNeeded()
            window.displayIfNeeded()
            if let used = laidOutTextHeight(needle, in: host) {
                height = used
                break
            }
            RunLoop.main.run(mode: .common, before: Date().addingTimeInterval(0.05))
        }
        XCTAssertGreaterThan(height, 1, "markdown text view missing, saw \(textDump(host))")
        return height
    }

    private func textDump(_ view: NSView) -> String {
        var lines: [String] = []
        func walk(_ node: NSView) {
            if let text = node as? NSTextView, !text.string.isEmpty {
                lines.append(String(text.string.prefix(80)))
            }
            node.subviews.forEach(walk)
        }
        walk(view)
        return lines.isEmpty ? "no text views" : lines.joined(separator: " | ")
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
        var transcript: CGFloat = 0
    }

    private struct Hosted: View {
        var model: AppModel
        var height: CGFloat
        var probe: Probe

        var body: some View {
            PopupRoot(model: model)
                .frame(width: PopupLayout.width, height: height, alignment: .bottom)
                .onPreferenceChange(InputRowHeightKey.self) { probe.row = $0 }
                .onPreferenceChange(TranscriptFrameKey.self) { probe.transcript = $0.height }
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
        // Intrinsic sizing collapses MarkdownView to zero before `.task`
        // parses, so the cookie path keeps the window's width and height.
        host.sizingOptions = role == .you ? [.intrinsicContentSize] : []
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
        let identifier = role == .you ? CookieAX.turnYou(0) : CookieAX.turnCookie(0)
        // displayText may insert a break inside a long token. The first 12
        // characters of END-OF-REPLY stay contiguous.
        let needle = text.contains("END-OF-REPLY") ? "END-OF-REPLY" : String(text.prefix(12))
        let deadline = Date().addingTimeInterval(role == .you ? 1 : 5)
        var height: CGFloat = 0
        var previous: CGFloat = 0
        var stable = 0
        while Date() < deadline {
            host.layoutSubtreeIfNeeded()
            if role == .cookie {
                if let used = laidOutTextHeight(needle, in: host) {
                    height = used
                }
            } else if let box = find(identifier, in: host) {
                height = box.bounds.height
            }
            if height > 1, abs(height - previous) < 0.5 {
                stable += 1
                if stable >= 2 { break }
            } else {
                stable = 0
            }
            previous = height
            RunLoop.main.run(mode: .common, before: Date().addingTimeInterval(0.05))
        }
        XCTAssertGreaterThan(height, 1)
        return height
    }

    private func laidOutTextHeight(_ needle: String, in view: NSView) -> CGFloat? {
        if let text = view as? NSTextView,
           text.string.contains(needle),
           let container = text.textContainer,
           let manager = text.layoutManager {
            manager.ensureLayout(for: container)
            let used = manager.usedRect(for: container).height
            if used > 1 { return used }
        }
        for subview in view.subviews {
            if let found = laidOutTextHeight(needle, in: subview) { return found }
        }
        return nil
    }

    private func find(_ identifier: String, in view: NSView) -> NSView? {
        if view.accessibilityIdentifier() == identifier { return view }
        for subview in view.subviews {
            if let found = find(identifier, in: subview) { return found }
        }
        return nil
    }
}
