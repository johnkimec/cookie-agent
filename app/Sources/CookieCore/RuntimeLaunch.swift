import Foundation
import CookieProtocol

/// `llama-server` invocation. The executable and arguments are the product
/// command: host, port, context, and the flags John runs on the M1 Max.
public struct RuntimeLaunch: Equatable, Sendable {
    public static let defaultBinary = "/opt/homebrew/bin/llama-server"
    public static let defaultPort = 8080
    public static let defaultModelFile = "Qwen3.6-35B-A3B-Q4_K_M.gguf"
    public static let maxStartAttempts = 3

    public var executable: String
    public var arguments: [String]
    public var port: Int?
    public var modelPath: String
    public var modelId: String
    public var logFile: String
    public var pidFile: String
    /// Extra copy under `~/cookie-runtime/run` when the shell chose the data
    /// directory. The product default is already stable; this still covers a
    /// launch whose `COOKIE_DATA_DIR` was unset.
    public var stablePidFile: String?
    public var dataDirectory: String

    public init(
        executable: String,
        arguments: [String],
        port: Int?,
        modelPath: String,
        modelId: String,
        logFile: String,
        pidFile: String,
        stablePidFile: String?,
        dataDirectory: String
    ) {
        self.executable = executable
        self.arguments = arguments
        self.port = port
        self.modelPath = modelPath
        self.modelId = modelId
        self.logFile = logFile
        self.pidFile = pidFile
        self.stablePidFile = stablePidFile
        self.dataDirectory = dataDirectory
    }

    public static func resolve(
        environment: [String: String],
        homeDirectory: URL,
        dataDirectory: String,
        recordsStablePid: Bool
    ) -> RuntimeLaunch {
        let home = homeDirectory.path
        let modelRaw = nonEmpty(environment["COOKIE_MODEL_PATH"])
            ?? home + "/cookie-runtime/models/" + defaultModelFile
        let modelPath = expandTilde(modelRaw, home: home)
        let executable = expandTilde(
            nonEmpty(environment["COOKIE_LLAMA_SERVER"]) ?? defaultBinary,
            home: home
        )
        let port = parseLlamaPort(environment["COOKIE_LLAMA_PORT"])
        let logs = (dataDirectory as NSString).appendingPathComponent("logs")
        let logFile = (logs as NSString).appendingPathComponent("llama-server.log")
        let pidFile = (logs as NSString).appendingPathComponent("llama-server.pid")
        let stable: String?
        if recordsStablePid, let port {
            stable = home + "/cookie-runtime/run/llama-server-\(port).pid"
        } else {
            stable = nil
        }
        let portText = port.map(String.init) ?? ""
        let arguments = [
            "-m", modelPath,
            "--host", "127.0.0.1",
            "--port", portText,
            "-c", "32768",
            "-np", "1",
            "-ngl", "99",
            "-fa", "on",
            "--jinja",
            "--metrics",
        ]
        return RuntimeLaunch(
            executable: executable,
            arguments: arguments,
            port: port,
            modelPath: modelPath,
            modelId: defaultModelID,
            logFile: logFile,
            pidFile: pidFile,
            stablePidFile: stable,
            dataDirectory: dataDirectory
        )
    }
}

/// Delay before a restart. Step 1 is the first retry.
public func runtimeRestartBackoff(step: Int) -> Double {
    switch step {
    case 1:
        return 1
    case 2:
        return 2
    default:
        return 4
    }
}

public func parseLlamaPort(_ raw: String?) -> Int? {
    guard let raw, !raw.isEmpty else { return RuntimeLaunch.defaultPort }
    guard let value = Int(raw), (1...65535).contains(value), String(value) == raw else {
        return nil
    }
    return value
}

public func expandTilde(_ path: String, home: String) -> String {
    if path == "~" { return home }
    if path.hasPrefix("~/") {
        return home + String(path.dropFirst(1))
    }
    return path
}

public struct RuntimeProcessSpec: Equatable, Sendable {
    public var executable: String
    public var arguments: [String]
    public var logFile: String

    public init(executable: String, arguments: [String], logFile: String) {
        self.executable = executable
        self.arguments = arguments
        self.logFile = logFile
    }
}

public struct OwnedProcess: Equatable, Sendable {
    public var pid: Int32
    public var processGroup: Int32
    public var leadsGroup: Bool

    public init(pid: Int32, processGroup: Int32, leadsGroup: Bool) {
        self.pid = pid
        self.processGroup = processGroup
        self.leadsGroup = leadsGroup
    }
}

public struct RuntimePidRecord: Equatable, Sendable {
    public var pid: Int32
    public var processGroup: Int32
    public var leadsGroup: Bool

    public init(pid: Int32, processGroup: Int32, leadsGroup: Bool) {
        self.pid = pid
        self.processGroup = processGroup
        self.leadsGroup = leadsGroup
    }
}

public enum RuntimeProbe: Equatable, Sendable {
    case up
    case loading
    case down
}

public enum RuntimeSpawnError: Error, Equatable, Sendable {
    case failed(String)
}

public protocol RuntimeLaunching: Sendable {
    func start(_ spec: RuntimeProcessSpec) throws -> OwnedProcess
    func isAlive(_ pid: Int32) -> Bool
    func terminate(pid: Int32, processGroup: Int32, leadsGroup: Bool)
    func forceTerminate(pid: Int32, processGroup: Int32, leadsGroup: Bool)
    func reap(_ pid: Int32) -> Int32?
    func isOurServer(pid: Int32, executable: String) -> Bool
}

public protocol RuntimeHealthChecking: Sendable {
    func probe(port: Int) async -> RuntimeProbe
}

public protocol RuntimePidStoring: Sendable {
    func load() -> RuntimePidRecord?
    func save(_ record: RuntimePidRecord)
    func remove()
}

public protocol RuntimeClock: Sendable {
    func sleep(seconds: Double) async
}

public struct TaskRuntimeClock: RuntimeClock {
    public init() {}

    public func sleep(seconds: Double) async {
        try? await Task.sleep(for: .seconds(seconds))
    }
}

/// `GET /health` the way llama-server answers while weights are loading.
public func interpretHealth(status: Int, body: Data) -> RuntimeProbe {
    if status == 503 { return .loading }
    if status < 200 || status >= 300 { return .down }
    if body.isEmpty { return .up }
    if let object = try? JSONSerialization.jsonObject(with: body) as? [String: Any],
       let value = object["status"] as? String {
        if value == "loading" { return .loading }
        if value == "error" || value == "failed" { return .down }
    }
    return .up
}

public func logShell(_ message: String) {
    let line = "cookie-shell: \(message)\n"
    FileHandle.standardError.write(Data(line.utf8))
}

/// How long Quit waits after SIGTERM before SIGKILL.
public let runtimeStopGraceSeconds = 5.0

private func nonEmpty(_ value: String?) -> String? {
    guard let value, !value.isEmpty else { return nil }
    return value
}
