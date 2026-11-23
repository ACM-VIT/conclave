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

    private final class ManualClock {
        var now = ContinuousClock.now

        func advance(_ duration: Duration) {
            now = now.advanced(by: duration)
        }
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

    @Test func theFloorKeepsTheWaitGoingAfterTheTurnsRunOut() async {
        let clock = ManualClock()
        var checks = 0
        let reached = await settle(floor: .seconds(1), turns: 3, ceiling: .seconds(60), now: { clock.now }) {
            checks += 1
            return checks == 10
        }
        #expect(reached, "no time passed, so spending the turns alone does not end the wait")
        #expect(checks == 10)
    }

    @Test func theTurnsKeepTheWaitGoingAfterTheFloorPasses() async {
        let clock = ManualClock()
        var checks = 0
        let reached = await settle(floor: .seconds(1), turns: 10, ceiling: .seconds(1000), now: { clock.now }) {
            checks += 1
            clock.advance(.seconds(2))
            return checks == 5
        }
        #expect(reached, "the floor passed on the first check, but the turns were not spent")
        #expect(checks == 5)
    }

    @Test func theCeilingEndsAWaitThatStillHasTurnsLeft() async {
        let clock = ManualClock()
        var checks = 0
        let reached = await settle(floor: .seconds(1), turns: 1_000_000, ceiling: .seconds(30), now: { clock.now }) {
            checks += 1
            clock.advance(.seconds(10))
            return false
        }
        #expect(!reached)
        #expect(checks == 3, "the third check sees 30 s gone and stops, with almost every turn unused")
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
