#if os(iOS) && !SKIP
import SwiftUI
import UIKit

// The chat bubble (F00 C23 = S40 CL1, adopted by RECONCILE R35): shape, tones and grouping geometry for Chat rows
// and the Transcript Ask answers (S60 6). Every bubble is one continuous rounded rectangle at radiusBubble (18) with
// no tails; grouping shows through spacing and the hidden header, so the Android tail corners do not apply here.
// Own public messages take the coral content fill with onCoral ink (the second coral use, F00 2.6 A10; onCoral is
// black under Increase Contrast, 6.764). Peers, answers and every private message take the neutral fill; private
// messages add a 1 pt separator border so privacy never rests on hue (S40 Q9). Text rows pad 12 by 8; media rows
// have no padding and clip to the shape. Rows own the 80% width cap (`ConclaveBubbleGeometry.maxWidthFraction`), the
// header, the private label, the reactions, the delivery line and the one-summary accessibility element (S40 3 c,
// 3 i). Never on a material.

/// The tone colors for content inside a bubble (S40 3 e). Links and mentions of you use `link`.
enum ConclaveBubbleColors {
    static func fill(_ tone: ConclaveBubbleTone) -> Color {
        tone.usesCoralFill ? HostingTheme.coralFill : Color(uiColor: .secondarySystemBackground)
    }

    static func ink(_ tone: ConclaveBubbleTone) -> Color {
        tone.usesCoralFill ? HostingTheme.onCoral : Color.primary
    }

    /// Links on neutral fills are coralText (4.809 on the light, 6.788 on the dark fill); on coral they are onCoral
    /// (never coralText on coral).
    static func link(_ tone: ConclaveBubbleTone) -> Color {
        tone.usesCoralFill ? HostingTheme.onCoral : HostingTheme.coralText
    }

    /// The quote rule: coralText on neutral, ink at 70% on coral.
    static func quoteBar(_ tone: ConclaveBubbleTone) -> Color {
        tone.usesCoralFill ? HostingTheme.onCoral.opacity(ConclaveBubbleGeometry.onCoralQuoteBarOpacity) : HostingTheme.coralText
    }

    /// The quote inset: the tertiary system fill on neutral, ink at 12% on coral.
    static func quoteFill(_ tone: ConclaveBubbleTone) -> Color {
        tone.usesCoralFill ? HostingTheme.onCoral.opacity(ConclaveBubbleGeometry.onCoralQuoteFillOpacity) : Color(uiColor: .tertiarySystemFill)
    }
}

/// One bubble. `content` is the row's text, media or voice control; the bubble sets the ink and the link tint.
struct ConclaveChatBubble<Content: View>: View {
    let tone: ConclaveBubbleTone
    let isMedia: Bool
    let identifier: String
    let content: Content

    init(tone: ConclaveBubbleTone, isMedia: Bool = false, identifier: String, @ViewBuilder content: () -> Content) {
        self.tone = tone
        self.isMedia = isMedia
        self.identifier = identifier
        self.content = content()
    }

    var body: some View {
        let shape = RoundedRectangle(cornerRadius: CGFloat(ConclaveBubbleGeometry.iosCornerRadius), style: .continuous)
        content
            .padding(.horizontal, isMedia ? 0 : CGFloat(ConclaveBubbleGeometry.horizontalPadding))
            .padding(.vertical, isMedia ? 0 : CGFloat(ConclaveBubbleGeometry.verticalPadding))
            .foregroundStyle(ConclaveBubbleColors.ink(tone))
            .tint(ConclaveBubbleColors.link(tone))
            .background(ConclaveBubbleColors.fill(tone), in: shape)
            .clipShape(shape)
            .overlay {
                if tone.hasBorder {
                    shape.strokeBorder(Color(uiColor: .separator), lineWidth: 1)
                }
            }
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier(identifier)
    }
}

/// The reply quote at the top of a bubble (S40 3 c): a 3 pt rule, the author and a two-line preview in an inset,
/// as a Button that jumps to the original message. Its label and hint come from the screen ("Reply to Avery Lee:
/// Starting in 2 min", "Goes to the original message").
struct ConclaveBubbleQuote: View {
    let author: String
    let preview: String
    let tone: ConclaveBubbleTone
    let accessibilityText: String
    let accessibilityHintText: String
    let identifier: String
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 8) {
                Rectangle()
                    .fill(ConclaveBubbleColors.quoteBar(tone))
                    .frame(width: CGFloat(ConclaveBubbleGeometry.quoteBarWidth))
                VStack(alignment: .leading, spacing: 2) {
                    Text(author)
                        .font(.caption.weight(.semibold))
                    Text(preview)
                        .font(.footnote)
                        .lineLimit(2)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .fixedSize(horizontal: false, vertical: true)
            .padding(8)
            .background(ConclaveBubbleColors.quoteFill(tone),
                        in: RoundedRectangle(cornerRadius: CGFloat(ConclaveBubbleGeometry.quoteCornerRadius), style: .continuous))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(accessibilityText)
        .accessibilityHint(accessibilityHintText)
        .accessibilityIdentifier(identifier)
    }
}
#endif
