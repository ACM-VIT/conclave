#if os(iOS) && !SKIP
import Accessibility
import SwiftUI

struct ConclaveToastHost: View {
    let item: ConclaveToastItem?
    let isScreenReaderRunning: Bool
    let identifier: String
    let onAction: (ConclaveToastItem) -> Void
    let onDismiss: (String) -> Void
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var announced = ToastAnnouncementLatch()

    init(item: ConclaveToastItem?, isScreenReaderRunning: Bool, identifier: String,
         onAction: @escaping (ConclaveToastItem) -> Void, onDismiss: @escaping (String) -> Void) {
        self.item = item
        self.isScreenReaderRunning = isScreenReaderRunning
        self.identifier = identifier
        self.onAction = onAction
        self.onDismiss = onDismiss
    }

    var body: some View {
        VStack(spacing: 0) {
            if let item {
                ConclaveToast(item: item, identifier: identifier + ".toast", onAction: { onAction(item) })
                    .id(item.id)
                    .conclaveLanePresence(from: .bottom)
                    .accessibilityAction(.escape) { onDismiss(item.id) }
                    .onAppear { announce(item) }
                    .task(id: item.id) {
                        let millis = ConclaveToastTiming.durationMillis(hasAction: item.hasAction,
                                                                        isScreenReaderRunning: isScreenReaderRunning, isProgress: item.isProgress)
                        guard millis > 0 else { return }
                        try? await Task.sleep(for: .milliseconds(Int(millis)))
                        if !Task.isCancelled { onDismiss(item.id) }
                    }
            }
        }
        .animation(ConclaveMotion.fast, value: item?.id)
        .environment(\.colorScheme, .dark)
        .accessibilityIdentifier(identifier)
    }

    private func announce(_ item: ConclaveToastItem) {
        guard announced.id != item.id else { return }
        announced.id = item.id
        var text = AttributedString(item.message)
        text.accessibilitySpeechAnnouncementPriority = item.isFailure ? .high : .low
        AccessibilityNotification.Announcement(text).post()
    }
}

private final class ToastAnnouncementLatch {
    var id: String?
}

struct ConclaveToast: View {
    let item: ConclaveToastItem
    let identifier: String
    let onAction: () -> Void

    var body: some View {
        HStack(spacing: 12) {
            if item.hasAvatar {
                ConclaveAvatar(name: item.avatarName, id: item.avatarId.isEmpty ? nil : item.avatarId, size: .mention)
            }
            Text(item.message)
                .font(.subheadline)
                .foregroundStyle(HostingTheme.token(DesignTokens.iosInCallText))
                .lineLimit(2)
                .frame(maxWidth: .infinity, alignment: .leading)
            if item.hasAction {
                Button(item.actionTitle, action: onAction)
                    .buttonStyle(.borderless)
                    .font(.subheadline.weight(.semibold))
                    .tint(HostingTheme.inCallCoralText)
                    .frame(minHeight: ConclaveToastMetrics.actionTarget)
                    .accessibilityIdentifier(identifier + ".action")
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 12)
        .background(HostingTheme.token(DesignTokens.iosInCallSurfaceRaised),
                    in: RoundedRectangle(cornerRadius: ConclaveToastMetrics.radius))
        .overlay {
            RoundedRectangle(cornerRadius: ConclaveToastMetrics.radius).strokeBorder(HostingTheme.inCallBorder, lineWidth: 1)
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier(identifier)
    }
}

enum ConclaveToastMetrics {
    static let radius = CGFloat(DesignTokens.radiusMedium)
    static let actionTarget: CGFloat = 44
}
#endif
