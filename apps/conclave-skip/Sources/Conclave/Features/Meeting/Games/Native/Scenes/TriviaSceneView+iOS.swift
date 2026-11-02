#if os(iOS) && !SKIP
import SwiftUI

struct TriviaSceneView: View {
    let scene: TriviaScene
    let games: GameStagePresenter

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            if !scene.isReveal {
                PromptStatusSlot(games: games, acted: scene.answeredCount, total: scene.totalPlayers)
            } else if !scene.isWaitingForQuestion, let outcome = PromptGameCopy.triviaOutcome(scene) {
                PromptOutcomeBadge(text: outcome, tone: PromptGameCopy.triviaTone(scene))
                    .accessibilityIdentifier("game.trivia.outcome")
            }
            GameKitPrompt(kicker: PromptGameCopy.triviaKicker(scene),
                          title: scene.isWaitingForQuestion ? PromptGameCopy.triviaWaiting() : scene.prompt)
            if !scene.isWaitingForQuestion {
                TriviaChoices(scene: scene, games: games)
            }
            if !scene.isPlayer {
                PromptSpectatorNotice(games: games)
            }
        }
        .modifier(PromptAnnouncement(games: games, key: PromptScenePolicy.triviaRevealKey(scene),
                                     text: PromptGameCopy.correctAnswer(scene.correctText)))
        .accessibilityIdentifier("game.scene.trivia")
    }
}

struct TriviaChoices: View {
    let scene: TriviaScene
    let games: GameStagePresenter
    @State private var pendingChoiceId = ""
    @State private var lockedCount = 0

    var body: some View {
        let interaction = games.interaction
        GameKitChoiceList(choices: scene.kitChoices(), pendingId: interaction.pendingType == "answer" ? pendingChoiceId : "",
                          isEnabled: scene.canAnswer && !interaction.isPending) { id in
            let index = scene.index(ofChoice: id)
            if index < 0 { return }
            if games.send(GameMoveIntent.answer(index)) == .dispatched {
                pendingChoiceId = id
                lockedCount += 1
            }
        }
        .conclaveGestureFeedback(.answerLocked, trigger: lockedCount)
    }
}
#endif
