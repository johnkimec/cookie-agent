import Carbon
import Foundation

/// Global ⌥Space. Carbon `RegisterEventHotKey` needs no Accessibility grant.
/// The callback is not on the main thread; `action` hops there.
final class HotkeyCenter: @unchecked Sendable {
    private let action: @Sendable () -> Void
    private var hotKey: EventHotKeyRef?
    private var handler: EventHandlerRef?

    init(action: @escaping @Sendable () -> Void) {
        self.action = action
    }

    func install() {
        var spec = EventTypeSpec(
            eventClass: OSType(kEventClassKeyboard),
            eventKind: UInt32(kEventHotKeyPressed)
        )
        let target = GetApplicationEventTarget()
        let pointer = Unmanaged.passUnretained(self).toOpaque()
        InstallEventHandler(target, hotkeyCallback, 1, &spec, pointer, &handler)
        let id = EventHotKeyID(signature: OSType(0x434B_4945), id: 1)
        let status = RegisterEventHotKey(
            UInt32(kVK_Space),
            UInt32(optionKey),
            id,
            target,
            0,
            &hotKey
        )
        if status != noErr {
            FileHandle.standardError.write(Data(
                "cookie-shell: RegisterEventHotKey failed \(status). Another app may own ⌥Space.\n".utf8
            ))
        }
    }
}

private let hotkeyCallback: EventHandlerProcPtr = { _, _, userData in
    guard let userData else { return noErr }
    let center = Unmanaged<HotkeyCenter>.fromOpaque(userData).takeUnretainedValue()
    center.fire()
    return noErr
}

extension HotkeyCenter {
    fileprivate func fire() {
        action()
    }
}
