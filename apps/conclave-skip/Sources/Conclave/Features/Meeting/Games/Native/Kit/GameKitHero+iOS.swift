#if os(iOS) && !SKIP
import SwiftUI

enum GameGlyphSymbols {
    static func name(_ glyph: GameGlyph) -> String {
        switch glyph {
        case .trivia: return "lightbulb.fill"
        case .bluff: return "theatermasks.fill"
        case .wouldYouRather: return "arrow.left.arrow.right"
        case .mostLikelyTo: return "person.2.fill"
        case .reaction: return "bolt.fill"
        case .imposter: return "person.fill.questionmark"
        case .wordle: return "textformat.abc"
        case .chess: return "checkerboard.rectangle"
        case .zip: return "point.topleft.down.to.point.bottomright.curvepath.fill"
        case .generic: return "gamecontroller.fill"
        }
    }

    static func name(gameId: String) -> String {
        name(GameGlyphPolicy.glyph(gameId: gameId))
    }
}

struct GameKitGlyphTile: View {
    let gameId: String
    var side: CGFloat = 64

    var body: some View {
        Image(systemName: GameGlyphSymbols.name(gameId: gameId))
            .font(.system(size: side * 0.42, weight: .semibold))
            .foregroundStyle(HostingTheme.token(DesignTokens.iosInCallText))
            .frame(width: side, height: side)
            .background(HostingTheme.token(DesignTokens.iosInCallSurfaceRaised),
                        in: RoundedRectangle(cornerRadius: side * 0.28, style: .continuous))
            .accessibilityHidden(true)
    }
}

struct GameKitAvatar: View {
    let player: GamePlayerModel
    var size: ConclaveAvatarSize = .tile

    var body: some View {
        ConclaveAvatar(name: player.name, id: player.id, size: size)
            .opacity(player.isPending ? 0.45 : 1)
            .overlay(alignment: .bottomTrailing) {
                if player.isPending {
                    GameKitAvatarBadge(symbol: ConclaveSymbols.clock, fill: HostingTheme.token(DesignTokens.iosInCallSurfaceHigh))
                } else if player.hasActed {
                    GameKitAvatarBadge(symbol: ConclaveSymbols.checkmark, fill: HostingTheme.token(DesignTokens.iosInCallSuccess))
                }
            }
    }
}

struct GameKitAvatarBadge: View {
    let symbol: String
    let fill: Color

    var body: some View {
        Image(systemName: symbol)
            .font(.system(size: 9, weight: .bold))
            .foregroundStyle(HostingTheme.token(DesignTokens.iosInCallText))
            .frame(width: 18, height: 18)
            .background(fill, in: Circle())
            .overlay { Circle().strokeBorder(HostingTheme.token(DesignTokens.iosInCallTile), lineWidth: 2) }
            .offset(x: 3, y: 3)
            .accessibilityHidden(true)
    }
}

struct GameKitPlayerChips: View {
    let players: [GamePlayerModel]
    let pending: [GamePlayerModel]

    var body: some View {
        LazyVGrid(columns: [GridItem(.adaptive(minimum: 64, maximum: 88), spacing: 8, alignment: .top)], alignment: .leading, spacing: 12) {
            ForEach(players) { player in
                GameKitPlayerCell(player: player)
            }
            ForEach(pending) { player in
                GameKitPlayerCell(player: player)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .contain)
        .accessibilityLabel(ActivitiesCopy.players(players.count))
        .accessibilityIdentifier("game.players")
    }
}

struct GameKitPlayerCell: View {
    let player: GamePlayerModel

    var body: some View {
        VStack(spacing: 6) {
            GameKitAvatar(player: player)
            Text(player.isYou ? ConclaveStrings.text("You") : player.name)
                .font(.caption)
                .foregroundStyle(player.isPending ? HostingTheme.inCallTextSecondary : HostingTheme.token(DesignTokens.iosInCallText))
                .lineLimit(1)
                .truncationMode(.tail)
        }
        .frame(maxWidth: .infinity)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(player.isYou ? ConclaveStrings.text("You") : player.name)
        .accessibilityValue(player.isPending ? ConclaveStrings.text("next round") : "")
    }
}

struct GameKitStatusRow: View {
    let acted: Int
    let total: Int
    let countdown: CountdownModel?

    var body: some View {
        let progress = GameKitProgressPolicy.text(acted: acted, total: total)
        if !progress.isEmpty || countdown != nil {
            HStack(spacing: 8) {
                if !progress.isEmpty {
                    let done = GameKitProgressPolicy.isComplete(acted: acted, total: total)
                    Label {
                        Text(progress)
                            .monospacedDigit()
                            .contentTransition(.numericText())
                    } icon: {
                        Image(systemName: done ? ConclaveSymbols.checkmarkCircleFill : ConclaveSymbols.person2Fill)
                    }
                    .labelStyle(GameKitCompactLabelStyle())
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(done ? HostingTheme.token(DesignTokens.iosInCallSuccess) : HostingTheme.inCallTextSecondary)
                    .padding(.horizontal, 10)
                    .frame(minHeight: 28)
                    .background(HostingTheme.token(DesignTokens.iosInCallSurfaceRaised), in: Capsule())
                    .accessibilityElement(children: .ignore)
                    .accessibilityLabel(GameCopy.progress(acted, total))
                    .accessibilityIdentifier("game.progress")
                }
                Spacer(minLength: 8)
                if let countdown = countdown {
                    GameKitCountdown(model: countdown)
                }
            }
        }
    }
}

struct GameKitWatching: View {
    var title: String = ConclaveStrings.text("Watching")
    let canJoin: Bool
    let onJoin: () -> Void

    var body: some View {
        HStack(spacing: 10) {
            Label(title, systemImage: ConclaveSymbols.eye)
                .labelStyle(GameKitCompactLabelStyle())
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(HostingTheme.inCallTextSecondary)
            Spacer(minLength: 8)
            if canJoin {
                Button(action: onJoin) {
                    Text(ConclaveStrings.text("Join"))
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(HostingTheme.inCallOnCoral)
                        .padding(.horizontal, 16)
                        .frame(minHeight: 34)
                        .background(HostingTheme.coralFill, in: Capsule())
                        .frame(minHeight: 44)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel(ConclaveStrings.text("Join the Game"))
                .accessibilityIdentifier("game.watching.join")
            }
        }
        .padding(.leading, 14)
        .padding(.trailing, 6)
        .frame(minHeight: 48)
        .background(HostingTheme.token(DesignTokens.iosInCallSurfaceRaised),
                    in: RoundedRectangle(cornerRadius: CGFloat(DesignTokens.radiusMedium), style: .continuous))
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("game.notice.spectator")
    }
}

struct GameKitPodium: View {
    let rows: [GameScoreboardRow]

    var body: some View {
        VStack(spacing: 16) {
            if let winner = GameKitPodiumPolicy.winner(rows) {
                VStack(spacing: 8) {
                    ConclaveAvatar(name: winner.name, id: winner.id, size: .lobby)
                        .overlay(alignment: .bottomTrailing) {
                            Image(systemName: ConclaveSymbols.trophyFill)
                                .font(.system(size: 14, weight: .bold))
                                .foregroundStyle(HostingTheme.inCallOnCoral)
                                .frame(width: 30, height: 30)
                                .background(HostingTheme.coralFill, in: Circle())
                                .overlay { Circle().strokeBorder(HostingTheme.token(DesignTokens.iosInCallTile), lineWidth: 3) }
                                .offset(x: 4, y: 4)
                                .accessibilityHidden(true)
                        }
                    Text(winner.isYou ? ConclaveStrings.text("You") : winner.name)
                        .font(.title3.weight(.semibold))
                        .foregroundStyle(HostingTheme.token(DesignTokens.iosInCallText))
                        .lineLimit(1)
                    Text(GameCopy.score(winner.score))
                        .font(.subheadline.weight(.semibold))
                        .monospacedDigit()
                        .foregroundStyle(HostingTheme.inCallTextSecondary)
                }
                .frame(maxWidth: .infinity)
                .accessibilityElement(children: .ignore)
                .accessibilityLabel(GameCopy.scoreRowLabel(winner))
                .accessibilityAddTraits(.isHeader)
                .accessibilityIdentifier("game.podium.winner")
            }
            GameKitScoreboard(rows: GameKitPodiumPolicy.rest(rows))
        }
    }
}

struct GameKitWaitingLine: View {
    let text: String
    var showsSpinner = true

    var body: some View {
        HStack(spacing: 8) {
            if showsSpinner {
                ProgressView()
                    .controlSize(.small)
                    .tint(HostingTheme.inCallTextSecondary)
            }
            Text(text)
                .font(.subheadline)
                .foregroundStyle(HostingTheme.inCallTextSecondary)
                .fixedSize(horizontal: false, vertical: true)
        }
        .frame(maxWidth: .infinity)
        .accessibilityElement(children: .combine)
    }
}
#endif
