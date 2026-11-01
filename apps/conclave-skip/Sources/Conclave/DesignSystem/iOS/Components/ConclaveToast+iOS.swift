#if !SKIP
import Foundation

@MainActor
final class ConclaveToastDeadline {
    struct Key: Equatable {
        let id: String
        let durationMillis: Double
    }

    var sleep: (Double) async throws -> Void = { millis in
        try await Task.sleep(nanoseconds: UInt64(millis * 1_000_000))
    }
    private var key: Key?
    private var task: Task<Void, Never>?

    static func key(item: ConclaveToastItem?, isScreenReaderRunning: Bool) -> Key? {
        guard let item else { return nil }
        return Key(id: item.id, durationMillis: ConclaveToastTiming.durationMillis(hasAction: item.hasAction,
                   isScreenReaderRunning: isScreenReaderRunning, isProgress: item.isProgress))
    }

    func update(_ next: Key?, onDismiss: @escaping (String) -> Void) {
        if key == next { return }
        cancel()
        key = next
        guard let next, next.durationMillis > 0 else { return }
        let delay = sleep
        task = Task { @MainActor [weak self] in
            do { try await delay(next.durationMillis) } catch { return }
            if !Task.isCancelled && self?.key == next { onDismiss(next.id) }
        }
    }

    func cancel() {
        task?.cancel()
        task = nil
        key = nil
    }
}
#endif

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
    @State private var deadline = ConclaveToastDeadline()

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
            }
        }
        .onChange(of: ConclaveToastDeadline.key(item: item, isScreenReaderRunning: isScreenReaderRunning), initial: true) { _, key in
            deadline.update(key, onDismiss: onDismiss)
        }
        .onDisappear { deadline.cancel() }
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
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    var body: some View {
        let stacked = dynamicTypeSize.isAccessibilitySize
        let layout = stacked
            ? AnyLayout(VStackLayout(alignment: .leading, spacing: 2))
            : AnyLayout(HStackLayout(spacing: 8))
        let shape = RoundedRectangle(cornerRadius: stacked ? ConclaveToastMetrics.radius : ConclaveToastMetrics.pillRadius,
                                     style: .continuous)
        layout {
            HStack(spacing: 8) {
                if item.hasAvatar {
                    ConclaveAvatar(name: item.avatarName, id: item.avatarId.isEmpty ? nil : item.avatarId, size: .mention)
                }
                Text(item.message)
                    .font(.subheadline)
                    .foregroundStyle(HostingTheme.token(DesignTokens.iosInCallText))
                    .fixedSize(horizontal: false, vertical: true)
            }
            .padding(.vertical, 6)
            if item.hasAction {
                Button(item.actionTitle, action: onAction)
                    .buttonStyle(.borderless)
                    .font(.subheadline.weight(.semibold))
                    .tint(HostingTheme.inCallCoralText)
                    .frame(minHeight: ConclaveToastMetrics.actionTarget)
                    .fixedSize(horizontal: true, vertical: false)
                    .accessibilityIdentifier(identifier + ".action")
            }
        }
        .padding(.leading, item.hasAvatar ? 10 : 16)
        .padding(.trailing, item.hasAction ? 12 : 16)
        .padding(.vertical, stacked ? 8 : (item.hasAction ? 0 : 2))
        .frame(minHeight: ConclaveToastMetrics.pillHeight)
        .background(HostingTheme.token(DesignTokens.iosInCallSurfaceRaised), in: shape)
        .overlay { shape.strokeBorder(HostingTheme.inCallBorder, lineWidth: 1) }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier(identifier)
    }
}

enum ConclaveToastMetrics {
    static let radius = CGFloat(DesignTokens.radiusMedium)
    static let pillRadius: CGFloat = 22
    static let pillHeight: CGFloat = 44
    static let actionTarget: CGFloat = 44
}
#endif
