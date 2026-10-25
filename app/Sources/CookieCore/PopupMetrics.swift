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
}
