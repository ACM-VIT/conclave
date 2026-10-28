#if os(iOS) && !SKIP
import SwiftUI

struct TriviaSceneView: View {
    let scene: TriviaScene
    let games: GameStagePresenter

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            if scene.isWaitingForQuestion {
                GameKitPrompt(kicker: PromptGameCopy.triviaKicker(scene), title: PromptGameCopy.triviaWaiting())
                PromptCountdownSlot(games: games)
            } else {
                GameKitPrompt(kicker: PromptGameCopy.triviaKicker(scene), title: scene.prompt)
                PromptCountdownSlot(games: games)
                TriviaChoices(scene: scene, games: games)
                if scene.isReveal {
                    if let outcome = PromptGameCopy.triviaOutcome(scene) {
                        PromptHeadline(text: outcome)
                            .accessibilityIdentifier("game.trivia.outcome")
                    }
                    if let standing = PromptGameCopy.triviaStanding(scene) {
                        PromptLine(text: standing)
                    }
                } else {
                    PromptLine(text: PromptGameCopy.triviaProgress(scene))
                }
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
