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

    @Test func onlyAChangeSendsARequest() {
        let viewModel = joinedViewModel()
        #expect(viewModel.setPipStashed(true))
        #expect(!viewModel.setPipStashed(true))
        #expect(viewModel.isPipStashed)
        #expect(viewModel.setPipStashed(false))
        #expect(!viewModel.setPipStashed(false))
    }

    @Test func noRequestIsSentWhileNotInACall() {
        let viewModel = MeetingViewModel()
        #expect(!viewModel.setPipStashed(true))
        #expect(viewModel.isPipStashed, "the stash is still recorded for the next policy pass")
        #expect(!viewModel.setPipStashed(false))
        #expect(viewModel.webRTCClient.testBandwidthPolicyCalls == 0)
    }
}
#endif
