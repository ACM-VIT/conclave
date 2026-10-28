#if os(iOS) && !SKIP
import Accessibility
import SwiftUI

enum ChatPreviewToastMetrics {
    static let minHeight: CGFloat = 44
    static let dismissTravel: CGFloat = 32
    static let dismissPredictedTravel: CGFloat = 80
    static let dragMinimumDistance: CGFloat = 8
}

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

    private func announce(_ notice: MeetingNotice) {
        guard announced.id != notice.id else { return }
        announced.id = notice.id
        var text = AttributedString(ChatPreviewCopy.announcement(notice))
        text.accessibilitySpeechAnnouncementPriority = .low
        AccessibilityNotification.Announcement(text).post()
    }
}

struct ChatPreviewTimerKey: Equatable {
    let id: String
    let count: Int
    let screenReader: Bool
}

final class ChatPreviewAnnouncementLatch {
    var id: String?
}

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

enum ChatPreviewSymbols {
    static let privateMessage = ConclaveSymbols.lockFill
}

enum ChatPreviewCopy {

    static func title(_ notice: MeetingNotice) -> String {
        let others = ChatPreviewPolicy.othersCount(notice)
        if others > 0 { return ConclaveStrings.format("%@ and %lld others", notice.name, others) }
        return notice.name
    }

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

    static func countLine(_ notice: MeetingNotice) -> String {
        ChatPreviewPolicy.showsCountLine(notice) ? ConclaveStrings.format("%lld new messages", notice.count) : ""
    }

    static func announcement(_ notice: MeetingNotice) -> String {
        ConclaveStrings.format("Message from %@: %@", title(notice), body(notice))
    }

    static func label(_ notice: MeetingNotice) -> String {
        announcement(notice)
    }

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
