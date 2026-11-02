#if os(iOS) && !SKIP
import Accessibility
import SwiftUI

enum NoticeCardActionStyle: String, CaseIterable {
    case primary, secondary, quiet
}

struct NoticeCardAction: Identifiable {
    let title: String
    let identifier: String
    let style: NoticeCardActionStyle
    let isEnabled: Bool
    let disabledHint: String
    let action: () -> Void

    var id: String { identifier }
}

enum NoticeCardMetrics {
    static let radius: CGFloat = 20
    static let badge: CGFloat = 28
    static let close: CGFloat = 28
    static let closeTarget: CGFloat = 44
    static let actionHeight: CGFloat = 30
}

struct NoticeCard: View {
    let kind: ConclaveBannerKind
    let title: String
    let text: String
    let announcement: String
    let actions: [NoticeCardAction]
    let onDismiss: (() -> Void)?
    let announces: Bool
    let isAssertive: Bool
    let lineLimit: Int?
    let identifier: String

    @State private var drag = NoticeSwipeOffset.zero
    @State private var isLeaving = false
    @State private var announced: String? = nil
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            NoticeCardBadge(kind: kind)
            VStack(alignment: .leading, spacing: 2) {
                if !title.isEmpty {
                    Text(title)
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(HostingTheme.token(DesignTokens.iosInCallText))
                        .lineLimit(1)
                }
                Text(text)
                    .font(.subheadline)
                    .foregroundStyle(title.isEmpty ? HostingTheme.token(DesignTokens.iosInCallText) : HostingTheme.inCallTextSecondary)
                    .lineLimit(lineLimit)
                    .fixedSize(horizontal: false, vertical: true)
                if !actions.isEmpty {
                    HStack(spacing: 8) {
                        ForEach(actions) { action in
                            NoticeCardActionButton(action: action)
                        }
                    }
                    .padding(.top, 8)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.top, title.isEmpty ? 4 : 0)
            if let onDismiss {
                NoticeCardCloseButton(identifier: identifier + ".dismiss") { leave(NoticeSwipeOutcome.dismissUp, then: onDismiss) }
            }
        }
        .padding(.leading, 12)
        .padding(.trailing, onDismiss == nil ? 14 : 6)
        .padding(.vertical, 12)
        .background(HostingTheme.token(DesignTokens.iosInCallSurfaceRaised),
                    in: RoundedRectangle(cornerRadius: NoticeCardMetrics.radius, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: NoticeCardMetrics.radius, style: .continuous)
                .strokeBorder(HostingTheme.inCallBorder, lineWidth: 1)
        }
        .shadow(color: Color.black.opacity(0.28), radius: 14, x: 0, y: 6)
        .offset(x: reduceMotion ? 0 : CGFloat(drag.x), y: reduceMotion ? 0 : CGFloat(drag.y))
        .opacity(NoticeSwipePolicy.opacity(drag))
        .contentShape(RoundedRectangle(cornerRadius: NoticeCardMetrics.radius, style: .continuous))
        .gesture(swipe)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier(identifier)
        .onAppear { announce() }
        .onChange(of: announcement) { announce() }
    }

    private var swipe: some Gesture {
        DragGesture(minimumDistance: 8)
            .onChanged { value in
                guard !isLeaving else { return }
                drag = NoticeSwipePolicy.offset(dx: Double(value.translation.width), dy: Double(value.translation.height),
                                                isDismissible: onDismiss != nil)
            }
            .onEnded { value in
                guard !isLeaving else { return }
                let outcome = NoticeSwipePolicy.outcome(dx: Double(value.translation.width), dy: Double(value.translation.height),
                                                        predictedDx: Double(value.predictedEndTranslation.width),
                                                        predictedDy: Double(value.predictedEndTranslation.height),
                                                        isDismissible: onDismiss != nil)
                if outcome == NoticeSwipeOutcome.settle || onDismiss == nil {
                    withAnimation(.spring(response: 0.32, dampingFraction: 0.78)) { drag = NoticeSwipeOffset.zero }
                } else if let onDismiss {
                    leave(outcome, then: onDismiss)
                }
            }
    }

    private func leave(_ outcome: NoticeSwipeOutcome, then dismiss: @escaping () -> Void) {
        guard !isLeaving else { return }
        isLeaving = true
        if reduceMotion {
            dismiss()
            return
        }
        withAnimation(.easeIn(duration: 0.18)) {
            drag = NoticeSwipePolicy.exitOffset(outcome, from: drag)
        } completion: {
            dismiss()
        }
    }

    private func announce() {
        guard announces, announced != announcement, !announcement.isEmpty else { return }
        announced = announcement
        var spoken = AttributedString(announcement)
        spoken.accessibilitySpeechAnnouncementPriority = isAssertive ? .high : .low
        AccessibilityNotification.Announcement(spoken).post()
    }
}

private struct NoticeCardBadge: View {
    let kind: ConclaveBannerKind

    var body: some View {
        ZStack {
            Circle().fill(tint.opacity(kind == .info || kind == .reconnecting ? 0.14 : 0.18))
            switch kind {
            case .reconnecting:
                ProgressView().controlSize(.small).tint(tint)
            case .info:
                Image(systemName: ConclaveSymbols.infoCircle).font(.system(size: 14, weight: .semibold))
            case .warning:
                Image(systemName: ConclaveSymbols.exclamationmarkTriangleFill).font(.system(size: 13, weight: .semibold))
            case .error:
                Image(systemName: ConclaveSymbols.exclamationmarkOctagonFill).font(.system(size: 13, weight: .semibold))
            case .success:
                Image(systemName: ConclaveSymbols.checkmarkCircleFill).font(.system(size: 14, weight: .semibold))
            }
        }
        .foregroundStyle(tint)
        .frame(width: NoticeCardMetrics.badge, height: NoticeCardMetrics.badge)
        .accessibilityHidden(true)
    }

    private var tint: Color {
        switch kind {
        case .info, .reconnecting: return HostingTheme.token(DesignTokens.iosInCallText)
        case .warning: return HostingTheme.token(DesignTokens.iosInCallWarning)
        case .success: return HostingTheme.token(DesignTokens.iosInCallSuccess)
        case .error: return Color(uiColor: .systemRed)
        }
    }
}

private struct NoticeCardActionButton: View {
    let action: NoticeCardAction

    var body: some View {
        Button(action: action.action) {
            Text(action.title)
                .font(.subheadline.weight(action.style == .quiet ? .regular : .semibold))
                .lineLimit(1)
                .padding(.horizontal, action.style == .quiet ? 4 : 12)
                .frame(minHeight: NoticeCardMetrics.actionHeight)
                .foregroundStyle(foreground)
                .background {
                    if action.style != .quiet {
                        Capsule().fill(fill)
                    }
                }
                .contentShape(Capsule())
        }
        .buttonStyle(.plain)
        .disabled(!action.isEnabled)
        .opacity(action.isEnabled ? 1 : 0.45)
        .accessibilityHint(action.isEnabled ? "" : action.disabledHint)
        .accessibilityIdentifier(action.identifier)
    }

    private var foreground: Color {
        switch action.style {
        case .primary: return HostingTheme.inCallCoralText
        case .secondary: return HostingTheme.token(DesignTokens.iosInCallText)
        case .quiet: return HostingTheme.inCallTextSecondary
        }
    }

    private var fill: Color {
        action.style == .primary ? HostingTheme.inCallCoralText.opacity(0.16) : Color.white.opacity(0.08)
    }
}

private struct NoticeCardCloseButton: View {
    let identifier: String
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Image(systemName: ConclaveSymbols.xmark)
                .font(.system(size: 11, weight: .bold))
                .foregroundStyle(HostingTheme.inCallTextSecondary)
                .frame(width: NoticeCardMetrics.close, height: NoticeCardMetrics.close)
                .background(Circle().fill(Color.white.opacity(0.08)))
                .frame(width: NoticeCardMetrics.closeTarget, height: NoticeCardMetrics.closeTarget)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .padding(.top, -8)
        .accessibilityLabel(ConclaveStrings.text("Dismiss"))
        .accessibilityIdentifier(identifier)
    }
}
#endif
