#if os(iOS) && !SKIP
import SwiftUI

// Badges and tags (F00 C06). Badges are never read on their own: the owner's label or value carries the count
// ("Chat, 3 unread"), tags fold into the row label and tile badges into the tile value.

/// The count badge: ink numerals on coral (6.374, never white), "99+" above 99, removed at zero. Capped with the
/// owner at xxxLarge. Coral fill against the raised in-call surface is 5.043.
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

/// The dot badge: an 8 pt coral circle for "has unseen content" (More), hidden from accessibility.
struct ConclaveDotBadge: View {
    var body: some View {
        Circle()
            .fill(HostingTheme.coralFill)
            .frame(width: 8, height: 8)
            .accessibilityHidden(true)
    }
}

/// A role tag beside a name: neutral, never coral. iOS title case ("Co-Host", S50 R50-5).
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

/// A status badge on a video tile: 24 pt (16 pt dense). Hand raised is the warning fill with an ink glyph (11.855);
/// pinned and presenting are the label scrim with a paper glyph; weak connection is the scrim with the glyph in the
/// warning color. Decorative: the tile value says it.
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
