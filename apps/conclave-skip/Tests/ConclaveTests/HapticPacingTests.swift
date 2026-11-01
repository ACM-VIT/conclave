#if !SKIP
import Testing
@testable import Conclave

struct HapticPacingTests {
    @Test func rapidRepeatsOfOneTapAreSpacedWhileOtherTapsStillPlay() {
        let pacer = HapticPacer()
        #expect(pacer.admits(.reactionSent, atMilliseconds: 1_000))
        #expect(!pacer.admits(.reactionSent, atMilliseconds: 1_050))
        #expect(pacer.admits(.micOn, atMilliseconds: 1_050))
        #expect(!pacer.admits(.reactionSent, atMilliseconds: 1_109))
        #expect(pacer.admits(.reactionSent, atMilliseconds: 1_110))
    }

    @Test func selectionTicksKeepUpWithFastScrubbing() {
        let pacer = HapticPacer()
        let admitted = stride(from: 0, through: 200, by: 20).filter {
            pacer.admits(.selectionChanged, atMilliseconds: Int64($0))
        }
        #expect(admitted == [0, 40, 80, 120, 160, 200])
    }

    @Test func aDoubleFiredGestureCollapsesToOneHaptic() {
        let pacer = HapticPacer()
        #expect(pacer.admits(.primaryActionPressed, atMilliseconds: 500))
        #expect(!pacer.admits(.primaryActionPressed, atMilliseconds: 520))
        #expect(pacer.admits(.primaryActionPressed, atMilliseconds: 560))
    }

    @Test func aClockThatJumpsBackwardsNeverSilencesFeedback() {
        let pacer = HapticPacer()
        #expect(pacer.admits(.micOff, atMilliseconds: 5_000))
        #expect(pacer.admits(.micOff, atMilliseconds: 10))
    }
}
#endif
