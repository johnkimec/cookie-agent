// CookieMark.swift
// The Cookie mascot as drawn paths, not a bitmap, so it stays sharp at 18 pt and 40 pt.
// Geometry is in a 100-unit space; the visible area is the viewBox "3 -4 94 94" from the HTML mascot sheet.
// The shape data under CookieShapes is generated from the same geometry as the sheet. Redraw it, don't hand-edit it.

import AppKit
import CookieCore
import SwiftUI

public enum CookiePose: String, CaseIterable {
    case idle        // ears down
    case listening   // ears lifted
    case thinking    // two dots
    case talking     // tongue
    case loading     // dotted outline (menu bar: model loading)
    case offline     // dotted outline and a slash

    var isGhost: Bool { self == .loading || self == .offline }

    /// Menu and popup VoiceOver. Idle is the menu at rest.
    /// Loading stays "Cookie, loading", the string the menu already publishes.
    public var spoken: String {
        switch self {
        case .idle: return "Cookie"
        case .listening: return "Cookie, listening"
        case .thinking: return "Cookie, thinking"
        case .talking: return "Cookie, talking"
        case .loading: return "Cookie, loading"
        case .offline: return "Cookie, offline"
        }
    }

    public init(menu glyph: MenuGlyph) {
        switch glyph {
        case .idle: self = .idle
        case .listening: self = .listening
        case .thinking: self = .thinking
        case .loading: self = .loading
        case .down: self = .offline
        }
    }

    public init(popup pose: PopupPose) {
        switch pose {
        case .listening: self = .listening
        case .thinking: self = .thinking
        case .talking: self = .talking
        case .offline: self = .offline
        }
    }
}

public struct CookieMark: View {
    public enum Style { case color, template }

    public var pose: CookiePose
    public var style: Style

    @Environment(\.colorScheme) private var scheme

    public init(pose: CookiePose, style: Style = .color) {
        self.pose = pose
        self.style = style
    }

    public var body: some View {
        Canvas { ctx, size in
            let s = min(size.width, size.height) / 94
            var c = ctx
            c.translateBy(x: (size.width - 94 * s) / 2, y: (size.height - 94 * s) / 2)
            c.scaleBy(x: s, y: s)
            c.translateBy(x: -3, y: 4)   // viewBox origin "3 -4"
            switch style {
            case .color: drawColor(&c)
            case .template: drawTemplate(&c)
            }
        }
        .aspectRatio(1, contentMode: .fit)
        // Accessibility is set at the call site (the popup gives it id cookie.popup.mascot and the spoken pose).
    }

    // MARK: Palette (sampled from the reference photo, coat lifted to offset its warm cast)

    private static let coat = Color(red: 0xEF / 255, green: 0xE4 / 255, blue: 0xD2 / 255)
    private static let muzzle = Color(red: 0xD1 / 255, green: 0xA7 / 255, blue: 0x80 / 255)
    private static let brow = Color(red: 0xC9 / 255, green: 0x9A / 255, blue: 0x78 / 255)
    private static let lock = Color(red: 0xCD / 255, green: 0xB5 / 255, blue: 0x97 / 255)
    private static let nose = Color(red: 0x32 / 255, green: 0x24 / 255, blue: 0x20 / 255)
    private static let tongue = Color(red: 0xE5 / 255, green: 0x8F / 255, blue: 0x9A / 255)
    private static let lineLight = Color(red: 0x4A / 255, green: 0x3A / 255, blue: 0x30 / 255)
    private static let lineDark = Color(red: 0x2E / 255, green: 0x2E / 255, blue: 0x31 / 255)

    // MARK: Parts that aren't traced paths

    private static func ellipse(_ cx: CGFloat, _ cy: CGFloat, _ rx: CGFloat, _ ry: CGFloat) -> Path {
        Path(ellipseIn: CGRect(x: cx - rx, y: cy - ry, width: rx * 2, height: ry * 2))
    }
    private static let eyeL = ellipse(40.5, 47.5, 4.2, 4.5)
    private static let eyeR = ellipse(60.5, 46.5, 4.2, 4.5)
    private static let browL = ellipse(40.5, 47.5, 8, 6)
    private static let browR = ellipse(60.5, 46.5, 8, 6)
    private static let noseShape: Path = {
        var p = Path()
        p.move(to: CGPoint(x: 44.5, y: 60.5))
        p.addCurve(to: CGPoint(x: 50.5, y: 57), control1: CGPoint(x: 44.5, y: 58), control2: CGPoint(x: 47.5, y: 57))
        p.addCurve(to: CGPoint(x: 56.5, y: 60.5), control1: CGPoint(x: 53.5, y: 57), control2: CGPoint(x: 56.5, y: 58))
        p.addCurve(to: CGPoint(x: 50.5, y: 66.5), control1: CGPoint(x: 56.5, y: 64), control2: CGPoint(x: 52.5, y: 66.5))
        p.addCurve(to: CGPoint(x: 44.5, y: 60.5), control1: CGPoint(x: 48.5, y: 66.5), control2: CGPoint(x: 44.5, y: 64))
        p.closeSubpath()
        return p
    }()
    private static let tongueShape: Path = {
        var p = Path()
        p.move(to: CGPoint(x: 46, y: 70))
        p.addQuadCurve(to: CGPoint(x: 55, y: 70), control: CGPoint(x: 50.5, y: 80))
        p.closeSubpath()
        return p
    }()
    private static let dotSmall = ellipse(82, 14, 2.8, 2.8)
    private static let dotLarge = ellipse(91, 7, 3.8, 3.8)
    private static let slash: Path = {
        var p = Path()
        p.move(to: CGPoint(x: 10, y: 92))
        p.addLine(to: CGPoint(x: 90, y: 8))
        return p
    }()

    private var locksL: [Path] { [CookieShapes.locksL0, CookieShapes.locksL1] }
    private var locksR: [Path] { [CookieShapes.locksR0, CookieShapes.locksR1] }

    private static func rotated(_ g: GraphicsContext, _ degrees: Double, about p: CGPoint) -> GraphicsContext {
        var h = g
        h.translateBy(x: p.x, y: p.y)
        h.rotate(by: .degrees(degrees))
        h.translateBy(x: -p.x, y: -p.y)
        return h
    }

    private var lift: Double { pose == .listening ? 15 : 0 }

    // MARK: Full-colour

    private func drawColor(_ ctx: inout GraphicsContext) {
        let line = scheme == .dark ? Self.lineDark : Self.lineLight
        let lw: CGFloat = 1.1
        let join = StrokeStyle(lineWidth: lw, lineJoin: .round)

        if pose.isGhost {
            let dashed = StrokeStyle(lineWidth: 1.4, lineJoin: .round, dash: [2.5, 2.5])
            var g = Self.rotated(ctx, -5, about: CGPoint(x: 50, y: 52))
            for p in [CookieShapes.earL, CookieShapes.earR, CookieShapes.knot, CookieShapes.head] {
                g.stroke(p, with: .color(.secondary), style: dashed)
            }
            for p in [Self.eyeL, Self.eyeR, Self.noseShape] { g.fill(p, with: .color(.secondary)) }
            if pose == .offline {
                ctx.stroke(Self.slash, with: .color(.primary), style: StrokeStyle(lineWidth: 1.6, lineCap: .round))
            }
            return
        }

        var g = Self.rotated(ctx, -5, about: CGPoint(x: 50, y: 52))

        // Ears sit behind the head.
        var l = Self.rotated(g, lift, about: CGPoint(x: 31, y: 29))
        l.fill(CookieShapes.earL, with: .color(Self.coat))
        l.stroke(CookieShapes.earL, with: .color(line), style: join)
        for p in locksL { l.stroke(p, with: .color(Self.lock), style: StrokeStyle(lineWidth: 1.2, lineCap: .round)) }

        var r = Self.rotated(g, -lift, about: CGPoint(x: 69, y: 29))
        r.fill(CookieShapes.earR, with: .color(Self.coat))
        r.stroke(CookieShapes.earR, with: .color(line), style: join)
        for p in locksR { r.stroke(p, with: .color(Self.lock), style: StrokeStyle(lineWidth: 1.2, lineCap: .round)) }

        for p in [CookieShapes.knot, CookieShapes.head] {
            g.fill(p, with: .color(Self.coat))
            g.stroke(p, with: .color(line), style: join)
        }

        g.fill(CookieShapes.muzzle, with: .color(Self.muzzle.opacity(0.75)))
        g.fill(Self.browL, with: .color(Self.brow.opacity(0.4)))
        g.fill(Self.browR, with: .color(Self.brow.opacity(0.4)))
        for p in [CookieShapes.fur0, CookieShapes.fur1, CookieShapes.fur2] {
            g.stroke(p, with: .color(Self.lock), style: StrokeStyle(lineWidth: 1.2, lineCap: .round))
        }

        if pose == .talking {
            g.fill(Self.tongueShape, with: .color(Self.tongue))
            g.stroke(Self.tongueShape, with: .color(line), style: StrokeStyle(lineWidth: 0.9, lineJoin: .round))
        }

        g.fill(Self.eyeL, with: .color(Self.nose))
        g.fill(Self.eyeR, with: .color(Self.nose))
        g.fill(Self.ellipse(42, 45.8, 1.4, 1.4), with: .color(.white))
        g.fill(Self.ellipse(62, 44.8, 1.4, 1.4), with: .color(.white))
        g.fill(Self.noseShape, with: .color(Self.nose))
        g.fill(Self.ellipse(48.5, 59.5, 2, 1), with: .color(.white.opacity(0.55)))

        if pose == .thinking {
            ctx.fill(Self.dotSmall, with: .color(.secondary))
            ctx.fill(Self.dotLarge, with: .color(.secondary))
        }
    }

    // MARK: Template (menu bar): one colour, features cut out with the clear blend mode

    private func drawTemplate(_ ctx: inout GraphicsContext) {
        let solid = GraphicsContext.Shading.color(.black)
        var g = Self.rotated(ctx, -5, about: CGPoint(x: 50, y: 52))

        if pose.isGhost {
            let dashed = StrokeStyle(lineWidth: 2.2, lineJoin: .round, dash: [3, 3])
            for p in [CookieShapes.earL, CookieShapes.earR, CookieShapes.knot, CookieShapes.head] {
                g.stroke(p, with: solid, style: dashed)
            }
            for p in [Self.eyeL, Self.eyeR, Self.noseShape] { g.fill(p, with: solid) }
            if pose == .offline {
                ctx.stroke(Self.slash, with: solid, style: StrokeStyle(lineWidth: 2.4, lineCap: .round))
            }
            return
        }

        var l = Self.rotated(g, lift, about: CGPoint(x: 31, y: 29))
        l.fill(CookieShapes.earL, with: solid)
        var r = Self.rotated(g, -lift, about: CGPoint(x: 69, y: 29))
        r.fill(CookieShapes.earR, with: solid)
        g.fill(CookieShapes.knot, with: solid)

        // A clear ring around the head separates it from ears and topknot.
        var cut = g
        cut.blendMode = .clear
        cut.stroke(CookieShapes.head, with: solid, style: StrokeStyle(lineWidth: 2.2, lineJoin: .round))
        g.fill(CookieShapes.head, with: solid)

        cut.fill(Self.eyeL, with: solid)
        cut.fill(Self.eyeR, with: solid)
        cut.fill(Self.noseShape, with: solid)
        var cutEarL = Self.rotated(cut, lift, about: CGPoint(x: 31, y: 29))
        var cutEarR = Self.rotated(cut, -lift, about: CGPoint(x: 69, y: 29))
        for p in locksL { cutEarL.stroke(p, with: solid, style: StrokeStyle(lineWidth: 1.4, lineCap: .round)) }
        for p in locksR { cutEarR.stroke(p, with: solid, style: StrokeStyle(lineWidth: 1.4, lineCap: .round)) }

        if pose == .thinking {
            ctx.fill(Self.dotSmall, with: solid)
            ctx.fill(Self.dotLarge, with: solid)
        }
    }
}

// MARK: - Menu bar image

public enum CookieGlyph {
    /// 18 pt template image for MenuBarExtra. macOS tints it for light, dark and the selected state.
    @MainActor
    public static func image(for pose: CookiePose) -> NSImage {
        let renderer = ImageRenderer(content: CookieMark(pose: pose, style: .template).frame(width: 18, height: 18))
        renderer.scale = NSScreen.main?.backingScaleFactor ?? 2
        let image = renderer.nsImage ?? NSImage(size: NSSize(width: 18, height: 18))
        image.isTemplate = true
        return image
    }
}

// MARK: - Generated shape data

enum CookieShapes {
    static let head: Path = {
        var p = Path()
        p.move(to: CGPoint(x: 78.7, y: 56.4))
        p.addCurve(to: CGPoint(x: 74.1, y: 62.8), control1: CGPoint(x: 77.7, y: 61.1), control2: CGPoint(x: 76.7, y: 58.3))
        p.addCurve(to: CGPoint(x: 71, y: 69.9), control1: CGPoint(x: 71.5, y: 67.3), control2: CGPoint(x: 74.5, y: 66.5))
        p.addCurve(to: CGPoint(x: 63.4, y: 73), control1: CGPoint(x: 67.4, y: 73.3), control2: CGPoint(x: 68.2, y: 70.5))
        p.addCurve(to: CGPoint(x: 56.6, y: 77.5), control1: CGPoint(x: 58.6, y: 75.5), control2: CGPoint(x: 61.6, y: 76.4))
        p.addCurve(to: CGPoint(x: 48.4, y: 76.3), control1: CGPoint(x: 51.6, y: 78.5), control2: CGPoint(x: 53.9, y: 76.5))
        p.addCurve(to: CGPoint(x: 40.2, y: 76.6), control1: CGPoint(x: 43, y: 76), control2: CGPoint(x: 45, y: 78.2))
        p.addCurve(to: CGPoint(x: 34, y: 71.5), control1: CGPoint(x: 35.3, y: 75), control2: CGPoint(x: 38.4, y: 74.5))
        p.addCurve(to: CGPoint(x: 26.8, y: 67.6), control1: CGPoint(x: 29.5, y: 68.5), control2: CGPoint(x: 30, y: 71.4))
        p.addCurve(to: CGPoint(x: 24.6, y: 60.2), control1: CGPoint(x: 23.7, y: 63.8), control2: CGPoint(x: 26.6, y: 64.9))
        p.addCurve(to: CGPoint(x: 20.8, y: 53.3), control1: CGPoint(x: 22.6, y: 55.4), control2: CGPoint(x: 21.3, y: 58.1))
        p.addCurve(to: CGPoint(x: 23.3, y: 46), control1: CGPoint(x: 20.4, y: 48.6), control2: CGPoint(x: 22.2, y: 51))
        p.addCurve(to: CGPoint(x: 24.1, y: 38.3), control1: CGPoint(x: 24.4, y: 41), control2: CGPoint(x: 21.7, y: 42.5))
        p.addCurve(to: CGPoint(x: 30.5, y: 33.4), control1: CGPoint(x: 26.5, y: 34.1), control2: CGPoint(x: 26.6, y: 37))
        p.addCurve(to: CGPoint(x: 35.6, y: 27.3), control1: CGPoint(x: 34.3, y: 29.7), control2: CGPoint(x: 31.2, y: 29.7))
        p.addCurve(to: CGPoint(x: 43.8, y: 26.4), control1: CGPoint(x: 40.1, y: 25), control2: CGPoint(x: 38.5, y: 27.5))
        p.addCurve(to: CGPoint(x: 51.7, y: 23.9), control1: CGPoint(x: 49.2, y: 25.2), control2: CGPoint(x: 46.6, y: 23.6))
        p.addCurve(to: CGPoint(x: 59.2, y: 27.2), control1: CGPoint(x: 56.8, y: 24.1), control2: CGPoint(x: 54, y: 25.5))
        p.addCurve(to: CGPoint(x: 67.2, y: 29), control1: CGPoint(x: 64.3, y: 28.9), control2: CGPoint(x: 63.1, y: 26.2))
        p.addCurve(to: CGPoint(x: 71.6, y: 35.6), control1: CGPoint(x: 71.3, y: 31.8), control2: CGPoint(x: 68.2, y: 31.5))
        p.addCurve(to: CGPoint(x: 77.3, y: 41.1), control1: CGPoint(x: 74.9, y: 39.6), control2: CGPoint(x: 75.4, y: 36.7))
        p.addCurve(to: CGPoint(x: 77.1, y: 48.8), control1: CGPoint(x: 79.1, y: 45.6), control2: CGPoint(x: 76.7, y: 43.8))
        p.addCurve(to: CGPoint(x: 78.7, y: 56.4), control1: CGPoint(x: 77.6, y: 53.9), control2: CGPoint(x: 79.7, y: 51.7))
        p.closeSubpath()
        return p
    }()

    static let knot: Path = {
        var p = Path()
        p.move(to: CGPoint(x: 59.1, y: 24.2))
        p.addCurve(to: CGPoint(x: 53.8, y: 27.1), control1: CGPoint(x: 57.6, y: 26.8), control2: CGPoint(x: 57.1, y: 25))
        p.addCurve(to: CGPoint(x: 49.1, y: 30.5), control1: CGPoint(x: 50.4, y: 29.2), control2: CGPoint(x: 52.8, y: 29.8))
        p.addCurve(to: CGPoint(x: 42.7, y: 29.3), control1: CGPoint(x: 45.4, y: 31.2), control2: CGPoint(x: 47, y: 29.9))
        p.addCurve(to: CGPoint(x: 36.1, y: 28.8), control1: CGPoint(x: 38.3, y: 28.8), control2: CGPoint(x: 39.2, y: 30.4))
        p.addCurve(to: CGPoint(x: 33.4, y: 24.5), control1: CGPoint(x: 33, y: 27.2), control2: CGPoint(x: 35.5, y: 27.3))
        p.addCurve(to: CGPoint(x: 29.8, y: 20.5), control1: CGPoint(x: 31.3, y: 21.7), control2: CGPoint(x: 29.9, y: 23.3))
        p.addCurve(to: CGPoint(x: 32.8, y: 16.3), control1: CGPoint(x: 29.6, y: 17.8), control2: CGPoint(x: 31.1, y: 19.2))
        p.addCurve(to: CGPoint(x: 34.9, y: 11.8), control1: CGPoint(x: 34.5, y: 13.4), control2: CGPoint(x: 32, y: 13.6))
        p.addCurve(to: CGPoint(x: 41.4, y: 10.9), control1: CGPoint(x: 37.8, y: 10), control2: CGPoint(x: 37.2, y: 11.7))
        p.addCurve(to: CGPoint(x: 47.7, y: 9.3), control1: CGPoint(x: 45.7, y: 10), control2: CGPoint(x: 43.9, y: 8.8))
        p.addCurve(to: CGPoint(x: 52.7, y: 12.3), control1: CGPoint(x: 51.4, y: 9.7), control2: CGPoint(x: 49.2, y: 10.5))
        p.addCurve(to: CGPoint(x: 58.4, y: 14.8), control1: CGPoint(x: 56.3, y: 14.2), control2: CGPoint(x: 56.6, y: 12.4))
        p.addCurve(to: CGPoint(x: 58.2, y: 19.5), control1: CGPoint(x: 60.2, y: 17.2), control2: CGPoint(x: 58, y: 16.4))
        p.addCurve(to: CGPoint(x: 59.1, y: 24.2), control1: CGPoint(x: 58.4, y: 22.7), control2: CGPoint(x: 60.5, y: 21.7))
        p.closeSubpath()
        return p
    }()

    static let earL: Path = {
        var p = Path()
        p.move(to: CGPoint(x: 31, y: 29))
        p.addCurve(to: CGPoint(x: 21, y: 32), control1: CGPoint(x: 29, y: 28), control2: CGPoint(x: 24.2, y: 29.7))
        p.addCurve(to: CGPoint(x: 12, y: 43), control1: CGPoint(x: 17.8, y: 34.3), control2: CGPoint(x: 14.2, y: 38.8))
        p.addCurve(to: CGPoint(x: 8, y: 57), control1: CGPoint(x: 9.8, y: 47.2), control2: CGPoint(x: 8.5, y: 52.5))
        p.addCurve(to: CGPoint(x: 9, y: 70), control1: CGPoint(x: 7.5, y: 61.5), control2: CGPoint(x: 8, y: 66.7))
        p.addCurve(to: CGPoint(x: 14, y: 77), control1: CGPoint(x: 10, y: 73.3), control2: CGPoint(x: 12.5, y: 76.8))
        p.addCurve(to: CGPoint(x: 18, y: 71), control1: CGPoint(x: 15.5, y: 77.2), control2: CGPoint(x: 16.7, y: 71.3))
        p.addCurve(to: CGPoint(x: 22, y: 75), control1: CGPoint(x: 19.3, y: 70.7), control2: CGPoint(x: 20.5, y: 76.2))
        p.addCurve(to: CGPoint(x: 27, y: 64), control1: CGPoint(x: 23.5, y: 73.8), control2: CGPoint(x: 25.5, y: 68))
        p.addCurve(to: CGPoint(x: 31, y: 51), control1: CGPoint(x: 28.5, y: 60), control2: CGPoint(x: 30, y: 55.3))
        p.addCurve(to: CGPoint(x: 33, y: 38), control1: CGPoint(x: 32, y: 46.7), control2: CGPoint(x: 33, y: 41.7))
        p.addCurve(to: CGPoint(x: 31, y: 29), control1: CGPoint(x: 33, y: 34.3), control2: CGPoint(x: 33, y: 30))
        p.closeSubpath()
        return p
    }()

    static let earR: Path = {
        var p = Path()
        p.move(to: CGPoint(x: 69, y: 29))
        p.addCurve(to: CGPoint(x: 79, y: 32), control1: CGPoint(x: 70.7, y: 28), control2: CGPoint(x: 75.8, y: 29.8))
        p.addCurve(to: CGPoint(x: 88, y: 42), control1: CGPoint(x: 82.2, y: 34.2), control2: CGPoint(x: 85.7, y: 38.3))
        p.addCurve(to: CGPoint(x: 93, y: 54), control1: CGPoint(x: 90.3, y: 45.7), control2: CGPoint(x: 91.8, y: 50.5))
        p.addCurve(to: CGPoint(x: 95, y: 63), control1: CGPoint(x: 94.2, y: 57.5), control2: CGPoint(x: 95.3, y: 60.3))
        p.addCurve(to: CGPoint(x: 91, y: 70), control1: CGPoint(x: 94.7, y: 65.7), control2: CGPoint(x: 92.3, y: 69.8))
        p.addCurve(to: CGPoint(x: 87, y: 64), control1: CGPoint(x: 89.7, y: 70.2), control2: CGPoint(x: 88.2, y: 64.3))
        p.addCurve(to: CGPoint(x: 84, y: 68), control1: CGPoint(x: 85.8, y: 63.7), control2: CGPoint(x: 85.3, y: 69))
        p.addCurve(to: CGPoint(x: 79, y: 58), control1: CGPoint(x: 82.7, y: 67), control2: CGPoint(x: 80.8, y: 61.3))
        p.addCurve(to: CGPoint(x: 73, y: 48), control1: CGPoint(x: 77.2, y: 54.7), control2: CGPoint(x: 74.7, y: 51.3))
        p.addCurve(to: CGPoint(x: 69, y: 38), control1: CGPoint(x: 71.3, y: 44.7), control2: CGPoint(x: 69.7, y: 41.2))
        p.addCurve(to: CGPoint(x: 69, y: 29), control1: CGPoint(x: 68.3, y: 34.8), control2: CGPoint(x: 67.3, y: 30))
        p.closeSubpath()
        return p
    }()

    static let muzzle: Path = {
        var p = Path()
        p.move(to: CGPoint(x: 65.5, y: 63.1))
        p.addCurve(to: CGPoint(x: 63, y: 67.1), control1: CGPoint(x: 65.1, y: 65.9), control2: CGPoint(x: 64.8, y: 64.5))
        p.addCurve(to: CGPoint(x: 60, y: 70.9), control1: CGPoint(x: 61.1, y: 69.6), control2: CGPoint(x: 62.8, y: 69.1))
        p.addCurve(to: CGPoint(x: 54.6, y: 72.3), control1: CGPoint(x: 57.3, y: 72.6), control2: CGPoint(x: 58.3, y: 71.4))
        p.addCurve(to: CGPoint(x: 49, y: 73.4), control1: CGPoint(x: 50.9, y: 73.1), control2: CGPoint(x: 52.6, y: 73.7))
        p.addCurve(to: CGPoint(x: 43.8, y: 71.5), control1: CGPoint(x: 45.4, y: 73.1), control2: CGPoint(x: 47.2, y: 72.8))
        p.addCurve(to: CGPoint(x: 38.8, y: 69.2), control1: CGPoint(x: 40.4, y: 70.1), control2: CGPoint(x: 41.1, y: 71.4))
        p.addCurve(to: CGPoint(x: 36.9, y: 65.1), control1: CGPoint(x: 36.5, y: 67.1), control2: CGPoint(x: 38.1, y: 67.9))
        p.addCurve(to: CGPoint(x: 35.5, y: 60.9), control1: CGPoint(x: 35.8, y: 62.3), control2: CGPoint(x: 35.1, y: 63.6))
        p.addCurve(to: CGPoint(x: 38, y: 56.9), control1: CGPoint(x: 35.9, y: 58.1), control2: CGPoint(x: 36.2, y: 59.5))
        p.addCurve(to: CGPoint(x: 41, y: 53.1), control1: CGPoint(x: 39.9, y: 54.4), control2: CGPoint(x: 38.2, y: 54.9))
        p.addCurve(to: CGPoint(x: 46.4, y: 51.7), control1: CGPoint(x: 43.7, y: 51.4), control2: CGPoint(x: 42.7, y: 52.6))
        p.addCurve(to: CGPoint(x: 52, y: 50.6), control1: CGPoint(x: 50.1, y: 50.9), control2: CGPoint(x: 48.4, y: 50.3))
        p.addCurve(to: CGPoint(x: 57.2, y: 52.5), control1: CGPoint(x: 55.6, y: 50.9), control2: CGPoint(x: 53.8, y: 51.2))
        p.addCurve(to: CGPoint(x: 62.2, y: 54.8), control1: CGPoint(x: 60.6, y: 53.9), control2: CGPoint(x: 59.9, y: 52.6))
        p.addCurve(to: CGPoint(x: 64.1, y: 58.9), control1: CGPoint(x: 64.5, y: 56.9), control2: CGPoint(x: 62.9, y: 56.1))
        p.addCurve(to: CGPoint(x: 65.5, y: 63.1), control1: CGPoint(x: 65.2, y: 61.7), control2: CGPoint(x: 65.9, y: 60.4))
        p.closeSubpath()
        return p
    }()

    static let locksL0: Path = {
        var p = Path()
        p.move(to: CGPoint(x: 24, y: 38))
        p.addCurve(to: CGPoint(x: 19, y: 50), control1: CGPoint(x: 23.8, y: 34.7), control2: CGPoint(x: 20, y: 46))
        p.addCurve(to: CGPoint(x: 18, y: 62), control1: CGPoint(x: 18, y: 54), control2: CGPoint(x: 17.8, y: 58.7))
        p.addCurve(to: CGPoint(x: 20, y: 70), control1: CGPoint(x: 18.2, y: 65.3), control2: CGPoint(x: 19, y: 74))
        return p
    }()

    static let locksL1: Path = {
        var p = Path()
        p.move(to: CGPoint(x: 21, y: 45))
        p.addCurve(to: CGPoint(x: 15, y: 56), control1: CGPoint(x: 21.2, y: 43.3), control2: CGPoint(x: 16.2, y: 52.5))
        p.addCurve(to: CGPoint(x: 14, y: 66), control1: CGPoint(x: 13.8, y: 59.5), control2: CGPoint(x: 13, y: 67.8))
        return p
    }()

    static let locksR0: Path = {
        var p = Path()
        p.move(to: CGPoint(x: 80, y: 38))
        p.addCurve(to: CGPoint(x: 86, y: 48), control1: CGPoint(x: 80, y: 35.2), control2: CGPoint(x: 84.8, y: 44.7))
        p.addCurve(to: CGPoint(x: 87, y: 58), control1: CGPoint(x: 87.2, y: 51.3), control2: CGPoint(x: 87, y: 55.2))
        p.addCurve(to: CGPoint(x: 86, y: 65), control1: CGPoint(x: 87, y: 60.8), control2: CGPoint(x: 87.2, y: 68.3))
        return p
    }()

    static let locksR1: Path = {
        var p = Path()
        p.move(to: CGPoint(x: 84, y: 45))
        p.addCurve(to: CGPoint(x: 90, y: 54), control1: CGPoint(x: 83.8, y: 43.7), control2: CGPoint(x: 88.8, y: 51.2))
        p.addCurve(to: CGPoint(x: 91, y: 62), control1: CGPoint(x: 91.2, y: 56.8), control2: CGPoint(x: 92, y: 63.5))
        return p
    }()

    static let fur0: Path = {
        var p = Path()
        p.move(to: CGPoint(x: 34, y: 30))
        p.addCurve(to: CGPoint(x: 38, y: 34), control1: CGPoint(x: 33.3, y: 30.2), control2: CGPoint(x: 36.7, y: 33.5))
        p.addCurve(to: CGPoint(x: 42, y: 33), control1: CGPoint(x: 39.3, y: 34.5), control2: CGPoint(x: 42.7, y: 33.7))
        return p
    }()

    static let fur1: Path = {
        var p = Path()
        p.move(to: CGPoint(x: 58, y: 30))
        p.addCurve(to: CGPoint(x: 62, y: 34), control1: CGPoint(x: 57.2, y: 30.3), control2: CGPoint(x: 60.5, y: 33.7))
        p.addCurve(to: CGPoint(x: 67, y: 32), control1: CGPoint(x: 63.5, y: 34.3), control2: CGPoint(x: 67.7, y: 32.7))
        return p
    }()

    static let fur2: Path = {
        var p = Path()
        p.move(to: CGPoint(x: 46, y: 22))
        p.addCurve(to: CGPoint(x: 50, y: 26), control1: CGPoint(x: 45.3, y: 22.5), control2: CGPoint(x: 48.7, y: 25.8))
        p.addCurve(to: CGPoint(x: 54, y: 23), control1: CGPoint(x: 51.3, y: 26.2), control2: CGPoint(x: 54.7, y: 23.7))
        return p
    }()
}
