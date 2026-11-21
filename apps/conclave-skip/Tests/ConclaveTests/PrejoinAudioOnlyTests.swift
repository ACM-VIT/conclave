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
        #expect(!viewModel.state.isAudioOnlyMode)
        #expect(!viewModel.state.isCameraOff)
        #expect(!viewModel.state.isMuted)
        #expect(previewCalls == ["start", "stop"])
        #expect(premeeting.lobbyMedia?.audioOnlyOn == true)
        #expect(premeeting.lobbyMedia?.cameraIntentOn == false)

        premeeting.setCameraIntent(true)
        #expect(premeeting.lobbyMedia?.cameraIntentOn == false)
        #expect(permissionRequests == ["camera"])
        #expect(previewCalls == ["start", "stop"])

        premeeting.setAudioOnlyIntent(false)
        #expect(!viewModel.state.isAudioOnlyMode)
        #expect(premeeting.lobbyMedia?.cameraIntentOn == false, "turning audio-only off does not restart the preview")
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

    @Test func audioOnlyJoinDefersExistingAndNewVideoUntilVideoIsEnabled() async throws {
        let call = RejoinHarness()
        let viewModel = call.viewModel
        let cameraUser = "camera@example.com#remote-session"
        let screenUser = "screen@example.com#remote-session"
        let lateUser = "late@example.com#remote-session"
        let camera = ProducerInfo(producerId: "camera", producerUserId: cameraUser, kind: "video", type: "webcam", paused: false, roomId: "rose-sora-luffy")
        let screen = ProducerInfo(producerId: "screen", producerUserId: screenUser, kind: "video", type: "screen", paused: false, roomId: "rose-sora-luffy")
        let mic = ProducerInfo(producerId: "mic", producerUserId: cameraUser, kind: "audio", type: "webcam", paused: false, roomId: "rose-sora-luffy")
        let late = ProducerInfo(producerId: "late", producerUserId: lateUser, kind: "video", type: "webcam", paused: false, roomId: "rose-sora-luffy")
        call.media.isConfigured = false
        viewModel.socketManager.testProducers = [camera, screen, mic]
        viewModel.testJoinResponse = JoinRoomResponse(
            rtpCapabilities: RtpCapabilities(codecs: nil, headerExtensions: nil),
            existingProducers: [camera, screen, mic], status: "joined", roomId: "rose-sora-luffy"
        )
        let lobby = viewModel.premeeting
        let hooks = LobbyCoreHooks()
        hooks.join = { [weak viewModel] request in
            viewModel?.joinRoom(roomId: request.roomId, displayName: request.displayName,
                                clientId: "test-client", audioOnly: request.audioOnly)
        }
        lobby.lobbyHooks = hooks
        lobby.handleIncomingURL(Self.link)
        lobby.setGuestName("Local User")
        lobby.setAudioOnlyIntent(true)
        #expect(!viewModel.state.isAudioOnlyMode)
        lobby.startOrJoin()
        #expect(viewModel.state.isAudioOnlyMode)
        #expect(await settle { viewModel.state.connectionState == .joined })
        #expect(call.calls.count("consume:mic") > 0)
        #expect(call.calls.count("consume:camera") == 0)
        #expect(call.calls.count("consume:screen") == 0)
        #expect(viewModel.state.participant(for: cameraUser)?.isCameraOff == false)
        #expect(viewModel.state.activeScreenShareUserId == screenUser)
        #expect(viewModel.makeStageInputs().participant(cameraUser)?.isCameraOff == true)

        viewModel.socketManager.testProducers.append(late)
        viewModel.socketManager.onNewProducer?(late)
        #expect(await settle { viewModel.state.participant(for: lateUser)?.isCameraOff == false })
        #expect(call.calls.count("consume:late") == 0)

        viewModel.socketManager.testProducers = []
        viewModel.setAudioOnlyMode(false)
        #expect(await settle {
            call.calls.count("consume:camera") == 1 && call.calls.count("consume:screen") == 1 && call.calls.count("consume:late") == 1
        })
        #expect(viewModel.makeStageInputs().participant(cameraUser)?.isCameraOff == false)
        await call.finish()
    }

    @Test func abandoningALobbyLeavesTheNextRoomInVideoMode() {
        let viewModel = MeetingViewModel()
        let hooks = LobbyCoreHooks()
        hooks.setEntryMediaIntent = { mic, camera in viewModel.setEntryMediaIntent(mic: mic, camera: camera) }
        hooks.setEntryAudioOnly = { on in viewModel.setEntryAudioOnly(on) }
        viewModel.setEntryMediaIntent(mic: false, camera: true)
        let lobby = viewModel.premeeting
        lobby.lobbyHooks = hooks
        lobby.handleIncomingURL(Self.link)
        lobby.setAudioOnlyIntent(true)
        #expect(lobby.lobbyMedia?.audioOnlyOn == true)
        #expect(!viewModel.state.isAudioOnlyMode)
        lobby.setPath([])
        lobby.handleIncomingURL("https://conclave.acmvit.in/fox-rain-dawn")
        #expect(lobby.lobbyMedia?.audioOnlyOn == false)
        #expect(lobby.lobbyMedia?.cameraIntentOn == true)
    }

    private func cameraRow(_ call: RejoinHarness) -> MeetingControlRow {
        MeetingControlAvailabilityPolicy.row(.camera, inputs: call.viewModel.makeShellInputs(),
                                             context: MeetingControlRowContext.make(phase: .inCall))
    }
}

#endif
#endif
