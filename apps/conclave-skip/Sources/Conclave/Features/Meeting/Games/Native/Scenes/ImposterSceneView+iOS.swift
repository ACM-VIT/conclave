#if os(iOS) && !SKIP
import SwiftUI

// S60 9 c and Q7 (ACT-3) on iOS, Imposter: reveal and discuss (K1 with the category and who starts, the discuss line,
// K2 while the reveal runs, and the K11 secret card: press and hold reveals "Your word: %@" with the category, or
// "You're the Imposter" with the hint; hidden by default for both roles, and the word is not in the view hierarchy at
// all while hidden), vote (K3 person rows with yourself disabled as "You", the voted count, a departed target), and
// the result (crew wins, the imposter escapes, or a tie; who it was and the word). Spectators see only the roles
// secret notice: Imposter is not spectatable, so no seat and no word ever reach them.

struct ImposterSceneView: View {
    let scene: ImposterScene
    let games: GameStagePresenter

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            if scene.isVoting {
                GameKitPrompt(kicker: scene.category, title: PromptGameCopy.voteTitle())
                if !scene.departedName.isEmpty {
                    GameKitNotice(kind: .info, message: PromptGameCopy.departed(scene.departedName))
                }
                ImposterVoteChoices(scene: scene, games: games)
                PromptLine(text: PromptGameCopy.voted(scene.votedCount, scene.totalPlayers))
            } else {
                GameKitPrompt(kicker: PromptGameCopy.discussKicker(scene), title: PromptGameCopy.discussBody())
                PromptCountdownSlot(games: games)
                if scene.showsSecretCard {
                    ImposterSecretCard(scene: scene)
                }
            }
            if !scene.isPlayer {
                GameKitNotice(kind: .spectator, message: GameCopy.rolesSecret())
            }
        }
        .accessibilityIdentifier("game.scene.imposter")
    }
}

/// K11 for the local role. The secret text is built here and handed to the card, which composes it only while held
/// (or while a VoiceOver "Reveal Word" lasts). `revealHeld` plays once per hold.
struct ImposterSecretCard: View {
    let scene: ImposterScene
    @State private var holds = 0

    var body: some View {
        GameKitSecretCard(prompt: PromptGameCopy.holdToReveal(), secret: PromptGameCopy.secret(scene), isEnabled: scene.showsSecretCard,
                          onRevealBegan: { holds += 1 })
            .conclaveGestureFeedback(.revealHeld, trigger: holds)
    }
}

/// K3 person rows for the vote; yourself is never a target (the module rejects a self vote).
struct ImposterVoteChoices: View {
    let scene: ImposterScene
    let games: GameStagePresenter
    @State private var pendingId = ""
    @State private var castCount = 0

    var body: some View {
        let interaction = games.interaction
        GameKitChoiceList(choices: scene.kitChoices(youLabel: ConclaveStrings.text("You")),
                          pendingId: interaction.pendingType == "vote" ? pendingId : "",
                          isEnabled: scene.canVote && !interaction.isPending) { id in
            for candidate in scene.candidates where candidate.id == id && (candidate.isMine || !candidate.isEligible) {
                return
            }
            if games.send(GameMoveIntent.vote(id)) == .dispatched {
                pendingId = id
                castCount += 1
            }
        }
        .conclaveGestureFeedback(.voteCast, trigger: castCount)
    }
}

/// The finished round: the result line, who the imposter was, the word (public now) and an abstention.
struct ImposterResultView: View {
    let scene: ImposterScene

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            GameKitPrompt(kicker: ConclaveStrings.text("Results"), title: PromptGameCopy.result(scene.resultKind))
            if !scene.imposterName.isEmpty {
                PromptHeadline(text: PromptGameCopy.imposterWas(scene.imposterName))
            }
            if !scene.revealedWord.isEmpty {
                PromptHeadline(text: PromptGameCopy.wordWas(scene.revealedWord))
            }
            if scene.abstained {
                PromptLine(text: PromptGameCopy.abstained())
            }
        }
        .accessibilityIdentifier("game.scene.imposter.result")
    }
}
#endif
