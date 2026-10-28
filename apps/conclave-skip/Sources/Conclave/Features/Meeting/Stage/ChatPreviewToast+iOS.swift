#if os(iOS) && !SKIP
import Accessibility
import SwiftUI

// S40 8 c (CHT-8; R40-8, F00 C13 chat variant; S20 10 c, f; RECONCILE R3): the chat preview on the stage toast lane.
// The toast lane mounts this host beside the F00 C13 host (HD request B6-T5 R1): this one shows `stage.toast` only
// while it is a `chatPreview`, the other host every other kind, and the presenter shows one toast at a time. The whole
// toast is one Button that opens Chat at the newest message (`performNoticeAction(.view)`, S40 R40-2 destination
// `chatMessage`); a swipe down, the escape gesture or the named accessibility action dismisses it. Display time is
// the host's: 4 s, restarted when the preview updates in place, held under VoiceOver, Switch Control or the fixture
// screen-reader override. No sound, no haptic (S20 10 h). Always dark (in-call surface).

/// Fixed geometry (points): the 44 pt minimum target, the swipe that dismisses.
enum ChatPreviewToastMetrics {
    static let minHeight: CGFloat = 44
    static let dismissTravel: CGFloat = 32
    static let dismissPredictedTravel: CGFloat = 80
    static let dragMinimumDistance: CGFloat = 8
}

/// The chat variant's host: shows the current chat preview, times it, announces each new preview once and hands the id
/// back through `dismissNotice(id:)` when it leaves.
struct ChatPreviewToastHost: View {
    let stage: StagePresenter
    let screenReader: Bool
    @State private var announced = ChatPreviewAnnouncementLatch()

    var body: some View {
        let current = stage.toast
        let notice = ChatPreviewPolicy.isChatPreview(current) ? current : nil
        VStack(spacing: 0) {
            if let notice {
                ChatPreviewToast(notice: notice,
                                 onOpen: { stage.performNoticeAction(noticeId: notice.id, actionId: NoticeAction.view) },
                                 onDismiss: { stage.dismissNotice(id: notice.id) })
                    .id(notice.id)
                    .conclaveLanePresence(from: .bottom)
                    .onAppear { announce(notice) }
                    // An in-place update (one more message) changes the key, so the 4 s start again (S40 8 m).
                    .task(id: ChatPreviewTimerKey(id: notice.id, count: notice.count, screenReader: screenReader)) {
                        let millis = ChatPreviewPolicy.displayMillis(isScreenReaderRunning: screenReader)
                        guard millis > 0 else { return }
                        try? await Task.sleep(for: .milliseconds(Int(millis)))
                        if !Task.isCancelled { stage.dismissNotice(id: notice.id) }
                    }
            }
        }
        .animation(ConclaveMotion.fast, value: notice?.id)
        .environment(\.colorScheme, .dark)
        .accessibilityIdentifier("chat.preview.host")
    }

    /// One low-priority announcement per preview id; coalesced updates do not announce again (S40 8 i).
    private func announce(_ notice: MeetingNotice) {
        guard announced.id != notice.id else { return }
        announced.id = notice.id
        var text = AttributedString(ChatPreviewCopy.announcement(notice))
        text.accessibilitySpeechAnnouncementPriority = .low
        AccessibilityNotification.Announcement(text).post()
    }
}

/// The timer key: the toast, its message count (an in-place update restarts the time) and the screen reader state.
struct ChatPreviewTimerKey: Equatable {
    let id: String
    let count: Int
    let screenReader: Bool
}

/// A reference latch (never observed view state), so announcing never re-evaluates the host.
final class ChatPreviewAnnouncementLatch {
    var id: String?
}

/// One preview (S40 8 c): the 24 pt avatar of the newest sender, the title line (name, or "Avery Lee and 2 others"; the
/// lock and "Private" for a private message), the body in two lines and, for one sender with several messages, the
/// count line. Flat raised surface with a 1 pt border, radius 12; geometry capped at xxxLarge with the Large Content
/// Viewer (F00 5).
struct ChatPreviewToast: View {
    let notice: MeetingNotice
    let onOpen: () -> Void
    let onDismiss: () -> Void
    @State private var dragOffset: CGFloat = 0
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        let title = ChatPreviewCopy.title(notice)
        let text = ChatPreviewCopy.body(notice)
        let countLine = ChatPreviewCopy.countLine(notice)
        let shape = RoundedRectangle(cornerRadius: ConclaveToastMetrics.radius)
        Button(action: onOpen) {
            HStack(alignment: .top, spacing: 12) {
                // The assistant's mark is the avatar of its identity until the `assistant` glyph lands (R40-5, CL4).
                ConclaveAvatar(name: notice.name, id: notice.userId.isEmpty ? nil : notice.userId, size: .mention)
                VStack(alignment: .leading, spacing: 2) {
                    ChatPreviewTitleLine(title: title, isPrivate: notice.isPrivate)
                    if !text.isEmpty {
                        Text(text)
                            .font(.subheadline)
                            .foregroundStyle(HostingTheme.inCallTextSecondary)
                            .lineLimit(2)
                            .accessibilityIdentifier("chat.preview.body")
                    }
                    if !countLine.isEmpty {
                        Text(countLine)
                            .font(.footnote)
                            .foregroundStyle(HostingTheme.inCallTextSecondary)
                            .lineLimit(1)
                            .accessibilityIdentifier("chat.preview.count")
                    }
                }
                .multilineTextAlignment(.leading)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 12)
            .frame(minHeight: ChatPreviewToastMetrics.minHeight)
            .background(HostingTheme.token(DesignTokens.iosInCallSurfaceRaised), in: shape)
            .overlay { shape.strokeBorder(HostingTheme.inCallBorder, lineWidth: 1) }
            .contentShape(shape)
        }
        .buttonStyle(.plain)
        .offset(y: dragOffset)
        .simultaneousGesture(swipeDown)
        .dynamicTypeSize(...DynamicTypeSize.xxxLarge)
        .accessibilityShowsLargeContentViewer { Text(ChatPreviewCopy.announcement(notice)) }
        .accessibilityLabel(ChatPreviewCopy.label(notice))
        .accessibilityValue(ChatPreviewCopy.value(notice))
        .accessibilityHint(ConclaveStrings.text("Opens chat"))
        .accessibilityAction(.escape) { onDismiss() }
        .accessibilityAction(named: Text(ChatPreviewCopy.dismissLabel(notice))) { onDismiss() }
        .accessibilityIdentifier("chat.preview.toast")
    }

    /// Swipe down dismisses (S40 8 a); a short drag springs back (no travel under Reduce Motion).
    private var swipeDown: some Gesture {
        DragGesture(minimumDistance: ChatPreviewToastMetrics.dragMinimumDistance)
            .onChanged { value in
                dragOffset = max(0, value.translation.height)
            }
            .onEnded { value in
                let travel = value.translation.height
                if travel > ChatPreviewToastMetrics.dismissTravel
                    || value.predictedEndTranslation.height > ChatPreviewToastMetrics.dismissPredictedTravel {
                    onDismiss()
                } else {
                    withAnimation(ConclaveMotion.travel(ConclaveMotion.snap, reduceMotion: reduceMotion)) {
                        dragOffset = 0
                    }
                }
            }
    }
}

/// The title line: the name (semibold) and, for a private message, the lock glyph with "Private" (S40 8 b).
struct ChatPreviewTitleLine: View {
    let title: String
    let isPrivate: Bool

    var body: some View {
        HStack(spacing: 4) {
            if isPrivate {
                Image(systemName: ChatPreviewSymbols.privateMessage)
                    .imageScale(.small)
                    .foregroundStyle(HostingTheme.inCallTextSecondary)
                    .accessibilityHidden(true)
            }
            Text(title)
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(HostingTheme.token(DesignTokens.iosInCallText))
                .lineLimit(1)
            if isPrivate {
                Text(verbatim: "\u{00B7}")
                    .font(.subheadline)
                    .foregroundStyle(HostingTheme.inCallTextSecondary)
                    .accessibilityHidden(true)
                Text(ConclaveStrings.text("Private"))
                    .font(.subheadline)
                    .foregroundStyle(HostingTheme.inCallTextSecondary)
                    .lineLimit(1)
                    .fixedSize()
            }
        }
        .accessibilityIdentifier("chat.preview.title")
    }
}

/// Symbol concepts (`private_message`, S40 R40-5).
enum ChatPreviewSymbols {
    static let privateMessage = ConclaveSymbols.lockFill
}

/// iOS copy (S40 8 g): sentence case bodies from the String Catalog; names and message text are data, never keys.
enum ChatPreviewCopy {
    /// One sender: the name; several: "Avery Lee and 2 others" (F00 grouping, people other than the newest sender).
    static func title(_ notice: MeetingNotice) -> String {
        let others = ChatPreviewPolicy.othersCount(notice)
        if others > 0 { return ConclaveStrings.format("%@ and %lld others", notice.name, others) }
        return notice.name
    }

    /// The body from the presenter's kind and payload (never a file name, S40 8 f).
    static func body(_ notice: MeetingNotice) -> String {
        let text = notice.detail
        switch ChatPreviewPolicy.bodyKind(notice) {
        case .text:
            return text
        case .photo:
            return text.isEmpty ? ConclaveStrings.text("Photo") : ConclaveStrings.format("Photo: %@", text)
        case .gif:
            return text.isEmpty ? ConclaveStrings.text("GIF") : ConclaveStrings.format("GIF: %@", text)
        case .sticker:
            return text.isEmpty ? ConclaveStrings.text("Sticker") : ConclaveStrings.format("Sticker: %@", text)
        case .clip:
            return text.isEmpty ? ConclaveStrings.text("Clip") : ConclaveStrings.format("Clip: %@", text)
        case .voice:
            return text.isEmpty ? ConclaveStrings.text("Voice message") : ConclaveStrings.format("Voice message: %@", text)
        }
    }

    /// "3 new messages" for one sender with several messages; "" otherwise.
    static func countLine(_ notice: MeetingNotice) -> String {
        ChatPreviewPolicy.showsCountLine(notice) ? ConclaveStrings.format("%lld new messages", notice.count) : ""
    }

    /// "Message from Avery Lee: Can you share the deck?" (the label and the announcement).
    static func announcement(_ notice: MeetingNotice) -> String {
        ConclaveStrings.format("Message from %@: %@", title(notice), body(notice))
    }

    static func label(_ notice: MeetingNotice) -> String {
        announcement(notice)
    }

    /// The private tag and the count line, read after the label.
    static func value(_ notice: MeetingNotice) -> String {
        var parts: [String] = []
        if notice.isPrivate { parts.append(ConclaveStrings.text("Private")) }
        let count = countLine(notice)
        if !count.isEmpty { parts.append(count) }
        return parts.joined(separator: ", ")
    }

    static func dismissLabel(_ notice: MeetingNotice) -> String {
        ConclaveStrings.format("Dismiss Message from %@", title(notice))
    }
}
#endif
