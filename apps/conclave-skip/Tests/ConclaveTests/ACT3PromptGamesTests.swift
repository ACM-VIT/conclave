#if !SKIP
import Foundation
import Testing
@testable import Conclave

/// ACT-3 (OUT/PLAN-screens.md section 5, S60 9): the six prompt game scenes. Scene models built once per push from the
/// projections of packages/sfu/server/games/modules and checked against the module rules (Trivia correct, wrong, no
/// answer, late spectator, host skip; Bluff rejection with the composer kept and a delayed ack; Would You Rather tie and
/// zero votes; Most Likely To departed target, self vote and ties; Reaction early tap, held touch, double input and
/// spectator; Imposter private word separation, abstention, tie and departing target), the outcome tokens once per
/// transition, the host bar table, one-shot announcements, the fixtures, and source scans of both platforms' scenes and
/// the B1 pad. The Kotlin half is T/Skip/ACT3PromptBridgeTests.kt (HD request B6-T7 R6), on the same fixtures.
@MainActor
struct ACT3PromptGamesTests {
    private final class Recorder {
        var commands: [GameStageCommand] = []
    }

    private func presenter(_ state: PromptGameFixtureState, recorder: Recorder? = nil) -> GameStagePresenter {
        let games = GameStagePresenter()
        games.sleep = { _ in try? await Task.sleep(nanoseconds: 60_000_000_000) }
        if let recorder = recorder {
            games.onCommand = { command in recorder.commands.append(command) }
        }
        for inputs in PromptGameFixtures.pushes(state) {
            games.apply(inputs)
        }
        return games
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

    private func context(isPlayer: Bool = true, isHost: Bool = true, isRecovering: Bool = false,
                         known: [GameNamedPlayer] = []) -> PromptSceneContext {
        PromptSceneContext.make(localId: "you", isPlayer: isPlayer, isHost: isHost, isRecovering: isRecovering,
                                players: ActivityFixtureScript.players(6, includingYou: true), knownPlayers: known)
    }

    private func projection(_ gameId: String, _ phase: String, _ view: String, _ mine: String) -> GameProjection {
        GameProjectionParser.parse(gameId: gameId, publicPhase: phase, publicViewJSON: view, playerViewJSON: mine)
    }

    // MARK: Trivia (S60 9 l 1)

    @Test func triviaQuestionAnsweredRevealAndSpectator() throws {
        let answered = try #require(presenter(.triviaAnswered).scene.trivia)
        #expect(answered.hasAnswered && !answered.canAnswer && answered.isPlayer)
        #expect(answered.options.map { $0.id } == ["q2-0", "q2-1", "q2-2", "q2-3"])
        #expect(answered.questionNumber == 3 && answered.questionTotal == 7 && answered.category == "Science")
        let question = answered.kitChoices()
        #expect(question.allSatisfy { $0.count == -1 && $0.isDisabled })
        #expect(question[1].mark == GameKitMark.selected && question[0].mark == GameKitMark.none)
        #expect(answered.hostAction == PromptHostAction.skipQuestion)

        let reveal = try #require(presenter(.triviaReveal).scene.trivia)
        #expect(reveal.outcome == TriviaOutcome.wrong && reveal.correctText == "Saturn")
        let marks = reveal.kitChoices()
        // Correctness is never color alone: the kit row turns each mark into a glyph and a word.
        #expect(marks[0].mark == GameKitMark.wrongPick && marks[1].mark == GameKitMark.correct)
        #expect(marks.map { $0.count } == [2, 3, 0, 1])
        #expect(reveal.hostAction == PromptHostAction.next && reveal.score == 1900 && reveal.rank == 2)

        let timeUp = try #require(presenter([PromptGameFixtures.triviaPush(phase: "reveal", choice: -1)]).scene.trivia)
        #expect(timeUp.outcome == TriviaOutcome.timeUp)
        let correct = try #require(presenter([PromptGameFixtures.triviaPush(phase: "reveal", choice: 1)]).scene.trivia)
        #expect(correct.outcome == TriviaOutcome.correct && correct.lastPoints == 650)

        // Late spectator (INM G7): read-only, no outcome, no score, no host bar.
        let spectator = GameStagePresenter()
        spectator.apply(ActivityFixtureScript.gameInputs(.gameSpectator))
        let watching = try #require(spectator.scene.trivia)
        #expect(!watching.isPlayer && !watching.canAnswer && watching.outcome == TriviaOutcome.none)
        #expect(watching.score == 0 && watching.rank == 0 && watching.hostAction == PromptHostAction.none)
        #expect(watching.kitChoices().allSatisfy { !$0.isSelected })

        let empty = projection("trivia", "question", #"{"phase":"question","questionIndex":0,"totalQuestions":5,"options":[],"prompt":null}"#,
                               #"{"answered":false}"#)
        let waiting = PromptSceneBuilder.trivia(try #require(empty.trivia), context: context())
        #expect(waiting.isWaitingForQuestion && !waiting.canAnswer)
    }

    @Test func triviaOutcomeTokensFireOnceAtTheRevealForPlayersOnly() {
        let games = presenter([PromptGameFixtures.triviaPush(phase: "question", choice: 1)])
        let before = games.feedbackState.token.sequence
        games.apply(PromptGameFixtures.triviaPush(phase: "reveal", choice: 1))
        #expect(games.feedbackState.token.kind == FeedbackKind.gameCorrect && games.feedbackState.token.sequence == before + 1)
        games.apply(PromptGameFixtures.triviaPush(phase: "reveal", choice: 1))
        #expect(games.feedbackState.token.sequence == before + 1)
        let wrong = presenter([PromptGameFixtures.triviaPush(phase: "question", choice: 0),
                               PromptGameFixtures.triviaPush(phase: "reveal", choice: 0)])
        #expect(wrong.feedbackState.token.kind == FeedbackKind.gameWrong)
        let late = presenter([PromptGameFixtures.triviaPush(phase: "question", choice: -1),
                              PromptGameFixtures.triviaPush(phase: "reveal", choice: -1)])
        #expect(late.feedbackState.token.sequence == 0)
        let joinedAtReveal = presenter([PromptGameFixtures.triviaPush(phase: "reveal", choice: 1)])
        #expect(joinedAtReveal.feedbackState.token.sequence == 0)
    }

    @Test func anAnswerIsSentOnceAndIgnoredWhilePending() throws {
        let recorder = Recorder()
        let games = presenter([PromptGameFixtures.triviaPush(phase: "question", choice: -1)], recorder: recorder)
        let trivia = try #require(games.scene.trivia)
        #expect(trivia.canAnswer)
        #expect(games.send(GameMoveIntent.answer(trivia.index(ofChoice: "q2-1"))) == ActivityTapResult.dispatched)
        #expect(recorder.commands.last?.payloadJSON == #"{"choice":1}"#)
        #expect(games.send(GameMoveIntent.answer(2)) == ActivityTapResult.ignored)
        #expect(trivia.index(ofChoice: "q9-9") == -1)
    }

    // MARK: Bluff (S60 9 l 2)

    @Test func bluffDraftStaysUntilTheAckAndARejectionKeepsTheComposer() throws {
        let recorder = Recorder()
        let games = presenter(.bluffWrite, recorder: recorder)
        let write = try #require(games.scene.bluff)
        #expect(write.canSubmit && !write.hasSubmitted && write.hostAction == PromptHostAction.skipWriting)
        #expect(BluffScene.maxBluffLength == 60)
        #expect(games.send(GameMoveIntent.submitBluff("pinkness")) == ActivityTapResult.dispatched)
        let submit = try #require(recorder.commands.last)
        #expect(submit.payloadJSON == #"{"text":"pinkness"}"#)
        // Delayed ack: the push that records the bluff arrives first; the move stays pending and no second submit goes.
        let recorded = GameStageInputs.make(callSession: 1, isActive: true, gameId: "bluff", name: "Bluff", phase: "write",
                                            players: ActivityFixtureScript.players(6, includingYou: true), minPlayers: 1,
                                            publicViewJSON: PromptGameFixtures.publicView(.bluffWrite),
                                            playerViewJSON: #"{"yourFake":"pinkness","submitted":true,"yourPick":null,"ownOptionId":null,"score":0}"#,
                                            localPlayerId: "you", isHost: true, receivedAtMillis: 1)
        games.apply(recorded)
        let pending = try #require(games.scene.bluff)
        #expect(games.interaction.isPending && games.interaction.pendingType == "submit")
        #expect(pending.hasSubmitted && !pending.canSubmit && pending.myBluff == "pinkness")
        #expect(games.send(GameMoveIntent.submitBluff("again")) == ActivityTapResult.ignored)
        games.moveAcknowledged(requestId: submit.requestId, success: true, serverText: "")
        #expect(!games.interaction.isPending)

        let rejected = presenter(.bluffWrite, recorder: recorder)
        _ = rejected.send(GameMoveIntent.submitBluff("flamboyance"))
        let sequence = rejected.feedbackState.token.sequence
        rejected.moveAcknowledged(requestId: try #require(recorder.commands.last).requestId, success: false,
                                  serverText: "That is the real answer. Write a bluff.")
        #expect(rejected.interaction.failure == GameFailure.server)
        #expect(rejected.interaction.failureServerText == "That is the real answer. Write a bluff.")
        #expect(rejected.feedbackState.token.kind == FeedbackKind.moveRejected && rejected.feedbackState.token.sequence == sequence + 1)
        #expect(try #require(rejected.scene.bluff).canSubmit)
    }

    @Test func bluffChooseAndRevealFollowTheModule() throws {
        let choose = try #require(presenter(.bluffChoose).scene.bluff)
        #expect(choose.canChoose && choose.hostAction == PromptHostAction.revealNow)
        #expect(choose.options.filter { $0.isOwn }.map { $0.id } == ["o2"])
        #expect(choose.options.allSatisfy { !$0.isTruth && $0.ownerName.isEmpty && $0.votes == -1 })
        let rows = choose.kitChoices(ownLabel: "Your bluff")
        #expect(rows[1].isDisabled && rows[1].detail == "Your bluff" && !rows[0].isDisabled)

        let reveal = try #require(presenter(.bluffReveal).scene.bluff)
        #expect(reveal.options.filter { $0.isTruth }.map { $0.id } == ["o3"] && reveal.truthText == "flamboyance")
        let picked = try #require(reveal.options.first { $0.id == "o1" })
        #expect(picked.isMine && picked.ownerName == "Ben" && picked.votes == 2)
        #expect(reveal.roundPoints.map { $0.points } == [1000, 1000, 500] && reveal.roundPoints.last?.isYou == true)
        #expect(reveal.hostAction == PromptHostAction.next && PromptScenePolicy.bluffRevealKey(reveal) == "bluff-reveal-1")

        let spectator = PromptSceneBuilder.bluff(try #require(projection("bluff", "write", PromptGameFixtures.publicView(.bluffWrite),
                                                                         PromptGameFixtures.playerView(.bluffChoose)).bluff),
                                                 context: context(isPlayer: false, isHost: false))
        #expect(!spectator.canSubmit && spectator.myBluff.isEmpty && !spectator.hasSubmitted && spectator.score == 0)
    }

    // MARK: Would You Rather (S60 9 l 3)

    @Test func wouldYouRatherIsChangeableAndShowsTiesAndZeroVotes() throws {
        let choose = try #require(presenter(.wyrChoose).scene.wouldYouRather)
        #expect(choose.myChoice == 0 && choose.canChoose && choose.kitFirst().isSelected && !choose.kitSecond().isSelected)
        #expect(choose.hostAction == PromptHostAction.revealNow)
        #expect(ChoiceScene.option(forChoice: ChoiceScene.secondId) == 1 && ChoiceScene.option(forChoice: "x") == -1)
        let reveal = try #require(presenter(.wyrReveal).scene.wouldYouRather)
        let split = reveal.split(nobodyLabel: "Nobody picked this")
        #expect(split.namesB == ["Nobody picked this"] && split.countB == 0 && split.fractionA == 1.0)
        #expect(reveal.hostAction == PromptHostAction.next)
        let tie = PromptSceneBuilder.wouldYouRather(try #require(projection("would-you-rather", "reveal",
            #"{"phase":"reveal","index":0,"total":6,"optionA":"A","optionB":"B","counts":[2,2],"namesA":["A1","A2"],"namesB":["B1","B2"],"answeredCount":4,"totalPlayers":4}"#,
            "").wouldYouRather), context: context(isPlayer: false, isHost: false))
        #expect(tie.split(nobodyLabel: "x").fractionA == 0.5 && tie.split(nobodyLabel: "x").namesA == ["A1", "A2"])
        #expect(tie.hostAction == PromptHostAction.none && tie.myChoice == -1 && !tie.canChoose)
    }

    // MARK: Most Likely To (S60 9 l 4)

    @Test func mostLikelyToNamesADepartedTargetAllowsSelfVotesAndShowsTies() throws {
        let vote = try #require(presenter(.mltVote).scene.mostLikelyTo)
        #expect(vote.departedName == "Fen" && !vote.candidates.contains { $0.isMine })
        let me = try #require(vote.candidates.first { $0.isYou })
        #expect(me.isEligible && vote.candidates.allSatisfy { $0.isEligible && $0.votes == -1 })
        #expect(vote.kitChoices(youLabel: "You").first?.text == "You" && vote.hostAction == PromptHostAction.revealNow)

        let tie = try #require(presenter(.mltRevealTie).scene.mostLikelyTo)
        #expect(tie.isTie && tie.tiedNames == ["Avery", "Ben"])
        #expect(tie.candidates.filter { $0.isWinner }.map { $0.id } == ["r1", "r2"])
        #expect(tie.candidates.first { $0.id == "r1" }?.isMine == true && tie.candidates.first { $0.id == "r4" }?.votes == 0)
        #expect(PromptScenePolicy.voteRevealKey(tie) == "vote-reveal-4")

        let single = PromptSceneBuilder.mostLikelyTo(try #require(projection("most-likely-to", "reveal",
            #"{"phase":"reveal","index":0,"total":6,"prompt":"to win","players":[{"id":"you","name":"You"},{"id":"r1","name":"Avery"}],"counts":{"r1":3},"winnerId":"r1","winnerName":"Avery"}"#,
            #"{"yourVote":"you"}"#).mostLikelyTo), context: context())
        #expect(!single.isTie && single.winnerName == "Avery" && single.candidates.first { $0.isYou }?.isMine == true)
    }

    // MARK: Reaction (S60 9 l 5)

    @Test func reactionPadStatesEarlyTapRowsAndOneTap() throws {
        let arming = try #require(presenter(.reactionArming).scene.reaction)
        #expect(arming.padState == ReactionPadState.wait && arming.canTap && arming.round == 2 && arming.isPadPhase)
        // A tap this device sent shows "Locked In" until the server echoes it (held touch, late event).
        #expect(arming.displayedPadState(locallySent: true) == ReactionPadState.locked)
        #expect(PromptScenePolicy.reactionGoKey(arming).isEmpty)
        let go = try #require(presenter(.reactionGo).scene.reaction)
        #expect(go.padState == ReactionPadState.go && PromptScenePolicy.reactionGoKey(go) == "reaction-go-2")
        #expect(go.phaseKey != arming.phaseKey)

        let early = presenter(.reactionArming)
        early.apply(PromptGameFixtures.earlyTapPush())
        let earlyScene = try #require(early.scene.reaction)
        #expect(earlyScene.padState == ReactionPadState.early && !earlyScene.canTap)
        #expect(early.feedbackState.token.kind == FeedbackKind.tapEarly && early.feedbackState.token.sequence == 1)
        early.apply(PromptGameFixtures.earlyTapPush())
        #expect(early.feedbackState.token.sequence == 1)

        let reveal = try #require(presenter(.reactionReveal).scene.reaction)
        #expect(reveal.results.map { $0.id } == ["r1", "you", "r3", "r2", "r4", "r5"])
        #expect(reveal.results.map { $0.outcome } == [ReactionResultOutcome.time, .time, .time, .early, .noTap, .noTap])
        #expect(reveal.results.map { $0.position } == [1, 2, 3, 4, 5, 6] && reveal.results[0].isFastest && reveal.results[1].isYou)
        #expect(reveal.results[3].ms == -1 && reveal.fastestName == "Avery" && reveal.hostAction == PromptHostAction.next)

        // Held touch and double input: the second tap is ignored while the first is pending.
        let recorder = Recorder()
        let games = presenter(.reactionGo, recorder: recorder)
        #expect(games.send(GameMoveIntent.tap()) == ActivityTapResult.dispatched)
        #expect(games.send(GameMoveIntent.tap()) == ActivityTapResult.ignored)
        #expect(recorder.commands.filter { $0.type == "tap" }.count == 1 && recorder.commands.last?.payloadJSON == "")

        let watcher = PromptSceneBuilder.reaction(try #require(projection("reaction", "go", PromptGameFixtures.publicView(.reactionGo), "").reaction),
                                                  context: context(isPlayer: false, isHost: false))
        #expect(watcher.padState == ReactionPadState.spectating && !watcher.canTap)
        #expect(watcher.displayedPadState(locallySent: false) == ReactionPadState.spectating)
    }

    // MARK: Imposter (S60 9 l 6, Q7)

    @Test func imposterWordReachesOnlyASeatedCrewMember() throws {
        let crew = try #require(presenter(.imposterCrew).scene.imposter)
        #expect(crew.role == ImposterRole.crew && crew.secretWord == "Library" && crew.showsSecretCard)
        #expect(crew.hostAction == PromptHostAction.callVote && crew.canCallVote)
        let imposterGames = presenter(.imposterImposter)
        let imposter = try #require(imposterGames.scene.imposter)
        #expect(imposter.role == ImposterRole.imposter && imposter.secretWord.isEmpty && imposter.showsSecretCard)
        #expect(!String(describing: imposterGames.scene).contains("Library"))
        let spectatorGames = presenter(.imposterSpectator)
        let spectator = try #require(spectatorGames.scene.imposter)
        #expect(spectator.role == ImposterRole.spectator && spectator.secretWord.isEmpty && !spectator.showsSecretCard)
        #expect(!spectator.isPlayer && spectator.hostAction == PromptHostAction.none && spectatorGames.chrome.seat == SeatState.watching)
        #expect(!String(describing: spectatorGames.scene).contains("Library"))
        // A spectator cannot hold a crew word even if a stray player view arrived.
        let stray = PromptSceneBuilder.imposter(try #require(projection("imposter", "discuss", PromptGameFixtures.publicView(.imposterCrew),
                                                                         PromptGameFixtures.playerView(.imposterCrew)).imposter),
                                                context: context(isPlayer: false, isHost: false))
        #expect(stray.secretWord.isEmpty && stray.role == ImposterRole.spectator)
    }

    @Test func imposterVoteAbstentionTieAndDepartingTarget() throws {
        let vote = try #require(presenter(.imposterVote).scene.imposter)
        #expect(vote.isVoting && vote.canVote && vote.canTally && vote.hostAction == PromptHostAction.endVote)
        #expect(vote.candidates.first { $0.isYou }?.isEligible == false && vote.votedCount == 2)
        #expect(vote.candidates.allSatisfy { $0.votes == -1 })
        let rows = vote.kitChoices(youLabel: "You")
        #expect(rows.first { $0.id == "you" }?.isDisabled == true && rows.first { $0.id == "you" }?.detail == "You")

        let resultGames = presenter(.imposterResult)
        let result = try #require(resultGames.scene.imposter)
        #expect(resultGames.chrome.phase == GameChromePhase.results)
        #expect(result.resultKind == ImposterResultKind.crewWins && result.abstained && result.imposterName == "Cai")
        #expect(result.revealedWord == "Library" && result.candidates.first { $0.id == "r3" }?.votes == 4)

        let tie = PromptSceneBuilder.imposter(try #require(projection("imposter", "result",
            #"{"phase":"result","category":"Places","players":[{"id":"you","name":"You"},{"id":"r1","name":"Avery"}],"votedPlayerIds":["you","r1"],"voteCounts":{"r1":1,"you":1},"result":{"imposterId":"r1","imposterName":"Avery","word":"Beach","votedOutId":null,"votedOutName":null,"crewWon":false,"tie":true}}"#,
            #"{"role":"crew","word":"Beach","yourVote":"r1"}"#).imposter), context: context())
        #expect(tie.resultKind == ImposterResultKind.tie && !tie.abstained)

        let departing = PromptSceneBuilder.imposter(try #require(projection("imposter", "vote",
            #"{"phase":"vote","category":"Places","players":[{"id":"you","name":"You"},{"id":"r1","name":"Avery"}],"votedPlayerIds":["you"],"voteCounts":{},"result":null}"#,
            #"{"role":"crew","word":"Beach","yourVote":"r9"}"#).imposter),
            context: context(known: [GameNamedPlayer(id: "r9", name: "Ivo")]))
        #expect(departing.departedName == "Ivo" && departing.myVote.isEmpty)
    }

    // MARK: Host bar, announcements, fixtures

    @Test func hostActionsFollowTheTableOnlyForASeatedHost() {
        let host = context()
        let table: [(String, String, PromptHostAction)] = [
            (GameSceneKind.trivia, "question", .skipQuestion), (GameSceneKind.trivia, "reveal", .next),
            (GameSceneKind.bluff, "write", .skipWriting), (GameSceneKind.bluff, "choose", .revealNow), (GameSceneKind.bluff, "reveal", .next),
            (GameSceneKind.wouldYouRather, "choose", .revealNow), (GameSceneKind.wouldYouRather, "reveal", .next),
            (GameSceneKind.mostLikelyTo, "vote", .revealNow), (GameSceneKind.mostLikelyTo, "reveal", .next),
            (GameSceneKind.reaction, "arming", PromptHostAction.none), (GameSceneKind.reaction, "go", PromptHostAction.none), (GameSceneKind.reaction, "reveal", .next),
            (GameSceneKind.imposter, "reveal", PromptHostAction.none), (GameSceneKind.imposter, "discuss", .callVote), (GameSceneKind.imposter, "vote", .endVote),
        ]
        for (kind, phase, action) in table {
            #expect(PromptSceneBuilder.hostAction(kind: kind, phase: phase, context: host) == action, "\(kind) \(phase)")
            #expect(PromptSceneBuilder.hostAction(kind: kind, phase: phase, context: context(isHost: false)) == PromptHostAction.none)
            #expect(PromptSceneBuilder.hostAction(kind: kind, phase: phase, context: context(isPlayer: false)) == PromptHostAction.none)
            #expect(PromptSceneBuilder.hostAction(kind: kind, phase: phase, context: context(isRecovering: true)) == PromptHostAction.none)
        }
        #expect(PromptHostAction.allCases.map { $0.moveType } == ["", "skip", "next", "skip", "skip", "callVote", "tally"])
        for action in PromptHostAction.allCases where action != PromptHostAction.none {
            #expect(action.intent().type == action.moveType && GameMoveAdapter.payloadJSON(action.intent()).isEmpty)
        }
        #expect(PromptScenePolicy.isPromptGame(GameSceneKind.imposter) && !PromptScenePolicy.isPromptGame(GameSceneKind.wordle))
    }

    @Test func announcementsAreClaimedOncePerGameSession() {
        let games = presenter(.triviaReveal)
        #expect(games.claimAnnouncement("trivia-reveal-2") && !games.claimAnnouncement("trivia-reveal-2"))
        #expect(!games.claimAnnouncement(""))
        games.apply(ActivityFixtureScript.gameInputs(.gameLobbyHost))
        #expect(games.claimAnnouncement("trivia-reveal-2"))
        games.reset()
        #expect(games.claimAnnouncement("trivia-reveal-2"))
    }

    @Test func everyPromptFixtureBuildsItsScene() throws {
        #expect(PromptGameFixtureState.allCases.count == 17)
        let base = StageFixtureScript.inputs(for: .grid6)
        for state in PromptGameFixtureState.allCases {
            #expect(PromptGameFixtures.state(named: state.rawValue) == state)
            #expect(ActivityFixtureState(rawValue: state.rawValue) == nil, "\(state.rawValue) collides with an ACT-2 state")
            let games = presenter(state)
            #expect(games.chrome.isKnownGame && PromptScenePolicy.isPromptGame(games.scene.projection.kind), "\(state.rawValue)")
            #expect(PromptScenePolicy.isPromptGame(games.scene.kind), "\(state.rawValue) shows \(games.scene.kind)")
            let stage = PromptGameFixtures.stageInputs(named: state.rawValue, base: base)
            #expect(stage.isGameActive && stage.gameName == PromptGameFixtures.gameName(state))
        }
        #expect(PromptGameFixtures.at(0) == "1700000600000")
    }

    // MARK: Source scans (both platforms)

    private func sources(_ directory: String, _ ext: String) throws -> String {
        var text = ""
        for file in try stageFiles(under: directory, extensions: [ext]) { text += try stageSource(file) }
        return text
    }

    @Test func theReactionPadSendsOneTapAndChangesInOneFrame() throws {
        let ios = stageNormalized(try stageSource("Sources/Conclave/Features/Meeting/Games/Native/Boards/ReactionPad+iOS.swift"))
        #expect(ios.contains("DragGesture(minimumDistance: 0).onChanged { _ in fire() }"))
        #expect(ios.contains(".accessibilityAction { fire() }") && ios.contains(".onKeyPress(.space)") && ios.contains(".onKeyPress(.return)"))
        #expect(ios.contains("DesignTokens.iosInCallSuccess") && ios.contains("DesignTokens.iosInCallOnControlOff"))
        #expect(ios.contains(".onChange(of: scene.phaseKey) { sent = false }") && ios.contains("urgent: true"))
        #expect(ios.contains(".conclaveGestureFeedback(.tapValid, trigger: validTaps)") && ios.contains("if showedGo { validTaps += 1 }"))
        let kotlin = stageNormalized(try stageSource("Sources/Conclave/Skip/ui/games/boards/ReactionPad.kt"))
        #expect(kotlin.contains("awaitEachGesture { awaitFirstDown(requireUnconsumed = false) latestFire() }"))
        #expect(kotlin.contains("onClick(label = tapLabel)") && kotlin.contains("Key.Spacebar") && kotlin.contains("Key.Enter"))
        #expect(kotlin.contains("remember(scene.phaseKey)") && kotlin.contains("assertive = true") && kotlin.contains("ext.onWarning"))
        #expect(kotlin.contains("if (showedGo) haptics.gesture(FeedbackKind.tapValid)"))
        for forbidden in ["withAnimation", ".animation(", "onLongPressGesture", "animate", "Color.white", "Color.White"] {
            #expect(!ios.contains(forbidden) && !kotlin.contains(forbidden), "the pad uses \(forbidden)")
        }
        let shared = stageNormalized(try stageSource("Sources/Conclave/Skip/ui/games/scenes/PromptGameScene.kt"))
        #expect(shared.contains("liveRegion = if (assertive) LiveRegionMode.Assertive else LiveRegionMode.Polite"))
    }

    @Test func scenesKeepTheDraftTheWordAndCorrectnessTwins() throws {
        let ios = try sources("Sources/Conclave/Features/Meeting/Games/Native/Scenes", "swift")
        let kotlin = try sources("Sources/Conclave/Skip/ui/games/scenes", "kt")
        let flatIOS = stageNormalized(ios)
        let flatKotlin = stageNormalized(kotlin)
        // Bluff: the draft is view state that survives pushes, kept on a rejection, cleared by a new round only.
        #expect(flatIOS.contains("@State private var draft = \"\"") && flatIOS.contains(".onChange(of: scene.round) { draft = \"\" }"))
        #expect(flatIOS.contains("scene.isPlayer && (scene.canSubmit || pending)"))
        #expect(flatKotlin.contains("rememberSaveable(scene.round)") && flatKotlin.contains("scene.isPlayer && (scene.canSubmit || pending)"))
        // Imposter: the word goes only into the K11 card (composed only while held), never into a plain Text.
        #expect(flatIOS.contains("secret: PromptGameCopy.secret(scene)") && flatKotlin.contains("secret = imposterSecret(scene)"))
        for leak in ["Text(scene.secretWord", "Text(imposter.secretWord", "accessibilityLabel(scene.secretWord", "contentDescription = scene.secretWord"] {
            #expect(!ios.contains(leak) && !kotlin.contains(leak), "the word leaks through \(leak)")
        }
        // Correctness and the winner always come with a glyph and a word next to the success border.
        #expect(flatIOS.contains("markText: option.isTruth ? PromptGameCopy.truth() : \"\"") && flatIOS.contains("emphasis: option.isTruth ? .success"))
        #expect(flatIOS.contains("markText: candidate.isWinner ? PromptGameCopy.mostVotes() : \"\"") && flatIOS.contains("emphasis: candidate.isWinner ? .success"))
        #expect(flatIOS.contains("Label(markText, systemImage: ConclaveSymbols.checkmark)"))
        #expect(flatKotlin.contains("markText = if (option.isTruth) truth else \"\"") && flatKotlin.contains("option.isTruth -> PromptRowEmphasis.Success"))
        #expect(flatKotlin.contains("markText = if (candidate.isWinner) mostVotes else \"\"") && flatKotlin.contains("candidate.isWinner -> PromptRowEmphasis.Success"))
        #expect(flatKotlin.contains("Icon(ConclaveIcons.CheckFill0, contentDescription = null"))
        // Gestures play only for a sent move.
        for kind in ["answerLocked", "bluffSubmitted", "voteCast", "revealHeld"] {
            #expect(ios.contains(".conclaveGestureFeedback(." + kind) && kotlin.contains("haptics.gesture(FeedbackKind." + kind + ")"), "\(kind)")
        }
        // Scenes read typed models only; nothing decorative moves.
        for forbidden in ["GameJSONValue", "dictionaryValue", "MeetingState", "MeetingViewModel", "confetti", "withAnimation", ".animation(",
                          "Font.system(size:", "onLongPressGesture"] {
            #expect(!ios.contains(forbidden) && !kotlin.contains(forbidden), "a scene uses \(forbidden)")
        }
    }

    @Test func everyPromptEnumCaseHasCopyOnBothPlatforms() throws {
        let ios = try stageSource("Sources/Conclave/Features/Meeting/Games/Native/Scenes/PromptGameCopy+iOS.swift")
        let kotlin = try stageSource("Sources/Conclave/Skip/ui/games/scenes/PromptGameCopy.kt")
        for value in TriviaOutcome.allCases { #expect(ios.contains("." + value.rawValue) && kotlin.contains("TriviaOutcome." + value.rawValue), "\(value)") }
        for value in ReactionPadState.allCases { #expect(ios.contains("." + value.rawValue) && kotlin.contains("ReactionPadState." + value.rawValue), "\(value)") }
        for value in ReactionResultOutcome.allCases {
            #expect(ios.contains("." + value.rawValue) && kotlin.contains("ReactionResultOutcome." + value.rawValue), "\(value)")
        }
        for value in ImposterRole.allCases { #expect(ios.contains("." + value.rawValue) && kotlin.contains("ImposterRole." + value.rawValue), "\(value)") }
        for value in ImposterResultKind.allCases {
            #expect(ios.contains("." + value.rawValue) && kotlin.contains("ImposterResultKind." + value.rawValue), "\(value)")
        }
        for value in PromptHostAction.allCases { #expect(ios.contains("." + value.rawValue) && kotlin.contains("PromptHostAction." + value.rawValue), "\(value)") }
    }

    /// True after the batch 6 strings merge (HD/strings/B6-T7.json).
    @Test func promptStringsAreInBothCatalogs() throws {
        let catalogData = try Data(contentsOf: URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().appendingPathComponent("Sources/Conclave/Resources/Localizable.xcstrings"))
        let catalog = try #require(try JSONSerialization.jsonObject(with: catalogData) as? [String: Any])
        let strings = try #require(catalog["strings"] as? [String: Any])
        var ios = try sources("Sources/Conclave/Features/Meeting/Games/Native/Scenes", "swift")
        ios += try stageSource("Sources/Conclave/Features/Meeting/Games/Native/Boards/ReactionPad+iOS.swift")
        var keys = Set<String>()
        for match in stageMatches(#"ConclaveStrings\.(?:text|format)\("[^"]+""#, in: ios) {
            if let start = match.firstIndex(of: "\"") { keys.insert(String(match[match.index(after: start)...].dropLast())) }
        }
        #expect(keys.count > 60)
        for key in keys { #expect(strings[key] != nil, "missing iOS key \(key)") }
        let xml = try stageSource("Android/app/src/main/res/values/strings.xml")
        var kotlin = try sources("Sources/Conclave/Skip/ui/games/scenes", "kt")
        kotlin += try stageSource("Sources/Conclave/Skip/ui/games/boards/ReactionPad.kt")
        var names = Set<String>()
        for match in stageMatches(#""(?:act|gm|ds)_[a-z0-9_]+""#, in: kotlin) { names.insert(String(match.dropFirst().dropLast())) }
        #expect(names.count > 60)
        for name in names { #expect(xml.contains("name=\"" + name + "\""), "missing Android resource \(name)") }
    }

    /// True after HD requests B6-T7 R2 and R3 (the shell hooks).
    @Test func theShellRoutesThePromptGamesAndPinsTheirHostBar() throws {
        let ios = stageNormalized(try stageSource("Sources/Conclave/Features/Meeting/Games/Native/GameShell+iOS.swift"))
        #expect(ios.contains("PromptGameSceneBody(games: games)") && ios.contains("PromptGameHostBar(games: games)"))
        let kotlin = stageNormalized(try stageSource("Sources/Conclave/Skip/ui/games/GameShell.kt"))
        #expect(kotlin.contains("PromptGameSceneBody(games)") && kotlin.contains("PromptGameHostBar(games)"))
    }
}
#endif
