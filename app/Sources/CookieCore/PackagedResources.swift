import Foundation

/// Resource bundles SwiftPM emits beside `CookieAgent` for the markdown
/// renderer. `Bundle.module` looks in `Bundle.main.resourceURL` first, which
/// is `Cookie Agent.app/Contents/Resources` when the shell is the packaged app.
public enum PackagedResourceBundles {
    public static let math = "iosMath_iosMath.bundle"
    public static let highlight = "HighlightSwift_HighlightSwift.bundle"
    public static let markdown = "SwiftStreamingMarkdown_SwiftStreamingMarkdown.bundle"

    public static let required = [math, highlight, markdown]

    /// `Bundle(url:)` for `Contents/Resources/<name>` inside an `.app`.
    /// That is the candidate `Bundle.module` tries first at runtime.
    public static func bundle(named name: String, inApp appURL: URL) -> Bundle? {
        let url = appURL
            .appendingPathComponent("Contents", isDirectory: true)
            .appendingPathComponent("Resources", isDirectory: true)
            .appendingPathComponent(name, isDirectory: true)
        return Bundle(url: url)
    }
}
