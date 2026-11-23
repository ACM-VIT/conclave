#if os(macOS) && !SKIP
import Foundation
import Testing
@testable import Conclave

@MainActor
@Suite(.serialized)
struct TestHarnessSettleTests {
    private final class Hops {
        var count = 0
    }

    @Test func aBusyMainActorSlowsTheWaitButNeverFailsIt() async {
        let load = MainActorLoad(jobs: 20, burn: .milliseconds(5))
        let hops = Hops()
        Task { @MainActor in
            for _ in 0..<3 {
                hops.count += 1
                await Task.yield()
            }
        }
        let started = ContinuousClock.now
        let reached = await settle(floor: .milliseconds(20), turns: 50) { hops.count == 3 }
        let waited = ContinuousClock.now - started
        await load.stop()
        #expect(reached)
        #expect(waited > .milliseconds(20), "the busy main actor kept the chain going past the wall-clock floor")
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

@MainActor
final class MainActorLoad {
    private var running = true
    private var tasks: [Task<Void, Never>] = []

    init(jobs: Int, burn: Duration) {
        for _ in 0..<jobs {
            tasks.append(Task { @MainActor [weak self] in
                while self?.running == true {
                    let end = ContinuousClock.now.advanced(by: burn)
                    while ContinuousClock.now < end {}
                    await Task.yield()
                }
            })
        }
    }

    func stop() async {
        running = false
        for task in tasks {
            await task.value
        }
    }
}
#endif
