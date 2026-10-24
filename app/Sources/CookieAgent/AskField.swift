import AppKit
import CookieCore
import SwiftUI

struct AskField: NSViewRepresentable {
    @Binding var text: String
    var onSubmit: () -> Void
    var onEscape: () -> Void
    var onEditLast: () -> Void

    func makeCoordinator() -> Coordinator {
        Coordinator(parent: self)
    }

    func makeNSView(context: Context) -> NSScrollView {
        let scroll = NSScrollView()
        scroll.drawsBackground = false
        scroll.borderType = .noBorder
        scroll.hasVerticalScroller = false
        scroll.hasHorizontalScroller = false
        scroll.autohidesScrollers = true

        let textView = AskTextView()
        textView.delegate = context.coordinator
        textView.isRichText = false
        textView.importsGraphics = false
        textView.font = .systemFont(ofSize: 15)
        textView.textColor = .labelColor
        textView.drawsBackground = false
        textView.isAutomaticQuoteSubstitutionEnabled = false
        textView.isAutomaticDashSubstitutionEnabled = false
        textView.isAutomaticTextReplacementEnabled = false
        textView.isContinuousSpellCheckingEnabled = false
        textView.isGrammarCheckingEnabled = false
        textView.textContainerInset = NSSize(width: 2, height: 8)
        textView.isVerticallyResizable = true
        textView.isHorizontallyResizable = false
        textView.autoresizingMask = [.width]
        textView.textContainer?.widthTracksTextView = true
        textView.setAccessibilityLabel(CookieCopy.ask)
        textView.setAccessibilityIdentifier(CookieAX.popupInput)
        textView.placeholder = CookieCopy.ask
        textView.onSubmit = onSubmit
        textView.onEscape = onEscape
        textView.onEditLast = onEditLast
        textView.onChange = { context.coordinator.parent.text = $0 }

        scroll.documentView = textView
        return scroll
    }

    func updateNSView(_ scroll: NSScrollView, context: Context) {
        context.coordinator.parent = self
        guard let textView = scroll.documentView as? AskTextView else { return }
        textView.onSubmit = onSubmit
        textView.onEscape = onEscape
        textView.onEditLast = onEditLast
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
            let limited = Self.limited(view.string)
            if limited != view.string {
                view.string = limited
            }
            parent.text = view.string
            view.needsDisplay = true
        }

        private static func limited(_ text: String) -> String {
            let lines = text.split(separator: "\n", omittingEmptySubsequences: false)
            guard lines.count > 5 else { return text }
            return lines.prefix(5).joined(separator: "\n")
        }
    }
}

final class AskTextView: NSTextView {
    var placeholder = ""
    var onSubmit: () -> Void = {}
    var onEscape: () -> Void = {}
    var onEditLast: () -> Void = {}
    var onChange: (String) -> Void = { _ in }

    override func keyDown(with event: NSEvent) {
        let flags = event.modifierFlags.intersection(.deviceIndependentFlagsMask)
        if event.keyCode == 53 {
            onEscape()
            return
        }
        if event.keyCode == 36 || event.keyCode == 76 {
            if flags.contains(.shift) {
                if string.components(separatedBy: "\n").count >= 5 { return }
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
            .font: font ?? NSFont.systemFont(ofSize: 15),
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
