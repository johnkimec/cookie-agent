import AppKit
import CookieCore
import SwiftUI

/// Sized like `TextField(axis: .vertical).lineLimit(1...8)`: one line when
/// empty, growing through eight, then scrolling inside the field.
///
/// This stays an `NSTextView`. A SwiftUI vertical text field turns Return
/// into a newline. Return still sends, Shift-Return inserts a newline, and
/// ⌘K, Up at the start, AXValue, and AXConfirm stay on this view.
struct AskField: NSViewRepresentable {
    @Binding var text: String
    var onSubmit: () -> Void
    var onEscape: () -> Void
    var onEditLast: () -> Void
    var onCommandK: () -> Void

    func makeCoordinator() -> Coordinator {
        Coordinator(parent: self)
    }

    func sizeThatFits(_ proposal: ProposedViewSize, nsView scroll: NSScrollView, context: Context) -> CGSize? {
        let width = proposal.width ?? 320
        let fittedWidth = width.isFinite && width > 1 ? width : 320
        guard let textView = scroll.documentView as? AskTextView else {
            return CGSize(width: fittedWidth, height: PopupMetrics.inputLineHeight)
        }
        let inset = textView.textContainerInset
        let containerWidth = max(1, fittedWidth - inset.width * 2)
        textView.textContainer?.containerSize = NSSize(
            width: containerWidth,
            height: CGFloat.greatestFiniteMagnitude
        )
        textView.textContainer?.widthTracksTextView = true
        let used: CGFloat
        if let container = textView.textContainer {
            textView.layoutManager?.ensureLayout(for: container)
            used = textView.layoutManager?.usedRect(for: container).height ?? PopupMetrics.inputLineHeight
        } else {
            used = PopupMetrics.inputLineHeight
        }
        let raw = used + inset.height * 2
        let maxHeight = PopupMetrics.clampedInputHeight(lineCount: PopupMetrics.inputMaxLines)
        let height = min(maxHeight, max(PopupMetrics.inputLineHeight, raw))
        scroll.hasVerticalScroller = raw > maxHeight + 1
        textView.frame = NSRect(x: 0, y: 0, width: fittedWidth, height: max(raw, PopupMetrics.inputLineHeight))
        return CGSize(width: fittedWidth, height: height)
    }

    func makeNSView(context: Context) -> NSScrollView {
        let scroll = NSScrollView()
        scroll.drawsBackground = false
        scroll.setAccessibilityElement(false)
        scroll.setAccessibilityIdentifier("")
        scroll.borderType = .noBorder
        scroll.hasVerticalScroller = false
        scroll.hasHorizontalScroller = false
        scroll.autohidesScrollers = true

        let textView = AskTextView()
        textView.delegate = context.coordinator
        textView.isRichText = false
        textView.importsGraphics = false
        textView.font = CookieFont.fieldNSFont
        textView.textColor = .labelColor
        textView.drawsBackground = false
        textView.isAutomaticQuoteSubstitutionEnabled = false
        textView.isAutomaticDashSubstitutionEnabled = false
        textView.isAutomaticTextReplacementEnabled = false
        textView.isContinuousSpellCheckingEnabled = false
        textView.isGrammarCheckingEnabled = false
        textView.textContainerInset = NSSize(width: 2, height: 2)
        textView.isVerticallyResizable = true
        textView.isHorizontallyResizable = false
        textView.autoresizingMask = [.width]
        textView.textContainer?.widthTracksTextView = true
        textView.setAccessibilityElement(true)
        textView.setAccessibilityLabel(CookieCopy.ask)
        textView.setAccessibilityIdentifier(CookieAX.popupInput)
        textView.placeholder = CookieCopy.ask
        textView.onSubmit = onSubmit
        textView.onEscape = onEscape
        textView.onEditLast = onEditLast
        textView.onCommandK = onCommandK
        textView.onChange = { context.coordinator.parent.text = $0 }

        scroll.documentView = textView
        return scroll
    }

    func updateNSView(_ scroll: NSScrollView, context: Context) {
        context.coordinator.parent = self
        scroll.setAccessibilityElement(false)
        scroll.setAccessibilityIdentifier("")
        guard let textView = scroll.documentView as? AskTextView else { return }
        textView.onSubmit = onSubmit
        textView.onEscape = onEscape
        textView.onEditLast = onEditLast
        textView.onCommandK = onCommandK
        if textView.string != text {
            textView.string = text
            textView.needsDisplay = true
        }
    }

    final class Coordinator: NSObject, NSTextViewDelegate {
        var parent: AskField

        init(parent: AskField) {
            self.parent = parent
        }

        func textDidChange(_ notification: Notification) {
            guard let view = notification.object as? AskTextView else { return }
            parent.text = view.string
            view.needsDisplay = true
        }
    }
}

final class AskTextView: NSTextView {
    var placeholder = ""
    var onSubmit: () -> Void = {}
    var onEscape: () -> Void = {}
    var onEditLast: () -> Void = {}
    var onCommandK: () -> Void = {}
    var onChange: (String) -> Void = { _ in }

    override func setAccessibilityValue(_ accessibilityValue: Any?) {
        let text = (accessibilityValue as? String) ?? ""
        string = text
        if let caret = driveCaretLocation(
            textLength: (string as NSString).length,
            environment: ProcessInfo.processInfo.environment
        ) {
            setSelectedRange(NSRange(location: caret, length: 0))
        }
        onChange(text)
        needsDisplay = true
    }

    override func accessibilityPerformConfirm() -> Bool {
        onSubmit()
        return true
    }

    override func accessibilityPerformCancel() -> Bool {
        onEscape()
        return true
    }

    /// Present only when `COOKIE_DRIVE_KEYS=1`. Each action calls `keyDown`,
    /// the same path as the key. Names stay off the accessibility tree otherwise.
    override func accessibilityCustomActions() -> [NSAccessibilityCustomAction]? {
        guard cookieDriveKeysEnabled(environment: ProcessInfo.processInfo.environment) else {
            return super.accessibilityCustomActions()
        }
        return [
            NSAccessibilityCustomAction(
                name: "Shift Return",
                target: self,
                selector: #selector(driveShiftReturn)
            ),
            NSAccessibilityCustomAction(
                name: "Clear Field",
                target: self,
                selector: #selector(driveClearField)
            ),
            NSAccessibilityCustomAction(
                name: "Recall Last",
                target: self,
                selector: #selector(driveRecallLast)
            ),
        ]
    }

    @objc func driveShiftReturn() -> Bool {
        driveKey(code: 36, flags: .shift, characters: "\r")
        return true
    }

    @objc func driveClearField() -> Bool {
        driveKey(code: 40, flags: .command, characters: "k")
        return true
    }

    @objc func driveRecallLast() -> Bool {
        driveKey(code: 126, flags: [], characters: "")
        return true
    }

    private func driveKey(code: UInt16, flags: NSEvent.ModifierFlags, characters: String) {
        let event = NSEvent.keyEvent(
            with: .keyDown,
            location: .zero,
            modifierFlags: flags,
            timestamp: ProcessInfo.processInfo.systemUptime,
            windowNumber: window?.windowNumber ?? 0,
            context: nil,
            characters: characters,
            charactersIgnoringModifiers: characters,
            isARepeat: false,
            keyCode: code
        )
        if let event {
            keyDown(with: event)
        }
    }

    override func keyDown(with event: NSEvent) {
        let flags = event.modifierFlags.intersection(.deviceIndependentFlagsMask)
        if event.keyCode == 53 {
            onEscape()
            return
        }
        if event.keyCode == 36 || event.keyCode == 76 {
            if flags.contains(.shift) {
                insertNewline(nil)
                return
            }
            onSubmit()
            return
        }
        if event.keyCode == 126, flags.subtracting(.numericPad).isEmpty, selectedRange().location == 0 {
            onEditLast()
            return
        }
        if event.charactersIgnoringModifiers?.lowercased() == "k",
           flags.contains(.command),
           !flags.contains(.shift),
           !flags.contains(.option),
           !flags.contains(.control) {
            string = ""
            onChange("")
            onCommandK()
            needsDisplay = true
            return
        }
        super.keyDown(with: event)
    }

    override func draw(_ dirtyRect: NSRect) {
        super.draw(dirtyRect)
        guard string.isEmpty else { return }
        let attributes: [NSAttributedString.Key: Any] = [
            .foregroundColor: NSColor.placeholderTextColor,
            .font: font ?? CookieFont.fieldNSFont,
        ]
        let rect = NSRect(
            x: textContainerInset.width + 5,
            y: textContainerInset.height,
            width: max(0, bounds.width - 16),
            height: 22
        )
        placeholder.draw(in: rect, withAttributes: attributes)
    }
}

/// AppKit label so System Events can read `AXIdentifier`. A SwiftUI `Text`
/// modifier did not show up in the window's accessibility tree.
///
/// Loading and refusal lines still use this view. Cookie turns do not: those
/// are `Text` and `MarkdownView`. A wrapping label whose
/// `preferredMaxLayoutWidth` stays 0 reports a one-line intrinsic height, so
/// the proposed width is written onto the field.
struct IdentifiedText: NSViewRepresentable {
    var text: String
    var identifier: String
    var label: String
    var font: NSFont
    var textColor: NSColor

    func makeNSView(context: Context) -> NSTextField {
        let field = WrappingLabel(wrappingLabelWithString: text)
        field.isEditable = false
        field.isSelectable = true
        field.isBezeled = false
        field.drawsBackground = false
        field.font = font
        field.textColor = textColor
        field.lineBreakMode = .byWordWrapping
        field.maximumNumberOfLines = 0
        field.setAccessibilityElement(true)
        field.setAccessibilityIdentifier(identifier)
        field.setAccessibilityLabel(label)
        field.setAccessibilityValue(text)
        field.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        return field
    }

    func updateNSView(_ field: NSTextField, context: Context) {
        if field.stringValue != text {
            field.stringValue = text
        }
        field.font = font
        field.textColor = textColor
        field.setAccessibilityIdentifier(identifier)
        field.setAccessibilityLabel(label)
        field.setAccessibilityValue(text)
    }

    func sizeThatFits(_ proposal: ProposedViewSize, nsView: NSTextField, context: Context) -> CGSize? {
        guard let width = proposal.width, width.isFinite, width > 0 else { return nil }
        if nsView.preferredMaxLayoutWidth != width {
            nsView.preferredMaxLayoutWidth = width
            nsView.invalidateIntrinsicContentSize()
        }
        return CGSize(width: width, height: nsView.intrinsicContentSize.height)
    }
}

/// Sets `preferredMaxLayoutWidth` from the width SwiftUI actually gave the label.
private final class WrappingLabel: NSTextField {
    override func layout() {
        let width = bounds.width
        if width > 1, abs(preferredMaxLayoutWidth - width) > 0.5 {
            preferredMaxLayoutWidth = width
            invalidateIntrinsicContentSize()
        }
        super.layout()
    }
}

struct IdentifiedButton: NSViewRepresentable {
    var title: String
    var identifier: String
    /// Drawn on the key. The spoken label stays `title` (`⏎` or `Stop`).
    var keycap: String
    var enabled: Bool = true
    /// A ready key with a draft, or Stop, draws at full strength.
    var emphasized: Bool = false
    var action: () -> Void

    /// A fixed key. Without this, SwiftUI treats the control as flexible and
    /// it takes half the row.
    func sizeThatFits(_ proposal: ProposedViewSize, nsView button: NSButton, context: Context) -> CGSize? {
        CGSize(width: 36, height: 24)
    }

    func makeCoordinator() -> Coordinator {
        Coordinator(action: action)
    }

    func makeNSView(context: Context) -> NSButton {
        let button = KeycapButton(title: keycap, target: context.coordinator, action: #selector(Coordinator.press))
        button.setButtonType(.momentaryPushIn)
        applyChrome(button)
        button.isEnabled = enabled
        button.setContentHuggingPriority(.required, for: .horizontal)
        button.setContentHuggingPriority(.required, for: .vertical)
        button.setContentCompressionResistancePriority(.required, for: .horizontal)
        button.setContentCompressionResistancePriority(.required, for: .vertical)
        button.setAccessibilityElement(true)
        button.setAccessibilityIdentifier(identifier)
        button.setAccessibilityLabel(title)
        return button
    }

    func updateNSView(_ button: NSButton, context: Context) {
        context.coordinator.action = action
        applyChrome(button)
        button.isEnabled = enabled
        button.setAccessibilityIdentifier(identifier)
        button.setAccessibilityLabel(title)
    }

    /// The key draws `keycap`. The spoken string stays the accessibility label.
    /// An empty title would make System Events describe the control as blank
    /// instead of `⏎` or `Stop`.
    private func applyChrome(_ button: NSButton) {
        button.font = CookieFont.metaNSFont
        button.image = nil
        button.imagePosition = .noImage
        button.title = keycap
        button.isBordered = false
        button.alphaValue = emphasized && enabled ? 1 : 0.55
        if let key = button as? KeycapButton {
            key.emphasized = emphasized && enabled
        }
    }

    final class Coordinator: NSObject {
        var action: () -> Void

        init(action: @escaping () -> Void) {
            self.action = action
        }

        @objc func press() {
            action()
        }
    }
}

/// Draws the send key. The title is the glyph (`⏎` or `esc`). The accessibility
/// label is set by `IdentifiedButton` and is what System Events reads.
final class KeycapButton: NSButton {
    var emphasized = false

    override func draw(_ dirtyRect: NSRect) {
        let stroke = NSColor.labelColor.withAlphaComponent(emphasized ? 0.55 : 0.3)
        let face = bounds.insetBy(dx: 1, dy: 1.5)
        let key = NSBezierPath(roundedRect: face, xRadius: 6, yRadius: 6)
        stroke.setStroke()
        key.lineWidth = 1
        key.stroke()
        let lip = NSBezierPath()
        lip.move(to: NSPoint(x: face.minX + 4, y: face.minY + 1))
        lip.line(to: NSPoint(x: face.maxX - 4, y: face.minY + 1))
        lip.lineWidth = 1
        lip.stroke()
        let color = emphasized ? NSColor.labelColor : NSColor.secondaryLabelColor
        let attributes: [NSAttributedString.Key: Any] = [
            .font: font ?? CookieFont.metaNSFont,
            .foregroundColor: color,
        ]
        let size = title.size(withAttributes: attributes)
        let origin = NSPoint(
            x: (bounds.width - size.width) / 2,
            y: (bounds.height - size.height) / 2 - 1
        )
        title.draw(at: origin, withAttributes: attributes)
    }
}

struct IdentifiedBox: NSViewRepresentable {
    var identifier: String
    var label: String
    var value: String? = nil
    var tooltip: String? = nil

    func makeNSView(context: Context) -> NSView {
        let view = NSView(frame: .zero)
        view.autoresizingMask = [.width, .height]
        view.setAccessibilityElement(true)
        view.setAccessibilityIdentifier(identifier)
        view.setAccessibilityLabel(label)
        if let value {
            view.setAccessibilityValue(value)
        }
        view.toolTip = tooltip
        return view
    }

    func updateNSView(_ view: NSView, context: Context) {
        view.setAccessibilityIdentifier(identifier)
        view.setAccessibilityLabel(label)
        if let value {
            view.setAccessibilityValue(value)
        }
        view.toolTip = tooltip
    }
}
