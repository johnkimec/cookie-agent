/// Compile-only stand-in for the Cookie app shell.
///
/// Menu bar, popup, permissions, and the llama-server supervisor are not
/// in this target. Product work waits until `docs/cookie-agent.md` has
/// Status `approved`.
public enum CookieAgentApp {
    /// In-app name. The bundle file is `Cookie Agent.app`, not `Cookie.app`.
    public static let displayName = "Cookie"

    /// On-disk app bundle name, chosen so it does not clash with SweetP's Cookie.app.
    public static let bundleFileName = "Cookie Agent.app"
}
