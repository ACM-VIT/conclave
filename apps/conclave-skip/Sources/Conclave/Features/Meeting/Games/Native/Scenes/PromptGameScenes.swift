import Foundation

enum TriviaOutcome: String, CaseIterable, Equatable {
    case none, correct, wrong, timeUp
}

enum ReactionPadState: String, CaseIterable, Equatable {
    case wait, go, early, locked, measured, spectating
}

enum ReactionResultOutcome: String, CaseIterable, Equatable {
    case time, early, noTap
}

enum ImposterRole: String, CaseIterable, Equatable {
    case crew, imposter, spectator
}

enum ImposterResultKind: String, CaseIterable, Equatable {
    case none, crewWins, imposterWins, tie
}

enum PromptHostAction: String, CaseIterable, Equatable {
    case none, skipQuestion, next, skipWriting, revealNow, callVote, endVote

    var moveType: String {
        switch self {
        case .none: return ""
        case .skipQuestion, .skipWriting, .revealNow: return "skip"
        case .next: return "next"
        case .callVote: return "callVote"
        case .endVote: return "tally"
        }
    }

    func intent() -> GameMoveIntent {
        switch self {
        case .none, .skipQuestion, .skipWriting, .revealNow: return GameMoveIntent.skip()
        case .next: return GameMoveIntent.next()
        case .callVote: return GameMoveIntent.callVote()
        case .endVote: return GameMoveIntent.tally()
        }
    }
}

struct TriviaChoiceModel: Equatable, Identifiable {
    let id: String
    let index: Int
    let text: String

    let count: Int
    let isCorrect: Bool
    let isMine: Bool
}

struct TriviaScene: Equatable {

    let phase: String

    let questionIndex: Int
    let questionNumber: Int
    let questionTotal: Int
    let category: String
    let prompt: String
    let options: [TriviaChoiceModel]
    let answeredCount: Int
    let totalPlayers: Int
    let outcome: TriviaOutcome
    let lastPoints: Int
    let score: Int

    let rank: Int

    let correctText: String
    let isPlayer: Bool
    let hasAnswered: Bool
    let canAnswer: Bool
    let hostAction: PromptHostAction

    var isReveal: Bool { phase == "reveal" }

    var isWaitingForQuestion: Bool { prompt.isEmpty || options.isEmpty }

    func index(ofChoice id: String) -> Int {
        for option in options where option.id == id {
            return option.index
        }
        return -1
    }

    func kitChoices() -> [GameKitChoice] {
        var result: [GameKitChoice] = []
        let revealed = isReveal
        for option in options {
            result.append(GameKitChoice(id: option.id, text: option.text, detail: "", count: revealed ? option.count : -1,
                                        isSelected: option.isMine, isCorrect: revealed && option.isCorrect,
                                        isWrongPick: revealed && option.isMine && !option.isCorrect, isDisabled: !canAnswer))
        }
        return result
    }
}

struct BluffOptionModel: Equatable, Identifiable {
    let id: String
    let text: String

    let isOwn: Bool

    let isTruth: Bool

    let ownerName: String

    let votes: Int
    let isMine: Bool
}

struct RoundPointsModel: Equatable, Identifiable {
    let id: String
    let name: String
    let points: Int
    let isYou: Bool
}

struct BluffScene: Equatable {

    let phase: String
    let round: Int
    let roundTotal: Int
    let question: String
    let options: [BluffOptionModel]
    let submittedCount: Int
    let chosenCount: Int
    let totalPlayers: Int

    let myBluff: String
    let hasSubmitted: Bool

    let canSubmit: Bool
    let canChoose: Bool
    let roundPoints: [RoundPointsModel]
    let score: Int
    let isPlayer: Bool
    let hostAction: PromptHostAction

    static let maxBluffLength = 60

    var truthText: String {
        for option in options where option.isTruth {
            return option.text
        }
        return ""
    }

    func kitChoices(ownLabel: String) -> [GameKitChoice] {
        var result: [GameKitChoice] = []
        for option in options {
            result.append(GameKitChoice(id: option.id, text: option.text, detail: option.isOwn ? ownLabel : "", count: -1,
                                        isSelected: option.isMine, isCorrect: false, isWrongPick: false,
                                        isDisabled: option.isOwn || !canChoose))
        }
        return result
    }
}

struct ChoiceScene: Equatable {

    let phase: String
    let index: Int
    let total: Int
    let optionA: String
    let optionB: String
    let countA: Int
    let countB: Int
    let namesA: [String]
    let namesB: [String]
    let answeredCount: Int
    let totalPlayers: Int

    let myChoice: Int

    let canChoose: Bool
    let isPlayer: Bool
    let hostAction: PromptHostAction

    static let firstId = "a"
    static let secondId = "b"

    var isReveal: Bool { phase == "reveal" }

    static func option(forChoice id: String) -> Int {
        if id == firstId { return 0 }
        if id == secondId { return 1 }
        return -1
    }

    func kitFirst() -> GameKitChoice {
        GameKitChoice(id: ChoiceScene.firstId, text: optionA, detail: "", count: -1, isSelected: myChoice == 0, isCorrect: false,
                      isWrongPick: false, isDisabled: !canChoose)
    }

    func kitSecond() -> GameKitChoice {
        GameKitChoice(id: ChoiceScene.secondId, text: optionB, detail: "", count: -1, isSelected: myChoice == 1, isCorrect: false,
                      isWrongPick: false, isDisabled: !canChoose)
    }

    func split(nobodyLabel: String) -> GameKitSplit {
        GameKitSplit(labelA: optionA, labelB: optionB, countA: countA, countB: countB,
                     namesA: countA <= 0 ? [nobodyLabel] : namesA, namesB: countB <= 0 ? [nobodyLabel] : namesB)
    }
}

struct PersonCandidateModel: Equatable, Identifiable {
    let id: String
    let name: String
    let isYou: Bool

    let votes: Int
    let isWinner: Bool
    let isMine: Bool
    let isEligible: Bool
}

struct PersonVoteScene: Equatable {

    let phase: String
    let index: Int
    let total: Int
    let prompt: String
    let candidates: [PersonCandidateModel]
    let votedCount: Int
    let totalPlayers: Int
    let winnerName: String

    let tiedNames: [String]
    let canVote: Bool
    let isPlayer: Bool

    let departedName: String
    let hostAction: PromptHostAction

    var isReveal: Bool { phase == "reveal" }
    var isTie: Bool { tiedNames.count > 1 }

    func kitChoices(youLabel: String) -> [GameKitChoice] {
        var result: [GameKitChoice] = []
        for candidate in candidates {
            result.append(GameKitChoice(id: candidate.id, text: candidate.isYou ? youLabel : candidate.name, detail: "", count: -1,
                                        isSelected: candidate.isMine, isCorrect: false, isWrongPick: false,
                                        isDisabled: !canVote || !candidate.isEligible))
        }
        return result
    }
}

struct ReactionResultModel: Equatable, Identifiable {
    let id: String

    let position: Int
    let name: String

    let ms: Int
    let outcome: ReactionResultOutcome
    let isYou: Bool
    let isFastest: Bool
}

struct ReactionScene: Equatable {

    let phase: String
    let round: Int
    let roundTotal: Int
    let padState: ReactionPadState

    let reactionMs: Int
    let tappedCount: Int
    let totalPlayers: Int
    let results: [ReactionResultModel]
    let fastestName: String
    let canTap: Bool
    let isPlayer: Bool
    let hostAction: PromptHostAction

    var phaseKey: String { String(round) + "|" + phase }
    var isPadPhase: Bool { phase == "arming" || phase == "go" }

    func displayedPadState(locallySent: Bool) -> ReactionPadState {
        if !isPlayer { return ReactionPadState.spectating }
        if locallySent && (padState == ReactionPadState.wait || padState == ReactionPadState.go) { return ReactionPadState.locked }
        return padState
    }
}

struct ImposterScene: Equatable {

    let phase: String
    let category: String
    let starterName: String
    let role: ImposterRole

    let secretWord: String
    let candidates: [PersonCandidateModel]
    let votedCount: Int
    let totalPlayers: Int
    let resultKind: ImposterResultKind
    let imposterName: String

    let revealedWord: String
    let canVote: Bool
    let canCallVote: Bool
    let canTally: Bool
    let isPlayer: Bool
    let myVote: String

    let abstained: Bool
    let departedName: String
    let hostAction: PromptHostAction

    var showsSecretCard: Bool { isPlayer && role != ImposterRole.spectator && (phase == "reveal" || phase == "discuss") }
    var isVoting: Bool { phase == "vote" }

    func kitChoices(youLabel: String) -> [GameKitChoice] {
        var result: [GameKitChoice] = []
        for candidate in candidates {
            result.append(GameKitChoice(id: candidate.id, text: candidate.name, detail: candidate.isYou ? youLabel : "", count: -1,
                                        isSelected: candidate.isMine, isCorrect: false, isWrongPick: false,
                                        isDisabled: !canVote || !candidate.isEligible))
        }
        return result
    }
}

struct PromptSceneContext: Equatable {
    let localId: String
    let isPlayer: Bool
    let isHost: Bool
    let isRecovering: Bool

    let players: [GamePlayerInput]
    let knownPlayers: [GameNamedPlayer]

    static func make(localId: String = "", isPlayer: Bool = false, isHost: Bool = false, isRecovering: Bool = false,
                     players: [GamePlayerInput] = [], knownPlayers: [GameNamedPlayer] = []) -> PromptSceneContext {
        PromptSceneContext(localId: localId, isPlayer: isPlayer, isHost: isHost, isRecovering: isRecovering, players: players,
                           knownPlayers: knownPlayers)
    }

    func knownName(_ id: String) -> String {
        for player in knownPlayers where player.id == id {
            return player.name
        }
        for player in players where player.id == id {
            return player.name
        }
        return ""
    }
}

enum PromptSceneBuilder {

    static func hostAction(kind: String, phase: String, context: PromptSceneContext) -> PromptHostAction {
        if !context.isHost || !context.isPlayer || context.isRecovering { return PromptHostAction.none }
        switch kind {
        case GameSceneKind.trivia:
            if phase == "question" { return PromptHostAction.skipQuestion }
            if phase == "reveal" { return PromptHostAction.next }
        case GameSceneKind.bluff:
            if phase == "write" { return PromptHostAction.skipWriting }
            if phase == "choose" { return PromptHostAction.revealNow }
            if phase == "reveal" { return PromptHostAction.next }
        case GameSceneKind.wouldYouRather:
            if phase == "choose" { return PromptHostAction.revealNow }
            if phase == "reveal" { return PromptHostAction.next }
        case GameSceneKind.mostLikelyTo:
            if phase == "vote" { return PromptHostAction.revealNow }
            if phase == "reveal" { return PromptHostAction.next }
        case GameSceneKind.reaction:
            if phase == "reveal" { return PromptHostAction.next }
        case GameSceneKind.imposter:
            if phase == "discuss" { return PromptHostAction.callVote }
            if phase == "vote" { return PromptHostAction.endVote }
        default:
            break
        }
        return PromptHostAction.none
    }

    static func trivia(_ projection: TriviaProjection, context: PromptSceneContext) -> TriviaScene {
        let phase = projection.phase
        let revealed = phase == "reveal"
        let isPlayer = context.isPlayer
        let hasAnswered = isPlayer && projection.hasAnswered
        let myChoice = isPlayer ? projection.myChoice : -1
        var options: [TriviaChoiceModel] = []
        var index = 0
        for text in projection.options {
            var count = -1
            if revealed { count = index < projection.optionCounts.count ? projection.optionCounts[index] : 0 }
            options.append(TriviaChoiceModel(id: "q" + String(projection.questionIndex) + "-" + String(index), index: index, text: text,
                                             count: count, isCorrect: revealed && projection.correctIndex == index,
                                             isMine: myChoice >= 0 && myChoice == index))
            index += 1
        }
        var correctText = ""
        if revealed && projection.correctIndex >= 0 && projection.correctIndex < projection.options.count {
            correctText = projection.options[projection.correctIndex]
        }
        let canAnswer = isPlayer && phase == "question" && !hasAnswered && !context.isRecovering && !projection.options.isEmpty
            && !projection.prompt.isEmpty
        return TriviaScene(phase: phase, questionIndex: projection.questionIndex, questionNumber: projection.questionIndex + 1,
                           questionTotal: projection.totalQuestions, category: projection.category, prompt: projection.prompt,
                           options: options, answeredCount: projection.answeredCount, totalPlayers: projection.totalPlayers,
                           outcome: triviaOutcome(projection, isPlayer: isPlayer), lastPoints: isPlayer ? projection.lastRoundPoints : 0,
                           score: isPlayer ? projection.score : 0, rank: isPlayer ? max(0, projection.rank) : 0,
                           correctText: correctText, isPlayer: isPlayer, hasAnswered: hasAnswered, canAnswer: canAnswer,
                           hostAction: hostAction(kind: GameSceneKind.trivia, phase: phase, context: context))
    }

    static func triviaOutcome(_ projection: TriviaProjection, isPlayer: Bool) -> TriviaOutcome {
        if !isPlayer || projection.phase != "reveal" { return TriviaOutcome.none }
        if !projection.hasAnswered { return TriviaOutcome.timeUp }
        if projection.myChoice >= 0 && projection.correctIndex >= 0 {
            return projection.myChoice == projection.correctIndex ? TriviaOutcome.correct : TriviaOutcome.wrong
        }
        if projection.outcome == "correct" { return TriviaOutcome.correct }
        if projection.outcome == "wrong" { return TriviaOutcome.wrong }
        return TriviaOutcome.none
    }

    static func bluff(_ projection: BluffProjection, context: PromptSceneContext) -> BluffScene {
        let phase = projection.phase
        let isPlayer = context.isPlayer
        let revealed = phase == "reveal"
        var options: [BluffOptionModel] = []
        for option in projection.options {
            options.append(BluffOptionModel(id: option.id, text: option.text,
                                            isOwn: isPlayer && !projection.ownOptionId.isEmpty && option.id == projection.ownOptionId,
                                            isTruth: revealed && (option.kind == "real" || option.kind == "truth"),
                                            ownerName: revealed ? option.ownerName : "", votes: revealed ? option.votes : -1,
                                            isMine: isPlayer && !projection.yourPick.isEmpty && option.id == projection.yourPick))
        }
        var points: [RoundPointsModel] = []
        for entry in projection.roundPoints {
            points.append(RoundPointsModel(id: entry.id, name: entry.name, points: entry.score, isYou: entry.id == context.localId))
        }
        let hasSubmitted = isPlayer && projection.hasSubmitted
        return BluffScene(phase: phase, round: projection.round + 1, roundTotal: projection.totalRounds, question: projection.question,
                          options: options, submittedCount: projection.submittedCount, chosenCount: projection.chosenCount,
                          totalPlayers: projection.totalPlayers, myBluff: isPlayer ? projection.yourFake : "", hasSubmitted: hasSubmitted,
                          canSubmit: isPlayer && phase == "write" && !hasSubmitted && !context.isRecovering,
                          canChoose: isPlayer && phase == "choose" && !context.isRecovering, roundPoints: points,
                          score: isPlayer ? projection.score : 0, isPlayer: isPlayer,
                          hostAction: hostAction(kind: GameSceneKind.bluff, phase: phase, context: context))
    }

    static func wouldYouRather(_ projection: WouldYouRatherProjection, context: PromptSceneContext) -> ChoiceScene {
        let phase = projection.phase
        let isPlayer = context.isPlayer
        return ChoiceScene(phase: phase, index: projection.index + 1, total: projection.total, optionA: projection.optionA,
                           optionB: projection.optionB, countA: projection.countA, countB: projection.countB, namesA: projection.namesA,
                           namesB: projection.namesB, answeredCount: projection.answeredCount, totalPlayers: projection.totalPlayers,
                           myChoice: isPlayer ? projection.myChoice : -1,
                           canChoose: isPlayer && phase == "choose" && !context.isRecovering, isPlayer: isPlayer,
                           hostAction: hostAction(kind: GameSceneKind.wouldYouRather, phase: phase, context: context))
    }

    static func count(of id: String, among counts: [GameCountEntry]) -> Int {
        for entry in counts where entry.key == id {
            return entry.count
        }
        return 0
    }

    static func topCount(_ counts: [GameCountEntry]) -> Int {
        var top = 0
        for entry in counts where entry.count > top {
            top = entry.count
        }
        return top
    }

    static func contains(_ players: [GameNamedPlayer], id: String) -> Bool {
        for player in players where player.id == id {
            return true
        }
        return false
    }

    static func mostLikelyTo(_ projection: MostLikelyToProjection, context: PromptSceneContext) -> PersonVoteScene {
        let phase = projection.phase
        let isPlayer = context.isPlayer
        let revealed = phase == "reveal"
        let top = revealed ? topCount(projection.counts) : 0
        let vote = isPlayer ? projection.yourVote : ""
        let voteIsLive = !vote.isEmpty && contains(projection.players, id: vote)
        var candidates: [PersonCandidateModel] = []
        var tied: [String] = []
        for player in projection.players {
            let votes = revealed ? count(of: player.id, among: projection.counts) : -1
            let isWinner = revealed && top > 0 && votes == top
            if isWinner { tied.append(player.name) }
            candidates.append(PersonCandidateModel(id: player.id, name: player.name, isYou: player.id == context.localId && !context.localId.isEmpty,
                                                   votes: votes, isWinner: isWinner, isMine: voteIsLive && player.id == vote,
                                                   isEligible: true))
        }
        var departed = ""
        if phase == "vote" && !vote.isEmpty && !voteIsLive {
            departed = context.knownName(vote)
        }
        var winner = projection.winnerName
        if winner.isEmpty && tied.count == 1 { winner = tied[0] }
        return PersonVoteScene(phase: phase, index: projection.index + 1, total: projection.total, prompt: projection.prompt,
                               candidates: candidates, votedCount: projection.answeredCount, totalPlayers: projection.totalPlayers,
                               winnerName: winner, tiedNames: tied.count > 1 ? tied : [],
                               canVote: isPlayer && phase == "vote" && !context.isRecovering, isPlayer: isPlayer, departedName: departed,
                               hostAction: hostAction(kind: GameSceneKind.mostLikelyTo, phase: phase, context: context))
    }

    static func reaction(_ projection: ReactionProjection, context: PromptSceneContext) -> ReactionScene {
        let phase = projection.phase
        let isPlayer = context.isPlayer
        var padState = ReactionPadState.wait
        if !isPlayer {
            padState = ReactionPadState.spectating
        } else if projection.hasTapped && projection.isEarly {
            padState = ReactionPadState.early
        } else if projection.hasTapped && projection.reactionMs >= 0 {
            padState = ReactionPadState.measured
        } else if projection.hasTapped {
            padState = ReactionPadState.locked
        } else if phase == "go" {
            padState = ReactionPadState.go
        }
        var rows: [ReactionResultModel] = []
        var fastestMarked = false
        if phase == "reveal" {
            var position = 0
            for result in projection.results {
                position += 1
                var outcome = ReactionResultOutcome.noTap
                if result.isEarly {
                    outcome = ReactionResultOutcome.early
                } else if result.reactionMs >= 0 {
                    outcome = ReactionResultOutcome.time
                }
                let fastest = outcome == ReactionResultOutcome.time && !fastestMarked
                if fastest { fastestMarked = true }
                rows.append(ReactionResultModel(id: result.id, position: position, name: result.name,
                                                ms: outcome == ReactionResultOutcome.time ? result.reactionMs : -1, outcome: outcome,
                                                isYou: result.id == context.localId && !context.localId.isEmpty, isFastest: fastest))
            }

            for player in context.players {
                var listed = false
                for result in projection.results where result.id == player.id {
                    listed = true
                }
                if listed { continue }
                position += 1
                rows.append(ReactionResultModel(id: player.id, position: position, name: player.name, ms: -1,
                                                outcome: ReactionResultOutcome.noTap,
                                                isYou: player.id == context.localId && !context.localId.isEmpty, isFastest: false))
            }
        }
        let canTap = isPlayer && !projection.hasTapped && (phase == "arming" || phase == "go") && !context.isRecovering
        return ReactionScene(phase: phase, round: projection.round + 1, roundTotal: projection.totalRounds, padState: padState,
                             reactionMs: isPlayer ? projection.reactionMs : -1, tappedCount: projection.tappedCount,
                             totalPlayers: projection.totalPlayers, results: rows, fastestName: projection.winnerName, canTap: canTap,
                             isPlayer: isPlayer, hostAction: hostAction(kind: GameSceneKind.reaction, phase: phase, context: context))
    }

    static func imposter(_ projection: ImposterProjection, context: PromptSceneContext) -> ImposterScene {
        let phase = projection.phase
        let isPlayer = context.isPlayer
        var role = ImposterRole.spectator
        if isPlayer && projection.role == "crew" {
            role = ImposterRole.crew
        } else if isPlayer && projection.role == "imposter" {
            role = ImposterRole.imposter
        }
        let vote = isPlayer ? projection.yourVote : ""
        let voteIsLive = !vote.isEmpty && contains(projection.players, id: vote)
        let showsCounts = phase == "result"
        var candidates: [PersonCandidateModel] = []
        for player in projection.players {
            let isYou = player.id == context.localId && !context.localId.isEmpty
            candidates.append(PersonCandidateModel(id: player.id, name: player.name, isYou: isYou,
                                                   votes: showsCounts ? count(of: player.id, among: projection.voteCounts) : -1,
                                                   isWinner: showsCounts && player.id == projection.votedOutId && !projection.votedOutId.isEmpty,
                                                   isMine: voteIsLive && player.id == vote, isEligible: !isYou))
        }
        var resultKind = ImposterResultKind.none
        if projection.hasResult {
            if projection.isTie {
                resultKind = ImposterResultKind.tie
            } else if projection.crewWon {
                resultKind = ImposterResultKind.crewWins
            } else {
                resultKind = ImposterResultKind.imposterWins
            }
        }
        var departed = ""
        if phase == "vote" && !vote.isEmpty && !voteIsLive {
            departed = context.knownName(vote)
        }
        let seatedHost = context.isHost && isPlayer && !context.isRecovering
        return ImposterScene(phase: phase, category: projection.category, starterName: projection.starterName, role: role,
                             secretWord: role == ImposterRole.crew ? projection.secretWord : "", candidates: candidates,
                             votedCount: projection.votedPlayerIds.count, totalPlayers: projection.totalPlayers, resultKind: resultKind,
                             imposterName: projection.imposterName, revealedWord: projection.hasResult ? projection.resultWord : "",
                             canVote: isPlayer && phase == "vote" && !context.isRecovering, canCallVote: seatedHost && phase == "discuss",
                             canTally: seatedHost && phase == "vote", isPlayer: isPlayer, myVote: voteIsLive ? vote : "",
                             abstained: isPlayer && phase == "result" && vote.isEmpty, departedName: departed,
                             hostAction: hostAction(kind: GameSceneKind.imposter, phase: phase, context: context))
    }
}

enum PromptOutcomePolicy {

    static func trivia(previous: TriviaScene?, next: TriviaScene?) -> FeedbackKind {
        guard let before = previous, let after = next else { return FeedbackKind.none }
        if !after.isPlayer || before.questionIndex != after.questionIndex { return FeedbackKind.none }
        if before.phase != "question" || after.phase != "reveal" { return FeedbackKind.none }
        if after.outcome == TriviaOutcome.correct { return FeedbackKind.gameCorrect }
        if after.outcome == TriviaOutcome.wrong { return FeedbackKind.gameWrong }
        return FeedbackKind.none
    }

    static func reaction(previous: ReactionScene?, next: ReactionScene?) -> FeedbackKind {
        guard let before = previous, let after = next else { return FeedbackKind.none }
        if !after.isPlayer || before.round != after.round { return FeedbackKind.none }
        if before.padState != ReactionPadState.early && after.padState == ReactionPadState.early { return FeedbackKind.tapEarly }
        return FeedbackKind.none
    }
}

enum PromptScenePolicy {

    static func hostAction(_ scene: GameScene) -> PromptHostAction {
        if let trivia = scene.trivia { return trivia.hostAction }
        if let bluff = scene.bluff { return bluff.hostAction }
        if let choice = scene.wouldYouRather { return choice.hostAction }
        if let vote = scene.mostLikelyTo { return vote.hostAction }
        if let reaction = scene.reaction { return reaction.hostAction }
        if let imposter = scene.imposter { return imposter.hostAction }
        return PromptHostAction.none
    }

    static func isPromptGame(_ kind: String) -> Bool {
        kind == GameSceneKind.trivia || kind == GameSceneKind.bluff || kind == GameSceneKind.wouldYouRather
            || kind == GameSceneKind.mostLikelyTo || kind == GameSceneKind.reaction || kind == GameSceneKind.imposter
    }

    static func triviaRevealKey(_ scene: TriviaScene) -> String {
        scene.isReveal && !scene.correctText.isEmpty ? "trivia-reveal-" + String(scene.questionIndex) : ""
    }

    static func bluffRevealKey(_ scene: BluffScene) -> String {
        scene.phase == "reveal" && !scene.truthText.isEmpty ? "bluff-reveal-" + String(scene.round) : ""
    }

    static func voteRevealKey(_ scene: PersonVoteScene) -> String {
        scene.isReveal && (scene.isTie || !scene.winnerName.isEmpty) ? "vote-reveal-" + String(scene.index) : ""
    }

    static func reactionGoKey(_ scene: ReactionScene) -> String {
        scene.isPlayer && scene.padState == ReactionPadState.go && scene.canTap ? "reaction-go-" + String(scene.round) : ""
    }
}
