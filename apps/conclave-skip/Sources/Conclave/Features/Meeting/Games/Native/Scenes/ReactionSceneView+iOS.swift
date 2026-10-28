#if os(iOS) && !SKIP
import SwiftUI

// S60 9 c (ACT-3) on iOS, Reaction: arming and go draw the B1 pad (Boards/ReactionPad+iOS.swift) with the tapped
// count; spectators get the same pad read-only ("Players are tapping"); the reveal shows who was fastest and K9 ranked
// rows ("%lld ms", "too soon", "no tap"). Results are the shell's K8 with "Sharpest reflexes" (PromptResultsBody).

struct ReactionSceneView: View {
    let scene: ReactionScene
    let games: GameStagePresenter

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            GameKitPrompt(kicker: PromptGameCopy.round(scene.round, of: scene.roundTotal),
                          title: scene.phase == "reveal" ? PromptGameCopy.fastest(scene.fastestName) : "")
            if scene.isPadPhase {
                ReactionPad(scene: scene, games: games)
                PromptLine(text: PromptGameCopy.tapped(scene.tappedCount, scene.totalPlayers))
            } else if scene.phase == "reveal" {
                GameKitRoundResults(rows: ReactionSceneView.rows(scene.results))
            }
        }
        .accessibilityIdentifier("game.scene.reaction")
    }

    static func rows(_ results: [ReactionResultModel]) -> [GameKitRoundRow] {
        var rows: [GameKitRoundRow] = []
        for result in results {
            rows.append(GameKitRoundRow(id: result.id, rank: result.position, name: result.name, value: PromptGameCopy.resultValue(result),
                                        isYou: result.isYou, isWinner: result.isFastest, isMuted: result.outcome != .time))
        }
        return rows
    }
}
#endif
