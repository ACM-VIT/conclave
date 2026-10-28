#if os(iOS) && !SKIP
import SwiftUI
import UIKit

// S40 2 (CHT-1): the timeline. A lazy list over the presenter's row ids (the list observes only `timeline`, each row
// only its entry), bottom anchored, following new rows only while at the bottom or for your own send, with a neutral
// jump pill counting unseen remote messages. iOS 18 reads bottom proximity from scroll geometry; iOS 17 uses a bottom
// sentinel whose appearance callbacks write a plain reference box plus a value-guarded flag (AGENTS appearance-
// callback rule). No merge, sort or format in a body; no timers except the one highlight task a jump starts.

/// The iOS 17 sentinel's reference box: mutating it never invalidates a body.
private final class ChatBottomSentinelState {
    var isVisible = true
}

/// One rotor entry (2 c): a row after the unread divider.
private struct ChatRotorEntry: Identifiable {
    let id: String
    let label: String
}

struct ChatTimeline: View {
    let chat: ChatPresenter
    let actions: ChatRowActions
    @State private var isAtBottom = true
    @State private var unseen = 0
    @State private var highlightId = ""
    @State private var sentinel = ChatBottomSentinelState()
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        let timeline = chat.timeline
        #if DEBUG
        let _ = ChatDiagnostics.counters?.bump("chat.recompose.list")
        #endif
        if timeline.isEmpty {
            ChatEmptyState(chat: chat, actions: actions)
        } else {
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 0) {
                        ForEach(timeline.rowIds, id: \.self) { rowId in
                            ChatRowView(entry: chat.rows.entry(for: rowId), actions: actions,
                                        isHighlighted: highlightId == rowId)
                                .id(rowId)
                        }
                        if !ChatTimelinePlatform.usesScrollGeometry {
                            Color.clear
                                .frame(height: 1)
                                .accessibilityHidden(true)
                                .onAppear { setBottomVisible(true) }
                                .onDisappear { setBottomVisible(false) }
                        }
                    }
                    .scrollTargetLayout()
                    .padding(.horizontal, CGFloat(DesignTokens.space16))
                    .padding(.vertical, CGFloat(DesignTokens.space12))
                }
                .defaultScrollAnchor(.bottom)
                .modifier(ChatSizeChangeBottomAnchor())
                .background {
                    if !ChatTimelinePlatform.usesScrollGeometry {
                        ChatStreamingFollow17(chat: chat, proxy: proxy, isAtBottom: isAtBottom)
                    }
                }
                .modifier(ChatBottomProximity(isAtBottom: $isAtBottom))
                .scrollDismissesKeyboard(.interactively)
                .overlay(alignment: .bottom) {
                    if !isAtBottom {
                        ChatJumpPill(unseen: unseen) { jumpToLatest(proxy, timeline: timeline) }
                            .padding(.bottom, CGFloat(DesignTokens.space8))
                    }
                }
                .accessibilityRotor(Text(ConclaveStrings.text("Unread Messages")), entries: rotorEntries(timeline),
                                    entryID: \ChatRotorEntry.id, entryLabel: \ChatRotorEntry.label)
                .task {
                    place(proxy, timeline: timeline)
                }
                .onChange(of: timeline.newestId) { _, _ in
                    follow(proxy, timeline: chat.timeline)
                }
                .onChange(of: timeline.focusRequest) { _, _ in
                    scrollToFocus(proxy, timeline: chat.timeline)
                }
                .onChange(of: isAtBottom) { _, atBottom in
                    if atBottom && unseen != 0 { unseen = 0 }
                }
            }
            .accessibilityIdentifier("chat.timeline")
        }
    }

    /// Value guarded: the sentinel's callbacks re-fire with body re-runs (AGENTS).
    private func setBottomVisible(_ visible: Bool) {
        sentinel.isVisible = visible
        if isAtBottom != visible { isAtBottom = visible }
    }

    /// Open position (2 c): the destination, else the unread divider, else the newest row; no animation.
    private func place(_ proxy: ScrollViewProxy, timeline: ChatTimelineSnapshot) {
        if !timeline.focusId.isEmpty {
            proxy.scrollTo(timeline.focusId, anchor: .center)
            highlight(timeline.focusId)
        } else if !timeline.firstUnreadId.isEmpty {
            proxy.scrollTo("unread", anchor: UnitPoint(x: 0.5, y: 0.33))
        } else if !timeline.newestId.isEmpty {
            proxy.scrollTo(timeline.newestId, anchor: .bottom)
        }
    }

    /// INM C2 follow rule: at the bottom or your own send, scroll to the newest; otherwise count unseen remote
    /// messages only (system rows, reactions and assistant deltas never count).
    private func follow(_ proxy: ScrollViewProxy, timeline: ChatTimelineSnapshot) {
        let atBottom = ChatTimelinePlatform.usesScrollGeometry ? isAtBottom : sentinel.isVisible
        if atBottom || timeline.newestIsOwn {
            if reduceMotion {
                proxy.scrollTo(timeline.newestId, anchor: .bottom)
            } else {
                withAnimation(.snappy) { proxy.scrollTo(timeline.newestId, anchor: .bottom) }
            }
        } else if timeline.newestIsRemoteMessage {
            unseen += 1
        }
    }

    private func jumpToLatest(_ proxy: ScrollViewProxy, timeline: ChatTimelineSnapshot) {
        unseen = 0
        if reduceMotion {
            proxy.scrollTo(timeline.newestId, anchor: .bottom)
        } else {
            withAnimation(.snappy) { proxy.scrollTo(timeline.newestId, anchor: .bottom) }
        }
    }

    /// A preview tap or a quote jump: the row scrolls to the middle and gets the 900 ms highlight (2 f).
    private func scrollToFocus(_ proxy: ScrollViewProxy, timeline: ChatTimelineSnapshot) {
        guard !timeline.focusId.isEmpty else { return }
        if reduceMotion {
            proxy.scrollTo(timeline.focusId, anchor: .center)
        } else {
            withAnimation(.snappy) { proxy.scrollTo(timeline.focusId, anchor: .center) }
        }
        highlight(timeline.focusId)
    }

    private func highlight(_ rowId: String) {
        highlightId = rowId
        Task { @MainActor in
            try? await Task.sleep(nanoseconds: 900_000_000)
            if highlightId == rowId { highlightId = "" }
        }
    }

    private func rotorEntries(_ timeline: ChatTimelineSnapshot) -> [ChatRotorEntry] {
        guard !timeline.firstUnreadId.isEmpty else { return [] }
        var entries: [ChatRotorEntry] = []
        var afterDivider = false
        var index = 0
        while index < timeline.rowIds.count {
            let rowId = timeline.rowIds[index]
            if afterDivider && ChatRowKind.text == timeline.rowKinds[index] {
                entries.append(ChatRotorEntry(id: rowId, label: chat.rows.entry(for: rowId).row.plainText))
            }
            if rowId == "unread" { afterDivider = true }
            index += 1
        }
        return entries
    }
}

/// Which bottom proximity path runs (2 c, 2 l 5).
enum ChatTimelinePlatform {
    static var usesScrollGeometry: Bool {
        if #available(iOS 18.0, *) { return true }
        return false
    }
}

/// iOS 18: keep the bottom anchored when content grows (streaming answers, an embed card).
private struct ChatSizeChangeBottomAnchor: ViewModifier {
    func body(content: Content) -> some View {
        if #available(iOS 18.0, *) {
            content.defaultScrollAnchor(.bottom, for: .sizeChanges)
        } else {
            content
        }
    }
}

/// 2 c, iOS 17 only (CHT-7): a leaf that alone reads `chat.tailGrowth`, so a streaming answer's growth re-runs no list
/// body; it keeps the newest row pinned only while the reader is at the bottom (iOS 18 uses the size-change anchor).
private struct ChatStreamingFollow17: View {
    let chat: ChatPresenter
    let proxy: ScrollViewProxy
    let isAtBottom: Bool

    var body: some View {
        Color.clear
            .frame(width: 0, height: 0)
            .accessibilityHidden(true)
            .onChange(of: chat.tailGrowth) { _, _ in
                guard isAtBottom else { return }
                let newest = chat.timeline.newestId
                if !newest.isEmpty { proxy.scrollTo(newest, anchor: .bottom) }
            }
    }
}

/// iOS 18: at the bottom when within 24 pt of the end, from scroll geometry (fires only when the value changes).
private struct ChatBottomProximity: ViewModifier {
    @Binding var isAtBottom: Bool

    func body(content: Content) -> some View {
        if #available(iOS 18.0, *) {
            content.onScrollGeometryChange(for: Bool.self) { geometry in
                geometry.contentOffset.y + geometry.containerSize.height >= geometry.contentSize.height - 24
            } action: { _, atBottom in
                if isAtBottom != atBottom { isAtBottom = atBottom }
            }
        } else {
            content
        }
    }
}

/// CL5: neutral, never coral (one prominent action rule); appears without animation.
private struct ChatJumpPill: View {
    let unseen: Int
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            // The scroll_to_latest glyph is a pending icon concept (R40-5, request R4); text only until it lands.
            Text(unseen > 0 ? ConclaveStrings.format("%lld New Messages", unseen) : ConclaveStrings.text("Jump to Latest"))
        }
        .buttonStyle(.bordered)
        .tint(.primary)
        .controlSize(.small)
        .background(Color(uiColor: .systemBackground), in: Capsule())
        .accessibilityIdentifier("chat.jumpPill")
    }
}

/// 2 c empty state: title, body, visibility line and Ask Conclave AI (hidden when the assistant is unavailable).
private struct ChatEmptyState: View {
    let chat: ChatPresenter
    let actions: ChatRowActions

    var body: some View {
        ContentUnavailableView {
            Label(ConclaveStrings.text("No Messages Yet"), systemImage: ConclaveSymbols.message)
                .accessibilityAddTraits(.isHeader)
        } description: {
            VStack(spacing: CGFloat(DesignTokens.space8)) {
                Text(ConclaveStrings.text("Be the first to say something. Share a photo, send a GIF, drop a link or just say hi."))
                Text(ConclaveStrings.text("Everyone in this call can see messages, including people who join later. Private messages stay between you and the recipient."))
                if chat.composer.assistant != AssistantAvailability.unavailable {
                    Text(ConclaveStrings.text("Ask Conclave AI anything. Type @Conclave anywhere in a message."))
                }
            }
        } actions: {
            if chat.composer.assistant != AssistantAvailability.unavailable {
                Button(ConclaveStrings.text("Ask Conclave AI")) {
                    actions.focusComposer(inserting: "@Conclave ")
                }
                .buttonStyle(.bordered)
                .tint(.primary)
                .accessibilityIdentifier("chat.askAssistant")
            }
        }
        .accessibilityIdentifier("chat.empty")
    }
}
#endif
