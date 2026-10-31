#if !SKIP
import Foundation
import Testing
@testable import Conclave

@MainActor
struct ActivityProjectionTests {
    private final class Recorder {
        var commands: [ActivitiesCommand] = []
    }

    private func presenter(_ state: ActivityFixtureState, recorder: Recorder? = nil) -> ActivitiesPresenter {
        let activities = ActivitiesPresenter()
        activities.sleep = { _ in }
        if let recorder = recorder {
            activities.onCommand = { command in recorder.commands.append(command) }
        }
        activities.apply(ActivityFixtureScript.activitiesInputs(state))
        return activities
    }

    @Test func hostIdleShowsTheWholeCatalogAppsAndTheBrowser() {
        let s = presenter(.activitiesHostIdle).snapshot
        #expect(s.role == ActivityRole.host)
        #expect(s.games.count == 9)
        #expect(s.games.allSatisfy { $0.isPlayable && $0.reason == ActivitiesReason.none })
        #expect(s.games.first?.detail == "Quick-fire quiz")
        #expect(s.canOpenVote)
        #expect(s.catalogReason == ActivitiesReason.none)
        #expect(s.apps.map { $0.id } == ["whiteboard", "wheel", "watch"])
        #expect(s.apps.allSatisfy { $0.canOpen })
        #expect(s.appsReason == ActivitiesReason.noAppOpen)
        #expect(s.browser.isAvailable)
        #expect(s.nowPlaying.isEmpty)
    }

    @Test func participantIdleSeesNoCatalogAndHostOnlyApps() {
        let s = presenter(.activitiesParticipantIdle).snapshot
        #expect(s.role == ActivityRole.participant)
        #expect(s.games.isEmpty)
        #expect(!s.canOpenVote)
        #expect(s.apps.allSatisfy { !$0.canOpen && $0.reason == ActivitiesReason.hostOnly })
        #expect(s.appsReason == ActivitiesReason.hostOnly)
    }

    @Test func recoveringDisablesActionsWithTheReason() {
        let s = presenter(.activitiesRecovering).snapshot
        #expect(s.isRecovering)
        #expect(s.catalogReason == ActivitiesReason.recovering)
        #expect(s.games.allSatisfy { !$0.isPlayable && $0.reason == ActivitiesReason.recovering })
        #expect(s.apps.allSatisfy { !$0.canOpen && $0.reason == ActivitiesReason.recovering })
        #expect(s.browser.reason == ActivitiesReason.recovering)
    }

    @Test func aLiveGameGatesTheCatalogAndShowsNowPlaying() {
        let activities = presenter(.activitiesGameLive)
        activities.applyGameSummary(ActivityGameSummary(gameId: "trivia", name: "Trivia", isActive: true, isFinished: false, round: 3,
                                                        roundTotal: 7, playerCount: 6))
        let s = activities.snapshot
        #expect(s.catalogReason == ActivitiesReason.gameLive)
        #expect(!s.canOpenVote)
        let item = s.nowPlayingItem(kind: .game)
        #expect(item != nil)
        #expect(item?.gameName == "Trivia" && item?.round == 3 && item?.roundTotal == 7 && item?.playerCount == 6)
        #expect(item?.canEnd == true)

        activities.applyGameSummary(ActivityGameSummary(gameId: "trivia", name: "Trivia", isActive: true, isFinished: true, round: 7,
                                                        roundTotal: 7, playerCount: 6))
        #expect(activities.snapshot.catalogReason == ActivitiesReason.none)
    }

    @Test func chessPlayAsAndComputerLevelShowOnlyAgainstTheComputer() {
        let activities = presenter(.activitiesHostIdle)
        activities.beginSetup("chess")
        var setup = activities.setup
        #expect(setup != nil)
        #expect(setup?.options.first { $0.id == "side" }?.isVisible == false)
        #expect(setup?.options.first { $0.id == "difficulty" }?.isVisible == false)
        #expect(setup?.options.first { $0.id == "timeControl" }?.choices.count == 11)
        #expect(setup?.options.first { $0.id == "rapidFire" }?.choices.map { $0.label } == ["Off", "10s / move", "20s / move", "30s / move"])
        activities.setOption("mode", value: "computer")
        setup = activities.setup
        #expect(setup?.options.first { $0.id == "side" }?.isVisible == true)
        #expect(setup?.options.first { $0.id == "difficulty" }?.isVisible == true)

        activities.beginSetup("chess")
        activities.beginSetup("chess")
        #expect(activities.beginSetupCount == 1)
    }

    @Test func numberPresetsBecomeChoicesWithTheServerSuffix() {
        let activities = presenter(.activitiesHostIdle)
        activities.beginSetup("zip")
        let limit = activities.setup?.options.first { $0.id == "timeLimitMinutes" }
        #expect(limit?.kind == GameOptionModel.numberKind)
        #expect(limit?.choices.map { $0.id } == ["1", "2", "3", "5", "10"])
        #expect(limit?.choices.last?.label == "10 min")
        #expect(limit?.value == "3")
        activities.setOption("timeLimitMinutes", value: "10")
        #expect(activities.setup?.options.first { $0.id == "timeLimitMinutes" }?.value == "10")
    }

    @Test func topicKeepsWhatWasTypedUntilStartAndStartSendsItTrimmedOnce() throws {
        let recorder = Recorder()
        let activities = presenter(.activitiesHostIdle, recorder: recorder)
        activities.beginSetup("trivia")
        let revision = activities.setup
        activities.setText("topic", text: "team lore ")
        #expect(activities.draftText("topic") == "team lore ")

        #expect(activities.setup == revision)
        activities.startGame()
        let start = try #require(recorder.commands.last)
        #expect(start.kind == ActivitiesCommandKind.startGame)
        #expect(start.id == "trivia")
        #expect(start.options.first { $0.id == "topic" }?.text == "team lore")
        #expect(start.options.first { $0.id == "questions" }?.number == 7)
        #expect(start.options.first { $0.id == "pace" }?.text == "normal")
        #expect(activities.setup?.phase == SetupPhase.starting)
    }

    @Test func slowStartAndFailureKeepTheDraft() {
        let activities = presenter(.activitiesHostIdle)
        activities.beginSetup("trivia")
        activities.setOption("pace", value: "fast")
        activities.startGame()
        activities.fireSlowTimer(serial: activities.currentTimerSerial)
        #expect(activities.setup?.phase == SetupPhase.slow)
        activities.commandFailed(ActivitiesCommandKind.startGame, serverText: "Trivia needs at least 3 players.")
        #expect(activities.setup?.phase == SetupPhase.failed)
        #expect(activities.setup?.failureServerText == "Trivia needs at least 3 players.")
        #expect(activities.setup?.options.first { $0.id == "pace" }?.value == "fast")

        activities.fireSlowTimer(serial: activities.currentTimerSerial - 1)
        #expect(activities.setup?.phase == SetupPhase.failed)
    }

    @Test func belowThePlayerRangeDisablesStartWithTheReason() {
        var inputs = ActivityFixtureScript.activitiesInputs(.activitiesHostIdle)
        inputs = ActivitiesInputs.make(callSession: 1, isHost: true, catalog: inputs.catalog, catalogLoaded: true, playersHere: 2)
        let activities = ActivitiesPresenter()
        activities.apply(inputs)
        activities.beginSetup("imposter")
        #expect(activities.setup?.canStart == false)
        #expect(activities.setup?.reason == ActivitiesReason.belowPlayerRange)
    }

    @Test func aStartedGameGoingLiveDismissesThePanelOnce() {
        let activities = presenter(.activitiesHostIdle)
        activities.beginSetup("trivia")
        activities.startGame()
        let before = activities.dismissSignal
        activities.applyGameSummary(ActivityGameSummary(gameId: "trivia", name: "Trivia", isActive: true, isFinished: false, round: 0,
                                                        roundTotal: 7, playerCount: 6))
        #expect(activities.dismissSignal == before + 1)
        #expect(activities.setup?.phase == SetupPhase.idle)
        activities.applyGameSummary(ActivityGameSummary(gameId: "trivia", name: "Trivia", isActive: true, isFinished: false, round: 1,
                                                        roundTotal: 7, playerCount: 6))
        #expect(activities.dismissSignal == before + 1)
    }

    @Test func voteTapsReturnDispatchedOnlyForANewChoice() {
        let recorder = Recorder()
        let activities = presenter(.activitiesVote, recorder: recorder)
        let s = activities.snapshot
        #expect(s.isVoteOpen)
        #expect(s.vote.map { $0.id } == ["trivia", "bluff", "imposter"])
        #expect(s.vote.first { $0.id == "trivia" }?.isMine == true)
        #expect(s.vote.first { $0.id == "trivia" }?.isLeader == true)
        #expect(s.leaderName == "Trivia" && s.leaderVotes == 3 && s.canStartLeader)
        #expect(s.games.allSatisfy { !$0.isPlayable && $0.reason == ActivitiesReason.voteOpen })
        #expect(activities.castVote("trivia") == ActivityTapResult.ignored)
        #expect(activities.castVote("bluff") == ActivityTapResult.dispatched)
        #expect(activities.castVote("imposter") == ActivityTapResult.ignored)
        #expect(recorder.commands.filter { $0.kind == ActivitiesCommandKind.castVote }.count == 1)
        #expect(activities.snapshot.vote.first { $0.id == "bluff" }?.isMine == true)
    }

    @Test func startTheLeaderIsDisabledAtZeroVotes() {
        let s = presenter(.activitiesVoteZero).snapshot
        #expect(s.leaderVotes == 0)
        #expect(!s.canStartLeader)
        #expect(s.leaderId.isEmpty)
        let recovering = ActivitiesPresenter()
        recovering.apply(ActivitiesInputs.make(callSession: 1, isHost: false, isRecovering: true, isVoteOpen: true,
                                               voteCandidates: ActivityFixtureScript.catalog()))
        #expect(recovering.castVote("trivia") == ActivityTapResult.explained)
    }

    @Test func endIsOneCommandWhilePendingAndFailsInline() {
        let recorder = Recorder()
        let activities = presenter(.activitiesGameLive, recorder: recorder)
        activities.applyGameSummary(ActivityGameSummary(gameId: "trivia", name: "Trivia", isActive: true, isFinished: false, round: 1,
                                                        roundTotal: 7, playerCount: 6))
        activities.requestEnd("game")
        activities.requestEnd("game")
        #expect(recorder.commands.filter { $0.kind == ActivitiesCommandKind.endGame }.count == 1)
        #expect(activities.snapshot.nowPlayingItem(kind: .game)?.endPending == true)
        activities.commandFailed(ActivitiesCommandKind.endGame, serverText: "Only the host can end the game")
        let item = activities.snapshot.nowPlayingItem(kind: .game)
        #expect(item?.endPending == false && item?.endFailed == true)
        activities.requestEnd("game")
        activities.applyGameSummary(ActivityGameSummary.none)
        #expect(activities.snapshot.nowPlayingItem(kind: .game) == nil)
    }

    @Test func browserValidationShowsUnderTheFieldAndSendsNothing() {
        let recorder = Recorder()
        let activities = presenter(.activitiesHostIdle, recorder: recorder)
        activities.submitBrowserURL("example .com")
        #expect(activities.snapshot.browser.validation == BrowserValidation.spaces)
        #expect(recorder.commands.isEmpty)
        activities.clearBrowserValidation()
        #expect(activities.snapshot.browser.validation == BrowserValidation.none)
        activities.submitBrowserURL("example.com")
        #expect(recorder.commands.last?.kind == ActivitiesCommandKind.launchBrowser)
        #expect(activities.snapshot.browser.phase == BrowserPhase.launching)
        activities.commandFailed(ActivitiesCommandKind.launchBrowser, serverText: "")
        #expect(activities.snapshot.browser.failure == BrowserFailure.startFailed)
    }

    @Test func browserValidationMatchesTheViewModelRules() {
        #expect(BrowserURLValidationPolicy.validate("") == BrowserValidation.empty)
        #expect(BrowserURLValidationPolicy.validate("   ") == BrowserValidation.empty)
        #expect(BrowserURLValidationPolicy.validate("example .com") == BrowserValidation.spaces)
        #expect(BrowserURLValidationPolicy.validate("ftp://example.com") == BrowserValidation.scheme)
        #expect(BrowserURLValidationPolicy.validate("mailto:a@b.c") == BrowserValidation.scheme)
        #expect(BrowserURLValidationPolicy.validate("https://") == BrowserValidation.invalid)
        #expect(BrowserURLValidationPolicy.validate("example.com") == BrowserValidation.none)
        #expect(BrowserURLValidationPolicy.validate("HTTP://Example.com/path?q=1") == BrowserValidation.none)
    }

    @Test func destinationsLandOnTheirPage() {
        #expect(ActivitiesDestinationPolicy.landing(destination: .activitiesVote, targetId: "") ==
                ActivitiesLanding(route: .root, id: "", focusesVote: true))
        #expect(ActivitiesDestinationPolicy.landing(destination: .activitiesApp, targetId: "wheel").route == .wheel)
        #expect(ActivitiesDestinationPolicy.landing(destination: .activitiesApp, targetId: "whiteboard") == ActivitiesLanding.root)
        #expect(ActivitiesDestinationPolicy.landing(destination: .chatPrivate, targetId: "x") == ActivitiesLanding.root)
        #expect(ActivitiesDestinationPolicy.isRenderable(.wheel) && ActivitiesDestinationPolicy.isRenderable(.watch))
        #expect(ActivitiesRoute.allCases.map { $0.rawValue } == ["root", "setup", "browser", "wheel", "watch"])
    }

    @Test func resetLeavesNoTimerDraftOrPendingState() {
        let activities = presenter(.activitiesHostIdle)
        activities.sleep = { _ in try? await Task.sleep(nanoseconds: 60_000_000_000) }
        activities.beginSetup("trivia")
        activities.startGame()
        #expect(activities.hasLiveTimers)
        activities.reset()
        #expect(!activities.hasLiveTimers)
        #expect(activities.setup == nil)
        #expect(activities.snapshot.withRevision(0) == ActivitiesSnapshot.empty)
    }

    @Test func activityStringsAreInBothCatalogs() throws {
        let catalogData = try Data(contentsOf: activityPackageRoot().appendingPathComponent("Sources/Conclave/Resources/Localizable.xcstrings"))
        let catalog = try #require(try JSONSerialization.jsonObject(with: catalogData) as? [String: Any])
        let strings = try #require(catalog["strings"] as? [String: Any])
        let iosFiles = try stageFiles(under: "Sources/Conclave/Features/Meeting/Activities", extensions: ["swift"])
            + stageFiles(under: "Sources/Conclave/Features/Meeting/Games/Native", extensions: ["swift"])
            + ["Sources/Conclave/Features/Meeting/Stage/ActivityStage+iOS.swift"]
        var keys = Set<String>()
        for file in iosFiles where file.hasSuffix("+iOS.swift") {
            let text = try stageSource(file)
            for match in stageMatches(#"ConclaveStrings\.(?:text|format)\("[^"]+""#, in: text) {
                if let start = match.firstIndex(of: "\"") {
                    keys.insert(String(match[match.index(after: start)...].dropLast()))
                }
            }
        }
        #expect(keys.count > 80)
        for key in keys {
            #expect(strings[key] != nil, "missing iOS key \(key)")
        }
        let xml = try String(contentsOf: activityPackageRoot().appendingPathComponent("Android/app/src/main/res/values/strings.xml"), encoding: .utf8)
        let kotlinFiles = try stageFiles(under: "Sources/Conclave/Skip/ui/activities", extensions: ["kt"])
            + stageFiles(under: "Sources/Conclave/Skip/ui/games", extensions: ["kt"])
            + ["Sources/Conclave/Skip/ui/call/stage/ActivityStage.kt", "Sources/Conclave/Skip/ui/copy/ActivitiesCopy.kt",
               "Sources/Conclave/Skip/ui/copy/GameCopy.kt"]
        var names = Set<String>()
        for file in kotlinFiles {
            let text = try stageSource(file)
            for match in stageMatches(#""(?:act|gm|br|app|stg|ds|set)_[a-z0-9_]+""#, in: text) {
                names.insert(String(match.dropFirst().dropLast()))
            }
        }
        #expect(names.count > 80)
        for name in names {
            #expect(xml.contains("name=\"" + name + "\""), "missing Android resource \(name)")
        }
    }
}

private func activityPackageRoot() -> URL {
    URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
}
#endif
