#if os(iOS) && !SKIP
import SwiftUI

// S60 L6-5 (ACT-2) on iOS: K3 ChoiceList, K4 BinaryChoice and K5 SplitResult. Selection, correctness and the
// person's own pick always carry a glyph and a word ("Your answer", "Correct"), never color alone (D4, R03): the
// selection border is 2 pt coral fill, correct is the in-call success border, a wrong pick the system red border.

/// K3: full-width option buttons (min 56 pt, `.body`). The acted control shows a spinner while its move is pending;
/// siblings are disabled until the ack (C6-15).
struct GameKitChoiceList: View {
    let choices: [GameKitChoice]
    let pendingId: String
    let isEnabled: Bool
    let onSelect: (String) -> Void

    var body: some View {
        VStack(spacing: 8) {
            ForEach(choices) { choice in
                GameKitChoiceRow(choice: choice, isPending: pendingId == choice.id,
                                 isEnabled: isEnabled && pendingId.isEmpty && !choice.isDisabled) {
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

    var body: some View {
        Button(action: action) {
            HStack(alignment: .center, spacing: 10) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(choice.text)
                        .font(.body)
                        .foregroundStyle(HostingTheme.token(DesignTokens.iosInCallText))
                        .multilineTextAlignment(.leading)
                        .fixedSize(horizontal: false, vertical: true)
                    if let markText = GameKitChoiceRow.markText(choice.mark) {
                        Label(markText, systemImage: GameKitChoiceRow.markSymbol(choice.mark))
                            .font(.footnote.weight(.semibold))
                            .foregroundStyle(HostingTheme.inCallTextSecondary)
                    } else if !choice.detail.isEmpty {
                        Text(choice.detail)
                            .font(.footnote)
                            .foregroundStyle(HostingTheme.inCallTextSecondary)
                    }
                }
                Spacer(minLength: 8)
                if isPending {
                    ProgressView().tint(HostingTheme.token(DesignTokens.iosInCallText))
                } else if choice.count >= 0 {
                    Text(choice.count.formatted(.number))
                        .font(.body.weight(.semibold))
                        .monospacedDigit()
                        .foregroundStyle(HostingTheme.token(DesignTokens.iosInCallText))
                }
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 10)
            .frame(maxWidth: .infinity, minHeight: 56, alignment: .leading)
            .background(HostingTheme.token(DesignTokens.iosInCallSurfaceRaised),
                        in: RoundedRectangle(cornerRadius: CGFloat(DesignTokens.radiusMedium), style: .continuous))
            .overlay {
                RoundedRectangle(cornerRadius: CGFloat(DesignTokens.radiusMedium), style: .continuous)
                    .strokeBorder(GameKitChoiceRow.border(choice.mark), lineWidth: choice.mark == .none ? 1 : 2)
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(!isEnabled)
        .opacity(isEnabled || choice.mark != .none ? 1 : HostingTheme.disabledOpacity)
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

    static func markSymbol(_ mark: GameKitMark) -> String {
        switch mark {
        case .correct, .selected: return ConclaveSymbols.checkmark
        case .wrongPick, .none: return ConclaveSymbols.xmark
        }
    }

    static func border(_ mark: GameKitMark) -> Color {
        switch mark {
        case .none: return HostingTheme.inCallBorder
        case .selected: return HostingTheme.coralFill
        case .correct: return HostingTheme.token(DesignTokens.iosInCallSuccess)
        case .wrongPick: return HostingTheme.inCallLeave
        }
    }

    /// "Your answer", "Correct, 3 votes" or "Incorrect" (S60 9 i).
    static func accessibilityValue(_ choice: GameKitChoice) -> String {
        var parts: [String] = []
        if let mark = markText(choice.mark) { parts.append(mark) }
        if choice.count >= 0 { parts.append(ActivitiesCopy.voteCountLabel(choice.count)) }
        return parts.joined(separator: ", ")
    }
}

/// K4: two large option buttons separated by "or" (Would You Rather).
struct GameKitBinaryChoice: View {
    let first: GameKitChoice
    let second: GameKitChoice
    let pendingId: String
    let isEnabled: Bool
    let onSelect: (String) -> Void

    var body: some View {
        VStack(spacing: 8) {
            GameKitChoiceRow(choice: first, isPending: pendingId == first.id, isEnabled: isEnabled && pendingId.isEmpty) {
                onSelect(first.id)
            }
            Text(ConclaveStrings.text("or"))
                .font(.footnote.weight(.semibold))
                .foregroundStyle(HostingTheme.inCallTextSecondary)
                .accessibilityHidden(true)
            GameKitChoiceRow(choice: second, isPending: pendingId == second.id, isEnabled: isEnabled && pendingId.isEmpty) {
                onSelect(second.id)
            }
        }
    }
}

/// K5: a flat split bar with counts and names per side (paper at 100% and 32%, no blend between the two).
struct GameKitSplitResult: View {
    let split: GameKitSplit

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            GeometryReader { proxy in
                HStack(spacing: 2) {
                    Rectangle()
                        .fill(HostingTheme.token(DesignTokens.iosInCallText))
                        .frame(width: max(0, (proxy.size.width - 2) * split.fractionA))
                    Rectangle()
                        .fill(HostingTheme.token(DesignTokens.iosInCallText).opacity(0.32))
                }
            }
            .frame(height: 12)
            .clipShape(Capsule())
            .background(HostingTheme.inCallBorderStrong, in: Capsule())
            .accessibilityHidden(true)
            side(label: split.labelA, count: split.countA, names: split.namesA)
            side(label: split.labelB, count: split.countB, names: split.namesB)
        }
    }

    private func side(label: String, count: Int, names: [String]) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack {
                Text(label).font(.subheadline.weight(.semibold))
                Spacer()
                Text(count.formatted(.number)).font(.subheadline.weight(.semibold)).monospacedDigit()
            }
            .foregroundStyle(HostingTheme.token(DesignTokens.iosInCallText))
            if !names.isEmpty {
                Text(names.joined(separator: ", "))
                    .font(.footnote)
                    .foregroundStyle(HostingTheme.inCallTextSecondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel(GameCopy.progress(count, split.total) + ", " + label)
    }
}
#endif
