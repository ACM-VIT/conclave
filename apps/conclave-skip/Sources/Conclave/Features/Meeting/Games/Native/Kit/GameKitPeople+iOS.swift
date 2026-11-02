#if os(iOS) && !SKIP
import SwiftUI

struct GameKitHostBar: View {
    let primaryTitle: String
    var primaryEnabled: Bool = true
    var primaryPending: Bool = false
    var primaryProminent: Bool = true
    let onPrimary: () -> Void
    var secondaryTitle: String = ""
    var secondaryRole: ButtonRole? = nil
    var onSecondary: (() -> Void)? = nil

    var body: some View {
        ViewThatFits(in: .horizontal) {
            HStack(spacing: 8) { buttons }
            VStack(spacing: 8) { buttons }
        }
    }

    @ViewBuilder
    private var buttons: some View {
        if let onSecondary = onSecondary, !secondaryTitle.isEmpty {
            Button(role: secondaryRole, action: onSecondary) {
                Text(secondaryTitle).frame(maxWidth: .infinity, minHeight: 44)
            }
            .buttonStyle(.bordered)
            .tint(secondaryRole == .destructive ? HostingTheme.inCallLeave : HostingTheme.token(DesignTokens.iosInCallText))
            .accessibilityIdentifier("game.bar.secondary")
        }
        if !primaryTitle.isEmpty {
            let ink = !primaryEnabled ? HostingTheme.inCallTextSecondary
                : primaryProminent ? HostingTheme.inCallOnCoral : HostingTheme.token(DesignTokens.iosInCallText)
            Button(action: onPrimary) {
                HStack(spacing: 8) {
                    if primaryPending {
                        ProgressView().tint(ink)
                    }
                    Text(primaryTitle)
                }
                .foregroundStyle(ink)
                .frame(maxWidth: .infinity, minHeight: 44)
            }
            .modifier(GameKitPrimaryStyle(isProminent: primaryProminent))
            .disabled(!primaryEnabled || primaryPending)
            .accessibilityValue(primaryPending ? ConclaveStrings.text("In Progress") : "")
            .accessibilityIdentifier("game.bar.primary")
        }
    }
}

struct GameKitPrimaryStyle: ViewModifier {
    let isProminent: Bool

    func body(content: Content) -> some View {
        if isProminent {
            content
                .buttonStyle(.borderedProminent)
                .tint(HostingTheme.coralFill)
        } else {
            content
                .buttonStyle(.bordered)
                .tint(HostingTheme.token(DesignTokens.iosInCallText))
        }
    }
}

struct GameKitScoreboard: View {
    let rows: [GameScoreboardRow]

    var body: some View {
        VStack(spacing: 2) {
            ForEach(rows) { row in
                GameKitRankRow(rank: row.rank, name: row.isYou ? ConclaveStrings.text("You") : row.name, value: GameCopy.score(row.score),
                               isHighlighted: row.isLeader, isMuted: false, showsTrophy: row.isLeader)
                    .accessibilityElement(children: .ignore)
                    .accessibilityLabel(GameCopy.scoreRowLabel(row))
                    .accessibilityIdentifier("game.score." + row.id)
            }
        }
    }
}

struct GameKitRoundResults: View {
    let rows: [GameKitRoundRow]

    var body: some View {
        VStack(spacing: 2) {
            ForEach(rows) { row in
                GameKitRankRow(rank: row.rank, name: row.isYou ? ConclaveStrings.text("You") : row.name, value: row.value,
                               isHighlighted: row.isWinner, isMuted: row.isMuted, showsTrophy: false)
                    .accessibilityElement(children: .combine)
            }
        }
    }
}

struct GameKitRankRow: View {
    let rank: Int
    let name: String
    let value: String
    let isHighlighted: Bool
    let isMuted: Bool
    let showsTrophy: Bool

    var body: some View {
        let ink = isMuted ? HostingTheme.inCallTextSecondary : HostingTheme.token(DesignTokens.iosInCallText)
        HStack(spacing: 12) {
            Text(rank.formatted(.number))
                .font(.subheadline.weight(.semibold))
                .monospacedDigit()
                .foregroundStyle(HostingTheme.inCallTextSecondary)
                .frame(minWidth: 20, alignment: .leading)
            Text(name)
                .font(isHighlighted ? .body.weight(.semibold) : .body)
                .foregroundStyle(ink)
                .lineLimit(2)
            if showsTrophy {
                Image(systemName: ConclaveSymbols.trophyFill)
                    .font(.footnote)
                    .foregroundStyle(ink)
                    .accessibilityHidden(true)
            }
            Spacer(minLength: 8)
            Text(value)
                .font(.body.weight(.semibold))
                .monospacedDigit()
                .foregroundStyle(ink)
        }
        .padding(.horizontal, 12)
        .frame(minHeight: 40)
        .background(isHighlighted ? HostingTheme.token(DesignTokens.iosInCallSurfaceHigh) : Color.clear,
                    in: RoundedRectangle(cornerRadius: CGFloat(DesignTokens.radiusSmall), style: .continuous))
    }
}

struct GameKitFact: Identifiable, Equatable {
    let id: String
    let label: String
    let value: String
}

struct GameKitFactList: View {
    let facts: [GameKitFact]

    var body: some View {
        VStack(spacing: 0) {
            ForEach(facts) { fact in
                HStack(alignment: .firstTextBaseline, spacing: 12) {
                    Text(fact.label)
                        .font(.body)
                        .foregroundStyle(HostingTheme.inCallTextSecondary)
                    Spacer(minLength: 8)
                    Text(fact.value)
                        .font(.body.weight(.semibold))
                        .foregroundStyle(HostingTheme.token(DesignTokens.iosInCallText))
                        .multilineTextAlignment(.trailing)
                }
                .padding(.horizontal, 14)
                .frame(minHeight: 48)
                .accessibilityElement(children: .combine)
                .accessibilityIdentifier("game.fact." + fact.id)
                if fact.id != facts.last?.id {
                    Rectangle()
                        .fill(HostingTheme.inCallBorder)
                        .frame(height: 1)
                        .padding(.leading, 14)
                }
            }
        }
        .background(HostingTheme.token(DesignTokens.iosInCallSurfaceRaised),
                    in: RoundedRectangle(cornerRadius: CGFloat(DesignTokens.radiusMedium), style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: CGFloat(DesignTokens.radiusMedium), style: .continuous)
                .strokeBorder(HostingTheme.inCallBorder, lineWidth: 1)
        }
    }
}
#endif
