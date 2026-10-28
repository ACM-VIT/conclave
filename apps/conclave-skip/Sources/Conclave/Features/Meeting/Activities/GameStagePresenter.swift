import Foundation
import Observation

@MainActor
@Observable
final class GameStagePresenter {
    private(set) var chrome: GameChromeModel = GameChromeModel.empty
    private(set) var scene: GameScene = GameScene.empty
    private(set) var countdown: CountdownModel? = nil
    private(set) var results: GameResultsModel = GameResultsModel.empty
    private(set) var interaction: GameInteractionModel = GameInteractionModel.idle

    private(set) var feedbackState = MeetingShellFeedbackState(session: 0, token: FeedbackToken.baseline)

    private(set) var wordleDraft: String = ""

    private(set) var chessPendingMove: ChessPendingMoveModel = ChessPendingMoveModel.none

    @ObservationIgnored var onCommand: ((GameStageCommand) -> Void)? = nil
    @ObservationIgnored var sleep: (Double) async -> Void = { millis in
        try? await Task.sleep(nanoseconds: UInt64(max(0.0, millis) * 1_000_000.0))
    }

    @ObservationIgnored private(set) var inputs = GameStageInputs.make()

    @ObservationIgnored private(set) var emitLog: [String] = []
    @ObservationIgnored private(set) var parseCount = 0

    @ObservationIgnored private var projection = GameProjection.empty
    @ObservationIgnored private var parsedKey = ""

    @ObservationIgnored private var pushReceivedAtMillis = 0.0
    @ObservationIgnored private var nextRequestNumber = 0
    @ObservationIgnored private var pendingRequestId = ""
    @ObservationIgnored private var pendingType = ""
    @ObservationIgnored private var failure = GameFailure.none
    @ObservationIgnored private var failureText = ""
    @ObservationIgnored private var timeoutTask: Task<Void, Never>? = nil
    @ObservationIgnored private var endPending = false
    @ObservationIgnored private var endFailed = false
    @ObservationIgnored private var rematchPending = false

    @ObservationIgnored private var knownPlayers: [GameNamedPlayer] = []

    @ObservationIgnored private var announced: [String] = []

    @ObservationIgnored private var wordleDraftKey = ""

    @ObservationIgnored private var wordleSubmitted = ""

    @ObservationIgnored private var chessMoveRequestId = ""
    @ObservationIgnored private var chessFenAtSend = ""

    static let moveTimeoutMillis = 10000.0

    init() {}

    func apply(_ next: GameStageInputs) {
        if inputs.callSession != 0 && next.callSession != inputs.callSession {
            reset()
        }
        if next == inputs { return }
        let previous = inputs
        inputs = next
        if !next.isActive || next.gameId != previous.gameId {

            clearPending()
            endPending = false
            endFailed = false
            rematchPending = false
            knownPlayers = []
            announced = []
            wordleSubmitted = ""

            chessMoveRequestId = ""
        }
        if next.phase == "lobby" { announced = [] }
        if rematchPending && (!next.isFinished || next.phase == "lobby") { rematchPending = false }
        let key = next.gameId + "|" + next.phase + "|" + next.publicViewJSON + "|" + next.playerViewJSON
        if key != parsedKey {
            parsedKey = key
            parseCount += 1
            pushReceivedAtMillis = next.receivedAtMillis
            projection = next.isActive
                ? GameProjectionParser.parse(gameId: next.gameId, publicPhase: next.phase, publicViewJSON: next.publicViewJSON,
                                             playerViewJSON: next.playerViewJSON)
                : GameProjection.empty

            if failure != GameFailure.none && pendingRequestId.isEmpty && previous.isActive {
                failure = GameFailure.none
                failureText = ""
            }
        }
        rebuild()
    }

    func moveAcknowledged(requestId: String, success: Bool, serverText: String) {
        if requestId.isEmpty || requestId != pendingRequestId { return }
        cancelTimeout()
        let ackedType = pendingType
        pendingRequestId = ""
        pendingType = ""

        let isChessMove = !chessMoveRequestId.isEmpty && chessMoveRequestId == requestId
        if isChessMove { settleChessMove(rejected: !success) }
        if success {
            failure = GameFailure.none
            failureText = ""

            if (ackedType == WordleIntent.guessType || ackedType == WordleIntent.setWordType) && !wordleSubmitted.isEmpty
                && wordleDraft == wordleSubmitted {
                wordleDraft = ""
            }
        } else {
            failure = GameFailurePolicy.failure(serverText: serverText)
            failureText = failure == GameFailure.server ? serverText : ""
            if ackedType == WordleIntent.guessType {

                advanceFeedback(FeedbackKind.guessInvalid)
            } else if isChessMove || failure == GameFailure.notAccepted || ackedType == "submit"
                        || (projection.kind == GameSceneKind.zip && ackedType == ZipIntent.moveType) {

                advanceFeedback(FeedbackKind.moveRejected)
            }
        }
        if ackedType == WordleIntent.guessType || ackedType == WordleIntent.setWordType { wordleSubmitted = "" }
        publishInteraction()
    }

    func endFailed(serverText: String) {
        endPending = false
        endFailed = true
        rebuild()
    }

    func rematchFailed() {
        if !rematchPending { return }
        rematchPending = false
        rebuild()
    }

    func send(_ intent: GameMoveIntent) -> ActivityTapResult {
        if !pendingRequestId.isEmpty { return ActivityTapResult.ignored }
        if !inputs.isActive || inputs.isRecovering || chrome.seat != SeatState.player { return ActivityTapResult.explained }
        nextRequestNumber += 1
        let requestId = "g" + String(inputs.callSession) + "-" + String(nextRequestNumber)
        let stamped = intent.withRequestId(requestId)
        pendingRequestId = requestId
        pendingType = stamped.type
        failure = GameFailure.none
        failureText = ""
        publishInteraction()
        startTimeout(requestId: requestId)
        record(stamped.type)

        noteChessDispatch(stamped)
        onCommand?(GameStageCommand(kind: GameStageCommandKind.move, type: stamped.type,
                                    payloadJSON: GameMoveAdapter.payloadJSON(stamped), requestId: requestId))
        return ActivityTapResult.dispatched
    }

    func join() {
        if !inputs.isActive || inputs.isRecovering || chrome.seat != SeatState.canJoin { return }
        record("join")
        onCommand?(GameStageCommand(kind: GameStageCommandKind.join, type: "", payloadJSON: "", requestId: ""))
    }

    func rematch() {
        if !results.canRematch || rematchPending { return }
        rematchPending = true
        rebuild()
        record("rematch")
        onCommand?(GameStageCommand(kind: GameStageCommandKind.rematch, type: "", payloadJSON: "", requestId: ""))
    }

    func requestEnd() {
        if !chrome.canEnd || endPending { return }
        endPending = true
        endFailed = false
        rebuild()
        record("end")
        onCommand?(GameStageCommand(kind: GameStageCommandKind.end, type: "", payloadJSON: "", requestId: ""))
    }

    func dismissFailure() {
        if failure == GameFailure.none && !endFailed { return }
        failure = GameFailure.none
        failureText = ""
        let hadEndFailure = endFailed
        endFailed = false
        publishInteraction()
        if hadEndFailure { rebuild() }
    }

    func claimAnnouncement(_ key: String) -> Bool {
        if key.isEmpty || announced.contains(key) { return false }
        announced.append(key)
        if announced.count > 40 { announced.removeFirst() }
        return true
    }

    func typeWordleLetter(_ letter: String) {
        guard let wordle = scene.wordle, canEditWordleDraft(wordle) else { return }
        setDraft(WordleBoardPolicy.normalized(wordleDraft + letter, limit: wordle.wordLength))
    }

    func deleteWordleLetter() {
        guard let wordle = scene.wordle, canEditWordleDraft(wordle) else { return }
        if wordleDraft.isEmpty { return }
        setDraft(String(wordleDraft.dropLast()))
    }

    func setWordleDraft(_ text: String) {
        guard let wordle = scene.wordle, canEditWordleDraft(wordle) else { return }
        setDraft(WordleBoardPolicy.normalized(text, limit: wordle.wordLength))
    }

    func submitWordle() -> ActivityTapResult {
        guard let wordle = scene.wordle else { return ActivityTapResult.explained }
        if !pendingRequestId.isEmpty { return ActivityTapResult.ignored }
        let word = WordleBoardPolicy.normalized(wordleDraft, limit: wordle.wordLength)
        var intent = WordleIntent.guess(word)
        if wordle.canSetWord {
            intent = WordleIntent.setWord(word)
        } else if !wordle.canGuess {
            return ActivityTapResult.explained
        }
        if word.count != wordle.wordLength { return ActivityTapResult.ignored }
        let result = send(intent)
        if result == ActivityTapResult.dispatched { wordleSubmitted = word }
        return result
    }

    private func canEditWordleDraft(_ wordle: WordleScene) -> Bool {
        if !wordle.canGuess && !wordle.canSetWord { return false }

        if !pendingRequestId.isEmpty && (pendingType == WordleIntent.guessType || pendingType == WordleIntent.setWordType) {
            return false
        }
        return true
    }

    private func setDraft(_ text: String) {
        if text != wordleDraft { wordleDraft = text }
    }

    private func syncWordleDraft(_ wordle: WordleScene?) {
        var key = ""
        if let wordle = wordle, !wordle.draftKey.isEmpty { key = inputs.gameId + "|" + wordle.draftKey }
        if key != wordleDraftKey {
            wordleDraftKey = key
            wordleSubmitted = ""
            setDraft("")
            return
        }
        guard let wordle = wordle else { return }
        if !wordleSubmitted.isEmpty && wordle.hasGuessed(wordleSubmitted) {
            if wordleDraft == wordleSubmitted { setDraft("") }
            wordleSubmitted = ""
        }
    }

    func sendChessMove(from: String, to: String, promotion: String) -> ActivityTapResult {
        guard let chess = scene.chess else { return ActivityTapResult.explained }
        if !pendingRequestId.isEmpty { return ActivityTapResult.ignored }
        if !chess.canMove { return ActivityTapResult.explained }
        if !ChessBoardPolicy.canSend(chess, from: from, to: to, promotion: promotion) { return ActivityTapResult.ignored }
        return send(ChessIntent.move(from: from, to: to, promotion: promotion))
    }

    func sendChessAction(_ action: ChessAction) -> ActivityTapResult {
        guard let chess = scene.chess else { return ActivityTapResult.explained }
        if !pendingRequestId.isEmpty { return ActivityTapResult.ignored }
        if !ChessBoardPolicy.isEligible(action, scene: chess) { return ActivityTapResult.explained }
        return send(ChessIntent.action(action))
    }

    private func noteChessDispatch(_ intent: GameMoveIntent) {
        if intent.type != ChessIntent.moveType || intent.from.isEmpty { return }
        guard let chess = scene.chess else { return }
        chessMoveRequestId = intent.requestId
        chessFenAtSend = chess.fen
        let next = ChessPendingMoveModel(from: intent.from, to: intent.to, promotion: intent.promotion,
                                         piece: chess.pieceAt(intent.from), isRejected: false)
        if next != chessPendingMove { chessPendingMove = next }
    }

    private func settleChessMove(rejected: Bool) {
        chessMoveRequestId = ""
        let next = rejected ? ChessPendingMoveModel.rejected : ChessPendingMoveModel.none
        if next != chessPendingMove { chessPendingMove = next }
    }

    private func syncChessPending(_ chess: ChessScene?) {
        guard let chess = chess else {
            chessFenAtSend = ""
            if chessPendingMove != ChessPendingMoveModel.none { chessPendingMove = ChessPendingMoveModel.none }
            return
        }
        if chessPendingMove == ChessPendingMoveModel.none { return }
        let orphaned = chessPendingMove.isPending && chessMoveRequestId.isEmpty
        if chess.fen != chessFenAtSend || chess.phase != ChessPhase.playing || orphaned {
            chessPendingMove = ChessPendingMoveModel.none
        }
    }

    func summary() -> ActivityGameSummary {
        if !inputs.isActive { return ActivityGameSummary.none }
        return ActivityGameSummary(gameId: inputs.gameId, name: inputs.name, isActive: true, isFinished: inputs.isFinished,
                                   round: chrome.roundIndex, roundTotal: chrome.roundTotal, playerCount: inputs.players.count)
    }

    func reset() {
        cancelTimeout()
        inputs = GameStageInputs.make()
        projection = GameProjection.empty
        parsedKey = ""
        pushReceivedAtMillis = 0.0
        emitLog = []
        pendingRequestId = ""
        pendingType = ""
        failure = GameFailure.none
        failureText = ""
        endPending = false
        endFailed = false
        rematchPending = false
        knownPlayers = []
        announced = []
        wordleDraftKey = ""
        wordleSubmitted = ""
        setDraft("")
        chessMoveRequestId = ""
        chessFenAtSend = ""
        if chessPendingMove != ChessPendingMoveModel.none { chessPendingMove = ChessPendingMoveModel.none }
        if chrome.withRevision(0) != GameChromeModel.empty { chrome = GameChromeModel.empty.withRevision(chrome.revision + 1) }
        if scene.withRevision(0) != GameScene.empty { scene = GameScene.empty.withRevision(scene.revision + 1) }
        if countdown != nil { countdown = nil }
        if results.withRevision(0) != GameResultsModel.empty { results = GameResultsModel.empty.withRevision(results.revision + 1) }
        publishInteraction()
    }

    var hasLiveTimeout: Bool { timeoutTask != nil }

    private func record(_ entry: String) {
        emitLog.append(entry)
        if emitLog.count > 20 { emitLog.removeFirst() }
    }

    private func rebuild() {
        let localId = inputs.localId
        var isSeated = false
        for player in inputs.players where player.id == localId && !localId.isEmpty {
            isSeated = true
        }
        var isQueued = false
        for player in inputs.pendingJoiners where player.id == localId && !localId.isEmpty {
            isQueued = true
        }
        let seat = GameStagePresenter.seat(isSeated: isSeated, isQueued: isQueued, canJoinLate: inputs.canJoinLate,
                                           isFinished: inputs.isFinished)
        let common = projection.common
        let known = projection.isKnownGame || !inputs.isActive
        var phase = GameChromePhase.playing
        if !known {
            phase = GameChromePhase.unsupported
        } else if inputs.isFinished {
            phase = GameChromePhase.results
        } else if inputs.phase == "lobby" || inputs.phase.isEmpty {
            phase = GameChromePhase.lobby
        }
        let nextChrome = GameChromeModel(
            revision: chrome.revision, gameId: inputs.gameId, name: inputs.name, phase: phase, roundIndex: common.roundNumber,
            roundTotal: common.roundTotal, seat: seat, isHost: inputs.isHost, playerCount: inputs.players.count,
            pendingCount: inputs.pendingJoiners.count, isReconnecting: inputs.isRecovering,
            canEnd: inputs.isActive && inputs.isHost && !inputs.isRecovering, endPending: endPending, endFailed: endFailed,
            isKnownGame: known)
        if nextChrome != chrome { chrome = nextChrome.withRevision(chrome.revision + 1) }

        let acted = common.actedPlayerIds
        var players: [GamePlayerModel] = []
        for player in inputs.players {
            players.append(GamePlayerModel(id: player.id, name: player.name, isYou: player.id == localId, isPending: false,
                                           hasActed: acted.contains(player.id)))
        }
        var pending: [GamePlayerModel] = []
        for player in inputs.pendingJoiners {
            pending.append(GamePlayerModel(id: player.id, name: player.name, isYou: player.id == localId, isPending: true, hasActed: false))
        }
        let lobby = GameStagePresenter.lobby(isHost: inputs.isHost, isSeated: isSeated, seat: seat, isRecovering: inputs.isRecovering,
                                             minPlayers: inputs.minPlayers, playerCount: inputs.players.count)
        rememberPlayers()

        let context = PromptSceneContext(localId: localId, isPlayer: seat == SeatState.player, isHost: inputs.isHost,
                                         isRecovering: inputs.isRecovering, players: inputs.players, knownPlayers: knownPlayers)
        var trivia: TriviaScene? = nil
        if let projected = projection.trivia { trivia = PromptSceneBuilder.trivia(projected, context: context) }
        var bluff: BluffScene? = nil
        if let projected = projection.bluff { bluff = PromptSceneBuilder.bluff(projected, context: context) }
        var wouldYouRather: ChoiceScene? = nil
        if let projected = projection.wouldYouRather { wouldYouRather = PromptSceneBuilder.wouldYouRather(projected, context: context) }
        var mostLikelyTo: PersonVoteScene? = nil
        if let projected = projection.mostLikelyTo { mostLikelyTo = PromptSceneBuilder.mostLikelyTo(projected, context: context) }
        var reaction: ReactionScene? = nil
        if let projected = projection.reaction { reaction = PromptSceneBuilder.reaction(projected, context: context) }
        var imposter: ImposterScene? = nil
        if let projected = projection.imposter { imposter = PromptSceneBuilder.imposter(projected, context: context) }

        var wordle: WordleScene? = nil
        if let projected = projection.wordle { wordle = WordleSceneBuilder.scene(projected, context: context) }

        var chess: ChessScene? = nil
        if let projected = projection.chess {
            chess = ChessSceneBuilder.scene(projected, context: context, receivedAtMillis: pushReceivedAtMillis,
                                            serverNowMillis: common.serverNowMillis)
        }

        var zip: ZipScene? = nil
        if let projected = projection.zip {
            zip = ZipSceneBuilder.scene(projected, context: context, serverNowMillis: common.serverNowMillis,
                                        receivedAtMillis: pushReceivedAtMillis)
        }
        let outcomes = [PromptOutcomePolicy.trivia(previous: scene.trivia, next: trivia),
                        PromptOutcomePolicy.reaction(previous: scene.reaction, next: reaction),
                        WordleOutcomePolicy.solved(previous: scene.wordle, next: wordle),
                        ZipOutcomePolicy.solved(previous: scene.zip, next: zip)]
        let nextScene = GameScene(revision: scene.revision, kind: sceneKind(phase: phase, isSeated: isSeated), players: players,
                                  pendingJoiners: pending, options: GameStagePresenter.optionSummary(config: inputs.config, options: inputs.options),
                                  lobby: lobby, projection: projection, trivia: trivia, bluff: bluff, wouldYouRather: wouldYouRather,
                                  mostLikelyTo: mostLikelyTo, reaction: reaction, imposter: imposter, wordle: wordle, chess: chess, zip: zip)
        if nextScene != scene { scene = nextScene.withRevision(scene.revision + 1) }
        syncWordleDraft(wordle)
        syncChessPending(chess)
        for outcome in outcomes where outcome != FeedbackKind.none {
            advanceFeedback(outcome)
        }

        var nextCountdown: CountdownModel? = nil
        if inputs.isActive && !inputs.isFinished && common.deadlineMillis > 0 {
            let offset = common.serverNowMillis > 0 && pushReceivedAtMillis > 0 ? pushReceivedAtMillis - common.serverNowMillis : 0.0
            nextCountdown = CountdownModel(deadlineMillis: common.deadlineMillis, serverOffsetMillis: offset, durationMillis: common.durationMillis)
        }
        if nextCountdown != countdown { countdown = nextCountdown }

        let nextResults = GameStagePresenter.results(common: common, localId: localId, isFinished: inputs.isFinished,
                                                     canRematch: inputs.isHost && inputs.isFinished && !inputs.isRecovering,
                                                     rematchPending: rematchPending, revision: results.revision)
        if nextResults != results { results = nextResults.withRevision(results.revision + 1) }
        publishInteraction()
    }

    private func sceneKind(phase: GameChromePhase, isSeated: Bool) -> String {
        switch phase {
        case .unsupported: return GameSceneKind.unsupported
        case .lobby: return GameSceneKind.lobby
        case .results: return projection.kind
        case .playing:

            if isSeated && !projection.hasPlayerView { return GameSceneKind.privateView }
            return projection.kind
        }
    }

    private func rememberPlayers() {
        var seen: [GameNamedPlayer] = []
        for player in inputs.players { seen.append(GameNamedPlayer(id: player.id, name: player.name)) }
        for player in inputs.pendingJoiners { seen.append(GameNamedPlayer(id: player.id, name: player.name)) }
        if let vote = projection.mostLikelyTo { seen.append(contentsOf: vote.players) }
        if let vote = projection.imposter { seen.append(contentsOf: vote.players) }
        for player in seen where !player.id.isEmpty && !player.name.isEmpty {
            var known = false
            for existing in knownPlayers where existing.id == player.id {
                known = true
            }
            if !known { knownPlayers.append(player) }
        }
        while knownPlayers.count > 200 { knownPlayers.removeFirst() }
    }

    private func publishInteraction() {
        let next = GameInteractionModel(revision: interaction.revision, pendingRequestId: pendingRequestId, pendingType: pendingType,
                                        failure: failure, failureServerText: failureText)
        if next != interaction { interaction = next.withRevision(interaction.revision + 1) }
    }

    private func clearPending() {
        cancelTimeout()
        pendingRequestId = ""
        pendingType = ""
    }

    private func advanceFeedback(_ kind: FeedbackKind) {
        feedbackState = MeetingShellFeedbackState(session: inputs.callSession,
                                                  token: FeedbackToken(sequence: feedbackState.token.sequence + 1, kind: kind))
    }

    static func seat(isSeated: Bool, isQueued: Bool, canJoinLate: Bool, isFinished: Bool) -> SeatState {
        if isSeated { return SeatState.player }
        if isQueued { return SeatState.joiningNextRound }
        if canJoinLate && !isFinished { return SeatState.canJoin }
        return SeatState.watching
    }

    static func lobby(isHost: Bool, isSeated: Bool, seat: SeatState, isRecovering: Bool, minPlayers: Int, playerCount: Int) -> GameLobbyModel {
        if isRecovering {
            return GameLobbyModel(canStart: false, reason: GameLobbyReason.reconnecting, minPlayers: minPlayers, playerCount: playerCount,
                                  showsJoin: false)
        }
        if !isHost {
            return GameLobbyModel(canStart: false, reason: GameLobbyReason.hostStarts, minPlayers: minPlayers, playerCount: playerCount,
                                  showsJoin: seat == SeatState.canJoin)
        }
        if !isSeated {

            return GameLobbyModel(canStart: false, reason: GameLobbyReason.joinToStart, minPlayers: minPlayers, playerCount: playerCount,
                                  showsJoin: seat == SeatState.canJoin)
        }
        if playerCount < minPlayers {
            return GameLobbyModel(canStart: false, reason: GameLobbyReason.needsPlayers, minPlayers: minPlayers, playerCount: playerCount,
                                  showsJoin: false)
        }
        return GameLobbyModel(canStart: true, reason: GameLobbyReason.none, minPlayers: minPlayers, playerCount: playerCount, showsJoin: false)
    }

    static func optionSummary(config: [ActivityOptionValue], options: [ActivityOptionInput]) -> [GameOptionSummaryModel] {
        var result: [GameOptionSummaryModel] = []
        for option in options {
            guard let value = ActivitiesCatalogPolicy.draft(option.id, in: config) else { continue }
            var text = ""
            if value.isNumber {
                text = ActivitiesCatalogPolicy.numberLabel(value.number, suffix: option.suffix)
            } else {
                text = value.text
                for choice in option.choices where choice.id == value.text {
                    text = choice.label
                }
            }
            if text.isEmpty { continue }
            result.append(GameOptionSummaryModel(id: option.id, label: option.label, value: text))
        }
        return result
    }

    static func results(common: GameCommonProjection, localId: String, isFinished: Bool, canRematch: Bool, rematchPending: Bool,
                        revision: Int) -> GameResultsModel {
        var rows: [GameScoreboardRow] = []
        var rank = 0
        var previousScore = Int.min
        var index = 0
        let top = common.scoreboard.first?.score ?? 0
        for entry in common.scoreboard {
            index += 1
            if entry.score != previousScore {
                rank = index
                previousScore = entry.score
            }
            rows.append(GameScoreboardRow(id: entry.id, rank: rank, name: entry.name, score: entry.score, isYou: entry.id == localId,
                                          isLeader: !common.scoreboard.isEmpty && entry.score == top && top > 0))
        }
        let isTie = common.scoreboard.count > 1 && common.scoreboard[0].score == common.scoreboard[1].score && top > 0
        var winner = common.winnerName
        if winner.isEmpty && !isTie && top > 0 { winner = common.scoreboard.first?.name ?? "" }
        return GameResultsModel(revision: revision, isFinished: isFinished, winnerName: winner, winnerScore: top, isTie: isTie,
                                scoreboard: rows, canRematch: canRematch, rematchPending: rematchPending)
    }

    private func startTimeout(requestId: String) {
        cancelTimeout()
        let wait = sleep
        timeoutTask = Task { @MainActor [weak self] in
            await wait(GameStagePresenter.moveTimeoutMillis)
            if Task.isCancelled { return }
            guard let self = self else { return }
            self.fireTimeout(requestId: requestId)
        }
    }

    func fireTimeout(requestId: String) {
        if requestId != pendingRequestId { return }
        timeoutTask?.cancel()
        timeoutTask = nil
        pendingRequestId = ""
        pendingType = ""
        failure = GameFailure.server
        failureText = ""

        if chessMoveRequestId == requestId { settleChessMove(rejected: false) }

        publishInteraction()
    }

    private func cancelTimeout() {
        timeoutTask?.cancel()
        timeoutTask = nil
    }
}

enum WordleCellState: String, CaseIterable, Equatable {
    case empty, typed, correct, present, absent
}

enum WordleKeyState: String, CaseIterable, Equatable {
    case unused, correct, present, absent
}

enum WordlePhase: String, CaseIterable, Equatable {
    case lobby, setWord, playing, results
}

enum WordleRole: String, CaseIterable, Equatable {
    case guesser, setter, spectator
}

enum WordleOutcome: String, CaseIterable, Equatable {
    case none, solved, outOfTries, timedOut
}

enum WordleStandingStatus: String, CaseIterable, Equatable {
    case playing, solved, outOfTries, timedOut
}

struct WordleCellModel: Equatable, Identifiable {

    let id: String

    let letter: String
    let state: WordleCellState
}

struct WordleRowModel: Equatable, Identifiable {
    let id: String

    let index: Int
    let cells: [WordleCellModel]

    let word: String

    let isGuess: Bool
}

struct WordleKeyModel: Equatable, Identifiable {

    let id: String
    let letter: String
    let state: WordleKeyState

    let row: Int
}

struct WordleStandingModel: Equatable, Identifiable {
    let id: String
    let name: String
    let status: WordleStandingStatus
    let tries: Int
    let isYou: Bool
}

struct WordleBoardStatusModel: Equatable, Identifiable {
    let id: String
    let name: String
    let status: WordleStandingStatus
    let tries: Int
    let rows: [WordleRowModel]
}

struct WordleScene: Equatable {
    let phase: WordlePhase

    let round: Int
    let roundTotal: Int
    let wordLength: Int
    let maxTries: Int

    let isRandomWord: Bool
    let role: WordleRole
    let setterName: String
    let isSetter: Bool
    let canSetWord: Bool
    let canGuess: Bool
    let myRows: [WordleRowModel]

    let keyStates: [WordleKeyModel]
    let myOutcome: WordleOutcome
    let standings: [WordleStandingModel]
    let liveBoards: [WordleBoardStatusModel]
    let solution: String
    let winnerName: String
    let isFinalRound: Bool
    let finishedCount: Int
    let totalContestants: Int
    let isPlayer: Bool

    let isReconnecting: Bool

    let canAdvanceRound: Bool

    var triesUsed: Int { myRows.count }

    var showsDraftRow: Bool {
        role == WordleRole.guesser && phase == WordlePhase.playing && myOutcome == WordleOutcome.none && myRows.count < maxTries
    }

    var draftKey: String {
        if phase == WordlePhase.setWord && isSetter { return "secret-" + String(round) }
        if phase == WordlePhase.playing && role == WordleRole.guesser { return "guess-" + String(round) }
        return ""
    }

    var outcomeKey: String {
        myOutcome == WordleOutcome.none ? "" : "wordle-outcome-" + String(round) + "-" + myOutcome.rawValue
    }

    var resultKey: String {
        phase == WordlePhase.results && !solution.isEmpty ? "wordle-result-" + String(round) : ""
    }

    func keys(inRow row: Int) -> [WordleKeyModel] {
        var result: [WordleKeyModel] = []
        for key in keyStates where key.row == row {
            result.append(key)
        }
        return result
    }

    func hasGuessed(_ word: String) -> Bool {
        for row in myRows where row.word == word {
            return true
        }
        return false
    }
}

enum WordleSceneBuilder {
    static let defaultWordLength = 5
    static let defaultMaxTries = 6

    static func scene(_ projection: WordleProjection, context: PromptSceneContext) -> WordleScene {
        let phase = parsePhase(projection.phase)
        let length = projection.wordLength > 0 ? projection.wordLength : defaultWordLength
        let tries = projection.maxTries > 0 ? projection.maxTries : defaultMaxTries
        let isPlayer = context.isPlayer
        let localId = context.localId
        var isContestant = false
        var standings: [WordleStandingModel] = []
        for entry in projection.standings {
            let isYou = !localId.isEmpty && entry.id == localId
            if isYou { isContestant = true }
            standings.append(WordleStandingModel(id: entry.id, name: entry.name, status: parseStatus(entry.outcome), tries: entry.triesUsed,
                                                 isYou: isYou))
        }
        let isSetter = isPlayer && projection.isSetter
        var role = WordleRole.spectator
        if isSetter {
            role = WordleRole.setter
        } else if isPlayer && (isContestant || phase == WordlePhase.setWord || phase == WordlePhase.lobby) {
            role = WordleRole.guesser
        }
        var myRows: [WordleRowModel] = []
        var myOutcome = WordleOutcome.none
        if isPlayer {
            var index = 0
            for guess in projection.myGuesses {
                myRows.append(guessRow(index: index, word: guess.word, feedback: guess.feedback, length: length, showsLetters: true))
                index += 1
            }
            myOutcome = parseOutcome(projection.myOutcome)
        }
        var liveBoards: [WordleBoardStatusModel] = []
        if isSetter {
            for board in projection.boards {
                var rows: [WordleRowModel] = []
                var index = 0
                for guess in board.guesses {
                    rows.append(guessRow(index: index, word: guess.word, feedback: guess.feedback, length: length, showsLetters: false))
                    index += 1
                }
                liveBoards.append(WordleBoardStatusModel(id: board.id, name: playerName(id: board.id, standings: standings, context: context),
                                                         status: parseStatus(board.outcome), tries: board.guesses.count, rows: rows))
            }
        }
        let recovering = context.isRecovering
        let isResults = phase == WordlePhase.results
        let canGuess = role == WordleRole.guesser && phase == WordlePhase.playing && projection.canGuess
            && myOutcome == WordleOutcome.none && myRows.count < tries && !recovering
        let canSetWord = isSetter && phase == WordlePhase.setWord && projection.canSetWord && !recovering
        return WordleScene(phase: phase, round: projection.currentRound, roundTotal: projection.totalRounds, wordLength: length,
                           maxTries: tries, isRandomWord: projection.wordSource != "setter", role: role,
                           setterName: projection.setterName, isSetter: isSetter, canSetWord: canSetWord, canGuess: canGuess,
                           myRows: myRows, keyStates: keyStates(myRows), myOutcome: myOutcome, standings: standings,
                           liveBoards: liveBoards, solution: isResults ? projection.resultWord.uppercased() : "",
                           winnerName: isResults ? projection.resultWinnerName : "", isFinalRound: projection.isFinalRound,
                           finishedCount: projection.finishedCount, totalContestants: projection.totalContestants, isPlayer: isPlayer,
                           isReconnecting: recovering,
                           canAdvanceRound: isResults && !projection.isFinalRound && context.isHost && isPlayer && !recovering)
    }

    static func guessRow(index: Int, word: String, feedback: [String], length: Int, showsLetters: Bool) -> WordleRowModel {
        let upper = word.uppercased()
        var letters: [String] = []
        for character in upper {
            letters.append(String(character))
        }
        var cells: [WordleCellModel] = []
        var column = 0
        while column < length {
            let letter = column < letters.count ? letters[column] : ""
            var state = WordleCellState.empty
            if column < feedback.count {
                state = parseMark(feedback[column])
            } else if !letter.isEmpty {
                state = WordleCellState.absent
            }
            cells.append(WordleCellModel(id: "r" + String(index) + "c" + String(column), letter: showsLetters ? letter : "", state: state))
            column += 1
        }
        return WordleRowModel(id: "r" + String(index), index: index, cells: cells, word: showsLetters ? upper : "", isGuess: true)
    }

    static func keyStates(_ rows: [WordleRowModel]) -> [WordleKeyModel] {
        var result: [WordleKeyModel] = []
        var rowIndex = 0
        for line in WordleBoardPolicy.keyboardRows {
            for character in line {
                let letter = String(character)
                result.append(WordleKeyModel(id: letter, letter: letter, state: bestState(letter: letter, rows: rows), row: rowIndex))
            }
            rowIndex += 1
        }
        return result
    }

    static func bestState(letter: String, rows: [WordleRowModel]) -> WordleKeyState {
        var best = WordleKeyState.unused
        for row in rows where row.isGuess {
            for cell in row.cells where cell.letter == letter {
                if cell.state == WordleCellState.correct { return WordleKeyState.correct }
                if cell.state == WordleCellState.present {
                    best = WordleKeyState.present
                } else if cell.state == WordleCellState.absent && best == WordleKeyState.unused {
                    best = WordleKeyState.absent
                }
            }
        }
        return best
    }

    static func playerName(id: String, standings: [WordleStandingModel], context: PromptSceneContext) -> String {
        for entry in standings where entry.id == id {
            return entry.name
        }
        return context.knownName(id)
    }

    static func parsePhase(_ raw: String) -> WordlePhase {
        switch raw {
        case "set-word": return WordlePhase.setWord
        case "playing": return WordlePhase.playing
        case "results": return WordlePhase.results
        default: return WordlePhase.lobby
        }
    }

    static func parseOutcome(_ raw: String) -> WordleOutcome {
        switch raw {
        case "win": return WordleOutcome.solved
        case "lose": return WordleOutcome.outOfTries
        case "timeout": return WordleOutcome.timedOut
        default: return WordleOutcome.none
        }
    }

    static func parseStatus(_ raw: String) -> WordleStandingStatus {
        switch raw {
        case "win": return WordleStandingStatus.solved
        case "lose": return WordleStandingStatus.outOfTries
        case "timeout": return WordleStandingStatus.timedOut
        default: return WordleStandingStatus.playing
        }
    }

    static func parseMark(_ raw: String) -> WordleCellState {
        switch raw {
        case "green": return WordleCellState.correct
        case "yellow": return WordleCellState.present
        default: return WordleCellState.absent
        }
    }
}

enum WordleBoardPolicy {
    static let keyboardRows: [String] = ["QWERTYUIOP", "ASDFGHJKL", "ZXCVBNM"]
    static let alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ"

    static let cellSize = 38.0
    static let gap = 4.0
    static let boardWidth = 206.0

    static let maxKeyWidth = 32.0
    static let wideKeyFactor = 1.5

    static let warningSeconds = 10
    static let announcedSeconds: [Int] = [60, 10]

    static func normalized(_ text: String, limit: Int) -> String {
        var result = ""
        var count = 0
        for character in text.uppercased() {
            if count >= limit { break }
            let letter = String(character)
            if letter.count == 1 && alphabet.contains(letter) {
                result += letter
                count += 1
            }
        }
        return result
    }

    static func canSubmit(_ scene: WordleScene, draft: String) -> Bool {
        (scene.canGuess || scene.canSetWord) && normalized(draft, limit: scene.wordLength).count == scene.wordLength
    }

    static func displayRows(_ scene: WordleScene, draft: String) -> [WordleRowModel] {
        var rows: [WordleRowModel] = []
        for row in scene.myRows {
            rows.append(row)
        }
        var index = rows.count
        if scene.showsDraftRow && index < scene.maxTries {
            rows.append(draftRow(index: index, draft: normalized(draft, limit: scene.wordLength), length: scene.wordLength))
            index += 1
        }
        while index < scene.maxTries {
            rows.append(draftRow(index: index, draft: "", length: scene.wordLength))
            index += 1
        }
        return rows
    }

    static func draftRow(index: Int, draft: String, length: Int) -> WordleRowModel {
        var letters: [String] = []
        for character in draft {
            letters.append(String(character))
        }
        var cells: [WordleCellModel] = []
        var column = 0
        while column < length {
            let letter = column < letters.count ? letters[column] : ""
            cells.append(WordleCellModel(id: "r" + String(index) + "c" + String(column), letter: letter,
                                         state: letter.isEmpty ? WordleCellState.empty : WordleCellState.typed))
            column += 1
        }
        return WordleRowModel(id: "r" + String(index), index: index, cells: cells, word: draft, isGuess: false)
    }

    static func solutionRow(_ scene: WordleScene) -> WordleRowModel {
        var feedback: [String] = []
        var count = 0
        while count < scene.solution.count {
            feedback.append("green")
            count += 1
        }
        return WordleSceneBuilder.guessRow(index: 0, word: scene.solution, feedback: feedback,
                                           length: max(scene.wordLength, scene.solution.count), showsLetters: true)
    }

    static func keyWidth(available: Double) -> Double {
        let width = (available - 9.0 * gap) / 10.0
        return max(1.0, min(maxKeyWidth, width))
    }
}

enum WordleOutcomePolicy {

    static func solved(previous: WordleScene?, next: WordleScene?) -> FeedbackKind {
        guard let before = previous, let after = next else { return FeedbackKind.none }
        if !after.isPlayer || before.round != after.round { return FeedbackKind.none }
        if before.myOutcome != WordleOutcome.solved && after.myOutcome == WordleOutcome.solved { return FeedbackKind.wordSolved }
        return FeedbackKind.none
    }
}

enum WordleIntent {
    static let guessType = "guess"
    static let setWordType = "setWord"
    static let nextRoundType = "nextRound"

    static func guess(_ word: String) -> GameMoveIntent { GameMoveIntent.make(type: guessType, text: word) }
    static func setWord(_ word: String) -> GameMoveIntent { GameMoveIntent.make(type: setWordType, text: word) }
    static func nextRound() -> GameMoveIntent { GameMoveIntent.make(type: nextRoundType) }
}

enum WordleFixtureState: String, CaseIterable, Equatable {
    case guess = "game-wordle-guess"
    case solved = "game-wordle-solved"
    case outOfTries = "game-wordle-out-of-tries"
    case setWord = "game-wordle-set-word"
    case waitingWord = "game-wordle-waiting-word"
    case setterWatching = "game-wordle-setter-watching"
    case roundResults = "game-wordle-round-results"
    case timeout = "game-wordle-timeout"
    case finalResults = "game-wordle-final"
    case spectator = "game-wordle-spectator"
    case reconnecting = "game-wordle-reconnecting"
}

enum WordleFixtures {
    static let serverNow = ActivityFixtureScript.serverNow

    static func state(named raw: String) -> WordleFixtureState? {
        WordleFixtureState(rawValue: raw.trimmingCharacters(in: .whitespacesAndNewlines))
    }

    static func at(_ offsetMillis: Double) -> String { String(Int64(serverNow + offsetMillis)) }

    static let sloth = guess("SLOTH", "gray", "yellow", "yellow", "gray", "gray")
    static let llama = guess("LLAMA", "green", "gray", "gray", "yellow", "gray")
    static let logic = guess("LOGIC", "green", "yellow", "gray", "gray", "gray")
    static let lemur = guess("LEMUR", "green", "green", "green", "gray", "gray")
    static let lemma = guess("LEMMA", "green", "green", "green", "gray", "gray")
    static let leech = guess("LEECH", "green", "green", "gray", "gray", "gray")
    static let lemon = guess("LEMON", "green", "green", "green", "green", "green")
    static let slate = guess("SLATE", "gray", "gray", "green", "gray", "green")
    static let brake = guess("BRAKE", "gray", "green", "green", "gray", "green")
    static let crane = guess("CRANE", "green", "green", "green", "green", "green")

    static func guess(_ word: String, _ a: String, _ b: String, _ c: String, _ d: String, _ e: String) -> String {
        "{\"word\":\"" + word + "\",\"feedback\":[\"" + a + "\",\"" + b + "\",\"" + c + "\",\"" + d + "\",\"" + e + "\"],\"at\":0}"
    }

    static func standing(_ id: String, _ name: String, _ tries: Int, _ outcome: String) -> String {
        "{\"playerId\":\"" + id + "\",\"playerName\":\"" + name + "\",\"triesUsed\":" + String(tries) + ",\"outcome\":"
            + text(outcome) + ",\"solvedAt\":null}"
    }

    static func text(_ value: String) -> String { value.isEmpty ? "null" : GameMoveAdapter.quoted(value) }

    static func flag(_ value: Bool) -> String { value ? "true" : "false" }

    static func publicView(phase: String, source: String, setterId: String, setterName: String, deadline: String,
                           standings: [String], finished: Int, round: Int, totalRounds: Int, scores: String, result: String) -> String {
        "{\"phase\":\"" + phase + "\",\"wordSource\":\"" + source + "\",\"setterId\":" + text(setterId) + ",\"setterName\":"
            + text(setterName) + ",\"serverNow\":" + at(0) + ",\"deadline\":" + deadline + ",\"timeLimitMs\":180000,\"wordLength\":5,"
            + "\"maxTries\":6,\"standings\":[" + standings.joined(separator: ",") + "],\"finishedCount\":" + String(finished)
            + ",\"totalContestants\":" + String(standings.count) + ",\"currentRound\":" + String(round) + ",\"totalRounds\":"
            + String(totalRounds) + ",\"isFinalRound\":" + flag(round >= totalRounds) + ",\"scores\":" + scores + ",\"result\":"
            + result + "}"
    }

    static func playerView(round: Int, isSetter: Bool, canSetWord: Bool, canGuess: Bool, secret: String, guesses: [String],
                           outcome: String, boards: String) -> String {
        "{\"currentRound\":" + String(round) + ",\"isSetter\":" + flag(isSetter) + ",\"canSetWord\":" + flag(canSetWord)
            + ",\"canGuess\":" + flag(canGuess) + ",\"secretWord\":" + text(secret) + ",\"myGuesses\":[" + guesses.joined(separator: ",")
            + "],\"myOutcome\":" + text(outcome) + ",\"mySolvedAt\":null,\"boards\":" + boards + "}"
    }

    static let roundScores = "[{\"playerId\":\"r1\",\"playerName\":\"Avery\",\"score\":4},{\"playerId\":\"you\",\"playerName\":\"You\","
        + "\"score\":3},{\"playerId\":\"r2\",\"playerName\":\"Ben\",\"score\":0},{\"playerId\":\"r3\",\"playerName\":\"Cai\",\"score\":0}]"
    static let finalScores = "[{\"playerId\":\"r1\",\"playerName\":\"Avery\",\"score\":14},{\"playerId\":\"you\",\"playerName\":\"You\","
        + "\"score\":9},{\"playerId\":\"r2\",\"playerName\":\"Ben\",\"score\":3},{\"playerId\":\"r3\",\"playerName\":\"Cai\",\"score\":0}]"
    static let lemonResult = "{\"targetWord\":\"LEMON\",\"winnerId\":\"r1\",\"winnerName\":\"Avery\"}"
    static let craneResult = "{\"targetWord\":\"CRANE\",\"winnerId\":\"r1\",\"winnerName\":\"Avery\"}"

    static func playingView(you: String, finished: Int) -> String {
        publicView(phase: "playing", source: "random", setterId: "", setterName: "", deadline: at(161000),
                   standings: [standing("r1", "Avery", 3, "win"), standing("r2", "Ben", 2, ""), standing("r3", "Cai", 1, ""), you],
                   finished: finished, round: 1, totalRounds: 3, scores: "[]", result: "null")
    }

    static func publicPhase(_ state: WordleFixtureState) -> String {
        switch state {
        case .guess, .solved, .outOfTries, .setterWatching, .spectator, .reconnecting: return "playing"
        case .setWord, .waitingWord: return "set-word"
        case .roundResults, .timeout, .finalResults: return "results"
        }
    }

    static func publicView(_ state: WordleFixtureState) -> String {
        switch state {
        case .guess, .reconnecting:
            return playingView(you: standing("you", "You", 2, ""), finished: 1)
        case .solved:
            return publicView(phase: "playing", source: "random", setterId: "", setterName: "", deadline: at(161000),
                              standings: [standing("r1", "Avery", 3, "win"), standing("you", "You", 3, "win"), standing("r2", "Ben", 2, ""),
                                          standing("r3", "Cai", 1, "")],
                              finished: 2, round: 1, totalRounds: 3, scores: "[]", result: "null")
        case .outOfTries:
            return playingView(you: standing("you", "You", 6, "lose"), finished: 2)
        case .setWord:
            return publicView(phase: "set-word", source: "setter", setterId: "you", setterName: "You", deadline: "null",
                              standings: [standing("r1", "Avery", 0, ""), standing("r2", "Ben", 0, ""), standing("r3", "Cai", 0, "")],
                              finished: 0, round: 1, totalRounds: 3, scores: "[]", result: "null")
        case .waitingWord:
            return publicView(phase: "set-word", source: "setter", setterId: "r1", setterName: "Avery", deadline: "null",
                              standings: [standing("r2", "Ben", 0, ""), standing("r3", "Cai", 0, ""), standing("you", "You", 0, "")],
                              finished: 0, round: 1, totalRounds: 3, scores: "[]", result: "null")
        case .setterWatching:
            return publicView(phase: "playing", source: "setter", setterId: "you", setterName: "You", deadline: at(161000),
                              standings: [standing("r1", "Avery", 3, "win"), standing("r2", "Ben", 2, ""), standing("r3", "Cai", 6, "lose")],
                              finished: 2, round: 1, totalRounds: 3, scores: "[]", result: "null")
        case .roundResults:
            return publicView(phase: "results", source: "random", setterId: "", setterName: "", deadline: "null",
                              standings: [standing("r1", "Avery", 3, "win"), standing("you", "You", 4, "win"), standing("r2", "Ben", 2, "timeout"),
                                          standing("r3", "Cai", 6, "lose")],
                              finished: 4, round: 1, totalRounds: 3, scores: roundScores, result: lemonResult)
        case .timeout:
            return publicView(phase: "results", source: "random", setterId: "", setterName: "", deadline: "null",
                              standings: [standing("r1", "Avery", 3, "win"), standing("r2", "Ben", 2, "timeout"), standing("r3", "Cai", 6, "lose"),
                                          standing("you", "You", 2, "timeout")],
                              finished: 4, round: 1, totalRounds: 3, scores: roundScores, result: lemonResult)
        case .finalResults:
            return publicView(phase: "results", source: "random", setterId: "", setterName: "", deadline: "null",
                              standings: [standing("r1", "Avery", 1, "win"), standing("you", "You", 3, "win"), standing("r2", "Ben", 6, "lose"),
                                          standing("r3", "Cai", 2, "timeout")],
                              finished: 4, round: 3, totalRounds: 3, scores: finalScores, result: craneResult)
        case .spectator:
            return publicView(phase: "playing", source: "random", setterId: "", setterName: "", deadline: at(161000),
                              standings: [standing("r1", "Avery", 3, "win"), standing("r2", "Ben", 2, ""), standing("r3", "Cai", 1, ""),
                                          standing("r4", "Dev", 2, "")],
                              finished: 1, round: 1, totalRounds: 3, scores: "[]", result: "null")
        }
    }

    static func playerView(_ state: WordleFixtureState) -> String {
        switch state {
        case .guess, .reconnecting:
            return playerView(round: 1, isSetter: false, canSetWord: false, canGuess: true, secret: "", guesses: [sloth, llama],
                              outcome: "", boards: "null")
        case .solved:
            return playerView(round: 1, isSetter: false, canSetWord: false, canGuess: false, secret: "", guesses: [sloth, llama, lemon],
                              outcome: "win", boards: "null")
        case .outOfTries:
            return playerView(round: 1, isSetter: false, canSetWord: false, canGuess: false, secret: "",
                              guesses: [sloth, llama, logic, lemur, lemma, leech], outcome: "lose", boards: "null")
        case .setWord:
            return playerView(round: 1, isSetter: true, canSetWord: true, canGuess: false, secret: "", guesses: [], outcome: "",
                              boards: "[]")
        case .waitingWord:
            return playerView(round: 1, isSetter: false, canSetWord: false, canGuess: false, secret: "", guesses: [], outcome: "",
                              boards: "null")
        case .setterWatching:
            let boards = "[{\"playerId\":\"r1\",\"guesses\":[" + [sloth, llama, lemon].joined(separator: ",") + "],\"outcome\":\"win\"},"
                + "{\"playerId\":\"r2\",\"guesses\":[" + [sloth, llama].joined(separator: ",") + "],\"outcome\":null},"
                + "{\"playerId\":\"r3\",\"guesses\":[" + [sloth, llama, logic, lemur, lemma, leech].joined(separator: ",")
                + "],\"outcome\":\"lose\"}]"
            return playerView(round: 1, isSetter: true, canSetWord: false, canGuess: false, secret: "LEMON", guesses: [], outcome: "",
                              boards: boards)
        case .roundResults:
            return playerView(round: 1, isSetter: false, canSetWord: false, canGuess: false, secret: "LEMON",
                              guesses: [sloth, llama, logic, lemon], outcome: "win", boards: "null")
        case .timeout:
            return playerView(round: 1, isSetter: false, canSetWord: false, canGuess: false, secret: "LEMON", guesses: [sloth, llama],
                              outcome: "timeout", boards: "null")
        case .finalResults:
            return playerView(round: 3, isSetter: false, canSetWord: false, canGuess: false, secret: "CRANE", guesses: [slate, brake, crane],
                              outcome: "win", boards: "null")
        case .spectator:
            return ""
        }
    }

    static func draft(_ state: WordleFixtureState) -> String {
        state == WordleFixtureState.guess || state == WordleFixtureState.reconnecting ? "LEMO" : ""
    }

    static func seated(_ state: WordleFixtureState) -> Bool { state != WordleFixtureState.spectator }

    static func pushes(_ state: WordleFixtureState) -> [GameStageInputs] {
        let isSeated = seated(state)
        let players = ActivityFixtureScript.players(4, includingYou: isSeated)
        let isHost = isSeated && state != WordleFixtureState.roundResults
        let receivedAt = Date().timeIntervalSince1970 * 1000.0
        let last = GameStageInputs.make(callSession: 1, isActive: true, gameId: "wordle", name: "Wordle", phase: publicPhase(state),
                                        players: players, isFinished: state == WordleFixtureState.finalResults, minPlayers: 1,
                                        publicViewJSON: publicView(state), playerViewJSON: playerView(state),
                                        localPlayerId: isSeated ? ActivityFixtureScript.localUserId : "", isHost: isHost,
                                        isRecovering: state == WordleFixtureState.reconnecting, receivedAtMillis: receivedAt)
        if state != WordleFixtureState.reconnecting { return [last] }
        let first = GameStageInputs.make(callSession: 1, isActive: true, gameId: "wordle", name: "Wordle", phase: "playing",
                                         players: players, minPlayers: 1, publicViewJSON: publicView(state),
                                         playerViewJSON: playerView(state), localPlayerId: ActivityFixtureScript.localUserId,
                                         isHost: true, receivedAtMillis: receivedAt)
        return [first, last]
    }

    static func playingPush(guesses: [String], outcome: String) -> GameStageInputs {
        let tries = guesses.count
        let view = playingView(you: standing("you", "You", tries, outcome), finished: outcome.isEmpty ? 1 : 2)
        let mine = playerView(round: 1, isSetter: false, canSetWord: false, canGuess: outcome.isEmpty && tries < 6, secret: "",
                              guesses: guesses, outcome: outcome, boards: "null")
        return GameStageInputs.make(callSession: 1, isActive: true, gameId: "wordle", name: "Wordle", phase: "playing",
                                    players: ActivityFixtureScript.players(4, includingYou: true), minPlayers: 1, publicViewJSON: view,
                                    playerViewJSON: mine, localPlayerId: ActivityFixtureScript.localUserId, isHost: true,
                                    receivedAtMillis: Date().timeIntervalSince1970 * 1000.0)
    }

    static func stageInputs(named raw: String, base: StageInputs) -> StageInputs {
        if state(named: raw) == nil { return base }
        let game = ActivityFixtureScript.stageInputs(named: ActivityFixtureState.gameTrivia6.rawValue, base: base)
        return StageFixtureScript.copy(game, isGameActive: true, gameName: "Wordle")
    }

    @discardableResult
    @MainActor
    static func apply(named raw: String, session: ActivitySession, owner: ActivityFixtureOwner) -> WordleFixtureState? {
        guard let fixture = state(named: raw) else { return nil }
        session.activities.onCommand = { [weak owner] command in
            owner?.record(command)
        }
        session.games.onCommand = { [weak owner, weak session] command in
            guard let owner = owner else { return }
            owner.record(command)
            guard let session = session else { return }
            if command.kind == GameStageCommandKind.move && owner.acknowledgesMoves {
                session.games.moveAcknowledged(requestId: command.requestId, success: true, serverText: "")
            } else if command.kind == GameStageCommandKind.end && owner.failsEnd {
                session.games.endFailed(serverText: "")
            }
        }
        session.applyActivities(ActivityFixtureScript.activitiesInputs(ActivityFixtureState.gameTrivia6))
        let typed = draft(fixture)
        var index = 0
        for inputs in pushes(fixture) {
            session.applyGame(inputs)
            if index == 0 && !typed.isEmpty { session.games.setWordleDraft(typed) }
            index += 1
        }
        return fixture
    }
}

enum ChessPhase: String, CaseIterable, Equatable {
    case lobby, playing, results
}

enum ChessMode: String, CaseIterable, Equatable {
    case duel, teams, computer
}

enum ChessSide: String, CaseIterable, Equatable {
    case none, white, black
}

enum ChessStatus: String, CaseIterable, Equatable {
    case waiting, yourMove, toMove, finished
}

enum ChessRole: String, CaseIterable, Equatable {
    case white, black, whiteCaptain, blackCaptain, whiteTeam, blackTeam, watching
}

enum ChessResultReason: String, CaseIterable, Equatable {
    case none, checkmate, timeout, resignation, stalemate, threefold, insufficient, fiftyMove, agreement
}

enum ChessPieceKind: String, CaseIterable, Equatable {
    case king, queen, rook, bishop, knight, pawn
}

enum ChessPromotion: String, CaseIterable, Equatable {
    case queen = "q", rook = "r", bishop = "b", knight = "n"
}

enum ChessAction: String, CaseIterable, Equatable {
    case offerDraw, acceptDraw, declineDraw, requestTakeback, acceptTakeback, declineTakeback, resign
}

enum ChessTakebackReason: String, CaseIterable, Equatable {
    case none, notMoved, pending
}

enum ChessTapAction: String, CaseIterable, Equatable {
    case none, select, deselect, move, promote
}

enum ChessDestinationKind: String, CaseIterable, Equatable {
    case quiet, capture, enPassant, castle
}

struct ChessSquareModel: Equatable, Identifiable {

    let id: String

    let file: Int

    let rank: Int

    let piece: String
    let isLight: Bool
    let isLastMove: Bool

    let isCheck: Bool
}

struct ChessLegalMoveModel: Equatable, Identifiable {

    let id: String
    let from: String
    let to: String
    let needsPromotion: Bool
    let isCapture: Bool
    let isCastle: Bool
    let isEnPassant: Bool
}

struct ChessClockModel: Equatable {
    let hasClock: Bool
    let whiteMillis: Double
    let blackMillis: Double
    let runningSide: ChessSide
    let referenceMillis: Double
    let moveLimitMillis: Double
    let moveDeadlineMillis: Double
    let incrementMillis: Double

    static let none = ChessClockModel(hasClock: false, whiteMillis: 0, blackMillis: 0, runningSide: ChessSide.none, referenceMillis: 0,
                                      moveLimitMillis: 0, moveDeadlineMillis: 0, incrementMillis: 0)

    static let lowTimeMillis = 10000.0

    func remainingMillis(_ side: ChessSide, nowMillis: Double) -> Double {
        var base = 0.0
        if side == ChessSide.white { base = whiteMillis }
        if side == ChessSide.black { base = blackMillis }
        if side != runningSide || referenceMillis <= 0 { return max(0.0, base) }
        return max(0.0, base - max(0.0, nowMillis - referenceMillis))
    }

    var hasMoveTimer: Bool { moveLimitMillis > 0 && moveDeadlineMillis > 0 && runningSide != ChessSide.none }

    func moveRemainingMillis(nowMillis: Double) -> Double {
        if !hasMoveTimer { return 0 }
        return max(0.0, moveDeadlineMillis - nowMillis)
    }

    func isLow(_ side: ChessSide, nowMillis: Double) -> Bool {
        hasClock && remainingMillis(side, nowMillis: nowMillis) < ChessClockModel.lowTimeMillis
    }

    static func wholeSeconds(_ millis: Double) -> Int {
        if millis <= 0 { return 0 }
        return Int((millis / 1000.0).rounded(.up))
    }
}

struct ChessMoveRowModel: Equatable, Identifiable {
    let id: String
    let number: Int
    let white: String
    let black: String
    let whiteAutoName: String
    let blackAutoName: String
}

struct ChessTeamMemberModel: Equatable, Identifiable {
    let id: String
    let name: String
    let isCaptain: Bool
    let isYou: Bool
    let isComputer: Bool
}

struct ChessOfferModel: Equatable {
    let side: ChessSide
    let byName: String
    let isYourSide: Bool
    let canRespond: Bool

    static let none = ChessOfferModel(side: ChessSide.none, byName: "", isYourSide: false, canRespond: false)

    var isActive: Bool { side != ChessSide.none }
}

struct ChessResultModel: Equatable {
    let reason: ChessResultReason
    let winner: ChessSide
    let isDraw: Bool
    let byName: String

    static let none = ChessResultModel(reason: ChessResultReason.none, winner: ChessSide.none, isDraw: false, byName: "")

    var isFinished: Bool { reason != ChessResultReason.none }
}

struct ChessPendingMoveModel: Equatable {
    let from: String
    let to: String
    let promotion: String
    let piece: String
    let isRejected: Bool

    static let none = ChessPendingMoveModel(from: "", to: "", promotion: "", piece: "", isRejected: false)
    static let rejected = ChessPendingMoveModel(from: "", to: "", promotion: "", piece: "", isRejected: true)

    var isPending: Bool { !from.isEmpty }
}

struct ChessTapOutcome: Equatable {
    let action: ChessTapAction
    let selected: String
    let from: String
    let to: String
}

struct ChessScene: Equatable {
    let phase: ChessPhase
    let mode: ChessMode

    let orientation: ChessSide
    let turnSide: ChessSide

    let localSide: ChessSide
    let squares: [ChessSquareModel]
    let legalMoves: [ChessLegalMoveModel]

    let hasProjectedLegalMoves: Bool

    let passantSquare: String
    let status: ChessStatus
    let isCheck: Bool
    let role: ChessRole
    let teamWhite: [ChessTeamMemberModel]
    let teamBlack: [ChessTeamMemberModel]

    let whiteMoverName: String
    let whiteMoverIsYou: Bool
    let blackMoverName: String
    let blackMoverIsYou: Bool

    let isRoomVsComputer: Bool
    let botName: String
    let botSide: ChessSide
    let clocks: ChessClockModel
    let moves: [ChessMoveRowModel]
    let plyCount: Int
    let lastMoveFrom: String
    let lastMoveTo: String
    let drawOffer: ChessOfferModel
    let takebackRequest: ChessOfferModel
    let canMove: Bool
    let canOfferDraw: Bool

    let showsTakeback: Bool
    let canRequestTakeback: Bool
    let takebackReason: ChessTakebackReason
    let canResign: Bool

    let canFlip: Bool
    let isReconnecting: Bool
    let isPlayer: Bool
    let result: ChessResultModel
    let fen: String

    var turnKey: String { status == ChessStatus.yourMove ? "chess-turn-" + fen : "" }
    var checkKey: String { isCheck && phase == ChessPhase.playing ? "chess-check-" + fen : "" }
    var resultKey: String { result.isFinished ? "chess-result-" + result.reason.rawValue + "-" + String(plyCount) : "" }

    var isReadOnly: Bool { !canMove }

    func square(_ id: String) -> ChessSquareModel? {
        let index = ChessBoardPolicy.index(of: id)
        if index < 0 || index >= squares.count { return nil }
        return squares[index]
    }

    func pieceAt(_ id: String) -> String {
        guard let found = square(id) else { return "" }
        return found.piece
    }

    func legalMove(from: String, to: String) -> ChessLegalMoveModel? {
        for move in legalMoves where move.from == from && move.to == to {
            return move
        }
        return nil
    }

    func destinations(from: String) -> [ChessLegalMoveModel] {
        var result: [ChessLegalMoveModel] = []
        if hasProjectedLegalMoves {
            for move in legalMoves where move.from == from {
                result.append(move)
            }
            return result
        }
        let mover = ChessBoardPolicy.side(ofPiece: pieceAt(from))
        if mover == ChessSide.none { return result }
        for target in squares where target.id != from && ChessBoardPolicy.side(ofPiece: target.piece) != mover {
            result.append(ChessBoardPolicy.legalMove(from: from, to: target.id, moving: pieceAt(from), target: target.piece,
                                                     passant: passantSquare))
        }
        return result
    }

    func targets(from: String) -> [String] {
        var result: [String] = []
        for move in destinations(from: from) {
            result.append(move.to)
        }
        return result
    }

    func sendableMove(from: String, to: String) -> ChessLegalMoveModel? {
        for move in destinations(from: from) where move.to == to {
            return move
        }
        return nil
    }

    func movablePieces() -> [ChessSquareModel] {
        var result: [ChessSquareModel] = []
        if localSide == ChessSide.none { return result }
        for candidate in squares where ChessBoardPolicy.side(ofPiece: candidate.piece) == localSide {
            if !destinations(from: candidate.id).isEmpty { result.append(candidate) }
        }
        return result
    }
}

enum ChessSceneBuilder {

    static let botId = "@chess-bot"

    static func scene(_ projection: ChessProjection, context: PromptSceneContext, receivedAtMillis: Double,
                      serverNowMillis: Double) -> ChessScene {
        let phase = parsePhase(projection.phase)
        let mode = parseMode(projection.mode)
        let turnSide = parseSide(projection.turnSide)
        let isPlayer = context.isPlayer
        let recovering = context.isRecovering
        let playing = phase == ChessPhase.playing
        let localSide = isPlayer ? parseSide(projection.side) : ChessSide.none
        let pieces = ChessBoardPolicy.placement(projection.fen)
        let passant = ChessBoardPolicy.field(projection.fen, 3)
        var lastFrom = ""
        var lastTo = ""
        if let last = projection.moves.last {
            lastFrom = last.from
            lastTo = last.to
        }
        var checkSquare = ""
        if projection.inCheck && turnSide != ChessSide.none {
            let king = turnSide == ChessSide.white ? "wK" : "bK"
            var position = 0
            for piece in pieces {
                if piece == king { checkSquare = ChessBoardPolicy.squareId(atIndex: position) }
                position += 1
            }
        }
        var squares: [ChessSquareModel] = []
        var index = 0
        for piece in pieces {
            let id = ChessBoardPolicy.squareId(atIndex: index)
            let file = index % 8
            let rank = 8 - index / 8
            squares.append(ChessSquareModel(id: id, file: file, rank: rank, piece: piece, isLight: (file + rank) % 2 == 0,
                                            isLastMove: id == lastFrom || id == lastTo, isCheck: id == checkSquare))
            index += 1
        }
        var legal: [ChessLegalMoveModel] = []
        if playing {
            for origin in projection.legalMoves {
                let moving = ChessBoardPolicy.piece(at: origin.id, pieces: pieces)
                var seen: [String] = []
                for target in origin.targets {
                    if seen.contains(target) { continue }
                    seen.append(target)
                    legal.append(ChessBoardPolicy.legalMove(from: origin.id, to: target, moving: moving,
                                                            target: ChessBoardPolicy.piece(at: target, pieces: pieces), passant: passant))
                }
            }
        }
        var role = ChessRole.watching
        if isPlayer {
            switch projection.role {
            case "white-captain": role = projection.whiteTeam.count > 1 ? ChessRole.whiteCaptain : ChessRole.white
            case "black-captain": role = projection.blackTeam.count > 1 ? ChessRole.blackCaptain : ChessRole.black
            case "white-team": role = ChessRole.whiteTeam
            case "black-team": role = ChessRole.blackTeam
            default: role = ChessRole.watching
            }
        }
        let teamWhite = team(projection.whiteTeam, projection: projection, context: context)
        let teamBlack = team(projection.blackTeam, projection: projection, context: context)
        var whiteMover = ChessTeamMemberModel(id: "", name: "", isCaptain: true, isYou: false, isComputer: false)
        for member in teamWhite where member.isCaptain {
            whiteMover = member
        }
        var blackMover = ChessTeamMemberModel(id: "", name: "", isCaptain: true, isYou: false, isComputer: false)
        for member in teamBlack where member.isCaptain {
            blackMover = member
        }
        let botSide = parseSide(projection.botSide)
        var humans = 0
        for member in teamWhite where !member.isComputer {
            humans += 1
        }
        for member in teamBlack where !member.isComputer {
            humans += 1
        }

        let hasClock = projection.timeControlMillis > 0 && projection.whiteClockMillis >= 0 && projection.blackClockMillis >= 0
        let offset = serverNowMillis > 0 && receivedAtMillis > 0 ? receivedAtMillis - serverNowMillis : 0.0
        var moveDeadline = 0.0
        if playing && receivedAtMillis > 0 && projection.moveTimeMillis > 0 && projection.turnStartedAtMillis > 0 {
            moveDeadline = projection.turnStartedAtMillis + projection.moveTimeMillis + offset
        }
        let clocks = ChessClockModel(hasClock: hasClock, whiteMillis: max(0.0, projection.whiteClockMillis),
                                     blackMillis: max(0.0, projection.blackClockMillis), runningSide: playing ? turnSide : ChessSide.none,
                                     referenceMillis: receivedAtMillis, moveLimitMillis: max(0.0, projection.moveTimeMillis),
                                     moveDeadlineMillis: moveDeadline, incrementMillis: projection.incrementMillis)

        let active = playing && isPlayer && !recovering
        let drawSide = parseSide(projection.drawOfferSide)
        let drawOffer = ChessOfferModel(side: drawSide, byName: projection.drawOfferName,
                                        isYourSide: drawSide != ChessSide.none && drawSide == localSide,
                                        canRespond: active && drawSide != ChessSide.none && projection.canRespondToDraw)
        let takebackSide = parseSide(projection.takebackSide)
        let takeback = ChessOfferModel(side: takebackSide, byName: projection.takebackName,
                                       isYourSide: takebackSide != ChessSide.none && takebackSide == localSide,
                                       canRespond: active && takebackSide != ChessSide.none && projection.canRespondToTakeback)
        let canMove = active && projection.canMove
        let isCaptain = role == ChessRole.white || role == ChessRole.black || role == ChessRole.whiteCaptain
            || role == ChessRole.blackCaptain
        let showsTakeback = playing && isPlayer && isCaptain && projection.allowTakebacks
        let canRequestTakeback = active && showsTakeback && projection.canRequestTakeback
        var takebackReason = ChessTakebackReason.none
        if showsTakeback && !canRequestTakeback {
            if takeback.isActive {
                takebackReason = ChessTakebackReason.pending
            } else if !sideHasMoved(projection.moves, side: localSide) {
                takebackReason = ChessTakebackReason.notMoved
            }
        }
        var status = ChessStatus.toMove
        if phase == ChessPhase.lobby {
            status = ChessStatus.waiting
        } else if phase == ChessPhase.results {
            status = ChessStatus.finished
        } else if canMove {
            status = ChessStatus.yourMove
        }
        var result = ChessResultModel.none
        if !projection.resultReason.isEmpty {
            let isDraw = projection.resultWinner == "draw"
            result = ChessResultModel(reason: parseReason(projection.resultReason), winner: isDraw ? ChessSide.none : parseSide(projection.resultWinner),
                                      isDraw: isDraw, byName: projection.resultByName)
        }
        return ChessScene(phase: phase, mode: mode, orientation: localSide == ChessSide.none ? ChessSide.white : localSide,
                          turnSide: turnSide, localSide: localSide, squares: squares, legalMoves: legal,
                          hasProjectedLegalMoves: !legal.isEmpty, passantSquare: passant == "-" ? "" : passant, status: status,
                          isCheck: projection.inCheck && playing, role: role, teamWhite: teamWhite, teamBlack: teamBlack,
                          whiteMoverName: whiteMover.name, whiteMoverIsYou: whiteMover.isYou, blackMoverName: blackMover.name,
                          blackMoverIsYou: blackMover.isYou, isRoomVsComputer: mode == ChessMode.computer && humans > 1,
                          botName: projection.botName, botSide: botSide, clocks: clocks, moves: moveRows(projection.moves),
                          plyCount: projection.moves.count, lastMoveFrom: lastFrom, lastMoveTo: lastTo, drawOffer: drawOffer,
                          takebackRequest: takeback, canMove: canMove, canOfferDraw: active && projection.canOfferDraw && !drawOffer.isActive,
                          showsTakeback: showsTakeback, canRequestTakeback: canRequestTakeback, takebackReason: takebackReason,
                          canResign: active && projection.canResign, canFlip: role == ChessRole.watching, isReconnecting: recovering,
                          isPlayer: isPlayer, result: result, fen: projection.fen)
    }

    static func team(_ members: [ChessTeamMemberProjection], projection: ChessProjection, context: PromptSceneContext) -> [ChessTeamMemberModel] {
        var result: [ChessTeamMemberModel] = []
        for member in members {
            let isComputer = member.id == botId
            var name = member.name
            if isComputer && !projection.botName.isEmpty { name = projection.botName }
            if name.isEmpty { name = context.knownName(member.id) }
            result.append(ChessTeamMemberModel(id: member.id, name: name, isCaptain: member.isCaptain,
                                               isYou: !context.localId.isEmpty && member.id == context.localId, isComputer: isComputer))
        }
        return result
    }

    static func moveRows(_ moves: [ChessMoveProjection]) -> [ChessMoveRowModel] {
        var rows: [ChessMoveRowModel] = []
        var number = 0
        var white = ""
        var whiteAuto = ""
        var isOpen = false
        for move in moves {
            let autoName = move.isAuto ? move.byName : ""
            if move.color == "b" {
                if !isOpen {
                    number += 1
                    white = ""
                    whiteAuto = ""
                }
                rows.append(ChessMoveRowModel(id: "m" + String(number), number: number, white: white, black: move.san,
                                              whiteAutoName: whiteAuto, blackAutoName: autoName))
                isOpen = false
            } else {
                if isOpen {
                    rows.append(ChessMoveRowModel(id: "m" + String(number), number: number, white: white, black: "",
                                                  whiteAutoName: whiteAuto, blackAutoName: ""))
                }
                number += 1
                white = move.san
                whiteAuto = autoName
                isOpen = true
            }
        }
        if isOpen {
            rows.append(ChessMoveRowModel(id: "m" + String(number), number: number, white: white, black: "", whiteAutoName: whiteAuto,
                                          blackAutoName: ""))
        }
        return rows
    }

    static func sideHasMoved(_ moves: [ChessMoveProjection], side: ChessSide) -> Bool {
        if side == ChessSide.none { return false }
        let color = side == ChessSide.white ? "w" : "b"
        for move in moves where move.color == color {
            return true
        }
        return false
    }

    static func parsePhase(_ raw: String) -> ChessPhase {
        switch raw {
        case "playing": return ChessPhase.playing
        case "results": return ChessPhase.results
        default: return ChessPhase.lobby
        }
    }

    static func parseMode(_ raw: String) -> ChessMode {
        switch raw {
        case "teams": return ChessMode.teams
        case "computer": return ChessMode.computer
        default: return ChessMode.duel
        }
    }

    static func parseSide(_ raw: String) -> ChessSide {
        switch raw {
        case "white": return ChessSide.white
        case "black": return ChessSide.black
        default: return ChessSide.none
        }
    }

    static func parseReason(_ raw: String) -> ChessResultReason {
        switch raw {
        case "checkmate": return ChessResultReason.checkmate
        case "timeout": return ChessResultReason.timeout
        case "resignation": return ChessResultReason.resignation
        case "stalemate": return ChessResultReason.stalemate
        case "threefold": return ChessResultReason.threefold
        case "insufficient": return ChessResultReason.insufficient
        case "fifty-move": return ChessResultReason.fiftyMove
        case "agreement": return ChessResultReason.agreement
        default: return ChessResultReason.none
        }
    }
}

enum ChessBoardPolicy {
    static let files = "abcdefgh"

    static let maxSide = 480.0
    static let compactMaxSide = 300.0
    static let squareCount = 64

    static func fileIndex(_ letter: String) -> Int {
        var position = 0
        for character in files {
            if String(character) == letter { return position }
            position += 1
        }
        return -1
    }

    static func squareId(file: Int, rank: Int) -> String {
        if file < 0 || file > 7 || rank < 1 || rank > 8 { return "" }
        var position = 0
        for character in files {
            if position == file { return String(character) + String(rank) }
            position += 1
        }
        return ""
    }

    static func squareId(atIndex index: Int) -> String {
        if index < 0 || index >= squareCount { return "" }
        return squareId(file: index % 8, rank: 8 - index / 8)
    }

    static func index(of id: String) -> Int {
        var file = -1
        var rank = -1
        var position = 0
        for character in id {
            let text = String(character)
            if position == 0 {
                file = fileIndex(text)
            } else if position == 1 {
                rank = Int(text) ?? -1
            }
            position += 1
        }
        if position != 2 || file < 0 || rank < 1 || rank > 8 { return -1 }
        return (8 - rank) * 8 + file
    }

    static func placement(_ fen: String) -> [String] {
        var pieces: [String] = []
        for character in fen {
            if character == " " { break }
            let text = String(character)
            if text == "/" { continue }
            if let count = Int(text) {
                var added = 0
                while added < count {
                    pieces.append("")
                    added += 1
                }
            } else {
                let upper = text.uppercased()
                pieces.append((text == upper ? "w" : "b") + upper)
            }
        }
        if pieces.count != squareCount { return Array(repeating: "", count: squareCount) }
        return pieces
    }

    static func field(_ fen: String, _ position: Int) -> String {
        var current = 0
        var text = ""
        for character in fen {
            if character == " " {
                if current == position { return text }
                current += 1
                text = ""
            } else if current == position {
                text += String(character)
            }
        }
        return current == position ? text : ""
    }

    static func piece(at id: String, pieces: [String]) -> String {
        let position = index(of: id)
        if position < 0 || position >= pieces.count { return "" }
        return pieces[position]
    }

    static func side(ofPiece code: String) -> ChessSide {
        if code.count != 2 { return ChessSide.none }
        if code.hasPrefix("w") { return ChessSide.white }
        if code.hasPrefix("b") { return ChessSide.black }
        return ChessSide.none
    }

    static func kind(ofPiece code: String) -> ChessPieceKind? {
        if code.count != 2 { return nil }
        if code.hasSuffix("K") { return ChessPieceKind.king }
        if code.hasSuffix("Q") { return ChessPieceKind.queen }
        if code.hasSuffix("R") { return ChessPieceKind.rook }
        if code.hasSuffix("B") { return ChessPieceKind.bishop }
        if code.hasSuffix("N") { return ChessPieceKind.knight }
        if code.hasSuffix("P") { return ChessPieceKind.pawn }
        return nil
    }

    static func legalMove(from: String, to: String, moving: String, target: String, passant: String) -> ChessLegalMoveModel {
        let fromIndex = index(of: from)
        let toIndex = index(of: to)
        if fromIndex < 0 || toIndex < 0 {
            return ChessLegalMoveModel(id: from + to, from: from, to: to, needsPromotion: false, isCapture: false, isCastle: false,
                                       isEnPassant: false)
        }
        let fromFile = fromIndex % 8
        let toFile = toIndex % 8
        let toRank = 8 - toIndex / 8
        let mover = side(ofPiece: moving)
        let moverKind = kind(ofPiece: moving)
        let isPawn = moverKind == ChessPieceKind.pawn
        let needsPromotion = isPawn && ((mover == ChessSide.white && toRank == 8) || (mover == ChessSide.black && toRank == 1))
        let isEnPassant = isPawn && target.isEmpty && fromFile != toFile && !passant.isEmpty && to == passant
        let targetSide = side(ofPiece: target)
        let isCapture = (targetSide != ChessSide.none && targetSide != mover) || isEnPassant
        let distance = toFile > fromFile ? toFile - fromFile : fromFile - toFile
        let isCastle = moverKind == ChessPieceKind.king && distance == 2
        return ChessLegalMoveModel(id: from + to, from: from, to: to, needsPromotion: needsPromotion, isCapture: isCapture,
                                   isCastle: isCastle, isEnPassant: isEnPassant)
    }

    static func displayOrder(_ orientation: ChessSide) -> [String] {
        var order: [String] = []
        var position = 0
        while position < squareCount {
            order.append(squareId(atIndex: orientation == ChessSide.black ? squareCount - 1 - position : position))
            position += 1
        }
        return order
    }

    static func displayIndex(of id: String, orientation: ChessSide) -> Int {
        let position = index(of: id)
        if position < 0 { return -1 }
        return orientation == ChessSide.black ? squareCount - 1 - position : position
    }

    static func displayedSquares(_ scene: ChessScene, orientation: ChessSide) -> [ChessSquareModel] {
        if orientation != ChessSide.black { return scene.squares }
        var result: [ChessSquareModel] = []
        var position = scene.squares.count - 1
        while position >= 0 {
            result.append(scene.squares[position])
            position -= 1
        }
        return result
    }

    static func opposite(_ side: ChessSide) -> ChessSide {
        if side == ChessSide.white { return ChessSide.black }
        if side == ChessSide.black { return ChessSide.white }
        return ChessSide.none
    }

    static func orientation(_ scene: ChessScene, flipped: Bool) -> ChessSide {
        if flipped && scene.canFlip { return opposite(scene.orientation) }
        return scene.orientation
    }

    static func destinationKind(_ move: ChessLegalMoveModel) -> ChessDestinationKind {
        if move.isCastle { return ChessDestinationKind.castle }
        if move.isEnPassant { return ChessDestinationKind.enPassant }
        if move.isCapture { return ChessDestinationKind.capture }
        return ChessDestinationKind.quiet
    }

    static func square(atX x: Double, y: Double, side: Double, orientation: ChessSide) -> String {
        if side <= 0 || x < 0 || y < 0 || x >= side || y >= side { return "" }
        let cell = side / 8.0
        let column = min(7, Int(x / cell))
        let row = min(7, Int(y / cell))
        let position = row * 8 + column
        return squareId(atIndex: orientation == ChessSide.black ? squareCount - 1 - position : position)
    }

    static func tap(_ scene: ChessScene, selected: String, square: String) -> ChessTapOutcome {
        if !scene.canMove || square.isEmpty {
            return ChessTapOutcome(action: ChessTapAction.none, selected: "", from: "", to: "")
        }
        let isOwn = scene.localSide != ChessSide.none && side(ofPiece: scene.pieceAt(square)) == scene.localSide
        let canStart = isOwn && !scene.destinations(from: square).isEmpty
        if selected.isEmpty {
            if canStart { return ChessTapOutcome(action: ChessTapAction.select, selected: square, from: "", to: "") }
            return ChessTapOutcome(action: ChessTapAction.none, selected: "", from: "", to: "")
        }
        if selected == square { return ChessTapOutcome(action: ChessTapAction.deselect, selected: "", from: "", to: "") }
        if let move = scene.sendableMove(from: selected, to: square) {
            let action = move.needsPromotion ? ChessTapAction.promote : ChessTapAction.move
            return ChessTapOutcome(action: action, selected: "", from: selected, to: square)
        }
        if canStart { return ChessTapOutcome(action: ChessTapAction.select, selected: square, from: "", to: "") }
        return ChessTapOutcome(action: ChessTapAction.deselect, selected: "", from: "", to: "")
    }

    static func canSend(_ scene: ChessScene, from: String, to: String, promotion: String) -> Bool {
        if !scene.canMove { return false }
        guard let move = scene.sendableMove(from: from, to: to) else { return false }
        if move.needsPromotion { return ChessPromotion(rawValue: promotion) != nil }
        return promotion.isEmpty
    }

    static func isEligible(_ action: ChessAction, scene: ChessScene) -> Bool {
        switch action {
        case .offerDraw: return scene.canOfferDraw
        case .acceptDraw, .declineDraw: return scene.drawOffer.canRespond
        case .requestTakeback: return scene.canRequestTakeback
        case .acceptTakeback, .declineTakeback: return scene.takebackRequest.canRespond
        case .resign: return scene.canResign
        }
    }

    static func shownPiece(_ scene: ChessScene, pending: ChessPendingMoveModel, square: String) -> String {
        if pending.isPending {
            if square == pending.from { return "" }
            if square == pending.to { return promotedPiece(pending.piece, promotion: pending.promotion) }
        }
        return scene.pieceAt(square)
    }

    static func promotedPiece(_ code: String, promotion: String) -> String {
        if promotion.isEmpty || code.count != 2 { return code }
        return (code.hasPrefix("w") ? "w" : "b") + promotion.uppercased()
    }
}

enum ChessIntent {
    static let moveType = "move"

    static func move(from: String, to: String, promotion: String) -> GameMoveIntent {
        GameMoveIntent.make(type: moveType, from: from, to: to, promotion: promotion)
    }

    static func action(_ action: ChessAction) -> GameMoveIntent {
        GameMoveIntent.make(type: action.rawValue)
    }
}

enum ChessFixtureState: String, CaseIterable, Equatable {
    case yourMove = "game-chess-your-move"
    case waiting = "game-chess-waiting"
    case check = "game-chess-check"
    case promotion = "game-chess-promotion"
    case special = "game-chess-castle-en-passant"
    case drawOffered = "game-chess-draw-offered"
    case takebackRequested = "game-chess-takeback"
    case teamsMember = "game-chess-teams-member"
    case computer = "game-chess-computer"
    case spectator = "game-chess-spectator"
    case lowTime = "game-chess-low-time"
    case checkmate = "game-chess-checkmate"
    case drawAgreed = "game-chess-draw-agreed"
    case reconnecting = "game-chess-reconnecting"
}

struct ChessFixtureSeat: Equatable {
    let id: String
    let name: String
}

enum ChessFixtures {
    static let serverNow = ActivityFixtureScript.serverNow

    static let you = ChessFixtureSeat(id: "you", name: "You")
    static let avery = ChessFixtureSeat(id: "r1", name: "Avery")
    static let ben = ChessFixtureSeat(id: "r2", name: "Ben")
    static let cai = ChessFixtureSeat(id: "r3", name: "Cai")
    static let computer = ChessFixtureSeat(id: "@chess-bot", name: "Computer")

    static let startFen = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1"
    static let openingFen = "r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 2 3"
    static let checkFen = "rnbqkbnr/ppp2ppp/3p4/1B2p3/4P3/5N2/PPPP1PPP/RNBQK2R b KQkq - 1 3"
    static let promotionFen = "rnbq1bnr/pP2kppp/8/4p3/8/8/PPPP1PPP/RNBQKBNR w KQ - 1 5"
    static let takebackFen = "r1bqkbnr/pppp1ppp/2n5/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R b KQkq - 3 3"
    static let kingsPawnFen = "rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2"
    static let knightFen = "rnbqkbnr/pppp1ppp/8/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R b KQkq - 1 2"
    static let specialFen = "rnbqkbnr/1pp1ppp1/7p/p2pP3/2B5/5N2/PPPP1PPP/RNBQK2R w KQkq d6 0 5"
    static let foolsMateFen = "rnb1kbnr/pppp1ppp/8/4p3/6Pq/5P2/PPPPP2P/RNBQKBNR w KQkq - 1 3"

    static let startLegal = "{\"a2\":[\"a3\",\"a4\"],\"b2\":[\"b3\",\"b4\"],\"c2\":[\"c3\",\"c4\"],\"d2\":[\"d3\",\"d4\"],"
        + "\"e2\":[\"e3\",\"e4\"],\"f2\":[\"f3\",\"f4\"],\"g2\":[\"g3\",\"g4\"],\"h2\":[\"h3\",\"h4\"],\"b1\":[\"a3\",\"c3\"],"
        + "\"g1\":[\"f3\",\"h3\"]}"
    static let openingLegal = "{\"f3\":[\"d4\",\"e5\",\"g5\",\"h4\",\"g1\"],\"a2\":[\"a3\",\"a4\"],\"b2\":[\"b3\",\"b4\"],"
        + "\"c2\":[\"c3\",\"c4\"],\"d2\":[\"d3\",\"d4\"],\"g2\":[\"g3\",\"g4\"],\"h2\":[\"h3\",\"h4\"],\"b1\":[\"a3\",\"c3\"],"
        + "\"d1\":[\"e2\"],\"e1\":[\"e2\"],\"f1\":[\"e2\",\"d3\",\"c4\",\"b5\",\"a6\"],\"h1\":[\"g1\"]}"
    static let checkLegal = "{\"b8\":[\"d7\",\"c6\"],\"c8\":[\"d7\"],\"d8\":[\"d7\"],\"e8\":[\"e7\"],\"c7\":[\"c6\"]}"
    static let promotionLegal = "{\"b7\":[\"a8\",\"a8\",\"a8\",\"a8\",\"c8\",\"c8\",\"c8\",\"c8\"],\"a2\":[\"a3\",\"a4\"],"
        + "\"b2\":[\"b3\",\"b4\"],\"c2\":[\"c3\",\"c4\"],\"d2\":[\"d3\",\"d4\"],\"f2\":[\"f3\",\"f4\"],\"g2\":[\"g3\",\"g4\"],"
        + "\"h2\":[\"h3\",\"h4\"],\"b1\":[\"a3\",\"c3\"],\"d1\":[\"e2\",\"f3\",\"g4\",\"h5\"],\"e1\":[\"e2\"],"
        + "\"f1\":[\"e2\",\"d3\",\"c4\",\"b5\",\"a6\"],\"g1\":[\"e2\",\"f3\",\"h3\"]}"
    static let takebackLegal = "{\"a8\":[\"b8\"],\"d8\":[\"e7\",\"f6\",\"g5\",\"h4\"],\"e8\":[\"e7\"],"
        + "\"f8\":[\"e7\",\"d6\",\"c5\",\"b4\",\"a3\"],\"g8\":[\"h6\",\"f6\",\"e7\"],\"a7\":[\"a6\",\"a5\"],\"b7\":[\"b6\",\"b5\"],"
        + "\"d7\":[\"d6\",\"d5\"],\"f7\":[\"f6\",\"f5\"],\"g7\":[\"g6\",\"g5\"],\"h7\":[\"h6\",\"h5\"],"
        + "\"c6\":[\"b8\",\"e7\",\"d4\",\"b4\",\"a5\"]}"
    static let kingsPawnLegal = "{\"a2\":[\"a3\",\"a4\"],\"b2\":[\"b3\",\"b4\"],\"c2\":[\"c3\",\"c4\"],\"d2\":[\"d3\",\"d4\"],"
        + "\"f2\":[\"f3\",\"f4\"],\"g2\":[\"g3\",\"g4\"],\"h2\":[\"h3\",\"h4\"],\"b1\":[\"a3\",\"c3\"],"
        + "\"d1\":[\"e2\",\"f3\",\"g4\",\"h5\"],\"e1\":[\"e2\"],\"f1\":[\"e2\",\"d3\",\"c4\",\"b5\",\"a6\"],\"g1\":[\"e2\",\"f3\",\"h3\"]}"
    static let knightLegal = "{\"b8\":[\"c6\",\"a6\"],\"d8\":[\"e7\",\"f6\",\"g5\",\"h4\"],\"e8\":[\"e7\"],"
        + "\"f8\":[\"e7\",\"d6\",\"c5\",\"b4\",\"a3\"],\"g8\":[\"h6\",\"f6\",\"e7\"],\"a7\":[\"a6\",\"a5\"],\"b7\":[\"b6\",\"b5\"],"
        + "\"c7\":[\"c6\",\"c5\"],\"d7\":[\"d6\",\"d5\"],\"f7\":[\"f6\",\"f5\"],\"g7\":[\"g6\",\"g5\"],\"h7\":[\"h6\",\"h5\"]}"
    static let specialLegal = "{\"e5\":[\"e6\",\"d6\"],\"c4\":[\"b5\",\"a6\",\"d5\",\"d3\",\"e2\",\"f1\",\"b3\"],"
        + "\"f3\":[\"d4\",\"g5\",\"h4\",\"g1\"],\"a2\":[\"a3\",\"a4\"],\"b2\":[\"b3\",\"b4\"],\"c2\":[\"c3\"],\"d2\":[\"d3\",\"d4\"],"
        + "\"g2\":[\"g3\",\"g4\"],\"h2\":[\"h3\",\"h4\"],\"b1\":[\"a3\",\"c3\"],\"d1\":[\"e2\"],\"e1\":[\"e2\",\"f1\",\"g1\"],"
        + "\"h1\":[\"g1\",\"f1\"]}"

    static let openingSan = ["e4", "e5", "Nf3", "Nc6"]
    static let openingFrom = ["e2", "e7", "g1", "b8"]
    static let openingTo = ["e4", "e5", "f3", "c6"]
    static let checkSan = ["e4", "e5", "Nf3", "d6", "Bb5+"]
    static let checkFrom = ["e2", "e7", "g1", "d7", "f1"]
    static let checkTo = ["e4", "e5", "f3", "d6", "b5"]
    static let promotionSan = ["e4", "d5", "exd5", "c6", "dxc6", "e5", "cxb7", "Ke7"]
    static let promotionFrom = ["e2", "d7", "e4", "c7", "d5", "e7", "c6", "e8"]
    static let promotionTo = ["e4", "d5", "d5", "c6", "c6", "e5", "b7", "e7"]
    static let takebackSan = ["e4", "e5", "Nf3", "Nc6", "Bc4"]
    static let takebackFrom = ["e2", "e7", "g1", "b8", "f1"]
    static let takebackTo = ["e4", "e5", "f3", "c6", "c4"]
    static let specialSan = ["e4", "a6", "Nf3", "a5", "Bc4", "h6", "e5", "d5"]
    static let specialFrom = ["e2", "a7", "g1", "a6", "f1", "h7", "e4", "d7"]
    static let specialTo = ["e4", "a6", "f3", "a5", "c4", "h6", "e5", "d5"]
    static let foolsMateSan = ["f3", "e5", "g4", "Qh4#"]
    static let foolsMateFrom = ["f2", "e7", "g2", "d8"]
    static let foolsMateTo = ["f3", "e5", "g4", "h4"]

    static func state(named raw: String) -> ChessFixtureState? {
        ChessFixtureState(rawValue: raw.trimmingCharacters(in: .whitespacesAndNewlines))
    }

    static func at(_ offsetMillis: Double) -> String { String(Int64(serverNow + offsetMillis)) }

    static func text(_ value: String) -> String { value.isEmpty ? "null" : GameMoveAdapter.quoted(value) }

    static func flag(_ value: Bool) -> String { value ? "true" : "false" }

    static func member(_ seat: ChessFixtureSeat, captain: Bool) -> String {
        "{\"id\":" + text(seat.id) + ",\"name\":" + text(seat.name) + ",\"captain\":" + flag(captain) + "}"
    }

    static func records(san: [String], from: [String], to: [String], white: ChessFixtureSeat, black: ChessFixtureSeat,
                        autoPly: Int) -> [String] {
        var result: [String] = []
        var ply = 0
        while ply < san.count && ply < from.count && ply < to.count {
            let isWhite = ply % 2 == 0
            let seat = isWhite ? white : black
            var item = "{\"san\":" + text(san[ply]) + ",\"from\":" + text(from[ply]) + ",\"to\":" + text(to[ply])
            item += ",\"color\":\"" + (isWhite ? "w" : "b") + "\",\"promotion\":null,\"byPlayerId\":" + text(seat.id)
            item += ",\"byName\":" + text(seat.name) + ",\"auto\":" + flag(ply == autoPly)
            item += ",\"at\":" + at(Double(ply - san.count) * 5000.0) + "}"
            result.append(item)
            ply += 1
        }
        return result
    }

    static func offer(_ side: String, _ seat: ChessFixtureSeat) -> String {
        "{\"side\":" + text(side) + ",\"byPlayerId\":" + text(seat.id) + ",\"byName\":" + text(seat.name) + "}"
    }

    static func clocks(_ white: Int, _ black: Int) -> String {
        "{\"white\":" + String(white) + ",\"black\":" + String(black) + "}"
    }

    static let noClocks = "{\"white\":null,\"black\":null}"
    static let mediumBot = "{\"side\":\"black\",\"level\":\"medium\",\"name\":\"Computer (medium)\"}"

    static func publicView(phase: String, mode: String, fen: String, turnSide: String, inCheck: Bool, legal: String, moves: [String],
                           white: [String], black: [String], clocks: String, timeControl: String, increment: Int, moveTime: String,
                           takebacks: Bool, bot: String, turnStartedAt: String, drawOffer: String, takeback: String,
                           result: String) -> String {
        var json = "{\"phase\":" + text(phase) + ",\"mode\":" + text(mode) + ",\"serverNow\":" + at(0)
        json += ",\"timeControlMs\":" + timeControl + ",\"incrementMs\":" + String(increment) + ",\"moveTimeMs\":" + moveTime
        json += ",\"allowTakebacks\":" + flag(takebacks) + ",\"bot\":" + bot + ",\"clocks\":" + clocks
        json += ",\"fen\":" + text(fen) + ",\"turn\":\"" + (turnSide == "white" ? "w" : "b") + "\",\"turnSide\":" + text(turnSide)
        json += ",\"turnStartedAt\":" + turnStartedAt + ",\"inCheck\":" + flag(inCheck) + ",\"legalMoves\":" + legal
        json += ",\"teams\":{\"white\":[" + white.joined(separator: ",") + "],\"black\":[" + black.joined(separator: ",") + "]}"
        json += ",\"moves\":[" + moves.joined(separator: ",") + "],\"drawOffer\":" + drawOffer + ",\"takebackRequest\":" + takeback
        json += ",\"result\":" + result + "}"
        return json
    }

    static func playerView(side: String, role: String, canMove: Bool, canResign: Bool, canOfferDraw: Bool, canRespondToDraw: Bool,
                           canRequestTakeback: Bool, canRespondToTakeback: Bool) -> String {
        var json = "{\"side\":" + text(side) + ",\"role\":" + text(role) + ",\"canMove\":" + flag(canMove)
        json += ",\"canResign\":" + flag(canResign) + ",\"canOfferDraw\":" + flag(canOfferDraw)
        json += ",\"canRespondToDraw\":" + flag(canRespondToDraw) + ",\"canRequestTakeback\":" + flag(canRequestTakeback)
        json += ",\"canRespondToTakeback\":" + flag(canRespondToTakeback) + "}"
        return json
    }

    static func duelView(fen: String, turnSide: String, inCheck: Bool, legal: String, moves: [String], white: ChessFixtureSeat,
                         black: ChessFixtureSeat, clocks: String, drawOffer: String, takeback: String) -> String {
        publicView(phase: "playing", mode: "duel", fen: fen, turnSide: turnSide, inCheck: inCheck, legal: legal, moves: moves,
                   white: [member(white, captain: true)], black: [member(black, captain: true)], clocks: clocks, timeControl: "300000",
                   increment: 3000, moveTime: "null", takebacks: true, bot: "null", turnStartedAt: at(-2000), drawOffer: drawOffer,
                   takeback: takeback, result: "null")
    }

    static func publicView(_ state: ChessFixtureState) -> String {
        switch state {
        case .yourMove, .reconnecting:
            return duelView(fen: openingFen, turnSide: "white", inCheck: false, legal: openingLegal,
                            moves: records(san: openingSan, from: openingFrom, to: openingTo, white: you, black: avery, autoPly: -1),
                            white: you, black: avery, clocks: clocks(238000, 252000), drawOffer: "null", takeback: "null")
        case .waiting:
            return duelView(fen: openingFen, turnSide: "white", inCheck: false, legal: openingLegal,
                            moves: records(san: openingSan, from: openingFrom, to: openingTo, white: avery, black: you, autoPly: -1),
                            white: avery, black: you, clocks: clocks(238000, 252000), drawOffer: "null", takeback: "null")
        case .check:
            return duelView(fen: checkFen, turnSide: "black", inCheck: true, legal: checkLegal,
                            moves: records(san: checkSan, from: checkFrom, to: checkTo, white: avery, black: you, autoPly: -1),
                            white: avery, black: you, clocks: clocks(240000, 251000), drawOffer: "null", takeback: "null")
        case .promotion:
            return duelView(fen: promotionFen, turnSide: "white", inCheck: false, legal: promotionLegal,
                            moves: records(san: promotionSan, from: promotionFrom, to: promotionTo, white: you, black: avery, autoPly: -1),
                            white: you, black: avery, clocks: clocks(230000, 244000), drawOffer: "null", takeback: "null")
        case .special:
            return duelView(fen: specialFen, turnSide: "white", inCheck: false, legal: specialLegal,
                            moves: records(san: specialSan, from: specialFrom, to: specialTo, white: you, black: avery, autoPly: -1),
                            white: you, black: avery, clocks: clocks(200000, 210000), drawOffer: "null", takeback: "null")
        case .drawOffered:
            return duelView(fen: openingFen, turnSide: "white", inCheck: false, legal: openingLegal,
                            moves: records(san: openingSan, from: openingFrom, to: openingTo, white: you, black: avery, autoPly: -1),
                            white: you, black: avery, clocks: clocks(238000, 252000), drawOffer: offer("black", avery), takeback: "null")
        case .takebackRequested:
            return duelView(fen: takebackFen, turnSide: "black", inCheck: false, legal: takebackLegal,
                            moves: records(san: takebackSan, from: takebackFrom, to: takebackTo, white: avery, black: you, autoPly: -1),
                            white: avery, black: you, clocks: clocks(236000, 250000), drawOffer: "null", takeback: offer("white", avery))
        case .teamsMember:
            return publicView(phase: "playing", mode: "teams", fen: kingsPawnFen, turnSide: "white", inCheck: false, legal: kingsPawnLegal,
                              moves: records(san: ["e4", "e5"], from: ["e2", "e7"], to: ["e4", "e5"], white: avery, black: ben, autoPly: -1),
                              white: [member(avery, captain: true), member(you, captain: false)],
                              black: [member(ben, captain: true), member(cai, captain: false)], clocks: clocks(594000, 597000),
                              timeControl: "600000", increment: 0, moveTime: "null", takebacks: true, bot: "null", turnStartedAt: at(-4000),
                              drawOffer: "null", takeback: "null", result: "null")
        case .computer:
            return publicView(phase: "playing", mode: "computer", fen: kingsPawnFen, turnSide: "white", inCheck: false, legal: kingsPawnLegal,
                              moves: records(san: ["e4", "e5"], from: ["e2", "e7"], to: ["e4", "e5"], white: you, black: computer, autoPly: -1),
                              white: [member(you, captain: true)], black: [member(computer, captain: true)], clocks: noClocks,
                              timeControl: "null", increment: 0, moveTime: "null", takebacks: true, bot: mediumBot, turnStartedAt: at(-1000),
                              drawOffer: "null", takeback: "null", result: "null")
        case .spectator:
            return publicView(phase: "playing", mode: "duel", fen: knightFen, turnSide: "black", inCheck: false, legal: knightLegal,
                              moves: records(san: ["e4", "e5", "Nf3"], from: ["e2", "e7", "g1"], to: ["e4", "e5", "f3"], white: avery,
                                             black: ben, autoPly: -1),
                              white: [member(avery, captain: true)], black: [member(ben, captain: true)], clocks: clocks(581000, 574000),
                              timeControl: "600000", increment: 0, moveTime: "null", takebacks: true, bot: "null", turnStartedAt: at(-6000),
                              drawOffer: "null", takeback: "null", result: "null")
        case .lowTime:
            return publicView(phase: "playing", mode: "duel", fen: openingFen, turnSide: "white", inCheck: false, legal: openingLegal,
                              moves: records(san: openingSan, from: openingFrom, to: openingTo, white: you, black: avery, autoPly: 3),
                              white: [member(you, captain: true)], black: [member(avery, captain: true)], clocks: clocks(8000, 41000),
                              timeControl: "60000", increment: 0, moveTime: "10000", takebacks: true, bot: "null", turnStartedAt: at(-3000),
                              drawOffer: "null", takeback: "null", result: "null")
        case .checkmate:
            return publicView(phase: "results", mode: "duel", fen: foolsMateFen, turnSide: "white", inCheck: true, legal: "{}",
                              moves: records(san: foolsMateSan, from: foolsMateFrom, to: foolsMateTo, white: you, black: avery, autoPly: -1),
                              white: [member(you, captain: true)], black: [member(avery, captain: true)], clocks: clocks(590000, 585000),
                              timeControl: "600000", increment: 0, moveTime: "null", takebacks: true, bot: "null", turnStartedAt: "null",
                              drawOffer: "null", takeback: "null", result: "{\"winner\":\"black\",\"reason\":\"checkmate\"}")
        case .drawAgreed:
            return publicView(phase: "results", mode: "duel", fen: openingFen, turnSide: "white", inCheck: false, legal: "{}",
                              moves: records(san: openingSan, from: openingFrom, to: openingTo, white: avery, black: you, autoPly: -1),
                              white: [member(avery, captain: true)], black: [member(you, captain: true)], clocks: clocks(238000, 252000),
                              timeControl: "300000", increment: 3000, moveTime: "null", takebacks: true, bot: "null", turnStartedAt: "null",
                              drawOffer: "null", takeback: "null",
                              result: "{\"winner\":\"draw\",\"reason\":\"agreement\",\"byPlayerId\":\"r1\",\"byName\":\"Avery\"}")
        }
    }

    static func playerView(_ state: ChessFixtureState) -> String {
        switch state {
        case .yourMove, .reconnecting, .promotion, .special, .lowTime:
            return playerView(side: "white", role: "white-captain", canMove: true, canResign: true, canOfferDraw: true,
                              canRespondToDraw: false, canRequestTakeback: true, canRespondToTakeback: false)
        case .waiting:
            return playerView(side: "black", role: "black-captain", canMove: false, canResign: true, canOfferDraw: true,
                              canRespondToDraw: false, canRequestTakeback: true, canRespondToTakeback: false)
        case .check:
            return playerView(side: "black", role: "black-captain", canMove: true, canResign: true, canOfferDraw: true,
                              canRespondToDraw: false, canRequestTakeback: true, canRespondToTakeback: false)
        case .drawOffered:
            return playerView(side: "white", role: "white-captain", canMove: true, canResign: true, canOfferDraw: true,
                              canRespondToDraw: true, canRequestTakeback: true, canRespondToTakeback: false)
        case .takebackRequested:
            return playerView(side: "black", role: "black-captain", canMove: true, canResign: true, canOfferDraw: true,
                              canRespondToDraw: false, canRequestTakeback: false, canRespondToTakeback: true)
        case .teamsMember:
            return playerView(side: "white", role: "white-team", canMove: false, canResign: false, canOfferDraw: false,
                              canRespondToDraw: false, canRequestTakeback: false, canRespondToTakeback: false)
        case .computer:
            return playerView(side: "white", role: "white-captain", canMove: true, canResign: true, canOfferDraw: false,
                              canRespondToDraw: false, canRequestTakeback: true, canRespondToTakeback: false)
        case .spectator:
            return ""
        case .checkmate:
            return playerView(side: "white", role: "white-captain", canMove: false, canResign: false, canOfferDraw: false,
                              canRespondToDraw: false, canRequestTakeback: false, canRespondToTakeback: false)
        case .drawAgreed:
            return playerView(side: "black", role: "black-captain", canMove: false, canResign: false, canOfferDraw: false,
                              canRespondToDraw: false, canRequestTakeback: false, canRespondToTakeback: false)
        }
    }

    static func players(_ state: ChessFixtureState) -> [GamePlayerInput] {
        switch state {
        case .teamsMember: return ActivityFixtureScript.players(4, includingYou: true)
        case .computer: return ActivityFixtureScript.players(1, includingYou: true)
        case .spectator: return ActivityFixtureScript.players(2, includingYou: false)
        default: return ActivityFixtureScript.players(2, includingYou: true)
        }
    }

    static func isFinished(_ state: ChessFixtureState) -> Bool {
        state == ChessFixtureState.checkmate || state == ChessFixtureState.drawAgreed
    }

    static func push(_ state: ChessFixtureState, isRecovering: Bool) -> GameStageInputs {
        let seated = state != ChessFixtureState.spectator
        return GameStageInputs.make(callSession: 1, isActive: true, gameId: "chess", name: "Chess",
                                    phase: isFinished(state) ? "results" : "playing", players: players(state),
                                    isFinished: isFinished(state), minPlayers: 1, publicViewJSON: publicView(state),
                                    playerViewJSON: playerView(state), localPlayerId: seated ? ActivityFixtureScript.localUserId : "",
                                    isHost: seated && state != ChessFixtureState.drawAgreed, isRecovering: isRecovering,
                                    receivedAtMillis: Date().timeIntervalSince1970 * 1000.0)
    }

    static func pushes(_ state: ChessFixtureState) -> [GameStageInputs] {
        if state == ChessFixtureState.reconnecting {
            return [push(ChessFixtureState.yourMove, isRecovering: false), push(state, isRecovering: true)]
        }
        return [push(state, isRecovering: false)]
    }

    static func duelPush(fen: String, turnSide: String, legal: String, san: [String], from: [String], to: [String],
                         canRequestTakeback: Bool) -> GameStageInputs {
        let view = duelView(fen: fen, turnSide: turnSide, inCheck: false, legal: legal,
                            moves: records(san: san, from: from, to: to, white: you, black: avery, autoPly: -1), white: you, black: avery,
                            clocks: clocks(300000, 300000), drawOffer: "null", takeback: "null")
        let mine = playerView(side: "white", role: "white-captain", canMove: turnSide == "white", canResign: true, canOfferDraw: true,
                              canRespondToDraw: false, canRequestTakeback: canRequestTakeback, canRespondToTakeback: false)
        return GameStageInputs.make(callSession: 1, isActive: true, gameId: "chess", name: "Chess", phase: "playing",
                                    players: ActivityFixtureScript.players(2, includingYou: true), minPlayers: 1, publicViewJSON: view,
                                    playerViewJSON: mine, localPlayerId: ActivityFixtureScript.localUserId, isHost: true,
                                    receivedAtMillis: Date().timeIntervalSince1970 * 1000.0)
    }

    static func stageInputs(named raw: String, base: StageInputs) -> StageInputs {
        if state(named: raw) == nil { return base }
        let game = ActivityFixtureScript.stageInputs(named: ActivityFixtureState.gameTrivia6.rawValue, base: base)
        return StageFixtureScript.copy(game, isGameActive: true, gameName: "Chess")
    }

    @discardableResult
    @MainActor
    static func apply(named raw: String, session: ActivitySession, owner: ActivityFixtureOwner) -> ChessFixtureState? {
        guard let fixture = state(named: raw) else { return nil }
        session.activities.onCommand = { [weak owner] command in
            owner?.record(command)
        }
        session.games.onCommand = { [weak owner, weak session] command in
            guard let owner = owner else { return }
            owner.record(command)
            guard let session = session else { return }
            if command.kind == GameStageCommandKind.move && owner.acknowledgesMoves {
                session.games.moveAcknowledged(requestId: command.requestId, success: true, serverText: "")
            } else if command.kind == GameStageCommandKind.end && owner.failsEnd {
                session.games.endFailed(serverText: "")
            }
        }
        session.applyActivities(ActivityFixtureScript.activitiesInputs(ActivityFixtureState.gameTrivia6))
        for inputs in pushes(fixture) {
            session.applyGame(inputs)
        }
        return fixture
    }
}
