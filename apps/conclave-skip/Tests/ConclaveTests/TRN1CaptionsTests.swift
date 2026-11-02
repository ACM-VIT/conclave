#if !SKIP
import Foundation
import Testing
@testable import Conclave

@MainActor
struct TRN1CaptionsTests {
    final class Clock {
        var millis = 5_000_000.0
    }

    static let longSleep: (Double) async -> Void = { _ in try? await Task.sleep(nanoseconds: 60_000_000_000) }

    private func segment(_ id: String, _ sequence: Int, _ speaker: String, _ text: String, final: Bool,
                         at: Double = 1_000) -> TranscriptSegmentModel {
        TranscriptSegmentModel(itemId: id, sequence: sequence, speakerUserId: speaker.lowercased(), speakerDisplayName: speaker,
                               text: text, startMs: at, isFinal: final)
    }

    @Test func liveNotesPolicyTable() {
        let none = TranscriptIssue.none
        #expect(LiveNotesPolicy.stageState(phase: .loading, link: .connected, issue: none) == .off)
        #expect(LiveNotesPolicy.stageState(phase: .idle, link: .connected, issue: none) == .off)
        #expect(LiveNotesPolicy.stageState(phase: .ended, link: .connected, issue: none) == .off)
        #expect(LiveNotesPolicy.stageState(phase: .starting, link: .connected, issue: none) == .starting)
        #expect(LiveNotesPolicy.stageState(phase: .live, link: .connected, issue: none) == .live)
        #expect(LiveNotesPolicy.stageState(phase: .stopping, link: .reconnecting, issue: none) == .live)
        #expect(LiveNotesPolicy.stageState(phase: .paused, link: .connected, issue: none) == .paused)
        #expect(LiveNotesPolicy.stageState(phase: .takeoverNeeded, link: .connected, issue: none) == .needsAttention)
        #expect(LiveNotesPolicy.stageState(phase: .unavailable, link: .failed, issue: none) == .needsAttention)
        #expect(LiveNotesPolicy.stageState(phase: .live, link: .failed, issue: none) == .needsAttention)
        #expect(LiveNotesPolicy.stageState(phase: .live, link: .connected, issue: .relayFailed) == .needsAttention)
        #expect(LiveNotesPhase.allCases.count == 9 && TranscriptIssue.allCases.count == 5 && RelayAvailability.allCases.count == 3)
    }

    @Test func phaseAndLinkFollowTheWorkerStatusAndTheAttempts() {
        #expect(TranscriptPhasePolicy.phase(sessionStatus: "live", hasSnapshot: false, failedAttempts: 0, sawSession: false) == .loading)
        #expect(TranscriptPhasePolicy.phase(sessionStatus: "idle", hasSnapshot: true, failedAttempts: 0, sawSession: false) == .idle)
        #expect(TranscriptPhasePolicy.phase(sessionStatus: "idle", hasSnapshot: true, failedAttempts: 0, sawSession: true) == .ended)
        #expect(TranscriptPhasePolicy.phase(sessionStatus: "takeover_needed", hasSnapshot: true, failedAttempts: 0, sawSession: true)
                == .takeoverNeeded)
        #expect(TranscriptPhasePolicy.phase(sessionStatus: "live", hasSnapshot: true, failedAttempts: 7, sawSession: true) == .live)
        #expect(TranscriptPhasePolicy.phase(sessionStatus: "live", hasSnapshot: true, failedAttempts: 8, sawSession: true) == .unavailable)
        #expect(TranscriptPhasePolicy.link(connectionStatus: .connected, failedAttempts: 0) == .connected)
        #expect(TranscriptPhasePolicy.link(connectionStatus: .connecting, failedAttempts: 3) == .reconnecting)
        #expect(TranscriptPhasePolicy.link(connectionStatus: .connecting, failedAttempts: 8) == .failed)

        let state = TranscriptState()
        var refreshes = 0
        state.onStageInputChanged = { refreshes += 1 }
        #expect(state.phase == .loading && state.liveNotes == .off)
        state.markSessionSnapshot()
        state.connectionStatus = .connected
        state.sessionStatus = "live"
        #expect(state.phase == .live && state.liveNotes == .live)
        state.setIssue(.relayFailed)
        #expect(state.liveNotes == .needsAttention)
        state.setIssue(.server, serverText: "Provider quota exceeded")
        #expect(state.issueServerText == "Provider quota exceeded")
        state.setIssue(.none)
        state.sessionStatus = "idle"
        #expect(state.phase == .ended)
        #expect(refreshes >= 6)
        state.resetAll()
        #expect(state.phase == .loading && state.issue == .none && state.relay == .unknown && state.sessionStartedAtMillis == 0)
    }

    @Test func catchUpIsOfferedToLateJoinersAfterTwoMinutes() {
        let start = 1_700_000_000_000.0
        #expect(CatchUpPolicy.minutes(phase: .live, sessionStartedAtMillis: start, joinedAtMillis: start + 60_000, isAttendee: false) == 0)
        #expect(CatchUpPolicy.minutes(phase: .live, sessionStartedAtMillis: start, joinedAtMillis: start + 120_000, isAttendee: false) == 2)
        #expect(CatchUpPolicy.minutes(phase: .paused, sessionStartedAtMillis: start, joinedAtMillis: start + 444_000, isAttendee: false) == 7)
        #expect(CatchUpPolicy.minutes(phase: .idle, sessionStartedAtMillis: start, joinedAtMillis: start + 444_000, isAttendee: false) == 0)
        #expect(CatchUpPolicy.minutes(phase: .live, sessionStartedAtMillis: start, joinedAtMillis: start + 444_000, isAttendee: true) == 0)
        #expect(CatchUpPolicy.minutes(phase: .live, sessionStartedAtMillis: 0, joinedAtMillis: start, isAttendee: false) == 0)

        let center = MeetingNoticeCenter()
        let offer = StageNoticeInputs.make(callSession: 1, localUserId: "you", catchUpMinutes: 2)
        _ = center.applyState(offer, nowMillis: 0)
        #expect(center.banner?.kind == NoticeKind.catchUp)
        center.dismiss(id: center.banner?.id ?? "", nowMillis: 1)
        _ = center.applyState(StageNoticeInputs.make(callSession: 1, localUserId: "you", catchUpMinutes: 3), nowMillis: 2)
        #expect(center.banner == nil)

        let fresh = MeetingNoticeCenter()
        fresh.setCurrentPanel(MeetingPanel.transcript.rawValue, nowMillis: 0)
        _ = fresh.applyState(offer, nowMillis: 0)
        #expect(fresh.banner == nil)
    }

    @Test func relayUnavailableOffersNoStartAndAttendeesNeverOpenTheStream() {
        #expect(LiveNotesStartPolicy.offersStart(canStart: true, relay: .available, phase: .idle))
        #expect(LiveNotesStartPolicy.offersStart(canStart: true, relay: .unknown, phase: .ended))
        #expect(!LiveNotesStartPolicy.offersStart(canStart: true, relay: .unavailable, phase: .idle))
        #expect(!LiveNotesStartPolicy.offersStart(canStart: false, relay: .available, phase: .idle))
        #expect(!LiveNotesStartPolicy.offersStart(canStart: true, relay: .available, phase: .live))
        #expect(LiveNotesStartPolicy.showsUnavailable(relay: .unavailable, phase: .idle))
        #expect(LiveNotesStartPolicy.showsUnavailable(relay: .available, phase: .unavailable))
        #expect(TranscriptStreamPolicy.shouldBeOpen(isInCall: true, isAttendee: false))
        #expect(!TranscriptStreamPolicy.shouldBeOpen(isInCall: true, isAttendee: true))
        #expect(!TranscriptStreamPolicy.shouldBeOpen(isInCall: false, isAttendee: false))
        #expect(TranscriptStreamPolicy.shouldProbeRelay(isInCall: true, isAttendee: false, relay: .unknown, afterRecovery: false))
        #expect(!TranscriptStreamPolicy.shouldProbeRelay(isInCall: true, isAttendee: false, relay: .available, afterRecovery: false))
        #expect(TranscriptStreamPolicy.shouldProbeRelay(isInCall: true, isAttendee: false, relay: .available, afterRecovery: true))
        #expect(!TranscriptStreamPolicy.shouldProbeRelay(isInCall: true, isAttendee: true, relay: .unknown, afterRecovery: true))
        let state = TranscriptState()
        state.setRelay(.unavailable)
        #expect(state.relay == .unavailable)
    }

    @Test func theCaptionLineKeepsTheNewestWordsOfALongMonologue() {
        var words: [String] = []
        for index in 0..<400 { words.append("word\(index)") }
        let monologue = words.joined(separator: " ")
        let tail = CaptionLinePolicy.trimmedTail(monologue)
        #expect(tail.count <= CaptionLinePolicy.maxCharacters)
        #expect(tail.hasPrefix("…") && tail.hasSuffix("word399"))
        #expect(!tail.contains(" word2 "))
        #expect(CaptionLinePolicy.trimmedTail("  short line ") == "short line")
        let longWord = String(repeating: "a", count: 300)
        #expect(CaptionLinePolicy.trimmedTail(longWord).count == CaptionLinePolicy.maxCharacters)
    }

    @Test func theNewestPartialWinsOverTheLastFinal() {
        let final = segment("f", 4, "Avery", "the deck is ready", final: true)
        let older = segment("p1", 3, "Ben", "older partial", final: false)
        let newer = segment("p2", 5, "Sam", "and then we probably need to dec", final: false)
        #expect(CaptionLinePolicy.newest(partials: [older, newer], lastFinal: final)?.itemId == "p2")
        #expect(CaptionLinePolicy.newest(partials: [], lastFinal: final)?.itemId == "f")
        let line = CaptionLinePolicy.line(from: newer, atMillis: 10)
        #expect(line.speakerName == "Sam" && !line.isFinal && line.isVisible)
    }

    @Test func transcriptStateSendsCaptionsForLiveDeltasOnly() {
        let state = TranscriptState()
        var lines: [CaptionLine] = []
        state.onCaptionChanged = { line in lines.append(line) }
        state.replaceSnapshot(finals: [segment("h", 1, "Avery", "history", final: true)], partials: [])
        #expect(lines.isEmpty, "history is not a caption")
        state.applyPartial(segment("p", 2, "Sam", "and then", final: false))
        state.applyPartial(segment("p", 2, "Sam", "and then", final: false))
        state.applyPartial(segment("p", 2, "Sam", "and then we", final: false))
        state.applyFinal(segment("p", 2, "Sam", "and then we ship", final: true))
        #expect(lines.map(\.text) == ["and then", "and then we", "and then we ship"])
        #expect(lines.map(\.isFinal) == [false, false, true])

        #expect(state.orderedSegments.map(\.itemId) == ["h", "p"])
    }

    @Test func thirtyDeltasPerSecondPublishAtMostTenTimes() {
        let clock = Clock()
        let feed = CaptionLineFeed()
        feed.now = { clock.millis }
        feed.sleep = TRN1CaptionsTests.longSleep
        feed.begin()
        #expect(feed.line.isPlaceholder)
        let start = feed.publishCount
        for index in 1...30 {
            clock.millis += 1000.0 / 30.0
            feed.update(CaptionLine(speakerName: "Avery", text: "word " + String(index), isFinal: false, updatedAtMillis: 0, isVisible: true))

            if feed.pending != nil && clock.millis - feed.lastPublishMillis >= CaptionLinePolicy.minimumIntervalMillis {
                feed.flushPending()
            }
        }
        #expect(feed.publishCount - start <= 10)
        #expect(feed.publishCount - start >= 5)

        clock.millis += 200
        feed.flushPending()
        #expect(feed.line.text == "word 30")
    }

    @Test func partialTextIsSecondaryAndTheLineHidesAfterSixSecondsOfSilence() throws {
        let clock = Clock()
        let feed = CaptionLineFeed()
        feed.now = { clock.millis }
        feed.sleep = TRN1CaptionsTests.longSleep
        feed.begin()
        clock.millis += 500
        feed.update(CaptionLine(speakerName: "Sam", text: "and then we probably need to dec", isFinal: false, updatedAtMillis: 0,
                                isVisible: true))
        #expect(feed.line.isVisible && !feed.line.isFinal)
        clock.millis += 5_999
        feed.hideIfSilent()
        #expect(feed.line.isVisible)
        clock.millis += 1
        feed.hideIfSilent()
        #expect(!feed.line.isVisible)
        feed.reset()
        #expect(feed.line == CaptionLine.empty && !feed.hasLiveTimers)
    }

    @Test func theStripMountsOnlyForLiveCaptionsOutsideTheAudience() {
        let live = StageFixtureSession(state: .captionsLive)
        #expect(live.stage.captionsActive && live.stage.captions.line.text == "so the deck is ready for review")
        let partial = StageFixtureSession(state: .captionsPartial)
        #expect(partial.stage.captionsActive && !partial.stage.captions.line.isFinal)
        let quiet = StageFixtureSession(state: .captionsQuiet)
        #expect(quiet.stage.captionsActive && quiet.stage.captions.line.isPlaceholder)
        let attendee = StageFixtureSession(state: .captionsAttendee)
        #expect(!attendee.stage.captionsActive && !attendee.stage.captions.line.isVisible, "attendees get no strip")
        let off = StageFixtureSession(state: .grid4)
        #expect(!off.stage.captionsActive)

        let stage = StagePresenter(shell: MeetingShellPresenter())
        stage.captions.sleep = TRN1CaptionsTests.longSleep
        stage.apply(StageFixtureScript.copy(StageFixtureScript.base(count: 4), captionsOn: true, liveNotes: .paused))
        stage.captionChanged(CaptionLine(speakerName: "A", text: "hello", isFinal: true, updatedAtMillis: 0, isVisible: true))
        #expect(!stage.captionsActive && stage.captions.publishCount == 0)
    }

    @Test func theCaptionsPreferenceFollowsTheSystemOnFirstUseThenPersists() throws {
        let suite = "trn1.captions." + UUID().uuidString
        let defaults = try #require(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        #expect(CaptionsPreference.isOn(defaults: defaults, systemDefault: true))
        #expect(!CaptionsPreference.isOn(defaults: defaults, systemDefault: false))
        CaptionsPreference.set(false, defaults: defaults)
        #expect(!CaptionsPreference.isOn(defaults: defaults, systemDefault: true))
        CaptionsPreference.set(true, defaults: defaults)
        #expect(CaptionsPreference.isOn(defaults: defaults, systemDefault: false))
        #expect(CaptionsPreference.defaultsKey == "conclave.pref.captions")
    }
}
#endif
