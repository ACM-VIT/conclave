#if os(iOS) && !SKIP
import SwiftUI
import UIKit

private final class ChatBottomSentinelState {
    var isVisible = true
}

private final class ChatRowVisibilityBox {

    static let partlyVisibleThreshold = 0.01
    private(set) var visibleRowIds: Set<String> = []

    var repinsAfterKeyboard = false

    func setVisible(_ rowId: String, _ visible: Bool) {
        if visible {
            visibleRowIds.insert(rowId)
        } else {
            visibleRowIds.remove(rowId)
        }
    }

    func isVisible(_ rowId: String) -> Bool {
        !rowId.isEmpty && visibleRowIds.contains(rowId)
    }
}

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
    @State private var initialPositioned = false
    @State private var sentinel = ChatBottomSentinelState()
    @State private var visibility = ChatRowVisibilityBox()
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
                                .modifier(ChatRowVisibilityProbe(rowId: rowId, box: visibility))
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
                .modifier(ChatTimelineAnchors(isAtBottom: isAtBottom))
                .background {
                    if !ChatTimelinePlatform.usesScrollGeometry {
                        ChatStreamingFollow17(chat: chat, proxy: proxy, isAtBottom: isAtBottom)
                    }
                }
                .background {
                    ChatComposerFocusFollow(chat: chat, actions: actions, proxy: proxy, visibility: visibility)
                }
                .modifier(ChatBottomProximity(isAtBottom: $isAtBottom))
                .scrollDismissesKeyboard(.interactively)
                .safeAreaInset(edge: .bottom, spacing: 0) {
                    if initialPositioned && ChatTimelinePolicy.showsJumpToLatest(isAtBottom: isAtBottom, unseenCount: unseen) {
                        ChatJumpPill(unseen: unseen) { jumpToLatest(proxy, timeline: timeline) }
                            .padding(.bottom, CGFloat(DesignTokens.space8))
                    }
                }
                .accessibilityRotor(Text(ConclaveStrings.text("Unread Messages")), entries: rotorEntries(timeline),
                                    entryID: \ChatRotorEntry.id, entryLabel: \ChatRotorEntry.label)
                .task {
                    place(proxy, timeline: timeline)
                    initialPositioned = true
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

    private func setBottomVisible(_ visible: Bool) {
        sentinel.isVisible = visible
        if isAtBottom != visible { isAtBottom = visible }
    }

    private func place(_ proxy: ScrollViewProxy, timeline: ChatTimelineSnapshot) {
        let target = ChatTimelinePolicy.initialTarget(focusId: timeline.focusId,
                                                     firstUnreadId: timeline.firstUnreadId, newestId: timeline.newestId)
        guard !target.isEmpty else { return }
        if !timeline.focusId.isEmpty {
            proxy.scrollTo(target, anchor: .center)
            highlight(target)
        } else if target == "unread" {
            proxy.scrollTo(target, anchor: UnitPoint(x: 0.5, y: 0.33))
        } else {
            proxy.scrollTo(target, anchor: .bottom)
        }
    }

    private func follow(_ proxy: ScrollViewProxy, timeline: ChatTimelineSnapshot) {
        guard initialPositioned else { return }
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

enum ChatTimelinePlatform {
    static var usesScrollGeometry: Bool {
        if #available(iOS 18.0, *) { return true }
        return false
    }
}

private struct ChatTimelineAnchors: ViewModifier {
    let isAtBottom: Bool

    func body(content: Content) -> some View {
        if #available(iOS 18.0, *) {
            content
                .defaultScrollAnchor(.bottom)
                .defaultScrollAnchor(.top, for: .alignment)
                .defaultScrollAnchor(isAtBottom ? .bottom : nil, for: .sizeChanges)
        } else {
            content.defaultScrollAnchor(.top)
        }
    }
}

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

private struct ChatRowVisibilityProbe: ViewModifier {
    let rowId: String
    let box: ChatRowVisibilityBox

    func body(content: Content) -> some View {
        if #available(iOS 18.0, *) {
            content.onScrollVisibilityChange(threshold: ChatRowVisibilityBox.partlyVisibleThreshold) { visible in
                box.setVisible(rowId, visible)
            }
        } else {
            content
                .onAppear { box.setVisible(rowId, true) }
                .onDisappear { box.setVisible(rowId, false) }
        }
    }
}

private struct ChatComposerFocusFollow: View {
    let chat: ChatPresenter
    let actions: ChatRowActions
    let proxy: ScrollViewProxy
    let visibility: ChatRowVisibilityBox
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        Color.clear
            .frame(width: 0, height: 0)
            .accessibilityHidden(true)
            .onChange(of: actions.composerFocusRevision) { _, _ in
                followComposerFocus()
            }
            .onReceive(NotificationCenter.default.publisher(for: UIResponder.keyboardDidShowNotification)) { _ in
                repinAfterKeyboard()
            }
            .onReceive(NotificationCenter.default.publisher(for: UIResponder.keyboardWillHideNotification)) { _ in
                visibility.repinsAfterKeyboard = false
            }
            .onDisappear {
                visibility.repinsAfterKeyboard = false
            }
    }

    private func followComposerFocus() {
        let newest = chat.timeline.newestId
        let follows = visibility.isVisible(newest)
        visibility.repinsAfterKeyboard = follows && !ChatTimelinePlatform.usesScrollGeometry
        guard follows else { return }
        scrollToNewest(newest)
    }

    private func repinAfterKeyboard() {
        guard visibility.repinsAfterKeyboard else { return }
        visibility.repinsAfterKeyboard = false
        let newest = chat.timeline.newestId
        guard !newest.isEmpty else { return }
        scrollToNewest(newest)
    }

    private func scrollToNewest(_ newest: String) {
        if reduceMotion {
            proxy.scrollTo(newest, anchor: .bottom)
        } else {
            withAnimation(.snappy) { proxy.scrollTo(newest, anchor: .bottom) }
        }
    }
}

private struct ChatBottomProximity: ViewModifier {
    @Binding var isAtBottom: Bool

    func body(content: Content) -> some View {
        if #available(iOS 18.0, *) {
            content.onScrollGeometryChange(for: Bool.self) { geometry in
                ChatTimelinePolicy.isAtBottom(offsetY: Double(geometry.contentOffset.y),
                                              viewportHeight: Double(geometry.containerSize.height),
                                              contentHeight: Double(geometry.contentSize.height),
                                              bottomInset: Double(geometry.contentInsets.bottom))
            } action: { _, atBottom in
                if isAtBottom != atBottom { isAtBottom = atBottom }
            }
        } else {
            content
        }
    }
}

private struct ChatJumpPill: View {
    let unseen: Int
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Text(ConclaveStrings.format("%lld New Messages", unseen))
        }
        .buttonStyle(.bordered)
        .tint(.primary)
        .controlSize(.small)
        .background(Color(uiColor: .systemBackground), in: Capsule())
        .accessibilityIdentifier("chat.jumpPill")
    }
}

private struct ChatEmptyState: View {
    let chat: ChatPresenter
    let actions: ChatRowActions
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    var body: some View {
        ContentUnavailableView {
            Label {
                Text(ConclaveStrings.text("No Messages Yet"))
            } icon: {
                if !dynamicTypeSize.isAccessibilitySize {
                    ChatGhostArt()
                }
            }
            .accessibilityAddTraits(.isHeader)
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

private struct ChatGhostArt: View {
    var body: some View {
        VStack(spacing: CGFloat(DesignTokens.space8)) {
            VStack(alignment: .leading, spacing: CGFloat(DesignTokens.space2)) {
                RoundedRectangle(cornerRadius: CGFloat(ConclaveBubbleGeometry.iosCornerRadius), style: .continuous)
                    .fill(ConclaveBubbleColors.fill(.peer))
                    .frame(width: 112, height: 26)
                RoundedRectangle(cornerRadius: CGFloat(ConclaveBubbleGeometry.iosCornerRadius), style: .continuous)
                    .fill(ConclaveBubbleColors.fill(.peer))
                    .frame(width: 80, height: 26)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            RoundedRectangle(cornerRadius: CGFloat(ConclaveBubbleGeometry.iosCornerRadius), style: .continuous)
                .fill(ConclaveBubbleColors.fill(.own))
                .frame(width: 64, height: 26)
                .frame(maxWidth: .infinity, alignment: .trailing)
        }
        .frame(width: 160, height: 88)
        .accessibilityHidden(true)
    }
}
#endif
