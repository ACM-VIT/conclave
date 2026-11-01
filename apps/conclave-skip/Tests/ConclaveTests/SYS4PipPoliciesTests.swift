#if !SKIP
import Foundation
import Testing
@testable import Conclave

@MainActor
struct SYS4PipPoliciesTests {
    static func frame(_ slotId: String = "p:r1", left: Double = 0, top: Double = 0, right: Double = 0, bottom: Double = 0,
                      width: Int = 0, height: Int = 0) -> PipTargetFrame {
        PipTargetFrame(slotId: slotId, left: left, top: top, right: right, bottom: bottom, videoWidth: width, videoHeight: height)
    }

    static func snapshot(phase: CallPresencePhase = .live, isMuted: Bool = false, isAttendee: Bool = false,
                         target: PipTargetFrame? = nil, title: String = "lily-zoro-iris", session: Int = 3) -> CallPresenceSnapshot {
        CallPresenceSnapshot(
            revision: 1, presenceSession: session, callSession: 1, phase: phase, title: title, roomId: title,
            joinedAtMillis: 1_000, isMuted: isMuted, isCameraOn: false, isPresenting: false, isAttendee: isAttendee,
            surface: .none, surfaceStatus: .inactive, interruption: .none, pip: .eligible, isInPictureInPicture: false,
            pipTarget: target, keepsScreenAwake: true, proximityArmed: false, cameraContinuesInBackground: false,
            endReason: .none
        )
    }

    @Test func aspectFollowsTheDecodedFrameSizeAndClampsToTheAndroidLimits() {
        #expect(PipParamsPolicy.aspect(width: 720, height: 1280) == PipAspect(width: 9, height: 16))
        #expect(PipParamsPolicy.aspect(width: 1280, height: 720) == PipAspect(width: 16, height: 9))
        #expect(PipParamsPolicy.aspect(width: 640, height: 480) == PipAspect(width: 4, height: 3))

        #expect(PipParamsPolicy.aspect(width: 900, height: 300) == PipAspect.widest)
        #expect(PipParamsPolicy.aspect(width: 300, height: 900) == PipAspect.tallest)
        #expect(PipAspect.widest == PipAspect(width: 239, height: 100))

        #expect(PipParamsPolicy.aspect(width: 0, height: 0) == PipAspect.standard)
        #expect(PipParamsPolicy.aspect(width: 1280, height: 0) == PipAspect(width: 16, height: 9))
    }

    @Test func sourceRectIsTheSlotBoundsInWindowPxOrNothing() {
        let laidOut = Self.frame(left: 10.4, top: 20.6, right: 370.4, bottom: 660.2, width: 720, height: 1280)
        #expect(PipParamsPolicy.sourceRect(laidOut) == PipSourceRect(left: 10, top: 21, right: 370, bottom: 660))

        #expect(PipParamsPolicy.sourceRect(Self.frame(width: 720, height: 1280)) == nil)
        #expect(PipParamsPolicy.sourceRect(nil) == nil)
        #expect(laidOut.hasBounds && laidOut.hasVideoSize && !laidOut.isShare)
        #expect(Self.frame("share:r2").isShare)
    }

    @Test func paramsComeFromTheSnapshotAndItsTargetFrame() {
        let target = Self.frame(left: 0, top: 100, right: 360, bottom: 740, width: 720, height: 1280)
        let muted = PipParamsPolicy.params(snapshot: Self.snapshot(isMuted: true, target: target), availability: .eligible)
        #expect(muted.aspect == PipAspect(width: 9, height: 16))
        #expect(muted.sourceRect == PipSourceRect(left: 0, top: 100, right: 360, bottom: 740))
        #expect(muted.actions == [.unmute, .leave])
        #expect(muted.autoEnterEnabled)
        #expect(muted.title == "lily-zoro-iris")
        #expect(muted.subtitle == .muted)
        #expect(muted.presenceSession == 3)

        let unmuted = PipParamsPolicy.params(snapshot: Self.snapshot(isMuted: false), availability: .eligible)
        #expect(unmuted.actions == [.mute, .leave])
        #expect(unmuted.subtitle == PipSubtitleKind.none)
        #expect(unmuted.aspect == PipAspect.standard)
        #expect(unmuted.sourceRect == nil)

        let attendee = PipParamsPolicy.params(snapshot: Self.snapshot(isMuted: true, isAttendee: true), availability: .eligible)
        #expect(attendee.actions == [.leave])
        #expect(attendee.subtitle == PipSubtitleKind.none)

        #expect(PipParamsPolicy.params(snapshot: Self.snapshot(phase: .recovering, isMuted: true), availability: .eligible).subtitle == .reconnecting)
        #expect(PipParamsPolicy.params(snapshot: Self.snapshot(phase: .onHold, isMuted: true), availability: .eligible).subtitle == .onHold)

        for availability in [PipAvailability.suppressed, .disabledByUser, .active, .notEligible, .unsupported] {
            #expect(!PipParamsPolicy.params(snapshot: Self.snapshot(), availability: availability).autoEnterEnabled)
        }

        #expect(PipParamsPolicy.params(snapshot: Self.snapshot(target: target), availability: .eligible)
                == PipParamsPolicy.params(snapshot: Self.snapshot(target: target), availability: .eligible))
    }

    @Test func actionNamesAreTheGeneratedDrawablesAndMatchTheCallNotification() {
        #expect(PipParamsPolicy.actionDrawableName(.mute) == "conclave_mic_fill1")
        #expect(PipParamsPolicy.actionDrawableName(.unmute) == "conclave_mic_off_fill1")
        #expect(PipParamsPolicy.actionDrawableName(.leave) == "conclave_call_end_fill1")
        #expect(PipParamsPolicy.actionDrawableName(.mute) == NotificationPostPolicy.actionDrawableName(.mute))
        #expect(PipParamsPolicy.actionDrawableName(.unmute) == NotificationPostPolicy.actionDrawableName(.unmute))
        #expect(PipParamsPolicy.actionTitleName(.mute) == "stg_pip_mute")
        #expect(PipParamsPolicy.actionTitleName(.unmute) == "stg_pip_unmute")
        #expect(PipParamsPolicy.actionTitleName(.leave) == "ds_leave_call")
        #expect(PipParamsPolicy.subtitleName(.muted) == "stg_pip_muted")
        #expect(PipParamsPolicy.subtitleName(.reconnecting) == "sys_pip_reconnecting")
        #expect(PipParamsPolicy.subtitleName(.onHold) == "sys_pip_on_hold")
        #expect(PipParamsPolicy.subtitleName(.none) == "")
        let target = Self.frame(left: 0, top: 100, right: 360, bottom: 740, width: 720, height: 1280)
        let model = PipParamsPolicy.params(snapshot: Self.snapshot(target: target), availability: .eligible)
        #expect(PipParamsPolicy.readout(model) == "aspect=9:16 rect=0,100,360,740 autoEnter=1")
        #expect(PipParamsPolicy.readout(PipParamsModel.inactive) == "aspect=16:9 rect=none autoEnter=0")
    }

    @Test func availabilityAndMinimizeFollowTheCallAndThePerson() {
        func availability(_ supported: Bool = true, allowed: Bool = true, suppressed: Bool = false, active: Bool = false,
                          phase: CallPresencePhase = .live) -> PipAvailability {
            PipAvailabilityPolicy.availability(isSupported: supported, isAllowedByUser: allowed, isSuppressed: suppressed,
                                               isActive: active, phase: phase)
        }
        #expect(availability() == .eligible)
        #expect(availability(phase: .recovering) == .eligible)
        #expect(availability(phase: .onHold) == .eligible)
        #expect(availability(phase: .waiting) == .notEligible)
        #expect(availability(phase: .connecting) == .notEligible)
        #expect(availability(phase: .ending) == .notEligible)
        #expect(availability(phase: .idle) == .notEligible)
        #expect(availability(suppressed: true) == .suppressed)
        #expect(availability(allowed: false) == .disabledByUser)
        #expect(availability(false) == .unsupported)
        #expect(availability(active: true) == .active)

        #expect(PipEntryPolicy.minimize(availability: .eligible) == .enterPictureInPicture)
        for other in [PipAvailability.suppressed, .disabledByUser, .unsupported, .notEligible, .active] {
            #expect(PipEntryPolicy.minimize(availability: other) == .moveTaskToBack)
        }

        #expect(PipEntryPolicy.entersOnUserLeaveHint(api: 28, availability: .eligible, isRequestingCapture: false))
        #expect(!PipEntryPolicy.entersOnUserLeaveHint(api: 31, availability: .eligible, isRequestingCapture: false))
        #expect(!PipEntryPolicy.entersOnUserLeaveHint(api: 29, availability: .suppressed, isRequestingCapture: false))
        #expect(!PipEntryPolicy.entersOnUserLeaveHint(api: 30, availability: .eligible, isRequestingCapture: true))
    }

    @Test func contentFollowsTheTargetAndTheWindowWidth() {
        let choice = PipTargetChoice(slotId: "p:r2", userId: "r2", isShare: false)
        let camera = StageParticipantInput.make(userId: "r2", displayName: "Avery", isMuted: true, isCameraOff: false,
                                                joinSerial: 2, videoKey: "probe:r2")
        let video = PipContentPolicy.content(choice: choice, participant: camera, phase: .live, windowWidth: 240)
        #expect(video.kind == .video && video.name == "Avery" && video.isMuted && video.showsNamePill && video.status == .none)

        #expect(!PipContentPolicy.content(choice: choice, participant: camera, phase: .live, windowWidth: 159).showsNamePill)
        #expect(PipContentPolicy.content(choice: choice, participant: camera, phase: .live, windowWidth: 160).showsNamePill)

        let off = StageParticipantInput.make(userId: "r2", displayName: "Avery", isCameraOff: true, joinSerial: 2)
        #expect(PipContentPolicy.content(choice: choice, participant: off, phase: .live, windowWidth: 240).kind == .avatar)

        let alone = PipContentPolicy.content(choice: PipTargetChoice.none, participant: nil, phase: .live, windowWidth: 240)
        #expect(alone.kind == .solo && !alone.showsNamePill)

        let shareChoice = PipTargetChoice(slotId: "share:r1", userId: "r1", isShare: true)
        let sharing = StageParticipantInput.make(userId: "r1", displayName: "Kai", isScreenSharing: true, joinSerial: 1,
                                                 shareVideoKey: "probe:share:r1")
        let share = PipContentPolicy.content(choice: shareChoice, participant: sharing, phase: .live, windowWidth: 240)
        #expect(share.kind == .video && share.isShare)

        #expect(PipContentPolicy.content(choice: choice, participant: camera, phase: .recovering, windowWidth: 240).status == .reconnecting)
        #expect(PipContentPolicy.content(choice: choice, participant: camera, phase: .onHold, windowWidth: 240).status == .onHold)
        #expect(PipContentPolicy.status(phase: .live) == PipStatusPill.none)
    }

    @Test func theNativeRootLaysOutOnlyTheTargetInPip() {
        let frames = PipStageLayoutPolicy.frames(targetSlotId: "p:r2", width: 240, height: 135)
        #expect(frames == [StageFrame(slotId: "p:r2", x: 0, y: 0, width: 240, height: 135)])
        #expect(PipStageLayoutPolicy.frames(targetSlotId: "", width: 240, height: 135).isEmpty)
        #expect(PipStageLayoutPolicy.frames(targetSlotId: "p:r2", width: 0, height: 135).isEmpty)
    }

    @Test func theControllerIsBuiltOnceAtTheFirstLiveAndStoppedBeforeReleaseAtEnding() {
        let machine = PipLifetimeMachine()
        #expect(machine.presenceChanged(phase: .connecting, targetSlotId: "", videoWidth: 0, videoHeight: 0, anchorRevision: 1).isEmpty)

        #expect(machine.presenceChanged(phase: .live, targetSlotId: "p:r1", videoWidth: 0, videoHeight: 0, anchorRevision: 0).isEmpty)

        #expect(machine.presenceChanged(phase: .live, targetSlotId: "p:r1", videoWidth: 0, videoHeight: 0, anchorRevision: 1)
                == [.createController])

        #expect(machine.presenceChanged(phase: .recovering, targetSlotId: "p:r1", videoWidth: 0, videoHeight: 0, anchorRevision: 1).isEmpty)
        #expect(machine.presenceChanged(phase: .connecting, targetSlotId: "p:r1", videoWidth: 0, videoHeight: 0, anchorRevision: 1).isEmpty)
        #expect(machine.presenceChanged(phase: .live, targetSlotId: "p:r1", videoWidth: 0, videoHeight: 0, anchorRevision: 1).isEmpty)

        #expect(machine.presenceChanged(phase: .live, targetSlotId: "p:r2", videoWidth: 0, videoHeight: 0, anchorRevision: 1).isEmpty)

        #expect(machine.sceneChanged(.inactive) == [.attachSink])
        #expect(machine.sceneChanged(.background).isEmpty)

        #expect(machine.presenceChanged(phase: .live, targetSlotId: "p:r3", videoWidth: 0, videoHeight: 0, anchorRevision: 1)
                == [.retargetSink])
        #expect(machine.pictureInPictureStarted() == [.suspendFeedback])

        let ending = machine.presenceChanged(phase: .ending, targetSlotId: "p:r3", videoWidth: 0, videoHeight: 0, anchorRevision: 1)
        #expect(ending == [.disableAutomaticStart, .stopPictureInPicture, .resumeFeedback, .detachSink, .releaseController])
        let stop = ending.firstIndex(of: .stopPictureInPicture) ?? 99
        let release = ending.firstIndex(of: .releaseController) ?? -1
        #expect(stop < release)
        #expect(machine.constructions == 1)
        #expect(machine.releases == 1)
        #expect(machine.sinkSwaps == 1)
        #expect(!machine.hasController && !machine.isSinkAttached && !machine.isPictureInPictureActive)

        #expect(machine.pictureInPictureStopped().isEmpty)

        #expect(machine.presenceChanged(phase: .live, targetSlotId: "p:r1", videoWidth: 0, videoHeight: 0, anchorRevision: 1)
                == [.createController])
        #expect(machine.constructions == 2)
    }

    @Test func reopeningConclaveDuringPipStopsOnceAndRestoresOnce() {
        let machine = PipLifetimeMachine()
        _ = machine.presenceChanged(phase: .live, targetSlotId: "p:r1", videoWidth: 0, videoHeight: 0, anchorRevision: 1)
        #expect(machine.sceneChanged(.inactive) == [.attachSink])
        _ = machine.sceneChanged(.background)
        #expect(machine.pictureInPictureStarted() == [.suspendFeedback])
        #expect(machine.sceneChanged(.active) == [.stopPictureInPicture, .restoreCall])

        #expect(machine.sceneChanged(.active).isEmpty)
        #expect(machine.pictureInPictureStopped() == [.resumeFeedback, .detachSink])
        #expect(machine.stopRequests == 1 && machine.restores == 1)

        #expect(machine.sceneChanged(.active).isEmpty)
    }

    @Test func theRestoreButtonRestoresOnceEvenWhenTheSceneActivatesFirst() {
        let machine = PipLifetimeMachine()
        _ = machine.presenceChanged(phase: .live, targetSlotId: "p:r1", videoWidth: 0, videoHeight: 0, anchorRevision: 1)
        _ = machine.sceneChanged(.inactive)
        _ = machine.pictureInPictureStarted()
        #expect(machine.restoreRequested() == [.restoreCall])
        #expect(machine.sceneChanged(.active).isEmpty)
        #expect(machine.pictureInPictureStopped() == [.resumeFeedback, .detachSink])
        #expect(machine.restores == 1 && machine.stopRequests == 0)

        _ = machine.sceneChanged(.inactive)
        _ = machine.pictureInPictureStarted()
        machine.pictureInPictureWillStop()
        #expect(machine.pictureInPictureStopped() == [.resumeFeedback, .detachSink])
        #expect(machine.sceneChanged(.inactive) == [.attachSink])
    }

    @Test func frameSizesResizeTheContentAndZeroKeepsTheLastSize() {
        let machine = PipLifetimeMachine()
        #expect(machine.presenceChanged(phase: .live, targetSlotId: "p:r1", videoWidth: 720, videoHeight: 1280, anchorRevision: 1)
                == [.createController, .resizeContent])
        #expect(machine.presenceChanged(phase: .live, targetSlotId: "p:r1", videoWidth: 720, videoHeight: 1280, anchorRevision: 1).isEmpty)
        #expect(machine.presenceChanged(phase: .live, targetSlotId: "p:r1", videoWidth: 0, videoHeight: 0, anchorRevision: 1).isEmpty)
        #expect(machine.videoWidth == 720 && machine.videoHeight == 1280)
        #expect(machine.presenceChanged(phase: .live, targetSlotId: "p:r1", videoWidth: 1280, videoHeight: 720, anchorRevision: 1)
                == [.resizeContent])
    }

    @Test func aRemountedCallRootUpdatesTheSourceAndNeverBuildsASecondController() {
        let machine = PipLifetimeMachine()
        _ = machine.presenceChanged(phase: .live, targetSlotId: "p:r1", videoWidth: 0, videoHeight: 0, anchorRevision: 1)
        #expect(machine.presenceChanged(phase: .live, targetSlotId: "p:r1", videoWidth: 0, videoHeight: 0, anchorRevision: 2)
                == [.updateSource])
        #expect(machine.constructions == 1)

        let late = PipLifetimeMachine()
        _ = late.sceneChanged(.inactive)
        #expect(late.presenceChanged(phase: .live, targetSlotId: "p:r1", videoWidth: 0, videoHeight: 0, anchorRevision: 1)
                == [.createController, .attachSink])
    }

    @Test func feedbackIsSuspendedWhileInPipOrEnteringIt() {
        #expect(PipLifetimePolicy.suspendsFeedback(isInPictureInPicture: true, isTransitioningToPip: false))
        #expect(PipLifetimePolicy.suspendsFeedback(isInPictureInPicture: false, isTransitioningToPip: true))
        #expect(!PipLifetimePolicy.suspendsFeedback(isInPictureInPicture: false, isTransitioningToPip: false))
        #expect(PipLifetimePolicy.keepsController(.recovering) && PipLifetimePolicy.keepsController(.connecting))
        #expect(!PipLifetimePolicy.keepsController(.ending) && !PipLifetimePolicy.keepsController(.idle))
    }

}

private func sys4PackageRoot() -> URL {
    URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
}

private func sys4Source(_ packageRelativePath: String) throws -> String {
    try String(contentsOf: sys4PackageRoot().appendingPathComponent(packageRelativePath).standardizedFileURL, encoding: .utf8)
}
#endif
