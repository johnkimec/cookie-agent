import Foundation
import Darwin
import CookieProtocol

public struct URLSessionRuntimeHealth: RuntimeHealthChecking {
    public init() {}

    public func probe(port: Int) async -> RuntimeProbe {
        guard let url = URL(string: "http://127.0.0.1:\(port)/health") else { return .down }
        var request = URLRequest(
            url: url,
            cachePolicy: .reloadIgnoringLocalCacheData,
            timeoutInterval: 2
        )
        request.httpMethod = "GET"
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        do {
            let (data, response) = try await URLSession.shared.data(for: request)
            guard let http = response as? HTTPURLResponse else { return .down }
            return interpretHealth(status: http.statusCode, body: data)
        } catch {
            return .down
        }
    }
}

public struct FileRuntimePidStore: RuntimePidStoring {
    public var path: String

    public init(path: String) {
        self.path = path
    }

    public func load() -> RuntimePidRecord? {
        guard let text = try? String(contentsOfFile: path, encoding: .utf8) else { return nil }
        let parts = text.split(whereSeparator: \.isWhitespace)
        guard parts.count >= 2,
              let pid = Int32(parts[0]),
              let processGroup = Int32(parts[1]),
              pid > 1,
              processGroup > 1 else { return nil }
        let leadsGroup = parts.count >= 3 && parts[2] == "1"
        return RuntimePidRecord(pid: pid, processGroup: processGroup, leadsGroup: leadsGroup)
    }

    public func save(_ record: RuntimePidRecord) {
        let url = URL(fileURLWithPath: path)
        try? FileManager.default.createDirectory(
            at: url.deletingLastPathComponent(),
            withIntermediateDirectories: true
        )
        let flag = record.leadsGroup ? "1" : "0"
        let text = "\(record.pid) \(record.processGroup) \(flag)\n"
        try? text.write(to: url, atomically: true, encoding: .utf8)
    }

    public func remove() {
        try? FileManager.default.removeItem(atPath: path)
    }
}

public struct CompositePidStore: RuntimePidStoring {
    public var stores: [FileRuntimePidStore]

    public init(stores: [FileRuntimePidStore]) {
        self.stores = stores
    }

    public func load() -> RuntimePidRecord? {
        for store in stores {
            if let record = store.load() { return record }
        }
        return nil
    }

    public func save(_ record: RuntimePidRecord) {
        for store in stores {
            store.save(record)
        }
    }

    public func remove() {
        for store in stores {
            store.remove()
        }
    }
}

/// Owns `llama-server` for the life of the app. A healthy server already
/// bound to the port is reused. A pid file from a previous launch is a
/// server this app started; that process group is killed before a new one
/// is spawned. Three crashes in a row publish `down`.
public actor RuntimeSupervisor {
    public nonisolated let events: AsyncStream<RuntimeStatus>
    private let eventsContinuation: AsyncStream<RuntimeStatus>.Continuation
    private let launch: RuntimeLaunch
    private let launcher: any RuntimeLaunching
    private let health: any RuntimeHealthChecking
    private let pidStore: any RuntimePidStoring
    private let clock: any RuntimeClock
    private let pollInterval: Double
    private var stopped = false
    private var ownsProcess = false
    private var watchGeneration = 0
    public private(set) var status: RuntimeStatus

    public init(
        launch: RuntimeLaunch,
        launcher: any RuntimeLaunching,
        health: any RuntimeHealthChecking,
        pidStore: any RuntimePidStoring,
        clock: any RuntimeClock,
        pollInterval: Double = 0.25
    ) {
        self.launch = launch
        self.launcher = launcher
        self.health = health
        self.pidStore = pidStore
        self.clock = clock
        self.pollInterval = pollInterval
        let pair = AsyncStream<RuntimeStatus>.makeStream(bufferingPolicy: .unbounded)
        self.events = pair.stream
        self.eventsContinuation = pair.continuation
        self.status = RuntimeStatus(state: .loading, modelId: launch.modelId)
    }

    public static func live(launch: RuntimeLaunch) -> RuntimeSupervisor {
        var stores = [FileRuntimePidStore(path: launch.pidFile)]
        if let stable = launch.stablePidFile {
            stores.insert(FileRuntimePidStore(path: stable), at: 0)
        }
        return RuntimeSupervisor(
            launch: launch,
            launcher: DarwinRuntimeLauncher(),
            health: URLSessionRuntimeHealth(),
            pidStore: CompositePidStore(stores: stores),
            clock: TaskRuntimeClock()
        )
    }

    public var isOwningProcess: Bool { ownsProcess }

    public func start() async {
        guard launch.port != nil else {
            publish(RuntimeStatus(state: .down, modelId: nil))
            return
        }
        publish(RuntimeStatus(state: .loading, modelId: launch.modelId))
        await reclaimStale()
        if stopped { return }
        guard let port = launch.port else { return }
        switch await health.probe(port: port) {
        case .up:
            ownsProcess = false
            publish(RuntimeStatus(state: .up, modelId: launch.modelId))
        case .loading:
            await waitForExternal(port: port)
        case .down:
            await runOwned(port: port, initialBackoff: false)
        }
    }

    /// Quit. An adopted server (healthy port, no pid of ours) is left running.
    public func stop() {
        stopped = true
        watchGeneration += 1
        guard ownsProcess, let record = pidStore.load() else {
            ownsProcess = false
            return
        }
        launcher.terminate(
            pid: record.pid,
            processGroup: record.processGroup,
            leadsGroup: record.leadsGroup
        )
        _ = launcher.reap(record.pid)
        pidStore.remove()
        ownsProcess = false
    }

    /// Re-read `/health` after a `-32002` so a cold load is not stuck on screen.
    public func confirm() async -> RuntimeStatus {
        guard let port = launch.port, !stopped else { return status }
        switch await health.probe(port: port) {
        case .up:
            publish(RuntimeStatus(state: .up, modelId: launch.modelId))
        case .loading:
            publish(RuntimeStatus(state: .loading, modelId: launch.modelId))
        case .down:
            if !ownsProcess {
                publish(RuntimeStatus(state: .down, modelId: nil))
            }
        }
        return status
    }

    private func publish(_ status: RuntimeStatus) {
        self.status = status
        eventsContinuation.yield(status)
    }

    private func reclaimStale() async {
        guard let record = pidStore.load() else { return }
        if launcher.isAlive(record.pid),
           launcher.isOurServer(pid: record.pid, executable: launch.executable) {
            launcher.terminate(
                pid: record.pid,
                processGroup: record.processGroup,
                leadsGroup: record.leadsGroup
            )
            var spins = 0
            while launcher.isAlive(record.pid), spins < 20, !stopped {
                await clock.sleep(seconds: 0.05)
                spins += 1
            }
            _ = launcher.reap(record.pid)
        }
        pidStore.remove()
    }

    private func waitForExternal(port: Int) async {
        publish(RuntimeStatus(state: .loading, modelId: launch.modelId))
        while !stopped {
            switch await health.probe(port: port) {
            case .up:
                ownsProcess = false
                publish(RuntimeStatus(state: .up, modelId: launch.modelId))
                return
            case .loading:
                await clock.sleep(seconds: pollInterval)
            case .down:
                await runOwned(port: port, initialBackoff: false)
                return
            }
        }
    }

    private func runOwned(port: Int, initialBackoff: Bool) async {
        var failures = 0
        var backoffStep = 1
        var needsBackoff = initialBackoff
        while !stopped {
            if needsBackoff {
                await clock.sleep(seconds: runtimeRestartBackoff(step: backoffStep))
                backoffStep += 1
                needsBackoff = false
                if stopped { return }
            }
            switch await health.probe(port: port) {
            case .up:
                ownsProcess = false
                pidStore.remove()
                publish(RuntimeStatus(state: .up, modelId: launch.modelId))
                return
            case .loading:
                await waitForExternal(port: port)
                return
            case .down:
                break
            }
            failures += 1
            if failures > RuntimeLaunch.maxStartAttempts {
                giveUp()
                return
            }
            publish(RuntimeStatus(state: .loading, modelId: launch.modelId))
            let spec = RuntimeProcessSpec(
                executable: launch.executable,
                arguments: launch.arguments,
                logFile: launch.logFile
            )
            let owned: OwnedProcess
            do {
                owned = try launcher.start(spec)
            } catch {
                needsBackoff = true
                if failures >= RuntimeLaunch.maxStartAttempts {
                    giveUp()
                    return
                }
                continue
            }
            ownsProcess = true
            pidStore.save(RuntimePidRecord(
                pid: owned.pid,
                processGroup: owned.processGroup,
                leadsGroup: owned.leadsGroup
            ))
            switch await waitUntilReady(port: port, owned: owned) {
            case .ready:
                publish(RuntimeStatus(state: .up, modelId: launch.modelId))
                armWatch(owned, port: port)
                return
            case .exited:
                ownsProcess = false
                pidStore.remove()
                if failures >= RuntimeLaunch.maxStartAttempts {
                    giveUp()
                    return
                }
                needsBackoff = true
            case .stopped:
                return
            }
        }
    }

    private func giveUp() {
        ownsProcess = false
        pidStore.remove()
        publish(RuntimeStatus(state: .down, modelId: nil))
    }

    private enum WaitOutcome {
        case ready
        case exited
        case stopped
    }

    private func waitUntilReady(port: Int, owned: OwnedProcess) async -> WaitOutcome {
        while !stopped {
            if !launcher.isAlive(owned.pid) {
                _ = launcher.reap(owned.pid)
                return .exited
            }
            if await health.probe(port: port) == .up {
                return .ready
            }
            await clock.sleep(seconds: pollInterval)
        }
        return .stopped
    }

    private func armWatch(_ owned: OwnedProcess, port: Int) {
        watchGeneration += 1
        let generation = watchGeneration
        Task {
            await self.watchAndRestart(owned, port: port, generation: generation)
        }
    }

    private func watchAndRestart(_ owned: OwnedProcess, port: Int, generation: Int) async {
        while !stopped, generation == watchGeneration {
            if !launcher.isAlive(owned.pid) {
                _ = launcher.reap(owned.pid)
                break
            }
            await clock.sleep(seconds: pollInterval)
        }
        guard !stopped, generation == watchGeneration else { return }
        ownsProcess = false
        pidStore.remove()
        await runOwned(port: port, initialBackoff: true)
    }
}

@_silgen_name("proc_pidpath")
private func cookieProcPidPath(_ pid: Int32, _ buffer: UnsafeMutableRawPointer, _ buffersize: UInt32) -> Int32

public final class DarwinRuntimeLauncher: RuntimeLaunching, @unchecked Sendable {
    private let lock = NSLock()
    private var exitCodes: [Int32: Int32] = [:]

    public init() {}

    /// `posix_spawn` with `POSIX_SPAWN_SETPGROUP` so the server is not in
    /// the app's group. `setpgid` after `Process.run` fails once the child
    /// has exec'd.
    public func start(_ spec: RuntimeProcessSpec) throws -> OwnedProcess {
        let url = URL(fileURLWithPath: spec.logFile)
        do {
            try FileManager.default.createDirectory(
                at: url.deletingLastPathComponent(),
                withIntermediateDirectories: true
            )
        } catch {
            throw RuntimeSpawnError.failed(String(describing: error))
        }
        let fd = open(spec.logFile, O_WRONLY | O_CREAT | O_APPEND, 0o644)
        if fd < 0 {
            throw RuntimeSpawnError.failed("log \(errno)")
        }
        defer { close(fd) }
        let header = "cookie-shell: \(spec.executable) \(spec.arguments.joined(separator: " "))\n"
        _ = header.withCString { pointer in
            Darwin.write(fd, pointer, strlen(pointer))
        }

        var actions: posix_spawn_file_actions_t?
        let initActions = posix_spawn_file_actions_init(&actions)
        if initActions != 0 {
            throw RuntimeSpawnError.failed("file actions \(initActions)")
        }
        defer { posix_spawn_file_actions_destroy(&actions) }
        if posix_spawn_file_actions_adddup2(&actions, fd, STDOUT_FILENO) != 0
            || posix_spawn_file_actions_adddup2(&actions, fd, STDERR_FILENO) != 0
            || posix_spawn_file_actions_addopen(&actions, STDIN_FILENO, "/dev/null", O_RDONLY, 0) != 0 {
            throw RuntimeSpawnError.failed("file actions dup")
        }
        if fd > STDERR_FILENO {
            _ = posix_spawn_file_actions_addclose(&actions, fd)
        }

        var attr: posix_spawnattr_t?
        let initAttr = posix_spawnattr_init(&attr)
        if initAttr != 0 {
            throw RuntimeSpawnError.failed("attr \(initAttr)")
        }
        defer { posix_spawnattr_destroy(&attr) }
        if posix_spawnattr_setflags(&attr, Int16(POSIX_SPAWN_SETPGROUP)) != 0
            || posix_spawnattr_setpgroup(&attr, 0) != 0 {
            throw RuntimeSpawnError.failed("process group")
        }

        var pid: pid_t = 0
        let arguments = [spec.executable] + spec.arguments
        let spawned = arguments.withSpawnArguments { argv in
            posix_spawn(&pid, spec.executable, &actions, &attr, argv, nil)
        }
        if spawned != 0 {
            throw RuntimeSpawnError.failed("posix_spawn \(spawned)")
        }
        return OwnedProcess(pid: pid, processGroup: pid, leadsGroup: true)
    }

    public func isAlive(_ pid: Int32) -> Bool {
        guard pid > 1 else { return false }
        if exitCode(pid) != nil { return false }
        var status: Int32 = 0
        let result = waitpid(pid, &status, WNOHANG)
        if result == pid {
            remember(pid, status: status)
            return false
        }
        if result == 0 { return true }
        if kill(pid, 0) == 0 { return true }
        return errno != ESRCH
    }

    public func terminate(pid: Int32, processGroup: Int32, leadsGroup: Bool) {
        guard pid > 1 else { return }
        if leadsGroup, processGroup > 1 {
            _ = kill(-processGroup, SIGTERM)
        } else {
            _ = kill(pid, SIGTERM)
        }
    }

    public func reap(_ pid: Int32) -> Int32? {
        if let code = exitCode(pid) { return code }
        var status: Int32 = 0
        let result = waitpid(pid, &status, WNOHANG)
        if result == pid {
            let code = decoded(status)
            remember(pid, code: code)
            return code
        }
        return nil
    }

    public func isOurServer(pid: Int32, executable: String) -> Bool {
        guard let path = executablePath(pid: pid) else { return false }
        if path == executable { return true }
        let running = (path as NSString).lastPathComponent
        let expected = (executable as NSString).lastPathComponent
        return !expected.isEmpty && running == expected
    }

    private func exitCode(_ pid: Int32) -> Int32? {
        lock.lock()
        defer { lock.unlock() }
        return exitCodes[pid]
    }

    private func remember(_ pid: Int32, status: Int32) {
        remember(pid, code: decoded(status))
    }

    private func remember(_ pid: Int32, code: Int32) {
        lock.lock()
        exitCodes[pid] = code
        lock.unlock()
    }

    private func decoded(_ status: Int32) -> Int32 {
        if status & 0x7f == 0 {
            return (status >> 8) & 0xff
        }
        return 128 + (status & 0x7f)
    }

    private func executablePath(pid: Int32) -> String? {
        let capacity = 4096
        let buffer = UnsafeMutablePointer<CChar>.allocate(capacity: capacity)
        defer { buffer.deallocate() }
        let count = cookieProcPidPath(pid, buffer, UInt32(capacity))
        guard count > 0 else { return nil }
        return String(cString: buffer)
    }
}

private extension Array where Element == String {
    func withSpawnArguments(
        _ body: (UnsafeMutablePointer<UnsafeMutablePointer<CChar>?>) -> Int32
    ) -> Int32 {
        let copies = map { strdup($0) }
        defer {
            for copy in copies {
                free(copy)
            }
        }
        var pointers: [UnsafeMutablePointer<CChar>?] = copies
        pointers.append(nil)
        return pointers.withUnsafeMutableBufferPointer { buffer in
            body(buffer.baseAddress!)
        }
    }
}
