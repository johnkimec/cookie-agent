import Foundation
import CookieProtocol

/// Stable accessibility identifiers. Feature files and `drive-mac` use these strings.
public enum CookieAX {
    public static let menuIcon = "cookie.menu.icon"
    public static let menuStatus = "cookie.menu.status"
    public static let menuAsk = "cookie.menu.ask"
    public static let menuLocalOnly = "cookie.menu.local-only"
    public static let menuQuit = "cookie.menu.quit"
    public static let popup = "cookie.popup"
    public static let popupInput = "cookie.popup.input"
    public static let popupMascot = "cookie.popup.mascot"
    public static let popupSend = "cookie.popup.send"
    public static func turnYou(_ index: Int) -> String { "cookie.turn.you.\(index)" }
    public static func turnCookie(_ index: Int) -> String { "cookie.turn.cookie.\(index)" }
    public static func badge(_ index: Int) -> String { "cookie.badge.on-device.\(index)" }
}

public enum CookieCopy {
    public static let displayName = "Cookie"
    public static let bundleFileName = "Cookie Agent.app"
    public static let ask = "Ask Cookie…"
    public static let localOnly = "Local-only mode"
    public static let quit = "Quit Cookie"
    public static let onDevice = "on-device"
    public static let you = "you"
    public static let cookie = "cookie"
    public static let qwenShort = "Qwen3.6"
}

public enum PopupLayout {
    public static let width: CGFloat = 560
    public static let maxHeight: CGFloat = 520
    public static let collapsedHeight: CGFloat = 64
    public static let mascot: CGFloat = 40
    public static let draftTTL: TimeInterval = 600
}

public enum MenuGlyph: String, Equatable, Sendable {
    case idle
    case listening
    case thinking
    case loading
    case down
}

public enum PopupPose: String, Equatable, Sendable {
    case listening
    case thinking
    case talking
    case offline
}

/// Contract decision 11. Down and loading override popup and in-flight chat.
/// A reply in flight is Thinking, including while the popup is open.
/// Popup open and idle is Listening.
public func menuGlyph(
    runtime: RuntimeState,
    popupOpen: Bool,
    replyInFlight: Bool
) -> MenuGlyph {
    switch runtime {
    case .down:
        return .down
    case .loading:
        return .loading
    case .up:
        if replyInFlight { return .thinking }
        if popupOpen { return .listening }
        return .idle
    }
}

public func menuVoiceOver(_ glyph: MenuGlyph) -> String {
    switch glyph {
    case .idle:
        return "Cookie"
    case .listening:
        return "Cookie, listening"
    case .thinking:
        return "Cookie, thinking"
    case .loading:
        return "Cookie, loading"
    case .down:
        return "Cookie, offline"
    }
}

/// Popup mascot, separate from the menu-bar glyph. Streaming chunks are Talking.
/// The menu bar stays Thinking for that same interval (decision 11).
public func popupPose(
    runtime: RuntimeState,
    replyInFlight: Bool,
    cookieTextStarted: Bool
) -> PopupPose {
    switch runtime {
    case .down:
        return .offline
    case .loading:
        return .thinking
    case .up:
        if replyInFlight && cookieTextStarted { return .talking }
        if replyInFlight { return .thinking }
        return .listening
    }
}

public func popupPoseVoiceOver(_ pose: PopupPose) -> String {
    switch pose {
    case .listening:
        return "Cookie, listening"
    case .thinking:
        return "Cookie, thinking"
    case .talking:
        return "Cookie, talking"
    case .offline:
        return "Cookie, offline"
    }
}

public func displayModelID(_ modelID: String?) -> String? {
    guard let modelID, !modelID.isEmpty else { return nil }
    if modelID == defaultModelID { return CookieCopy.qwenShort }
    return modelID
}

public func statusLine(modelID: String?) -> String {
    let base = "🐾 Cookie · on-device"
    guard let shown = displayModelID(modelID) else { return base }
    return "\(base) · \(shown)"
}
