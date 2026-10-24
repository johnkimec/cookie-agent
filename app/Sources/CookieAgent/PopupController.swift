import AppKit
import CookieCore
import SwiftUI

final class CookiePanel: NSPanel {
    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { false }
}

final class PopupController: NSObject, @unchecked Sendable {
    private let model: AppModel
    private let panel: CookiePanel
    private let host: NSHostingView<PopupRoot>
    private var monitors: [Any] = []
    private var anchoredTop: CGFloat?

    init(model: AppModel) {
        self.model = model
        panel = CookiePanel(
            contentRect: NSRect(x: 0, y: 0, width: PopupLayout.width, height: PopupLayout.collapsedHeight),
            styleMask: [.borderless, .nonactivatingPanel, .fullSizeContentView],
            backing: .buffered,
            defer: false
        )
        host = NSHostingView(rootView: PopupRoot(model: model))
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
        if let global = NSEvent.addGlobalMonitorForEvents(matching: [.leftMouseDown, .rightMouseDown], handler: { [weak self] _ in
            let point = NSEvent.mouseLocation
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
        panel.orderFrontRegardless()
        panel.makeKey()
        DispatchQueue.main.async { [weak self] in
            self?.focusField()
        }
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
        let turns = model.conversation.turns
        let draftLines = min(5, max(1, model.conversation.draft.components(separatedBy: "\n").count))
        let input = max(PopupLayout.collapsedHeight, 28 + CGFloat(draftLines) * 22)
        guard !turns.isEmpty else { return min(PopupLayout.maxHeight, input) }
        var lines = 0
        for turn in turns {
            lines += max(1, Int((Double(max(turn.text.count, 1)) / 48).rounded(.up)))
        }
        let transcript = CGFloat(lines) * 22 + CGFloat(turns.count) * 16 + 16
        return min(PopupLayout.maxHeight, input + transcript)
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
        if event.modifierFlags.contains(.option),
           let button = StatusItemAccess.findButton(),
           event.window === button.window {
            model.openPopup()
            return nil
        }
        if model.popupOpen, let window = event.window, window !== panel {
            model.closePopup()
        }
        return event
    }

    private func handleKey(_ event: NSEvent) -> NSEvent? {
        guard model.popupOpen, event.keyCode == 53 else { return event }
        model.closePopup()
        return nil
    }

    private func closeIfOutside(_ point: NSPoint) {
        guard model.popupOpen else { return }
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

struct PopupRoot: View {
    @ObservedObject var model: AppModel

    var body: some View {
        let _ = model.runtime
        let _ = model.popupOpen
        VStack(spacing: 0) {
            if !model.conversation.turns.isEmpty {
                ScrollView {
                    VStack(alignment: .leading, spacing: 12) {
                        ForEach(model.conversation.turns) { turn in
                            TurnRow(turn: turn)
                        }
                    }
                    .padding(16)
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
                .frame(maxHeight: .infinity)
                Divider()
            }
            inputRow
        }
        .frame(width: PopupLayout.width)
        .frame(minHeight: PopupLayout.collapsedHeight)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
    }

    private var inputRow: some View {
        HStack(alignment: .center, spacing: 10) {
            CookiePlaceholder(pose: model.pose)
            AskField(
                text: Binding(
                    get: { model.conversation.draft },
                    set: { newValue in
                        var next = model.conversation
                        next.draft = newValue
                        model.conversation = next
                        model.onLayout?()
                    }
                ),
                onSubmit: { model.submit() },
                onEscape: { model.closePopup() },
                onEditLast: { model.recallLast() }
            )
            .frame(maxWidth: .infinity, minHeight: PopupLayout.mascot, maxHeight: 120)
            Button {
                model.submit()
            } label: {
                Text("⏎")
                    .font(.body)
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier(CookieAX.popupSend)
            .accessibilityLabel("⏎")
            .help(CookieCopy.ask)
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 12)
        .frame(minHeight: PopupLayout.collapsedHeight)
    }
}

struct TurnRow: View {
    var turn: ChatTurn

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 12) {
            Text(turn.role.rawValue)
                .font(.body.monospaced())
                .foregroundStyle(.secondary)
                .frame(width: 64, alignment: .leading)
                .accessibilityIdentifier(identifier)
                .accessibilityLabel(turn.role.rawValue)
            Text(turn.text)
                .frame(maxWidth: .infinity, alignment: .leading)
                .textSelection(.enabled)
            if let badge = turn.badge {
                Text(badge)
                    .font(.caption)
                    .padding(.horizontal, 8)
                    .padding(.vertical, 3)
                    .background(.quaternary, in: Capsule())
                    .accessibilityIdentifier(CookieAX.badge(turn.index))
                    .accessibilityLabel(badge)
            }
        }
    }

    private var identifier: String {
        switch turn.role {
        case .you:
            CookieAX.turnYou(turn.index)
        case .cookie:
            CookieAX.turnCookie(turn.index)
        }
    }
}

struct CookiePlaceholder: View {
    var pose: PopupPose
    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        let fur = colorScheme == .dark ? Color(white: 0.78) : Color(white: 0.97)
        let outline = colorScheme == .dark ? Color(white: 0.9) : Color(white: 0.42)
        Canvas { context, size in
            let rect = CGRect(origin: .zero, size: size)
            let earsRaised = pose == .listening
            let earY: CGFloat = earsRaised ? size.height * 0.42 : size.height * 0.12
            let ear = CGSize(width: size.width * 0.22, height: size.height * 0.42)
            var left = Path(ellipseIn: CGRect(x: size.width * 0.08, y: earY, width: ear.width, height: ear.height))
            var right = Path(ellipseIn: CGRect(x: size.width * 0.70, y: earY, width: ear.width, height: ear.height))
            var head = Path(ellipseIn: rect.insetBy(dx: size.width * 0.18, dy: size.height * 0.16))
            context.fill(left, with: .color(fur))
            context.fill(right, with: .color(fur))
            context.fill(head, with: .color(fur))
            context.stroke(left, with: .color(outline), lineWidth: 1.6)
            context.stroke(right, with: .color(outline), lineWidth: 1.6)
            if pose == .offline {
                context.stroke(head, with: .color(outline), style: StrokeStyle(lineWidth: 1.6, dash: [2, 2]))
                var slash = Path()
                slash.move(to: CGPoint(x: size.width * 0.22, y: size.height * 0.2))
                slash.addLine(to: CGPoint(x: size.width * 0.78, y: size.height * 0.82))
                context.stroke(slash, with: .color(outline), lineWidth: 1.6)
            } else {
                context.stroke(head, with: .color(outline), lineWidth: 1.6)
            }
            let eye = Color.primary
            let eyeSize = size.width * 0.08
            context.fill(
                Path(ellipseIn: CGRect(x: size.width * 0.38, y: size.height * 0.48, width: eyeSize, height: eyeSize)),
                with: .color(eye)
            )
            context.fill(
                Path(ellipseIn: CGRect(x: size.width * 0.54, y: size.height * 0.48, width: eyeSize, height: eyeSize)),
                with: .color(eye)
            )
            if pose == .talking {
                let tongue = CGRect(x: size.width * 0.44, y: size.height * 0.28, width: size.width * 0.12, height: size.height * 0.14)
                context.fill(Path(ellipseIn: tongue), with: .color(.pink.opacity(0.85)))
            }
            if pose == .thinking {
                context.fill(
                    Path(ellipseIn: CGRect(x: size.width * 0.72, y: size.height * 0.72, width: 4, height: 4)),
                    with: .color(outline)
                )
                context.fill(
                    Path(ellipseIn: CGRect(x: size.width * 0.84, y: size.height * 0.8, width: 3, height: 3)),
                    with: .color(outline)
                )
            }
        }
        .frame(width: PopupLayout.mascot, height: PopupLayout.mascot)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(popupPoseVoiceOver(pose))
        .accessibilityIdentifier(CookieAX.popupMascot)
        .opacity(pose == .offline ? 0.55 : 1)
        .help(popupPoseVoiceOver(pose))
    }
}
