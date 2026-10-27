#if os(iOS) && !SKIP
import SwiftUI
import UIKit

// The message reaction chip (F00 C24 = S40 CL2): "emoji count" in footnote tabular digits on a tertiary system fill
// capsule, 28 pt tall with a 44 pt hit area. Your own reaction adds a 1 pt coralText outline; the selected trait,
// not color, carries it for VoiceOver. A chip that cannot toggle (private, local or unacknowledged rows) is plain
// text. Tapping toggles; `reactionSent` plays only when the tap adds a reaction (S40 3 h), through the view-local
// route at this chip. Chips wrap with a flow layout. Never coral-filled and never on a material.

/// One chip. `onToggle` hands back the chip so the screen calls its toggle intent.
struct ConclaveReactionChip: View {
    let chip: ConclaveReactionChipModel
    let gestureRoute: ConclaveGestureRoute
    let identifier: String
    let onToggle: (ConclaveReactionChipModel) -> Void
    @State private var adds = 0

    init(chip: ConclaveReactionChipModel, gestureRoute: ConclaveGestureRoute = .live, identifier: String,
         onToggle: @escaping (ConclaveReactionChipModel) -> Void) {
        self.chip = chip
        self.gestureRoute = gestureRoute
        self.identifier = identifier
        self.onToggle = onToggle
    }

    var body: some View {
        if chip.canToggle {
            Button {
                if ConclaveReactionChipPolicy.tapAdds(chip) {
                    switch gestureRoute {
                    case .live:
                        adds += 1
                    case .recordOnly(let record):
                        record(.reactionSent)
                    }
                }
                onToggle(chip)
            } label: {
                ConclaveReactionChipLabel(chip: chip)
            }
            .buttonStyle(.plain)
            .modifier(ConclaveReactionChipFeedback(route: gestureRoute, trigger: adds))
            .accessibilityLabel(chip.accessibilityLabel)
            .accessibilityValue(chip.count.formatted())
            .accessibilityAddTraits(chip.isMine ? [.isSelected] : [])
            .accessibilityIdentifier(identifier)
        } else {
            ConclaveReactionChipLabel(chip: chip)
                .accessibilityElement(children: .ignore)
                .accessibilityLabel(chip.accessibilityLabel)
                .accessibilityValue(chip.count.formatted())
                .accessibilityIdentifier(identifier)
        }
    }
}

/// The visual chip inside its 44 pt target.
private struct ConclaveReactionChipLabel: View {
    let chip: ConclaveReactionChipModel

    var body: some View {
        Text(verbatim: chip.emoji + " " + chip.count.formatted())
            .font(.footnote.monospacedDigit())
            .foregroundStyle(.primary)
            .padding(.horizontal, CGFloat(ConclaveReactionChipPolicy.horizontalPadding))
            .frame(minHeight: CGFloat(ConclaveReactionChipPolicy.iosVisualHeight))
            .background(Color(uiColor: .tertiarySystemFill), in: Capsule())
            .overlay {
                if chip.isMine {
                    Capsule().strokeBorder(HostingTheme.coralText, lineWidth: 1)
                }
            }
            .frame(minWidth: CGFloat(ConclaveReactionChipPolicy.iosTarget), minHeight: CGFloat(ConclaveReactionChipPolicy.iosTarget))
            .contentShape(Rectangle())
    }
}

/// Plays `reactionSent` at this chip in production; the record-only route adds nothing.
private struct ConclaveReactionChipFeedback: ViewModifier {
    let route: ConclaveGestureRoute
    let trigger: Int

    @ViewBuilder
    func body(content: Content) -> some View {
        switch route {
        case .live:
            content.conclaveGestureFeedback(.reactionSent, trigger: trigger)
        case .recordOnly:
            content
        }
    }
}

/// The chips of one message, wrapping onto more lines as needed, each its own element in reading order.
struct ConclaveReactionChipRow: View {
    let chips: [ConclaveReactionChipModel]
    let gestureRoute: ConclaveGestureRoute
    let identifier: String
    let onToggle: (ConclaveReactionChipModel) -> Void

    init(chips: [ConclaveReactionChipModel], gestureRoute: ConclaveGestureRoute = .live, identifier: String,
         onToggle: @escaping (ConclaveReactionChipModel) -> Void) {
        self.chips = chips
        self.gestureRoute = gestureRoute
        self.identifier = identifier
        self.onToggle = onToggle
    }

    var body: some View {
        ConclaveFlowLayout(spacing: CGFloat(ConclaveReactionChipPolicy.spacing)) {
            ForEach(chips) { chip in
                ConclaveReactionChip(chip: chip, gestureRoute: gestureRoute, identifier: identifier + "." + chip.id,
                                     onToggle: onToggle)
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier(identifier)
    }
}

/// A leading-aligned flow: subviews keep their ideal size and wrap to a new line when the next one would overflow.
/// SwiftUI mirrors the placement in right-to-left layouts.
struct ConclaveFlowLayout: Layout {
    let spacing: CGFloat

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let maxWidth = proposal.width ?? .greatestFiniteMagnitude
        var x: CGFloat = 0
        var y: CGFloat = 0
        var lineHeight: CGFloat = 0
        var widest: CGFloat = 0
        for subview in subviews {
            let size = subview.sizeThatFits(.unspecified)
            if x > 0 && x + size.width > maxWidth {
                y += lineHeight + spacing
                x = 0
                lineHeight = 0
            }
            x += size.width
            widest = max(widest, x)
            x += spacing
            lineHeight = max(lineHeight, size.height)
        }
        return CGSize(width: widest, height: y + lineHeight)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        var x = bounds.minX
        var y = bounds.minY
        var lineHeight: CGFloat = 0
        for subview in subviews {
            let size = subview.sizeThatFits(.unspecified)
            if x > bounds.minX && x + size.width > bounds.maxX {
                y += lineHeight + spacing
                x = bounds.minX
                lineHeight = 0
            }
            subview.place(at: CGPoint(x: x, y: y), anchor: .topLeading, proposal: ProposedViewSize(size))
            x += size.width + spacing
            lineHeight = max(lineHeight, size.height)
        }
    }
}
#endif
