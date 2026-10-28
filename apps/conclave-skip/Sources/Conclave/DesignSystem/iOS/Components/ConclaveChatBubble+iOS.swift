#if os(iOS) && !SKIP
import SwiftUI
import UIKit

enum ConclaveBubbleColors {
    static func fill(_ tone: ConclaveBubbleTone) -> Color {
        tone.usesCoralFill ? HostingTheme.coralFill : Color(uiColor: .secondarySystemBackground)
    }

    static func ink(_ tone: ConclaveBubbleTone) -> Color {
        tone.usesCoralFill ? HostingTheme.onCoral : Color.primary
    }

    static func link(_ tone: ConclaveBubbleTone) -> Color {
        tone.usesCoralFill ? HostingTheme.onCoral : HostingTheme.coralText
    }

    static func quoteBar(_ tone: ConclaveBubbleTone) -> Color {
        tone.usesCoralFill ? HostingTheme.onCoral.opacity(ConclaveBubbleGeometry.onCoralQuoteBarOpacity) : HostingTheme.coralText
    }

    static func quoteFill(_ tone: ConclaveBubbleTone) -> Color {
        tone.usesCoralFill ? HostingTheme.onCoral.opacity(ConclaveBubbleGeometry.onCoralQuoteFillOpacity) : Color(uiColor: .tertiarySystemFill)
    }
}

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
