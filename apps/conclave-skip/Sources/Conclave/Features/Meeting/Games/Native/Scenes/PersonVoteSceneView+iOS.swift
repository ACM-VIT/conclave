#if os(iOS) && !SKIP
import SwiftUI

struct PersonVoteSceneView: View {
    let scene: PersonVoteScene
    let games: GameStagePresenter

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            if !scene.isReveal {
                PromptStatusSlot(games: games, acted: scene.votedCount, total: scene.totalPlayers)
            }
            GameKitPrompt(kicker: "", title: PromptGameCopy.mostLikelyTitle(scene.prompt))
            if scene.isReveal {
                VStack(spacing: 8) {
                    ForEach(scene.candidates) { candidate in
                        PromptResultRow(id: candidate.id, text: candidate.isYou ? ConclaveStrings.text("You") : candidate.name,
                                        accessibilityNote: PromptGameCopy.candidateNote(candidate),
                                        count: max(0, candidate.votes),
                                        mark: candidate.isWinner ? .correct : (candidate.isMine ? .selected : .none))
                    }
                }
            } else {
                if !scene.departedName.isEmpty {
                    GameKitNotice(kind: .info, message: PromptGameCopy.departed(scene.departedName))
                }
                PersonVoteChoices(scene: scene, games: games)
            }
            if !scene.isPlayer {
                PromptSpectatorNotice(games: games)
            }
        }
        .modifier(PromptAnnouncement(games: games, key: PromptScenePolicy.voteRevealKey(scene),
                                     text: PromptGameCopy.voteResultAnnouncement(scene)))
        .accessibilityIdentifier("game.scene.mostLikelyTo")
    }
}

struct PersonVoteChoices: View {
    let scene: PersonVoteScene
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
#endif
