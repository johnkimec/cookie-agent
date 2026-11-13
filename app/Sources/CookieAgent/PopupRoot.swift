import CookieCore
import SwiftStreamingMarkdown
import SwiftUI

private struct PaddedTranscriptKey: PreferenceKey {
    static var defaultValue: TranscriptFrame {
        TranscriptFrame(height: 0, minY: 0)
    }

    static func reduce(value: inout TranscriptFrame, nextValue: () -> TranscriptFrame) {
        let next = nextValue()
        if next.height > 0 {
            value = next
        }
    }
}

struct PopupRoot: View {
    @ObservedObject var model: AppModel
    @State private var pin = TranscriptPin()
    @State private var viewportHeight: CGFloat = 0
    @State private var transcriptFrame = TranscriptFrame(height: 0, minY: 0)
    @State private var paddedHeight: CGFloat = 0
    @State private var paddedMinY: CGFloat = 0

    var body: some View {
        let _ = model.runtime
        let _ = model.popupOpen
        let shape = RoundedRectangle(cornerRadius: 14, style: .continuous)
        VStack(spacing: 0) {
            if !model.conversation.turns.isEmpty {
                transcript
                Rectangle()
                    .fill(Color.primary.opacity(0.12))
                    .frame(height: PopupGeometry.divider)
            }
            inputRow
        }
        .frame(width: PopupLayout.width, height: layoutHeight, alignment: .top)
        .background(.regularMaterial, in: shape)
        .overlay {
            shape.strokeBorder(Color.primary.opacity(0.12), lineWidth: 1)
        }
        .clipShape(shape)
        .accessibilityElement(children: .contain)
    }

    /// Window height is the unpadded stack, plus the transcript's own padding,
    /// plus the divider, plus the input row. It reaches the cap only when
    /// that sum would pass it.
    private var layoutHeight: CGFloat {
        PopupMetrics.panelHeight(
            turnTexts: model.conversation.turns.map(\.text),
            draft: model.conversation.draft,
            showsNotice: showsNotice,
            measuredTranscript: transcriptFrame.height > 1 ? transcriptFrame.height : nil
        )
    }

    private var showsNotice: Bool {
        popupLoadingLine(runtime: model.runtime.state) != nil
            || model.conversation.refusalLine(runtime: model.runtime.state) != nil
    }

    private var transcriptSlot: CGFloat {
        guard !model.conversation.turns.isEmpty else { return 0 }
        return PopupGeometry.transcriptViewport(panelHeight: layoutHeight, inputRowHeight: inputRowCap)
    }

    private var capped: Bool {
        transcriptFrame.height > 1 && PopupGeometry.isCapped(
            transcriptContent: transcriptFrame.height,
            inputRowHeight: inputRowCap
        )
    }

    private var transcript: some View {
        ScrollViewReader { proxy in
            ScrollView {
                ZStack(alignment: .bottomLeading) {
                    VStack(alignment: .leading, spacing: PopupGeometry.pairSpacing) {
                        ForEach(popupExchanges(model.conversation.turns)) { pair in
                            TurnPair(
                                index: pair.index,
                                prompt: pair.prompt,
                                replyText: pair.reply,
                                source: pair.source
                            ) {
                                MarkdownView(text: prepareReplyMarkdown(pair.reply ?? ""))
                                    .fixedSize(horizontal: false, vertical: true)
                                    .frame(maxWidth: .infinity, alignment: .leading)
                            }
                        }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .fixedSize(horizontal: false, vertical: true)
                    .background {
                        GeometryReader { geo in
                            Color.clear.preference(
                                key: TranscriptFrameKey.self,
                                value: TranscriptFrame(height: geo.size.height, minY: 0)
                            )
                        }
                    }
                    .padding(.horizontal, PopupGeometry.horizontalPadding)
                    .padding(.top, PopupGeometry.transcriptTopPadding)
                    .padding(.bottom, PopupGeometry.transcriptBottomPadding)

                    IdentifiedBox(
                        identifier: CookieAX.transcriptBottom,
                        label: "transcript"
                    )
                    .frame(width: 8, height: 8)
                    .id(CookieAX.transcriptBottom)
                }
                .fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background {
                    GeometryReader { geo in
                        Color.clear.preference(
                            key: PaddedTranscriptKey.self,
                            value: TranscriptFrame(
                                height: geo.size.height,
                                minY: geo.frame(in: .named("popupTranscript")).minY
                            )
                        )
                    }
                }
            }
            .coordinateSpace(name: "popupTranscript")
            .scrollIndicators(capped ? .automatic : .never)
            .background {
                GeometryReader { geo in
                    Color.clear.preference(key: ViewportHeightKey.self, value: geo.size.height)
                }
            }
            .onPreferenceChange(ViewportHeightKey.self) { height in
                viewportHeight = height
                follow(proxy)
            }
            .onPreferenceChange(TranscriptFrameKey.self) { frame in
                transcriptFrame = frame
                follow(proxy)
                model.noteTranscriptHeight(frame.height)
            }
            .onPreferenceChange(PaddedTranscriptKey.self) { frame in
                paddedHeight = frame.height
                paddedMinY = frame.minY
                follow(proxy)
            }
            .onChange(of: model.conversation.turns.last?.text ?? "") { _, _ in
                guard pin.pinnedToBottom else { return }
                proxy.scrollTo(CookieAX.transcriptBottom, anchor: .bottom)
            }
            .mask(topFade)
        }
        .frame(height: max(1, transcriptSlot))
        .layoutPriority(1)
    }

    /// A short fade at the top once the transcript scrolls.
    private var topFade: some View {
        VStack(spacing: 0) {
            if capped {
                LinearGradient(colors: [.clear, .black], startPoint: .top, endPoint: .bottom)
                    .frame(height: PopupGeometry.topFade)
            }
            Rectangle()
        }
    }

    private func follow(_ proxy: ScrollViewProxy) {
        var next = pin
        let shouldScroll = next.note(
            contentHeight: paddedHeight,
            viewportHeight: viewportHeight,
            contentMinY: paddedMinY
        )
        pin = next
        if shouldScroll {
            proxy.scrollTo(CookieAX.transcriptBottom, anchor: .bottom)
        }
    }

    private var inputRowCap: CGFloat {
        PopupMetrics.inputRowHeight(draft: model.conversation.draft, showsNotice: showsNotice)
    }

    private var fieldHeight: CGFloat {
        PopupMetrics.clampedInputHeight(lineCount: PopupMetrics.draftLineCount(model.conversation.draft))
    }

    private var runtimeStatus: PopupRuntimeStatus {
        switch model.runtime.state {
        case .up: .ready
        case .loading: .loading
        case .down: .down
        }
    }

    private var note: (text: String, identifier: String)? {
        if let loading = popupLoadingLine(runtime: model.runtime.state) {
            return (loading, CookieAX.popupLoading)
        }
        if let refusal = model.conversation.refusalLine(runtime: model.runtime.state) {
            return (refusal, CookieAX.popupRefusal)
        }
        return nil
    }

    private var inputRow: some View {
        PopupInputRow(
            pose: CookiePose(popup: model.pose),
            spokenPose: popupPoseVoiceOver(model.pose),
            status: runtimeStatus,
            hasDraft: !model.conversation.draft.isEmpty,
            isStreaming: model.conversation.replyInFlight,
            note: note?.text,
            noteIdentifier: note?.identifier,
            inputRowHeight: inputRowCap,
            onSend: { model.submit() },
            onStop: { model.submit() }
        ) {
            AskField(
                text: Binding(
                    get: { model.conversation.draft },
                    set: { model.setDraft($0) }
                ),
                onSubmit: { model.submit() },
                onEscape: { model.pressEscape() },
                onEditLast: { model.recallLast() },
                onCommandK: { model.pressCommandK() }
            )
            .accessibilityLabel(CookieCopy.ask)
            .frame(maxWidth: .infinity)
            .frame(height: fieldHeight)
        }
    }
}

/// One turn, for the layout tests. The popup itself stacks a prompt and its reply.
struct TurnRow: View {
    var turn: ChatTurn

    var body: some View {
        switch turn.role {
        case .you:
            TurnPair(index: turn.index, prompt: turn.text, replyText: nil, source: nil) {
                EmptyView()
            }
        case .cookie:
            TurnPair(
                index: turn.index,
                prompt: nil,
                replyText: turn.text,
                source: replySource(badge: turn.badge, streaming: turn.streaming)
            ) {
                MarkdownView(text: prepareReplyMarkdown(turn.text))
                    .fixedSize(horizontal: false, vertical: true)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
    }
}
