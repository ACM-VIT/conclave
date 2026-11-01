#if os(iOS) && !SKIP
import Accessibility
import SwiftUI

struct PromptGameSceneBody: View {
    let games: GameStagePresenter

    var body: some View {
        let scene = games.scene
        if games.chrome.phase == .results {
            PromptResultsBody(games: games, scene: scene)
        } else if let trivia = scene.trivia {
            TriviaSceneView(scene: trivia, games: games)
        } else if let bluff = scene.bluff {
            BluffSceneView(scene: bluff, games: games)
        } else if let choice = scene.wouldYouRather {
            ChoiceSceneView(scene: choice, games: games)
        } else if let vote = scene.mostLikelyTo {
            PersonVoteSceneView(scene: vote, games: games)
        } else if let reaction = scene.reaction {
            ReactionSceneView(scene: reaction, games: games)
        } else if let imposter = scene.imposter {
            ImposterSceneView(scene: imposter, games: games)
        }
    }
}

struct PromptGameHostBar: View {
    let games: GameStagePresenter

    var body: some View {
        let action = PromptScenePolicy.hostAction(games.scene)
        if action != .none {
            let interaction = games.interaction
            let pending = interaction.isPending && interaction.pendingType == action.moveType
            GameKitHostBar(primaryTitle: PromptGameCopy.hostAction(action), primaryEnabled: !interaction.isPending || pending,
                           primaryPending: pending, primaryProminent: !action.isOverride,
                           onPrimary: { _ = games.send(action.intent()) })
                .accessibilityIdentifier("game.host." + action.rawValue)
        }
    }
}

struct PromptStatusSlot: View {
    let games: GameStagePresenter
    var acted = 0
    var total = 0

    var body: some View {
        GameKitStatusRow(acted: acted, total: total, countdown: games.countdown)
    }
}

struct PromptSpectatorNotice: View {
    let games: GameStagePresenter
    var allowsJoin = true

    var body: some View {
        GameKitWatching(title: GameCopy.seatTag(games.chrome.seat) ?? ConclaveStrings.text("Watching"),
                        canJoin: allowsJoin && games.chrome.seat == .canJoin, onJoin: { games.join() })
    }
}

struct PromptOwnerLine: View {
    let name: String
    let isTruth: Bool

    var body: some View {
        HStack(spacing: 6) {
            if isTruth {
                Image(systemName: ConclaveSymbols.checkmarkCircleFill)
                    .font(.footnote)
                    .foregroundStyle(HostingTheme.token(DesignTokens.iosInCallSuccess))
                Text(PromptGameCopy.truth())
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(HostingTheme.token(DesignTokens.iosInCallSuccess))
            } else if !name.isEmpty {
                ConclaveAvatar(name: name, id: name, size: .mention)
                Text(name)
                    .font(.footnote)
                    .foregroundStyle(HostingTheme.inCallTextSecondary)
                    .lineLimit(1)
            }
        }
    }
}

struct PromptOutcomeBadge: View {
    let text: String
    let tone: GameKitMark

    var body: some View {
        let ink = GameKitChoiceRow.tint(tone)
        HStack(spacing: 8) {
            Image(systemName: tone == .wrongPick ? ConclaveSymbols.xmarkCircleFill
                  : (tone == .correct ? ConclaveSymbols.checkmarkCircleFill : ConclaveSymbols.timer))
            Text(text)
        }
        .font(.headline)
        .foregroundStyle(ink)
        .padding(.horizontal, 14)
        .frame(minHeight: 40)
        .background(HostingTheme.token(DesignTokens.iosInCallSurfaceRaised), in: Capsule())
        .accessibilityElement(children: .combine)
    }
}

struct PromptLine: View {
    let text: String

    var body: some View {
        if !text.isEmpty {
            Text(text)
                .font(.footnote)
                .monospacedDigit()
                .foregroundStyle(HostingTheme.inCallTextSecondary)
                .fixedSize(horizontal: false, vertical: true)
        }
    }
}

struct PromptHeadline: View {
    let text: String

    var body: some View {
        if !text.isEmpty {
            Text(text)
                .font(.headline)
                .foregroundStyle(HostingTheme.token(DesignTokens.iosInCallText))
                .fixedSize(horizontal: false, vertical: true)
        }
    }
}

struct PromptResultRow: View {
    let id: String
    let text: String
    var owner: String = ""
    var isTruth = false
    var accessibilityNote: String = ""
    var count: Int = -1
    var mark: GameKitMark = .none

    var body: some View {
        HStack(alignment: .center, spacing: 12) {
            VStack(alignment: .leading, spacing: 4) {
                Text(text)
                    .font(.body)
                    .foregroundStyle(HostingTheme.token(DesignTokens.iosInCallText))
                    .multilineTextAlignment(.leading)
                    .fixedSize(horizontal: false, vertical: true)
                if isTruth || !owner.isEmpty {
                    PromptOwnerLine(name: owner, isTruth: isTruth)
                }
            }
            Spacer(minLength: 8)
            GameKitRowTrailing(count: count, mark: isTruth ? .none : mark)
        }
        .modifier(GameKitRowSurface(mark: mark))
        .accessibilityElement(children: .combine)
        .accessibilityValue(accessibilityNote)
        .accessibilityIdentifier("game.result." + id)
    }
}

struct PromptAnnouncement: ViewModifier {
    let games: GameStagePresenter
    let key: String
    let text: String
    var urgent: Bool = false

    func body(content: Content) -> some View {
        content.task(id: key) {
            if key.isEmpty || text.isEmpty { return }
            if !games.claimAnnouncement(key) { return }
            var attributed = AttributedString(text)
            attributed.accessibilitySpeechAnnouncementPriority = urgent ? .high : .default
            AccessibilityNotification.Announcement(attributed).post()
        }
    }
}

struct PromptResultsBody: View {
    let games: GameStagePresenter
    let scene: GameScene

    var body: some View {
        let isHost = games.chrome.isHost
        VStack(alignment: .leading, spacing: 12) {
            if let imposter = scene.imposter {
                ImposterResultView(scene: imposter)
            } else if scene.wouldYouRather != nil || scene.mostLikelyTo != nil {
                VStack(spacing: 12) {
                    GameKitGlyphTile(gameId: games.chrome.gameId)
                    Text(PromptGameCopy.wrapTitle())
                        .font(.title3.weight(.semibold))
                        .foregroundStyle(HostingTheme.token(DesignTokens.iosInCallText))
                        .accessibilityAddTraits(.isHeader)
                }
                .frame(maxWidth: .infinity)
                .padding(.top, 12)
            } else {
                PromptScoredResults(games: games, kind: scene.kind)
            }
            if !isHost {
                GameKitWaitingLine(text: PromptGameCopy.waitingForHost())
            }
        }
        .accessibilityIdentifier("game.scene.results")
    }
}

struct PromptScoredResults: View {
    let games: GameStagePresenter
    let kind: String

    var body: some View {
        let results = games.results
        GameKitPodium(rows: results.scoreboard)
            .padding(.top, 8)
    }
}
#endif
