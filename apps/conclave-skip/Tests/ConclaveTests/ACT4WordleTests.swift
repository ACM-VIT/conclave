#if !SKIP
import Foundation
import Testing
@testable import Conclave

@MainActor
struct ACT4WordleTests {
    private final class Recorder {
        var commands: [GameStageCommand] = []
    }

    private func presenter(_ pushes: [GameStageInputs], recorder: Recorder? = nil) -> GameStagePresenter {
        let games = GameStagePresenter()
        games.sleep = { _ in try? await Task.sleep(nanoseconds: 60_000_000_000) }
        if let recorder = recorder {
            games.onCommand = { command in recorder.commands.append(command) }
        }
        for inputs in pushes {
            games.apply(inputs)
        }
        return games
    }

    private func presenter(_ state: WordleFixtureState, recorder: Recorder? = nil) -> GameStagePresenter {
        presenter(WordleFixtures.pushes(state), recorder: recorder)
    }

    private func makeSession() -> ActivitySession {
        let shell = MeetingShellPresenter()
        return ActivitySession(shell: shell, stage: StagePresenter(shell: shell))
    }

    private func marks(_ row: WordleRowModel) -> [WordleCellState] {
        row.cells.map { $0.state }
    }

    private func key(_ scene: WordleScene, _ letter: String) -> WordleKeyState {
        scene.keyStates.first { $0.letter == letter }?.state ?? WordleKeyState.unused
    }

    private func evaluate(target: String, guess: String) -> [String] {
        let goal = target.map { String($0) }
        let attempt = guess.map { String($0) }
        var feedback = Array(repeating: "gray", count: attempt.count)
        var pool = goal
        for index in attempt.indices where index < goal.count && attempt[index] == goal[index] {
            feedback[index] = "green"
            pool[index] = ""
        }
        for index in attempt.indices where feedback[index] != "green" {
            if let found = pool.firstIndex(of: attempt[index]) {
                feedback[index] = "yellow"
                pool[found] = ""
            }
        }
        return feedback
    }

    @Test func theFixtureGuessesMatchTheModuleEvaluator() throws {
        for json in [WordleFixtures.sloth, WordleFixtures.llama, WordleFixtures.logic, WordleFixtures.lemur, WordleFixtures.lemma,
                     WordleFixtures.leech, WordleFixtures.lemon] {
            let item = try #require(try JSONSerialization.jsonObject(with: Data(json.utf8)) as? [String: Any])
            let word = try #require(item["word"] as? String)
            #expect(item["feedback"] as? [String] == evaluate(target: "LEMON", guess: word), "\(word)")
        }
        for json in [WordleFixtures.slate, WordleFixtures.brake, WordleFixtures.crane] {
            let item = try #require(try JSONSerialization.jsonObject(with: Data(json.utf8)) as? [String: Any])
            let word = try #require(item["word"] as? String)
            #expect(item["feedback"] as? [String] == evaluate(target: "CRANE", guess: word), "\(word)")
        }
    }

    @Test func theBoardMarksCorrectPresentAbsentAndRepeatedLetters() throws {
        let scene = try #require(presenter(.guess).scene.wordle)
        #expect(scene.phase == WordlePhase.playing && scene.role == WordleRole.guesser && scene.canGuess && scene.isRandomWord)
        #expect(scene.round == 1 && scene.roundTotal == 3 && scene.wordLength == 5 && scene.maxTries == 6)
        #expect(scene.myRows.map { $0.word } == ["SLOTH", "LLAMA"] && scene.myRows.allSatisfy { $0.isGuess })
        try #require(scene.myRows.count >= 2)
        #expect(marks(scene.myRows[0]) == [.absent, .present, .present, .absent, .absent])

        #expect(marks(scene.myRows[1]) == [.correct, .absent, .absent, .present, .absent])
        #expect(scene.myRows[1].cells.map { $0.letter } == ["L", "L", "A", "M", "A"])

        #expect(key(scene, "L") == .correct && key(scene, "O") == .present && key(scene, "M") == .present)
        #expect(key(scene, "S") == .absent && key(scene, "A") == .absent && key(scene, "Q") == .unused)
        #expect(scene.keyStates.count == 26)
        #expect(scene.keys(inRow: 0).map { $0.letter }.joined() == "QWERTYUIOP")
        #expect(scene.keys(inRow: 1).map { $0.letter }.joined() == "ASDFGHJKL")
        #expect(scene.keys(inRow: 2).map { $0.letter }.joined() == "ZXCVBNM")
        #expect(scene.draftKey == "guess-1" && scene.showsDraftRow && scene.myOutcome == WordleOutcome.none)
        #expect(scene.standings.map { $0.id } == ["r1", "r2", "r3", "you"] && scene.standings[3].isYou)
        try #require(!scene.standings.isEmpty)
        #expect(scene.standings[0].status == WordleStandingStatus.solved && scene.standings[0].tries == 3)
        #expect(scene.solution.isEmpty && scene.winnerName.isEmpty && !scene.canAdvanceRound)
        #expect(presenter(.guess).countdown != nil)
    }

    @Test func displayRowsAddTheDraftRowThenEmptyRowsAndFilterLetters() throws {
        let scene = try #require(presenter(.guess).scene.wordle)
        let rows = WordleBoardPolicy.displayRows(scene, draft: "LEMO")
        #expect(rows.count == 6 && rows.map { $0.index } == [0, 1, 2, 3, 4, 5])
        try #require(rows.count >= 3)
        #expect(marks(rows[2]) == [.typed, .typed, .typed, .typed, .empty] && !rows[2].isGuess)
        #expect(rows[3...].allSatisfy { row in row.cells.allSatisfy { $0.state == .empty && $0.letter.isEmpty } })
        #expect(rows[2].cells.map { $0.id } == ["r2c0", "r2c1", "r2c2", "r2c3", "r2c4"])

        #expect(WordleBoardPolicy.normalized("l\u{00E9} mon2Ok", limit: 5) == "LMONO")
        #expect(WordleBoardPolicy.normalized("crane!", limit: 5) == "CRANE")
        #expect(WordleBoardPolicy.normalized("\u{0645}\u{0631}\u{062D}\u{0628}\u{0627}", limit: 5).isEmpty)
        #expect(WordleBoardPolicy.canSubmit(scene, draft: "LEMON") && !WordleBoardPolicy.canSubmit(scene, draft: "LEMO"))
        let solved = try #require(presenter(.solved).scene.wordle)
        #expect(!solved.showsDraftRow && WordleBoardPolicy.displayRows(solved, draft: "ABCDE").filter { !$0.isGuess }.count == 3)
    }

    @Test func keyAndBoardGeometryFollowTheSpec() {

        #expect(abs(WordleBoardPolicy.keyWidth(available: 335) - 29.9) < 0.0001)
        #expect(abs(WordleBoardPolicy.keyWidth(available: 311) - 27.5) < 0.0001)
        #expect(WordleBoardPolicy.keyWidth(available: 420) == 32)
        #expect(WordleBoardPolicy.keyWidth(available: 0) == 1)
        #expect(WordleBoardPolicy.cellSize * 5 + WordleBoardPolicy.gap * 4 == WordleBoardPolicy.boardWidth)
        #expect(WordleBoardPolicy.wideKeyFactor == 1.5 && WordleBoardPolicy.warningSeconds == 10)
        #expect(WordleBoardPolicy.announcedSeconds == [60, 10])

        let unit = WordleBoardPolicy.keyWidth(available: 311)
        #expect(unit * 10 + WordleBoardPolicy.gap * 8 <= 311)
    }

    @Test func theDraftLivesInThePresenterAndSurvivesUnrelatedPushes() throws {
        let games = presenter(.guess)
        for letter in ["l", "E", "1", "M", "O"] {
            games.typeWordleLetter(letter)
        }
        #expect(games.wordleDraft == "LEMO")
        let sceneRevision = games.scene.revision

        let other = WordleFixtures.playingView(you: WordleFixtures.standing("you", "You", 2, ""), finished: 1)
            .replacingOccurrences(of: "\"r2\",\"playerName\":\"Ben\",\"triesUsed\":2", with: "\"r2\",\"playerName\":\"Ben\",\"triesUsed\":3")
        games.apply(GameStageInputs.make(callSession: 1, isActive: true, gameId: "wordle", name: "Wordle", phase: "playing",
                                         players: ActivityFixtureScript.players(4, includingYou: true), minPlayers: 1, publicViewJSON: other,
                                         playerViewJSON: WordleFixtures.playerView(.guess), localPlayerId: "you", isHost: true,
                                         receivedAtMillis: 2))
        #expect(games.scene.revision == sceneRevision + 1 && games.wordleDraft == "LEMO")
        games.deleteWordleLetter()
        #expect(games.wordleDraft == "LEM")
        games.setWordleDraft("lemon pie")
        #expect(games.wordleDraft == "LEMON")
        games.typeWordleLetter("S")
        #expect(games.wordleDraft == "LEMON")

        #expect(games.scene.revision == sceneRevision + 1)
    }

    @Test func aGuessIsSentOnceAndTheRecordingPushClearsTheDraft() throws {
        let recorder = Recorder()
        let games = presenter(.guess, recorder: recorder)
        games.setWordleDraft("LEMO")
        #expect(games.submitWordle() == ActivityTapResult.ignored && recorder.commands.isEmpty)
        games.typeWordleLetter("N")
        #expect(games.submitWordle() == ActivityTapResult.dispatched)
        let sent = try #require(recorder.commands.last)
        #expect(sent.kind == GameStageCommandKind.move && sent.type == "guess" && sent.payloadJSON == #"{"word":"LEMON"}"#)

        #expect(games.submitWordle() == ActivityTapResult.ignored && recorder.commands.count == 1)
        games.deleteWordleLetter()
        #expect(games.wordleDraft == "LEMON")
        let before = games.feedbackState.token.sequence

        games.apply(WordleFixtures.playingPush(guesses: [WordleFixtures.sloth, WordleFixtures.llama, WordleFixtures.lemon], outcome: "win"))
        #expect(games.wordleDraft.isEmpty && games.interaction.isPending)
        #expect(games.feedbackState.token.kind == FeedbackKind.wordSolved && games.feedbackState.token.sequence == before + 1)
        let solved = try #require(games.scene.wordle)
        #expect(solved.myOutcome == WordleOutcome.solved && !solved.canGuess && solved.myRows.count == 3)
        games.moveAcknowledged(requestId: sent.requestId, success: true, serverText: "")
        #expect(!games.interaction.isPending && games.wordleDraft.isEmpty)
        games.apply(WordleFixtures.playingPush(guesses: [WordleFixtures.sloth, WordleFixtures.llama, WordleFixtures.lemon], outcome: "win"))
        #expect(games.feedbackState.token.sequence == before + 1)

        let late = presenter([WordleFixtures.playingPush(guesses: [WordleFixtures.lemon], outcome: "win")])
        #expect(late.feedbackState.token.sequence == 0)
    }

    @Test func aRejectedGuessKeepsTheDraftAndPlaysGuessInvalid() throws {
        let recorder = Recorder()
        let games = presenter(.guess, recorder: recorder)
        games.setWordleDraft("XYLYX")
        #expect(games.submitWordle() == ActivityTapResult.dispatched)
        let before = games.feedbackState.token.sequence
        games.moveAcknowledged(requestId: try #require(recorder.commands.last).requestId, success: false, serverText: "Not in word list")
        #expect(games.wordleDraft == "XYLYX")
        #expect(games.interaction.failure == GameFailure.server && games.interaction.failureServerText == "Not in word list")
        #expect(games.feedbackState.token.kind == FeedbackKind.guessInvalid && games.feedbackState.token.sequence == before + 1)

        games.deleteWordleLetter()
        games.typeWordleLetter("Z")
        #expect(games.wordleDraft == "XYLYZ" && games.submitWordle() == ActivityTapResult.dispatched)
    }

    @Test func anAckBeforeThePushClearsTheDraftOnceAndATimeoutKeepsIt() throws {
        let recorder = Recorder()
        let early = presenter(.guess, recorder: recorder)
        early.setWordleDraft("LOGIC")
        _ = early.submitWordle()
        early.moveAcknowledged(requestId: try #require(recorder.commands.last).requestId, success: true, serverText: "")
        #expect(early.wordleDraft.isEmpty)
        early.typeWordleLetter("L")
        early.apply(WordleFixtures.playingPush(guesses: [WordleFixtures.sloth, WordleFixtures.llama, WordleFixtures.logic], outcome: ""))
        #expect(early.wordleDraft == "L")

        let slowRecorder = Recorder()
        let slow = presenter(.guess, recorder: slowRecorder)
        slow.setWordleDraft("LOGIC")
        _ = slow.submitWordle()
        let requestId = try #require(slowRecorder.commands.last).requestId
        slow.fireTimeout(requestId: requestId)
        #expect(slow.wordleDraft == "LOGIC" && slow.interaction.failure == GameFailure.server && !slow.interaction.isPending)

        #expect(slowRecorder.commands.count == 1)
        slow.apply(WordleFixtures.playingPush(guesses: [WordleFixtures.sloth, WordleFixtures.llama, WordleFixtures.logic], outcome: ""))
        #expect(slow.wordleDraft.isEmpty)
    }

    @Test func aNewRoundOrPhaseClearsTheDraftAndTheResultsShowNoDraft() throws {
        let games = presenter(.guess)
        games.setWordleDraft("LEMO")
        games.apply(WordleFixtures.pushes(.timeout)[0])
        let results = try #require(games.scene.wordle)
        #expect(results.phase == WordlePhase.results && results.draftKey.isEmpty && games.wordleDraft.isEmpty)
        games.setWordleDraft("ABC")
        #expect(games.wordleDraft.isEmpty)
        games.reset()
        #expect(games.wordleDraft.isEmpty && games.scene.wordle == nil)
    }

    @Test func playerSetModeCoversTheSetterTheWaitingGuesserAndTheWatchingSetter() throws {
        let recorder = Recorder()
        let setter = presenter(.setWord, recorder: recorder)
        let pick = try #require(setter.scene.wordle)
        #expect(pick.phase == WordlePhase.setWord && pick.role == WordleRole.setter && pick.canSetWord && !pick.canGuess)
        #expect(!pick.isRandomWord && pick.draftKey == "secret-1" && pick.standings.count == 3)
        setter.setWordleDraft("crane")
        #expect(setter.wordleDraft == "CRANE" && setter.submitWordle() == ActivityTapResult.dispatched)
        #expect(recorder.commands.last?.type == "setWord" && recorder.commands.last?.payloadJSON == #"{"word":"CRANE"}"#)

        setter.moveAcknowledged(requestId: try #require(recorder.commands.last).requestId, success: false, serverText: "Not in word list")
        #expect(setter.wordleDraft == "CRANE" && setter.feedbackState.token.kind != FeedbackKind.guessInvalid)

        let waiting = try #require(presenter(.waitingWord).scene.wordle)
        #expect(waiting.role == WordleRole.guesser && !waiting.canGuess && !waiting.canSetWord && waiting.setterName == "Avery")
        #expect(waiting.draftKey.isEmpty && !waiting.showsDraftRow)

        let watching = try #require(presenter(.setterWatching).scene.wordle)
        #expect(watching.role == WordleRole.setter && !watching.canGuess && watching.myRows.isEmpty)
        #expect(watching.liveBoards.map { $0.id } == ["r1", "r2", "r3"] && watching.liveBoards.map { $0.name } == ["Avery", "Ben", "Cai"])
        try #require(watching.liveBoards.count >= 3)
        #expect(watching.liveBoards[0].status == WordleStandingStatus.solved && watching.liveBoards[0].tries == 3)
        #expect(watching.liveBoards[2].status == WordleStandingStatus.outOfTries && watching.liveBoards[2].rows.count == 6)

        #expect(watching.liveBoards.allSatisfy { board in board.rows.allSatisfy { row in
            row.word.isEmpty && row.cells.allSatisfy { $0.letter.isEmpty } } })
        try #require(watching.liveBoards[0].rows.count >= 3)
        #expect(marks(watching.liveBoards[0].rows[2]) == [.correct, .correct, .correct, .correct, .correct])
    }

    @Test func onlyTheSettersOwnViewCarriesTheBoards() throws {

        let mine = WordleFixtures.playerView(round: 1, isSetter: false, canSetWord: false, canGuess: true, secret: "", guesses: [],
                                             outcome: "", boards: "[{\"playerId\":\"r1\",\"guesses\":[" + WordleFixtures.sloth + "],\"outcome\":null}]")
        let projection = GameProjectionParser.parse(gameId: "wordle", publicPhase: "playing",
                                                    publicViewJSON: WordleFixtures.publicView(.guess), playerViewJSON: mine)
        let host = PromptSceneContext.make(localId: "you", isPlayer: true, isHost: true, players: ActivityFixtureScript.players(4, includingYou: true))
        let scene = WordleSceneBuilder.scene(try #require(projection.wordle), context: host)
        #expect(scene.liveBoards.isEmpty && scene.role == WordleRole.guesser)
        let spectatorProjection = GameProjectionParser.parse(gameId: "wordle", publicPhase: "playing",
                                                             publicViewJSON: WordleFixtures.publicView(.setterWatching),
                                                             playerViewJSON: WordleFixtures.playerView(.setterWatching))
        let unseated = PromptSceneContext.make(localId: "you", isPlayer: false, isHost: true)
        let watching = WordleSceneBuilder.scene(try #require(spectatorProjection.wordle), context: unseated)
        #expect(watching.role == WordleRole.spectator && watching.liveBoards.isEmpty && watching.myRows.isEmpty && !watching.isSetter)
    }

    @Test func outcomesTimeoutAndResultsFollowTheModule() throws {
        let solved = try #require(presenter(.solved).scene.wordle)
        #expect(solved.myOutcome == WordleOutcome.solved && !solved.canGuess && solved.outcomeKey == "wordle-outcome-1-solved")
        let out = try #require(presenter(.outOfTries).scene.wordle)
        #expect(out.myOutcome == WordleOutcome.outOfTries && out.myRows.count == 6 && !out.canGuess && !out.showsDraftRow)

        let timeoutGames = presenter(.timeout)
        let timeout = try #require(timeoutGames.scene.wordle)
        #expect(timeout.phase == WordlePhase.results && timeout.myOutcome == WordleOutcome.timedOut)
        #expect(timeout.solution == "LEMON" && timeout.winnerName == "Avery" && timeout.resultKey == "wordle-result-1")
        #expect(timeout.canAdvanceRound && !timeout.isFinalRound && timeoutGames.chrome.phase == GameChromePhase.playing)
        let round = try #require(presenter(.roundResults).scene.wordle)
        #expect(!round.canAdvanceRound && round.myOutcome == WordleOutcome.solved && round.myRows.count == 4)
        #expect(round.standings.map { $0.status } == [.solved, .solved, .timedOut, .outOfTries])
        #expect(WordleBoardPolicy.solutionRow(round).cells.map { $0.letter }.joined() == "LEMON")
        #expect(marks(WordleBoardPolicy.solutionRow(round)) == [.correct, .correct, .correct, .correct, .correct])

        let finalGames = presenter(.finalResults)
        let final = try #require(finalGames.scene.wordle)
        #expect(final.isFinalRound && !final.canAdvanceRound && finalGames.chrome.phase == GameChromePhase.results)
        #expect(finalGames.results.canRematch && finalGames.results.scoreboard.first?.name == "Avery")
        #expect(final.standings.first?.tries == 1 && final.standings.first?.status == WordleStandingStatus.solved)
        #expect(final.solution == "CRANE" && finalGames.scene.kind == GameSceneKind.wordle)
    }

    @Test func nextRoundIsASeatedHostMoveWithoutAPayload() throws {
        let recorder = Recorder()
        let games = presenter(.timeout, recorder: recorder)
        #expect(games.send(WordleIntent.nextRound()) == ActivityTapResult.dispatched)
        let sent = try #require(recorder.commands.last)
        #expect(sent.type == "nextRound" && sent.payloadJSON.isEmpty)
        #expect(GameMoveAdapter.payloadJSON(WordleIntent.guess("CRANE")) == #"{"word":"CRANE"}"#)
        #expect(GameMoveAdapter.payloadJSON(WordleIntent.setWord("CRANE")) == #"{"word":"CRANE"}"#)
        let unseatedHost = PromptSceneContext.make(localId: "", isPlayer: false, isHost: true)
        let projection = GameProjectionParser.parse(gameId: "wordle", publicPhase: "results", publicViewJSON: WordleFixtures.publicView(.timeout),
                                                    playerViewJSON: "")
        #expect(!WordleSceneBuilder.scene(try #require(projection.wordle), context: unseatedHost).canAdvanceRound)
    }

    @Test func spectatorAndReconnectingAreReadOnly() throws {
        let spectator = presenter(.spectator)
        let watching = try #require(spectator.scene.wordle)
        #expect(!watching.isPlayer && watching.role == WordleRole.spectator && watching.myRows.isEmpty && !watching.canGuess)
        #expect(watching.standings.count == 4 && spectator.scene.kind == GameSceneKind.wordle)
        spectator.typeWordleLetter("A")
        #expect(spectator.wordleDraft.isEmpty && spectator.submitWordle() == ActivityTapResult.explained)

        let session = makeSession()
        WordleFixtures.apply(named: WordleFixtureState.reconnecting.rawValue, session: session, owner: ActivityFixtureOwner())
        let recovering = try #require(session.games.scene.wordle)
        #expect(recovering.isReconnecting && !recovering.canGuess && recovering.showsDraftRow)
        #expect(session.games.wordleDraft == "LEMO")
        session.games.typeWordleLetter("N")
        #expect(session.games.wordleDraft == "LEMO" && session.games.submitWordle() == ActivityTapResult.explained)
    }

    @Test func everyWordleFixtureBuildsItsScene() throws {
        #expect(WordleFixtureState.allCases.count == 11)
        let base = StageFixtureScript.inputs(for: .grid6)
        for state in WordleFixtureState.allCases {
            #expect(state.rawValue.hasPrefix("game-wordle-"))
            #expect(WordleFixtures.state(named: state.rawValue) == state)
            #expect(ActivityFixtureState(rawValue: state.rawValue) == nil && PromptGameFixtureState(rawValue: state.rawValue) == nil)
            let games = presenter(state)
            #expect(games.chrome.isKnownGame && games.scene.kind == GameSceneKind.wordle, "\(state.rawValue) shows \(games.scene.kind)")
            #expect(games.scene.wordle != nil, "\(state.rawValue)")
            let stage = WordleFixtures.stageInputs(named: state.rawValue, base: base)
            #expect(stage.isGameActive && stage.gameName == "Wordle")
        }
        #expect(WordleFixtures.stageInputs(named: "grid-6", base: base) == base)
        let session = makeSession()
        #expect(WordleFixtures.apply(named: "game-wordle-guess", session: session, owner: ActivityFixtureOwner()) == .guess)
        #expect(session.games.wordleDraft == "LEMO")
        #expect(WordleFixtures.apply(named: "game-trivia-6", session: session, owner: ActivityFixtureOwner()) == nil)
    }

    private let iosPath = "Sources/Conclave/Features/Meeting/Games/Native/Boards/WordleBoard+iOS.swift"
    private let kotlinPath = "Sources/Conclave/Skip/ui/games/boards/WordleBoard.kt"

    @Test func tilesAndKeysCarryTextAndGlyphTwinsAndNeverMirror() throws {
        let ios = try stageSource(iosPath)
        let kotlin = try stageSource(kotlinPath)
        let flatIOS = stageNormalized(ios)
        let flatKotlin = stageNormalized(kotlin)

        #expect(flatIOS.contains(".accessibilityElement(children: .ignore) .accessibilityLabel(label)"))
        #expect(flatIOS.contains("WordleRowView(row: row, label: WordleCopy.rowSummary(row))"))
        #expect(flatIOS.contains(".accessibilityLabel(WordleCopy.keyLabel(key))"))
        #expect(flatKotlin.contains("clearAndSetSemantics { contentDescription = label }"))
        #expect(flatKotlin.contains(".semantics { contentDescription = label }"))

        #expect(flatIOS.contains("Image(systemName: ConclaveSymbols.checkmark)") && flatIOS.contains("Circle() .fill(ink)"))
        #expect(flatKotlin.contains("Icon(ConclaveIcons.CheckFill0, contentDescription = null, tint = ink") && flatKotlin.contains("background(ink, CircleShape)"))

        for token in ["DesignTokens.iosInCallSuccess", "DesignTokens.iosInCallWarning", "DesignTokens.iosInCallSurfaceHigh",
                      "HostingTheme.inCallBorderStrong", "DesignTokens.iosInCallOnControlOff"] {
            #expect(ios.contains(token), "iOS board misses \(token)")
        }
        for token in ["ext.success", "ext.warning", "ext.onWarning", "scheme.surfaceContainerHighest", "scheme.outline"] {
            #expect(kotlin.contains(token), "Android board misses \(token)")
        }
        for forbidden in ["coral", "Coral", "primaryContainer", "Color.white", "Color.White"] {
            #expect(!ios.contains(forbidden) && !kotlin.contains(forbidden), "the board uses \(forbidden)")
        }

        #expect(flatIOS.contains(".dynamicTypeSize(...DynamicTypeSize.accessibility1)") && ios.contains(".accessibilityShowsLargeContentViewer"))
        #expect(flatIOS.contains(".environment(\\.layoutDirection, .leftToRight)"))
        #expect(flatKotlin.contains("CompositionLocalProvider(LocalLayoutDirection provides LayoutDirection.Ltr)"))
        #expect(flatKotlin.contains("Modifier.size(WordleBoardPolicy.cellSize.dp)") && flatIOS.contains("CGFloat(WordleBoardPolicy.cellSize)"))
        #expect(flatKotlin.contains("private val WordleKeyHeight = 48.dp") && flatIOS.contains("static let keyHeight: CGFloat = 44"))

        #expect(flatIOS.contains("focusedRow = new - 1") && flatKotlin.contains("announcement = newest"))
    }

    @Test func textEntryFollowsTheScreenReaderAndHardwareKeysFeedTheSameDraft() throws {
        let flatIOS = stageNormalized(try stageSource(iosPath))
        let flatKotlin = stageNormalized(try stageSource(kotlinPath))

        #expect(flatIOS.contains("@Environment(\\.accessibilityVoiceOverEnabled) private var voiceOver"))
        #expect(flatIOS.contains("textEntry: prefersTextEntry ?? voiceOver"))
        #expect(flatKotlin.contains("if (entryMode == 0) access.touchExploration else entryMode == 1"))

        for fragment in [".textInputAutocapitalization(.characters)", ".autocorrectionDisabled()", ".submitLabel(.go)",
                         ".keyboardType(.asciiCapable)", "SecureField(WordleCopy.secretField(), text: $text)",
                         "games.setWordleDraft(letters)"] {
            #expect(flatIOS.contains(fragment), "iOS misses \(fragment)")
        }
        for fragment in ["capitalization = KeyboardCapitalization.Characters", "autoCorrectEnabled = false", "keyboardType = KeyboardType.Ascii",
                         "imeAction = ImeAction.Go", "visualTransformation = PasswordVisualTransformation()",
                         "onValueChange = { games.setWordleDraft(it) }"] {
            #expect(flatKotlin.contains(fragment), "Android misses \(fragment)")
        }

        #expect(flatIOS.contains(".onKeyPress(characters: .letters, phases: .down)") && flatIOS.contains(".onKeyPress(.delete)")
            && flatIOS.contains(".onKeyPress(.return)") && flatIOS.contains(".focusable(canType)"))
        #expect(flatKotlin.contains(".onPreviewKeyEvent { event ->") && flatKotlin.contains("event.key == Key.Backspace")
            && flatKotlin.contains("event.key == Key.Enter || event.key == Key.NumPadEnter")
            && flatKotlin.contains("wordleHardwareLetter(event.utf16CodePoint)"))

        #expect(flatIOS.contains("games.typeWordleLetter(key.letter)") && flatIOS.contains("games.deleteWordleLetter()"))
        #expect(flatKotlin.contains("games.typeWordleLetter(letterKey.letter)") && flatKotlin.contains("role = Role.Button"))
    }

    @Test func theTimerIsItsOwnLeafAndKeysPlayNoHaptics() throws {
        let ios = try stageSource(iosPath)
        let kotlin = try stageSource(kotlinPath)
        let flatIOS = stageNormalized(ios)
        let flatKotlin = stageNormalized(kotlin)
        #expect(flatIOS.contains("TimelineView(.periodic(from: .now, by: 1))") && flatIOS.contains("if scenePhase == .active"))
        #expect(flatIOS.contains("WordleBoardPolicy.announcedSeconds.contains(value)") && flatIOS.contains(".monospacedDigit()"))
        #expect(flatIOS.contains("if let countdown = games.countdown { WordleTimerChip(model: countdown) }"))
        #expect(flatKotlin.contains("lifecycle.repeatOnLifecycle(Lifecycle.State.STARTED)") && flatKotlin.contains("LiveRegionMode.Polite"))
        #expect(flatKotlin.contains("val countdown = games.countdown ?: return WordleTimerChip(countdown)"))
        for forbidden in ["conclaveGestureFeedback", "haptics.gesture", "withAnimation", ".animation(", "animate", "GameJSONValue",
                          "dictionaryValue", "MeetingState", "MeetingViewModel", "Font.system(size:", "onLongPressGesture", "confetti"] {
            #expect(!ios.contains(forbidden) && !kotlin.contains(forbidden), "the board uses \(forbidden)")
        }
    }

    @Test func everyWordleEnumCaseHasCopyOnBothPlatforms() throws {
        let ios = try stageSource(iosPath)
        let kotlin = try stageSource(kotlinPath)
        for value in WordleCellState.allCases { #expect(ios.contains("." + value.rawValue) && kotlin.contains("WordleCellState." + value.rawValue), "\(value)") }
        for value in WordleKeyState.allCases { #expect(ios.contains("." + value.rawValue) && kotlin.contains("WordleKeyState." + value.rawValue), "\(value)") }
        for value in WordlePhase.allCases { #expect(ios.contains("." + value.rawValue) && kotlin.contains("WordlePhase." + value.rawValue), "\(value)") }
        for value in WordleRole.allCases { #expect(ios.contains("." + value.rawValue) && kotlin.contains("WordleRole." + value.rawValue), "\(value)") }
        for value in WordleOutcome.allCases { #expect(ios.contains("." + value.rawValue) && kotlin.contains("WordleOutcome." + value.rawValue), "\(value)") }
        for value in WordleStandingStatus.allCases {
            #expect(ios.contains("." + value.rawValue) && kotlin.contains("WordleStandingStatus." + value.rawValue), "\(value)")
        }

        #expect(ios.contains("ConclaveStrings.format(\"%lld tries\", count)") && kotlin.contains("conclavePlural(\"gm_wordle_tries\", tries, tries)"))
    }

    @Test func wordleStringsAreInBothCatalogs() throws {
        let catalogData = try Data(contentsOf: URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().appendingPathComponent("Sources/Conclave/Resources/Localizable.xcstrings"))
        let catalog = try #require(try JSONSerialization.jsonObject(with: catalogData) as? [String: Any])
        let strings = try #require(catalog["strings"] as? [String: Any])
        let ios = try stageSource(iosPath)
        var keys = Set<String>()
        for match in stageMatches(#"ConclaveStrings\.(?:text|format)\("[^"]+""#, in: ios) {
            if let start = match.firstIndex(of: "\"") { keys.insert(String(match[match.index(after: start)...].dropLast())) }
        }
        #expect(keys.count > 35)
        for key in keys { #expect(strings[key] != nil, "missing iOS key \(key)") }
        let triesEntry = try #require(strings["%lld tries"] as? [String: Any])
        #expect(String(describing: triesEntry).contains("1 try") || String(describing: triesEntry).contains("%lld try"))
        let xml = try stageSource("Android/app/src/main/res/values/strings.xml")
        let kotlin = try stageSource(kotlinPath)
        var names = Set<String>()
        for match in stageMatches(#""(?:gm|ds)_[a-z0-9_]+""#, in: kotlin) { names.insert(String(match.dropFirst().dropLast())) }
        #expect(names.count > 30)
        for name in names { #expect(xml.contains("name=\"" + name + "\""), "missing Android resource \(name)") }
        #expect(xml.contains("<plurals name=\"gm_wordle_tries\">"))
    }

    @Test func theShellRoutesWordleAndPinsItsHostBar() throws {
        let ios = stageNormalized(try stageSource("Sources/Conclave/Features/Meeting/Games/Native/GameShell+iOS.swift"))
        #expect(ios.contains("case GameSceneKind.wordle: WordleSceneBody(games: games)") && ios.contains("WordleHostBar(games: games)"))
        let kotlin = stageNormalized(try stageSource("Sources/Conclave/Skip/ui/games/GameShell.kt"))
        #expect(kotlin.contains("GameSceneKind.wordle -> WordleSceneBody(games)") && kotlin.contains("WordleHostBar(games)"))
        let models = try stageSource("Sources/Conclave/Features/Meeting/Activities/GameStageModels.swift")
        #expect(models.contains("let wordle: WordleScene?"))
    }
}
#endif
