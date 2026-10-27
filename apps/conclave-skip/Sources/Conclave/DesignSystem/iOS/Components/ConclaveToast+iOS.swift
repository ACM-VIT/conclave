#if os(iOS) && !SKIP
import Accessibility
import SwiftUI

// Toasts and the toast host (F00 C13): transient, low-stakes feedback on the dark stage, one at a time. Which
// toast shows, the queue (max 3, coalesced) and suspension while a compact sheet covers the stage belong to the
// S20 lane owner (STG-5); this host draws the current `ConclaveToastItem`, times it (4 s, 8 s with an action,
// persisting under VoiceOver or Switch Control when it has an action, F00 AX11) and announces it once. It runs no
// timer while no toast shows. System-appearance iOS screens never use toasts (inline confirmation instead).

/// The host: place it at the bottom of the stage above the control bar (or above the bottom safe area while chrome
/// hides), outside the self-view snap zone. `onTimeout` and `onDismiss` both hand back the toast id.
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
                                                                        isScreenReaderRunning: isScreenReaderRunning)
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

    /// One announcement per toast id (a reference latch, never observed view state): low priority for events, high
    /// for failures.
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

/// One toast: optional 24 pt avatar, up to two lines of text and an optional borderless action in the in-call
/// coral text color (6.246 on the raised surface), on the flat raised surface with a 1 pt border, radius 12.
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
