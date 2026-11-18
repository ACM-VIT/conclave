#if !SKIP
import Foundation
import Testing
@testable import Conclave

struct T3BorrowComposerComponentTests {
    @Test func counterBandsFollowTheLimit() {
        let from = ConclaveComposerCounterPolicy.visibleFrom(limit: 1000)
        #expect(from == 900)
        #expect(ConclaveComposerCounterPolicy.band(count: 0, limit: 1000, visibleFrom: from) == .hidden)
        #expect(ConclaveComposerCounterPolicy.band(count: 899, limit: 1000, visibleFrom: from) == .hidden)
        #expect(ConclaveComposerCounterPolicy.band(count: 900, limit: 1000, visibleFrom: from) == .near)
        #expect(ConclaveComposerCounterPolicy.band(count: 1000, limit: 1000, visibleFrom: from) == .near)
        #expect(ConclaveComposerCounterPolicy.band(count: 1001, limit: 1000, visibleFrom: from) == .over)
        #expect(ConclaveComposerCounterPolicy.band(count: 1200, limit: 1000, visibleFrom: from) == .over)

        #expect(ConclaveComposerCounterPolicy.band(count: 0, limit: 500, visibleFrom: 0) == .near)
        #expect(ConclaveComposerCounterPolicy.band(count: 501, limit: 500, visibleFrom: 0) == .over)

        for limit in [40, 500, 1000] {
            for visibleFrom in [0, 30, ConclaveComposerCounterPolicy.visibleFrom(limit: limit)] {
                for count in stride(from: 0, through: limit + 20, by: 1) {
                    let band = ConclaveComposerCounterPolicy.band(count: count, limit: limit, visibleFrom: visibleFrom)
                    #expect((band != .hidden) == (count >= visibleFrom), "\(count) of \(limit) from \(visibleFrom)")
                    if band != .hidden {
                        #expect((band == .over) == (ConclaveComposerCounterPolicy.overflow(count: count, limit: limit) > 0))
                    }
                }
            }
        }
        #expect(ConclaveCounterBand.allCases.map { $0.rawValue } == ["hidden", "near", "over"])
    }

    @Test func counterAnnouncesOnceAtEachCrossing() {

        let expected: [String: Bool] = [
            "hidden>hidden": false, "hidden>near": true, "hidden>over": true,
            "near>hidden": false, "near>near": false, "near>over": true,
            "over>hidden": false, "over>near": true, "over>over": false,
        ]
        for previous in ConclaveCounterBand.allCases {
            for next in ConclaveCounterBand.allCases {
                let key = previous.rawValue + ">" + next.rawValue
                #expect(ConclaveComposerCounterPolicy.announces(previous: previous, next: next) == expected[key], "\(key)")
            }
        }

        var previous = ConclaveCounterBand.hidden
        var spoken: [String] = []
        for count in [0, 1200, 1210, 1250, 999, 950, 899, 0] {
            let next = ConclaveComposerCounterPolicy.band(count: count, limit: 1000, visibleFrom: 900)
            if ConclaveComposerCounterPolicy.announces(previous: previous, next: next) { spoken.append(next.rawValue) }
            previous = next
        }
        #expect(spoken == ["over", "near"])
    }
}
#endif
