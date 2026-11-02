#if os(iOS) && !SKIP
import SwiftUI

struct ImposterSceneView: View {
    let scene: ImposterScene
    let games: GameStagePresenter

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            if scene.isVoting {
                PromptStatusSlot(games: games, acted: scene.votedCount, total: scene.totalPlayers)
                GameKitPrompt(kicker: scene.category, title: PromptGameCopy.voteTitle())
                if !scene.departedName.isEmpty {
                    GameKitNotice(kind: .info, message: PromptGameCopy.departed(scene.departedName))
                }
                ImposterVoteChoices(scene: scene, games: games)
            } else {
                PromptStatusSlot(games: games)
                ImposterDiscussHeader(scene: scene)
                if scene.showsSecretCard {
                    ImposterSecretCard(scene: scene)
                }
            }
            if !scene.isPlayer {
                PromptSpectatorNotice(games: games, allowsJoin: false)
            }
        }
        .accessibilityIdentifier("game.scene.imposter")
    }
}

struct ImposterDiscussHeader: View {
    let scene: ImposterScene

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            if !scene.category.isEmpty {
                Text(scene.category)
                    .font(.title3.weight(.semibold))
                    .foregroundStyle(HostingTheme.token(DesignTokens.iosInCallText))
                    .accessibilityAddTraits(.isHeader)
            }
            if !scene.starterName.isEmpty {
                HStack(spacing: 8) {
                    ConclaveAvatar(name: scene.starterName, id: scene.starterName, size: .mention)
                    Text(ConclaveStrings.format("%@ starts", scene.starterName))
                        .font(.subheadline)
                        .foregroundStyle(HostingTheme.inCallTextSecondary)
                }
                .accessibilityElement(children: .combine)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
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
        VStack(alignment: .leading, spacing: 12) {
            GameKitPrompt(kicker: "", title: PromptGameCopy.result(scene.resultKind))
            let facts = PromptGameCopy.imposterFacts(scene)
            if !facts.isEmpty {
                GameKitFactList(facts: facts)
            }

        }
        .accessibilityIdentifier("game.scene.imposter.result")
    }
}
#endif
