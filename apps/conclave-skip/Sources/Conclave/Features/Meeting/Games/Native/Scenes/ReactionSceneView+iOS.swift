#if os(iOS) && !SKIP
import SwiftUI

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
