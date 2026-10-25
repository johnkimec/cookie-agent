import XCTest
@testable import CookieCore

/// The packaged app finds SwiftPM resource bundles inside
/// `Cookie Agent.app/Contents/Resources`, which is where `Bundle.module` looks first.
final class PackagedResourceTests: XCTestCase {
    func testPackagedAppFindsResourceBundles() throws {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("cookie-app-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let app = root.appendingPathComponent("Cookie Agent.app", isDirectory: true)
        let resources = app
            .appendingPathComponent("Contents", isDirectory: true)
            .appendingPathComponent("Resources", isDirectory: true)
        try FileManager.default.createDirectory(at: resources, withIntermediateDirectories: true)
        let info = """
        <?xml version="1.0" encoding="UTF-8"?>
        <!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
        <plist version="1.0"><dict></dict></plist>
        """
        for name in PackagedResourceBundles.required {
            let bundleURL = resources.appendingPathComponent(name, isDirectory: true)
            try FileManager.default.createDirectory(at: bundleURL, withIntermediateDirectories: true)
            try Data("marker".utf8).write(to: bundleURL.appendingPathComponent("marker.txt"))
            try info.write(to: bundleURL.appendingPathComponent("Info.plist"), atomically: true, encoding: .utf8)
        }

        for name in PackagedResourceBundles.required {
            let bundle = try XCTUnwrap(PackagedResourceBundles.bundle(named: name, inApp: app))
            XCTAssertEqual(bundle.bundleURL.lastPathComponent, name)
            XCTAssertTrue(bundle.bundleURL.path.hasPrefix(app.path))
            let marker = bundle.url(forResource: "marker", withExtension: "txt")
            XCTAssertEqual(marker?.lastPathComponent, "marker.txt")
            XCTAssertTrue(marker?.path.hasPrefix(app.path) ?? false)
        }
        XCTAssertNil(PackagedResourceBundles.bundle(named: "Missing.bundle", inApp: app))
    }
}
