import Foundation
import Darwin
import CookieProtocol

public protocol CoreTransport: Sendable {
    func start() throws
    var lines: AsyncStream<String> { get }
    func writeLine(_ text: String) throws
    func closeInput()
    func stop()
}

public final class ProcessTransport: CoreTransport, @unchecked Sendable {
    private let launch: CoreLaunch
    private let process = Process()
    private let stdinPipe = Pipe()
    private let stdoutPipe = Pipe()
    private let stderrPipe = Pipe()
    private let framer = LockedFramer()
    private let continuation: AsyncStream<String>.Continuation
    public let lines: AsyncStream<String>
    private let stderrLock = NSLock()
    private var stderrData = Data()
    private var started = false

    public init(launch: CoreLaunch) {
        self.launch = launch
        let pair = AsyncStream<String>.makeStream(bufferingPolicy: .unbounded)
        self.lines = pair.stream
        self.continuation = pair.continuation
    }

    public func start() throws {
        if started { return }
        started = true
        process.executableURL = URL(fileURLWithPath: launch.executable)
        process.arguments = launch.arguments
        process.currentDirectoryURL = launch.workingDirectory
        process.environment = launch.environment
        process.standardInput = stdinPipe
        process.standardOutput = stdoutPipe
        process.standardError = stderrPipe

        stdoutPipe.fileHandleForReading.readabilityHandler = { [weak self] handle in
            guard let self else { return }
            let data = handle.availableData
            if data.isEmpty {
                handle.readabilityHandler = nil
                self.continuation.finish()
                return
            }
            for item in self.framer.append(data) {
                switch item {
                case .line(let text):
                    self.continuation.yield(text)
                case .tooLong:
                    self.continuation.yield("{")
                }
            }
        }
        stderrPipe.fileHandleForReading.readabilityHandler = { [weak self] handle in
            guard let self else { return }
            let data = handle.availableData
            if data.isEmpty {
                handle.readabilityHandler = nil
                return
            }
            self.stderrLock.lock()
            self.stderrData.append(data)
            self.stderrLock.unlock()
        }
        try process.run()
    }

    public func writeLine(_ text: String) throws {
        guard let data = text.data(using: .utf8) else {
            throw CoreError.unexpected("utf8")
        }
        try writeAll(stdinPipe.fileHandleForWriting, data)
    }

    public func closeInput() {
        try? stdinPipe.fileHandleForWriting.close()
    }

    public func stop() {
        stdoutPipe.fileHandleForReading.readabilityHandler = nil
        stderrPipe.fileHandleForReading.readabilityHandler = nil
        if process.isRunning {
            process.terminate()
        }
        continuation.finish()
    }

    public func stderrText() -> String {
        stderrLock.lock()
        defer { stderrLock.unlock() }
        return String(decoding: stderrData, as: UTF8.self)
    }

    /// Nil when the process is still running after `timeout` seconds.
    public func waitForExit(timeout: TimeInterval) async -> Int32? {
        let process = self.process
        return await withCheckedContinuation { continuation in
            DispatchQueue.global(qos: .utility).async {
                let start = Date()
                while process.isRunning && Date().timeIntervalSince(start) < timeout {
                    Thread.sleep(forTimeInterval: 0.02)
                }
                if process.isRunning {
                    continuation.resume(returning: nil)
                } else {
                    continuation.resume(returning: process.terminationStatus)
                }
            }
        }
    }
}

private func writeAll(_ handle: FileHandle, _ data: Data) throws {
    try data.withUnsafeBytes { raw in
        guard let base = raw.baseAddress else { return }
        var offset = 0
        while offset < raw.count {
            let wrote = Darwin.write(handle.fileDescriptor, base.advanced(by: offset), raw.count - offset)
            if wrote < 0 {
                if errno == EINTR { continue }
                throw CoreError.unexpected("write \(errno)")
            }
            if wrote == 0 {
                throw CoreError.disconnected
            }
            offset += wrote
        }
    }
}

private final class LockedFramer: @unchecked Sendable {
    private var framer = LineFramer()
    private let lock = NSLock()

    func append(_ data: Data) -> [LineFramer.Item] {
        lock.lock()
        defer { lock.unlock() }
        return framer.append(data)
    }
}
