#if !SKIP
import Foundation
import Testing
@testable import Conclave

/// TRN-2 (OUT/PLAN-screens.md section 5; S60 6, 0.5 TranscriptPresenter, 0.6 L6-4, L6-14, 0.8 C6-11, C6-12, C6-26; S30 0.8
/// CC8; RECONCILE R12, R52): the incremental transcript feed (C6-11: binary insertion, regrouping limited to the touched
/// group and its neighbours, per-row revisions, stored edge-triggered `hasContent`, no rebuild during a partial stream on
/// a 2,000-segment fixture), the presenter's snapshot table on the `transcript-*` fixtures, Stop confirming and failing,
/// Ask rows settling on a worker error, a reconnect or 30 s, Minutes, the finals-only localized export, the recap
/// (offersRecap, Post Recap and End with the 30 s cap, End Now) through `CallControlsPresenter`, `liveNotesFailed` once
/// per session, and source contracts for the iOS and Android files (copy completeness, no glass outside the composer
/// file, FileProvider export). The Kotlin half is T/Skip/TRN2TranscriptBridgeTests.kt. Not run in the heads-down push.
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

    // MARK: Incremental feed (C6-11)

    @Test func theEngineGroupsLikeTheLegacyPolicyWithoutSorting() throws {
        let engine = TranscriptFeedEngine()
        var all: [TranscriptSegmentModel] = []
        // Out of order arrivals, a speaker change, a lull that splits one speaker, a late final that merges two groups.
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
        // The partial finalizes in place: the same groups, the text and finality patched.
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
        // Only the touched rows changed revision: at most the newest group (and a new row for a new speaker group).
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
        // A partial that grows the newest row keeps its id and bumps its revision (the follow key).
        let before = feed.newestRevision
        let newest = feed.newestId
        driver.growNewestByFiveLines()
        #expect(feed.newestRevision != before || feed.newestId != newest)
    }

    // MARK: Snapshot table (6 f, 6 l 1, 1b)

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

    // MARK: Stop (6 l 2)

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

    // MARK: Ask (6 l 6)

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
        // A reconnect settles a pending row with the app copy.
        driver.run(.askSilence)
        presenter.askQuestion("What are the action items?")
        try #require(presenter.ask.rowIds.count > 2)
        let pendingId = presenter.ask.rowIds[2]
        driver.state.connectionStatus = .connecting
        #expect(presenter.ask.row(pendingId).state == .error && presenter.ask.row(pendingId).errorText.isEmpty)
        // A worker error settles with the worker text.
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

    // MARK: Minutes (6 l 7, 13)

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

    // MARK: Export (6 l 3)

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

    // MARK: Keys and coverage (6 c Options)

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

    // MARK: liveNotesFailed (RECONCILE R12)

    @Test func liveNotesFailedPublishesOncePerSession() {
        let driver = fixture(.liveController)
        let presenter = driver.presenter
        let start = presenter.feedbackState.token.sequence
        driver.state.setIssue(.relayFailed)
        #expect(presenter.feedbackState.token.kind == .liveNotesFailed && presenter.feedbackState.token.sequence == start + 1)
        driver.state.recordFailedAttempts(TranscriptPhasePolicy.maxFailedAttempts)
        #expect(presenter.feedbackState.token.sequence == start + 1, "once per call session")
    }

    // MARK: Recap and End (S30 CC8)

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
        recap.sendRecap = { sent += 1; return true }
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
        // An answer older than the request does not end the call; a newer one does.
        recap.noteAssistantAnswerSettled(atMillis: clock.millis - 5_000, failed: false)
        #expect(host.endCommands == 0)
        recap.noteAssistantAnswerSettled(atMillis: clock.millis + 10, failed: false)
        #expect(host.endCommands == 1 && recap.endCount == 1 && host.leave.endPhase != .postingRecap)
        // The 30 s cap on a second host.
        let capped = RecapCoordinator()
        let capClock = Clock()
        capped.now = { capClock.millis }
        capped.sleep = TRN2TranscriptPanelTests.longSleep
        var ended = 0
        capped.sendRecap = { true }
        capped.endCall = { ended += 1 }
        #expect(capped.postAndEnd() && capped.isPostingBeforeEnd && capped.hasCapTimer)
        capClock.millis += 29_000
        capped.expireIfDue()
        #expect(ended == 0)
        capClock.millis += 1_000
        capped.expireIfDue()
        #expect(ended == 1 && !capped.isPostingBeforeEnd)
        // End Now ends at once; a recap the core cannot send ends at once too.
        let now = RecapCoordinator()
        var nowEnded = 0
        now.sleep = TRN2TranscriptPanelTests.longSleep
        now.sendRecap = { true }
        now.endCall = { nowEnded += 1 }
        now.postAndEnd()
        now.endNow()
        #expect(nowEnded == 1)
        let refused = RecapCoordinator()
        refused.sendRecap = { false }
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
        // Without the recap on offer `postRecap` is the plain End.
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
        recap.sendRecap = { true }
        recap.onChange = { changes += 1 }
        #expect(recap.postToChat() && recap.phase == .posting)
        #expect(!recap.postToChat())
        recap.noteAssistantAnswerSettled(atMillis: clock.millis + 1, failed: false)
        #expect(recap.phase == .posted && changes == 2)
        #expect(recap.postToChat())
        clock.millis += RecapPolicy.capMillis
        recap.expireIfDue()
        #expect(recap.phase == .failed)
        recap.reset()
        #expect(recap.phase == .idle && !recap.hasCapTimer)
    }

    // MARK: Policies

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

    // MARK: Source contracts (L6-14, OQ2, C6-26)

    @Test func everyEnumCaseHasCopyOnBothPlatforms() throws {
        let ios = try stageSource("Sources/Conclave/Features/Meeting/Transcript/TranscriptCopy+iOS.swift")
        let kotlin = try stageSource("Sources/Conclave/Skip/ui/copy/TranscriptCopy.kt")
        func cases<T: RawRepresentable & CaseIterable>(_ type: T.Type) -> [String] where T.RawValue == String {
            var names: [String] = []
            for value in T.allCases { names.append(value.rawValue) }
            return names
        }
        let enums: [(String, [String])] = [
            ("TranscriptTab", cases(TranscriptTab.self)), ("TranscriptStartKind", cases(TranscriptStartKind.self)),
            ("TranscriptBlurb", cases(TranscriptBlurb.self)), ("KeyCoverage", cases(KeyCoverage.self)),
            ("TranscriptStatusKind", cases(TranscriptStatusKind.self)), ("TranscriptHostKind", cases(TranscriptHostKind.self)),
            ("TranscriptIssue", cases(TranscriptIssue.self)), ("AskRowState", cases(AskRowState.self)),
            ("MinutesSection", cases(MinutesSection.self)), ("MinutesEmptyKind", cases(MinutesEmptyKind.self)),
            ("MinutesStatusKind", cases(MinutesStatusKind.self)), ("RecapPhase", cases(RecapPhase.self)),
            ("TranscriptAnnouncementKind", cases(TranscriptAnnouncementKind.self))
        ]
        for (type, names) in enums {
            for name in names {
                #expect(ios.contains("case ." + name) || ios.contains(", ." + name), "iOS copy misses \(type).\(name)")
                #expect(kotlin.contains(type + "." + name + " ->") || kotlin.contains(type + "." + name + ","),
                        "Android copy misses \(type).\(name)")
            }
        }
        // Every key the iOS copy names exists in the catalog or in HD/strings/B7-T5.json (merged by the integrator).
        let catalog = try stageSource("Sources/Conclave/Resources/Localizable.xcstrings")
        let fragment = (try? String(contentsOfFile: "/Users/ishaan/Documents/conclave-overhaul-recovery-20261023/heads-down/strings/B7-T5.json",
                                    encoding: .utf8)) ?? ""
        let pattern = try NSRegularExpression(pattern: #"ConclaveStrings\.(?:text|format)\("([^"]+)""#)
        let range = NSRange(ios.startIndex..<ios.endIndex, in: ios)
        for match in pattern.matches(in: ios, range: range) {
            guard let keyRange = Range(match.range(at: 1), in: ios) else { continue }
            let key = String(ios[keyRange]).replacingOccurrences(of: "\\u{2026}", with: "\u{2026}")
                .replacingOccurrences(of: "\\u{2019}", with: "\u{2019}")
            let json = key.replacingOccurrences(of: "\"", with: "\\\"")
            #expect(catalog.contains("\"" + json + "\"") || fragment.contains("\"" + json + "\""), "missing iOS key \(key)")
        }
        let strings = try stageSource("Android/app/src/main/res/values/strings.xml")
        let names = try NSRegularExpression(pattern: #""((?:trn|ctl)_[a-z_]+)""#)
        let kotlinRange = NSRange(kotlin.startIndex..<kotlin.endIndex, in: kotlin)
        for match in names.matches(in: kotlin, range: kotlinRange) {
            guard let nameRange = Range(match.range(at: 1), in: kotlin) else { continue }
            let name = String(kotlin[nameRange])
            #expect(strings.contains("name=\"" + name + "\"") || fragment.contains("\"" + name + "\""), "missing Android name \(name)")
        }
    }

    @Test func transcriptSourcesStayFlatDashFreeAndOnTheSharedComponents() throws {
        let files = try stageFiles(under: "Sources/Conclave/Features/Meeting/Transcript", extensions: ["swift"])
            + stageFiles(under: "Sources/Conclave/Skip/ui/transcript", extensions: ["kt"])
            + ["Sources/Conclave/Skip/ui/copy/TranscriptCopy.kt", "Sources/Conclave/Core/State/TranscriptState.swift",
               "Sources/Conclave/Core/Networking/TranscriptService.swift",
               "Sources/Conclave/Features/Meeting/Controls/CallControlsPresenter.swift"]
        #expect(files.count >= 13)
        for file in files {
            let text = try stageSource(file)
            #expect(!text.contains("\u{2013}") && !text.contains("\u{2014}"), "\(file) has an en or em dash")
            #expect(!text.lowercased().contains("gradient"), "\(file) mentions a gradient")
            #expect(!text.contains("Image(systemName: \""), "\(file) names a raw symbol")
            for pattern in ["glassEffect", "GlassEffectContainer", "ultraThinMaterial", "regularMaterial", "NativeTextShimmer",
                            "Color(red:", "Color(0x", "announceForAccessibility"] {
                #expect(!text.contains(pattern), "\(file) uses \(pattern)")
            }
        }
        let panel = try stageSource("Sources/Conclave/Features/Meeting/Transcript/TranscriptPanel+iOS.swift")
        for required in ["PanelShell(title: TranscriptCopy.title", "ConclaveComposerField(identifier: \"transcript.ask.composer.cluster\")",
                         "ShareLink(item: TranscriptPanelExportItem(presenter: transcript)", ".conclaveGestureFeedback(.linkCopied, trigger: copyCount)",
                         ".confirmationDialog(TranscriptCopy.stopTitle", ".defaultScrollAnchor(.bottom)", "AssistantMarkdownView(blocks: row.blocks",
                         ".conclaveTopBar {", "ConclaveViewSwitch(TranscriptCopy.viewSwitchLabel", "TimelineView(.periodic(from: Date(), by: 60))",
                         "accessibilitySpeechAnnouncementPriority = .low"] {
            #expect(panel.contains(required), "iOS panel misses \(required)")
        }
        #expect(!panel.contains(".sheet("), "the panel is the PanelShell content, never its own sheet")
        let page = try stageSource("Sources/Conclave/Skip/ui/transcript/TranscriptPage.kt")
        for required in ["InCallPage(", "contentMode = InCallPageContent.lazyList", "hasComposer = true", "ConclaveTabSwitch(",
                         "DropdownMenu(", "liveRegion = LiveRegionMode.Polite", "SnackbarHost(snackbars)"] {
            #expect(page.contains(required), "Android page misses \(required)")
        }
        let lists = try stageSource("Sources/Conclave/Skip/ui/transcript/TranscriptLists.kt")
        #expect(lists.contains("reverseLayout = true") && lists.contains("LaunchedEffect(newestId, newestRevision)"))
        #expect(lists.contains("AssistantMarkdown(blocks = row.blocks.toList()"))
        let export = try stageSource("Sources/Conclave/Skip/ui/transcript/TranscriptExport.kt")
        for required in ["FileProvider.getUriForFile(context, authority(context), file)", "putExtra(Intent.EXTRA_STREAM, uri)",
                         "addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)", "File(context.cacheDir, \"exports\")",
                         "PipManager.suppressNextAutoEnter(\"transcript_export\")", "Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU"] {
            #expect(export.contains(required), "export misses \(required)")
        }
        let paths = try stageSource("Android/app/src/main/res/xml/conclave_file_paths.xml")
        #expect(paths.contains("<cache-path name=\"exports\" path=\"exports/\" />"))
        let manifest = try stageSource("Android/app/src/main/AndroidManifest.xml")
        #expect(manifest.contains("android:authorities=\"${applicationId}.fileprovider\""))
        #expect(manifest.contains("android:resource=\"@xml/conclave_file_paths\""))
    }

    @Test func theCallRootRegistersTheTranscriptPanel() throws {
        // HD request B7-T5 R4 (the call root is B7-T2's this batch): red until the integrator applies it.
        let ios = try stageSource("Sources/Conclave/Features/Meeting/Stage/CallRoot+iOS.swift")
        #expect(ios.contains("TranscriptPanel(transcript: shell.transcript"))
        let android = try stageSource("Sources/Conclave/Skip/ui/call/stage/CallRoot.kt")
        #expect(android.contains("TranscriptPage("))
    }
}
#endif
