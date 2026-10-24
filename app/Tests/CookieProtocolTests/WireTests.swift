import Foundation
import XCTest
@testable import CookieProtocol

final class WireTests: XCTestCase {
    func testGoldenFilesRoundTrip() throws {
        let examples = repoRoot().appendingPathComponent("protocol/examples")
        let files = try FileManager.default.contentsOfDirectory(at: examples, includingPropertiesForKeys: nil)
            .filter { $0.pathExtension == "json" }
            .sorted { $0.lastPathComponent < $1.lastPathComponent }
        XCTAssertGreaterThanOrEqual(files.count, 20)
        for file in files {
            let original = try Data(contentsOf: file)
            let decoded = try decodeWire(data: original)
            let encoded = try encodeWire(decoded)
            let again = try decodeWire(data: encoded)
            XCTAssertEqual(decoded, again, file.lastPathComponent)
            XCTAssertTrue(
                semanticallyEqual(try jsonObject(original), try jsonObject(encoded)),
                "\(file.lastPathComponent) encoded \(String(decoding: encoded, as: UTF8.self))"
            )
        }
    }

    func testDownStatusOmitsNilModelID() throws {
        let file = repoRoot().appendingPathComponent("protocol/examples/runtime.status.notification.down.json")
        let decoded = try decodeWire(data: Data(contentsOf: file))
        guard case .runtimeStatus(let note) = decoded else {
            return XCTFail("expected notification")
        }
        XCTAssertEqual(note.params.state, .down)
        XCTAssertNil(note.params.modelId)
        let encoded = try jsonObject(encodeWire(decoded)) as? [String: Any]
        let params = encoded?["params"] as? [String: Any]
        XCTAssertFalse(params?.keys.contains("modelId") ?? true)
    }

    func testSessionTraceRoundTrip() throws {
        let file = repoRoot().appendingPathComponent("protocol/examples/session.jsonl")
        let text = try String(contentsOf: file, encoding: .utf8)
        let lines = text.split(whereSeparator: \.isNewline).map(String.init)
        XCTAssertEqual(lines.count, 11)
        for line in lines {
            let decoded = try decodeWireLine(line)
            let encoded = try encodeLine(decoded)
            XCTAssertTrue(encoded.hasSuffix("\n"))
            XCTAssertFalse(encoded.hasSuffix("\r\n"))
            XCTAssertTrue(
                semanticallyEqual(try jsonObject(Data(line.utf8)), try jsonObject(Data(encoded.utf8)))
            )
        }
    }

    func testWritersUseNewlineOnly() throws {
        let message = WireMessage.shutdownRequest(RpcRequest(
            id: "9",
            method: "shutdown",
            params: ShutdownParams()
        ))
        let line = try encodeLine(message)
        XCTAssertTrue(line.hasSuffix("\n"))
        XCTAssertFalse(line.contains("\r"))
    }

    func testNullErrorIDIsPreserved() throws {
        let file = repoRoot().appendingPathComponent("protocol/examples/error.parse.json")
        let decoded = try decodeWire(data: Data(contentsOf: file))
        guard case .error(let error) = decoded else { return XCTFail("expected error") }
        XCTAssertNil(error.id)
        let object = try jsonObject(encodeWire(decoded)) as? [String: Any]
        XCTAssertTrue(object?["id"] is NSNull)
    }

    func testNumericIDIsRejected() {
        let json = #"{"jsonrpc":"2.0","id":1,"method":"shutdown","params":{}}"#
        XCTAssertThrowsError(try decodeWireLine(json))
    }

    func testUnknownFieldIsRejected() {
        let json = #"{"jsonrpc":"2.0","id":"1","method":"shutdown","params":{},"extra":true}"#
        XCTAssertThrowsError(try decodeWireLine(json)) { error in
            XCTAssertEqual(error as? WireError, .unknownField("extra"))
        }
    }

    func testArrayIsRejected() {
        XCTAssertThrowsError(try decodeWireLine("[]"))
    }
}

final class FramerTests: XCTestCase {
    func testCRLFAndBlankLinesAndSplitPackets() {
        var framer = LineFramer()
        XCTAssertEqual(framer.append(Data("{\"a\":1".utf8)), [])
        let items = framer.append(Data("}\r\n\n{\"b\":2}\n".utf8))
        XCTAssertEqual(items, [.line("{\"a\":1}"), .line("{\"b\":2}")])
    }

    func testLineLongerThanOneMebibyteIsNotParsed() {
        var framer = LineFramer()
        let big = Data(repeating: 0x61, count: LineFramer.maxLineBytes + 1)
        XCTAssertEqual(framer.append(big), [.tooLong])
        XCTAssertEqual(framer.append(Data("rest\nok\n".utf8)), [.line("ok")])
    }

    func testExactLimitIsALine() {
        var framer = LineFramer()
        var payload = Data(repeating: 0x62, count: LineFramer.maxLineBytes)
        payload.append(0x0A)
        let items = framer.append(payload)
        XCTAssertEqual(items.count, 1)
        guard case .line(let text) = items[0] else {
            return XCTFail("expected a line")
        }
        XCTAssertEqual(text.count, LineFramer.maxLineBytes)
    }
}

private func repoRoot() -> URL {
    var url = URL(fileURLWithPath: #filePath)
    while url.path != "/" {
        if FileManager.default.fileExists(atPath: url.appendingPathComponent("pnpm-workspace.yaml").path) {
            return url
        }
        url.deleteLastPathComponent()
    }
    fatalError("repo root not found from \(#filePath)")
}

private func jsonObject(_ data: Data) throws -> Any {
    let space = Data([0x20, 0x09, 0x0A, 0x0D])
    var start = data.startIndex
    var end = data.endIndex
    while start < end, space.contains(data[start]) { start = data.index(after: start) }
    while end > start, space.contains(data[data.index(before: end)]) {
        end = data.index(before: end)
    }
    return try JSONSerialization.jsonObject(with: data.subdata(in: start..<end))
}

private func semanticallyEqual(_ left: Any, _ right: Any) -> Bool {
    if isNull(left), isNull(right) { return true }
    switch (left, right) {
    case let (lhs as [String: Any], rhs as [String: Any]):
        let keys = Set(lhs.keys).union(rhs.keys)
        for key in keys {
            let leftValue = lhs[key]
            let rightValue = rhs[key]
            if key == "modelId", isNullOrMissing(leftValue), isNullOrMissing(rightValue) {
                continue
            }
            guard let leftValue, let rightValue else { return false }
            if !semanticallyEqual(leftValue, rightValue) { return false }
        }
        return true
    case let (lhs as [Any], rhs as [Any]):
        guard lhs.count == rhs.count else { return false }
        return zip(lhs, rhs).allSatisfy(semanticallyEqual)
    case let (lhs as String, rhs as String):
        return lhs == rhs
    case let (lhs as NSNumber, rhs as NSNumber):
        if isBoolean(lhs) || isBoolean(rhs) {
            return isBoolean(lhs) && isBoolean(rhs) && lhs.boolValue == rhs.boolValue
        }
        return lhs.doubleValue == rhs.doubleValue
    default:
        return false
    }
}

private func isNull(_ value: Any) -> Bool {
    value is NSNull
}

private func isNullOrMissing(_ value: Any?) -> Bool {
    guard let value else { return true }
    return value is NSNull
}

private func isBoolean(_ number: NSNumber) -> Bool {
    CFGetTypeID(number) == CFBooleanGetTypeID()
}
