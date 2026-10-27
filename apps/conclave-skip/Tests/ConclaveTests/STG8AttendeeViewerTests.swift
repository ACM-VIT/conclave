#if !SKIP
import Foundation
import Testing
@testable import Conclave

/// STG-8 (OUT/PLAN-screens.md section 5; S20 12 l, 0.5 `AttendeeViewerSnapshot`, SC22; S30 0.6; RECONCILE R18, R30,
/// R44): the attendee fixtures (waiting with 128 people, live camera, live share with the inset, two unseen answers), the
/// program feed keeping its renderer when a share starts, no grid or captions for attendees, the hand capability hidden
/// until PPL-5, the capsule (webinar title and "Live") opening Webinar Details, the live and demotion announcements, the
/// auto-hide rule and the view sources. The Kotlin twin with the same fixtures is T/Skip/STG6STG8BridgeTests.kt.
@MainActor
struct STG8AttendeeViewerTests {
    static let longSleep: (Double) async -> Void = { _ in try? await Task.sleep(nanoseconds: 60_000_000_000) }

    private func presenter() -> StagePresenter {
        let stage = StagePresenter(shell: MeetingShellPresenter())
        stage.sleep = STG8AttendeeViewerTests.longSleep
        stage.captions.sleep = STG8AttendeeViewerTests.longSleep
        stage.shell.panels.onSnapshotChanged = { [weak stage] in stage?.panelSnapshotChanged() }
        stage.setViewport(StagePoliciesTests.iphoneSE)
        return stage
    }

    private func slotSummary(_ stage: StagePresenter) -> [String] {
        var result: [String] = []
        for slot in stage.layout.slots {
            result.append(slot.id + "/" + slot.role.rawValue + "/" + slot.fit.rawValue)
        }
        return result
    }

    // MARK: Fixtures (S20 12 l)

    @Test func waitingFixtureShowsTheTitleAndCountWithNoFeed() throws {
        let session = StageFixtureSession(state: .attendeeWaiting128)
        let viewer = try #require(session.stage.attendee)
        #expect(session.stage.kind == .attendeeWaiting)
        #expect(viewer.state == AttendeeViewerPolicy.waitingState && !viewer.isLive)
        #expect(viewer.waitingCount == 128 && AttendeeViewerPolicy.showsWaitingCount(viewer.waitingCount))
        #expect(viewer.title == StageFixtureScript.webinarTitle)
        #expect(session.stage.layout.slots.isEmpty && session.stage.layout.overflowCount == 0)
        #expect(!AttendeeViewerPolicy.showsWaitingCount(1) && AttendeeViewerPolicy.showsWaitingCount(2))
        #expect(session.attendeeReadout() == "state=waiting feed= inset= waiting=128 qa=0")
    }

    @Test func liveFeedFillsAndAShareFeedFitsWithThePresenterInset() throws {
        let live = StageFixtureSession(state: .attendeeLive)
        #expect(live.stage.kind == .attendeeLive)
        #expect(slotSummary(live.stage) == ["p:r1/programFeed/fill"])
        #expect(live.stage.attendee?.feedName == "Avery" && live.stage.attendee?.isShareFeed == false)
        let share = StageFixtureSession(state: .attendeeLiveShare)
        #expect(slotSummary(share.stage) == ["share:r2/programFeed/fit", "p:r2/speakerInset/fill"])
        let viewer = try #require(share.stage.attendee)
        #expect(viewer.isShareFeed && viewer.feedUserId == "r2" && viewer.insetUserId == "r2")
        #expect(share.stage.bindings.binding(for: "share:r2").videoKey == "probe:share:r2")
        #expect(share.stage.bindings.binding(for: "p:r2").videoKey == "probe:r2")
    }

    @Test func theProgramFeedKeepsItsRendererWhenAShareStarts() {
        let stage = presenter()
        let camera = StageFixtureScript.inputs(for: .attendeeLive)
        stage.apply(camera)
        #expect(slotSummary(stage) == ["p:r1/programFeed/fill"])
        let binding = stage.bindings.binding(for: "p:r1")
        // Avery starts sharing: the camera keeps its "p:" slot (now the inset), so its renderer is not recreated.
        var rows: [StageParticipantInput] = []
        for participant in camera.participants {
            if participant.userId == "r1" {
                rows.append(StageParticipantInput.make(userId: "r1", displayName: "Avery", isMuted: false, isCameraOff: false,
                                                       isScreenSharing: true, isHost: true, joinSerial: 1, videoKey: "probe:r1",
                                                       shareVideoKey: "probe:share:r1"))
            } else {
                rows.append(participant)
            }
        }
        stage.apply(StageFixtureScript.copy(camera, participants: rows, screenShareUserId: "r1"))
        #expect(slotSummary(stage) == ["share:r1/programFeed/fit", "p:r1/speakerInset/fill"])
        #expect(stage.bindings.binding(for: "p:r1") === binding && binding.videoKey == "probe:r1")
        // A per-session fit override on the feed wins (SC4).
        stage.setSlotFit(.fill, slotId: "share:r1")
        #expect(slotSummary(stage).first == "share:r1/programFeed/fill")
    }

    @Test func noGridNoCaptionsAndNoSelfViewForAttendees() {
        for state in [StageFixtureState.attendeeWaiting128, .attendeeLive, .attendeeLiveShare, .attendeeQaUnseen2] {
            let stage = StageFixtureSession(state: state).stage
            for slot in stage.layout.slots {
                #expect(slot.role == .programFeed || slot.role == .speakerInset, "\(state.rawValue) drew \(slot.role.rawValue)")
                #expect(slot.userId != StageFixtureScript.localUserId)
            }
            #expect(!stage.captionsActive)
        }
        let captions = StageFixtureScript.copy(StageFixtureScript.inputs(for: .attendeeLive), captionsOn: true, liveNotes: .live)
        let stage = presenter()
        stage.apply(captions)
        #expect(!stage.captionsActive, "attendees hold no transcript tokens (S20 Q11)")
    }

    @Test func qaUnseenFixtureCarriesTheBadgeAndTheHandStaysHidden() throws {
        let viewer = try #require(StageFixtureSession(state: .attendeeQaUnseen2).stage.attendee)
        #expect(viewer.qaEnabled && viewer.webinarQaUnseen == 2)
        #expect(!viewer.canRaiseHand, "the attendee hand stays hidden until PPL-5 (S20 Q10)")
        // Q&A off reads no unseen count.
        let off = AttendeeViewerPolicy.snapshot(inputs: StageFixtureScript.inputs(for: .attendeeQaUnseen2),
                                                details: StageDetailsInputs.make(callSession: 1, webinarQaUnseen: 2),
                                                feed: AttendeeFeed.none, hand: .lowered)
        #expect(!off.qaEnabled && off.webinarQaUnseen == 0)
        // The S30 attendee composition (CTL-1): Raise Hand only with the capability, Q&A with the badge, Leave last.
        #expect(ControlBarPolicy.order(.attendee) == [.hand, .qa, .leave])
        let controls = stageNormalized(try stageSource("Sources/Conclave/Features/Meeting/Controls/ControlBarPolicy.swift"))
        #expect(controls.contains("guard inputs.attendeeCanRaiseHand else { return nil }"))
    }

    @Test func theCapsuleReadsTheWebinarTitleAndLiveAndOpensWebinarDetails() throws {
        let session = StageFixtureSession(state: .attendeeLive)
        let capsule = session.stage.capsule
        #expect(capsule.title == StageFixtureScript.webinarTitle)
        #expect(capsule.subtitleKind == AttendeeViewerPolicy.capsuleLiveKind)
        #expect(!capsule.isLocked && !capsule.captionsOn)
        session.stage.openMeetingInfo()
        let info = try #require(session.stage.meetingInfo)
        #expect(info.isAttendee && MeetingInfoPolicy.rowIds(info).last == "settings")
        #expect(session.panelReadout() == "panel=meetingInfo invoker=call destination=none")
        // An empty landing title stays empty in the model; the views show the "Webinar" fallback (SC22).
        let stage = presenter()
        stage.apply(StageFixtureScript.inputs(for: .attendeeLive))
        #expect(stage.capsule.title.isEmpty && stage.attendee?.title == "")
    }

    @Test func theLiveStartIsAnnouncedOncePerSessionAndADemotionOnce() {
        let stage = presenter()
        let waiting = StageFixtureScript.inputs(for: .attendeeWaiting128)
        let live = StageFixtureScript.inputs(for: .attendeeLive)
        stage.apply(waiting)
        stage.apply(live)
        stage.apply(waiting)
        stage.apply(live)
        let liveCount = stage.announcementLog.filter { $0.hasPrefix(AttendeeViewerPolicy.webinarLiveAnnouncement + ":") }.count
        #expect(liveCount == 1)
        // Moved to the audience inside the call: announced once; joining as an attendee is not a demotion.
        let demoted = presenter()
        demoted.apply(StageFixtureScript.base(count: 3))
        demoted.apply(StageFixtureScript.copy(StageFixtureScript.base(count: 3), isWebinarAttendee: true))
        #expect(demoted.announcementLog.contains(AttendeeViewerPolicy.demotedAnnouncement + ":"))
        let fresh = presenter()
        fresh.apply(waiting)
        #expect(!fresh.announcementLog.contains(AttendeeViewerPolicy.demotedAnnouncement + ":"))
        #expect(!AttendeeViewerPolicy.isDemotion(previous: StageInputs.make(), next: waiting))
    }

    @Test func chromeAutoHidesOnlyOnceTheFeedIsLive() {
        #expect(StageFixtureSession(state: .attendeeWaiting128).stage.autoHideBlocker == .noRemoteVideo)
        #expect(StageFixtureSession(state: .attendeeLive).stage.autoHideBlocker == AutoHideBlocker.none)
        #expect(StageFixtureSession(state: .attendeeLiveShare).stage.autoHideBlocker == AutoHideBlocker.none)
    }

    @Test func theFeedChoiceFollowsShareThenSpeakerThenAnyCamera() {
        let base = StageFixtureScript.inputs(for: .attendeeWaiting128)
        #expect(AttendeeViewerPolicy.feed(base) == AttendeeFeed.none)
        var rows: [StageParticipantInput] = []
        for participant in base.participants {
            if participant.userId == "r2" {
                rows.append(StageParticipantInput.make(userId: "r2", displayName: "Ben", isCameraOff: false, joinSerial: 2,
                                                       videoKey: "probe:r2"))
            } else {
                rows.append(participant)
            }
        }
        let cameraOnly = StageFixtureScript.copy(base, participants: rows)
        #expect(AttendeeViewerPolicy.feed(cameraOnly) == AttendeeFeed(userId: "r2", isShare: false, insetUserId: ""))
        let speaker = StageFixtureScript.copy(cameraOnly, webinarSpeakerUserId: "r1")
        #expect(AttendeeViewerPolicy.feed(speaker).userId == "r1")
        // A share with the presenter's camera off has no inset.
        let share = StageFixtureScript.copy(speaker, screenShareUserId: "r1")
        #expect(AttendeeViewerPolicy.feed(share) == AttendeeFeed(userId: "r1", isShare: true, insetUserId: ""))
        #expect(AttendeeViewerPolicy.kind(AttendeeFeed.none) == .attendeeWaiting)
    }

    // MARK: Sources

    @Test func attendeeViewerSourcesStayInTheInCallTheme() throws {
        let ios = stageNormalized(try stageSource("Sources/Conclave/Features/Meeting/Stage/AttendeeViewer+iOS.swift"))
        #expect(ios.contains("ContentUnavailableView {"))
        #expect(ios.contains("ConclaveStrings.text(\"The Webinar Will Begin Soon\")"))
        #expect(ios.contains("ConclaveStrings.format(\"Webinar Waiting Count %lld\", count)"))
        #expect(ios.contains("ConclaveStrings.format(\"Shared Screen from %@\", name)"))
        #expect(ios.contains("if let viewer = stage.attendee, !viewer.isLive {"))
        let android = stageNormalized(try stageSource("Sources/Conclave/Skip/ui/call/stage/AttendeeViewer.kt"))
        #expect(android.contains("ConclaveEmptyStatus("))
        #expect(android.contains("conclavePlural(\"stg_webinar_waiting_count\", count, count)"))
        #expect(android.contains("conclaveString(\"stg_announce_webinar_live\")"))
        #expect(!android.contains("Text(\""))
        let callRoot = stageNormalized(try stageSource("Sources/Conclave/Skip/ui/call/stage/CallRoot.kt"))
        #expect(callRoot.contains("AttendeeViewerPolicy.demotedAnnouncement, AttendeeViewerPolicy.webinarLiveAnnouncement ->"))
    }
}
#endif
