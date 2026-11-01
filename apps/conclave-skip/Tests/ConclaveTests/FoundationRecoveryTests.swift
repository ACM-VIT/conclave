#if os(macOS) && !SKIP
import Testing
@testable import Conclave

@MainActor
struct FoundationRecoveryTests {
    @Test
    func adminMuteCancelsMicrophoneWithoutAnInstalledProducer() async {
        let viewModel = MeetingViewModel()
        viewModel.state.isMuted = false
        var localMuteCount = 0
        viewModel.webRTCClient.onLocalAudioEnabledChanged = { enabled in
            #expect(!enabled)
            localMuteCount += 1
        }
        #expect(!viewModel.webRTCClient.hasLocalAudioProducer)

        let handled = await viewModel.closeAdminEnforcedProducer(AdminMediaProducer(
            producerId: "acknowledged-but-not-installed",
            kind: "audio",
            type: "webcam"
        ))

        #expect(handled)
        #expect(localMuteCount == 1)
        #expect(viewModel.state.isMuted)
    }

    @Test
    func adminCameraCloseDoesNotCancelMicrophoneIntent() async {
        let viewModel = MeetingViewModel()
        viewModel.state.isMuted = false
        var localMuteCount = 0
        viewModel.webRTCClient.onLocalAudioEnabledChanged = { _ in
            localMuteCount += 1
        }

        let handled = await viewModel.closeAdminEnforcedProducer(AdminMediaProducer(
            producerId: "camera",
            kind: "video",
            type: "webcam"
        ))

        #expect(handled)
        #expect(localMuteCount == 0)
        #expect(!viewModel.state.isMuted)
        #expect(viewModel.state.isCameraOff)
    }
}
#endif
