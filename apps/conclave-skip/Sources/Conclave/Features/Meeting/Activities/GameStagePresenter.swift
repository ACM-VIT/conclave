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
            } else if failure == GameFailure.notAccepted || ackedType == "submit" {
                // A rejected bluff ("That is the real answer. Write a bluff.") is the S60 9 h rejection outcome too; R12
                // names this presenter's rejection token `moveRejected` (S1 alone publishes `actionRejected`).
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
        let outcomes = [PromptOutcomePolicy.trivia(previous: scene.trivia, next: trivia),
                        PromptOutcomePolicy.reaction(previous: scene.reaction, next: reaction),
                        WordleOutcomePolicy.solved(previous: scene.wordle, next: wordle)]
        let nextScene = GameScene(revision: scene.revision, kind: sceneKind(phase: phase, isSeated: isSeated), players: players,
                                  pendingJoiners: pending, options: GameStagePresenter.optionSummary(config: inputs.config, options: inputs.options),
                                  lobby: lobby, projection: projection, trivia: trivia, bluff: bluff, wouldYouRather: wouldYouRather,
                                  mostLikelyTo: mostLikelyTo, reaction: reaction, imposter: imposter, wordle: wordle)
        if nextScene != scene { scene = nextScene.withRevision(scene.revision + 1) }
        syncWordleDraft(wordle)
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
