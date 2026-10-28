import Foundation
import Observation

/// S60 0.5 and 8 (ACT-2): the session-owned game shell presenter inside the S20 activity card. Five stored properties,
/// each its own observation unit (SkipModel backs each with one `MutableState`): `chrome` (the header and seat, per
/// phase), `scene` (the body, per push), `countdown` (the deadline, once per push; the leaf ticks itself), `results`
/// (the scoreboard and rematch) and `interaction` (pending and failure, per local move). Pushes are parsed once
/// (`GameProjectionParser`, C6-15). A move's request id is client-local and bound to that emit's ack: pending clears on
/// that ack or after a 10 s timeout mapped to `GameFailure.server`, never on a push, because the SFU broadcasts the new
/// state before it acks the move (gameHandlers.ts:601-651). ACT-3 to ACT-6 extend `scene` with per-game models: ACT-3
/// builds the six prompt game scenes (S60 9 j) here, once per push, from the typed projections
/// (`PromptSceneBuilder`, Games/Native/Scenes/PromptGameScenes.swift); private fields come only from the local
/// person's own player view and only while that person holds a seat. ACT-4 builds the Wordle scene (S60 10 j,
/// `WordleSceneBuilder` at the end of this file) the same way and keeps the one Wordle draft here
/// (`wordleDraft`, keyed by the game, the round and the input kind), so the draft survives rotation, Show Video and
/// unrelated pushes, stays on a rejected guess and clears only when the server records the guess or the round moves on.
/// ACT-5 builds the chess scene (S60 11 j, `ChessSceneBuilder` at the end of this file) once per push, the FEN parsed
/// into 64 squares here, and keeps the move in flight as `chessPendingMove` (the piece at its destination with a pending
/// outline until that move's ack or the push that records it; a rejection restores the position and plays
/// `moveRejected`). The draw, takeback and resign actions are payload-free moves gated by the projected eligibility.
/// ACT-6 builds the Zip scene (S60 12 j, ZipSceneBuilder in Games/Native/Boards/ZipScene.swift) once per push; the
/// draft path stays view-local in the boards until a finger lift, key run or step sends it.
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
    /// ACT-4 (S60 10 j): the Wordle draft (uppercase A to Z, at most the word length), its own observation unit so a key
    /// press re-evaluates only the board's draft row and the keys, never the scene (S60 10 k). The secret word a setter
    /// types and a guess share it; the key below keeps them apart.
    private(set) var wordleDraft: String = ""
    /// ACT-5 (S60 11 f): the chess move in flight as the board draws it, or the rejection that restored the position. Its
    /// own observation unit, read only by the board and its status line, so dispatching a move re-evaluates nothing else.
    private(set) var chessPendingMove: ChessPendingMoveModel = ChessPendingMoveModel.none

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
    /// Names seen during this game (seated players and the module rosters), so a vote target who left can still be
    /// named ("%@ left. Vote again.", S60 9 f). Cleared when the game changes.
    @ObservationIgnored private var knownPlayers: [GameNamedPlayer] = []
    /// One-shot accessibility announcements already made for this game session (S60 9 i: the reveal, the vote result
    /// and the Reaction go are announced once, however often a view reappears). Cleared in the lobby and on a new game.
    @ObservationIgnored private var announced: [String] = []
    /// What `wordleDraft` belongs to: the game id plus `WordleScene.draftKey` ("guess-2", "secret-1"); "" when no draft
    /// can exist. A new key clears the draft (a new round, the word set, the round's results, another game).
    @ObservationIgnored private var wordleDraftKey = ""
    /// The word of the guess or secret in flight, so the push that records it (or its successful ack) clears the draft
    /// exactly once; a rejection or the timeout keeps the draft (S60 10 f).
    @ObservationIgnored private var wordleSubmitted = ""
    /// ACT-5: the request id of the chess move whose overlay shows (its ack or timeout settles it) and the position it
    /// was sent from (a push with another position clears the overlay; the request stays pending until its ack).
    @ObservationIgnored private var chessMoveRequestId = ""
    @ObservationIgnored private var chessFenAtSend = ""

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
            knownPlayers = []
            announced = []
            wordleSubmitted = ""
            // ACT-5: the chess move in flight belonged to the old game; its overlay goes on the rebuild below.
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
        let ackedType = pendingType
        pendingRequestId = ""
        pendingType = ""
        // ACT-5: whether this ack answers the chess move whose overlay shows (S60 11 f "move pending" and "move rejected").
        let isChessMove = !chessMoveRequestId.isEmpty && chessMoveRequestId == requestId
        if isChessMove { settleChessMove(rejected: !success) }
        if success {
            failure = GameFailure.none
            failureText = ""
            // ACT-4: the server took the guess or the secret word. The push that records it normally arrived first and
            // already cleared the draft; if the ack won the race, clear it now so the same word is never sent twice.
            if (ackedType == WordleIntent.guessType || ackedType == WordleIntent.setWordType) && !wordleSubmitted.isEmpty
                && wordleDraft == wordleSubmitted {
                wordleDraft = ""
            }
        } else {
            failure = GameFailurePolicy.failure(serverText: serverText)
            failureText = failure == GameFailure.server ? serverText : ""
            if ackedType == WordleIntent.guessType {
                // S60 10 e, f: a rejected guess ("Not in word list") keeps the draft and plays `guessInvalid`.
                advanceFeedback(FeedbackKind.guessInvalid)
            } else if isChessMove || failure == GameFailure.notAccepted || ackedType == "submit"
                        || (projection.kind == GameSceneKind.zip && ackedType == ZipIntent.moveType) {
                // A rejected bluff ("That is the real answer. Write a bluff.") is the S60 9 h rejection outcome too; R12
                // names this presenter's rejection token `moveRejected` (S1 alone publishes `actionRejected`). ACT-5: a
                // rejected chess move ("Illegal move") plays it once and the board shows the server position again.
                // ACT-6: a refused Zip path ("That path isn’t allowed. Try again.") plays it once; the board shows
                // the server’s path again.
                advanceFeedback(FeedbackKind.moveRejected)
            }
        }
        if ackedType == WordleIntent.guessType || ackedType == WordleIntent.setWordType { wordleSubmitted = "" }
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
        // ACT-5: the chess overlay is set before the core sees the command, so a synchronous ack still finds it.
        noteChessDispatch(stamped)
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

    /// Views only: true the first time `key` is claimed during this game session, so an announcement (the Trivia
    /// reveal, the vote result, the Reaction go) is posted once even when its view appears again (S60 9 i).
    func claimAnnouncement(_ key: String) -> Bool {
        if key.isEmpty || announced.contains(key) { return false }
        announced.append(key)
        if announced.count > 40 { announced.removeFirst() }
        return true
    }

    // MARK: Wordle draft and moves (ACT-4, S60 10 c, d, f, j)

    /// Views only: one letter from the letter keys or a hardware key. Ignored when the person cannot type (no guess or
    /// secret is possible, the board is full, or the guess is waiting for its ack).
    func typeWordleLetter(_ letter: String) {
        guard let wordle = scene.wordle, canEditWordleDraft(wordle) else { return }
        setDraft(WordleBoardPolicy.normalized(wordleDraft + letter, limit: wordle.wordLength))
    }

    /// Views only: Delete (the R6-1 `backspace` key) or the hardware delete key removes one letter.
    func deleteWordleLetter() {
        guard let wordle = scene.wordle, canEditWordleDraft(wordle) else { return }
        if wordleDraft.isEmpty { return }
        setDraft(String(wordleDraft.dropLast()))
    }

    /// Views only: the text field ("Your Guess", "Secret Word") and paste. Letters only, uppercased, at most the word
    /// length; anything else is dropped (S60R 22: never arbitrary scripts into a five-letter server game).
    func setWordleDraft(_ text: String) {
        guard let wordle = scene.wordle, canEditWordleDraft(wordle) else { return }
        setDraft(WordleBoardPolicy.normalized(text, limit: wordle.wordLength))
    }

    /// Views only: Enter, Enter Guess, Go, Return or Set Word. Sends exactly one `guess` or `setWord` move with the full
    /// draft; the draft stays until the server records the word (S60 10 f), so a rejection keeps it. `ignored` for a
    /// short draft or while another move is pending; `explained` when the person cannot play this round.
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
        // The guess in flight is the draft: it stays as sent until the server answers (no edit races the ack).
        if !pendingRequestId.isEmpty && (pendingType == WordleIntent.guessType || pendingType == WordleIntent.setWordType) {
            return false
        }
        return true
    }

    private func setDraft(_ text: String) {
        if text != wordleDraft { wordleDraft = text }
    }

    /// After each rebuild: a new draft key clears the draft; the push that records the word in flight clears it once.
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

    // MARK: Chess moves and actions (ACT-5, S60 11 c, d, f, j; C6-17)

    /// Views only: the board's destination tap, the promotion choice or the move chooser. Sends one `move {from, to,
    /// promotion}` when the projection lists it (or, without projected moves, any empty or enemy square, S60R 23); a
    /// promotion is never sent without the person's choice (no auto-queen). `ignored` for a move the projection does not
    /// allow or while another move is pending; `explained` when the person cannot move now.
    func sendChessMove(from: String, to: String, promotion: String) -> ActivityTapResult {
        guard let chess = scene.chess else { return ActivityTapResult.explained }
        if !pendingRequestId.isEmpty { return ActivityTapResult.ignored }
        if !chess.canMove { return ActivityTapResult.explained }
        if !ChessBoardPolicy.canSend(chess, from: from, to: to, promotion: promotion) { return ActivityTapResult.ignored }
        return send(ChessIntent.move(from: from, to: to, promotion: promotion))
    }

    /// Views only: Offer Draw, Accept Draw, Decline, Request Takeback, Accept Takeback, Decline and Resign (after its
    /// confirmation). Payload-free moves of the module's own types, sent only while the projection makes the person
    /// eligible (`explained` otherwise).
    func sendChessAction(_ action: ChessAction) -> ActivityTapResult {
        guard let chess = scene.chess else { return ActivityTapResult.explained }
        if !pendingRequestId.isEmpty { return ActivityTapResult.ignored }
        if !ChessBoardPolicy.isEligible(action, scene: chess) { return ActivityTapResult.explained }
        return send(ChessIntent.action(action))
    }

    /// Inside `send`: a chess move shows its piece at the destination with the pending outline from now on.
    private func noteChessDispatch(_ intent: GameMoveIntent) {
        if intent.type != ChessIntent.moveType || intent.from.isEmpty { return }
        guard let chess = scene.chess else { return }
        chessMoveRequestId = intent.requestId
        chessFenAtSend = chess.fen
        let next = ChessPendingMoveModel(from: intent.from, to: intent.to, promotion: intent.promotion,
                                         piece: chess.pieceAt(intent.from), isRejected: false)
        if next != chessPendingMove { chessPendingMove = next }
    }

    /// The move's ack or timeout: the overlay goes; a rejection leaves "Move rejected" until the position changes.
    private func settleChessMove(rejected: Bool) {
        chessMoveRequestId = ""
        let next = rejected ? ChessPendingMoveModel.rejected : ChessPendingMoveModel.none
        if next != chessPendingMove { chessPendingMove = next }
    }

    /// After each rebuild: a push with another position replaces the overlay (the board now shows the server's
    /// position); the request itself stays pending until its own ack (C6-15). The overlay also goes when the game is no
    /// longer being played, and a pending piece whose request was dropped with an ended game never lingers.
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
        rememberPlayers()
        // ACT-3 (S60 9 j): the prompt game scene of this push, built once; private fields only for a seated player.
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
        // ACT-4 (S60 10 j): the Wordle scene of this push; your rows, outcome and the setter's live boards only from your
        // own player view while you hold a seat.
        var wordle: WordleScene? = nil
        if let projected = projection.wordle { wordle = WordleSceneBuilder.scene(projected, context: context) }
        // ACT-5 (S60 11 j): the chess scene of this push (the FEN parsed once into 64 squares, the legal moves with their
        // flags, the clocks with this push's clock offset); your side and eligibility only from your own player view.
        var chess: ChessScene? = nil
        if let projected = projection.chess {
            chess = ChessSceneBuilder.scene(projected, context: context, receivedAtMillis: pushReceivedAtMillis,
                                            serverNowMillis: common.serverNowMillis)
        }
        // ACT-6 (S60 12 j): the Zip scene of this push (checkpoints, barriers, removed cells, the cell models with the
        // eligible next cells, standings); your path, outcome, hints and hint cooldown (with this push's clock offset) only
        // from your own player view while you hold a seat and the module counts you in the round.
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
            // A seated player waits for their own view before the scene shows (S60 8 f "Loading Your Game View").
            if isSeated && !projection.hasPlayerView { return GameSceneKind.privateView }
            return projection.kind
        }
    }

    /// Adds the names of this push (seated players, queued joiners and the vote rosters) to `knownPlayers`.
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
        // ACT-5: an unanswered chess move drops its overlay (the next push shows whatever the server holds).
        if chessMoveRequestId == requestId { settleChessMove(rejected: false) }
        // An unanswered guess keeps its draft and nothing is resent on its own (S60 10 f "submitting"); `wordleSubmitted`
        // stays, so a late push that does record the word still clears the draft once.
        publishInteraction()
    }

    private func cancelTimeout() {
        timeoutTask?.cancel()
        timeoutTask = nil
    }
}

// MARK: - Wordle scene (ACT-4, S60 10)

// S60 10 j: the Wordle scene models, built once per push from `WordleProjection` (GameProjections.swift; G/wordle.ts
// publicView 531-597 and playerView 599-621) and published inside `GameScene.wordle`, so both platforms' boards read ready
// values and never parse JSON. Hidden information stays per player: your rows and outcome come only from your own player
// view while you hold a seat, and the contestants' boards only from the setter's own view, as marks without letters (the
// room host never gains anyone's guesses). Shared (transpiled): String raw-value enums, scalar structs and arrays of structs
// only. They live in this file because ACT-4 owns this presenter and the two board files only.

/// One board letter (S60 10 c, e). `typed` is a draft letter not yet sent; the three marks are the server's green, yellow
/// and gray, each drawn with a glyph twin and read as text, never color alone.
enum WordleCellState: String, CaseIterable, Equatable {
    case empty, typed, correct, present, absent
}

/// The best known state of a letter key (S60 10 c): correct beats present beats absent.
enum WordleKeyState: String, CaseIterable, Equatable {
    case unused, correct, present, absent
}

/// G/wordle.ts phases; `results` is a round's results, and the game's at the final round.
enum WordlePhase: String, CaseIterable, Equatable {
    case lobby, setWord, playing, results
}

/// Your part in this round: a guesser, the setter watching, or watching without a board (no seat, or a seat granted after
/// the round began, which the module does not count as a contestant).
enum WordleRole: String, CaseIterable, Equatable {
    case guesser, setter, spectator
}

/// Your board's end (G/wordle.ts `myOutcome`: "win", "lose", "timeout").
enum WordleOutcome: String, CaseIterable, Equatable {
    case none, solved, outOfTries, timedOut
}

/// A contestant's state in the public standings (`standings[].outcome`).
enum WordleStandingStatus: String, CaseIterable, Equatable {
    case playing, solved, outOfTries, timedOut
}

struct WordleCellModel: Equatable, Identifiable {
    /// "r2c3": row and column, stable for the round.
    let id: String
    /// One uppercase letter; "" for an empty cell and in the setter's status-only boards.
    let letter: String
    let state: WordleCellState
}

struct WordleRowModel: Equatable, Identifiable {
    let id: String
    /// 0-based; read 1-based ("Row %lld: %@").
    let index: Int
    let cells: [WordleCellModel]
    /// The row's letters ("" for an empty row and in status-only boards).
    let word: String
    /// A row the server marked (a recorded guess).
    let isGuess: Bool
}

struct WordleKeyModel: Equatable, Identifiable {
    /// The letter.
    let id: String
    let letter: String
    let state: WordleKeyState
    /// The keyboard row: 0 (Q to P), 1 (A to L) or 2 (Z to M).
    let row: Int
}

struct WordleStandingModel: Equatable, Identifiable {
    let id: String
    let name: String
    let status: WordleStandingStatus
    let tries: Int
    let isYou: Bool
}

/// One contestant's board as the setter watches it (S60 10 f): marks only, no letters, with the status twin.
struct WordleBoardStatusModel: Equatable, Identifiable {
    let id: String
    let name: String
    let status: WordleStandingStatus
    let tries: Int
    let rows: [WordleRowModel]
}

/// S60 10 j. `myRows` holds only the rows the server marked, so it changes per guess; the board adds the draft row from
/// `GameStagePresenter.wordleDraft` (`WordleBoardPolicy.displayRows`). `solution` and `winnerName` are set at the results
/// only; the countdown is the shell's.
struct WordleScene: Equatable {
    let phase: WordlePhase
    /// 1-based; 0 in the lobby.
    let round: Int
    let roundTotal: Int
    let wordLength: Int
    let maxTries: Int
    /// The "random" word source; false when a player sets the word.
    let isRandomWord: Bool
    let role: WordleRole
    let setterName: String
    let isSetter: Bool
    let canSetWord: Bool
    let canGuess: Bool
    let myRows: [WordleRowModel]
    /// All 26 letters in keyboard order with their best known state.
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
    /// Reconnecting: the board is read-only (S60 10 f).
    let isReconnecting: Bool
    /// Next Round for a seated host at a round's results before the final round (G/wordle.ts `nextRound`; the engine
    /// takes moves only from seated players).
    let canAdvanceRound: Bool

    var triesUsed: Int { myRows.count }

    /// The draft row shows while your board is open this round (also while reconnecting, read-only).
    var showsDraftRow: Bool {
        role == WordleRole.guesser && phase == WordlePhase.playing && myOutcome == WordleOutcome.none && myRows.count < maxTries
    }

    /// What a draft belongs to: "secret-<round>" for the setter's word, "guess-<round>" for a guess, "" otherwise.
    var draftKey: String {
        if phase == WordlePhase.setWord && isSetter { return "secret-" + String(round) }
        if phase == WordlePhase.playing && role == WordleRole.guesser { return "guess-" + String(round) }
        return ""
    }

    /// One-shot announcement keys (S60 10 i); "" when nothing is due.
    var outcomeKey: String {
        myOutcome == WordleOutcome.none ? "" : "wordle-outcome-" + String(round) + "-" + myOutcome.rawValue
    }

    var resultKey: String {
        phase == WordlePhase.results && !solution.isEmpty ? "wordle-result-" + String(round) : ""
    }

    /// The keys of one keyboard row, in order.
    func keys(inRow row: Int) -> [WordleKeyModel] {
        var result: [WordleKeyModel] = []
        for key in keyStates where key.row == row {
            result.append(key)
        }
        return result
    }

    /// Whether one of your recorded rows is `word`.
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

    /// A recorded guess as a row. `showsLetters` is false for the setter's status-only boards (marks without letters).
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

    /// The 26 keys in keyboard order with the best state your marked rows prove.
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

    /// Correct beats present beats absent: a letter marked absent in one spot (a repeated letter) keeps the better mark
    /// it earned elsewhere.
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

    /// G/wordle.ts `WordleTile`.
    static func parseMark(_ raw: String) -> WordleCellState {
        switch raw {
        case "green": return WordleCellState.correct
        case "yellow": return WordleCellState.present
        default: return WordleCellState.absent
        }
    }
}

/// Board and keyboard rules both platforms share (S60 10 c, d).
enum WordleBoardPolicy {
    static let keyboardRows: [String] = ["QWERTYUIOP", "ASDFGHJKL", "ZXCVBNM"]
    static let alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ"
    /// 38 pt/dp cells with 4 pt/dp gaps: 5 x 38 + 4 x 4 = 206, which fits every phone card.
    static let cellSize = 38.0
    static let gap = 4.0
    static let boardWidth = 206.0
    /// The deliberate game-grid width exception (S60R 22): letter keys at most 32 wide; Enter and Delete 1.5 keys.
    static let maxKeyWidth = 32.0
    static let wideKeyFactor = 1.5
    /// The timer turns the warning color with its "%@ left" twin at 10 s or less, and is announced at 60 s and 10 s.
    static let warningSeconds = 10
    static let announcedSeconds: [Int] = [60, 10]

    /// Letters only (A to Z, uppercased), at most `limit`: the letter keys, hardware keys, the text field and paste share
    /// it, so nothing but game letters ever reaches the server (S60R 22).
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

    /// Enter, Enter Guess and Set Word: a full draft while the person can guess or set the word.
    static func canSubmit(_ scene: WordleScene, draft: String) -> Bool {
        (scene.canGuess || scene.canSetWord) && normalized(draft, limit: scene.wordLength).count == scene.wordLength
    }

    /// The rows the board draws: your marked rows, the draft row while your board is open, then empty rows up to the try
    /// limit. Only the board's draft leaf calls it, so a key press never rebuilds the scene (S60 10 k).
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

    /// A draft (typed letters, then empty cells) or an empty row.
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

    /// The results' solution as correct cells (S60 10 c "solution as five success cells").
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

    /// S60 10 c, d: a letter key is min(32, (width - 36) / 10) wide (ten keys and nine 4 pt/dp gaps across the width).
    static func keyWidth(available: Double) -> Double {
        let width = (available - 9.0 * gap) / 10.0
        return max(1.0, min(maxKeyWidth, width))
    }
}

/// S60 10 e, h: the outcome tokens this scene adds to the presenter's registry (`guessInvalid` is published on the ack).
enum WordleOutcomePolicy {
    /// `wordSolved` once, on the push where your own board turns solved in the same round.
    static func solved(previous: WordleScene?, next: WordleScene?) -> FeedbackKind {
        guard let before = previous, let after = next else { return FeedbackKind.none }
        if !after.isPlayer || before.round != after.round { return FeedbackKind.none }
        if before.myOutcome != WordleOutcome.solved && after.myOutcome == WordleOutcome.solved { return FeedbackKind.wordSolved }
        return FeedbackKind.none
    }
}

/// G/wordle.ts moves (S60 10 j `GameMoveIntent` types): `guess {word}`, `setWord {word}`, `nextRound` (host). The payload
/// is `GameMoveAdapter`'s `{"word": ...}`; nextRound carries none.
enum WordleIntent {
    static let guessType = "guess"
    static let setWordType = "setWord"
    static let nextRoundType = "nextRound"

    static func guess(_ word: String) -> GameMoveIntent { GameMoveIntent.make(type: guessType, text: word) }
    static func setWord(_ word: String) -> GameMoveIntent { GameMoveIntent.make(type: setWordType, text: word) }
    static func nextRound() -> GameMoveIntent { GameMoveIntent.make(type: nextRoundType) }
}

// MARK: - Wordle fixtures (ACT-4, S60 10 l, L6-12)

/// Debug fixture states for Wordle, layered on the stage fixture exactly like the ACT-2 and ACT-3 game states
/// (`CONCLAVE_STAGE_FIXTURE` / `conclave.stageFixture`; HD requests B7-T7 R4 and R5 hook them into `ActivityFixtureScript`
/// and `StageFixtureState`). No socket, network, audio or capture: module-shaped public and player views (G/wordle.ts),
/// and the shell's commands land in the recording `ActivityFixtureOwner` behind the `game.emits` readout. Players: you
/// plus Avery (r1), Ben (r2) and Cai (r3); you are the seated host unless the state says otherwise. The word is LEMON
/// (CRANE in the final round).
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

    /// Epoch milliseconds as JSON text. Int64, because a transpiled Swift `Int` is a 32-bit Kotlin `Int`.
    static func at(_ offsetMillis: Double) -> String { String(Int64(serverNow + offsetMillis)) }

    // Guesses as G/wordle.ts evaluateGuess marks them against LEMON: SLOTH marks L and O present; LLAMA marks the first L
    // correct, the repeated L absent (the target has one L) and M present; LEMON solves. Against CRANE: SLATE, BRAKE, CRANE.
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

    /// A JSON string, or null for "".
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

    /// The playing view of round 1 of 3 (random word) with `you` standing as given, 2:41 left.
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

    /// The draft the fixture types before it hands over (the draft row shows four typed letters).
    static func draft(_ state: WordleFixtureState) -> String {
        state == WordleFixtureState.guess || state == WordleFixtureState.reconnecting ? "LEMO" : ""
    }

    static func seated(_ state: WordleFixtureState) -> Bool { state != WordleFixtureState.spectator }

    /// The pushes the fixture applies in order: one for most states; the reconnecting state first plays the guess state
    /// (so the draft can be typed) and then the same push while recovering.
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

    /// One random-word playing push for the seated host with `guesses` (module JSON) and `outcome`, for the transition
    /// checks on both platforms (the `wordSolved` token fires once; the draft clears on the recording push).
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

    /// What the stage layer shows for a Wordle state: the game is live under its server name (S20 11 j).
    static func stageInputs(named raw: String, base: StageInputs) -> StageInputs {
        if state(named: raw) == nil { return base }
        let game = ActivityFixtureScript.stageInputs(named: ActivityFixtureState.gameTrivia6.rawValue, base: base)
        return StageFixtureScript.copy(game, isGameActive: true, gameName: "Wordle")
    }

    /// Feeds the activity session for a Wordle state and wires its commands to the recording owner, the way
    /// `ActivityFixtureScript.apply(named:session:owner:)` does for the ACT-2 states. Nil for any other name.
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

// MARK: - Chess scene (ACT-5, S60 11)

// S60 11 j: the chess scene models, built once per push from `ChessProjection` (GameProjections.swift; G/chess.ts
// publicView and playerView) and published inside `GameScene.chess`, so neither platform's board parses anything. The FEN
// is read into 64 squares here, once (the legacy board parsed it per render, GSG:840). Legal moves come only from the
// server projection, deduplicated (the module lists a promotion target once per piece), with flags read from the position
// (promotion, capture, castle, en passant); no legality rule is invented. Your side, role and eligibility come only from
// your own player view while you hold a seat. The selected square, the board flip and the move chooser are view-local;
// the move in flight is `GameStagePresenter.chessPendingMove`. Shared (transpiled): String raw-value enums, scalar
// structs and arrays of structs only. They live in this file because ACT-5 owns this presenter and the two board files.

enum ChessPhase: String, CaseIterable, Equatable {
    case lobby, playing, results
}

enum ChessMode: String, CaseIterable, Equatable {
    case duel, teams, computer
}

/// A side of the board; `none` for no side (watching, no offer, no running clock, the winner of a draw).
enum ChessSide: String, CaseIterable, Equatable {
    case none, white, black
}

/// The status line (S60 11 f): the lobby, your move, the other side to move, or finished. Check is the scene's own
/// `isCheck` flag, so "Your Move" and "Check" show together.
enum ChessStatus: String, CaseIterable, Equatable {
    case waiting, yourMove, toMove, finished
}

/// Your part (S60 11 j): a duel or solo side, a team captain, a team member (the board is read-only) or watching.
enum ChessRole: String, CaseIterable, Equatable {
    case white, black, whiteCaptain, blackCaptain, whiteTeam, blackTeam, watching
}

/// G/chess.ts `ChessResultReason` ("fifty-move" is `fiftyMove`); `none` while the game runs.
enum ChessResultReason: String, CaseIterable, Equatable {
    case none, checkmate, timeout, resignation, stalemate, threefold, insufficient, fiftyMove, agreement
}

enum ChessPieceKind: String, CaseIterable, Equatable {
    case king, queen, rook, bishop, knight, pawn
}

/// The four promotion choices (S60 11 c "Promote To"); the raw value is the module's `promotion` field.
enum ChessPromotion: String, CaseIterable, Equatable {
    case queen = "q", rook = "r", bishop = "b", knight = "n"
}

/// The eligibility-gated actions (S60 11 c, C6-17); the raw value is the module's move type, sent without a payload.
enum ChessAction: String, CaseIterable, Equatable {
    case offerDraw, acceptDraw, declineDraw, requestTakeback, acceptTakeback, declineTakeback, resign
}

/// Why Request Takeback shows disabled (S60 11 i "eligibility reasons when disabled").
enum ChessTakebackReason: String, CaseIterable, Equatable {
    case none, notMoved, pending
}

/// What a board tap does (S60 11 c "tap source then destination is primary").
enum ChessTapAction: String, CaseIterable, Equatable {
    case none, select, deselect, move, promote
}

/// How the move chooser reads a destination (S60 11 c: "f3", "takes on e5"; castling and en passant named too).
enum ChessDestinationKind: String, CaseIterable, Equatable {
    case quiet, capture, enPassant, castle
}

struct ChessSquareModel: Equatable, Identifiable {
    /// Algebraic ("e4"), the stable id of the square on both platforms and in the accessibility tree.
    let id: String
    /// 0 (a) to 7 (h).
    let file: Int
    /// 1 to 8.
    let rank: Int
    /// "wN" (color, then K Q R B N P) or "" for an empty square.
    let piece: String
    let isLight: Bool
    let isLastMove: Bool
    /// The king of the side to move while it is in check.
    let isCheck: Bool
}

struct ChessLegalMoveModel: Equatable, Identifiable {
    /// "e2e4".
    let id: String
    let from: String
    let to: String
    let needsPromotion: Bool
    let isCapture: Bool
    let isCastle: Bool
    let isEnPassant: Bool
}

/// The clocks of one push (S60 11 c): remaining time per side as the server resolved it at `serverNow`, which is the
/// client clock `referenceMillis` (the push's arrival), so the one timer leaf subtracts only the time since then from the
/// running side. `moveDeadlineMillis` is the rapid-fire per-move deadline on the client clock (0 when off).
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
    /// "Low time" under 10 s (S60 11 c): the warning color with its text twin, never a shake.
    static let lowTimeMillis = 10000.0

    /// The side's remaining time at `nowMillis` (client clock); only the running side counts down.
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

    /// Whole seconds shown on a chip, rounded up so "0:01" shows until the flag falls.
    static func wholeSeconds(_ millis: Double) -> Int {
        if millis <= 0 { return 0 }
        return Int((millis / 1000.0).rounded(.up))
    }
}

/// One move-list row (S60 11 c "1. e4 e5"); SAN stays verbatim. `whiteAutoName` and `blackAutoName` name whom the server
/// auto-played for when the rapid-fire timer ran out ("Auto-played for %@"), "" otherwise.
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

/// A draw offer or a takeback request (S60 11 f). `isYourSide` shows "Draw offered" or "Takeback requested"; `canRespond`
/// shows Accept and Decline to the opposing captain only.
struct ChessOfferModel: Equatable {
    let side: ChessSide
    let byName: String
    let isYourSide: Bool
    let canRespond: Bool

    static let none = ChessOfferModel(side: ChessSide.none, byName: "", isYourSide: false, canRespond: false)

    var isActive: Bool { side != ChessSide.none }
}

/// The end of the game (S60 11 g results); `winner` is `none` for a draw.
struct ChessResultModel: Equatable {
    let reason: ChessResultReason
    let winner: ChessSide
    let isDraw: Bool
    let byName: String

    static let none = ChessResultModel(reason: ChessResultReason.none, winner: ChessSide.none, isDraw: false, byName: "")

    var isFinished: Bool { reason != ChessResultReason.none }
}

/// The move in flight as the board draws it (S60 11 f "move pending": the piece at the destination with a pending
/// outline until the ack or the push), or the rejection that restored the position ("Move rejected").
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

/// What a tap on `square` does given the view-local selection: the new selection, or a move to send (or to complete
/// with a promotion choice first).
struct ChessTapOutcome: Equatable {
    let action: ChessTapAction
    let selected: String
    let from: String
    let to: String
}

/// S60 11 j. `squares` holds all 64 squares in FEN order (a8 to h8, then down to a1 to h1); the board maps them to the
/// display order of its orientation (`ChessBoardPolicy.displayOrder`). The pending move and the selection are not here.
struct ChessScene: Equatable {
    let phase: ChessPhase
    let mode: ChessMode
    /// The side at the bottom by default: your side, else White. Watching people flip it locally ("Flip Board").
    let orientation: ChessSide
    let turnSide: ChessSide
    /// Your side while you hold one (also as a team member); `none` when watching.
    let localSide: ChessSide
    let squares: [ChessSquareModel]
    let legalMoves: [ChessLegalMoveModel]
    /// False when the projection carries no legal destinations: the chooser then offers every empty or enemy square and
    /// the server decides (S60R 23).
    let hasProjectedLegalMoves: Bool
    /// The FEN en passant target ("d6") or "".
    let passantSquare: String
    let status: ChessStatus
    let isCheck: Bool
    let role: ChessRole
    let teamWhite: [ChessTeamMemberModel]
    let teamBlack: [ChessTeamMemberModel]
    /// The captain (the one who moves) of each side: a name, the computer's server name, or you.
    let whiteMoverName: String
    let whiteMoverIsYou: Bool
    let blackMoverName: String
    let blackMoverIsYou: Bool
    /// Computer mode with more than one person on the human side ("The room vs the computer").
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
    /// Request Takeback shows for a captain while takebacks are allowed; `canRequestTakeback` enables it and
    /// `takebackReason` says why it is disabled.
    let showsTakeback: Bool
    let canRequestTakeback: Bool
    let takebackReason: ChessTakebackReason
    let canResign: Bool
    /// Watching people may flip the board for themselves (R6-1 `flip_board`).
    let canFlip: Bool
    let isReconnecting: Bool
    let isPlayer: Bool
    let result: ChessResultModel
    let fen: String

    /// One-shot announcement keys (S60 11 h: turn, check and result are announced once); "" when nothing is due.
    var turnKey: String { status == ChessStatus.yourMove ? "chess-turn-" + fen : "" }
    var checkKey: String { isCheck && phase == ChessPhase.playing ? "chess-check-" + fen : "" }
    var resultKey: String { result.isFinished ? "chess-result-" + result.reason.rawValue + "-" + String(plyCount) : "" }

    /// The board is read-only: no move is possible for this person now (team member, watching, reconnecting, waiting).
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

    /// The projected move from `from` to `to`, if any.
    func legalMove(from: String, to: String) -> ChessLegalMoveModel? {
        for move in legalMoves where move.from == from && move.to == to {
            return move
        }
        return nil
    }

    /// The destinations a selected piece can reach: projected moves, or (without them) every empty or enemy square.
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

    /// The target squares of `destinations(from:)`, for the board's dots and rings.
    func targets(from: String) -> [String] {
        var result: [String] = []
        for move in destinations(from: from) {
            result.append(move.to)
        }
        return result
    }

    /// The move from `from` to `to` the person may send (projected, or a candidate square without projected moves).
    func sendableMove(from: String, to: String) -> ChessLegalMoveModel? {
        for move in destinations(from: from) where move.to == to {
            return move
        }
        return nil
    }

    /// Move chooser step one (S60 11 c): your pieces that have a destination, in board order.
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
    /// G/chess.ts CHESS_BOT_ID.
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

    /// Team rows with names (the computer by its server name, "Computer (medium)").
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

    /// "1. e4 e5" rows from the module's move records, with the auto-played names (needs HD request B8-T3 R1 for
    /// `byName` and `isAuto`).
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

/// Board rules both platforms share (S60 11 c, d): square ids, the FEN placement, move flags read from the position, the
/// display order of an orientation (the board never mirrors under RTL, D18), hit testing and the tap state machine.
enum ChessBoardPolicy {
    static let files = "abcdefgh"
    /// The board side caps: a phone card gives about 311 pt/dp (cells about 38); tablets stop at 480; compact height 300.
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

    /// "e4" for file 4, rank 4; "" outside the board.
    static func squareId(file: Int, rank: Int) -> String {
        if file < 0 || file > 7 || rank < 1 || rank > 8 { return "" }
        var position = 0
        for character in files {
            if position == file { return String(character) + String(rank) }
            position += 1
        }
        return ""
    }

    /// The square at a FEN-order index (0 is a8, 63 is h1).
    static func squareId(atIndex index: Int) -> String {
        if index < 0 || index >= squareCount { return "" }
        return squareId(file: index % 8, rank: 8 - index / 8)
    }

    /// The FEN-order index of "e4", or -1.
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

    /// The FEN piece placement as 64 codes in FEN order ("wN", "bp" never: the kind letter is always uppercase); an
    /// unreadable placement is an empty board.
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

    /// One space-separated FEN field (3 is the en passant target, "-" when none).
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

    /// A move's flags from the position alone (no legality is decided here): a pawn reaching the last rank promotes, an
    /// enemy on the target or a diagonal pawn step onto the en passant square captures, a king moving two files castles.
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

    /// The 64 square ids top-left first, row by row: White at the bottom reads a8 to h1; Black at the bottom reads h1 to a8.
    static func displayOrder(_ orientation: ChessSide) -> [String] {
        var order: [String] = []
        var position = 0
        while position < squareCount {
            order.append(squareId(atIndex: orientation == ChessSide.black ? squareCount - 1 - position : position))
            position += 1
        }
        return order
    }

    /// Where a square sits in the display grid (row * 8 + column) for an orientation, or -1.
    static func displayIndex(of id: String, orientation: ChessSide) -> Int {
        let position = index(of: id)
        if position < 0 { return -1 }
        return orientation == ChessSide.black ? squareCount - 1 - position : position
    }

    /// The 64 squares top-left first for an orientation (the canvas and the accessibility overlay read them in this
    /// order): the scene's FEN order for White at the bottom, reversed for Black. No square id is parsed per frame.
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

    /// The orientation the board draws: the scene's (your side, else White), turned around by a watcher's Flip Board.
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

    /// The square under a point of a board `side` points or pixels wide (the canvas tap); "" outside it.
    static func square(atX x: Double, y: Double, side: Double, orientation: ChessSide) -> String {
        if side <= 0 || x < 0 || y < 0 || x >= side || y >= side { return "" }
        let cell = side / 8.0
        let column = min(7, Int(x / cell))
        let row = min(7, Int(y / cell))
        let position = row * 8 + column
        return squareId(atIndex: orientation == ChessSide.black ? squareCount - 1 - position : position)
    }

    /// Tap source, then destination (S60 11 c): your piece with a move selects; the same square deselects; a destination
    /// moves (or asks for the promotion piece first); another piece of yours switches; anything else deselects.
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

    /// Whether `sendChessMove` may send this: a move the person may make, with a promotion choice exactly when needed.
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

    /// The piece the board draws on `square` with the move in flight applied (the mover at its destination, promoted).
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

/// G/chess.ts moves (S60 11 j intents, C6-17): `move {from, to, promotion}` through `GameMoveAdapter`, and the seven
/// payload-free actions by their module type. They travel over the existing native `sendGameMove(type:payloadJSON:
/// requestId:)` path, which already passes any move type through, so the takeback moves need no core change.
enum ChessIntent {
    static let moveType = "move"

    static func move(from: String, to: String, promotion: String) -> GameMoveIntent {
        GameMoveIntent.make(type: moveType, from: from, to: to, promotion: promotion)
    }

    static func action(_ action: ChessAction) -> GameMoveIntent {
        GameMoveIntent.make(type: action.rawValue)
    }
}

// MARK: - Chess fixtures (ACT-5, S60 11 l, L6-12)

/// Debug fixture states for chess, layered on the stage fixture like the Wordle states (`CONCLAVE_STAGE_FIXTURE` /
/// `conclave.stageFixture`; HD requests B8-T3 R5 and R6 hook them into `ActivityFixtureScript` and `StageFixtureState`).
/// No socket, network, audio or capture: module-shaped public and player views whose positions, legal moves and move
/// records come from chess.js 1.4.0, the library G/chess.ts uses (HD/scratch/B8-T3/positions.cjs), and the shell's
/// commands land in the recording `ActivityFixtureOwner` behind the `game.emits` readout. You are the seated host unless
/// the state says otherwise; Avery (r1), Ben (r2) and Cai (r3) are the other players.
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

/// One seated person as the module names them in teams and move records.
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

    // Positions (chess.js 1.4.0 `fen()` after the plies below).
    static let startFen = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1"
    static let openingFen = "r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 2 3"
    static let checkFen = "rnbqkbnr/ppp2ppp/3p4/1B2p3/4P3/5N2/PPPP1PPP/RNBQK2R b KQkq - 1 3"
    static let promotionFen = "rnbq1bnr/pP2kppp/8/4p3/8/8/PPPP1PPP/RNBQKBNR w KQ - 1 5"
    static let takebackFen = "r1bqkbnr/pppp1ppp/2n5/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R b KQkq - 3 3"
    static let kingsPawnFen = "rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2"
    static let knightFen = "rnbqkbnr/pppp1ppp/8/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R b KQkq - 1 2"
    static let specialFen = "rnbqkbnr/1pp1ppp1/7p/p2pP3/2B5/5N2/PPPP1PPP/RNBQK2R w KQkq d6 0 5"
    static let foolsMateFen = "rnb1kbnr/pppp1ppp/8/4p3/6Pq/5P2/PPPPP2P/RNBQKBNR w KQkq - 1 3"

    // Legal moves exactly as G/chess.ts `legalMoves` projects them (a promotion target once per piece).
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

    // The plies (SAN, from, to) that reach each position.
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

    /// Epoch milliseconds as JSON text. Int64, because a transpiled Swift `Int` is a 32-bit Kotlin `Int`.
    static func at(_ offsetMillis: Double) -> String { String(Int64(serverNow + offsetMillis)) }

    static func text(_ value: String) -> String { value.isEmpty ? "null" : GameMoveAdapter.quoted(value) }

    static func flag(_ value: Bool) -> String { value ? "true" : "false" }

    static func member(_ seat: ChessFixtureSeat, captain: Bool) -> String {
        "{\"id\":" + text(seat.id) + ",\"name\":" + text(seat.name) + ",\"captain\":" + flag(captain) + "}"
    }

    /// The module's move records: White moves the even plies, Black the odd ones; `autoPly` was auto-played (rapid fire).
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

    /// G/chess.ts publicView with the fields the native scene reads.
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

    /// G/chess.ts playerView.
    static func playerView(side: String, role: String, canMove: Bool, canResign: Bool, canOfferDraw: Bool, canRespondToDraw: Bool,
                           canRequestTakeback: Bool, canRespondToTakeback: Bool) -> String {
        var json = "{\"side\":" + text(side) + ",\"role\":" + text(role) + ",\"canMove\":" + flag(canMove)
        json += ",\"canResign\":" + flag(canResign) + ",\"canOfferDraw\":" + flag(canOfferDraw)
        json += ",\"canRespondToDraw\":" + flag(canRespondToDraw) + ",\"canRequestTakeback\":" + flag(canRequestTakeback)
        json += ",\"canRespondToTakeback\":" + flag(canRespondToTakeback) + "}"
        return json
    }

    /// A duel public view between `white` and `black` (5 + 3, takebacks on): the common shape of most states.
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

    /// One push for `state`: you hold a seat (except watching) and host (except watching and the participant's draw).
    static func push(_ state: ChessFixtureState, isRecovering: Bool) -> GameStageInputs {
        let seated = state != ChessFixtureState.spectator
        return GameStageInputs.make(callSession: 1, isActive: true, gameId: "chess", name: "Chess",
                                    phase: isFinished(state) ? "results" : "playing", players: players(state),
                                    isFinished: isFinished(state), minPlayers: 1, publicViewJSON: publicView(state),
                                    playerViewJSON: playerView(state), localPlayerId: seated ? ActivityFixtureScript.localUserId : "",
                                    isHost: seated && state != ChessFixtureState.drawAgreed, isRecovering: isRecovering,
                                    receivedAtMillis: Date().timeIntervalSince1970 * 1000.0)
    }

    /// The pushes the fixture applies in order: one for most states; the reconnecting state first plays your move and
    /// then the same push while recovering (the board turns read-only until the snapshot).
    static func pushes(_ state: ChessFixtureState) -> [GameStageInputs] {
        if state == ChessFixtureState.reconnecting {
            return [push(ChessFixtureState.yourMove, isRecovering: false), push(state, isRecovering: true)]
        }
        return [push(state, isRecovering: false)]
    }

    /// A playing duel push after `san` plies at `fen` (you White against Avery), for the transition checks on both
    /// platforms (the recording push that clears the overlay, the start position without a move).
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

    /// What the stage layer shows for a chess state: the game is live under its server name (S20 11 j).
    static func stageInputs(named raw: String, base: StageInputs) -> StageInputs {
        if state(named: raw) == nil { return base }
        let game = ActivityFixtureScript.stageInputs(named: ActivityFixtureState.gameTrivia6.rawValue, base: base)
        return StageFixtureScript.copy(game, isGameActive: true, gameName: "Chess")
    }

    /// Feeds the activity session for a chess state and wires its commands to the recording owner, the way
    /// `WordleFixtures.apply(named:session:owner:)` does. Nil for any other name.
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
