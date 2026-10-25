import Foundation

public struct CoreLaunch: Equatable, Sendable {
    public var executable: String
    public var arguments: [String]
    public var workingDirectory: URL
    public var environment: [String: String]
    /// The working directory contains `core/package.json`.
    public var coreRootReady: Bool
    /// The core command's first token resolved to an executable file.
    public var commandReady: Bool

    /// `core/package.json` script `start` (`src/index.ts`). `fake-core` is
    /// selected only by `COOKIE_CORE_COMMAND`.
    public static let defaultCommand = "pnpm --filter @cookie-agent/core start"
    /// Product default is 8080, applied by the core when this variable is
    /// absent (contract decision 8). The shell must not substitute the
    /// verification port 18080. Verification exports 18080 itself.
    /// Finder's PATH does not include Homebrew or a user pnpm install.
    public static let toolPathExtras = [
        "/opt/homebrew/bin",
        "/usr/local/bin",
    ]

    public init(
        executable: String,
        arguments: [String],
        workingDirectory: URL,
        environment: [String: String],
        coreRootReady: Bool = true,
        commandReady: Bool = true
    ) {
        self.executable = executable
        self.arguments = arguments
        self.workingDirectory = workingDirectory
        self.environment = environment
        self.coreRootReady = coreRootReady
        self.commandReady = commandReady
    }

    /// Stable product default. Verification sets `COOKIE_DATA_DIR` itself.
    public static let applicationSupportFolder = "com.johnkimec.cookie-agent"

    public static func defaultDataDirectory(home: URL) -> URL {
        home
            .appendingPathComponent("Library", isDirectory: true)
            .appendingPathComponent("Application Support", isDirectory: true)
            .appendingPathComponent(applicationSupportFolder, isDirectory: true)
    }

    public static func resolve(
        environment: [String: String],
        currentDirectory: URL,
        homeDirectory: URL,
        plistRepoRoot: String? = nil,
        bundleURL: URL? = nil,
        toolSearchPaths: [String]? = nil
    ) -> CoreLaunch {
        var env = environment
        if env["COOKIE_DATA_DIR"]?.isEmpty ?? true {
            env["COOKIE_DATA_DIR"] = defaultDataDirectory(home: homeDirectory).path
        }
        if env["COOKIE_LLAMA_PORT"]?.isEmpty ?? false {
            env.removeValue(forKey: "COOKIE_LLAMA_PORT")
        }
        let command = env["COOKIE_CORE_COMMAND"].flatMap { $0.isEmpty ? nil : $0 } ?? defaultCommand
        let parts = command.split(whereSeparator: { $0.isWhitespace }).map(String.init)
        let search = toolSearchPaths ?? Self.toolSearchPaths(
            environment: env,
            homeDirectory: homeDirectory
        )
        if !search.isEmpty {
            env["PATH"] = search.joined(separator: ":")
        }
        let head = parts.first ?? ""
        let resolved = resolveTool(head, searchPaths: search)
        let cwd = resolveCoreRoot(
            environment: env,
            currentDirectory: currentDirectory,
            plistRepoRoot: plistRepoRoot,
            bundleURL: bundleURL
        )
        return CoreLaunch(
            executable: resolved ?? head,
            arguments: Array(parts.dropFirst()),
            workingDirectory: cwd.url,
            environment: env,
            coreRootReady: cwd.ready,
            commandReady: resolved != nil
        )
    }

    /// `COOKIE_CORE_CWD` wins. Otherwise the first directory that contains
    /// `core/package.json`: Info.plist `CookieRepoRoot`, then `<bundle>/../..`,
    /// then a walk up from the current directory.
    static func resolveCoreRoot(
        environment: [String: String],
        currentDirectory: URL,
        plistRepoRoot: String?,
        bundleURL: URL?
    ) -> (url: URL, ready: Bool) {
        if let raw = environment["COOKIE_CORE_CWD"], !raw.isEmpty {
            let url = URL(fileURLWithPath: raw, isDirectory: true)
            return (url, hasCorePackage(url))
        }
        var candidates: [URL] = []
        if let plistRepoRoot, !plistRepoRoot.isEmpty {
            candidates.append(URL(fileURLWithPath: plistRepoRoot, isDirectory: true))
        }
        if let bundleURL {
            let fallback = bundleURL
                .deletingLastPathComponent()
                .deletingLastPathComponent()
            candidates.append(fallback)
        }
        if let found = findRepo(from: currentDirectory) {
            candidates.append(found)
        }
        if let match = candidates.first(where: { hasCorePackage($0) }) {
            return (match, true)
        }
        return (currentDirectory, false)
    }

    public static func hasCorePackage(_ url: URL) -> Bool {
        let marker = url
            .appendingPathComponent("core", isDirectory: true)
            .appendingPathComponent("package.json")
        return FileManager.default.fileExists(atPath: marker.path)
    }

    public static func toolSearchPaths(
        environment: [String: String],
        homeDirectory: URL
    ) -> [String] {
        let home = homeDirectory.path
        var dirs: [String] = []
        let raw = environment["PATH"] ?? ""
        for part in raw.split(separator: ":") {
            let item = String(part)
            if !item.isEmpty, !dirs.contains(item) {
                dirs.append(item)
            }
        }
        let extras = toolPathExtras + [
            home + "/Library/pnpm",
            home + "/.local/share/pnpm",
        ]
        for extra in extras where !dirs.contains(extra) {
            dirs.append(extra)
        }
        return dirs
    }

    public static func resolveTool(_ name: String, searchPaths: [String]) -> String? {
        guard !name.isEmpty else { return nil }
        if name.contains("/") {
            return FileManager.default.isExecutableFile(atPath: name) ? name : nil
        }
        for dir in searchPaths {
            let candidate = (dir as NSString).appendingPathComponent(name)
            if FileManager.default.isExecutableFile(atPath: candidate) {
                return candidate
            }
        }
        return nil
    }

    public static func findRepo(from start: URL) -> URL? {
        var dir = start
        for _ in 0..<8 {
            let marker = dir.appendingPathComponent("pnpm-workspace.yaml")
            if FileManager.default.fileExists(atPath: marker.path) {
                return dir
            }
            let parent = dir.deletingLastPathComponent()
            if parent.path == dir.path { break }
            dir = parent
        }
        return nil
    }

    /// The fake core does not dial llama-server. The shell starts the
    /// runtime only for the real core.
    public var supervisesRuntime: Bool {
        !arguments.contains { $0.contains("fake-core") }
    }

    public func prepareDataDirectory() throws {
        guard let path = environment["COOKIE_DATA_DIR"], !path.isEmpty else { return }
        try FileManager.default.createDirectory(
            atPath: path,
            withIntermediateDirectories: true
        )
    }
}
