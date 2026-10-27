#if os(iOS) && !SKIP
import SwiftUI

// S60 L6-5 (ACT-2) on iOS: K6 PlayerChips, K7 HostBar, K8 Scoreboard and K9 RoundResults.

/// K6: non-interactive chips (24 pt avatar plus name) in an adaptive grid that reflows to fewer columns at large text.
/// The container reads "6 players"; queued people show "next round"; a check marks who acted (never what).
struct GameKitPlayerChips: View {
    let players: [GamePlayerModel]
    let pending: [GamePlayerModel]

    var body: some View {
        LazyVGrid(columns: [GridItem(.adaptive(minimum: 140), spacing: 8, alignment: .leading)], alignment: .leading, spacing: 8) {
            ForEach(players) { player in
                GameKitPlayerChip(player: player)
            }
            ForEach(pending) { player in
                GameKitPlayerChip(player: player)
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel(ActivitiesCopy.players(players.count))
        .accessibilityIdentifier("game.players")
    }
}

struct GameKitPlayerChip: View {
    let player: GamePlayerModel

    var body: some View {
        HStack(spacing: 6) {
            ConclaveAvatar(name: player.name, id: player.id, size: .mention)
            Text(player.isYou ? ConclaveStrings.text("You") : player.name)
                .font(.subheadline)
                .lineLimit(1)
                .foregroundStyle(player.isPending ? HostingTheme.inCallTextSecondary : HostingTheme.token(DesignTokens.iosInCallText))
            if player.isPending {
                Text(ConclaveStrings.text("next round"))
                    .font(.caption)
                    .foregroundStyle(HostingTheme.inCallTextSecondary)
            } else if player.hasActed {
                Image(systemName: ConclaveSymbols.checkmark)
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(HostingTheme.token(DesignTokens.iosInCallSuccess))
                    .accessibilityHidden(true)
            }
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 4)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(HostingTheme.token(DesignTokens.iosInCallSurfaceRaised),
                    in: RoundedRectangle(cornerRadius: CGFloat(DesignTokens.radiusSmall), style: .continuous))
        .accessibilityElement(children: .combine)
    }
}

/// K7: a secondary (neutral bordered) and a primary (coral fill, in-call onCoral ink, never white) side by side,
/// stacked when they do not fit (`ViewThatFits`, Dynamic Type).
struct GameKitHostBar: View {
    let primaryTitle: String
    var primaryEnabled: Bool = true
    var primaryPending: Bool = false
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
            Button(action: onPrimary) {
                HStack(spacing: 8) {
                    if primaryPending {
                        ProgressView().tint(HostingTheme.inCallOnCoral)
                    }
                    Text(primaryTitle)
                }
                .foregroundStyle(HostingTheme.inCallOnCoral)
                .frame(maxWidth: .infinity, minHeight: 44)
            }
            .buttonStyle(.borderedProminent)
            .tint(HostingTheme.coralFill)
            .disabled(!primaryEnabled || primaryPending)
            .opacity(primaryEnabled ? 1 : HostingTheme.disabledOpacity)
            .accessibilityValue(primaryPending ? ConclaveStrings.text("In Progress") : "")
            .accessibilityIdentifier("game.bar.primary")
        }
    }
}

/// K8: ranked rows; the leader row sits on the raised surface with a text twin (never coral text on a raised fill).
struct GameKitScoreboard: View {
    let rows: [GameScoreboardRow]

    var body: some View {
        VStack(spacing: 4) {
            ForEach(rows) { row in
                HStack(spacing: 10) {
                    Text(row.rank.formatted(.number))
                        .font(.subheadline.weight(.semibold))
                        .monospacedDigit()
                        .frame(minWidth: 22, alignment: .leading)
                    Text(row.isYou ? ConclaveStrings.text("You") : row.name)
                        .font(.body)
                        .lineLimit(2)
                    if row.isLeader {
                        // The text twin of the leader row until the R6-1 `trophy` concept lands in the icon manifest.
                        GameKitTag(title: ConclaveStrings.text("Leading"))
                    }
                    Spacer(minLength: 8)
                    Text(GameCopy.score(row.score))
                        .font(.body.weight(.semibold))
                        .monospacedDigit()
                }
                .foregroundStyle(HostingTheme.token(DesignTokens.iosInCallText))
                .padding(.horizontal, 10)
                .padding(.vertical, 6)
                .background(row.isLeader ? HostingTheme.token(DesignTokens.iosInCallSurfaceHigh) : Color.clear,
                            in: RoundedRectangle(cornerRadius: CGFloat(DesignTokens.radiusSmall), style: .continuous))
                .accessibilityElement(children: .ignore)
                .accessibilityLabel(GameCopy.scoreRowLabel(row))
                .accessibilityIdentifier("game.score." + row.id)
            }
        }
    }
}

/// K9: one ranked round ("312 ms", "too soon", "no tap"); muted rows read secondary.
struct GameKitRoundResults: View {
    let rows: [GameKitRoundRow]

    var body: some View {
        VStack(spacing: 4) {
            ForEach(rows) { row in
                HStack(spacing: 10) {
                    Text(row.rank.formatted(.number))
                        .font(.subheadline.weight(.semibold))
                        .monospacedDigit()
                        .frame(minWidth: 22, alignment: .leading)
                    Text(row.isYou ? ConclaveStrings.text("You") : row.name)
                        .font(.body)
                        .lineLimit(2)
                    Spacer(minLength: 8)
                    Text(row.value)
                        .font(.body.weight(.semibold))
                        .monospacedDigit()
                }
                .foregroundStyle(row.isMuted ? HostingTheme.inCallTextSecondary : HostingTheme.token(DesignTokens.iosInCallText))
                .padding(.horizontal, 10)
                .padding(.vertical, 6)
                .background(row.isWinner ? HostingTheme.token(DesignTokens.iosInCallSurfaceHigh) : Color.clear,
                            in: RoundedRectangle(cornerRadius: CGFloat(DesignTokens.radiusSmall), style: .continuous))
                .accessibilityElement(children: .combine)
            }
        }
    }
}
#endif
