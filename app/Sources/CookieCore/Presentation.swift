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
    public static let popupRefusal = "cookie.popup.refusal"
    public static let popupLoading = "cookie.popup.loading"
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
    /// Placeholder menu copy, pending John's review.
    public static let startingModel = "🐾 Cookie · starting model…"
    /// Placeholder menu copy, pending John's review.
    public static let modelOffline = "🐾 Cookie · model offline"
    /// Placeholder refusal copy, pending John's review.
    public static let modelNotReady = "Cookie's model isn't ready yet."
    /// Placeholder refusal copy, pending John's review.
    public static let stillAnswering = "Cookie's still answering."
    /// Placeholder loading copy, pending John's review.
    public static let modelLoading = "Loading the model…"
    /// Placeholder menu copy, pending John's review.
    public static let coreNotFound = "🐾 Cookie · core not found"
    /// Placeholder menu copy, pending John's review.
    public static let pnpmNotFound = "🐾 Cookie · pnpm not found"
    /// Placeholder menu copy, pending John's review.
    public static let commandNotFound = "🐾 Cookie · core can't start"
}

public enum ShellLaunchFailure: Equatable, Sendable {
    case coreNotFound
    case pnpmNotFound
    case commandNotFound

    public var statusLine: String {
        switch self {
        case .coreNotFound:
            return CookieCopy.coreNotFound
        case .pnpmNotFound:
            return CookieCopy.pnpmNotFound
        case .commandNotFound:
            return CookieCopy.commandNotFound
        }
    }
}

public enum PopupLayout {
    public static let width: CGFloat = 560
    public static let maxHeight: CGFloat = 520
    public static let collapsedHeight: CGFloat = 64
    public static let mascot: CGFloat = 40
    public static let draftTTL: TimeInterval = 600
}

/// Product default is 10 minutes. `COOKIE_DRAFT_TTL_SECONDS` shortens that
/// window for a drive-mac recipe. Unset, empty, and out-of-range values
/// stay on the product default, and a value cannot lengthen it.
public func resolvedDraftTTL(environment: [String: String]) -> TimeInterval {
    guard let raw = environment["COOKIE_DRAFT_TTL_SECONDS"], !raw.isEmpty else {
        return PopupLayout.draftTTL
    }
    guard let value = Double(raw), value > 0, value <= PopupLayout.draftTTL else {
        return PopupLayout.draftTTL
    }
    return value
}

/// Custom accessibility actions that replay Shift-Return, ⌘K, and Up.
/// System Events keystrokes go to the frontmost app, not this panel.
/// Unset leaves the field's actions unchanged.
public func cookieDriveKeysEnabled(environment: [String: String]) -> Bool {
    environment["COOKIE_DRIVE_KEYS"] == "1"
}

/// Where Shift-Return should insert after an accessibility set.
/// System Events replaces the field text and does not leave the caret
/// where typing would. Unset returns nil so the setter stays as it is.
public func driveCaretLocation(textLength: Int, environment: [String: String]) -> Int? {
    guard cookieDriveKeysEnabled(environment: environment), textLength >= 0 else {
        return nil
    }
    return textLength
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

public let runtimeUnavailableCode = -32002

public enum ChatSendFailurePresentation: Equatable, Sendable {
    /// `-32002` while the runtime is not `down`. Cold load, not a failed send.
    case stillLoading
    case notReady
    case failed
}

public func presentChatSendFailure(code: Int?, runtime: RuntimeState) -> ChatSendFailurePresentation {
    if code == runtimeUnavailableCode {
        if runtime == .down { return .notReady }
        return .stillLoading
    }
    return .failed
}

public func sendEnabled(runtime: RuntimeState) -> Bool {
    runtime != .loading
}

public func popupLoadingLine(runtime: RuntimeState) -> String? {
    guard runtime == .loading else { return nil }
    return CookieCopy.modelLoading
}

public func displayModelID(_ modelID: String?) -> String? {
    guard let modelID, !modelID.isEmpty else { return nil }
    if modelID == defaultModelID { return CookieCopy.qwenShort }
    return modelID
}

public func statusLine(runtime: RuntimeState, modelID: String?) -> String {
    switch runtime {
    case .loading:
        return CookieCopy.startingModel
    case .down:
        return CookieCopy.modelOffline
    case .up:
        let base = "🐾 Cookie · on-device"
        guard let shown = displayModelID(modelID) else { return base }
        return "\(base) · \(shown)"
    }
}
