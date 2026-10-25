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
        do {
            try FileManager.default.createDirectory(
                at: url.deletingLastPathComponent(),
                withIntermediateDirectories: true
            )
            let flag = record.leadsGroup ? "1" : "0"
            let text = "\(record.pid) \(record.processGroup) \(flag)\n"
            try text.write(to: url, atomically: true, encoding: .utf8)
            logShell("pid file \(path)")
        } catch {
            logShell("pid file \(path) write failed: \(error)")
        }
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
    private var ownedRecord: RuntimePidRecord?
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
        switch await reclaimStale() {
        case .adopted:
            return
        case .spawn:
            if let port = launch.port, !stopped {
                await runOwned(port: port, initialBackoff: false)
            }
            return
        case .cleared:
            break
        }
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

    /// Quit. A server this app did not launch is left running. An owned
    /// server gets SIGTERM, then SIGKILL if it is still alive after the
    /// grace period. The pid file stays until that process has exited.
    public func stop() async {
        stopped = true
        watchGeneration += 1
        let record = ownedRecord ?? (ownsProcess ? pidStore.load() : nil)
        guard ownsProcess, let record else {
            logShell("runtime stop skipped owns=\(ownsProcess)")
            ownsProcess = false
            ownedRecord = nil
            return
        }
        logShell("runtime stop pid=\(record.pid) pgid=\(record.processGroup)")
        await signalUntilDead(record)
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

    private enum Reclaim {
        /// Kept the recorded server. Do not spawn another.
        case adopted
        /// Recorded server was not healthy and has been killed.
        case spawn
        /// No owned server. The caller probes the port.
        case cleared
    }

    /// A live `llama-server` recorded in the pid file is one we started.
    /// Reuse it when the port is healthy or still loading. Otherwise kill
    /// it before a new server is spawned.
    private func reclaimStale() async -> Reclaim {
        guard let port = launch.port, let record = pidStore.load() else {
            if pidStore.load() != nil {
                pidStore.remove()
            }
            return .cleared
        }
        let alive = launcher.isAlive(record.pid)
        let ours = alive && launcher.isOurServer(
            pid: record.pid,
            executable: launch.executable,
            port: port
        )
        guard ours else {
            pidStore.remove()
            return .cleared
        }
        let owned = OwnedProcess(
            pid: record.pid,
            processGroup: record.processGroup,
            leadsGroup: record.leadsGroup
        )
        switch await health.probe(port: port) {
        case .up:
            remember(record)
            publish(RuntimeStatus(state: .up, modelId: launch.modelId))
            armWatch(owned, port: port)
            return .adopted
        case .loading:
            remember(record)
            switch await waitUntilReady(port: port, owned: owned) {
            case .ready:
                publish(RuntimeStatus(state: .up, modelId: launch.modelId))
                armWatch(owned, port: port)
                return .adopted
            case .exited:
                forgetProcess(removePid: true)
                return .cleared
            case .stopped:
                return .adopted
            }
        case .down:
            await signalUntilDead(record)
            if launcher.isAlive(record.pid) {
                publish(RuntimeStatus(state: .down, modelId: nil))
                return .adopted
            }
            return .spawn
        }
    }

    private func remember(_ record: RuntimePidRecord) {
        ownsProcess = true
        ownedRecord = record
    }

    private func forgetProcess(removePid: Bool) {
        ownsProcess = false
        ownedRecord = nil
        if removePid {
            pidStore.remove()
        }
    }

    /// SIGTERM the process group, wait, then SIGKILL. Remove the pid file
    /// only after the process is gone so the next launch can still find it.
    private func signalUntilDead(_ record: RuntimePidRecord) async {
        launcher.terminate(
            pid: record.pid,
            processGroup: record.processGroup,
            leadsGroup: record.leadsGroup
        )
        if await waitUntilDead(record.pid, seconds: runtimeStopGraceSeconds) {
            _ = launcher.reap(record.pid)
            forgetProcess(removePid: true)
            return
        }
        logShell("runtime SIGKILL pid=\(record.pid) pgid=\(record.processGroup)")
        launcher.forceTerminate(
            pid: record.pid,
            processGroup: record.processGroup,
            leadsGroup: record.leadsGroup
        )
        if await waitUntilDead(record.pid, seconds: 2) {
            _ = launcher.reap(record.pid)
            forgetProcess(removePid: true)
            return
        }
        logShell("runtime pid \(record.pid) still alive; keeping \(launch.pidFile)")
        forgetProcess(removePid: false)
    }

    private func waitUntilDead(_ pid: Int32, seconds: Double) async -> Bool {
        let slice = 0.05
        var waited = 0.0
        while launcher.isAlive(pid) {
            if waited >= seconds { return false }
            let step = min(slice, seconds - waited)
            await clock.sleep(seconds: step)
            waited += step
        }
        return true
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
                forgetProcess(removePid: true)
                publish(RuntimeStatus(state: .up, modelId: launch.modelId))
                return
            case .loading:
                await waitForExternal(port: port)
                return
            case .down:
                break
            }
            // Quit can land during the probe. Starting after that leaves a
            // server this app no longer owns.
            if stopped { return }
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
            let record = RuntimePidRecord(
                pid: owned.pid,
                processGroup: owned.processGroup,
                leadsGroup: owned.leadsGroup
            )
            remember(record)
            pidStore.save(record)
            if pidStore.load()?.pid != record.pid {
                logShell("pid file \(launch.pidFile) missing after save")
            }
            switch await waitUntilReady(port: port, owned: owned) {
            case .ready:
                publish(RuntimeStatus(state: .up, modelId: launch.modelId))
                armWatch(owned, port: port)
                return
            case .exited:
                forgetProcess(removePid: true)
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
        forgetProcess(removePid: true)
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
        forgetProcess(removePid: true)
        await runOwned(port: port, initialBackoff: true)
    }
}

/// Chat server plus the optional embedding server. Each one is a
/// `RuntimeSupervisor`. Embed failures stay on the embed instance.
public struct RuntimeServers: Sendable {
    public let chat: RuntimeSupervisor
    public let embed: RuntimeSupervisor?

    public init(chat: RuntimeSupervisor, embed: RuntimeSupervisor?) {
        self.chat = chat
        self.embed = embed
    }

    public func start() async {
        async let chatStarted: Void = chat.start()
        if let embed {
            async let embedStarted: Void = embed.start()
            _ = await (chatStarted, embedStarted)
        } else {
            await chatStarted
        }
    }

    /// SIGTERM both process groups together. Returns after each owned
    /// server has exited and that server's pid file has been removed.
    public func stop() async {
        async let chatStopped: Void = chat.stop()
        if let embed {
            async let embedStopped: Void = embed.stop()
            _ = await (chatStopped, embedStopped)
        } else {
            await chatStopped
        }
    }
}

public struct RuntimeServerPlan: Sendable {
    public var chatLaunch: RuntimeLaunch
    public var embedLaunch: RuntimeLaunch
    public var embedSkip: String?
    public var servers: RuntimeServers

    public init(
        chatLaunch: RuntimeLaunch,
        embedLaunch: RuntimeLaunch,
        embedSkip: String?,
        servers: RuntimeServers
    ) {
        self.chatLaunch = chatLaunch
        self.embedLaunch = embedLaunch
        self.embedSkip = embedSkip
        self.servers = servers
    }
}

public extension RuntimeServers {
    /// Build both supervisors. A missing embed model, an invalid
    /// `COOKIE_EMBED_PORT`, or an embed port equal to the chat port skips
    /// the embedder and leaves chat running.
    static func make(
        environment: [String: String],
        homeDirectory: URL,
        dataDirectory: String,
        recordsStablePid: Bool,
        modelExists: @escaping @Sendable (String) -> Bool = { path in
            FileManager.default.fileExists(atPath: path)
        },
        chatFactory: @escaping @Sendable (RuntimeLaunch) -> RuntimeSupervisor = { launch in
            RuntimeSupervisor.live(launch: launch)
        },
        embedFactory: @escaping @Sendable (RuntimeLaunch) -> RuntimeSupervisor = { launch in
            RuntimeSupervisor.live(launch: launch)
        }
    ) -> RuntimeServerPlan {
        let chatLaunch = RuntimeLaunch.resolve(
            environment: environment,
            homeDirectory: homeDirectory,
            dataDirectory: dataDirectory,
            recordsStablePid: recordsStablePid
        )
        let embedLaunch = RuntimeLaunch.resolveEmbed(
            environment: environment,
            homeDirectory: homeDirectory,
            dataDirectory: dataDirectory,
            recordsStablePid: recordsStablePid
        )
        let chat = chatFactory(chatLaunch)
        let embed: RuntimeSupervisor?
        let skip: String?
        if embedLaunch.port == nil {
            let raw = environment["COOKIE_EMBED_PORT"] ?? ""
            skip = "embed port invalid \(raw); skipping llama-embed"
            embed = nil
        } else if let embedPort = embedLaunch.port, embedPort == chatLaunch.port {
            skip = "embed port \(embedPort) matches chat port; skipping llama-embed"
            embed = nil
        } else if !modelExists(embedLaunch.modelPath) {
            skip = "embed model missing \(embedLaunch.modelPath); skipping llama-embed"
            embed = nil
        } else {
            skip = nil
            embed = embedFactory(embedLaunch)
        }
        return RuntimeServerPlan(
            chatLaunch: chatLaunch,
            embedLaunch: embedLaunch,
            embedSkip: skip,
            servers: RuntimeServers(chat: chat, embed: embed)
        )
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
        signal(pid: pid, processGroup: processGroup, leadsGroup: leadsGroup, sig: SIGTERM)
    }

    public func forceTerminate(pid: Int32, processGroup: Int32, leadsGroup: Bool) {
        signal(pid: pid, processGroup: processGroup, leadsGroup: leadsGroup, sig: SIGKILL)
    }

    private func signal(pid: Int32, processGroup: Int32, leadsGroup: Bool, sig: Int32) {
        guard pid > 1 else { return }
        if leadsGroup, processGroup > 1 {
            _ = kill(-processGroup, sig)
        } else {
            _ = kill(pid, sig)
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

    public func isOurServer(pid: Int32, executable: String, port: Int) -> Bool {
        guard let path = executablePath(pid: pid) else { return false }
        let running = (path as NSString).lastPathComponent
        let expected = (executable as NSString).lastPathComponent
        let sameBinary = path == executable || (!expected.isEmpty && running == expected)
        guard sameBinary, let arguments = processArguments(pid: pid) else { return false }
        return commandArgumentsContainPort(arguments, port: port)
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

    /// `KERN_PROCARGS2`: argc, the exec path, NUL padding, then argv.
    private func processArguments(pid: Int32) -> [String]? {
        var mib: [Int32] = [CTL_KERN, KERN_PROCARGS2, pid]
        var size = 0
        if sysctl(&mib, u_int(mib.count), nil, &size, nil, 0) != 0 || size <= MemoryLayout<Int32>.size {
            return nil
        }
        let buffer = UnsafeMutablePointer<CChar>.allocate(capacity: size)
        defer { buffer.deallocate() }
        var copied = size
        if sysctl(&mib, u_int(mib.count), buffer, &copied, nil, 0) != 0 || copied <= MemoryLayout<Int32>.size {
            return nil
        }
        let argc = buffer.withMemoryRebound(to: Int32.self, capacity: 1) { $0.pointee }
        guard argc > 0 else { return nil }
        var cursor = buffer.advanced(by: MemoryLayout<Int32>.size)
        let end = buffer.advanced(by: copied)
        while cursor < end, cursor.pointee != 0 {
            cursor = cursor.advanced(by: 1)
        }
        while cursor < end, cursor.pointee == 0 {
            cursor = cursor.advanced(by: 1)
        }
        var arguments: [String] = []
        arguments.reserveCapacity(Int(argc))
        for _ in 0..<argc {
            guard cursor < end else { return nil }
            let word = String(cString: cursor)
            arguments.append(word)
            cursor = cursor.advanced(by: word.utf8.count + 1)
        }
        return arguments
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
