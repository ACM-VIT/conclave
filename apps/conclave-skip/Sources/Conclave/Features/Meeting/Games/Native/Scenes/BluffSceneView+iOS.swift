#if os(iOS) && !SKIP
import SwiftUI

// S60 9 c (ACT-3) on iOS, Bluff: write (K1 with the blanked fact, K2, K10 field with Submit; then "Submitted: %@" and
// the submitted count), choose (K3 options, your own bluff disabled with "Your bluff"), reveal ("The truth" with the
// success border and glyph; "Bluff by %@ · %lld votes"; "You picked this"; the round points as K9). The draft is view
// state that survives pushes and is kept on a rejection; the composer stays until the submit's ack (S60 9 f) and the
// draft clears only when the round changes.

struct BluffSceneView: View {
    let scene: BluffScene
    let games: GameStagePresenter
    @State private var draft = ""

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            GameKitPrompt(kicker: PromptGameCopy.bluffKicker(scene), title: scene.question)
            switch scene.phase {
            case "write":
                PromptCountdownSlot(games: games)
                BluffComposer(scene: scene, games: games, draft: $draft)
            case "choose":
                PromptCountdownSlot(games: games)
                BluffChoices(scene: scene, games: games)
                PromptLine(text: PromptGameCopy.bluffChosenCount(scene))
            case "reveal":
                BluffReveal(scene: scene)
            default:
                EmptyView()
            }
            if !scene.isPlayer {
                PromptSpectatorNotice(games: games)
            }
        }
        .onChange(of: scene.round) {
            draft = ""
        }
        .modifier(PromptAnnouncement(games: games, key: PromptScenePolicy.bluffRevealKey(scene),
                                     text: PromptGameCopy.twoFacts(PromptGameCopy.truth(), scene.truthText)))
        .accessibilityIdentifier("game.scene.bluff")
    }
}

/// K10 plus the submitted state; reads `interaction` for the pending submit.
struct BluffComposer: View {
    let scene: BluffScene
    let games: GameStagePresenter
    @Binding var draft: String
    @State private var submittedCount = 0

    var body: some View {
        let interaction = games.interaction
        let pending = interaction.isPending && interaction.pendingType == "submit"
        VStack(alignment: .leading, spacing: 8) {
            if scene.isPlayer && (scene.canSubmit || pending) {
                GameKitTextEntry(label: PromptGameCopy.bluffField(), placeholder: PromptGameCopy.bluffPlaceholder(),
                                 maxLength: BluffScene.maxBluffLength, text: $draft, submitTitle: PromptGameCopy.bluffSubmit(),
                                 isPending: pending, isEnabled: scene.canSubmit && !interaction.isPending, onSubmit: submit)
            } else if scene.hasSubmitted {
                PromptHeadline(text: PromptGameCopy.bluffSubmitted(scene.myBluff))
                    .accessibilityIdentifier("game.bluff.submitted")
            }
            PromptLine(text: PromptGameCopy.bluffSubmittedCount(scene))
        }
        .conclaveGestureFeedback(.bluffSubmitted, trigger: submittedCount)
    }

    private func submit() {
        let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        if text.isEmpty { return }
        if games.send(GameMoveIntent.submitBluff(text)) == .dispatched {
            submittedCount += 1
        }
    }
}

/// K3 for the choose phase; tapping your current pick again sends nothing.
struct BluffChoices: View {
    let scene: BluffScene
    let games: GameStagePresenter
    @State private var pendingId = ""

    var body: some View {
        let interaction = games.interaction
        GameKitChoiceList(choices: scene.kitChoices(ownLabel: PromptGameCopy.ownBluff()),
                          pendingId: interaction.pendingType == "choose" ? pendingId : "",
                          isEnabled: scene.canChoose && !interaction.isPending) { id in
            for option in scene.options where option.id == id && (option.isMine || option.isOwn) {
                return
            }
            if games.send(GameMoveIntent.chooseBluff(id)) == .dispatched {
                pendingId = id
            }
        }
    }
}

/// The reveal: every option read-only with its truth or author and votes, then the round points.
struct BluffReveal: View {
    let scene: BluffScene

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            ForEach(scene.options) { option in
                PromptResultRow(id: option.id, text: option.text, markText: option.isTruth ? PromptGameCopy.truth() : "",
                                lines: PromptGameCopy.bluffRevealLines(option), count: -1,
                                emphasis: option.isTruth ? .success : (option.isMine ? .selected : .none))
            }
            if !scene.roundPoints.isEmpty {
                GameKitRoundResults(rows: BluffReveal.pointRows(scene.roundPoints))
            }
        }
    }

    static func pointRows(_ points: [RoundPointsModel]) -> [GameKitRoundRow] {
        var rows: [GameKitRoundRow] = []
        var rank = 0
        for entry in points {
            rank += 1
            rows.append(GameKitRoundRow(id: entry.id, rank: rank, name: entry.name, value: PromptGameCopy.plusPoints(entry.points),
                                        isYou: entry.isYou, isWinner: rank == 1, isMuted: false))
        }
        return rows
    }
}
#endif
