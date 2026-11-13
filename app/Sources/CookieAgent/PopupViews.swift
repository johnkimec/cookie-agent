// The redesigned popup. Views take values and closures so they do not know AppModel.
// Accessibility identifiers are NSViews. A SwiftUI accessibility modifier does not
// show up in the window's accessibility tree, which is what System Events reads.

import AppKit
import CookieCore
import CoreText
import SwiftUI

public enum CookieFont {
    public static let family = "Atkinson Hyperlegible Next"

    /// Call once at launch with the bundle that holds the font file.
    /// A missing file leaves Font.custom on the system font.
    public static func register(in bundle: Bundle) {
        for ext in ["ttf", "otf"] {
            for url in bundle.urls(forResourcesWithExtension: ext, subdirectory: nil) ?? [] {
                CTFontManagerRegisterFontsForURL(url as CFURL, .process, nil)
            }
        }
    }

    public static let reply = Font.custom(family, size: 15)
    public static let prompt = Font.custom(family, size: 13)
    public static let meta = Font.custom(family, size: 11)
    public static let field = Font.custom(family, size: 15)

    public static var fieldNSFont: NSFont {
        NSFont(name: family, size: 15) ?? .systemFont(ofSize: 15)
    }

    public static var metaNSFont: NSFont {
        NSFont(name: family, size: 11) ?? .systemFont(ofSize: 11, weight: .medium)
    }
}

public enum CookieColor {
    /// Used for one thing only: a reply that left the machine.
    public static let collar = Color(red: 0x3C / 255, green: 0x5B / 255, blue: 0xFF / 255)
}

public enum ReplySource { case onDevice, cloud }

/// One exchange. `reply` is nil until the cookie turn exists.
/// `source` is nil while that reply is still streaming, so the label waits.
struct PopupExchange: Identifiable {
    var index: Int
    var prompt: String
    var reply: String?
    var source: ReplySource?
    var id: Int { index }
}

func popupExchanges(_ turns: [ChatTurn]) -> [PopupExchange] {
    var pairs: [PopupExchange] = []
    var pending: (index: Int, text: String)?
    for turn in turns {
        switch turn.role {
        case .you:
            if let pending {
                pairs.append(PopupExchange(index: pending.index, prompt: pending.text, reply: nil, source: nil))
            }
            pending = (turn.index, turn.text)
        case .cookie:
            let prompt = pending?.text ?? ""
            pending = nil
            pairs.append(PopupExchange(
                index: turn.index,
                prompt: prompt,
                reply: turn.text,
                source: replySource(badge: turn.badge, streaming: turn.streaming)
            ))
        }
    }
    if let pending {
        pairs.append(PopupExchange(index: pending.index, prompt: pending.text, reply: nil, source: nil))
    }
    return pairs
}

func replySource(badge: String?, streaming: Bool) -> ReplySource? {
    guard !streaming, let badge else { return nil }
    if badge.caseInsensitiveCompare("cloud") == .orderedSame { return .cloud }
    return .onDevice
}

struct TurnPair<Reply: View>: View {
    let index: Int
    let prompt: String?
    let replyText: String?
    let source: ReplySource?
    let reply: () -> Reply

    init(
        index: Int,
        prompt: String?,
        replyText: String?,
        source: ReplySource?,
        @ViewBuilder reply: @escaping () -> Reply
    ) {
        self.index = index
        self.prompt = prompt
        self.replyText = replyText
        self.source = source
        self.reply = reply
    }

    var body: some View {
        VStack(alignment: .leading, spacing: PopupGeometry.promptToReplySpacing) {
            if let prompt {
                Text(prompt)
                    .font(CookieFont.prompt)
                    .lineSpacing(2)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background {
                        IdentifiedBox(
                            identifier: CookieAX.turnYou(index),
                            label: CookieCopy.you,
                            value: prompt
                        )
                    }
            }

            if let replyText {
                VStack(alignment: .leading, spacing: PopupGeometry.replyToLabelSpacing) {
                    reply()
                        .font(CookieFont.reply)
                        .lineSpacing(3)
                        .foregroundStyle(.primary)
                        .fixedSize(horizontal: false, vertical: true)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    if let source {
                        ReplyLabel(source: source, index: index)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .background {
                    // The label sits inside this element so the gap under the
                    // reply is the transcript's bottom inset, not the label.
                    IdentifiedBox(
                        identifier: CookieAX.turnCookie(index),
                        label: CookieCopy.cookie,
                        value: replyText
                    )
                }
            }
        }
    }
}

struct ReplyLabel: View {
    let source: ReplySource
    let index: Int

    var body: some View {
        switch source {
        case .onDevice:
            Text(CookieCopy.onDevice)
                .font(CookieFont.meta)
                .foregroundStyle(.tertiary)
                .lineLimit(1)
                .fixedSize()
                .background {
                    IdentifiedBox(
                        identifier: CookieAX.badge(index),
                        label: CookieCopy.onDevice,
                        value: CookieCopy.onDevice
                    )
                }
        case .cloud:
            Text("cloud")
                .font(CookieFont.meta)
                .foregroundStyle(.white)
                .lineLimit(1)
                .fixedSize()
                .padding(.horizontal, 7)
                .background(Capsule().fill(CookieColor.collar))
                .background {
                    IdentifiedBox(
                        identifier: CookieAX.badgeCloud(index),
                        label: "cloud",
                        value: "cloud"
                    )
                }
        }
    }
}

/// One control. While a reply is arriving the key reads esc and stops the reply.
/// The accessibility label stays `⏎` or `Stop`.
struct SendStopKey: View {
    let glyph: String
    let accessibilityTitle: String
    let identifier: String
    let isReady: Bool
    let emphasized: Bool
    let action: () -> Void

    var body: some View {
        IdentifiedButton(
            title: accessibilityTitle,
            identifier: identifier,
            keycap: glyph,
            enabled: isReady,
            emphasized: emphasized,
            action: action
        )
        .help(accessibilityTitle == CookieCopy.stop ? CookieCopy.stop : CookieCopy.ask)
    }
}

enum PopupRuntimeStatus { case ready, loading, down }

struct PopupInputRow<Field: View>: View {
    let pose: CookiePose
    let spokenPose: String
    let status: PopupRuntimeStatus
    let hasDraft: Bool
    let isStreaming: Bool
    let note: String?
    let noteIdentifier: String?
    let inputRowHeight: CGFloat
    let onSend: () -> Void
    let onStop: () -> Void
    let field: () -> Field

    var body: some View {
        let control = isStreaming
            ? (glyph: "esc", title: CookieCopy.stop, identifier: CookieAX.popupStop)
            : (glyph: "⏎", title: "⏎", identifier: CookieAX.popupSend)
        HStack(spacing: 12) {
            CookieMark(pose: pose)
                .frame(width: PopupLayout.mascot, height: PopupLayout.mascot)
                .background {
                    IdentifiedBox(
                        identifier: CookieAX.popupMascot,
                        label: spokenPose
                    )
                }
                .help(spokenPose)

            VStack(alignment: .leading, spacing: 1) {
                field()
                    .frame(maxWidth: .infinity, alignment: .leading)
                if let note, let noteIdentifier {
                    IdentifiedText(
                        text: note,
                        identifier: noteIdentifier,
                        label: note,
                        font: CookieFont.metaNSFont,
                        textColor: .tertiaryLabelColor
                    )
                }
            }

            SendStopKey(
                glyph: control.glyph,
                accessibilityTitle: control.title,
                identifier: control.identifier,
                isReady: isStreaming || status != .loading,
                emphasized: isStreaming || (status == .ready && hasDraft),
                action: isStreaming ? onStop : onSend
            )

            // No green fill. The element stays 8×8 so the size check still
            // sees one on-device indicator in the input row.
            if status == .ready {
                Color.clear
                    .frame(width: 8, height: 8)
                    .allowsHitTesting(false)
                    .background {
                        IdentifiedBox(
                            identifier: CookieAX.onDeviceIndicator,
                            label: CookieCopy.onDevice,
                            value: CookieCopy.onDevice,
                            tooltip: CookieCopy.onDevice
                        )
                    }
                    .help(CookieCopy.onDevice)
            }
        }
        .padding(.horizontal, PopupGeometry.horizontalPadding)
        .padding(.vertical, PopupLayout.inputRowVerticalPadding)
        .frame(height: inputRowHeight)
        .background {
            GeometryReader { geo in
                Color.clear.preference(key: InputRowHeightKey.self, value: geo.size.height)
            }
        }
    }
}
