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

private struct TranscriptFrame: Equatable, Sendable {
    var height: CGFloat
    var minY: CGFloat
}

private struct TranscriptFrameKey: PreferenceKey {
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

private struct ViewportHeightKey: PreferenceKey {
    static var defaultValue: CGFloat { 0 }

    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) {
        value = max(value, nextValue())
    }
}

struct PopupRoot: View {
    @ObservedObject var model: AppModel
    @State private var pin = TranscriptPin()
    @State private var viewportHeight: CGFloat = 0
    @State private var transcriptFrame = TranscriptFrame(height: 0, minY: 0)

    var body: some View {
        let _ = model.runtime
        let _ = model.popupOpen
        VStack(spacing: 0) {
            if !model.conversation.turns.isEmpty {
                transcript
                Divider()
            }
            inputRow
        }
        .frame(width: PopupLayout.width)
        .frame(minHeight: PopupLayout.collapsedHeight)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
        .accessibilityElement(children: .contain)
    }

    private var transcript: some View {
        ScrollViewReader { proxy in
            ScrollView {
                // The marker used to be the last stack item, so the 12 pt
                // spacing, its 8 pt height, and the 16 pt padding sat under
                // the last line. It now occupies the bottom inset.
                ZStack(alignment: .bottomLeading) {
                    VStack(alignment: .leading, spacing: 12) {
                        ForEach(model.conversation.turns) { turn in
                            TurnRow(turn: turn)
                        }
                    }
                    .padding(.horizontal, 16)
                    .padding(.top, 16)
                    .padding(.bottom, PopupLayout.transcriptBottomInset)
                    .frame(maxWidth: .infinity, alignment: .topLeading)
                    IdentifiedBox(
                        identifier: CookieAX.transcriptBottom,
                        label: "transcript"
                    )
                    .frame(width: 8, height: 8)
                    .id(CookieAX.transcriptBottom)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .background {
                    GeometryReader { geo in
                        Color.clear.preference(
                            key: TranscriptFrameKey.self,
                            value: TranscriptFrame(
                                height: geo.size.height,
                                minY: geo.frame(in: .named("popupTranscript")).minY
                            )
                        )
                    }
                }
            }
            .coordinateSpace(name: "popupTranscript")
            .background {
                GeometryReader { geo in
                    Color.clear.preference(key: ViewportHeightKey.self, value: geo.size.height)
                }
            }
            .onPreferenceChange(ViewportHeightKey.self) { height in
                viewportHeight = height
                follow(proxy, frame: transcriptFrame, viewport: height)
            }
            .onPreferenceChange(TranscriptFrameKey.self) { frame in
                transcriptFrame = frame
                follow(proxy, frame: frame, viewport: viewportHeight)
                model.noteTranscriptHeight(frame.height)
            }
            .onChange(of: model.conversation.turns.last?.text ?? "") { _, _ in
                guard pin.pinnedToBottom else { return }
                proxy.scrollTo(CookieAX.transcriptBottom, anchor: .bottom)
            }
            .frame(maxHeight: .infinity)
        }
        .frame(maxHeight: .infinity)
        .layoutPriority(1)
    }

    private func follow(_ proxy: ScrollViewProxy, frame: TranscriptFrame, viewport: CGFloat) {
        var next = pin
        let shouldScroll = next.note(
            contentHeight: frame.height,
            viewportHeight: viewport,
            contentMinY: frame.minY
        )
        pin = next
        if shouldScroll {
            proxy.scrollTo(CookieAX.transcriptBottom, anchor: .bottom)
        }
    }

    private var inputRowCap: CGFloat {
        let showsNotice = popupLoadingLine(runtime: model.runtime.state) != nil
            || model.conversation.refusalLine(runtime: model.runtime.state) != nil
        return PopupMetrics.inputRowHeight(draft: model.conversation.draft, showsNotice: showsNotice)
    }

    private var inputRow: some View {
        let control = popupSendControl(
            runtime: model.runtime.state,
            replyInFlight: model.conversation.replyInFlight
        )
        return HStack(alignment: .center, spacing: 10) {
            CookiePlaceholder(pose: model.pose)
            VStack(alignment: .leading, spacing: 4) {
                AskField(
                    text: Binding(
                        get: { model.conversation.draft },
                        set: { model.setDraft($0) }
                    ),
                    onSubmit: { model.submit() },
                    onEscape: { model.pressEscape() },
                    onEditLast: { model.recallLast() },
                    onCommandK: { model.pressCommandK() }
                )
                .accessibilityLabel(CookieCopy.ask)
                .frame(maxWidth: .infinity)
                if let loading = popupLoadingLine(runtime: model.runtime.state) {
                    IdentifiedText(
                        text: loading,
                        identifier: CookieAX.popupLoading,
                        label: loading,
                        font: .systemFont(ofSize: NSFont.smallSystemFontSize),
                        textColor: .secondaryLabelColor
                    )
                } else if let notice = model.conversation.refusalLine(runtime: model.runtime.state) {
                    IdentifiedText(
                        text: notice,
                        identifier: CookieAX.popupRefusal,
                        label: notice,
                        font: .systemFont(ofSize: NSFont.smallSystemFontSize),
                        textColor: .secondaryLabelColor
                    )
                }
            }
            if model.runtime.state == .up {
                onDeviceIndicator
            }
            IdentifiedButton(
                title: control.title,
                identifier: control.identifier,
                enabled: control.enabled
            ) {
                model.submit()
            }
            .fixedSize()
            .help(control.stopsReply ? CookieCopy.stop : CookieCopy.ask)
        }
        .padding(.horizontal, 16)
        .padding(.vertical, PopupLayout.inputRowVerticalPadding)
        .frame(minHeight: PopupLayout.collapsedHeight, maxHeight: inputRowCap)
        .fixedSize(horizontal: false, vertical: true)
        .background {
            GeometryReader { geo in
                Color.clear.preference(key: InputRowHeightKey.self, value: geo.size.height)
            }
        }
    }

    /// One status dot for the whole popup. The existing on-device string is
    /// its accessibility label and tooltip. There is no per-reply pill.
    private var onDeviceIndicator: some View {
        ZStack {
            IdentifiedBox(
                identifier: CookieAX.onDeviceIndicator,
                label: CookieCopy.onDevice,
                value: CookieCopy.onDevice,
                tooltip: CookieCopy.onDevice
            )
            Circle()
                .fill(Color.secondary)
                .frame(width: 8, height: 8)
                .accessibilityHidden(true)
        }
        .frame(width: 8, height: 8)
        .fixedSize()
        .help(CookieCopy.onDevice)
    }
}

struct TurnRow: View {
    var turn: ChatTurn

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            Text(turn.role.rawValue)
                .font(.body.monospaced())
                .foregroundStyle(.secondary)
                .frame(width: 64, alignment: .leading)
            reply
                .frame(maxWidth: .infinity, alignment: .leading)
                .background {
                    IdentifiedBox(
                        identifier: identifier,
                        label: turn.role.rawValue,
                        value: turn.text
                    )
                }
        }
    }

    @ViewBuilder
    private var reply: some View {
        switch turn.role {
        case .you:
            // fixedSize stays inside the width frame. Outside it, the ideal
            // height is the unwrapped line and the column clips the tail.
            Text(turn.text)
                .textSelection(.enabled)
                .multilineTextAlignment(.leading)
                .fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: .infinity, alignment: .leading)
        case .cookie:
            // Same width order for markdown. ParagraphView.sizeThatFits
            // returns nil for an infinite width, and the paragraph then
            // stays one line. Inline LaTeX is an attachment in that
            // paragraph, so it wraps with the text once the width is finite.
            MarkdownView(text: prepareReplyMarkdown(turn.text))
                .fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: .infinity, alignment: .leading)
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
            let left = Path(ellipseIn: CGRect(x: size.width * 0.08, y: earY, width: ear.width, height: ear.height))
            let right = Path(ellipseIn: CGRect(x: size.width * 0.70, y: earY, width: ear.width, height: ear.height))
            let head = Path(ellipseIn: rect.insetBy(dx: size.width * 0.18, dy: size.height * 0.16))
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
        .accessibilityHidden(true)
        .background {
            IdentifiedBox(identifier: CookieAX.popupMascot, label: popupPoseVoiceOver(pose))
        }
        .opacity(pose == .offline ? 0.55 : 1)
        .help(popupPoseVoiceOver(pose))
    }
}
