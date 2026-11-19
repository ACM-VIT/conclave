#if !SKIP
import Foundation
import Testing
@testable import Conclave

@MainActor
struct PrejoinAudioOnlySnapshotTests {
    private func device(microphone: MediaPermissionState = .granted, camera: MediaPermissionState = .granted,
                        preview: PreviewState = .live) -> LobbyDeviceInputs {
        LobbyDeviceInputs.initial
            .withPermissions(microphone: microphone, camera: camera, canAskAgainMicrophone: false, canAskAgainCamera: false)
            .withPreview(state: preview, sessionId: 3, isFrontCamera: true, interruption: PreviewInterruption.none)
    }

    @Test func audioOnlyTurnsThePreviewOffAndShowsTheCameraOff() {
        let media = LobbySnapshotPolicy.media(routeId: 1, micIntentOn: true, cameraIntentOn: true, device: device(),
                                              avatarName: "Avery", avatarSeed: "", audioOnlyOn: true)
        #expect(media.audioOnlyOn)
        #expect(!media.cameraIntentOn)
        #expect(media.preview == .off)
        #expect(media.micIntentOn)

        let video = LobbySnapshotPolicy.media(routeId: 1, micIntentOn: true, cameraIntentOn: true, device: device(),
                                              avatarName: "Avery", avatarSeed: "")
        #expect(video.cameraIntentOn && video.preview == .live && !video.audioOnlyOn)
    }

    @Test func audioOnlyAsksForNoCameraPermission() {
        for android in [true, false] {
            let blocked = device(camera: .denied)
            let media = LobbySnapshotPolicy.media(routeId: 1, micIntentOn: true, cameraIntentOn: false, device: blocked,
                                                  avatarName: "Avery", avatarSeed: "", audioOnlyOn: true)
            #expect(LobbyStatusPolicy.rows(status: nil, media: media, supportsRationale: android, offersAppInfo: android)
                .allSatisfy { $0.mediaKind != .camera }, "android \(android)")
            #expect(media.preview == .off, "no blocked-camera overlay in audio-only mode")

            let bothBlocked = LobbySnapshotPolicy.media(routeId: 1, micIntentOn: true, cameraIntentOn: false,
                                                        device: device(microphone: .denied, camera: .denied),
                                                        avatarName: "Avery", avatarSeed: "", audioOnlyOn: true)
            let rows = LobbyStatusPolicy.rows(status: nil, media: bothBlocked, supportsRationale: android, offersAppInfo: android)
            #expect(rows.contains { $0.kind == .microphone }, "the microphone still needs permission, android \(android)")
            #expect(!rows.contains { $0.kind == .media || $0.kind == .camera }, "android \(android)")
        }
    }
}

#if os(macOS)

@MainActor
@Suite(.serialized)
struct PrejoinAudioOnlyLobbyTests {
    private static let link = "https://conclave.acmvit.in/rose-sora-luffy"

    @Test func choosingAudioOnlyBeforeJoiningStopsThePreviewAndLocksTheCamera() {
        let viewModel = MeetingViewModel()
        viewModel.state = MeetingState(userId: "local@example.com#local-session", sessionId: "local-session")
        let hooks = LobbyCoreHooks()
        var permissionRequests: [String] = []
        var previewCalls: [String] = []
        hooks.setEntryMediaIntent = { mic, camera in viewModel.setEntryMediaIntent(mic: mic, camera: camera) }
        hooks.setEntryAudioOnly = { on in viewModel.setEntryAudioOnly(on) }
        hooks.requestPermission = { kind in permissionRequests.append(kind) }
        hooks.startPreview = { _ in previewCalls.append("start") }
        hooks.stopPreview = { previewCalls.append("stop") }
        let premeeting = viewModel.premeeting
        premeeting.lobbyHooks = hooks
        premeeting.handleIncomingURL(Self.link)
        let routeId = premeeting.path.last?.id ?? -1
        premeeting.lobbyDidAppear(routeId: routeId)
        premeeting.applyPermissions(microphone: .granted, camera: .notDetermined, canAskAgainMicrophone: true,
                                    canAskAgainCamera: true)
        premeeting.setMicIntent(true)
        premeeting.setCameraIntent(true)
        #expect(permissionRequests == ["camera"])
        premeeting.applyPermissions(microphone: .granted, camera: .granted, canAskAgainMicrophone: true, canAskAgainCamera: true)
        #expect(previewCalls == ["start"])

        premeeting.setAudioOnlyIntent(true)
        #expect(viewModel.state.isAudioOnlyMode)
        #expect(viewModel.state.isCameraOff)
        #expect(!viewModel.state.isMuted)
        #expect(previewCalls == ["start", "stop"])
        #expect(premeeting.lobbyMedia?.audioOnlyOn == true)
        #expect(premeeting.lobbyMedia?.cameraIntentOn == false)

        premeeting.setCameraIntent(true)
        viewModel.setEntryMediaIntent(mic: true, camera: true)
        #expect(viewModel.state.isCameraOff, "the camera stays off while audio-only is chosen")
        #expect(permissionRequests == ["camera"])
        #expect(previewCalls == ["start", "stop"])

        premeeting.setAudioOnlyIntent(false)
        #expect(!viewModel.state.isAudioOnlyMode)
        #expect(viewModel.state.isCameraOff, "turning audio-only off does not turn the camera back on")
        #expect(premeeting.lobbyMedia?.audioOnlyOn == false)
    }

    @Test func theCallStartsInAudioOnlyModeWithoutVideo() async {
        let call = RejoinHarness()
        call.viewModel.setEntryMediaIntent(mic: true, camera: true)
        call.viewModel.setEntryAudioOnly(true)
        #expect(await call.join(muted: call.viewModel.state.isMuted, cameraOff: call.viewModel.state.isCameraOff))

        #expect(call.viewModel.state.isAudioOnlyMode)
        #expect(call.viewModel.state.isCameraOff)
        #expect(call.calls.count("startProducingVideo") == 0)
        #expect(!call.media.hasLocalVideoProducer)
        call.viewModel.toggleCamera()
        #expect(call.viewModel.state.isCameraOff)
        #expect(call.calls.count("startProducingVideo") == 0)
        #expect(cameraRow(call).blockedReason == .audioOnly)
        await call.finish()
    }

    @Test func aCallJoinedWithoutTheChoiceStartsWithVideoAllowed() async {
        let call = RejoinHarness()
        call.viewModel.setEntryMediaIntent(mic: true, camera: false)
        #expect(await call.join(muted: call.viewModel.state.isMuted, cameraOff: call.viewModel.state.isCameraOff))
        #expect(!call.viewModel.state.isAudioOnlyMode)
        #expect(cameraRow(call).blockedReason == .none)
        await call.finish()
    }

    private func cameraRow(_ call: RejoinHarness) -> MeetingControlRow {
        MeetingControlAvailabilityPolicy.row(.camera, inputs: call.viewModel.makeShellInputs(),
                                             context: MeetingControlRowContext.make(phase: .inCall))
    }
}

#endif
#endif
