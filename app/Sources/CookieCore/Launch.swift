import Foundation

public struct CoreLaunch: Equatable, Sendable {
    public var executable: String
    public var arguments: [String]
    public var workingDirectory: URL
    public var environment: [String: String]

    public static let defaultCommand = "pnpm --filter @cookie-agent/core fake-core"
    /// Product default is 8080, applied by the core when this variable is
    /// absent (contract decision 8). The shell must not substitute the
    /// verification port 18080. Verification exports 18080 itself.

    public init(
        executable: String,
        arguments: [String],
        workingDirectory: URL,
        environment: [String: String]
    ) {
        self.executable = executable
        self.arguments = arguments
        self.workingDirectory = workingDirectory
        self.environment = environment
    }

    public static func resolve(
        environment: [String: String],
        currentDirectory: URL,
        temporaryDirectory: URL,
        pid: Int32
    ) -> CoreLaunch {
        var env = environment
        if env["COOKIE_DATA_DIR"]?.isEmpty ?? true {
            let dir = temporaryDirectory.appendingPathComponent("cookie-agent-\(pid)", isDirectory: true)
            env["COOKIE_DATA_DIR"] = dir.path
        }
        if env["COOKIE_LLAMA_PORT"]?.isEmpty ?? false {
            env.removeValue(forKey: "COOKIE_LLAMA_PORT")
        }
        let command = env["COOKIE_CORE_COMMAND"].flatMap { $0.isEmpty ? nil : $0 } ?? defaultCommand
        let parts = command.split(whereSeparator: { $0.isWhitespace }).map(String.init)
        let cwd: URL
        if let raw = env["COOKIE_CORE_CWD"], !raw.isEmpty {
            cwd = URL(fileURLWithPath: raw, isDirectory: true)
        } else if let found = findRepo(from: currentDirectory) {
            cwd = found
        } else {
            cwd = currentDirectory
        }
        return CoreLaunch(
            executable: "/usr/bin/env",
            arguments: parts,
            workingDirectory: cwd,
            environment: env
        )
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

    public func prepareDataDirectory() throws {
        guard let path = environment["COOKIE_DATA_DIR"], !path.isEmpty else { return }
        try FileManager.default.createDirectory(
            atPath: path,
            withIntermediateDirectories: true
        )
    }
}
