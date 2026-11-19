#if !SKIP
import Foundation
import Testing
@testable import Conclave

@MainActor
struct ACT11LongShotTests {
    private final class Recorder {
        var commands: [GameStageCommand] = []
    }

    private struct Fixture {
        let root: [String: Any]

        static func load() throws -> Fixture {
            let url = try #require(Bundle.module.url(forResource: "LongShotFixtures", withExtension: "json"))
            let object = try JSONSerialization.jsonObject(with: Data(contentsOf: url))
            return Fixture(root: try #require(object as? [String: Any]))
        }

        func snapshot(_ name: String) throws -> [String: Any] {
            let snapshots = try #require(root["snapshots"] as? [String: Any])
            return try #require(snapshots[name] as? [String: Any], "missing snapshot \(name)")
        }

        func catalog() throws -> GameCatalogEntry {
            let entry = try #require(root["catalog"])
            return try JSONDecoder().decode(GameCatalogEntry.self, from: JSONSerialization.data(withJSONObject: entry))
        }
    }

    private static let host = "host"
    private static let sam = "p2"
    private static let robin = "p3"
    private static let watcher = "watch"
    private static let late = "late"

    private func json(_ value: Any) throws -> String {
        String(decoding: try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]), as: UTF8.self)
    }

    private func inputs(_ name: String, viewer: String, recovering: Bool = false, gameId: String? = nil, privateFrom: String? = nil,
                        patch: (inout [String: Any]) -> Void = { _ in }) throws -> GameStageInputs {
        let fixture = try Fixture.load()
        let snapshot = try fixture.snapshot(name)
        var envelope = try #require(snapshot["public"] as? [String: Any])
        var view = try #require(envelope["view"] as? [String: Any])
        patch(&view)
        envelope["view"] = view
        if let gameId = gameId { envelope["gameId"] = gameId }
        let state = try JSONDecoder().decode(GamePublicState.self, from: JSONSerialization.data(withJSONObject: envelope))
        var playerView = ""
        let privateSnapshot = try fixture.snapshot(privateFrom ?? name)
        if let views = privateSnapshot["views"] as? [String: Any], let mine = views[viewer] {
            playerView = try JSONDecoder().decode(GameJSONValue.self, from: JSONSerialization.data(withJSONObject: mine)).rawJSON
        }
        var config: [ActivityOptionValue] = []
        for key in (state.config ?? [:]).keys.sorted() {
            guard let value = state.config?[key] else { continue }
            config.append(ActivityOptionValue(id: key, isNumber: value.numberValue != nil, number: value.numberValue ?? 0, text: value.stringValue ?? ""))
        }
        let catalog = MeetingViewModel.activityGameInput(try fixture.catalog())
        return GameStageInputs.make(callSession: 1, isActive: true, gameId: state.gameId, name: state.name, phase: state.phase,
                                    players: state.players.map { GamePlayerInput(id: $0.id, name: $0.name) },
                                    pendingJoiners: (state.pendingJoiners ?? []).map { GamePlayerInput(id: $0.id, name: $0.name) },
                                    isFinished: state.finished, canJoinLate: state.canJoinLate ?? false, config: config,
                                    options: catalog.options, minPlayers: catalog.minPlayers, publicViewJSON: state.view?.rawJSON ?? "",
                                    playerViewJSON: playerView, selfId: viewer, localPlayerId: viewer, isHost: viewer == Self.host,
                                    isRecovering: recovering, receivedAtMillis: (view["serverNow"] as? Double) ?? 0)
    }

    private func presenter(_ names: [String], viewer: String, recorder: Recorder? = nil) throws -> GameStagePresenter {
        let games = GameStagePresenter()
        games.sleep = { _ in try? await Task.sleep(nanoseconds: 60_000_000_000) }
        if let recorder = recorder {
            games.onCommand = { command in recorder.commands.append(command) }
        }
        for name in names {
            games.apply(try inputs(name, viewer: viewer))
        }
        return games
    }

    private func scene(_ name: String, viewer: String) throws -> LongShotScene {
        try #require(try presenter([name], viewer: viewer).scene.longShot, "\(name) has no Long Shot scene")
    }

    private func projection(_ name: String, viewer: String) throws -> LongShotProjection {
        let built = try inputs(name, viewer: viewer)
        let parsed = GameProjectionParser.parse(gameId: built.gameId, publicPhase: built.phase, publicViewJSON: built.publicViewJSON,
                                                playerViewJSON: built.playerViewJSON)
        return try #require(parsed.longShot)
    }

    @Test func outOfRangeLongShotNumbersMakeTheGameUnavailable() throws {
        for (field, value) in [
            ("promptIndex", 1e30 as Any),
            ("promptIndex", Int32.max as Any),
            ("tierPoints", ["obvious": -1e30] as Any),
        ] {
            let fixture = try inputs("classic-prompt-open", viewer: Self.host) { $0[field] = value }
            let games = GameStagePresenter()
            games.apply(fixture)
            #expect(games.scene.longShot == nil)
            #expect(!games.chrome.isKnownGame)
        }
        for (gameId, json) in [
            ("trivia", #"{"optionCounts":[1,1e30]}"#),
            ("most-likely-to", #"{"counts":{"host":-1e30}}"#),
        ] {
            let projection = GameProjectionParser.parse(gameId: gameId, publicPhase: "question", publicViewJSON: json, playerViewJSON: "")
            #expect(!projection.isKnownGame)
        }
    }

    @Test func theLongShotHostSkipEmitsTheServerMove() throws {
        let recorder = Recorder()
        let games = try presenter(["classic-prompt-open"], viewer: Self.host, recorder: recorder)
        let action = PromptScenePolicy.hostAction(games.scene)
        #expect(games.send(action.intent()) == .dispatched)
        let command = try #require(recorder.commands.last)
        #expect(command.kind == .move && command.type == "skip" && command.payloadJSON.isEmpty)
    }

    @Test func judgedMovesWaitForTheServerAndReconcileALateAck() async throws {
        let recorder = Recorder()
        let games = try presenter(["classic-prompt-open"], viewer: Self.host, recorder: recorder)
        var scheduledWait: Double?
        games.sleep = { millis in
            scheduledWait = millis
            try? await Task.sleep(nanoseconds: 60_000_000_000)
        }
        games.setLongShotDraft("Modula-2")
        #expect(games.submitLongShot() == .dispatched)
        let command = try #require(recorder.commands.last)
        for _ in 0..<100 {
            if scheduledWait != nil { break }
            await Task.yield()
        }
        #expect((scheduledWait ?? 0) > GameStagePresenter.moveTimeoutMillis)
        games.fireTimeout(requestId: command.requestId)
        #expect(!games.interaction.isPending)
        games.moveAcknowledged(requestId: command.requestId, success: true, serverText: "")
        #expect(games.interaction.failure == .none)
        #expect(games.longShotDraft.isEmpty)
    }

    @Test func everyServerSnapshotParsesIntoItsTypedRound() throws {
        let expected: [(String, LongShotMode, LongShotStage)] = [
            ("classic-lobby", .classic, .lobby), ("classic-ready", .classic, .dive), ("classic-prompt-open", .classic, .dive),
            ("classic-prompt-miss", .classic, .dive), ("classic-reveal", .classic, .reveal), ("classic-ready-seated", .classic, .dive),
            ("classic-reveal-no-answer", .classic, .reveal), ("classic-results", .classic, .results), ("fuse-lobby", .fuse, .lobby),
            ("fuse-turn", .fuse, .fuse), ("fuse-miss-used", .fuse, .fuse), ("fuse-chain-judged", .fuse, .fuse), ("fuse-heart", .fuse, .fuse),
            ("fuse-paused", .fuse, .fuse), ("fuse-popped", .fuse, .popped), ("fuse-popped-out", .fuse, .popped), ("fuse-results", .fuse, .results),
        ]
        let snapshots = try #require(try Fixture.load().root["snapshots"] as? [String: Any])
        #expect(Set(snapshots.keys) == Set(expected.map { $0.0 }))
        for (name, mode, stage) in expected {
            let games = try presenter([name], viewer: Self.host)
            let scene = try #require(games.scene.longShot, "\(name)")
            #expect(scene.mode == mode && scene.stage == stage, "\(name) is \(scene.mode) \(scene.stage)")
            #expect(games.chrome.isKnownGame && games.chrome.gameId == "long-shot", "\(name)")
            let kind = stage == .lobby ? GameSceneKind.lobby : GameSceneKind.longShot
            #expect(games.scene.kind == kind, "\(name) shows \(games.scene.kind)")
        }
        #expect(try projection("classic-ready", viewer: Self.host).round == .ready(LongShotDive(
            prompt: LongShotPromptCard(category: "Tech", text: "Name a programming language", number: 1, total: 3), lockedCount: 0, totalPlayers: 3)))
    }

    @Test func theLadderCarriesEveryTierAtItsServerDepth() throws {
        let ladder = try projection("classic-prompt-open", viewer: Self.host).ladder
        #expect(ladder.map { $0.tier } == LongShotTier.depthOrder)
        #expect(ladder.map { $0.points } == [100, 150, 300, 600, 850, 1000])
        let open = try #require(try scene("classic-prompt-open", viewer: Self.sam).board.dive)
        #expect(open.rungs.count == 6 && open.rungs.allSatisfy { !$0.isLanded } && open.landedIndex == -1)
    }

    @Test func aLandedAnswerLocksYourRungAndAMissKeepsTheFieldOpen() throws {
        let hostScene = try scene("classic-prompt-miss", viewer: Self.host)
        let landed = try #require(hostScene.board.dive)
        #expect(landed.landing == LongShotLanding(text: "Python", tier: .obvious, points: 100, isJudged: false))
        #expect(landed.landedIndex == 0 && landed.rungs[0].isLanded && landed.rungs[0].word == "Python")
        #expect(landed.depth == 100 && landed.gain == 100 && landed.miss == nil)
        #expect(!hostScene.entry.isShown && !hostScene.entry.canSubmit)
        #expect(landed.lockedCount == 1 && landed.totalPlayers == 3)

        let samScene = try scene("classic-prompt-miss", viewer: Self.sam)
        let missed = try #require(samScene.board.dive)
        #expect(missed.landing == nil && missed.miss?.text == "Zzyzx" && missed.miss?.reason == .notListed)
        #expect(samScene.entry.isShown && samScene.entry.canSubmit && samScene.entry.action == .dive && samScene.entry.hint == .answer)
    }

    @Test func theReadyCountdownShowsThePromptButHoldsTheField() throws {
        let games = try presenter(["classic-ready"], viewer: Self.host)
        let scene = try #require(games.scene.longShot)
        #expect(scene.board.dive?.isReady == true && scene.entry.isShown && !scene.entry.canSubmit && scene.entry.hint == .getReady)
        #expect(scene.hostAction == .none)
        let countdown = try #require(games.countdown)
        #expect(countdown.durationMillis == 3000 && countdown.secondsLeft(nowMillis: games.inputs.receivedAtMillis) == 3)
        #expect(games.chrome.roundIndex == 1 && games.chrome.roundTotal == 3)

        let open = try presenter(["classic-prompt-open"], viewer: Self.host)
        #expect(open.countdown?.durationMillis == 25000)
        #expect(try presenter(["classic-reveal"], viewer: Self.host).countdown == nil)
        #expect(try presenter(["fuse-turn"], viewer: Self.host).countdown == nil)
        #expect(try presenter(["fuse-turn"], viewer: Self.host).chrome.roundTotal == 0)
    }

    @Test func theRevealShowsJudgedAnswersThePearlAndWhatNobodyFound() throws {
        let reveal = try #require(try scene("classic-reveal", viewer: Self.robin).board.reveal)
        #expect(reveal.rows.map { $0.name } == ["Sam", "Robin", "Avery"])
        #expect(reveal.rows[0].landing == LongShotLanding(text: "APL", tier: .pearl, points: 1000, isJudged: false))
        #expect(reveal.rows[1].landing == LongShotLanding(text: "Modula-2", tier: .rare, points: 600, isJudged: true) && reveal.rows[1].isYou)
        #expect(reveal.rows[2].landing?.text == "Python" && reveal.rows[2].landing?.isJudged == false)
        #expect(reveal.pearl == LongShotPearl(answer: "APL", foundBy: ["Sam"]))
        #expect(reveal.missedGems.count == 5 && !reveal.missedGems.contains("Modula-2"))
        #expect(reveal.depth == 600 && reveal.gain == 600)

        let silent = try #require(try scene("classic-reveal-no-answer", viewer: Self.host).board.reveal)
        let quiet = try #require(silent.rows.first { $0.id == Self.sam })
        #expect(quiet.landing == nil && silent.rows.last?.id == Self.sam)
        #expect(silent.rows.first { $0.id == Self.late }?.landing?.tier == .cliche)
    }

    @Test func hostControlsAreTheMovesTheServerAccepts() throws {
        let cases: [(String, PromptHostAction)] = [
            ("classic-lobby", .none), ("classic-ready", .none), ("classic-prompt-open", .skipPrompt), ("classic-reveal", .next),
            ("classic-results", .none), ("fuse-turn", .skipPrompt), ("fuse-paused", .skipPrompt), ("fuse-popped", .next),
        ]
        for (name, action) in cases {
            let games = try presenter([name], viewer: Self.host)
            #expect(PromptScenePolicy.hostAction(games.scene) == action, "\(name)")
            if action != .none {
                #expect(GameShellBarPolicy.content(chrome: games.chrome, scene: games.scene, results: games.results) == .promptHost, "\(name)")
            }
            #expect(PromptScenePolicy.hostAction(try presenter([name], viewer: Self.sam).scene) == .none, "\(name) for a guest")
        }
        let recorder = Recorder()
        let host = try presenter(["classic-prompt-open"], viewer: Self.host, recorder: recorder)
        #expect(host.send(PromptHostAction.skipPrompt.intent()) == .dispatched)
        #expect(recorder.commands.last?.type == "skip" && recorder.commands.last?.payloadJSON == "")
        let popped = try presenter(["fuse-popped"], viewer: Self.host, recorder: recorder)
        #expect(popped.send(PromptHostAction.next.intent()) == .dispatched && recorder.commands.last?.type == "next")
        #expect(GameShellBarPolicy.content(chrome: try presenter(["classic-results"], viewer: Self.host).chrome,
                                           scene: try presenter(["classic-results"], viewer: Self.host).scene,
                                           results: try presenter(["classic-results"], viewer: Self.host).results) == .rematch)
    }

    @Test func answersSendTheTextPayloadTheServerDecodes() throws {
        let recorder = Recorder()
        let games = try presenter(["classic-prompt-open"], viewer: Self.sam, recorder: recorder)
        games.setLongShotDraft("  Say \"Modula-2\"\n")
        #expect(games.submitLongShot() == .dispatched)
        let command = try #require(recorder.commands.last)
        #expect(command.kind == .move && command.type == "answer")
        let payload = try #require(try JSONSerialization.jsonObject(with: Data(command.payloadJSON.utf8)) as? [String: Any])
        #expect(payload.count == 1 && payload["text"] as? String == "Say \"Modula-2\"")
        #expect(games.submitLongShot() == .ignored)
        #expect(GameMoveAdapter.payloadJSON(GameMoveIntent.answer(2)) == "{\"choice\":2}")

        games.moveAcknowledged(requestId: command.requestId, success: true, serverText: "")
        games.setLongShotDraft(String(repeating: "x", count: 80))
        #expect(games.longShotDraft.count == LongShotSceneBuilder.maxAnswerLength)
        games.setLongShotDraft("   ")
        #expect(games.submitLongShot() == .ignored && recorder.commands.count == 1)
    }

    @Test func theDraftClearsWhenTheServerTakesItAndSurvivesARefusal() throws {
        let recorder = Recorder()
        let games = try presenter(["classic-prompt-open"], viewer: Self.sam, recorder: recorder)
        games.setLongShotDraft("Zzyzx")
        #expect(games.submitLongShot() == .dispatched)
        games.moveAcknowledged(requestId: try #require(recorder.commands.last).requestId, success: true, serverText: "")
        #expect(games.longShotDraft.isEmpty)

        games.setLongShotDraft("Modula-2")
        #expect(games.submitLongShot() == .dispatched)
        games.moveAcknowledged(requestId: try #require(recorder.commands.last).requestId, success: false, serverText: "Time's up")
        #expect(games.longShotDraft == "Modula-2")
        #expect(games.interaction.failure == .server && games.interaction.failureServerText == "Time's up")

        games.apply(try inputs("classic-reveal", viewer: Self.sam))
        games.apply(try inputs("classic-ready-seated", viewer: Self.sam))
        #expect(games.longShotDraft.isEmpty)
        games.setLongShotDraft("Typed during the countdown")
        #expect(games.longShotDraft.isEmpty)
    }

    @Test func spectatorsAndQueuedJoinersWatchWithoutAField() throws {
        let watching = try presenter(["classic-prompt-miss"], viewer: Self.watcher)
        let scene = try #require(watching.scene.longShot)
        #expect(!scene.isPlayer && !scene.entry.isShown && scene.board.dive?.landing == nil && scene.board.dive?.miss == nil)
        #expect(watching.chrome.seat == .canJoin && GameShellHeaderPolicy.bodyShowsSeat(chrome: watching.chrome, sceneKind: watching.scene.kind))
        #expect(watching.submitLongShot() == .explained)

        let queued = try presenter(["classic-prompt-miss"], viewer: Self.late)
        #expect(queued.chrome.seat == .joiningNextRound && queued.scene.longShot?.isPlayer == false)

        let seated = try presenter(["classic-ready-seated"], viewer: Self.late)
        #expect(seated.chrome.seat == .player && seated.scene.longShot?.entry.isShown == true)

        let fuseWatcher = try presenter(["fuse-turn"], viewer: Self.watcher)
        #expect(fuseWatcher.chrome.seat == .watching && fuseWatcher.scene.longShot?.entry.isShown == false)
    }

    @Test func theFuseBelongsToItsHolder() throws {
        let holder = try scene("fuse-turn", viewer: Self.sam)
        let board = try #require(holder.board.fuse)
        #expect(board.status == .yourTurn && holder.entry.canSubmit && holder.entry.action == .pass)
        #expect(board.prompt.text == "Name a board game" && board.prompt.category == "Games" && board.foundCount == 0)
        #expect(board.seats.map { $0.id } == [Self.sam, Self.robin, Self.host] && board.seats.allSatisfy { $0.hearts == 2 && !$0.isOut })
        #expect(board.seats.first { $0.isHolding }?.id == Self.sam && board.showsMeter && board.meterFraction == 0)

        let waiting = try scene("fuse-turn", viewer: Self.robin)
        #expect(waiting.board.fuse?.status == .theirTurn && waiting.board.fuse?.holderName == "Sam")
        #expect(waiting.entry.isShown && !waiting.entry.canSubmit)

        let paused = try scene("fuse-paused", viewer: Self.sam)
        #expect(paused.board.fuse?.status == .paused && !paused.entry.canSubmit && paused.board.fuse?.seats.contains { $0.isHolding } == false)
    }

    @Test func fuseNotesNameRepeatsJudgedLinksAndHearts() throws {
        let repeated = try #require(try scene("fuse-miss-used", viewer: Self.robin).board.fuse)
        let line = try #require(repeated.note.missLine)
        #expect(line.isYou && line.name == "Robin" && line.miss.reason == .taken && line.miss.text == "Risk")
        #expect(try scene("fuse-miss-used", viewer: Self.sam).board.fuse?.note.missLine?.isYou == false)

        let chained = try #require(try scene("fuse-chain-judged", viewer: Self.host).board.fuse)
        #expect(chained.chain.map { $0.landing.text } == ["Tigris and Euphrates", "Risk"])
        #expect(chained.chain[0].landing.isJudged && chained.chain[0].landing.tier == .longShot && chained.chain[0].name == "Robin")
        #expect(!chained.chain[1].landing.isJudged && chained.chain[1].landing.tier == .solid)
        #expect(chained.foundCount == 2 && chained.note == .none && chained.status == .yourTurn)

        let heart = try #require(try scene("fuse-heart", viewer: Self.host).board.fuse)
        #expect(heart.note.heartLine == LongShotHeartLine(name: "Avery", isYou: true))
        #expect(heart.seats.first { $0.id == Self.host }?.hearts == 3 && heart.chain.count == LongShotSceneBuilder.chainRows)
        #expect(try scene("fuse-heart", viewer: Self.robin).board.fuse?.note.heartLine?.isYou == false)
    }

    @Test func aPopNamesWhoRanOutOfAir() throws {
        let lost = try #require(try scene("fuse-popped", viewer: Self.robin).board.popped)
        #expect(lost.name == "Sam" && !lost.isYou && !lost.isEliminated && lost.seats.first { $0.isPopped }?.id == Self.sam)
        #expect(try scene("fuse-popped", viewer: Self.sam).board.popped?.isYou == true)
        let out = try #require(try scene("fuse-popped-out", viewer: Self.host).board.popped)
        #expect(out.name == "Sam" && out.isEliminated && out.seats.first { $0.id == Self.sam }?.isOut == true)
    }

    @Test func resultsNameTheDeepestDiverOrTheLastOneUnder() throws {
        let classic = try #require(try scene("classic-results", viewer: Self.host).board.results)
        #expect(classic.winner == LongShotWinnerModel(name: "Sam", isYou: false, depth: 1850) && !classic.isTie)
        #expect(classic.standings.map { $0.depth } == [1850, 1550, 1000, 750] && classic.standings[0].isWinner && classic.standings[0].fraction == 1)
        #expect(classic.band == .shallows && classic.best.first?.landing.text == "APL")
        #expect(try scene("classic-results", viewer: Self.sam).board.results?.band == .twilight)
        #expect(try scene("classic-results", viewer: Self.watcher).board.results?.band == nil)

        let fuse = try #require(try scene("fuse-results", viewer: Self.host).board.results)
        #expect(fuse.winner == LongShotWinnerModel(name: "Avery", isYou: true, depth: 8800) && fuse.band == nil)
        #expect(fuse.standings.first { $0.isWinner }?.id == Self.host)
        let games = try presenter(["fuse-results"], viewer: Self.sam)
        #expect(games.chrome.phase == .results && games.results.winnerName == "Avery")
    }

    @Test func lastOneUnderNeedsTwoDiversBeforeTheHostCanStart() throws {
        let lobby = try inputs("fuse-lobby", viewer: Self.host)
        let fuse = GameStageInputs.make(callSession: 1, isActive: true, gameId: lobby.gameId, name: lobby.name, phase: lobby.phase,
                                    players: [GamePlayerInput(id: Self.host, name: "Avery")], canJoinLate: true, config: lobby.config,
                                    options: lobby.options, minPlayers: lobby.minPlayers, publicViewJSON: lobby.publicViewJSON,
                                    playerViewJSON: lobby.playerViewJSON, selfId: Self.host, isHost: true)
        let alone = GameStagePresenter()
        alone.apply(fuse)
        #expect(!alone.scene.lobby.canStart && alone.scene.lobby.reason == .needsPlayers && alone.scene.lobby.minPlayers == 2)

        let classic = try inputs("classic-lobby", viewer: Self.host)
        let soloClassic = GameStagePresenter()
        soloClassic.apply(GameStageInputs.make(callSession: 1, isActive: true, gameId: classic.gameId, name: classic.name, phase: classic.phase,
                                               players: [GamePlayerInput(id: Self.host, name: "Avery")], config: classic.config,
                                               options: classic.options, minPlayers: classic.minPlayers, publicViewJSON: classic.publicViewJSON,
                                               playerViewJSON: classic.playerViewJSON, selfId: Self.host, isHost: true))
        #expect(soloClassic.scene.lobby.canStart)
        #expect(try presenter(["fuse-lobby"], viewer: Self.host).scene.lobby.canStart)
    }

    @Test func theServerCatalogShowsModeSpecificOptions() throws {
        let entry = MeetingViewModel.activityGameInput(try Fixture.load().catalog())
        #expect(entry.id == "long-shot" && entry.name == "Long Shot" && entry.minPlayers == 1)
        #expect(entry.options.map { $0.id } == ["topic", "mode", "prompts", "lives", "pace"])
        let visible: (String) -> [String] = { mode in
            let drafts = [ActivityOptionValue(id: "mode", isNumber: false, number: 0, text: mode)]
            return entry.options.filter { ActivitiesCatalogPolicy.isVisible($0, among: entry.options, drafts: drafts) }.map { $0.id }
        }
        #expect(visible("classic") == ["topic", "mode", "prompts", "pace"])
        #expect(visible("fuse") == ["topic", "mode", "lives", "pace"])
        let mode = try #require(entry.options.first { $0.id == "mode" })
        #expect(mode.choices.map { $0.label } == ["Dive together", "Last one under"])
        #expect(GameGlyphPolicy.glyph(gameId: entry.id) == .longShot)
    }

    @Test func outcomesPlayTheirFeedbackOnce() throws {
        let landed = try presenter(["classic-prompt-open", "classic-prompt-miss"], viewer: Self.host)
        #expect(landed.feedbackState.token.kind == .gameCorrect)
        let missed = try presenter(["classic-prompt-open", "classic-prompt-miss"], viewer: Self.sam)
        #expect(missed.feedbackState.token.kind == .guessInvalid)
        let sequence = missed.feedbackState.token.sequence
        missed.apply(try inputs("classic-prompt-miss", viewer: Self.sam))
        #expect(missed.feedbackState.token.sequence == sequence)
        let popped = try presenter(["fuse-heart", "fuse-popped"], viewer: Self.sam)
        #expect(popped.feedbackState.token.kind == .gameWrong)
        let repeatFeedback = try presenter(["fuse-turn", "fuse-miss-used"], viewer: Self.robin)
        #expect(repeatFeedback.feedbackState.token.kind == .guessInvalid)
        let passed = try presenter(["fuse-miss-used", "fuse-chain-judged"], viewer: Self.robin)
        #expect(passed.feedbackState.token.kind == .gameCorrect)
    }

    @Test func aStalePrivateViewNeverShowsLastPromptsAnswerUnderTheNextOne() throws {
        let games = try presenter(["classic-reveal"], viewer: Self.host)
        let sequence = games.feedbackState.token.sequence
        games.apply(try inputs("classic-ready-seated", viewer: Self.host, privateFrom: "classic-reveal"))
        let scene = try #require(games.scene.longShot)
        let dive = try #require(scene.board.dive)
        #expect(dive.prompt.number == 2 && dive.landing == nil && dive.miss == nil && dive.rungs.allSatisfy { !$0.isLanded })
        #expect(scene.announcementKey.isEmpty && games.feedbackState.token.sequence == sequence)
        games.apply(try inputs("classic-ready-seated", viewer: Self.host))
        #expect(games.scene.longShot?.board.dive?.landing == nil && games.feedbackState.token.sequence == sequence)
    }

    @Test func everyPopIsAnnouncedEvenWhenTheSameDiverLosesAgain() throws {
        let first = try scene("fuse-popped", viewer: Self.robin)
        let sameOutcome = GameStagePresenter()
        sameOutcome.apply(try inputs("fuse-popped-out", viewer: Self.robin) { view in
            var popped = view["popped"] as? [String: Any] ?? [:]
            popped["eliminated"] = false
            view["popped"] = popped
        })
        let repeatPop = try #require(sameOutcome.scene.longShot?.board.popped)
        #expect(first.board.popped?.name == repeatPop.name && repeatPop.name == "Sam" && first.board.popped?.isEliminated == false)
        #expect(!repeatPop.isEliminated && first.board.popped?.promptNumber != repeatPop.promptNumber)
        let key = try #require(sameOutcome.scene.longShot).announcementKey
        #expect(!first.announcementKey.isEmpty && !key.isEmpty && key != first.announcementKey)
    }

    @Test func onlyANewMissShakesTheField() throws {
        let opened = try scene("fuse-turn", viewer: Self.robin).board.fuse?.note.missLine?.miss.atMillis ?? 0
        let missed = try #require(try scene("fuse-miss-used", viewer: Self.robin).board.fuse?.note.missLine?.miss.atMillis)
        let passed = try scene("fuse-chain-judged", viewer: Self.robin).board.fuse?.note.missLine?.miss.atMillis ?? 0
        #expect(LongShotShakePolicy.shakes(previousMissAt: opened, nextMissAt: missed))
        #expect(!LongShotShakePolicy.shakes(previousMissAt: missed, nextMissAt: missed))
        #expect(!LongShotShakePolicy.shakes(previousMissAt: missed, nextMissAt: passed))
        let first = try #require(try scene("classic-prompt-miss", viewer: Self.sam).board.dive?.miss?.atMillis)
        #expect(LongShotShakePolicy.shakes(previousMissAt: first, nextMissAt: first + 900))
    }

    @Test func anAcknowledgementThatArrivesDuringDispatchStillClearsTheDraft() throws {
        let games = GameStagePresenter()
        games.sleep = { _ in try? await Task.sleep(nanoseconds: 60_000_000_000) }
        games.onCommand = { command in games.moveAcknowledged(requestId: command.requestId, success: true, serverText: "") }
        games.apply(try inputs("classic-prompt-open", viewer: Self.sam))
        games.setLongShotDraft("Modula-2")
        #expect(games.submitLongShot() == .dispatched)
        #expect(games.longShotDraft.isEmpty && !games.interaction.isPending)
    }

    @Test func anUnknownGameOrPhaseFallsBackWithoutCrashing() throws {
        let unknown = GameStagePresenter()
        unknown.apply(try inputs("classic-prompt-open", viewer: Self.host, gameId: "long-shot-next"))
        #expect(!unknown.chrome.isKnownGame && unknown.chrome.phase == .unsupported && unknown.scene.kind == GameSceneKind.unsupported)
        #expect(unknown.scene.longShot == nil && unknown.chrome.canEnd)
        #expect(GameShellBarPolicy.content(chrome: unknown.chrome, scene: unknown.scene, results: unknown.results) == .none)

        let futurePhase = GameStagePresenter()
        futurePhase.apply(try inputs("classic-prompt-open", viewer: Self.host) { $0["phase"] = "bonus" })
        #expect(futurePhase.chrome.isKnownGame && futurePhase.scene.kind == GameSceneKind.longShot && futurePhase.scene.longShot == nil)

        let mismatched = try inputs("classic-prompt-open", viewer: Self.host) { $0["mode"] = "fuse" }
        #expect(GameProjectionParser.parse(gameId: "long-shot", publicPhase: mismatched.phase, publicViewJSON: mismatched.publicViewJSON,
                                           playerViewJSON: mismatched.playerViewJSON).longShot == nil)
        let empty = GameProjectionParser.parse(gameId: "long-shot", publicPhase: "prompt", publicViewJSON: "", playerViewJSON: "")
        #expect(empty.isKnownGame && empty.longShot == nil)
    }
}
#endif
