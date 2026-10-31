#if os(iOS) && !SKIP
import SwiftUI
import UIKit

struct ConclaveReactionChip: View {
    let chip: ConclaveReactionChipModel
    let gestureRoute: ConclaveGestureRoute
    let identifier: String
    let reduceMotion: Bool
    let onToggle: (ConclaveReactionChipModel) -> Void
    @State private var adds = 0

    init(chip: ConclaveReactionChipModel, gestureRoute: ConclaveGestureRoute = .live, identifier: String, reduceMotion: Bool,
         onToggle: @escaping (ConclaveReactionChipModel) -> Void) {
        self.chip = chip
        self.gestureRoute = gestureRoute
        self.identifier = identifier
        self.reduceMotion = reduceMotion
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
                ConclaveReactionChipLabel(chip: chip, reduceMotion: reduceMotion)
            }
            .buttonStyle(.plain)
            .modifier(ConclaveReactionChipFeedback(route: gestureRoute, trigger: adds))
            .accessibilityLabel(chip.accessibilityLabel)
            .accessibilityValue(chip.count.formatted())
            .accessibilityAddTraits(chip.isMine ? [.isSelected] : [])
            .accessibilityIdentifier(identifier)
        } else {
            ConclaveReactionChipLabel(chip: chip, reduceMotion: reduceMotion)
                .accessibilityElement(children: .ignore)
                .accessibilityLabel(chip.accessibilityLabel)
                .accessibilityValue(chip.count.formatted())
                .accessibilityIdentifier(identifier)
        }
    }
}

private struct ConclaveReactionChipLabel: View {
    let chip: ConclaveReactionChipModel
    let reduceMotion: Bool

    var body: some View {
        Text(verbatim: chip.emoji + " " + chip.count.formatted())
            .contentTransition(reduceMotion ? .identity : .numericText(value: Double(chip.count)))
            .animation(ConclaveMotion.travel(.snappy(duration: 0.14), reduceMotion: reduceMotion), value: chip.count)
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

private struct ConclaveReactionChipLanding: ViewModifier {
    let isNew: Bool
    let reduceMotion: Bool
    @State private var landed = false

    func body(content: Content) -> some View {
        content
            .scaleEffect(isNew && !reduceMotion && !landed ? 0.5 : 1)
            .onAppear {
                guard isNew && !landed else { return }
                if reduceMotion {
                    landed = true
                } else {
                    withAnimation(.bouncy(duration: 0.18, extraBounce: 0.15)) {
                        landed = true
                    }
                }
            }
    }
}

struct ConclaveReactionChipRow: View {
    let chips: [ConclaveReactionChipModel]
    let gestureRoute: ConclaveGestureRoute
    let identifier: String
    let onToggle: (ConclaveReactionChipModel) -> Void
    @State private var initialIds: Set<String>
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    init(chips: [ConclaveReactionChipModel], gestureRoute: ConclaveGestureRoute = .live, initialIds: Set<String>? = nil,
         identifier: String, onToggle: @escaping (ConclaveReactionChipModel) -> Void) {
        self.chips = chips
        self.gestureRoute = gestureRoute
        self.identifier = identifier
        self.onToggle = onToggle
        _initialIds = State(initialValue: initialIds ?? Set(chips.map { $0.id }))
    }

    var body: some View {
        ConclaveFlowLayout(spacing: CGFloat(ConclaveReactionChipPolicy.spacing)) {
            ForEach(chips) { chip in
                ConclaveReactionChip(chip: chip, gestureRoute: gestureRoute, identifier: identifier + "." + chip.id,
                                     reduceMotion: reduceMotion, onToggle: onToggle)
                    .modifier(ConclaveReactionChipLanding(isNew: !initialIds.contains(chip.id), reduceMotion: reduceMotion))
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier(identifier)
    }
}

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
