#if os(iOS) && !SKIP
import SwiftUI

struct PersonVoteSceneView: View {
    let scene: PersonVoteScene
    let games: GameStagePresenter

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            GameKitPrompt(kicker: PromptGameCopy.round(scene.index, of: scene.total), title: PromptGameCopy.mostLikelyTitle(scene.prompt))
            if scene.isReveal {
                if scene.isTie {
                    PromptHeadline(text: PromptGameCopy.tied(scene.tiedNames))
                }
                VStack(spacing: 8) {
                    ForEach(scene.candidates) { candidate in
                        PromptResultRow(id: candidate.id, text: candidate.isYou ? ConclaveStrings.text("You") : candidate.name,
                                        markText: candidate.isWinner ? PromptGameCopy.mostVotes() : "",
                                        lines: candidate.isMine ? [ConclaveStrings.text("Your answer")] : [],
                                        count: max(0, candidate.votes),
                                        emphasis: candidate.isWinner ? .success : (candidate.isMine ? .selected : .none))
                    }
                }
                if scene.hostAction == .none {
                    PromptLine(text: PromptGameCopy.waitingForHost())
                }
            } else {
                PromptCountdownSlot(games: games)
                if !scene.departedName.isEmpty {
                    GameKitNotice(kind: .info, message: PromptGameCopy.departed(scene.departedName))
                }
                PersonVoteChoices(scene: scene, games: games)
                PromptLine(text: PromptGameCopy.voted(scene.votedCount, scene.totalPlayers))
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
