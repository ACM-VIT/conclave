#if !SKIP
import Foundation
import Testing
@testable import Conclave

/// SYS-4 (OUT/PLAN-screens.md section 5; S70 3, SX4, SX11, SY6, SY7; RECONCILE R28; S70 R70-7, D8): the shared PiP
/// params, availability, entry, content and lifetime policies, plus source scans of the iOS adapters (S70 O14: no
/// iOS-hosted test bundle) and the Android bridge. The Robolectric half (platform params, API 33 title and subtitle,
/// API 35 transition, absolute intents) is T/Skip/SYS4PipBridgeTests.kt. Not run in the heads-down push.
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

    // MARK: S70 3 l1: aspect, rect, actions, subtitle

    @Test func aspectFollowsTheDecodedFrameSizeAndClampsToTheAndroidLimits() {
        #expect(PipParamsPolicy.aspect(width: 720, height: 1280) == PipAspect(width: 9, height: 16))
        #expect(PipParamsPolicy.aspect(width: 1280, height: 720) == PipAspect(width: 16, height: 9))
        #expect(PipParamsPolicy.aspect(width: 640, height: 480) == PipAspect(width: 4, height: 3))
        // 3:1 clamps to 2.39:1, 1:3 to 1:2.39 (D-14).
        #expect(PipParamsPolicy.aspect(width: 900, height: 300) == PipAspect.widest)
        #expect(PipParamsPolicy.aspect(width: 300, height: 900) == PipAspect.tallest)
        #expect(PipAspect.widest == PipAspect(width: 239, height: 100))
        // No frame yet keeps 16:9.
        #expect(PipParamsPolicy.aspect(width: 0, height: 0) == PipAspect.standard)
        #expect(PipParamsPolicy.aspect(width: 1280, height: 0) == PipAspect(width: 16, height: 9))
    }

    @Test func sourceRectIsTheSlotBoundsInWindowPxOrNothing() {
        let laidOut = Self.frame(left: 10.4, top: 20.6, right: 370.4, bottom: 660.2, width: 720, height: 1280)
        #expect(PipParamsPolicy.sourceRect(laidOut) == PipSourceRect(left: 10, top: 21, right: 370, bottom: 660))
        // A target that is not laid out keeps zero bounds: no source rect, the window uses the activity bounds.
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

        // Attendee params have only Leave call and no mute subtitle.
        let attendee = PipParamsPolicy.params(snapshot: Self.snapshot(isMuted: true, isAttendee: true), availability: .eligible)
        #expect(attendee.actions == [.leave])
        #expect(attendee.subtitle == PipSubtitleKind.none)

        // Recovery and hold outrank the mute state.
        #expect(PipParamsPolicy.params(snapshot: Self.snapshot(phase: .recovering, isMuted: true), availability: .eligible).subtitle == .reconnecting)
        #expect(PipParamsPolicy.params(snapshot: Self.snapshot(phase: .onHold, isMuted: true), availability: .eligible).subtitle == .onHold)

        // Auto-enter only while eligible: a suppressed, disabled, active or ended call never arms it.
        for availability in [PipAvailability.suppressed, .disabledByUser, .active, .notEligible, .unsupported] {
            #expect(!PipParamsPolicy.params(snapshot: Self.snapshot(), availability: availability).autoEnterEnabled)
        }
        // Equal inputs give an equal model, so the params are not set again (3 d equality guard).
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

    // MARK: Availability and entry (3 a, 3 d, D9)

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
        // Back with no panel: PiP when eligible, else the task to the back; never a leave.
        #expect(PipEntryPolicy.minimize(availability: .eligible) == .enterPictureInPicture)
        for other in [PipAvailability.suppressed, .disabledByUser, .unsupported, .notEligible, .active] {
            #expect(PipEntryPolicy.minimize(availability: other) == .moveTaskToBack)
        }
        // API 28 to 30 enter from onUserLeaveHint; API 31+ auto-enter instead; a capture consent never enters.
        #expect(PipEntryPolicy.entersOnUserLeaveHint(api: 28, availability: .eligible, isRequestingCapture: false))
        #expect(!PipEntryPolicy.entersOnUserLeaveHint(api: 31, availability: .eligible, isRequestingCapture: false))
        #expect(!PipEntryPolicy.entersOnUserLeaveHint(api: 29, availability: .suppressed, isRequestingCapture: false))
        #expect(!PipEntryPolicy.entersOnUserLeaveHint(api: 30, availability: .eligible, isRequestingCapture: true))
    }

    // MARK: S20 13 d content and the native root's PiP layout

    @Test func contentFollowsTheTargetAndTheWindowWidth() {
        let choice = PipTargetChoice(slotId: "p:r2", userId: "r2", isShare: false)
        let camera = StageParticipantInput.make(userId: "r2", displayName: "Avery", isMuted: true, isCameraOff: false,
                                                joinSerial: 2, videoKey: "probe:r2")
        let video = PipContentPolicy.content(choice: choice, participant: camera, phase: .live, windowWidth: 240)
        #expect(video.kind == .video && video.name == "Avery" && video.isMuted && video.showsNamePill && video.status == .none)
        // The name pill needs at least 160 wide.
        #expect(!PipContentPolicy.content(choice: choice, participant: camera, phase: .live, windowWidth: 159).showsNamePill)
        #expect(PipContentPolicy.content(choice: choice, participant: camera, phase: .live, windowWidth: 160).showsNamePill)
        // Camera off: avatar and name.
        let off = StageParticipantInput.make(userId: "r2", displayName: "Avery", isCameraOff: true, joinSerial: 2)
        #expect(PipContentPolicy.content(choice: choice, participant: off, phase: .live, windowWidth: 240).kind == .avatar)
        // Alone: the solo text, no video.
        let alone = PipContentPolicy.content(choice: PipTargetChoice.none, participant: nil, phase: .live, windowWidth: 240)
        #expect(alone.kind == .solo && !alone.showsNamePill)
        // A share shows once its track is bound.
        let shareChoice = PipTargetChoice(slotId: "share:r1", userId: "r1", isShare: true)
        let sharing = StageParticipantInput.make(userId: "r1", displayName: "Kai", isScreenSharing: true, joinSerial: 1,
                                                 shareVideoKey: "probe:share:r1")
        let share = PipContentPolicy.content(choice: shareChoice, participant: sharing, phase: .live, windowWidth: 240)
        #expect(share.kind == .video && share.isShare)
        // Recovery and hold pills.
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

    // MARK: S70 3 l5: PipLifetimePolicy across a scripted call

    @Test func theControllerIsBuiltOnceAtTheFirstLiveAndStoppedBeforeReleaseAtEnding() {
        let machine = PipLifetimeMachine()
        #expect(machine.presenceChanged(phase: .connecting, targetSlotId: "", videoWidth: 0, videoHeight: 0, anchorRevision: 1).isEmpty)
        // Live without an anchor (no native call root yet): nothing is built.
        #expect(machine.presenceChanged(phase: .live, targetSlotId: "p:r1", videoWidth: 0, videoHeight: 0, anchorRevision: 0).isEmpty)
        // The anchor arrives: exactly one controller.
        #expect(machine.presenceChanged(phase: .live, targetSlotId: "p:r1", videoWidth: 0, videoHeight: 0, anchorRevision: 1)
                == [.createController])
        // Recovery and a same-room redirect (presence keeps it connecting) keep it.
        #expect(machine.presenceChanged(phase: .recovering, targetSlotId: "p:r1", videoWidth: 0, videoHeight: 0, anchorRevision: 1).isEmpty)
        #expect(machine.presenceChanged(phase: .connecting, targetSlotId: "p:r1", videoWidth: 0, videoHeight: 0, anchorRevision: 1).isEmpty)
        #expect(machine.presenceChanged(phase: .live, targetSlotId: "p:r1", videoWidth: 0, videoHeight: 0, anchorRevision: 1).isEmpty)
        // A target switch before the sink is attached swaps nothing (the attach resolves the current target).
        #expect(machine.presenceChanged(phase: .live, targetSlotId: "p:r2", videoWidth: 0, videoHeight: 0, anchorRevision: 1).isEmpty)
        // The scene resigns during a live call: the sink attaches.
        #expect(machine.sceneChanged(.inactive) == [.attachSink])
        #expect(machine.sceneChanged(.background).isEmpty)
        // A target switch now only swaps the sink.
        #expect(machine.presenceChanged(phase: .live, targetSlotId: "p:r3", videoWidth: 0, videoHeight: 0, anchorRevision: 1)
                == [.retargetSink])
        #expect(machine.pictureInPictureStarted() == [.suspendFeedback])
        // Ending while PiP shows: no automatic start, stop, resume feedback, detach, then release.
        let ending = machine.presenceChanged(phase: .ending, targetSlotId: "p:r3", videoWidth: 0, videoHeight: 0, anchorRevision: 1)
        #expect(ending == [.disableAutomaticStart, .stopPictureInPicture, .resumeFeedback, .detachSink, .releaseController])
        let stop = ending.firstIndex(of: .stopPictureInPicture) ?? 99
        let release = ending.firstIndex(of: .releaseController) ?? -1
        #expect(stop < release)
        #expect(machine.constructions == 1)
        #expect(machine.releases == 1)
        #expect(machine.sinkSwaps == 1)
        #expect(!machine.hasController && !machine.isSinkAttached && !machine.isPictureInPictureActive)
        // A late stop callback from the released controller changes nothing.
        #expect(machine.pictureInPictureStopped().isEmpty)
        // The next call builds a new one.
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
        // A second activation before the stop callback does nothing more.
        #expect(machine.sceneChanged(.active).isEmpty)
        #expect(machine.pictureInPictureStopped() == [.resumeFeedback, .detachSink])
        #expect(machine.stopRequests == 1 && machine.restores == 1)
        // Active without PiP and nothing attached: nothing to do.
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
        // The person closed PiP in the background: audio only, the sink detaches; the next resign attaches it again.
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
        // The anchor arriving while the app already resigns attaches at once.
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

    // MARK: Source scans (S70 3 l5, O14)

    @Test func theIOSAdaptersBuildOneControllerAndConvertOffTheMainThreadSafely() throws {
        let pip = try sys4Source("Sources/Conclave/Core/Call/VideoCallPictureInPicture+iOS.swift")
        #expect(pip.hasPrefix("#if os(iOS) && !SKIP\n"))
        #expect(pip.components(separatedBy: "AVPictureInPictureController(contentSource:").count - 1 == 1)
        #expect(pip.contains("AVPictureInPictureController.ContentSource(activeVideoCallSourceView: anchor,"))
        #expect(pip.contains("AVPictureInPictureVideoCallViewController()"))
        #expect(pip.contains("created.canStartPictureInPictureAutomaticallyFromInline = true"))
        #expect(pip.contains("presence.handle(.returnToCall, source: .pictureInPicture, presenceSession: snapshot.presenceSession)"))
        #expect(pip.contains("completionHandler(true)"))
        #expect(pip.contains("PipWindowState.shared.set(showing: true)") && pip.contains("PipWindowState.shared.set(showing: false)"))
        #expect(pip.contains("callViewController.preferredContentSize = size"))
        #expect(pip.contains("StagePipAnchorRegistry.shared"))
        // No in-app PiP start button on iPhone (D8): the controller never starts PiP itself.
        #expect(!pip.contains("startPictureInPicture()"))
        let renderer = try sys4Source("Sources/Conclave/Core/Call/PipSampleBufferRenderer+iOS.swift")
        #expect(renderer.hasPrefix("#if os(iOS) && !SKIP\n"))
        #expect(renderer.contains("kCMSampleAttachmentKey_DisplayImmediately"))
        #expect(renderer.contains("displayLayer.sampleBufferRenderer"))
        #expect(renderer.contains("final class PipSampleBufferRenderer: NSObject, RTCVideoRenderer {"))
        // Frames never add or remove sinks (AGENTS media invariants); only the main-thread sink adapter does.
        #expect(!renderer.contains(".add(") && !renderer.contains(".remove("))
        let video = try sys4Source("Sources/Conclave/Core/WebRTC/VideoView.swift")
        let sinkStart = try #require(video.range(of: "final class PipVideoTrackSink {"))
        let sinkEnd = try #require(video.range(of: "// MARK: - Renderer frame size", range: sinkStart.upperBound..<video.endIndex))
        let before = String(video[..<sinkStart.lowerBound].suffix(80))
        #expect(before.contains("@MainActor"))
        let sink = String(video[sinkStart.upperBound..<sinkEnd.lowerBound])
        #expect(sink.contains("track?.remove(renderer)") && sink.contains("next?.add(renderer)"))
        for file in ["Sources/Conclave/Core/Call/PipParamsPolicy.swift", "Sources/Conclave/Core/Call/PipLifetimePolicy.swift"] {
            let text = try sys4Source(file)
            #expect(!text.contains("#if"), "\(file) is shared Skip Lite code")
            #expect(!text.contains("protocol "), "\(file) declares no protocol")
            #expect(!text.contains("inout "), "\(file) uses no inout")
        }
    }

    @Test func theAndroidBridgeBuildsAbsoluteParamsFromThePolicy() throws {
        let manager = try sys4Source("Sources/Conclave/Skip/PipManager.kt")
        #expect(manager.contains("PipParamsPolicy.params(snapshot = snapshot, availability = availability)"))
        #expect(manager.contains("Rational(model.aspect.width, model.aspect.height)"))
        #expect(manager.contains("res.drawable(PipParamsPolicy.actionDrawableName(kind))"))
        #expect(manager.contains("putExtra(CallActionDispatcher.EXTRA_PRESENCE_SESSION, presenceSession)"))
        #expect(manager.contains("builder.setTitle(model.title)") && manager.contains("builder.setSubtitle("))
        #expect(manager.contains("Build.VERSION_CODES.TIRAMISU"))
        #expect(manager.contains("CallActionDispatcher.handle(kind, SystemCallSource.pictureInPicture, session)"))
        // Leave in PiP and a call ending in PiP close the window; Conclave is never relaunched full screen (CE E13).
        #expect(!manager.contains("getLaunchIntentForPackage"))
        #expect(manager.contains("activity.moveTaskToBack(true)"))
        // Toggle intents are gone from the window (absolute actions only).
        #expect(!manager.contains("ACTION_TOGGLE_MUTE"))
        #expect(manager.contains("PipEntryPolicy.minimize(availability = availability(activity))"))
        #expect(manager.contains("AppOpsManager.OPSTR_PICTURE_IN_PICTURE"))
        #expect(manager.contains("PackageManager.FEATURE_PICTURE_IN_PICTURE"))
        let controller = try sys4Source("Sources/Conclave/Skip/PipController.kt")
        #expect(controller.contains("get() = inPipMode && isInCall && !nativeRootComposed"))
        #expect(controller.contains("PipLifetimePolicy.suspendsFeedback(isInPictureInPicture = inPipMode, isTransitioningToPip = isTransitioningToPip)"))
        let content = try sys4Source("Sources/Conclave/Skip/PipContent.kt")
        #expect(content.contains("internal fun NativePipOverlay(stage: StagePresenter, phase: CallPresencePhase, modifier: Modifier = Modifier)"))
        #expect(content.contains("conclaveString(\"sys_pip_content\", content.name)"))
        #expect(content.contains("stateDescription = state"))
        // S70 12 l3 and the dash rule over every SYS-4 and SYS-8 file.
        let files = [
            "Sources/Conclave/Core/Call/PipParamsPolicy.swift", "Sources/Conclave/Core/Call/PipLifetimePolicy.swift",
            "Sources/Conclave/Core/Call/VideoCallPictureInPicture+iOS.swift", "Sources/Conclave/Core/Call/PipSampleBufferRenderer+iOS.swift",
            "Sources/Conclave/Skip/PipManager.kt", "Sources/Conclave/Skip/PipController.kt", "Sources/Conclave/Skip/PipContent.kt",
            "Sources/Conclave/Skip/NativeMeetingShare.kt",
        ]
        for file in files {
            let text = try sys4Source(file)
            for pattern in ["conclaveGestureFeedback(", "HapticManager", "ConclaveHapticFeedback", "performHapticFeedback", "FeedbackToken(", "Gradient"] {
                #expect(!text.contains(pattern), "\(file) uses \(pattern)")
            }
            #expect(!text.contains("\u{2013}") && !text.contains("\u{2014}"), "\(file) has a dash")
        }
    }

    /// The hooks HD/requests/B5-T4.md asks other owners for. Fails until the batch 5 integrator applies them.
    @Test func requestedHooksAreWired() throws {
        let sync = try sys4Source("Sources/Conclave/Core/Call/CallPresenceSync.swift")
        #expect(sync.contains("func reportPipTarget(_ target: PipTargetFrame?)"))
        #expect(sync.contains("CameraContinuityPolicy.continuesInBackground("))
        let bridge = try sys4Source("Sources/Conclave/Skip/CallNotificationBridge.kt")
        #expect(bridge.contains("PipManager.presenceAdapter(presence)"))
        let receiver = try sys4Source("Sources/Conclave/Skip/CallForegroundService.kt")
        #expect(receiver.contains("if (PipManager.handleActionIntent(intent)) return"))
        let main = try sys4Source("Android/app/src/main/kotlin/Main.kt")
        #expect(main.contains("if (PipController.showsLegacyPipContent) {"))
        #expect(main.contains("PipManager.handlePictureInPictureUiStateChanged("))
        #expect(main.components(separatedBy: "SideEffect { saveableStateHolder.removeState(FULL_ROOT_SAVEABLE_KEY) }").count - 1 == 1)
        let anchor = try sys4Source("Sources/Conclave/Features/Meeting/Stage/PipAnchor+iOS.swift")
        #expect(anchor.contains("VideoCallPictureInPicture.shared.anchorDidChange()"))
    }
}

private func sys4PackageRoot() -> URL {
    URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
}

private func sys4Source(_ packageRelativePath: String) throws -> String {
    try String(contentsOf: sys4PackageRoot().appendingPathComponent(packageRelativePath).standardizedFileURL, encoding: .utf8)
}
#endif
