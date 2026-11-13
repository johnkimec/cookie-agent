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

    func testStoredReplyEqualsTheOriginal() throws {
        let text = "Einstein is best known for relativity. END-OF-REPLY-m1-popup "
            + String(repeating: "Transaction", count: 6)
        for role in [TurnRole.you, .cookie] {
            let identifier = role == .you ? CookieAX.turnYou(0) : CookieAX.turnCookie(0)
            let row = TurnRow(turn: ChatTurn(index: 0, role: role, text: text, streaming: false, badge: nil))
                .frame(width: PopupLayout.width, alignment: .topLeading)
            let host = NSHostingView(rootView: row)
            host.frame = NSRect(x: 0, y: 0, width: PopupLayout.width, height: 200)
            let window = NSWindow(
                contentRect: host.frame,
                styleMask: [.borderless],
                backing: .buffered,
                defer: false
            )
            window.isReleasedWhenClosed = false
            window.contentView = host
            defer { window.close() }
            host.layoutSubtreeIfNeeded()
            let box = try XCTUnwrap(find(identifier, in: host))
            let value = box.accessibilityValue() as? String
            XCTAssertEqual(value, text)
            XCTAssertFalse(value?.contains("\u{200B}") ?? true)
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
            RunLoop.main.run(mode: .default, before: Date().addingTimeInterval(0.05))
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
        let deadline = Date().addingTimeInterval(5)
        while Date() < deadline {
            host.layoutSubtreeIfNeeded()
            ReplyTextLayout.constrain(host)
            if probe.row > 1, probe.transcript > 40, textContains("pass that along", in: host) {
                break
            }
            RunLoop.main.run(mode: .default, before: Date().addingTimeInterval(0.05))
        }
        XCTAssertTrue(textContains("pass that along", in: host), "markdown did not render the cookie rows")
        XCTAssertLessThanOrEqual(probe.row, 72)
        let panel = PopupGeometry.panelHeight(
            transcriptContent: probe.transcript,
            inputRowHeight: probe.row
        )
        let estimate = PopupMetrics.panelHeight(turnTexts: lines, draft: "", showsNotice: false)
        XCTAssertGreaterThan(estimate, 300, "the line estimate is the near-full flash")
        XCTAssertGreaterThan(panel, 180)
        XCTAssertLessThan(panel, PopupLayout.maxHeight, "settled three exchanges stay under the cap")
        XCTAssertLessThan(panel, estimate)
    }

    func testRealCookieRowWraps() throws {
        let token = String(repeating: "Transaction", count: 4)
        let text = "Einstein is best known for relativity. END-OF-REPLY-m1-popup. "
            + "The concept of TPS (Transactions per second) is how many commits a database finishes. "
            + token + " `code` and \\(a^2 + b^2\\)."
        let row = TurnRow(turn: ChatTurn(index: 0, role: .cookie, text: text, streaming: false, badge: CookieCopy.onDevice))
            .padding(.horizontal, 16)
            .frame(width: PopupLayout.width, alignment: .topLeading)
        let host = NSHostingView(rootView: row)
        host.frame = NSRect(x: 0, y: 0, width: PopupLayout.width, height: 400)
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
        let deadline = Date().addingTimeInterval(5)
        var rendered: NSTextView?
        while Date() < deadline {
            host.layoutSubtreeIfNeeded()
            ReplyTextLayout.constrain(host)
            rendered = textView(containing: "END-OF-REPLY-m1-popup", in: host)
            if rendered != nil { break }
            RunLoop.main.run(mode: .default, before: Date().addingTimeInterval(0.05))
        }
        let textView = try XCTUnwrap(rendered, "MarkdownView did not render")
        let box = try XCTUnwrap(find(CookieAX.turnCookie(0), in: host))
        XCTAssertGreaterThan(box.bounds.height, 30, "a two-line cookie reply is taller than a clipped line")
        XCTAssertEqual(box.accessibilityValue() as? String, text)
        XCTAssertFalse(textView.string.contains("\u{200B}"))
        XCTAssertTrue(textView.string.contains("END-OF-REPLY-m1-popup"))
        XCTAssertTrue(textView.string.contains(token))
        XCTAssertTrue(textContains("code", in: host), "the code span was not rendered")
        let storage = textView.attributedString()
        let mathAttachment = storage.containsAttachments(
            in: NSRange(location: 0, length: storage.length)
        )
        XCTAssertTrue(
            mathAttachment || textContains("a^2", in: host),
            "inline math was neither an attachment nor text"
        )
        let width = textView.textContainer?.containerSize.width ?? 10_000
        XCTAssertGreaterThan(width, 300, "the reply uses the column")
        XCTAssertLessThanOrEqual(width, PopupLayout.width - 32)
        XCTAssertEqual(textView.textContainer?.lineBreakMode, .byWordWrapping)
    }

    func testNewTurnsKeepTheSettledHeight() {
        let lines = [
            "hey cookie!",
            "Hi! How can I help you?",
            "say something long",
            "The concept of TPS (Transactions per second) is how many commits a database finishes.",
            "this ui is kinda chopped",
            "I'm sorry to hear that. I'll pass that along.",
        ]
        let model = AppModel()
        // Unpadded stack for a panel near 260. Padding is 24, the divider is 1,
        // and the row is 64: 171 + 24 + 1 + 64 = 260. The line estimate is 303.
        let settledTranscript: CGFloat = 171
        model.measuredTranscriptHeight = settledTranscript
        let settled = panelFrame(lines: lines, measured: model.measuredTranscriptHeight)
        let epsilon: CGFloat = 1
        // A send publishes the you turn, then the cookie turn. Each publish
        // used to zero the measurement and draw the estimate before the new
        // one arrived.
        for count in [5, 6] {
            model.prepareLayoutForTurnCount(count)
            let during = panelFrame(
                lines: Array(lines.prefix(count)),
                measured: model.measuredTranscriptHeight > 1 ? model.measuredTranscriptHeight : nil
            )
            XCTAssertLessThanOrEqual(
                during,
                settled + epsilon,
                "panel during turn count \(count) flashed past the settled height"
            )
        }
        XCTAssertEqual(model.measuredTranscriptHeight, settledTranscript)
        let estimate = panelFrame(lines: lines, measured: nil)
        XCTAssertGreaterThan(estimate, settled + 20, "the line estimate is the near-full flash")
        model.prepareLayoutForTurnCount(0)
        XCTAssertEqual(model.measuredTranscriptHeight, 0)
        let cleared = panelFrame(lines: [], measured: model.measuredTranscriptHeight > 1 ? model.measuredTranscriptHeight : nil)
        XCTAssertEqual(cleared, PopupLayout.collapsedHeight)
    }

    func testLongTokenWrapsInAWordWrappingTextContainer() {
        let word = String(repeating: "Transaction", count: 8)
        let text = NSTextView(frame: NSRect(x: 0, y: 0, width: 180, height: 400))
        text.string = word
        text.textContainer?.widthTracksTextView = true
        text.textContainer?.containerSize = NSSize(width: 10_000, height: 20)
        ReplyTextLayout.constrain(text)
        let widthAfter = text.textContainer?.containerSize.width ?? 0
        ReplyTextLayout.constrain(text)
        guard let container = text.textContainer, let manager = text.layoutManager else {
            XCTFail("missing text container")
            return
        }
        manager.ensureLayout(for: container)
        let used = manager.usedRect(for: container)
        XCTAssertEqual(text.string, word)
        XCTAssertFalse(text.string.contains("\u{200B}"))
        XCTAssertEqual(container.lineBreakMode, .byWordWrapping)
        XCTAssertFalse(container.widthTracksTextView)
        XCTAssertEqual(container.containerSize.width, widthAfter, "a second pass does not reset the container")
        XCTAssertLessThan(widthAfter, 180)
        XCTAssertGreaterThan(used.height, 40, "an over-long token wraps by character inside the column")
    }

    private func panelFrame(lines: [String], measured: CGFloat?) -> CGFloat {
        PopupMetrics.panelHeight(
            turnTexts: lines,
            draft: "",
            showsNotice: false,
            measuredTranscript: measured
        )
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
            RunLoop.main.run(mode: .default, before: Date().addingTimeInterval(0.05))
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
        let identifier = role == .you ? CookieAX.turnYou(0) : CookieAX.turnCookie(0)
        let deadline = Date().addingTimeInterval(1)
        var height: CGFloat = 0
        var previous: CGFloat = 0
        var stable = 0
        while Date() < deadline {
            host.layoutSubtreeIfNeeded()
            if let box = find(identifier, in: host) {
                height = box.bounds.height
            }
            if height > 1, abs(height - previous) < 0.5 {
                stable += 1
                if stable >= 2 { break }
            } else {
                stable = 0
            }
            previous = height
            RunLoop.main.run(mode: .default, before: Date().addingTimeInterval(0.05))
        }
        XCTAssertGreaterThan(height, 1)
        return height
    }

    private func textContains(_ needle: String, in view: NSView) -> Bool {
        textView(containing: needle, in: view) != nil
    }

    private func textView(containing needle: String, in view: NSView) -> NSTextView? {
        if let text = view as? NSTextView, text.string.contains(needle) { return text }
        for subview in view.subviews {
            if let found = textView(containing: needle, in: subview) { return found }
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
