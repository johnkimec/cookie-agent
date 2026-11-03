import CoreGraphics
import Foundation

/// Sizes for the popup field and the transcript estimate.
/// The UI spec's five-line draft cap is eight for this polish pass.
public enum PopupMetrics {
    public static let inputMaxLines = 8
    public static let inputLineHeight: CGFloat = 22

    public static func inputLineCount(_ text: String) -> Int {
        let lines = max(1, text.components(separatedBy: "\n").count)
        return min(inputMaxLines, lines)
    }

    /// The field's column inside the 560 pt row: padding, mascot, gaps, dot, button.
    public static var draftFieldWidth: CGFloat {
        max(120, PopupLayout.width - 32 - PopupLayout.mascot - 90)
    }

    /// Newlines and soft wraps. A long paste with no newline still grows the field.
    public static func draftLineCount(_ text: String) -> Int {
        let wrapped = estimatedLines(text, width: draftFieldWidth)
        return min(inputMaxLines, max(inputLineCount(text), wrapped))
    }

    /// Wrapped line count for a column `width` points wide. About 7 pt per character.
    public static func estimatedLines(_ text: String, width: CGFloat) -> Int {
        let charsPerLine = max(8, Int((width / 7).rounded(.down)))
        let pieces = text.isEmpty ? [""] : text.components(separatedBy: "\n")
        var total = 0
        for line in pieces {
            let count = max(line.count, 1)
            total += max(1, Int((Double(count) / Double(charsPerLine)).rounded(.up)))
        }
        return max(1, total)
    }

    public static func clampedInputHeight(lineCount: Int) -> CGFloat {
        let lines = min(inputMaxLines, max(1, lineCount))
        return CGFloat(lines) * inputLineHeight
    }

    /// Height of the mascot row. A one-line draft, with or without the
    /// loading line, is the collapsed row. Further draft lines grow the
    /// field. The panel's extra height does not.
    public static func inputRowHeight(draft: String, showsNotice: Bool) -> CGFloat {
        let notice: CGFloat = showsNotice ? 20 : 0
        return max(
            PopupLayout.collapsedHeight,
            PopupLayout.inputRowVerticalPadding * 2
                + clampedInputHeight(lineCount: draftLineCount(draft))
                + notice
        )
    }

    /// Panel height for the turns now on screen. Empty is the input row.
    /// A measured transcript height replaces the line estimate. The result
    /// never passes `PopupLayout.maxHeight`. The extra point is the divider
    /// between the transcript and the input row.
    public static func panelHeight(
        turnTexts: [String],
        draft: String,
        showsNotice: Bool,
        measuredTranscript: CGFloat? = nil
    ) -> CGFloat {
        let input = inputRowHeight(draft: draft, showsNotice: showsNotice)
        guard !turnTexts.isEmpty else { return min(PopupLayout.maxHeight, input) }
        let transcript: CGFloat
        if let measuredTranscript, measuredTranscript > 1 {
            transcript = measuredTranscript
        } else {
            var lines = 0
            for text in turnTexts {
                lines += estimatedLines(text, width: 400)
            }
            // Spacing matches the transcript stack (12 pt between turns,
            // 16 pt top, 8 pt bottom). A per-turn 16 pt pad pushed three
            // short exchanges up against the 320 pt cap and left a gap.
            let spacing = CGFloat(max(0, turnTexts.count - 1)) * 12
            let padding = 16 + PopupLayout.transcriptBottomInset
            transcript = CGFloat(lines) * inputLineHeight + spacing + padding
        }
        return min(PopupLayout.maxHeight, input + transcript + 1)
    }
}
