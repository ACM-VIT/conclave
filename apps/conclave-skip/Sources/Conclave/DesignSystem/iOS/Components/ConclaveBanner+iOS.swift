#if os(iOS) && !SKIP
import Accessibility
import SwiftUI

/// The visual kinds of a banner (F00 C12). Which banner shows, its priority and its copy belong to the S20
/// notice catalog and the banner lane (STG-5), not to this component.
enum ConclaveBannerKind: String, CaseIterable {
    case info, warning, error, success, reconnecting
}

/// Where a banner sits: the always-dark call surface or a system-appearance screen.
enum ConclaveBannerSurface: String, CaseIterable {
    case inCall, app
}

/// One banner action, drawn as a borderless text button after the text.
struct ConclaveBannerAction: Identifiable {
    let title: String
    let identifier: String
    let action: () -> Void

    var id: String { identifier }
}

/// Banner motion (F00 9, C12 h): an 8 pt move plus opacity over 120 ms, opacity only under Reduce Motion.
/// DesignTokens has no motion durations yet; this is `motion.fast` from packages/ui-tokens/src/tokens.ts and moves
/// to the FND-1 A5 motion constants.
enum ConclaveBannerMotion {
    static let duration = 0.12
    static let travel: CGFloat = 8
}

/// A flat banner with a 1 pt border and radius 12, never glass (F00 0.4 O7). A static banner reads as one
/// element; with actions or Dismiss the text comes first and each control stays its own element. Production posts
/// one announcement per new banner text; the silent Debug gallery passes `announces: false`. Text wraps; the
/// `lineLimit` defaults to none (OQ-2b-5) and the lane (STG-5) sets its four-line cap.
struct ConclaveBanner: View {
    let kind: ConclaveBannerKind
    let text: String
    let surface: ConclaveBannerSurface
    let actions: [ConclaveBannerAction]
    let onDismiss: (() -> Void)?
    let announces: Bool
    let lineLimit: Int?
    let identifier: String
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.colorSchemeContrast) private var contrast
    @State private var announced = BannerAnnouncementLatch()

    init(kind: ConclaveBannerKind, text: String, surface: ConclaveBannerSurface = .inCall,
         actions: [ConclaveBannerAction] = [], onDismiss: (() -> Void)? = nil, announces: Bool = true,
         lineLimit: Int? = nil, identifier: String) {
        self.kind = kind
        self.text = text
        self.surface = surface
        self.actions = actions
        self.onDismiss = onDismiss
        self.announces = announces
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

    /// At most one announcement per banner text, however often the body re-runs (a reference box, never observed
    /// view state, so the appearance callback cannot loop).
    private func announce() {
        guard announces, announced.text != text else { return }
        announced.text = text
        AccessibilityNotification.Announcement(text).post()
    }

    private var textColor: Color {
        surface == .inCall ? HostingTheme.token(DesignTokens.iosInCallText) : .primary
    }

    private var fill: Color {
        surface == .inCall ? HostingTheme.token(DesignTokens.iosInCallSurfaceRaised) : Color(uiColor: .secondarySystemGroupedBackground)
    }

    private var border: Color {
        guard surface == .inCall else { return Color(uiColor: .separator) }
        return HostingTheme.token(contrast == .increased ? DesignTokens.iosInCallBorderHighContrast : DesignTokens.iosInCallBorder)
    }

    /// Status colors by surface (F00 C12 e); never coral as a warning.
    private var glyphColor: Color {
        let dark = surface == .inCall || colorScheme == .dark
        switch kind {
        case .info, .reconnecting:
            return surface == .inCall ? HostingTheme.token(DesignTokens.iosInCallText) : HostingTheme.secondaryText
        case .warning:
            if surface == .inCall { return HostingTheme.token(DesignTokens.iosInCallWarning) }
            return HostingTheme.token(dark ? DesignTokens.warningDark : DesignTokens.warningLight)
        case .success:
            if surface == .inCall { return HostingTheme.token(DesignTokens.iosInCallSuccess) }
            return HostingTheme.token(dark ? DesignTokens.successDark : DesignTokens.successLight)
        case .error:
            return Color(uiColor: .systemRed)
        }
    }
}

enum ConclaveBannerMetrics {
    static let radius = CGFloat(DesignTokens.radiusMedium)
    static let dismissTarget: CGFloat = 44
}

/// The status glyph, or a system spinner while reconnecting. The success and offline concepts are pending in the
/// icon manifest, so success uses the checkmark stand-in (FND-1 carry, F00 7.3).
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
                Image(systemName: ConclaveSymbols.checkmark)
            }
        }
        .font(.body)
        .foregroundStyle(color)
        .accessibilityHidden(true)
    }
}

/// Holds the last announced text outside observation.
private final class BannerAnnouncementLatch {
    var text: String?
}

/// Shows and hides a banner with the banner motion. The animation is scoped to this container.
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
#endif
