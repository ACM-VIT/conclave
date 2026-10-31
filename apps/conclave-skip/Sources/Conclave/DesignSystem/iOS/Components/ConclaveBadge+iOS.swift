#if os(iOS) && !SKIP
import SwiftUI

struct ConclaveCountBadge: View {
    let count: Int

    var body: some View {
        if ConclaveBadgeCount.isVisible(count) {
            Text(label)
                .font(.caption2.weight(.bold).monospacedDigit())
                .foregroundStyle(HostingTheme.onCoral)
                .padding(.horizontal, 5)
                .frame(minWidth: 18, minHeight: 18)
                .background(HostingTheme.coralFill, in: Capsule())
                .dynamicTypeSize(...DynamicTypeSize.xxxLarge)
                .accessibilityHidden(true)
        }
    }

    private var label: String {
        let shown = ConclaveBadgeCount.displayed(count).formatted()
        return ConclaveBadgeCount.isCapped(count) ? shown + "+" : shown
    }
}

struct ConclaveDotBadge: View {
    var body: some View {
        Circle()
            .fill(HostingTheme.coralFill)
            .frame(width: 8, height: 8)
            .accessibilityHidden(true)
    }
}

struct ConclaveTag: View {
    let tag: ConclavePersonTag

    var body: some View {
        Text(Self.title(tag))
            .font(.caption.weight(.semibold))
            .padding(.horizontal, 6)
            .padding(.vertical, 2)
            .background(Color(uiColor: .tertiarySystemFill), in: Capsule())
    }

    static func title(_ tag: ConclavePersonTag) -> String {
        switch tag {
        case .host: return ConclaveStrings.text("Host")
        case .cohost: return ConclaveStrings.text("Co-Host")
        case .you: return ConclaveStrings.text("You")
        }
    }
}

struct ConclaveTileBadge: View {
    let kind: ConclaveTileBadgeKind
    let size: CGFloat

    var body: some View {
        Image(systemName: symbol)
            .font(size < 20 ? .caption2.weight(.semibold) : .caption.weight(.semibold))
            .dynamicTypeSize(...DynamicTypeSize.large)
            .foregroundStyle(glyph)
            .frame(width: size, height: size)
            .background(fill, in: Circle())
            .accessibilityHidden(true)
    }

    private var symbol: String {
        switch kind {
        case .handRaised: return ConclaveSymbols.handRaisedFill
        case .pinned: return ConclaveSymbols.pinFill
        case .presenting: return ConclaveSymbols.rectangleInsetFilledOnRectangle
        case .weakConnection: return ConclaveSymbols.wifiExclamationmark
        }
    }

    private var fill: Color {
        kind == .handRaised ? HostingTheme.token(DesignTokens.iosInCallWarning) : HostingTheme.inCallLabelScrim
    }

    private var glyph: Color {
        switch kind {
        case .handRaised: return HostingTheme.token(DesignTokens.iosInCallOnControlOff)
        case .weakConnection: return HostingTheme.token(DesignTokens.iosInCallWarning)
        case .pinned, .presenting: return HostingTheme.token(DesignTokens.iosInCallText)
        }
    }
}
#endif
