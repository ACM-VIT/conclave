#if os(iOS) && !SKIP
import SwiftUI

// S60 9 c (ACT-3) on iOS, Would You Rather: choose (K1, K2, K4 two large options separated by "or", changeable until
// the phase ends, "%lld of %lld chose"), reveal (sticky K5 split with counts and names per side; a side nobody picked
// says so; everyone but the seated host reads "Waiting for the host").

struct ChoiceSceneView: View {
    let scene: ChoiceScene
    let games: GameStagePresenter

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            GameKitPrompt(kicker: PromptGameCopy.round(scene.index, of: scene.total), title: PromptGameCopy.wouldYouRather())
            if scene.isReveal {
                GameKitSplitResult(split: scene.split(nobodyLabel: PromptGameCopy.nobodyPicked()))
                if scene.hostAction == .none {
                    PromptLine(text: PromptGameCopy.waitingForHost())
                }
            } else {
                PromptCountdownSlot(games: games)
                ChoiceButtons(scene: scene, games: games)
                PromptLine(text: PromptGameCopy.chose(scene.answeredCount, scene.totalPlayers))
            }
            if !scene.isPlayer {
                PromptSpectatorNotice(games: games)
            }
        }
        .accessibilityIdentifier("game.scene.wouldYouRather")
    }
}

/// K4; a new side is sent, your current side again is not. `voteCast` plays only for a sent pick (S60 9 h).
struct ChoiceButtons: View {
    let scene: ChoiceScene
    let games: GameStagePresenter
    @State private var pendingId = ""
    @State private var castCount = 0

    var body: some View {
        let interaction = games.interaction
        GameKitBinaryChoice(first: scene.kitFirst(), second: scene.kitSecond(),
                            pendingId: interaction.pendingType == "choose" ? pendingId : "",
                            isEnabled: scene.canChoose && !interaction.isPending) { id in
            let option = ChoiceScene.option(forChoice: id)
            if option < 0 || option == scene.myChoice { return }
            if games.send(GameMoveIntent.choose(option)) == .dispatched {
                pendingId = id
                castCount += 1
            }
        }
        .conclaveGestureFeedback(.voteCast, trigger: castCount)
    }
}
#endif
