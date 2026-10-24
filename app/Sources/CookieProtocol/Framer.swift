import Foundation

/// Newline-delimited framing. Writers use `\n` only. Readers accept `\n` and `\r\n`.
/// Blank lines are ignored. A line longer than 1 MiB is not parsed.
public struct LineFramer: Sendable {
    public static let maxLineBytes = 1_048_576

    public enum Item: Equatable, Sendable {
        case line(String)
        case tooLong
    }

    private var buffer = Data()
    private var skipping = false

    public init() {}

    public mutating func append(_ data: Data) -> [Item] {
        var items: [Item] = []
        for byte in data {
            if skipping {
                if byte == 0x0A {
                    skipping = false
                }
                continue
            }
            if byte == 0x0A {
                if buffer.last == 0x0D {
                    buffer.removeLast()
                }
                if buffer.isEmpty {
                    continue
                }
                if buffer.count > Self.maxLineBytes {
                    items.append(.tooLong)
                } else if let text = String(data: buffer, encoding: .utf8) {
                    items.append(.line(text))
                } else {
                    items.append(.tooLong)
                }
                buffer.removeAll(keepingCapacity: true)
                continue
            }
            buffer.append(byte)
            if buffer.count > Self.maxLineBytes {
                items.append(.tooLong)
                buffer.removeAll(keepingCapacity: true)
                skipping = true
            }
        }
        return items
    }
}
