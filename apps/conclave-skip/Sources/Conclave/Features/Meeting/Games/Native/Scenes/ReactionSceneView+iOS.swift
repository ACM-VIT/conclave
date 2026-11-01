#if os(iOS) && !SKIP
import SwiftUI

struct ReactionSceneView: View {
    let scene: ReactionScene
    let games: GameStagePresenter

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            if scene.isPadPhase {
                PromptStatusSlot(games: games, acted: scene.tappedCount, total: scene.totalPlayers)
                ReactionPad(scene: scene, games: games)
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
