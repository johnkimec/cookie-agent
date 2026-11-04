import CoreGraphics
import Foundation

/// Follows the bottom of the transcript while the user is already there.
/// Content growth does not count as scrolling up.
public struct TranscriptPin: Equatable, Sendable {
    public static let epsilon: CGFloat = 24

    public var pinnedToBottom: Bool
    public private(set) var lastScrolled: CGFloat

    public init(pinnedToBottom: Bool = true, lastScrolled: CGFloat = 0) {
        self.pinnedToBottom = pinnedToBottom
        self.lastScrolled = lastScrolled
    }

    /// `contentMinY` is the content frame's minY in the scroll view's coordinate
    /// space: 0 at the top, negative after the user scrolls down.
    /// Returns whether the view should scroll to the bottom anchor.
    public mutating func note(
        contentHeight: CGFloat,
        viewportHeight: CGFloat,
        contentMinY: CGFloat,
        epsilon: CGFloat = TranscriptPin.epsilon
    ) -> Bool {
        guard viewportHeight > 1 else { return false }
        let scrolled = max(0, -contentMinY)
        let maxScroll = max(0, contentHeight - viewportHeight)
        let distance = max(0, maxScroll - scrolled)
        let scrolledDelta = scrolled - lastScrolled
        if distance <= epsilon {
            pinnedToBottom = true
        } else if pinnedToBottom && scrolledDelta >= -0.5 {
            pinnedToBottom = true
        } else if scrolledDelta < -0.5 {
            pinnedToBottom = false
        }
        lastScrolled = scrolled
        return pinnedToBottom && distance > 1
    }
}
