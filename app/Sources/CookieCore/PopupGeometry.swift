// PopupGeometry.swift
// Pure panel-height math, no SwiftUI, so it can be unit-tested in CookieCore.
// Fold this into PopupMetrics / PopupLayout. The one behavioural change: the transcript's own
// vertical padding (16 top, 8 bottom) now counts toward the height. Leaving it out is what
// sliced the first line in popup-short.png and popup-long.png.

import CoreGraphics

public enum PopupGeometry {
    public static let width: CGFloat = 560
    public static let maxHeight: CGFloat = 320          // D-2026-11-03-01
    public static let emptyHeight: CGFloat = 64         // input row alone
    public static let divider: CGFloat = 1
    public static let horizontalPadding: CGFloat = 16
    public static let transcriptTopPadding: CGFloat = 16
    public static let transcriptBottomPadding: CGFloat = 8
    public static let pairSpacing: CGFloat = 16
    public static let replyToLabelSpacing: CGFloat = 4
    public static let promptToReplySpacing: CGFloat = 3
    public static let topFade: CGFloat = 16

    /// - Parameters:
    ///   - transcriptContent: measured height of the stacked pairs, without the transcript padding. Nil or 0 means no turns yet.
    ///   - inputRowHeight: 64 for a one-line field; larger as the field grows through its 8 lines.
    public static func panelHeight(transcriptContent: CGFloat?, inputRowHeight: CGFloat = emptyHeight) -> CGFloat {
        guard let content = transcriptContent, content > 0 else { return inputRowHeight }
        return min(maxHeight, content + transcriptTopPadding + transcriptBottomPadding + divider + inputRowHeight)
    }

    /// Height of the visible transcript area for a given panel height.
    public static func transcriptViewport(panelHeight: CGFloat, inputRowHeight: CGFloat = emptyHeight) -> CGFloat {
        max(0, panelHeight - inputRowHeight - divider)
    }

    /// True once the content no longer fits and the transcript scrolls.
    public static func isCapped(transcriptContent: CGFloat, inputRowHeight: CGFloat = emptyHeight) -> Bool {
        transcriptContent + transcriptTopPadding + transcriptBottomPadding + divider + inputRowHeight > maxHeight
    }
}
