import Foundation

/// Hops onto the main thread without `DispatchQueue.main`.
///
/// `NSApp.terminate` with `.terminateLater` spins a modal run loop until
/// `reply(toApplicationShouldTerminate:)`. The main queue will not start
/// another block while the current one is still inside that call, so a
/// reply scheduled with `DispatchQueue.main.async` never runs. The run
/// loop does run blocks scheduled for `.modalPanel`.
public enum TerminationHop {
    /// `NSModalPanelRunLoopMode`. AppKit exposes this as
    /// `RunLoop.Mode.modalPanel`; Foundation does not.
    public static let modalPanel = RunLoop.Mode(rawValue: "NSModalPanelRunLoopMode")
    /// `NSEventTrackingRunLoopMode`. A status-item menu runs in this mode.
    /// AppKit exposes it as `RunLoop.Mode.eventTracking`.
    public static let eventTracking = RunLoop.Mode(rawValue: "NSEventTrackingRunLoopMode")

    /// `RunLoop.perform` with no modes waits for the default mode only.
    /// drive-mac's menu read leaves the app in event-tracking mode, so a
    /// SIGTERM hop queued for the default mode never calls `terminate`.
    public static let signalModes: [RunLoop.Mode] = [.default, eventTracking, modalPanel]

    /// Modes `NSApplication` uses while `.terminateLater` is pending.
    /// `.common` includes the modal-panel mode; listing both matches the
    /// run loop `terminate` actually spins.
    public static let replyModes: [RunLoop.Mode] = [.common, modalPanel]

    /// Core `shutdown` timeout, then SIGTERM grace, then the SIGKILL wait.
    /// A shorter backstop can reply while the owned server is still alive.
    public static let coreShutdownSeconds = 5.0
    public static let sigkillWaitSeconds = 2.0
    public static let replyBackstopSeconds =
        coreShutdownSeconds + runtimeStopGraceSeconds + sigkillWaitSeconds + 3.0

    /// Enter `NSApp.terminate` from the main run loop, not from a main-queue
    /// block. A signal source calls this from a background queue. The block
    /// is registered for the default, event-tracking, and modal-panel modes
    /// so an open status menu cannot swallow it.
    public static func perform(_ body: @escaping @Sendable () -> Void) {
        RunLoop.main.perform(inModes: signalModes, block: body)
        CFRunLoopWakeUp(RunLoop.main.getCFRunLoop())
    }

    /// Deliver the terminate reply while `.terminateLater` is spinning.
    public static func performDuringTerminate(_ body: @escaping @Sendable () -> Void) {
        RunLoop.main.perform(inModes: replyModes, block: body)
        CFRunLoopWakeUp(RunLoop.main.getCFRunLoop())
    }

    /// Fires even when the main queue is blocked inside `terminate`.
    public static func performDuringTerminate(
        after seconds: TimeInterval,
        _ body: @escaping @Sendable () -> Void
    ) {
        DispatchQueue.global(qos: .userInitiated).asyncAfter(deadline: .now() + seconds) {
            performDuringTerminate(body)
        }
    }
}
