#if !SKIP
import Foundation
import Testing
@testable import Conclave

@MainActor
struct TRN2TranscriptPanelTests {
    final class Clock {
        var millis = 1_000_000.0
    }

    static let longSleep: (Double) async -> Void = { _ in try? await Task.sleep(nanoseconds: 60_000_000_000) }

    private func segment(_ id: String, _ sequence: Int, _ speaker: String, _ text: String, final: Bool = true,
                         at: Double) -> TranscriptSegmentModel {
        TranscriptSegmentModel(itemId: id, sequence: sequence, speakerUserId: speaker, speakerDisplayName: speaker.capitalized,
                               text: text, startMs: at, isFinal: final)
    }

    private func fixture(_ state: TranscriptFixtureState) -> TranscriptFixtureDriver {
        let driver = TranscriptFixtureDriver(fixture: state)
        driver.runsFollowUps = false
        driver.presenter.sleep = TRN2TranscriptPanelTests.longSleep
        return driver
    }

    private static let labels = TranscriptExportLabels(title: "Meeting Transcript - room", summary: "Summary", topics: "Topics",
                                                       decisions: "Decisions", actionItems: "Action Items",
                                                       openQuestions: "Open Questions", followUps: "Follow-Ups",
                                                       transcript: "Transcript", speaker: "Speaker")

    @Test func theEngineGroupsLikeTheLegacyPolicyWithoutSorting() throws {
        let engine = TranscriptFeedEngine()
        var all: [TranscriptSegmentModel] = []

        let arrivals = [
            segment("c", 3, "sam", "three", at: 3_000), segment("a", 1, "avery", "one", at: 1_000),
            segment("e", 5, "avery", "five", at: 200_000), segment("b", 2, "avery", "two", at: 2_000),
            segment("d", 4, "sam", "four", final: false, at: 4_000), segment("f", 6, "avery", "six", at: 201_000)
        ]
        for item in arrivals {
            engine.upsert(item)
            all.append(item)
            let legacy = TranscriptPresentationPolicy.groupedSegments(from: TranscriptPresentationPolicy.orderedSegments(finals: all, partials: [:]))
            #expect(engine.groups.map { $0.id } == legacy.map { $0.id })
            #expect(engine.groups.map { $0.text } == legacy.map { $0.text })
            #expect(engine.groups.map { $0.isFinal } == legacy.map { $0.isFinal })
        }
        #expect(engine.segments.map { $0.itemId } == ["a", "b", "c", "d", "e", "f"])
        #expect(engine.sortCount == 0 && engine.fullRebuildCount == 0)
        #expect(engine.hasMarker(before: 2), "a lull of at least 3 minutes puts a marker before Avery's second group")

        engine.upsert(segment("d", 4, "sam", "four done", at: 4_000))
        try #require(engine.groups.count > 1)
        #expect(engine.groups[1].text == "three four done" && engine.groups[1].isFinal)
        engine.remove(itemId: "c")
        #expect(engine.groups.map { $0.speakerUserId } == ["avery", "sam", "avery"])
    }

    @Test func aPartialDeltaOnTwoThousandSegmentsTouchesAtMostThreeGroupsAndRebuildsNothing() {
        let driver = fixture(.long)
        let state = driver.state
        let feed = driver.presenter.feed
        #expect(state.feedEngine.segments.count == 2_001)
        let rebuilds = feed.rebuildCount
        let sorts = state.feedEngine.sortCount
        let engineRebuilds = state.feedEngine.fullRebuildCount
        let rowIds = feed.rowIds
        var revisions: [String: Int] = [:]
        for id in rowIds { revisions[id] = feed.row(id).revision }
        driver.streamPartials(10, finalize: false)
        #expect(state.feedEngine.lastTouchedGroupCount <= 3)
        #expect(feed.lastTouchedCount <= 3)
        #expect(feed.rebuildCount == rebuilds, "transcript.rebuilds stays 0 during a partial stream")
        #expect(state.feedEngine.sortCount == sorts && state.feedEngine.fullRebuildCount == engineRebuilds)
        #expect(state.legacyRebuildCount == 0, "the native route never regroups the legacy presentation")

        var changed = 0
        for id in rowIds where feed.row(id).revision != revisions[id] { changed += 1 }
        #expect(changed <= 3)
        #expect(!feed.newestId.isEmpty)
    }

    @Test func hasContentIsEdgeTriggered() {
        let state = TranscriptState()
        var flips: [Bool] = []
        var last = state.hasContent
        state.onPanelChanged = { _ in
            if state.hasContent != last {
                last = state.hasContent
                flips.append(last)
            }
        }
        state.applyPartial(segment("p", 1, "sam", "partial", final: false, at: 1_000))
        #expect(!state.hasContent, "partials alone are not export content")
        for index in 0..<50 {
            state.applyFinal(segment("f\(index)", index + 2, "sam", "line", at: Double(2_000 + index)))
        }
        #expect(state.hasContent && flips == [true])
        state.clearSegments()
        #expect(!state.hasContent && flips == [true, false])
    }

    @Test func theLegacyPresentationIsUnchangedWhileEnabled() {
        let state = TranscriptState()
        #expect(state.legacyPresentationEnabled)
        state.applyPartial(segment("p", 2, "alex", "live", final: false, at: 2_000))
        state.applyFinal(segment("f", 1, "alex", "ready", at: 1_000))
        #expect(state.orderedSegments.map { $0.itemId } == ["f", "p"])
        #expect(state.groupedSegments.map { $0.text } == ["ready live"])
        state.setLegacyPresentation(false)
        state.applyFinal(segment("g", 3, "bea", "next", at: 3_000))
        #expect(state.groupedSegments.map { $0.text } == ["ready live"], "frozen while the native route owns it")
        #expect(state.orderedSegments.map { $0.itemId } == ["f", "p", "g"], "orderedSegments always reads the engine")
        state.setLegacyPresentation(true)
        #expect(state.groupedSegments.map { $0.text } == ["ready live", "next"])
    }

    @Test func rowsCarryMarkersYouAndPerRowRevisions() {
        let driver = fixture(.liveController)
        let feed = driver.presenter.feed
        #expect(!feed.isEmpty)
        let youRows = feed.rowIds.filter { feed.row($0).isYou }
        #expect(!youRows.isEmpty, "the local user's groups read You")
        let long = fixture(.long)
        #expect(long.presenter.feed.rowIds.contains { $0.hasPrefix(TranscriptFeed.markerPrefix) })

        let before = feed.newestRevision
        let newest = feed.newestId
        driver.growNewestByFiveLines()
        #expect(feed.newestRevision != before || feed.newestId != newest)
    }

    @Test func fixtureSnapshotsMatchTheStatesTable() {
        let idle = fixture(.idle).presenter.snapshot
        #expect(idle.body == .startCard && idle.offersStart && idle.startKind == .start && idle.tabs.isEmpty && !idle.isViewOnly)
        let viewOnly = fixture(.viewOnly).presenter.snapshot
        #expect(viewOnly.body == .startCard && viewOnly.isViewOnly && !viewOnly.offersStart && viewOnly.blurb == .viewOnly)
        let takeover = fixture(.takeover).presenter.snapshot
        #expect(takeover.startKind == .takeover && takeover.offersStart && takeover.blurb == .takeoverBringKey)
        let controller = fixture(.liveController).presenter.snapshot
        #expect(controller.body == .content && controller.status == .live && controller.host == .you)
        #expect(controller.canPause && controller.canStop && controller.tabs == [.transcript, .ask, .minutes])
        let follower = fixture(.liveFollower).presenter.snapshot
        #expect(follower.host == .named && follower.controllerName == "Avery Lee" && !follower.canStop && !follower.canPause)
        let paused = fixture(.paused).presenter.snapshot
        #expect(paused.status == .paused && paused.canPause)
        let reconnecting = fixture(.reconnecting).presenter.snapshot
        #expect(reconnecting.status == .reconnecting && reconnecting.controlsDisabled)
        let unavailable = fixture(.unavailable).presenter.snapshot
        #expect(unavailable.body == .unavailable && unavailable.phase == .unavailable)
        let ended = fixture(.ended).presenter.snapshot
        #expect(ended.status == .ended && ended.hasContent && ended.offersStart && !ended.canStop)
        let relay = fixture(.relayUnavailable).presenter.snapshot
        #expect(relay.body == .relayUnavailable && !relay.offersStart)
    }

    @Test func viewOnlyShowsNoAskTab() {
        let driver = fixture(.liveFollower)
        driver.state.applyCapabilities(start: false, takeover: false, stop: false, ask: false)
        #expect(driver.presenter.snapshot.tabs == [.transcript, .minutes] && !driver.presenter.snapshot.canAsk)
        driver.presenter.select(.ask)
        #expect(driver.presenter.tab == .transcript)
    }

    @Test func destinationsSelectTheirTab() {
        let driver = fixture(.liveController)
        driver.presenter.panelDidOpen(destination: .transcriptMinutes)
        #expect(driver.presenter.tab == .minutes)
        driver.presenter.panelDidOpen(destination: .transcriptAsk)
        #expect(driver.presenter.tab == .ask)
        driver.presenter.panelDidOpen(destination: .transcriptLive)
        #expect(driver.presenter.tab == .transcript)
        driver.presenter.select(.minutes)
        driver.presenter.panelDidClose()
        driver.presenter.panelDidOpen(destination: .none)
        #expect(driver.presenter.tab == .minutes, "a reopen keeps the last tab")
    }

    @Test func stopConfirmsRecordsOneCallAndEndsReadable() {
        let driver = fixture(.liveController)
        let presenter = driver.presenter
        presenter.requestStop()
        #expect(presenter.snapshot.stop == .confirming)
        presenter.cancelStop()
        #expect(presenter.snapshot.stop == .idle && presenter.callLog.isEmpty)
        presenter.requestStop()
        #expect(presenter.confirmStop())
        #expect(presenter.callLog == ["stop"] && presenter.snapshot.stop == .stopping && presenter.snapshot.status == .stopping)
        #expect(!presenter.confirmStop(), "one stop per tap")
        driver.finishStop()
        #expect(presenter.snapshot.stop == .idle && presenter.snapshot.phase == .ended && presenter.snapshot.hasContent)
        #expect(presenter.announcement?.kind == .stopped)
    }

    @Test func aScriptedStopFailureShowsTheBannerAndTryAgainStopsAgain() {
        let driver = fixture(.liveController)
        let presenter = driver.presenter
        driver.run(.stopFails)
        presenter.requestStop()
        presenter.confirmStop()
        #expect(presenter.snapshot.stop == .failed && presenter.snapshot.phase == .live)
        #expect(presenter.confirmStop())
        #expect(presenter.callLog == ["stop", "stop"] && presenter.snapshot.stop == .stopping)
    }

    @Test func askRowsSettleOnWorkerErrorReconnectAndThirtySeconds() throws {
        let driver = fixture(.liveController)
        let presenter = driver.presenter
        let clock = Clock()
        presenter.now = { clock.millis }
        driver.run(.askReject)
        #expect(presenter.askQuestion("What did we decide?"))
        try #require(presenter.ask.rowIds.count > 0)
        let rejected = presenter.ask.row(presenter.ask.rowIds[0])
        #expect(rejected.state == .error && rejected.errorText == "The assistant is busy. Try again in a moment.")
        driver.run(.askSilence)
        presenter.askQuestion("Summarize the discussion")
        try #require(presenter.ask.rowIds.count > 1)
        let silentId = presenter.ask.rowIds[1]
        #expect(presenter.ask.row(silentId).state == .thinking && presenter.hasAskTimer)
        clock.millis += 29_000
        presenter.expireAskRows()
        #expect(presenter.ask.row(silentId).state == .thinking)
        clock.millis += 1_500
        presenter.expireAskRows()
        #expect(presenter.ask.row(silentId).state == .timedOut && !presenter.hasAskTimer)

        driver.run(.askSilence)
        presenter.askQuestion("What are the action items?")
        try #require(presenter.ask.rowIds.count > 2)
        let pendingId = presenter.ask.rowIds[2]
        driver.state.connectionStatus = .connecting
        #expect(presenter.ask.row(pendingId).state == .error && presenter.ask.row(pendingId).errorText.isEmpty)

        driver.state.connectionStatus = .connected
        driver.run(.askSilence)
        presenter.askQuestion("Who owns the deck?")
        try #require(presenter.ask.rowIds.count > 3)
        let workerId = presenter.ask.rowIds[3]
        driver.state.setIssue(.server, serverText: "Worker restarted")
        #expect(presenter.ask.row(workerId).state == .error && presenter.ask.row(workerId).errorText == "Worker restarted")
    }

    @Test func tryAgainHidesTheRowAndAsksAgainAndTheDraftSurvivesTabs() {
        let driver = fixture(.ask)
        let presenter = driver.presenter
        #expect(presenter.ask.rowIds == ["qa-done", "qa-error", "qa-unsent"])
        #expect(presenter.ask.row("qa-done").state == .done && !presenter.ask.row("qa-done").blocks.isEmpty)
        #expect(presenter.ask.row("qa-unsent").state == .notSent)
        #expect(presenter.retryAsk(rowId: "qa-error"))
        #expect(!presenter.ask.rowIds.contains("qa-error") && presenter.callLog == ["ask"])
        #expect(!presenter.retryAsk(rowId: "qa-done"), "a done row offers no Try Again")
        presenter.drafts.ask = "half a question"
        presenter.select(.minutes)
        presenter.select(.ask)
        #expect(presenter.drafts.ask == "half a question")
        presenter.drafts.providerKey = "sk-test"
        presenter.panelDidClose()
        #expect(presenter.drafts.ask == "half a question" && presenter.drafts.providerKey.isEmpty, "keys clear on close")
    }

    @Test func minutesSectionsStatusAndRefresh() throws {
        let driver = fixture(.minutes)
        let presenter = driver.presenter
        #expect(presenter.minutes.sections.map { $0.section } == [.topics, .decisions, .actionItems, .openQuestions, .followUps])
        try #require(presenter.minutes.sections.count > 2)
        let action = try #require(presenter.minutes.sections[2].entries.first)
        #expect(action.owner == "Avery Lee" && action.due == "Friday")
        #expect(presenter.snapshot.canRefreshMinutes && presenter.snapshot.minutesUpdatedAtMillis > 0)
        #expect(MinutesPolicy.statusKind(updating: false, updatedAtMillis: 10) == .updated)
        #expect(MinutesPolicy.statusKind(updating: true, updatedAtMillis: 10) == .updating)
        #expect(MinutesPolicy.statusKind(updating: false, updatedAtMillis: 0) == .automatic)
        #expect(MinutesPolicy.emptyKind(phase: .live, hasContent: false) == .cooking)
        #expect(MinutesPolicy.emptyKind(phase: .idle, hasContent: false) == .buildAsYouTalk)
        #expect(!MinutesPolicy.canRefresh(canAsk: false, phase: .live), "Refresh hidden without canAsk")
        #expect(presenter.refreshMinutes() && presenter.callLog == ["refreshMinutes"])
    }

    @Test func recapFromMinutesPostsOncePerTapAndAnnouncesEachState() {
        let driver = fixture(.minutes)
        let presenter = driver.presenter
        #expect(presenter.snapshot.offersRecapToChat)
        #expect(presenter.postRecapToChat())
        #expect(presenter.snapshot.recap == .posting && presenter.announcement?.kind == .recapPosting)
        #expect(!presenter.postRecapToChat(), "one recap per tap while posting")
        driver.setRecap(.failed)
        #expect(presenter.snapshot.recap == .failed && presenter.announcement?.kind == .recapFailed)
        #expect(presenter.callLog == ["postRecap"])
    }

    @Test func exportIsFinalsOnlyLocalizedAndNamedForTheRoom() {
        let driver = fixture(.liveController)
        let presenter = driver.presenter
        let file = presenter.exportFile(labels: Self.labels, timeLabel: { _ in "10:41" })
        #expect(file.fileName == "conclave-fixture-room-transcript.md")
        #expect(file.byteCount > 0 && presenter.exportBytes == file.byteCount)
        #expect(file.content.hasPrefix("# Meeting Transcript - room"))
        #expect(file.content.contains("## Transcript"))
        #expect(!file.content.contains("And then we probably need to dec"), "partial lines never export")
        #expect(file.content.contains("- 10:41 Avery Lee: So the deck is ready for review by Friday."))
        #expect(presenter.copyText(labels: Self.labels, timeLabel: { _ in "10:41" }) == file.content)
        #expect(TranscriptExportPolicy.fileName(roomId: "abc def/ghi") == "conclave-abc-def-ghi-transcript.md")
        #expect(TranscriptExportPolicy.fileName(roomId: "  ") == "conclave-meeting-transcript.md")
        let minutes = fixture(.minutes).presenter.exportFile(labels: Self.labels, timeLabel: { _ in "t" }).content
        #expect(minutes.contains("## Action Items") && minutes.contains("- Send the deck to the design group (Avery Lee - Friday)"))
    }

    @Test func keyCoverageFollowsTheWebStartCard() {
        #expect(TranscriptKeyPolicy.coverage(provider: .openAI, keysKnown: false, openAICovered: true, sarvamCovered: true) == .unknown)
        #expect(TranscriptKeyPolicy.coverage(provider: .openAI, keysKnown: true, openAICovered: true, sarvamCovered: false) == .covered)
        #expect(TranscriptKeyPolicy.coverage(provider: .sarvam, keysKnown: true, openAICovered: false, sarvamCovered: true) == .sarvamNeedsOpenAI)
        #expect(TranscriptKeyPolicy.coverage(provider: .openAI, keysKnown: true, openAICovered: false, sarvamCovered: true) == .needsKeys)
        #expect(!TranscriptKeyPolicy.hasRequiredKeys(provider: .sarvam, keysKnown: true, openAICovered: false, sarvamCovered: true,
                                                     providerKey: "", assistantKey: " "))
        #expect(TranscriptKeyPolicy.hasRequiredKeys(provider: .sarvam, keysKnown: true, openAICovered: false, sarvamCovered: true,
                                                    providerKey: "", assistantKey: "sk"))
        let options = TranscriptKeyPolicy.options(provider: .sarvam, assistantModel: "gpt-5.6-luna", openAICovered: false,
                                                  sarvamCovered: true, providerKey: "unused", assistantKey: "sk")
        #expect(options.apiKey == nil && options.assistantApiKey == "sk" && options.transcriptModel == "saaras:v3"
                && options.qaModel == "gpt-5.6-luna")
        #expect(TranscriptKeyPolicy.optionsStartExpanded(.needsKeys) && !TranscriptKeyPolicy.optionsStartExpanded(.covered))
    }

    @Test func startUsesTheOptionsAndClearsTheKeys() {
        let driver = fixture(.idle)
        let presenter = driver.presenter
        presenter.drafts.providerKey = "sk"
        #expect(presenter.start(options: TranscriptStartOptions()))
        #expect(presenter.callLog == ["start"] && presenter.snapshot.status == .live && presenter.drafts.providerKey.isEmpty)
        #expect(presenter.announcement?.kind == .started)
        let takeover = fixture(.takeover)
        #expect(takeover.presenter.start(options: TranscriptStartOptions(apiKey: "sk")))
        #expect(takeover.presenter.callLog == ["takeover"])
        let relay = fixture(.relayUnavailable)
        #expect(!relay.presenter.start(options: TranscriptStartOptions()) && relay.presenter.callLog.isEmpty)
    }

    @Test func liveNotesFailedPublishesOncePerSession() {
        let driver = fixture(.liveController)
        let presenter = driver.presenter
        let start = presenter.feedbackState.token.sequence
        driver.state.setIssue(.relayFailed)
        #expect(presenter.feedbackState.token.kind == .liveNotesFailed && presenter.feedbackState.token.sequence == start + 1)
        driver.state.recordFailedAttempts(TranscriptPhasePolicy.maxFailedAttempts)
        #expect(presenter.feedbackState.token.sequence == start + 1, "once per call session")
    }

    @Test func recapPolicyAndTheLeaveOverlay() {
        #expect(RecapPolicy.canPostToChat(isChatLocked: true, isHost: true, isAttendee: false, isJoined: true))
        #expect(!RecapPolicy.canPostToChat(isChatLocked: true, isHost: false, isAttendee: false, isJoined: true))
        #expect(!RecapPolicy.canPostToChat(isChatLocked: false, isHost: true, isAttendee: true, isJoined: true))
        #expect(RecapPolicy.offersRecap(canPostToChat: true, phase: .live, hasContent: true))
        #expect(!RecapPolicy.offersRecap(canPostToChat: true, phase: .live, hasContent: false))
        #expect(!RecapPolicy.offersRecap(canPostToChat: true, phase: .ended, hasContent: true))
        let guest = CTL2LeaveEndTests.Harness(CTL2LeaveEndTests.joined())
        guest.controls.applyRecap(RecapControlsState(offersRecap: true, isPostingBeforeEnd: false))
        #expect(!guest.leave.offersRecap, "only someone who can end for everyone gets the recap")
        let host = CTL2LeaveEndTests.Harness(CTL2LeaveEndTests.joined(isAdmin: true))
        host.controls.applyRecap(RecapControlsState(offersRecap: true, isPostingBeforeEnd: false))
        #expect(host.leave.offersRecap && host.leave.endPhase == .idle)
    }

    @Test func postRecapAndEndPostsThenEndsOnTheAnswerOrAtThirtySeconds() {
        let host = CTL2LeaveEndTests.Harness(CTL2LeaveEndTests.joined(isAdmin: true))
        let recap = RecapCoordinator()
        let clock = Clock()
        recap.now = { clock.millis }
        recap.sleep = TRN2TranscriptPanelTests.longSleep
        var sent = 0
        recap.sendRecap = { _ in sent += 1; return true }
        recap.endCall = { _ = host.controls.finishRecapAndEnd() }
        recap.onChange = {
            host.controls.applyRecap(RecapControlsState(offersRecap: true, isPostingBeforeEnd: recap.isPostingBeforeEnd))
        }
        var recapCommands: [RecapCommandKind] = []
        host.controls.onRecap = { kind in
            recapCommands.append(kind)
            switch kind {
            case .postAndEnd: return recap.postAndEnd()
            case .endNow: recap.endNow(); return true
            case .postOnly: return recap.postToChat()
            }
        }
        host.controls.applyRecap(RecapControlsState(offersRecap: true, isPostingBeforeEnd: false))
        _ = host.controls.selectLeaveMenuItem(LeaveControlPolicy.endItemId)
        let id = host.leave.confirmationId
        #expect(id != 0 && host.leave.offersRecap)
        #expect(host.controls.confirmEndForEveryone(id: id, postRecap: true) == .dispatched)
        #expect(sent == 1 && recapCommands == [.postAndEnd] && host.endCommands == 0)
        #expect(host.leave.confirmationId == 0 && host.leave.endPhase == .postingRecap)
        #expect(host.controls.feedbackState.token.kind == .recapPostingStarted)

        recap.noteAssistantAnswerSettled(answerId: recap.requestedAnswerId, atMillis: clock.millis - 5_000, failed: false)
        #expect(host.endCommands == 0)
        recap.noteAssistantAnswerSettled(answerId: recap.requestedAnswerId, atMillis: clock.millis + 10, failed: false)
        #expect(host.endCommands == 1 && recap.endCount == 1 && host.leave.endPhase != .postingRecap)

        let capped = RecapCoordinator()
        let capClock = Clock()
        capped.now = { capClock.millis }
        capped.sleep = TRN2TranscriptPanelTests.longSleep
        var ended = 0
        capped.sendRecap = { _ in true }
        capped.endCall = { ended += 1 }
        #expect(capped.postAndEnd() && capped.isPostingBeforeEnd && capped.hasCapTimer)
        capClock.millis += 29_000
        capped.expireIfDue()
        #expect(ended == 0)
        capClock.millis += 1_000
        capped.expireIfDue()
        #expect(ended == 1 && !capped.isPostingBeforeEnd)

        let now = RecapCoordinator()
        var nowEnded = 0
        now.sleep = TRN2TranscriptPanelTests.longSleep
        now.sendRecap = { _ in true }
        now.endCall = { nowEnded += 1 }
        now.postAndEnd()
        now.endNow()
        #expect(nowEnded == 1)
        let refused = RecapCoordinator()
        refused.sendRecap = { _ in false }
        #expect(!refused.postAndEnd() && refused.phase == .failed)
    }

    @Test func aRecapTheCoreCannotSendEndsAtOnceAndEndNowNeedsPosting() {
        let host = CTL2LeaveEndTests.Harness(CTL2LeaveEndTests.joined(isAdmin: true))
        host.controls.onRecap = { _ in false }
        host.controls.applyRecap(RecapControlsState(offersRecap: true, isPostingBeforeEnd: false))
        _ = host.controls.selectLeaveMenuItem(LeaveControlPolicy.endItemId)
        let id = host.leave.confirmationId
        #expect(host.controls.confirmEndForEveryone(id: id, postRecap: true) == .dispatched)
        #expect(host.endCommands == 1 && host.leave.endPhase == .ending)
        #expect(host.controls.endNowDuringRecap() == .ignored)

        let plain = CTL2LeaveEndTests.Harness(CTL2LeaveEndTests.joined(isAdmin: true))
        plain.controls.onRecap = { _ in Issue.record("no recap without the offer"); return true }
        _ = plain.controls.selectLeaveMenuItem(LeaveControlPolicy.endItemId)
        #expect(plain.controls.confirmEndForEveryone(id: plain.leave.confirmationId, postRecap: true) == .dispatched)
        #expect(plain.endCommands == 1)
    }

    @Test func minutesRecapCoordinatorPhases() {
        let recap = RecapCoordinator()
        let clock = Clock()
        recap.now = { clock.millis }
        recap.sleep = TRN2TranscriptPanelTests.longSleep
        var changes = 0
        recap.sendRecap = { _ in true }
        recap.onChange = { changes += 1 }
        #expect(recap.postToChat() && recap.phase == .posting)
        #expect(!recap.postToChat())
        recap.noteAssistantAnswerSettled(answerId: recap.requestedAnswerId, atMillis: clock.millis + 1, failed: false)
        #expect(recap.phase == .posted && changes == 2)
        #expect(recap.postToChat())
        clock.millis += RecapPolicy.capMillis
        recap.expireIfDue()
        #expect(recap.phase == .failed)
        recap.reset()
        #expect(recap.phase == .idle && !recap.hasCapTimer)
    }

    @Test func viewPolicyTables() {
        #expect(TranscriptViewPolicy.body(phase: .idle, relay: .unavailable) == .relayUnavailable)
        #expect(TranscriptViewPolicy.body(phase: .takeoverNeeded, relay: .available) == .startCard)
        #expect(TranscriptViewPolicy.body(phase: .ended, relay: .unavailable) == .content)
        #expect(TranscriptViewPolicy.status(phase: .live, link: .reconnecting) == .reconnecting)
        #expect(TranscriptViewPolicy.status(phase: .ended, link: .reconnecting) == .ended)
        #expect(TranscriptViewPolicy.host(phase: .live, controllerName: "", controllerUserId: "", localUserId: "me") == .following)
        #expect(TranscriptViewPolicy.canStop(capability: false, isController: true, phase: .live))
        #expect(!TranscriptViewPolicy.canStop(capability: true, isController: false, phase: .ended))
        #expect(TranscriptAnnouncementPolicy.transition(from: .starting, to: .live) == .started)
        #expect(TranscriptAnnouncementPolicy.transition(from: .live, to: .paused) == .paused)
        #expect(TranscriptAnnouncementPolicy.transition(from: .stopping, to: .ended) == .stopped)
        #expect(TranscriptAnnouncementPolicy.transition(from: .loading, to: .idle) == nil)
        #expect(AskRowPolicy.state(status: .streaming, answer: "", isUnsent: false, isTimedOut: false, settledError: false) == .thinking)
        #expect(AskRowPolicy.state(status: .streaming, answer: "x", isUnsent: false, isTimedOut: true, settledError: false) == .timedOut)
        #expect(AskRowPolicy.state(status: .error, answer: "", isUnsent: true, isTimedOut: false, settledError: false) == .notSent)
        #expect(TranscriptTab.allCases.count == 3 && StopPhase.allCases.count == 4 && RecapPhase.allCases.count == 4
                && KeyCoverage.allCases.count == 4 && AskRowState.allCases.count == 6 && MinutesSection.allCases.count == 6)
    }

    @Test func transcriptSourcesStayFlatDashFreeAndOnTheSharedComponents() throws {
        let paths = try stageSource("Android/app/src/main/res/xml/conclave_file_paths.xml")
        #expect(paths.contains("<cache-path name=\"exports\" path=\"exports/\" />"))
        let manifest = try stageSource("Android/app/src/main/AndroidManifest.xml")
        #expect(manifest.contains("android:authorities=\"${applicationId}.fileprovider\""))
        #expect(manifest.contains("android:resource=\"@xml/conclave_file_paths\""))
    }
}
#endif
