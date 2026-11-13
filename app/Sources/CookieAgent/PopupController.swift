import AppKit
import CookieCore
import SwiftStreamingMarkdown
import SwiftUI

final class CookiePanel: NSPanel {
    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { false }

    /// A non-activating panel resigns key as soon as the frontmost app is
    /// something else. Closing here would dismiss the popup immediately.
    override func resignKey() {
        super.resignKey()
    }
}

/// The hosting view is not an element, so System Events walks the AppKit
/// subviews. Each identifier is already on one of those views. Appending
/// them again from `accessibilityChildren` publishes the same id twice.
final class PopupHostingView: NSHostingView<PopupRoot> {
    override func isAccessibilityElement() -> Bool {
        false
    }

    override func layout() {
        super.layout()
        ReplyTextLayout.constrain(self)
    }
}

/// Reply text is not rewritten to force a wrap. A finite text-container
/// width and word wrapping break a token that does not fit the column.
enum ReplyTextLayout {
    static func constrain(_ view: NSView) {
        if let text = view as? NSTextView, !(text is AskTextView), let container = text.textContainer {
            let inset = text.textContainerInset.width * 2
            let padding = container.lineFragmentPadding * 2
            let width = text.bounds.width - inset - padding
            // Tracking would write the full view width back on the next
            // layout and undo the inset. Set the container once, then only
            // when the column actually changes.
            if width > 1 {
                if container.lineBreakMode != .byWordWrapping {
                    container.lineBreakMode = .byWordWrapping
                }
                if container.maximumNumberOfLines != 0 {
                    container.maximumNumberOfLines = 0
                }
                if container.widthTracksTextView {
                    container.widthTracksTextView = false
                }
                if abs(container.containerSize.width - width) > 0.5 {
                    container.containerSize = NSSize(width: width, height: CGFloat.greatestFiniteMagnitude)
                }
            }
        }
        for subview in view.subviews {
            constrain(subview)
        }
    }
}

final class PopupController: NSObject, @unchecked Sendable {
    private let model: AppModel
    private let panel: CookiePanel
    private let host: PopupHostingView
    private var monitors: [Any] = []
    private var anchoredTop: CGFloat?
    private var suppressOutsideCloseUntil = Date.distantPast

    init(model: AppModel) {
        self.model = model
        panel = CookiePanel(
            contentRect: NSRect(x: 0, y: 0, width: PopupLayout.width, height: PopupLayout.collapsedHeight),
            styleMask: [.borderless, .nonactivatingPanel, .fullSizeContentView],
            backing: .buffered,
            defer: false
        )
        host = PopupHostingView(rootView: PopupRoot(model: model))
        super.init()
        panel.isFloatingPanel = true
        panel.level = .floating
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        panel.hidesOnDeactivate = false
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = true
        panel.isMovable = false
        panel.becomesKeyOnlyIfNeeded = false
        panel.title = CookieCopy.ask
        panel.setAccessibilityIdentifier(CookieAX.popup)
        panel.setAccessibilityLabel(CookieCopy.ask)
        host.frame = panel.contentRect(forFrameRect: panel.frame)
        host.autoresizingMask = [.width, .height]
        panel.contentView = host
    }

    func install() {
        let localMouse = NSEvent.addLocalMonitorForEvents(matching: [.leftMouseDown, .rightMouseDown]) { [weak self] event in
            self?.handleLocalMouse(event) ?? event
        }
        if let localMouse { monitors.append(localMouse) }
        let keys = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak self] event in
            self?.handleKey(event) ?? event
        }
        if let keys { monitors.append(keys) }
        if let global = NSEvent.addGlobalMonitorForEvents(matching: [.leftMouseDown, .rightMouseDown], handler: { [weak self] event in
            let point = self?.screenPoint(of: event) ?? NSEvent.mouseLocation
            DispatchQueue.main.async {
                self?.closeIfOutside(point)
            }
        }) {
            monitors.append(global)
        }
        let menu = NotificationCenter.default.addObserver(
            forName: NSMenu.didBeginTrackingNotification,
            object: nil,
            queue: .main
        ) { [weak self] note in
            self?.menuBeganTracking(note)
        }
        monitors.append(menu)
    }

    func apply(open: Bool) {
        if open {
            show()
        } else {
            panel.orderOut(nil)
        }
    }

    func relayout() {
        guard model.popupOpen else { return }
        let height = preferredHeight()
        var frame = panel.frame
        if abs(frame.height - height) < 0.5, abs(frame.width - PopupLayout.width) < 0.5 {
            return
        }
        let top = anchoredTop ?? frame.maxY
        frame.size.width = PopupLayout.width
        frame.size.height = height
        frame.origin.y = top - height
        panel.setFrame(frame, display: true)
    }

    private func show() {
        let height = preferredHeight()
        panel.setContentSize(NSSize(width: PopupLayout.width, height: height))
        place(height: height)
        // Become key without activating Cookie. `orderFrontRegardless` plus
        // `makeKey` leaves the field unable to take keystrokes.
        suppressOutsideCloseUntil = Date().addingTimeInterval(0.8)
        panel.makeKeyAndOrderFront(nil)
        focusField()
        DispatchQueue.main.async { [weak self] in
            self?.focusField()
        }
    }

    /// Global event locations are CG top-left coordinates. AppKit frames are
    /// bottom-left. An AX click does not move the cursor, so `mouseLocation`
    /// would look outside the panel and dismiss it.
    private func screenPoint(of event: NSEvent) -> NSPoint {
        if let window = event.window {
            return window.convertPoint(toScreen: event.locationInWindow)
        }
        guard let cgPoint = event.cgEvent?.location else { return NSEvent.mouseLocation }
        let height = (NSScreen.screens.first { $0.frame.origin == .zero } ?? NSScreen.main)?.frame.height ?? 0
        guard height > 0 else { return NSEvent.mouseLocation }
        return NSPoint(x: cgPoint.x, y: height - cgPoint.y)
    }

    private func place(height: CGFloat) {
        let screen = screenForPopup()
        let visible = screen.visibleFrame
        let bandHeight = visible.height / 3
        let bandMidY = visible.maxY - bandHeight / 2
        let x = visible.midX - PopupLayout.width / 2
        let y = bandMidY - height / 2
        let frame = NSRect(x: x, y: y, width: PopupLayout.width, height: height)
        panel.setFrame(frame, display: true)
        anchoredTop = frame.maxY
    }

    private func screenForPopup() -> NSScreen {
        let mouse = NSEvent.mouseLocation
        return NSScreen.screens.first { NSMouseInRect(mouse, $0.frame, false) } ?? NSScreen.main ?? NSScreen.screens[0]
    }

    private func preferredHeight() -> CGFloat {
        let showsNotice = popupLoadingLine(runtime: model.runtime.state) != nil
            || model.conversation.refusalLine(runtime: model.runtime.state) != nil
        let measured = model.measuredTranscriptHeight
        return PopupMetrics.panelHeight(
            turnTexts: model.conversation.turns.map(\.text),
            draft: model.conversation.draft,
            showsNotice: showsNotice,
            measuredTranscript: measured > 1 ? measured : nil
        )
    }

    private func focusField() {
        guard let text = findTextView(in: panel.contentView) else { return }
        panel.makeFirstResponder(text)
    }

    private func findTextView(in view: NSView?) -> AskTextView? {
        guard let view else { return nil }
        if let text = view as? AskTextView { return text }
        for subview in view.subviews {
            if let text = findTextView(in: subview) { return text }
        }
        return nil
    }

    private func handleLocalMouse(_ event: NSEvent) -> NSEvent? {
        let optionHeld = event.modifierFlags.contains(.option) || NSEvent.modifierFlags.contains(.option)
        if optionHeld,
           let button = StatusItemAccess.findButton(),
           event.window === button.window {
            model.openPopup()
            return nil
        }
        if model.popupOpen,
           Date() >= suppressOutsideCloseUntil,
           let window = event.window,
           window !== panel {
            model.closePopup()
        }
        return event
    }

    private func handleKey(_ event: NSEvent) -> NSEvent? {
        guard model.popupOpen, event.keyCode == 53 else { return event }
        // The monitor swallows Escape, so the field does not see it too.
        // While a reply is arriving this stops the reply and leaves the panel up.
        model.pressEscape()
        return nil
    }

    private func closeIfOutside(_ point: NSPoint) {
        guard model.popupOpen, Date() >= suppressOutsideCloseUntil else { return }
        if !panel.frame.contains(point) {
            model.closePopup()
        }
    }

    private func menuBeganTracking(_ note: Notification) {
        guard let menu = note.object as? NSMenu else { return }
        for item in menu.items {
            switch item.title {
            case model.statusText:
                item.isEnabled = false
                item.setAccessibilityIdentifier(CookieAX.menuStatus)
                item.setAccessibilityLabel(model.statusText)
            case CookieCopy.ask:
                item.setAccessibilityIdentifier(CookieAX.menuAsk)
                item.setAccessibilityLabel(CookieCopy.ask)
            case CookieCopy.localOnly:
                item.state = .on
                item.setAccessibilityIdentifier(CookieAX.menuLocalOnly)
                item.setAccessibilityLabel(CookieCopy.localOnly)
            case CookieCopy.quit:
                item.setAccessibilityIdentifier(CookieAX.menuQuit)
                item.setAccessibilityLabel(CookieCopy.quit)
            default:
                if item.title.hasPrefix("🐾 Cookie") {
                    item.isEnabled = false
                    item.setAccessibilityIdentifier(CookieAX.menuStatus)
                }
            }
        }
        if NSEvent.modifierFlags.contains(.option) {
            menu.cancelTracking()
            model.openPopup()
        }
    }
}

struct TranscriptFrame: Equatable, Sendable {
    var height: CGFloat
    var minY: CGFloat
}

struct TranscriptFrameKey: PreferenceKey {
    static var defaultValue: TranscriptFrame {
        TranscriptFrame(height: 0, minY: 0)
    }

    static func reduce(value: inout TranscriptFrame, nextValue: () -> TranscriptFrame) {
        let next = nextValue()
        if next.height > 0 {
            value = next
        }
    }
}

struct InputRowHeightKey: PreferenceKey {
    static var defaultValue: CGFloat { 0 }

    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) {
        value = max(value, nextValue())
    }
}

struct ViewportHeightKey: PreferenceKey {
    static var defaultValue: CGFloat { 0 }

    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) {
        value = max(value, nextValue())
    }
}

