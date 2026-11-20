#if !SKIP
import Foundation
import Testing
@testable import Conclave

struct WordleServerProbe {
    let ok: Bool
    let error: String
}

struct WordleServerStep {
    let scenario: String
    let label: String
    let now: Double
    let publicState: GamePublicState
    let views: [String: GamePlayerViewNotification]
    let guess: [String: WordleServerProbe]
    let passTurn: [String: WordleServerProbe]
    let moveError: String

    var view: [String: Any] { publicState.view?.dictionaryValue ?? [:] }
    var team: [String: Any] { view["team"] as? [String: Any] ?? [:] }
}

@MainActor
struct WordleServerViews {
    static let hostId = "ava"
    static let viewers = ["ava", "ben", "cam", "dee"]

    let catalog: GameCatalogEntry
    let steps: [WordleServerStep]

    static func load() throws -> WordleServerViews {
        let url = try #require(Bundle.module.url(forResource: "WordleServerViews", withExtension: "json"))
        let root = try #require(try JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any])
        let decoder = JSONDecoder()
        let catalog = try decoder.decode(GameCatalogEntry.self, from: JSONSerialization.data(withJSONObject: try #require(root["catalog"])))
        var steps: [WordleServerStep] = []
        for scenario in try #require(root["scenarios"] as? [[String: Any]]) {
            let name = try #require(scenario["name"] as? String)
            for step in try #require(scenario["steps"] as? [[String: Any]]) {
                let state = try decoder.decode(GamePublicState.self, from: JSONSerialization.data(withJSONObject: try #require(step["state"])))
                var views: [String: GamePlayerViewNotification] = [:]
                var guess: [String: WordleServerProbe] = [:]
                var passTurn: [String: WordleServerProbe] = [:]
                let rawViews = try #require(step["views"] as? [String: Any])
                let accepts = try #require(step["accepts"] as? [String: [String: [String: Any]]])
                for viewer in viewers {
                    let envelope: [String: Any] = ["gameId": state.gameId, "view": rawViews[viewer] ?? NSNull()]
                    views[viewer] = try decoder.decode(GamePlayerViewNotification.self, from: JSONSerialization.data(withJSONObject: envelope))
                    guess[viewer] = probe(accepts[viewer]?["guess"])
                    passTurn[viewer] = probe(accepts[viewer]?["passTurn"])
                }
                let move = step["move"] as? [String: Any]
                steps.append(WordleServerStep(scenario: name, label: try #require(step["label"] as? String),
                                              now: try #require(step["now"] as? Double), publicState: state, views: views,
                                              guess: guess, passTurn: passTurn, moveError: move?["error"] as? String ?? ""))
            }
        }
        return WordleServerViews(catalog: catalog, steps: steps)
    }

    static func probe(_ raw: [String: Any]?) -> WordleServerProbe {
        WordleServerProbe(ok: raw?["ok"] as? Bool ?? false, error: raw?["error"] as? String ?? "")
    }

    func step(_ scenario: String, _ label: String) throws -> WordleServerStep {
        try #require(steps.first { $0.scenario == scenario && $0.label == label }, "\(scenario)/\(label)")
    }

    func scenario(_ name: String) -> [WordleServerStep] {
        steps.filter { $0.scenario == name }
    }

    func inputs(_ step: WordleServerStep, viewer: String, isRecovering: Bool = false) -> GameStageInputs {
        let state = step.publicState
        var players: [GamePlayerInput] = []
        var localPlayer = ""
        for player in state.players {
            players.append(GamePlayerInput(id: player.id, name: player.name))
            if player.id == viewer { localPlayer = viewer }
        }
        var pending: [GamePlayerInput] = []
        for player in state.pendingJoiners ?? [] {
            pending.append(GamePlayerInput(id: player.id, name: player.name))
            if player.id == viewer { localPlayer = viewer }
        }
        var config: [ActivityOptionValue] = []
        for key in (state.config ?? [:]).keys.sorted() {
            guard let value = state.config?[key] else { continue }
            config.append(ActivityOptionValue(id: key, isNumber: value.numberValue != nil, number: value.numberValue ?? 0.0,
                                              text: value.stringValue ?? ""))
        }
        return GameStageInputs.make(callSession: 1, isActive: true, gameId: state.gameId, name: state.name, phase: state.phase,
                                    players: players, pendingJoiners: pending, isFinished: state.finished,
                                    canJoinLate: state.canJoinLate ?? false, config: config,
                                    options: MeetingViewModel.activityGameInput(catalog).options, minPlayers: catalog.minPlayers,
                                    publicViewJSON: state.view?.rawJSON ?? "", playerViewJSON: step.views[viewer]?.view?.rawJSON ?? "",
                                    selfId: viewer, localPlayerId: localPlayer, isHost: viewer == WordleServerViews.hostId,
                                    isRecovering: isRecovering, receivedAtMillis: step.now)
    }

    @MainActor
    func presenter(_ step: WordleServerStep, viewer: String, onCommand: ((GameStageCommand) -> Void)? = nil) -> GameStagePresenter {
        let games = GameStagePresenter()
        games.sleep = { _ in try? await Task.sleep(nanoseconds: 60_000_000_000) }
        games.onCommand = onCommand
        games.apply(inputs(step, viewer: viewer))
        return games
    }

    @MainActor
    func replay(_ scenario: String, viewer: String, onCommand: ((GameStageCommand) -> Void)? = nil) -> GameStagePresenter {
        let games = GameStagePresenter()
        games.sleep = { _ in try? await Task.sleep(nanoseconds: 60_000_000_000) }
        games.onCommand = onCommand
        for step in self.scenario(scenario) {
            games.apply(inputs(step, viewer: viewer))
        }
        return games
    }
}

@MainActor
struct WordleServerViewsTests {
    private func words(_ rows: [WordleRowModel]) -> [String] { rows.map { $0.word } }

    private func serverGuesses(_ step: WordleServerStep, _ viewer: String) -> [String] {
        let mine = step.views[viewer]?.view?.dictionaryValue ?? [:]
        return GameProjectionJSON.objects(mine, "myGuesses").map { GameProjectionJSON.string($0, "word") }
    }

    @Test func everySoloStepMatchesTheServersGuessRuleAndBoard() throws {
        let fixture = try WordleServerViews.load()
        let solo = fixture.steps.filter { $0.scenario.hasPrefix("solo-") }
        #expect(solo.count == 15)
        for step in solo {
            for viewer in WordleServerViews.viewers {
                let at = "\(step.scenario)/\(step.label) as \(viewer)"
                let wordle = try #require(fixture.presenter(step, viewer: viewer).scene.wordle, "\(at)")
                let probe = try #require(step.guess[viewer])
                #expect(wordle.canGuess == probe.ok, "\(at): server says \(probe.error)")
                if viewer != "dee" && !wordle.isSetter {
                    #expect(words(wordle.myRows) == serverGuesses(step, viewer), "\(at)")
                }
                #expect(wordle.phase == WordleSceneBuilder.parsePhase(step.publicState.phase), "\(at)")
            }
        }
    }

    @Test func soloRandomCoversAWinALossAndATimeout() throws {
        let fixture = try WordleServerViews.load()
        let solved = try #require(fixture.presenter(try fixture.step("solo-random", "ava-solved"), viewer: "ava").scene.wordle)
        #expect(solved.myOutcome == WordleOutcome.solved && solved.myRows.count == 2 && !solved.canGuess)
        #expect(solved.myRows.last?.cells.allSatisfy { $0.state == WordleCellState.correct } == true)
        #expect(solved.standings.first { $0.id == "ava" }?.status == WordleStandingStatus.solved)

        let lost = try #require(fixture.presenter(try fixture.step("solo-random", "ben-out-of-tries"), viewer: "ben").scene.wordle)
        #expect(lost.myOutcome == WordleOutcome.outOfTries && lost.myRows.count == 6 && !lost.showsDraftRow)

        let resultsStep = try fixture.step("solo-random", "cam-timed-out")
        let results = fixture.presenter(resultsStep, viewer: "cam")
        let scene = try #require(results.scene.wordle)
        let target = try #require((resultsStep.view["result"] as? [String: Any])?["targetWord"] as? String)
        #expect(scene.phase == WordlePhase.results && scene.myOutcome == WordleOutcome.timedOut)
        #expect(scene.solution == target && scene.winnerName == "Ava")
        #expect(scene.standings.map { $0.status } == [.solved, .outOfTries, .timedOut])
        #expect(results.chrome.phase == GameChromePhase.results && !scene.canAdvanceRound)
        #expect(fixture.presenter(resultsStep, viewer: "ava").results.canRematch)

        let spectator = try #require(fixture.presenter(try fixture.step("solo-random", "ben-guessed"), viewer: "dee").scene.wordle)
        #expect(spectator.role == WordleRole.spectator && spectator.myRows.isEmpty && !spectator.isPlayer)
    }

    @Test func soloSetterShowsTheSettersHiddenBoardsAndAdvancesRounds() throws {
        let fixture = try WordleServerViews.load()
        let choosing = try #require(fixture.presenter(try fixture.step("solo-setter", "choosing-word"), viewer: "ava").scene.wordle)
        #expect(choosing.phase == WordlePhase.setWord && choosing.role == WordleRole.setter && choosing.canSetWord && !choosing.isRandomWord)
        let waiting = try #require(fixture.presenter(try fixture.step("solo-setter", "choosing-word"), viewer: "ben").scene.wordle)
        #expect(waiting.role == WordleRole.guesser && !waiting.canSetWord && waiting.setterName == "Ava")

        let watching = try #require(fixture.presenter(try fixture.step("solo-setter", "first-guess"), viewer: "ava").scene.wordle)
        #expect(watching.role == WordleRole.setter && watching.liveBoards.map { $0.id } == ["ben", "cam"])
        #expect(watching.liveBoards.map { $0.name } == ["Ben", "Cam"] && watching.liveBoards.first?.tries == 1)
        #expect(watching.liveBoards.allSatisfy { board in board.rows.allSatisfy { $0.word.isEmpty } })

        let roundOne = try fixture.step("solo-setter", "round-one-results")
        let host = try #require(fixture.presenter(roundOne, viewer: "ava").scene.wordle)
        #expect(host.canAdvanceRound && !host.isFinalRound && host.solution == "LEMON")
        #expect(!(try #require(fixture.presenter(roundOne, viewer: "ben").scene.wordle)).canAdvanceRound)

        let final = fixture.presenter(try fixture.step("solo-setter", "final-results"), viewer: "ben")
        let finalScene = try #require(final.scene.wordle)
        #expect(finalScene.isFinalRound && finalScene.solution == "CRANE" && finalScene.myOutcome == WordleOutcome.timedOut)
        #expect(final.chrome.phase == GameChromePhase.results && final.results.scoreboard.map { $0.name }.sorted() == ["Ben", "Cam"])
    }

    @Test func aSoloGuessFromTheServerFlowSendsOnceAndClearsWithThePush() throws {
        let fixture = try WordleServerViews.load()
        var sent: [GameStageCommand] = []
        let games = fixture.presenter(try fixture.step("solo-random", "started"), viewer: "ava") { sent.append($0) }
        let next = try fixture.step("solo-random", "ava-guessed")
        let word = try #require(serverGuesses(next, "ava").first)
        games.setWordleDraft(word.lowercased())
        #expect(games.submitWordle() == ActivityTapResult.dispatched)
        #expect(sent.count == 1 && sent.last?.type == "guess" && sent.last?.payloadJSON == "{\"word\":\"" + word + "\"}")
        #expect(games.submitWordle() == ActivityTapResult.ignored && sent.count == 1)
        games.apply(fixture.inputs(next, viewer: "ava"))
        #expect(games.scene.wordle?.myRows.count == 1 && games.wordleDraft.isEmpty)
    }

    @Test func theHostPicksTheModeAndOnlySeesTheTurnTimerForTakeTurns() throws {
        let fixture = try WordleServerViews.load()
        var sent: [ActivitiesCommand] = []
        let activities = ActivitiesPresenter()
        activities.sleep = { _ in }
        activities.onCommand = { sent.append($0) }
        activities.apply(ActivitiesInputs.make(callSession: 1, isHost: true, catalog: [MeetingViewModel.activityGameInput(fixture.catalog)],
                                               catalogLoaded: true, playersHere: 3))
        activities.beginSetup("wordle")
        let options = try #require(activities.setup?.options)
        let mode = try #require(options.first { $0.id == "mode" })
        #expect(mode.isVisible && mode.value == "solo")
        #expect(mode.choices.map { $0.id } == ["solo", "relay", "huddle"])
        #expect(mode.choices.map { $0.label } == ["Solo", "Take turns", "All together"])
        #expect(options.first { $0.id == "turnSeconds" }?.isVisible == false)

        activities.setOption("mode", value: "relay")
        let timer = try #require(activities.setup?.options.first { $0.id == "turnSeconds" })
        #expect(timer.isVisible && timer.value == "45" && timer.choices.map { $0.id } == ["20", "30", "45", "60"])
        activities.setOption("turnSeconds", value: "30")
        activities.startGame()
        let start = try #require(sent.last)
        #expect(start.kind == ActivitiesCommandKind.startGame && start.id == "wordle")
        #expect(start.options.first { $0.id == "mode" }?.text == "relay")
        #expect(start.options.first { $0.id == "turnSeconds" }?.number == 30)

        activities.beginSetup("wordle")
        activities.setOption("mode", value: "huddle")
        #expect(activities.setup?.options.first { $0.id == "turnSeconds" }?.isVisible == false)
    }

    @Test func theLobbyNamesTheModeAndOnlyListsTheTurnTimerForTakeTurns() throws {
        let fixture = try WordleServerViews.load()
        let relay = fixture.presenter(try fixture.step("relay-random", "lobby"), viewer: "ben")
        #expect(relay.scene.options.map { $0.label + "=" + $0.value }
            == ["Mode=Take turns", "Turn timer=30 s", "Word source=Random", "Rounds=2", "Time limit=5 min"])

        let lobby = fixture.inputs(try fixture.step("huddle-timeout", "lobby"), viewer: "ben")
        var config = lobby.config
        config.append(ActivityOptionValue(id: "turnSeconds", isNumber: true, number: 45, text: ""))
        let games = GameStagePresenter()
        games.apply(GameStageInputs.make(callSession: 1, isActive: true, gameId: lobby.gameId, name: lobby.name, phase: lobby.phase,
                                         players: lobby.players, config: config, options: lobby.options,
                                         publicViewJSON: lobby.publicViewJSON, playerViewJSON: lobby.playerViewJSON, selfId: "ben",
                                         localPlayerId: "ben", receivedAtMillis: lobby.receivedAtMillis))
        #expect(games.scene.options.map { $0.id } == ["mode", "wordSource", "rounds", "timeLimitMinutes"])
        #expect(games.scene.options.first?.value == "All together")
    }

    private func teamWords(_ step: WordleServerStep) -> [String] {
        GameProjectionJSON.objects(step.team, "guesses").map { GameProjectionJSON.string($0, "word") }
    }

    private func team(_ fixture: WordleServerViews, _ scenario: String, _ label: String, _ viewer: String) throws -> (WordleScene, WordleTeamScene) {
        let wordle = try #require(fixture.presenter(try fixture.step(scenario, label), viewer: viewer).scene.wordle, "\(scenario)/\(label)")
        return (wordle, try #require(wordle.team, "\(scenario)/\(label) as \(viewer) has no team board"))
    }

    @Test func everyTeamStepMatchesTheServersTurnRulesAndSharedBoard() throws {
        let fixture = try WordleServerViews.load()
        let teamSteps = fixture.steps.filter { !$0.scenario.hasPrefix("solo-") }
        #expect(teamSteps.count == 28)
        var passChecks = 0
        for step in teamSteps {
            for viewer in WordleServerViews.viewers {
                let at = "\(step.scenario)/\(step.label) as \(viewer)"
                let wordle = try #require(fixture.presenter(step, viewer: viewer).scene.wordle, "\(at)")
                let guess = try #require(step.guess[viewer])
                let pass = try #require(step.passTurn[viewer])
                #expect(wordle.canGuess == guess.ok, "\(at): server says \(guess.error)")
                #expect((wordle.team?.canPass ?? false) == pass.ok, "\(at): server says \(pass.error)")
                if pass.ok { passChecks += 1 }
                #expect((wordle.team != nil) == !step.team.isEmpty, "\(at)")
                if wordle.team != nil {
                    #expect(words(wordle.myRows) == teamWords(step), "\(at)")
                    #expect(wordle.liveBoards.isEmpty && wordle.standings.count == wordle.team?.members.count, "\(at)")
                }
            }
        }
        #expect(passChecks == 12)
    }

    @Test func takeTurnsShowsWhoIsGuessingWhoIsNextAndTheTurnClock() throws {
        let fixture = try WordleServerViews.load()
        let step = try fixture.step("relay-random", "ava-turn")
        let (ava, avaTeam) = try team(fixture, "relay-random", "ava-turn", "ava")
        #expect(avaTeam.mode == WordleMode.relay && avaTeam.turn == WordleTurn.yours && avaTeam.canPass && ava.canGuess)
        #expect(avaTeam.members.map { $0.id } == ["ava", "ben", "cam"] && avaTeam.members.map { $0.seat } == [1, 2, 3] && avaTeam.showsSeats)
        #expect(avaTeam.members.map { $0.isGuessing } == [true, false, false] && avaTeam.members.map { $0.isUpNext } == [false, true, false])
        #expect(avaTeam.members.first?.isYou == true && avaTeam.members.allSatisfy { !$0.isAway })
        #expect(ava.draftKey == "guess-1-0" && avaTeam.label(row: 0) == WordleRowLabel(id: 0, name: "Ava", isYou: true, isTurn: true))
        #expect(!avaTeam.turnKey.isEmpty && avaTeam.turnDurationMillis == 30_000)
        let clock = try #require(avaTeam.turnCountdown(serverOffsetMillis: 0))
        #expect(clock.secondsLeft(nowMillis: step.now) == 30 && clock.secondsLeft(nowMillis: step.now + 29_500) == 1)

        let (ben, benTeam) = try team(fixture, "relay-random", "ava-turn", "ben")
        #expect(benTeam.turn == WordleTurn.teammate && benTeam.guesserName == "Ava" && benTeam.isUpNext)
        #expect(!ben.canGuess && !benTeam.canPass && ben.draftKey.isEmpty && benTeam.turnKey.isEmpty && ben.showsDraftRow)
        #expect(benTeam.label(row: 0) == WordleRowLabel(id: 0, name: "Ava", isYou: false, isTurn: true))
        let (_, camTeam) = try team(fixture, "relay-random", "ava-turn", "cam")
        #expect(camTeam.turn == WordleTurn.teammate && !camTeam.isUpNext)
        let (dee, deeTeam) = try team(fixture, "relay-random", "ava-turn", "dee")
        #expect(dee.role == WordleRole.spectator && deeTeam.turn == WordleTurn.teammate && !deeTeam.canPass && !dee.canGuess)

        let (afterGuess, afterTeam) = try team(fixture, "relay-random", "ben-turn", "ava")
        #expect(afterGuess.myRows.count == 1 && afterTeam.turn == WordleTurn.teammate && afterTeam.guesserName == "Ben")
        #expect(afterTeam.label(row: 0) == WordleRowLabel(id: 0, name: "Ava", isYou: true, isTurn: false))
        #expect(afterTeam.label(row: 1) == WordleRowLabel(id: 1, name: "Ben", isYou: false, isTurn: true) && afterTeam.label(row: 2) == nil)
        let (deeAfter, _) = try team(fixture, "relay-random", "ben-turn", "dee")
        #expect(words(deeAfter.myRows) == words(afterGuess.myRows) && deeAfter.myRows.first?.cells.allSatisfy { !$0.letter.isEmpty } == true)
    }

    @Test func aDisconnectedGuesserIsShownAwayThenSkipped() throws {
        let fixture = try WordleServerViews.load()
        let (_, away) = try team(fixture, "relay-random", "ava-away", "ben")
        #expect(away.members.first { $0.id == "ava" }?.isAway == true && away.members.first { $0.id == "ava" }?.isGuessing == true)
        let (_, skipped) = try team(fixture, "relay-random", "ava-skipped", "ben")
        #expect(skipped.turn == WordleTurn.yours && skipped.canPass && skipped.members.first { $0.id == "ava" }?.isAway == true)
        let (_, back) = try team(fixture, "relay-random", "ava-back", "ava")
        #expect(back.turn == WordleTurn.teammate && back.members.allSatisfy { !$0.isAway })
        let (alone, aloneTeam) = try team(fixture, "relay-random", "cam-alone", "cam")
        #expect(alone.canGuess && aloneTeam.turn == WordleTurn.yours && !aloneTeam.canPass)
        #expect(aloneTeam.members.filter { $0.isAway }.map { $0.id } == ["ava", "ben"] && aloneTeam.members.allSatisfy { !$0.isUpNext })
    }

    @Test func passingAndTurnChangesDriveTheDraftAndTheMove() throws {
        let fixture = try WordleServerViews.load()
        var sent: [GameStageCommand] = []
        let ava = fixture.presenter(try fixture.step("relay-random", "ava-turn"), viewer: "ava") { sent.append($0) }
        ava.setWordleDraft("plant")
        ava.apply(fixture.inputs(try fixture.step("relay-random", "ben-out-of-turn"), viewer: "ava"))
        #expect(ava.wordleDraft == "PLANT")
        ava.apply(fixture.inputs(try fixture.step("relay-random", "ben-turn"), viewer: "ava"))
        #expect(ava.wordleDraft.isEmpty)
        ava.typeWordleLetter("A")
        #expect(ava.wordleDraft.isEmpty && ava.submitWordle() == ActivityTapResult.explained && ava.passWordleTurn() == ActivityTapResult.explained)
        #expect(sent.isEmpty)

        let ben = fixture.presenter(try fixture.step("relay-random", "ben-turn"), viewer: "ben") { sent.append($0) }
        ben.setWordleDraft("storm")
        #expect(ben.passWordleTurn() == ActivityTapResult.dispatched)
        let pass = try #require(sent.last)
        #expect(pass.kind == GameStageCommandKind.move && pass.type == "passTurn" && pass.payloadJSON.isEmpty)
        #expect(ben.passWordleTurn() == ActivityTapResult.ignored && ben.interaction.pendingType == WordleIntent.passTurnType)
        ben.moveAcknowledged(requestId: pass.requestId, success: false, serverText: "Your turn is over")
        #expect(ben.wordleDraft == "STORM" && ben.interaction.failureServerText == "Your turn is over")
        #expect(ben.passWordleTurn() == ActivityTapResult.dispatched)
        ben.apply(fixture.inputs(try fixture.step("relay-random", "ben-passed"), viewer: "ben"))
        #expect(ben.wordleDraft.isEmpty && ben.scene.wordle?.team?.turn == WordleTurn.teammate)

        let cam = fixture.presenter(try fixture.step("relay-random", "cam-alone"), viewer: "cam") { sent.append($0) }
        let before = sent.count
        #expect(cam.passWordleTurn() == ActivityTapResult.explained && sent.count == before)
    }

    @Test func aPlayerViewThatLagsTheTurnCannotReopenInput() throws {
        let fixture = try WordleServerViews.load()
        let stale = fixture.inputs(try fixture.step("relay-random", "ava-turn"), viewer: "ava")
        let fresh = fixture.inputs(try fixture.step("relay-random", "ben-turn"), viewer: "ava")
        let games = GameStagePresenter()
        games.apply(GameStageInputs.make(callSession: 1, isActive: true, gameId: fresh.gameId, name: fresh.name, phase: fresh.phase,
                                         players: fresh.players, options: fresh.options, publicViewJSON: fresh.publicViewJSON,
                                         playerViewJSON: stale.playerViewJSON, selfId: "ava", localPlayerId: "ava", isHost: true,
                                         receivedAtMillis: fresh.receivedAtMillis))
        let wordle = try #require(games.scene.wordle)
        #expect(wordle.team?.turn == WordleTurn.teammate && !wordle.canGuess && wordle.draftKey.isEmpty)
    }

    @Test func aSolvedSharedBoardCreditsTheTeamAndTheNextRoundRotates() throws {
        let fixture = try WordleServerViews.load()
        let solvedStep = try fixture.step("relay-random", "team-solved")
        let target = try #require((solvedStep.view["result"] as? [String: Any])?["targetWord"] as? String)
        let (solved, solvedTeam) = try team(fixture, "relay-random", "team-solved", "ava")
        #expect(solved.phase == WordlePhase.results && solvedTeam.outcome == WordleOutcome.solved && solvedTeam.solvedByName == "Ben")
        #expect(solvedTeam.turn == WordleTurn.none && !solvedTeam.isTurnTimed && solvedTeam.labels.map { $0.name } == ["Ava", "Ben"])
        #expect(solved.solution == target && solved.canAdvanceRound && solved.myOutcome == WordleOutcome.solved && solvedTeam.triesUsed == 2)

        let replay = fixture.replay("relay-random", viewer: "ava")
        #expect(replay.scene.wordle?.team?.outcome == WordleOutcome.outOfTries)
        let ava = GameStagePresenter()
        for step in fixture.scenario("relay-random").prefix(while: { $0.label != "round-two-cam-starts" }) {
            ava.apply(fixture.inputs(step, viewer: "ava"))
        }
        #expect(ava.feedbackState.token.kind == FeedbackKind.wordSolved)

        let (roundTwo, roundTwoTeam) = try team(fixture, "relay-random", "round-two-cam-starts", "cam")
        #expect(roundTwo.round == 2 && roundTwo.myRows.isEmpty && roundTwoTeam.turn == WordleTurn.yours && roundTwo.draftKey == "guess-2-0")
        #expect(roundTwoTeam.members.map { $0.isGuessing } == [false, false, true])

        let (lastTry, _) = try team(fixture, "relay-random", "one-try-left", "ben")
        #expect(lastTry.canGuess && lastTry.myRows.count == 5 && lastTry.draftKey == "guess-2-5")
        let finalStep = try fixture.step("relay-random", "team-out-of-tries")
        let final = fixture.presenter(finalStep, viewer: "ava")
        let finalScene = try #require(final.scene.wordle)
        #expect(finalScene.team?.outcome == WordleOutcome.outOfTries && finalScene.myRows.count == 6 && finalScene.isFinalRound)
        #expect(final.chrome.phase == GameChromePhase.results && final.results.scoreboard.map { $0.score } == [5, 5, 5])
    }

    @Test func allTogetherLetsAnyoneGuessAndTheSetterWatchesTheSharedBoard() throws {
        let fixture = try WordleServerViews.load()
        let (setter, setterTeam) = try team(fixture, "huddle-setter", "word-set", "ava")
        #expect(setter.role == WordleRole.setter && setter.liveBoards.isEmpty && setterTeam.mode == WordleMode.huddle)
        #expect(setterTeam.turn == WordleTurn.anyone && !setterTeam.showsSeats && setterTeam.members.map { $0.id } == ["ben", "cam"])
        #expect(!setterTeam.canPass && !setterTeam.isTurnTimed && setterTeam.turnCountdown(serverOffsetMillis: 0) == nil)
        for viewer in ["ben", "cam"] {
            let (guesser, guesserTeam) = try team(fixture, "huddle-setter", "word-set", viewer)
            #expect(guesser.canGuess && guesserTeam.turn == WordleTurn.anyone && guesser.draftKey == "guess-1" && guesserTeam.labels.isEmpty)
        }
        let (watching, _) = try team(fixture, "huddle-setter", "first-guess", "ava")
        #expect(watching.myRows.count == 1 && watching.myRows.first?.word.isEmpty == false)
        #expect(try fixture.step("huddle-setter", "duplicate-guess").moveError == "Your team already guessed that word")

        let (solved, solvedTeam) = try team(fixture, "huddle-setter", "team-solved", "dee")
        #expect(solved.role == WordleRole.spectator && solvedTeam.outcome == WordleOutcome.solved && solved.solution == "LEMON")
        #expect(!solvedTeam.solvedByName.isEmpty && solvedTeam.labels.last?.name == solvedTeam.solvedByName)

        let (relaySetter, relaySetterTeam) = try team(fixture, "relay-setter", "word-set", "ava")
        #expect(relaySetter.role == WordleRole.setter && relaySetterTeam.turn == WordleTurn.teammate && !relaySetterTeam.canPass)
        #expect(relaySetterTeam.members.map { $0.id } == ["ben", "cam"] && relaySetterTeam.guesserName == "Ben")

        let (late, lateTeam) = try team(fixture, "huddle-timeout", "time-ran-out", "cam")
        #expect(late.phase == WordlePhase.results && lateTeam.outcome == WordleOutcome.timedOut && late.myOutcome == WordleOutcome.timedOut)
        #expect(lateTeam.labels.map { $0.isYou } == [true])
    }
}
#endif
