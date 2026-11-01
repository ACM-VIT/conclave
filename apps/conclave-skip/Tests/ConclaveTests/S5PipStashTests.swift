#if !SKIP
import Foundation
import Testing
@testable import Conclave

@MainActor
struct S5PipStashTests {
    private let remote = "r@example.com#r"

    private func joinedViewModel() -> MeetingViewModel {
        let viewModel = MeetingViewModel()
        viewModel.state.participants[remote] = Participant(id: remote, isCameraOff: false)
        viewModel.state.pinnedUserId = remote
        viewModel.state.connectionState = .joined
        return viewModel
    }

    private func settle(_ condition: () -> Bool) async -> Bool {
        for _ in 0..<500 {
            if condition() { return true }
            try? await Task.sleep(nanoseconds: 2_000_000)
        }
        return condition()
    }

    @Test func stashingLowersEveryRemoteConsumerAndUnstashingRestoresThePreviousPreferences() async {
        let viewModel = joinedViewModel()
        let client = viewModel.webRTCClient
        let before = client.testBandwidthPolicyCalls

        viewModel.setPipStashed(true)
        #expect(await settle { client.testBandwidthPolicyCalls > before })
        #expect(client.testLastFocusedUserIds.isEmpty)
        #expect(client.testLastVisibleUserIds.isEmpty)

        let stashedCalls = client.testBandwidthPolicyCalls
        viewModel.setPipStashed(false)
        #expect(await settle { client.testBandwidthPolicyCalls > stashedCalls })
        #expect(client.testLastFocusedUserIds.contains(remote))
    }

    private func quiesce(_ client: WebRTCClient) async {
        var last = -1
        while last != client.testBandwidthPolicyCalls {
            last = client.testBandwidthPolicyCalls
            try? await Task.sleep(nanoseconds: 150_000_000)
        }
    }

    @Test func onlyAChangeSendsARequest() async {
        let viewModel = joinedViewModel()
        let client = viewModel.webRTCClient
        viewModel.setPipStashed(true)
        #expect(await settle { client.testLastFocusedUserIds.isEmpty && client.testBandwidthPolicyCalls > 0 })
        await quiesce(client)
        let calls = client.testBandwidthPolicyCalls
        viewModel.setPipStashed(true)
        try? await Task.sleep(nanoseconds: 150_000_000)
        #expect(client.testBandwidthPolicyCalls == calls)
        #expect(client.testLastFocusedUserIds.isEmpty)
    }

    @Test func noRequestIsSentWhileNotInACall() async {
        let viewModel = MeetingViewModel()
        let client = viewModel.webRTCClient
        viewModel.setPipStashed(true)
        viewModel.setPipStashed(false)
        try? await Task.sleep(nanoseconds: 50_000_000)
        #expect(client.testBandwidthPolicyCalls == 0)
        #expect(!viewModel.isPipStashed)
    }
}
#endif
