#if !SKIP
import Foundation
import Testing
@testable import Conclave

@MainActor
struct ACT2GameShellTests {
    private final class Recorder {
        var commands: [GameStageCommand] = []
    }

    private func presenter(_ inputs: GameStageInputs, recorder: Recorder? = nil) -> GameStagePresenter {
        let games = GameStagePresenter()
        games.sleep = { _ in try? await Task.sleep(nanoseconds: 60_000_000_000) }
        if let recorder = recorder {
            games.onCommand = { command in recorder.commands.append(command) }
        }
        games.apply(inputs)
        return games
    }

    private func players(_ ids: [String]) -> [GamePlayerInput] {
        var result: [GamePlayerInput] = []
        for id in ids { result.append(GamePlayerInput(id: id, name: id.uppercased())) }
        return result
    }

    private func trivia(phase: String = "question", view: String, mine: String = "", localId: String = "a", selfId: String = "",
                        ids: [String] = ["a", "b", "c"], receivedAt: Double = 1700000005000) -> GameStageInputs {
        GameStageInputs.make(callSession: 1, isActive: true, gameId: "trivia", name: "Trivia", phase: phase, players: players(ids),
                             minPlayers: 1, publicViewJSON: view, playerViewJSON: mine, selfId: selfId, localPlayerId: localId,
                             isHost: true, receivedAtMillis: receivedAt)
    }

    static let triviaQuestion = #"{"phase":"question","questionIndex":1,"totalQuestions":5,"serverNow":1700000000000,"deadline":1700000020000,"questionDurationMs":20000,"category":"Science","prompt":"Which planet has the most moons?","options":["Jupiter","Saturn","Neptune","Uranus"],"correctIndex":null,"optionCounts":[],"answeredCount":1,"totalPlayers":3,"scoreboard":[{"id":"b","name":"B","score":900},{"id":"a","name":"A","score":900},{"id":"c","name":"C","score":100}],"tiles":{"b":{"acted":true}}}"#
    static let triviaReveal = #"{"phase":"reveal","questionIndex":1,"totalQuestions":5,"serverNow":1700000021000,"deadline":1700000026000,"category":"Science","prompt":"Which planet has the most moons?","options":["Jupiter","Saturn","Neptune","Uranus"],"correctIndex":1,"optionCounts":[1,2,0,0],"answeredCount":3,"totalPlayers":3,"scoreboard":[],"tiles":{}}"#
    static let triviaMine = #"{"answered":true,"choice":0,"score":900,"rank":2,"lastRoundPoints":0,"correct":false}"#
    static let bluffChoose = #"{"phase":"choose","round":0,"totalRounds":3,"serverNow":1,"deadline":2,"question":"The capital of ___ is Canberra","submittedCount":3,"chosenCount":1,"totalPlayers":3,"options":[{"id":"o1","text":"Australia"},{"id":"o2","text":"Austria"}],"roundPoints":[],"scoreboard":[]}"#
    static let bluffMine = #"{"yourFake":"Austria","submitted":true,"yourPick":null,"ownOptionId":"o2","score":0}"#
    static let wyrReveal = #"{"phase":"reveal","index":0,"total":5,"serverNow":1,"deadline":null,"optionA":"Fly","optionB":"Swim","counts":[2,1],"answeredCount":3,"totalPlayers":3,"namesA":["A","B"],"namesB":["C"]}"#
    static let mltVote = #"{"phase":"vote","index":2,"total":5,"serverNow":1,"deadline":2,"prompt":"to be late","players":[{"id":"a","name":"A"},{"id":"b","name":"B"}],"counts":{},"votedPlayerIds":["b"],"answeredCount":1,"totalPlayers":2,"winnerId":null,"winnerName":null}"#
    static let reactionReveal = #"{"phase":"reveal","round":1,"totalRounds":5,"serverNow":1,"goAt":null,"tappedCount":2,"totalPlayers":2,"results":[{"id":"a","name":"A","reactionMs":312,"early":false},{"id":"b","name":"B","reactionMs":null,"early":true}],"winnerName":"A","scoreboard":[{"id":"a","name":"A","score":1}]}"#
    static let imposterDiscuss = #"{"phase":"discuss","category":"Places","serverNow":1,"deadline":null,"starterName":"B","players":[{"id":"a","name":"A"},{"id":"b","name":"B"},{"id":"c","name":"C"}],"votedPlayerIds":[],"voteCounts":{},"totalPlayers":3,"result":null}"#
    static let imposterCrew = #"{"role":"crew","category":"Places","word":"Library","hint":null,"yourVote":null}"#
    static let imposterImposter = #"{"role":"imposter","category":"Places","word":null,"hint":"You don't know the word.","yourVote":null}"#
    static let wordlePlaying = #"{"phase":"playing","wordSource":"setter","setterId":"s","setterName":"S","serverNow":1,"deadline":2,"timeLimitMs":180000,"wordLength":5,"maxTries":6,"standings":[{"playerId":"a","playerName":"A","triesUsed":2,"outcome":null}],"finishedCount":0,"totalContestants":1,"currentRound":1,"totalRounds":3,"isFinalRound":false,"scores":[{"playerId":"a","playerName":"A","score":0}],"result":null}"#
    static let wordleSetter = #"{"currentRound":1,"isSetter":true,"canSetWord":false,"canGuess":false,"secretWord":"CRANE","myGuesses":[],"myOutcome":null,"boards":[{"playerId":"a","guesses":[{"word":"SLATE","feedback":["gray","gray","green","gray","green"],"at":1}],"outcome":null}]}"#
    static let wordleContestant = #"{"currentRound":1,"isSetter":false,"canSetWord":false,"canGuess":true,"secretWord":null,"myGuesses":[{"word":"SLATE","feedback":["gray","gray","green","gray","green"],"at":1}],"myOutcome":null,"boards":null}"#
    static let chessPlaying = #"{"phase":"playing","mode":"duel","serverNow":1,"timeControlMs":600000,"incrementMs":0,"moveTimeMs":null,"allowTakebacks":true,"bot":null,"clocks":{"white":590000,"black":600000},"fen":"rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1","pgn":"1. e4","turn":"b","turnSide":"black","turnStartedAt":1,"inCheck":false,"legalMoves":{"e7":["e6","e5"],"g8":["f6","h6"]},"teams":{"white":[{"id":"a","name":"A","captain":true}],"black":[{"id":"b","name":"B","captain":true}]},"captains":{"white":"a","black":"b"},"moves":[{"san":"e4","from":"e2","to":"e4","color":"w","promotion":null,"byPlayerId":"a"}],"drawOffer":null,"takebackRequest":null,"result":null,"startedAt":1,"finishedAt":null}"#
    static let chessMine = #"{"side":"black","role":"captain","canMove":true,"canResign":true,"canOfferDraw":true,"canRespondToDraw":false,"canRequestTakeback":false,"canRespondToTakeback":false}"#
    static let zipPlaying = #"{"phase":"playing","gridSize":6,"anchors":{"0":1,"35":2},"barriers":[{"from":1,"to":2}],"deadCells":[7],"serverNow":1700000000000,"roundStartedAt":1699999990000,"roundEndsAt":1700000170000,"standings":[{"playerId":"a","playerName":"A","cellsFilled":4,"totalCells":35,"outcome":null,"hintsUsed":0,"solvedAt":null}],"finishedCount":0,"totalPlayers":1,"currentRound":1,"totalRounds":3,"isFinalRound":false,"scores":[],"scoreboard":[{"id":"a","name":"A","score":0}],"result":null}"#
    static let zipMine = #"{"path":[0,1,2,3],"outcome":null,"solvedAt":null,"hintsUsed":0,"hintAvailableAt":1700000030000,"mistakes":1}"#

    @Test func triviaProjectsPublicAndPrivateViewsOnce() throws {
        let projection = GameProjectionParser.parse(gameId: "trivia", publicPhase: "question", publicViewJSON: Self.triviaQuestion,
                                                    playerViewJSON: Self.triviaMine)
        let trivia = try #require(projection.trivia)
        #expect(projection.kind == GameSceneKind.trivia && projection.isKnownGame && projection.hasPlayerView)
        #expect(trivia.prompt == "Which planet has the most moons?")
        #expect(trivia.options == ["Jupiter", "Saturn", "Neptune", "Uranus"])
        #expect(trivia.correctIndex == -1)
        #expect(trivia.hasAnswered && trivia.myChoice == 0 && trivia.score == 900 && trivia.rank == 2)
        #expect(trivia.outcome == "wrong")
        let common = projection.common
        #expect(common.roundNumber == 2 && common.roundTotal == 5)
        #expect(common.deadlineMillis == 1700000020000 && common.durationMillis == 20000)
        #expect(common.actedPlayerIds == ["b"] && common.actedCount == 1 && common.totalPlayers == 3)
        #expect(common.scoreboard.map { $0.id } == ["b", "a", "c"])
        #expect(projection.bluff == nil && projection.chess == nil)
        let reveal = try #require(GameProjectionParser.parse(gameId: "trivia", publicPhase: "reveal", publicViewJSON: Self.triviaReveal,
                                                             playerViewJSON: "").trivia)
        #expect(reveal.correctIndex == 1 && reveal.optionCounts == [1, 2, 0, 0])
        #expect(reveal.outcome.isEmpty && reveal.myChoice == -1)
    }

    @Test func promptGameProjectionsMatchTheModules() throws {
        let bluff = try #require(GameProjectionParser.parse(gameId: "bluff", publicPhase: "choose", publicViewJSON: Self.bluffChoose,
                                                            playerViewJSON: Self.bluffMine).bluff)
        #expect(bluff.options.map { $0.id } == ["o1", "o2"])
        #expect(bluff.options.allSatisfy { $0.kind.isEmpty && $0.ownerName.isEmpty })
        #expect(bluff.yourFake == "Austria" && bluff.hasSubmitted && bluff.ownOptionId == "o2" && bluff.yourPick.isEmpty)
        let wyr = try #require(GameProjectionParser.parse(gameId: "would-you-rather", publicPhase: "reveal", publicViewJSON: Self.wyrReveal,
                                                          playerViewJSON: #"{"choice":1}"#).wouldYouRather)
        #expect(wyr.countA == 2 && wyr.countB == 1 && wyr.namesA == ["A", "B"] && wyr.myChoice == 1)
        let mlt = GameProjectionParser.parse(gameId: "most-likely-to", publicPhase: "vote", publicViewJSON: Self.mltVote,
                                             playerViewJSON: #"{"yourVote":"b"}"#)
        #expect(mlt.mostLikelyTo?.yourVote == "b" && mlt.mostLikelyTo?.winnerName == "")
        #expect(mlt.common.actedPlayerIds == ["b"] && mlt.common.roundNumber == 3)
        let reaction = try #require(GameProjectionParser.parse(gameId: "reaction", publicPhase: "reveal", publicViewJSON: Self.reactionReveal,
                                                               playerViewJSON: #"{"tapped":true,"early":false,"reactionMs":312,"score":1}"#).reaction)
        #expect(reaction.results.map { $0.reactionMs } == [312, -1])
        #expect(reaction.results.last?.isEarly == true)
        #expect(reaction.winnerName == "A" && reaction.reactionMs == 312)
    }

    @Test func imposterPrivateWordReachesOnlyTheCrewView() throws {
        let crew = try #require(GameProjectionParser.parse(gameId: "imposter", publicPhase: "discuss", publicViewJSON: Self.imposterDiscuss,
                                                           playerViewJSON: Self.imposterCrew).imposter)
        #expect(crew.role == "crew" && crew.secretWord == "Library")
        let imposter = try #require(GameProjectionParser.parse(gameId: "imposter", publicPhase: "discuss", publicViewJSON: Self.imposterDiscuss,
                                                               playerViewJSON: Self.imposterImposter).imposter)
        #expect(imposter.role == "imposter" && imposter.secretWord.isEmpty)

        let spectator = try #require(GameProjectionParser.parse(gameId: "imposter", publicPhase: "discuss",
                                                                publicViewJSON: Self.imposterDiscuss, playerViewJSON: "").imposter)
        #expect(spectator.role.isEmpty && spectator.secretWord.isEmpty && spectator.resultWord.isEmpty)
        #expect(!Self.imposterDiscuss.contains("Library"))
    }

    @Test func boardGameProjectionsMatchTheModules() throws {
        let setter = try #require(GameProjectionParser.parse(gameId: "wordle", publicPhase: "playing", publicViewJSON: Self.wordlePlaying,
                                                             playerViewJSON: Self.wordleSetter).wordle)
        #expect(setter.isSetter && setter.secretWord == "CRANE" && setter.boards.count == 1)
        #expect(setter.boards.first?.guesses.first?.feedback == ["gray", "gray", "green", "gray", "green"])
        let contestant = try #require(GameProjectionParser.parse(gameId: "wordle", publicPhase: "playing", publicViewJSON: Self.wordlePlaying,
                                                                 playerViewJSON: Self.wordleContestant).wordle)
        #expect(!contestant.isSetter && contestant.secretWord.isEmpty && contestant.boards.isEmpty && contestant.canGuess)
        #expect(contestant.myGuesses.first?.word == "SLATE")
        let wordleCommon = GameProjectionParser.parse(gameId: "wordle", publicPhase: "playing", publicViewJSON: Self.wordlePlaying,
                                                      playerViewJSON: "").common
        #expect(wordleCommon.roundNumber == 1 && wordleCommon.roundTotal == 3 && wordleCommon.totalPlayers == 1)
        let chess = try #require(GameProjectionParser.parse(gameId: "chess", publicPhase: "playing", publicViewJSON: Self.chessPlaying,
                                                            playerViewJSON: Self.chessMine).chess)
        #expect(chess.turnSide == "black" && chess.whiteClockMillis == 590000 && chess.moveTimeMillis == 0)
        #expect(chess.legalMoves.map { $0.id } == ["e7", "g8"] && chess.legalMoves.first?.targets == ["e6", "e5"])
        #expect(chess.whiteTeam.first?.isCaptain == true && chess.moves.first?.san == "e4" && chess.moves.first?.promotion == "")
        #expect(chess.side == "black" && chess.canMove && !chess.canRequestTakeback && chess.botName.isEmpty)
        let zip = GameProjectionParser.parse(gameId: "zip", publicPhase: "playing", publicViewJSON: Self.zipPlaying, playerViewJSON: Self.zipMine)
        let board = try #require(zip.zip)
        #expect(board.gridSize == 6 && board.anchors == [GameCountEntry(key: "0", count: 1), GameCountEntry(key: "35", count: 2)])
        #expect(board.barriers == [ZipBarrierProjection(from: 1, to: 2)] && board.deadCells == [7])
        #expect(board.path == [0, 1, 2, 3] && board.mistakes == 1)
        #expect(zip.common.deadlineMillis == 1700000170000 && zip.common.durationMillis == 180000)
    }

    @Test func anUnknownGameIsUnsupportedAndInvalidJSONIsEmpty() {
        let unknown = GameProjectionParser.parse(gameId: "pictionary", publicPhase: "drawing", publicViewJSON: #"{"phase":"drawing"}"#,
                                                 playerViewJSON: "")
        #expect(!unknown.isKnownGame && unknown.kind == GameSceneKind.unsupported && unknown.common.phase == "drawing")
        let broken = GameProjectionParser.parse(gameId: "trivia", publicPhase: "lobby", publicViewJSON: "{not json", playerViewJSON: "null")
        #expect(broken.common.phase == "lobby" && !broken.hasPlayerView && broken.trivia?.options == [])
    }

    @Test func eachPushIsParsedOnceAndAnEqualPushNotAtAll() {
        let games = presenter(trivia(view: Self.triviaQuestion, mine: Self.triviaMine))
        #expect(games.parseCount == 1)
        games.apply(trivia(view: Self.triviaQuestion, mine: Self.triviaMine))
        #expect(games.parseCount == 1)
        games.apply(trivia(phase: "reveal", view: Self.triviaReveal, mine: Self.triviaMine))
        #expect(games.parseCount == 2)
    }

    @Test func theServerSelfIdWinsOverTheLocalRule() {
        let games = presenter(trivia(view: Self.triviaQuestion, localId: "a", selfId: "b"))
        #expect(games.scene.players.first { $0.isYou }?.id == "b")
        #expect(games.results.scoreboard.first { $0.isYou }?.id == "b")
        #expect(games.chrome.seat == SeatState.player)
    }

    @Test func aPushNeverClearsAPendingMoveOnlyItsAckOrTheTimeout() throws {
        let recorder = Recorder()
        let games = presenter(trivia(view: Self.triviaQuestion, mine: Self.triviaMine), recorder: recorder)
        #expect(games.send(GameMoveIntent.answer(1)) == ActivityTapResult.dispatched)
        let command = try #require(recorder.commands.last)
        #expect(command.kind == GameStageCommandKind.move && command.type == "answer" && command.payloadJSON == #"{"choice":1}"#)
        #expect(games.interaction.pendingRequestId == command.requestId && games.interaction.pendingType == "answer")
        #expect(games.hasLiveTimeout)

        games.apply(trivia(view: Self.triviaQuestion.replacingOccurrences(of: "\"answeredCount\":1", with: "\"answeredCount\":2"),
                           mine: Self.triviaMine))
        #expect(games.interaction.isPending)
        #expect(games.send(GameMoveIntent.answer(2)) == ActivityTapResult.ignored)
        games.moveAcknowledged(requestId: "someone-else", success: true, serverText: "")
        #expect(games.interaction.isPending)
        games.moveAcknowledged(requestId: command.requestId, success: true, serverText: "")
        #expect(!games.interaction.isPending && games.interaction.failure == GameFailure.none)
        #expect(!games.hasLiveTimeout)

        _ = games.send(GameMoveIntent.answer(3))
        let second = try #require(recorder.commands.last)
        games.fireTimeout(requestId: second.requestId)
        #expect(!games.interaction.isPending && games.interaction.failure == GameFailure.server && games.interaction.failureServerText.isEmpty)
    }

    @Test func rejectionsMapToTypedFailuresAndClearOnTheNextPush() throws {
        let recorder = Recorder()
        let games = presenter(trivia(view: Self.triviaQuestion), recorder: recorder)
        _ = games.send(GameMoveIntent.answer(0))
        games.moveAcknowledged(requestId: try #require(recorder.commands.last).requestId, success: false, serverText: "Too many moves")
        #expect(games.interaction.failure == GameFailure.slowDown)
        _ = games.send(GameMoveIntent.answer(0))
        let feedbackBefore = games.feedbackState.token.sequence
        games.moveAcknowledged(requestId: try #require(recorder.commands.last).requestId, success: false, serverText: "Invalid move")
        #expect(games.interaction.failure == GameFailure.notAccepted)
        #expect(games.feedbackState.token.kind == FeedbackKind.moveRejected && games.feedbackState.token.sequence == feedbackBefore + 1)
        _ = games.send(GameMoveIntent.answer(0))
        games.moveAcknowledged(requestId: try #require(recorder.commands.last).requestId, success: false, serverText: "Answers are closed")
        #expect(games.interaction.failure == GameFailure.server && games.interaction.failureServerText == "Answers are closed")
        games.apply(trivia(phase: "reveal", view: Self.triviaReveal))
        #expect(games.interaction.failure == GameFailure.none)
    }

    @Test func failureStringsMapExplicitly() {
        #expect(GameFailurePolicy.failure(serverText: "Too many moves") == GameFailure.slowDown)
        #expect(GameFailurePolicy.failure(serverText: "No active game") == GameFailure.movedOn)
        #expect(GameFailurePolicy.failure(serverText: "Watch-only attendees cannot play") == GameFailure.notSeated)
        #expect(GameFailurePolicy.failure(serverText: "Game is full") == GameFailure.full)
        #expect(GameFailurePolicy.failure(serverText: "Invalid move") == GameFailure.notAccepted)
        #expect(GameFailurePolicy.failure(serverText: "That's the real answer. Write a bluff.") == GameFailure.server)
    }

    @Test func aMoveTouchesInteractionNeverTheChrome() throws {
        let recorder = Recorder()
        let games = presenter(trivia(view: Self.triviaQuestion), recorder: recorder)
        let chrome = games.chrome.revision
        let scene = games.scene.revision
        let interaction = games.interaction.revision
        _ = games.send(GameMoveIntent.answer(1))
        #expect(games.chrome.revision == chrome && games.scene.revision == scene)
        #expect(games.interaction.revision == interaction + 1)
        games.moveAcknowledged(requestId: try #require(recorder.commands.last).requestId, success: true, serverText: "")
        #expect(games.chrome.revision == chrome)
    }

    @Test func theCountdownUsesTheServerClockOffset() throws {

        let games = presenter(trivia(view: Self.triviaQuestion, receivedAt: 1700000005000))
        let countdown = try #require(games.countdown)
        #expect(countdown.serverOffsetMillis == 5000)
        #expect(countdown.secondsLeft(nowMillis: 1700000005000) == 20)
        #expect(countdown.secondsLeft(nowMillis: 1700000024500) == 1)
        #expect(countdown.secondsLeft(nowMillis: 1700000030000) == 0)
        #expect(abs(countdown.fractionLeft(nowMillis: 1700000015000) - 0.5) < 0.0001)
        #expect(CountdownModel.announcedSeconds == [10, 5] && CountdownModel.warningSeconds == 5)
        games.apply(trivia(phase: "results", view: #"{"phase":"results","deadline":null,"scoreboard":[]}"#))
        #expect(games.countdown == nil)
    }

    @Test func lobbyRulesFollowTheFixtures() {
        let host = GameStagePresenter()
        host.apply(ActivityFixtureScript.gameInputs(.gameLobbyHost))
        #expect(host.chrome.phase == GameChromePhase.lobby && host.scene.kind == GameSceneKind.lobby)
        #expect(host.scene.lobby.canStart && host.scene.lobby.reason == GameLobbyReason.none)
        #expect(host.scene.pendingJoiners.map { $0.name } == ["Dee"] && host.chrome.pendingCount == 1)
        #expect(host.scene.options.map { $0.label + "=" + $0.value } == ["Questions=7", "Pace=Normal"])
        let unseated = GameStagePresenter()
        unseated.apply(ActivityFixtureScript.gameInputs(.gameLobbyHostUnseated))
        #expect(unseated.scene.lobby.reason == GameLobbyReason.joinToStart && unseated.scene.lobby.showsJoin)
        #expect(unseated.chrome.seat == SeatState.canJoin)
        let imposter = GameStagePresenter()
        imposter.apply(ActivityFixtureScript.gameInputs(.gameLobbyImposter2))
        #expect(!imposter.scene.lobby.canStart && imposter.scene.lobby.reason == GameLobbyReason.needsPlayers)
        #expect(imposter.scene.lobby.minPlayers == 3)
    }

    @Test func seatsPrivateViewsAndUnsupportedGames() {
        #expect(GameStagePresenter.seat(isSeated: false, isQueued: true, canJoinLate: true, isFinished: false) == SeatState.joiningNextRound)
        #expect(GameStagePresenter.seat(isSeated: false, isQueued: false, canJoinLate: false, isFinished: false) == SeatState.watching)
        #expect(GameStagePresenter.seat(isSeated: false, isQueued: false, canJoinLate: true, isFinished: true) == SeatState.watching)
        let loading = GameStagePresenter()
        loading.apply(ActivityFixtureScript.gameInputs(.gamePrivateLoading))
        #expect(loading.scene.kind == GameSceneKind.privateView)
        let spectator = GameStagePresenter()
        spectator.apply(ActivityFixtureScript.gameInputs(.gameSpectator))
        #expect(spectator.chrome.seat == SeatState.canJoin && spectator.scene.kind == GameSceneKind.trivia)
        #expect(spectator.send(GameMoveIntent.answer(0)) == ActivityTapResult.explained)
        let unknown = GameStagePresenter()
        unknown.apply(ActivityFixtureScript.gameInputs(.gameUnsupported))
        #expect(unknown.chrome.phase == GameChromePhase.unsupported && !unknown.chrome.isKnownGame)
        #expect(unknown.scene.kind == GameSceneKind.unsupported && unknown.chrome.canEnd)
    }

    @Test func resultsRankTiesAndOfferRematchToTheHost() throws {
        let common = GameCommonProjection(phase: "results", serverNowMillis: 0, deadlineMillis: 0, durationMillis: 0, roundNumber: 0,
                                          roundTotal: 0, actedCount: 0, totalPlayers: 3, actedPlayerIds: [],
                                          scoreboard: [GameScoreEntry(id: "a", name: "A", score: 2400), GameScoreEntry(id: "b", name: "B", score: 1900),
                                                       GameScoreEntry(id: "c", name: "C", score: 1900)], winnerName: "")
        let results = GameStagePresenter.results(common: common, localId: "b", isFinished: true, canRematch: true, rematchPending: false, revision: 0)
        #expect(results.scoreboard.map { $0.rank } == [1, 2, 2])
        #expect(results.winnerName == "A" && results.winnerScore == 2400 && !results.isTie)
        try #require(results.scoreboard.count >= 2)
        #expect(results.scoreboard.first?.isLeader == true && results.scoreboard[1].isYou)
        let tied = GameCommonProjection(phase: "results", serverNowMillis: 0, deadlineMillis: 0, durationMillis: 0, roundNumber: 0,
                                        roundTotal: 0, actedCount: 0, totalPlayers: 2, actedPlayerIds: [],
                                        scoreboard: [GameScoreEntry(id: "a", name: "A", score: 5), GameScoreEntry(id: "b", name: "B", score: 5)],
                                        winnerName: "")
        #expect(GameStagePresenter.results(common: tied, localId: "", isFinished: true, canRematch: false, rematchPending: false, revision: 0).isTie)
        let games = GameStagePresenter()
        games.apply(ActivityFixtureScript.gameInputs(.gameResults))
        #expect(games.chrome.phase == GameChromePhase.results && games.results.canRematch)
        games.rematch()
        games.rematch()
        #expect(games.results.rematchPending)
        #expect(games.emitLog.filter { $0 == "rematch" }.count == 1)
    }

    @Test func endIsOneCommandAndAFailureShowsInTheChrome() {
        let recorder = Recorder()
        let games = presenter(ActivityFixtureScript.gameInputs(.gameTrivia6), recorder: recorder)
        games.requestEnd()
        games.requestEnd()
        #expect(recorder.commands.filter { $0.kind == GameStageCommandKind.end }.count == 1)
        #expect(games.chrome.endPending)
        games.endFailed(serverText: "")
        #expect(!games.chrome.endPending && games.chrome.endFailed)
        games.dismissFailure()
        #expect(!games.chrome.endFailed)
    }

    @Test func summaryFeedsTheLauncherWithoutTheProjection() {
        let games = GameStagePresenter()
        games.apply(ActivityFixtureScript.gameInputs(.gameTrivia6))
        let summary = games.summary()
        #expect(summary.gameId == "trivia" && summary.isActive && !summary.isFinished)
        #expect(summary.round == 3 && summary.roundTotal == 7 && summary.playerCount == 6)
        games.reset()
        #expect(games.summary() == ActivityGameSummary.none && !games.hasLiveTimeout)
    }

    @Test func movePayloadsAreEachModulesValidatedShape() {
        #expect(GameMoveAdapter.payloadJSON(GameMoveIntent.answer(2)) == #"{"choice":2}"#)
        #expect(GameMoveAdapter.payloadJSON(GameMoveIntent.submitBluff("Vienna \"really\"")) == #"{"text":"Vienna \"really\""}"#)
        #expect(GameMoveAdapter.payloadJSON(GameMoveIntent.chooseBluff("o2")) == #"{"optionId":"o2"}"#)
        #expect(GameMoveAdapter.payloadJSON(GameMoveIntent.choose(1)) == #"{"option":1}"#)
        #expect(GameMoveAdapter.payloadJSON(GameMoveIntent.vote("u-1")) == #"{"target":"u-1"}"#)
        #expect(GameMoveAdapter.payloadJSON(GameMoveIntent.make(type: "guess", text: "CRANE")) == #"{"word":"CRANE"}"#)
        #expect(GameMoveAdapter.payloadJSON(GameMoveIntent.make(type: "move", from: "e7", to: "e8", promotion: "q")) ==
                #"{"from":"e7","to":"e8","promotion":"q"}"#)
        #expect(GameMoveAdapter.payloadJSON(GameMoveIntent.make(type: "move", cells: [0, 1, 7])) == #"{"cells":[0,1,7]}"#)
        #expect(GameMoveAdapter.payloadJSON(GameMoveIntent.start()).isEmpty && GameMoveAdapter.payloadJSON(GameMoveIntent.tap()).isEmpty)
        #expect(GameMoveAdapter.quoted("a\\b\nc") == #""a\\b\nc""#)
    }

    @Test func everyGameEnumCaseHasCopyOnBothPlatforms() throws {
        let ios = try stageSource("Sources/Conclave/Features/Meeting/Activities/GameCopy+iOS.swift")
        let kotlin = try stageSource("Sources/Conclave/Skip/ui/copy/GameCopy.kt")
        for value in GameFailure.allCases { #expect(ios.contains("." + value.rawValue) && kotlin.contains("GameFailure." + value.rawValue), "\(value)") }
        for value in SeatState.allCases { #expect(ios.contains("." + value.rawValue) && kotlin.contains("SeatState." + value.rawValue), "\(value)") }
        for value in GameLobbyReason.allCases { #expect(ios.contains("." + value.rawValue) && kotlin.contains("GameLobbyReason." + value.rawValue), "\(value)") }
        for value in GameKitNoticeKind.allCases { #expect(ios.contains("." + value.rawValue) && kotlin.contains("GameKitNoticeKind." + value.rawValue), "\(value)") }
        for value in GameChromePhase.allCases { #expect(ios.contains("." + value.rawValue) && kotlin.contains("GameChromePhase." + value.rawValue), "\(value)") }
    }

    @Test func kitK1ToK13ExistOnBothPlatformsWithTheirPlatformRules() throws {
        var ios = ""
        for file in try stageFiles(under: "Sources/Conclave/Features/Meeting/Games/Native", extensions: ["swift"]) { ios += try stageSource(file) }
        var kotlin = ""
        for file in try stageFiles(under: "Sources/Conclave/Skip/ui/games", extensions: ["kt"]) { kotlin += try stageSource(file) }
        let kit = ["GameKitPrompt", "GameKitCountdown", "GameKitChoiceList", "GameKitBinaryChoice", "GameKitSplitResult",
                   "GameKitPlayerChips", "GameKitHostBar", "GameKitScoreboard", "GameKitRoundResults", "GameKitTextEntry",
                   "GameKitSecretCard", "GameKitSeatControl", "GameKitNotice"]
        #expect(kit.count == 13)
        for name in kit {
            #expect(ios.contains("struct " + name + ": View"), "iOS kit misses \(name)")
            #expect(kotlin.contains("internal fun " + name + "("), "Android kit misses \(name)")
        }
        let flatIOS = stageNormalized(ios)
        let flatKotlin = stageNormalized(kotlin)

        #expect(flatIOS.contains("TimelineView(.periodic(from: .now, by: 1))") && flatIOS.contains("if scenePhase == .active"))
        #expect(flatKotlin.contains("lifecycle.repeatOnLifecycle(Lifecycle.State.STARTED)"))
        #expect(flatKotlin.contains("LinearProgressIndicator( progress = { fraction }"))

        #expect(flatIOS.contains("DragGesture(minimumDistance: 0).updating($isHeld)") && !ios.contains("onLongPressGesture"))
        #expect(flatIOS.contains(".accessibilityAction(named: Text(ConclaveStrings.text(\"Reveal Word\")))"))
        #expect(flatKotlin.contains(".pointerInput(enabled)") && flatKotlin.contains("tryAwaitRelease()"))
        #expect(flatKotlin.contains("CustomAccessibilityAction(revealLabel)") && !kotlin.contains("FLAG_SECURE"))

        #expect(flatIOS.contains("ConclaveStrings.text(\"Your answer\")") && flatIOS.contains("ConclaveStrings.text(\"Correct\")"))
        #expect(flatKotlin.contains("role = Role.RadioButton") && flatKotlin.contains("conclaveString(\"gm_your_answer\")"))

        #expect(flatIOS.contains(".modifier(GameShellEndDialog(games: games, name: chrome.name, isPresented: $endPrompt))"))
        #expect(flatIOS.contains(".safeAreaInset(edge: .bottom, spacing: 0)"))
        for forbidden in ["GameJSONValue", "dictionaryValue", "Font.system(size:", "confetti", "shimmer", "MeetingState"] {
            #expect(!ios.contains(forbidden) && !kotlin.contains(forbidden), "the shell uses \(forbidden)")
        }
    }
}
#endif
