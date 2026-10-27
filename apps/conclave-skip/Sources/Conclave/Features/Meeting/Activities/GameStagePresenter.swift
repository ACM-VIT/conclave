import Foundation
import Observation

/// S60 0.5 and 8 (ACT-2): the session-owned game shell presenter inside the S20 activity card. Five stored properties,
/// each its own observation unit (SkipModel backs each with one `MutableState`): `chrome` (the header and seat, per
/// phase), `scene` (the body, per push), `countdown` (the deadline, once per push; the leaf ticks itself), `results`
/// (the scoreboard and rematch) and `interaction` (pending and failure, per local move). Pushes are parsed once
/// (`GameProjectionParser`, C6-15). A move's request id is client-local and bound to that emit's ack: pending clears on
/// that ack or after a 10 s timeout mapped to `GameFailure.server`, never on a push, because the SFU broadcasts the new
/// state before it acks the move (gameHandlers.ts:601-651). ACT-3 to ACT-6 extend `scene` with per-game models.
@MainActor
@Observable
final class GameStagePresenter {
    private(set) var chrome: GameChromeModel = GameChromeModel.empty
    private(set) var scene: GameScene = GameScene.empty
    private(set) var countdown: CountdownModel? = nil
    private(set) var results: GameResultsModel = GameResultsModel.empty
    private(set) var interaction: GameInteractionModel = GameInteractionModel.idle
    /// Game outcome tokens (S20 0.5 registry: `gameCorrect`, `gameWrong`, `tapEarly`, `guessInvalid`, `wordSolved`,
    /// `moveRejected`; `gameStarted` stays with the stage presenter, RECONCILE R12).
    private(set) var feedbackState = MeetingShellFeedbackState(session: 0, token: FeedbackToken.baseline)

    /// Core only: moves, join, rematch and end (the S1 `onCommand` pattern).
    @ObservationIgnored var onCommand: ((GameStageCommand) -> Void)? = nil
    @ObservationIgnored var sleep: (Double) async -> Void = { millis in
        try? await Task.sleep(nanoseconds: UInt64(max(0.0, millis) * 1_000_000.0))
    }

    @ObservationIgnored private(set) var inputs = GameStageInputs.make()
    /// Diagnostics for readouts and tests (never observed): `game.emits`, parse count.
    @ObservationIgnored private(set) var emitLog: [String] = []
    @ObservationIgnored private(set) var parseCount = 0

    @ObservationIgnored private var projection = GameProjection.empty
    @ObservationIgnored private var parsedKey = ""
    /// The client clock of the push the current projection came from (the countdown offset uses it, never a refresh).
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

    static let moveTimeoutMillis = 10000.0

    init() {}

    // MARK: Core hooks

    /// Core only: one game push (public state, player view, identity). Equality guarded; parsed once.
    func apply(_ next: GameStageInputs) {
        if inputs.callSession != 0 && next.callSession != inputs.callSession {
            reset()
        }
        if next == inputs { return }
        let previous = inputs
        inputs = next
        if !next.isActive || next.gameId != previous.gameId {
            // The session ended or another game replaced it: nothing pending can still be answered for it.
            clearPending()
            endPending = false
            endFailed = false
            rematchPending = false
        }
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
            // A failure shows until the next push that moved the game on (S60 8 f); a pending move stays pending.
            if failure != GameFailure.none && pendingRequestId.isEmpty && previous.isActive {
                failure = GameFailure.none
                failureText = ""
            }
        }
        rebuild()
    }

    /// Core only: the ack of the emit that carried `requestId` (C6-15). An ack for an older request is ignored.
    func moveAcknowledged(requestId: String, success: Bool, serverText: String) {
        if requestId.isEmpty || requestId != pendingRequestId { return }
        cancelTimeout()
        pendingRequestId = ""
        pendingType = ""
        if success {
            failure = GameFailure.none
            failureText = ""
        } else {
            failure = GameFailurePolicy.failure(serverText: serverText)
            failureText = failure == GameFailure.server ? serverText : ""
            if failure == GameFailure.notAccepted { advanceFeedback(FeedbackKind.moveRejected) }
        }
        publishInteraction()
    }

    /// Core only: the stage End failed (S60 8 f "Couldn't end the game. Try again.").
    func endFailed(serverText: String) {
        endPending = false
        endFailed = true
        rebuild()
    }

    /// Core only: the rematch failed; Play Again stops showing "Starting".
    func rematchFailed() {
        if !rematchPending { return }
        rematchPending = false
        rebuild()
    }

    // MARK: Actions (views)

    /// `dispatched` only for a sent move; `ignored` while another move is pending; `explained` when the person cannot
    /// move (not seated, reconnecting, no game), so the view shows why instead of a silent drop (INM G5).
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
        onCommand?(GameStageCommand(kind: GameStageCommandKind.move, type: stamped.type,
                                    payloadJSON: GameMoveAdapter.payloadJSON(stamped), requestId: requestId))
        return ActivityTapResult.dispatched
    }

    /// Asks for a seat; the server grants it at the next round boundary (`game:join`).
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

    /// After the confirmation attached to the End button (R09). A second tap while pending is ignored.
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

    /// The running game as the launcher needs it (Activities Now Playing and catalog gate).
    func summary() -> ActivityGameSummary {
        if !inputs.isActive { return ActivityGameSummary.none }
        return ActivityGameSummary(gameId: inputs.gameId, name: inputs.name, isActive: true, isFinished: inputs.isFinished,
                                   round: chrome.roundIndex, roundTotal: chrome.roundTotal, playerCount: inputs.players.count)
    }

    /// With the S1 reset (S1C 3.3 TEAR): no timer or pending request survives.
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
        if chrome.withRevision(0) != GameChromeModel.empty { chrome = GameChromeModel.empty.withRevision(chrome.revision + 1) }
        if scene.withRevision(0) != GameScene.empty { scene = GameScene.empty.withRevision(scene.revision + 1) }
        if countdown != nil { countdown = nil }
        if results.withRevision(0) != GameResultsModel.empty { results = GameResultsModel.empty.withRevision(results.revision + 1) }
        publishInteraction()
    }

    var hasLiveTimeout: Bool { timeoutTask != nil }

    // MARK: Building

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
        let nextScene = GameScene(revision: scene.revision, kind: sceneKind(phase: phase, isSeated: isSeated), players: players,
                                  pendingJoiners: pending, options: GameStagePresenter.optionSummary(config: inputs.config, options: inputs.options),
                                  lobby: lobby, projection: projection)
        if nextScene != scene { scene = nextScene.withRevision(scene.revision + 1) }

        var nextCountdown: CountdownModel? = nil
        if inputs.isActive && !inputs.isFinished && common.deadlineMillis > 0 {
            let offset = common.serverNowMillis > 0 && pushReceivedAtMillis > 0 ? pushReceivedAtMillis - common.serverNowMillis : 0
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
            // A seated player waits for their own view before the scene shows (S60 8 f "Loading Your Game View").
            if isSeated && !projection.hasPlayerView { return GameSceneKind.privateView }
            return projection.kind
        }
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

    // MARK: Pure rules

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
            // Fixes the silent drop of an unseated host's Start (INM G5).
            return GameLobbyModel(canStart: false, reason: GameLobbyReason.joinToStart, minPlayers: minPlayers, playerCount: playerCount,
                                  showsJoin: seat == SeatState.canJoin)
        }
        if playerCount < minPlayers {
            return GameLobbyModel(canStart: false, reason: GameLobbyReason.needsPlayers, minPlayers: minPlayers, playerCount: playerCount,
                                  showsJoin: false)
        }
        return GameLobbyModel(canStart: true, reason: GameLobbyReason.none, minPlayers: minPlayers, playerCount: playerCount, showsJoin: false)
    }

    /// "Questions: 7 · Pace: Normal": server labels and choice labels verbatim, in catalog order.
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

    /// Ranked rows (ties share a rank), the leader marked, the winner line and tie flag (S60 8 g).
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

    // MARK: Timeout (one task; injectable sleep)

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

    /// What the timeout runs (tests call it directly): an unanswered move becomes the `server` failure.
    func fireTimeout(requestId: String) {
        if requestId != pendingRequestId { return }
        timeoutTask?.cancel()
        timeoutTask = nil
        pendingRequestId = ""
        pendingType = ""
        failure = GameFailure.server
        failureText = ""
        publishInteraction()
    }

    private func cancelTimeout() {
        timeoutTask?.cancel()
        timeoutTask = nil
    }
}
