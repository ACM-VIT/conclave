#if os(iOS) && !SKIP
import SwiftUI

struct GameKitChoiceList: View {
    let choices: [GameKitChoice]
    let pendingId: String
    let isEnabled: Bool
    let onSelect: (String) -> Void

    var body: some View {
        VStack(spacing: 8) {
            ForEach(choices) { choice in
                GameKitChoiceRow(choice: choice, isPending: pendingId == choice.id,
                                 isEnabled: GameKitChoicePolicy.isInteractive(choice, listEnabled: isEnabled, pendingId: pendingId)) {
                    onSelect(choice.id)
                }
            }
        }
    }
}

struct GameKitChoiceRow: View {
    let choice: GameKitChoice
    let isPending: Bool
    let isEnabled: Bool
    let action: () -> Void
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        let muted = GameKitChoicePolicy.isMuted(choice, isInteractive: isEnabled || isPending)
        Button(action: action) {
            HStack(alignment: .center, spacing: 12) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(choice.text)
                        .font(.body)
                        .foregroundStyle(muted ? HostingTheme.inCallTextSecondary : HostingTheme.token(DesignTokens.iosInCallText))
                        .multilineTextAlignment(.leading)
                        .fixedSize(horizontal: false, vertical: true)
                    if !choice.detail.isEmpty {
                        Text(choice.detail)
                            .font(.footnote)
                            .foregroundStyle(HostingTheme.inCallTextSecondary)
                    }
                }
                Spacer(minLength: 8)
                GameKitRowTrailing(count: choice.count, mark: choice.mark, isPending: isPending)
            }
            .animation(reduceMotion ? nil : .snappy(duration: 0.2), value: choice.mark)
        }
        .buttonStyle(GameKitRowButtonStyle(mark: choice.mark))
        .disabled(!isEnabled)
        .accessibilityValue(GameKitChoiceRow.accessibilityValue(choice))
        .accessibilityAddTraits(choice.isSelected ? .isSelected : [])
        .accessibilityIdentifier("game.choice." + choice.id)
    }

    static func markText(_ mark: GameKitMark) -> String? {
        switch mark {
        case .none: return nil
        case .selected, .wrongPick: return ConclaveStrings.text("Your answer")
        case .correct: return ConclaveStrings.text("Correct")
        }
    }

    static func tint(_ mark: GameKitMark) -> Color {
        switch mark {
        case .none: return HostingTheme.inCallTextSecondary
        case .selected: return HostingTheme.coralFill
        case .correct: return HostingTheme.token(DesignTokens.iosInCallSuccess)
        case .wrongPick: return HostingTheme.inCallLeave
        }
    }

    static func border(_ mark: GameKitMark) -> Color {
        mark == .none ? Color.clear : tint(mark)
    }

    static func accessibilityValue(_ choice: GameKitChoice) -> String {
        var parts: [String] = []
        if let mark = markText(choice.mark) { parts.append(mark) }
        if choice.count >= 0 { parts.append(ActivitiesCopy.voteCountLabel(choice.count)) }
        return parts.joined(separator: ", ")
    }
}

struct GameKitRowTrailing: View {
    let count: Int
    let mark: GameKitMark
    var isPending: Bool = false

    var body: some View {
        HStack(spacing: 10) {
            if count >= 0 {
                Text(count.formatted(.number))
                    .font(.body.weight(.semibold))
                    .monospacedDigit()
                    .foregroundStyle(HostingTheme.token(DesignTokens.iosInCallText))
                    .contentTransition(.numericText())
            }
            if isPending {
                ProgressView()
                    .tint(HostingTheme.token(DesignTokens.iosInCallText))
            } else if mark != .none {
                Image(systemName: mark == .wrongPick ? ConclaveSymbols.xmarkCircleFill : ConclaveSymbols.checkmarkCircleFill)
                    .font(.title3)
                    .foregroundStyle(GameKitChoiceRow.tint(mark))
                    .transition(.scale(scale: 0.6).combined(with: .opacity))
                    .accessibilityHidden(true)
            }
        }
    }
}

struct GameKitRowButtonStyle: ButtonStyle {
    let mark: GameKitMark

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .modifier(GameKitRowSurface(mark: mark, isPressed: configuration.isPressed))
    }
}

struct GameKitRowSurface: ViewModifier {
    let mark: GameKitMark
    var isPressed: Bool = false

    func body(content: Content) -> some View {
        let shape = RoundedRectangle(cornerRadius: CGFloat(DesignTokens.radiusMedium), style: .continuous)
        content
            .padding(.horizontal, 14)
            .padding(.vertical, 12)
            .frame(maxWidth: .infinity, minHeight: 56, alignment: .leading)
            .background(isPressed ? HostingTheme.token(DesignTokens.iosInCallSurfaceHigh)
                        : HostingTheme.token(DesignTokens.iosInCallSurfaceRaised), in: shape)
            .overlay { shape.strokeBorder(GameKitChoiceRow.border(mark), lineWidth: mark == .none ? 0 : 1.5) }
            .contentShape(shape)
    }
}

struct GameKitBinaryChoice: View {
    let first: GameKitChoice
    let second: GameKitChoice
    let pendingId: String
    let isEnabled: Bool
    let onSelect: (String) -> Void

    var body: some View {
        VStack(spacing: 6) {
            GameKitChoiceRow(choice: first, isPending: pendingId == first.id,
                             isEnabled: GameKitChoicePolicy.isInteractive(first, listEnabled: isEnabled, pendingId: pendingId)) {
                onSelect(first.id)
            }
            Text(ConclaveStrings.text("or"))
                .font(.footnote.weight(.semibold))
                .foregroundStyle(HostingTheme.inCallTextSecondary)
                .accessibilityHidden(true)
            GameKitChoiceRow(choice: second, isPending: pendingId == second.id,
                             isEnabled: GameKitChoicePolicy.isInteractive(second, listEnabled: isEnabled, pendingId: pendingId)) {
                onSelect(second.id)
            }
        }
    }
}

struct GameKitSplitResult: View {
    let split: GameKitSplit

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            GameKitSplitSide(label: split.labelA, count: split.countA, total: split.total, fraction: split.fractionOfTotalA,
                             names: split.namesA, leads: split.leadsA, picked: split.picked == 0)
            GameKitSplitSide(label: split.labelB, count: split.countB, total: split.total, fraction: split.fractionOfTotalB,
                             names: split.namesB, leads: split.leadsB, picked: split.picked == 1)
        }
    }
}

struct GameKitSplitSide: View {
    let label: String
    let count: Int
    let total: Int
    let fraction: Double
    let names: [String]
    let leads: Bool
    let picked: Bool

    var body: some View {
        let mark = picked ? GameKitMark.selected : GameKitMark.none
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .firstTextBaseline, spacing: 12) {
                Text(label)
                    .font(leads ? .body.weight(.semibold) : .body)
                    .foregroundStyle(HostingTheme.token(DesignTokens.iosInCallText))
                    .fixedSize(horizontal: false, vertical: true)
                if picked {
                    Image(systemName: ConclaveSymbols.checkmarkCircleFill)
                        .font(.subheadline)
                        .foregroundStyle(HostingTheme.coralFill)
                        .accessibilityHidden(true)
                }
                Spacer(minLength: 8)
                Text(count.formatted(.number))
                    .font(.body.weight(.semibold))
                    .monospacedDigit()
                    .foregroundStyle(HostingTheme.token(DesignTokens.iosInCallText))
            }
            ProgressView(value: fraction)
                .tint(picked ? HostingTheme.coralFill
                      : (leads ? HostingTheme.token(DesignTokens.iosInCallText) : HostingTheme.inCallTextSecondary))
                .accessibilityHidden(true)
            if !names.isEmpty {
                GameKitNameStack(names: names)
            }
        }
        .modifier(GameKitRowSurface(mark: mark))
        .accessibilityElement(children: .combine)
        .accessibilityLabel(GameCopy.progress(count, total) + ", " + label)
        .accessibilityValue(picked ? ConclaveStrings.text("Your answer") : "")
    }
}

struct GameKitNameStack: View {
    let names: [String]

    var body: some View {
        let shown = Array(names.prefix(GameKitNameStackPolicy.visible))
        let extra = GameKitNameStackPolicy.overflow(names.count)
        HStack(spacing: -6) {
            ForEach(Array(shown.enumerated()), id: \.offset) { _, name in
                ConclaveAvatar(name: name, id: name, size: .mention)
                    .overlay { Circle().strokeBorder(HostingTheme.token(DesignTokens.iosInCallSurfaceRaised), lineWidth: 2) }
            }
            if extra > 0 {
                Text("+" + extra.formatted(.number))
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(HostingTheme.inCallTextSecondary)
                    .padding(.leading, 10)
            }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(names.joined(separator: ", "))
    }
}
#endif
