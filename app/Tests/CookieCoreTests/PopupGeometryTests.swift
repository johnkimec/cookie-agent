import XCTest
@testable import CookieCore

final class PopupGeometryTests: XCTestCase {
    func testEmptyIsTheInputRowOnly() {
        XCTAssertEqual(PopupGeometry.panelHeight(transcriptContent: nil), 64)
        XCTAssertEqual(PopupGeometry.panelHeight(transcriptContent: 0), 64)
    }

    func testShortTranscriptCountsItsOwnPadding() {
        // One prompt line (18) + 3 + two reply lines (42) + 4 + label (16) = 83.
        XCTAssertEqual(PopupGeometry.panelHeight(transcriptContent: 83), 83 + 16 + 8 + 1 + 64)
    }

    func testNothingIsClippedBelowTheCap() {
        var h: CGFloat = 1
        while !PopupGeometry.isCapped(transcriptContent: h) {
            let panel = PopupGeometry.panelHeight(transcriptContent: h)
            let viewport = PopupGeometry.transcriptViewport(panelHeight: panel)
            XCTAssertGreaterThanOrEqual(viewport, h + 16 + 8, "content \(h) would be clipped")
            h += 7
        }
    }

    func testCapsAt320AndTheViewportIs255() {
        let panel = PopupGeometry.panelHeight(transcriptContent: 5_000)
        XCTAssertEqual(panel, 320)
        XCTAssertEqual(PopupGeometry.transcriptViewport(panelHeight: panel), 255)
        XCTAssertTrue(PopupGeometry.isCapped(transcriptContent: 5_000))
    }

    func testGrowingFieldPushesTheCapUp() {
        // A three-line field is 64 + 2 * 22.
        XCTAssertEqual(PopupGeometry.panelHeight(transcriptContent: 5_000, inputRowHeight: 108), 320)
        XCTAssertEqual(PopupGeometry.transcriptViewport(panelHeight: 320, inputRowHeight: 108), 211)
    }
}
