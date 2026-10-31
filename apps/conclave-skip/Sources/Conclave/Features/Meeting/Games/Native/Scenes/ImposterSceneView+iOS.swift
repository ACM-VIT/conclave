#if os(iOS) && !SKIP
import SwiftUI

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

struct ImposterSecretCard: View {
    let scene: ImposterScene
    @State private var holds = 0

    var body: some View {
        GameKitSecretCard(prompt: PromptGameCopy.holdToReveal(), secret: PromptGameCopy.secret(scene), isEnabled: scene.showsSecretCard,
                          onRevealBegan: { holds += 1 })
            .conclaveGestureFeedback(.revealHeld, trigger: holds)
    }
}

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
