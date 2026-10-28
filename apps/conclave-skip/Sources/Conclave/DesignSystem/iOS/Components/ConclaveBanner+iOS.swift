#if os(iOS) && !SKIP
import Accessibility
import SwiftUI

enum ConclaveBannerKind: String, CaseIterable {
    case info, warning, error, success, reconnecting
}

enum ConclaveBannerSurface: String, CaseIterable {
    case inCall, app
}

struct ConclaveBannerAction: Identifiable {
    let title: String
    let identifier: String
    let action: () -> Void

    var isEnabled: Bool = true

    var disabledHint: String = ""

    var id: String { identifier }
}

enum ConclaveBannerMotion {
    static let duration = Double(ConclaveMotionDurations.fastMillis) / 1000.0
    static let travel = CGFloat(ConclaveMotionDurations.bannerTravel)
}

struct ConclaveBanner: View {
    let kind: ConclaveBannerKind
    let text: String
    let surface: ConclaveBannerSurface
    let actions: [ConclaveBannerAction]
    let onDismiss: (() -> Void)?
    let announces: Bool
    let isAssertive: Bool
    let lineLimit: Int?
    let identifier: String
    @State private var announced = BannerAnnouncementLatch()

    init(kind: ConclaveBannerKind, text: String, surface: ConclaveBannerSurface = .inCall,
         actions: [ConclaveBannerAction] = [], onDismiss: (() -> Void)? = nil, announces: Bool = true, isAssertive: Bool = false,
         lineLimit: Int? = nil, identifier: String) {
        self.kind = kind
        self.text = text
        self.surface = surface
        self.actions = actions
        self.onDismiss = onDismiss
        self.announces = announces
        self.isAssertive = isAssertive
        self.lineLimit = lineLimit
        self.identifier = identifier
    }

    private var isStatic: Bool { actions.isEmpty && onDismiss == nil }

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            BannerGlyph(kind: kind, color: glyphColor)
            VStack(alignment: .leading, spacing: 8) {
                Text(text)
                    .font(.subheadline)
                    .foregroundStyle(textColor)
                    .lineLimit(lineLimit)
                    .fixedSize(horizontal: false, vertical: true)
                if !actions.isEmpty {
                    HStack(spacing: 16) {
                        ForEach(actions) { action in
                            Button(action.title, action: action.action)
                                .buttonStyle(.borderless)
                                .tint(HostingTheme.coralText)
                                .disabled(!action.isEnabled)
                                .accessibilityHint(action.isEnabled ? "" : action.disabledHint)
                                .accessibilityIdentifier(action.identifier)
                        }
                    }
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            if let onDismiss {
                Button(action: onDismiss) {
                    Image(systemName: ConclaveSymbols.xmark)
                        .frame(width: ConclaveBannerMetrics.dismissTarget, height: ConclaveBannerMetrics.dismissTarget)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .foregroundStyle(textColor)
                .accessibilityLabel(ConclaveStrings.text("Dismiss"))
                .accessibilityIdentifier(identifier + ".dismiss")
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 12)
        .background(fill, in: RoundedRectangle(cornerRadius: ConclaveBannerMetrics.radius))
        .overlay {
            RoundedRectangle(cornerRadius: ConclaveBannerMetrics.radius).strokeBorder(border, lineWidth: 1)
        }
        .accessibilityElement(children: isStatic ? .combine : .contain)
        .accessibilityIdentifier(identifier)
        .onAppear { announce() }
        .onChange(of: text) { announce() }
    }

    private func announce() {
        guard announces, announced.text != text else { return }
        announced.text = text
        var announcement = AttributedString(text)
        announcement.accessibilitySpeechAnnouncementPriority = isAssertive ? .high : .low
        AccessibilityNotification.Announcement(announcement).post()
    }

    private var textColor: Color {
        surface == .inCall ? HostingTheme.token(DesignTokens.iosInCallText) : .primary
    }

    private var fill: Color {
        surface == .inCall ? HostingTheme.token(DesignTokens.iosInCallSurfaceRaised) : Color(uiColor: .secondarySystemGroupedBackground)
    }

    private var border: Color {
        guard surface == .inCall else { return Color(uiColor: .separator) }
        return HostingTheme.inCallBorder
    }

    private var glyphColor: Color {
        switch kind {
        case .info, .reconnecting:
            return surface == .inCall ? HostingTheme.token(DesignTokens.iosInCallText) : HostingTheme.secondaryText
        case .warning:
            return surface == .inCall ? HostingTheme.token(DesignTokens.iosInCallWarning) : HostingTheme.statusWarning
        case .success:
            return surface == .inCall ? HostingTheme.token(DesignTokens.iosInCallSuccess) : HostingTheme.statusSuccess
        case .error:
            return Color(uiColor: .systemRed)
        }
    }
}

enum ConclaveBannerMetrics {
    static let radius = CGFloat(DesignTokens.radiusMedium)
    static let dismissTarget: CGFloat = 44
}

private struct BannerGlyph: View {
    let kind: ConclaveBannerKind
    let color: Color

    var body: some View {
        Group {
            switch kind {
            case .reconnecting:
                ProgressView()
                    .tint(color)
            case .info:
                Image(systemName: ConclaveSymbols.infoCircle)
            case .warning:
                Image(systemName: ConclaveSymbols.exclamationmarkTriangleFill)
            case .error:
                Image(systemName: ConclaveSymbols.exclamationmarkOctagonFill)
            case .success:
                Image(systemName: ConclaveSymbols.checkmarkCircleFill)
            }
        }
        .font(.body)
        .foregroundStyle(color)
        .accessibilityHidden(true)
    }
}

private final class BannerAnnouncementLatch {
    var text: String?
}

struct ConclaveBannerPresence<Content: View>: View {
    let isPresented: Bool
    @ViewBuilder let content: () -> Content
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        VStack(spacing: 0) {
            if isPresented {
                content()
                    .transition(transition)
            }
        }
        .animation(.easeOut(duration: ConclaveBannerMotion.duration), value: isPresented)
    }

    private var transition: AnyTransition {
        reduceMotion ? .opacity : .opacity.combined(with: .offset(y: -ConclaveBannerMotion.travel))
    }
}

enum ConclaveBannerLaneMetrics {

    static let maxWidth: CGFloat = 560

    static let lineLimit = 4
}

struct ConclaveBannerLane<Content: View>: View {
    let noticeID: String?
    let identifier: String
    @ViewBuilder let content: () -> Content

    init(noticeID: String?, identifier: String, @ViewBuilder content: @escaping () -> Content) {
        self.noticeID = noticeID
        self.identifier = identifier
        self.content = content
    }

    var body: some View {
        ConclaveBannerPresence(isPresented: noticeID != nil) {
            content()
                .id(noticeID)
                .frame(maxWidth: ConclaveBannerLaneMetrics.maxWidth)
        }
        .frame(maxWidth: .infinity)
        .padding(.horizontal, CGFloat(DesignTokens.space12))
        .padding(.top, CGFloat(DesignTokens.space8))
        .environment(\.colorScheme, .dark)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier(identifier)
    }
}
#endif
