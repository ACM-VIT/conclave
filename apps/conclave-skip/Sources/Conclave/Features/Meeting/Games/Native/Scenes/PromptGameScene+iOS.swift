#if os(iOS) && !SKIP
import Accessibility
import SwiftUI

// S60 9 (ACT-3) on iOS: the body of the six prompt games inside the game shell's scroll view (GameShell+iOS.swift routes
// their scene kinds here and pins `PromptGameHostBar` in its bottom bar, HD request B6-T7 R2). Each scene reads the
// typed scene model the presenter built once per push; controls read `interaction` in their own leaf, and the
// countdown stays its own leaf (S60 8 k). No decorative motion: answers lock, reveals and scores appear in one frame.

/// Switches on the prompt game scene; results (the shell's finished phase) have their own per game bodies.
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

/// The pinned host bar of a prompt game phase (S60 9 c): one primary for a seated host, pending until that emit's ack.
struct PromptGameHostBar: View {
    let games: GameStagePresenter

    var body: some View {
        let action = PromptScenePolicy.hostAction(games.scene)
        if action != .none {
            let interaction = games.interaction
            let pending = interaction.isPending && interaction.pendingType == action.moveType
            GameKitHostBar(primaryTitle: PromptGameCopy.hostAction(action), primaryEnabled: !interaction.isPending || pending,
                           primaryPending: pending, onPrimary: { _ = games.send(action.intent()) })
                .accessibilityIdentifier("game.host." + action.rawValue)
        }
    }
}

/// Observes only `countdown`, so the per-second leaf never re-evaluates the scene.
struct PromptCountdownSlot: View {
    let games: GameStagePresenter

    var body: some View {
        if let countdown = games.countdown {
            GameKitCountdown(model: countdown)
        }
    }
}

/// K13 for a person without a seat: never a self line, Join when the server allows a late seat (S60 8 f).
struct PromptSpectatorNotice: View {
    let games: GameStagePresenter
    var message: String = GameCopy.spectatorBody()

    var body: some View {
        let canJoin = games.chrome.seat == .canJoin
        GameKitNotice(kind: .spectator, message: message, buttonTitle: canJoin ? ConclaveStrings.text("Join") : "",
                      onButton: canJoin ? { games.join() } : nil)
    }
}

/// A quiet secondary line (counts, standings).
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

/// A headline line in paper (an outcome, a winner, a result).
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

/// How a read-only reveal row stands out: the success border with its glyph and word, or the 2 pt coral selection
/// border of your own pick (a non-text indicator next to its "You picked this" or "Your answer" line, R03).
enum PromptRowEmphasis: Equatable {
    case none, success, selected
}

/// A read-only reveal row (Bluff truth and authors, Most Likely To counts): the option, a marked word with its glyph,
/// detail lines and an optional count. Correctness is never color alone (D4): the success border always comes with
/// the glyph and the word.
struct PromptResultRow: View {
    let id: String
    let text: String
    var markText: String = ""
    var lines: [String] = []
    var count: Int = -1
    var emphasis: PromptRowEmphasis = .none

    var body: some View {
        HStack(alignment: .center, spacing: 10) {
            VStack(alignment: .leading, spacing: 2) {
                Text(text)
                    .font(.body)
                    .foregroundStyle(HostingTheme.token(DesignTokens.iosInCallText))
                    .multilineTextAlignment(.leading)
                    .fixedSize(horizontal: false, vertical: true)
                if !markText.isEmpty {
                    Label(markText, systemImage: ConclaveSymbols.checkmark)
                        .font(.footnote.weight(.semibold))
                        .foregroundStyle(HostingTheme.inCallTextSecondary)
                }
                ForEach(lines.indices, id: \.self) { index in
                    Text(lines[index])
                        .font(.footnote)
                        .foregroundStyle(HostingTheme.inCallTextSecondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            Spacer(minLength: 8)
            if count >= 0 {
                Text(count.formatted(.number))
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
                .strokeBorder(border, lineWidth: emphasis == .none ? 1 : 2)
        }
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("game.result." + id)
    }

    private var border: Color {
        switch emphasis {
        case .none: return HostingTheme.inCallBorder
        case .success: return HostingTheme.token(DesignTokens.iosInCallSuccess)
        case .selected: return HostingTheme.coralFill
        }
    }
}

/// One-shot announcement (S60 9 i): posted the first time `key` is claimed for this game session, so a view that
/// appears again (Show Video and back, a scroll) never repeats it. `urgent` is the assertive Reaction "Tap now".
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

/// The finished phase per game (S60 9 c): K8 with the award for the scored games, the wrap for Would You Rather and
/// Most Likely To (no score invented), and the Imposter result lines. Participants see "Waiting for the host".
struct PromptResultsBody: View {
    let games: GameStagePresenter
    let scene: GameScene

    var body: some View {
        let isHost = games.chrome.isHost
        VStack(alignment: .leading, spacing: 12) {
            if let imposter = scene.imposter {
                ImposterResultView(scene: imposter)
            } else if scene.wouldYouRather != nil {
                GameKitPrompt(kicker: ConclaveStrings.text("Results"), title: PromptGameCopy.wrapTitle(),
                              subtitle: PromptGameCopy.wyrWrapBody())
            } else if scene.mostLikelyTo != nil {
                GameKitPrompt(kicker: ConclaveStrings.text("Results"), title: PromptGameCopy.wrapTitle(),
                              subtitle: PromptGameCopy.mltWrapBody())
            } else {
                PromptScoredResults(games: games, kind: scene.kind)
            }
            if !isHost {
                PromptLine(text: PromptGameCopy.waitingForHost())
            }
        }
        .accessibilityIdentifier("game.scene.results")
    }
}

/// Trivia, Bluff and Reaction results: the award as the kicker ("Best bluffer", "Sharpest reflexes"), the winner line
/// and K8.
struct PromptScoredResults: View {
    let games: GameStagePresenter
    let kind: String

    var body: some View {
        let results = games.results
        VStack(alignment: .leading, spacing: 12) {
            GameKitPrompt(kicker: PromptGameCopy.award(kind: kind), title: GameCopy.winnerLine(results) ?? "")
            GameKitScoreboard(rows: results.scoreboard)
        }
    }
}
#endif
