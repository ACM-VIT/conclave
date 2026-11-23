#if os(macOS) && !SKIP
import Foundation
import Testing
@testable import Conclave

@MainActor
@Suite(.serialized)
struct TestHarnessSettleTests {
    private final class Chain {
        var hops = 0
    }

    @Test func aMainActorStallPastTheFloorKeepsTheWaitGoingUntilTheNextHop() async {
        let floor: Duration = .milliseconds(20)
        let chain = Chain()
        Task { @MainActor in
            chain.hops = 1
            let end = ContinuousClock.now.advanced(by: floor * 3)
            while ContinuousClock.now < end {}
            await Task.yield()
            chain.hops = 2
        }
        let deadline = ContinuousClock.now.advanced(by: floor)
        var sawUnfinishedChainPastTheFloor = false
        let reached = await settle(floor: floor, turns: 50) {
            if chain.hops == 1 && ContinuousClock.now >= deadline {
                sawUnfinishedChainPastTheFloor = true
            }
            return chain.hops == 2
        }
        #expect(sawUnfinishedChainPastTheFloor, "the stall ended after the floor with one hop still queued")
        #expect(reached, "one more turn lets the queued hop run")
    }

    @Test func aConditionThatNeverHoldsFailsOnceTheTurnsAndTheFloorAreSpent() async {
        var checks = 0
        let reached = await settle(floor: .zero, turns: 10) {
            checks += 1
            return false
        }
        #expect(!reached)
        #expect(checks == 11)
    }
}
#endif
