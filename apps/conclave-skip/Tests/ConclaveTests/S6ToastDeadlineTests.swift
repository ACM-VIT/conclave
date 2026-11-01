#if !SKIP
import Foundation
import Testing
@testable import Conclave

@MainActor
struct S6ToastDeadlineTests {
    private final class Clock {
        var waits: [CheckedContinuation<Void, Never>] = []
        var delays: [Double] = []
        func sleep(_ millis: Double) async {
            delays.append(millis)
            await withCheckedContinuation { waits.append($0) }
        }
    }

    private func settle(_ condition: () -> Bool) async -> Bool {
        for _ in 0..<300 {
            if condition() { return true }
            try? await Task.sleep(nanoseconds: 1_000_000)
        }
        return condition()
    }

    private func item(progress: Bool = false) -> ConclaveToastItem {
        ConclaveToastItem(id: "same-toast", message: "Saved", actionTitle: "Undo", actionId: "undo",
                         avatarName: "", avatarId: "", isFailure: false, isProgress: progress)
    }

    @Test func screenReaderEligibilityCancelsTheOldDeadlineAndArmsAFreshOne() async {
        let clock = Clock()
        let deadline = ConclaveToastDeadline()
        deadline.sleep = { millis in await clock.sleep(millis) }
        var dismissed: [String] = []
        deadline.update(ConclaveToastDeadline.key(item: item(), isScreenReaderRunning: false)) { dismissed.append($0) }
        #expect(await settle { clock.waits.count == 1 })
        deadline.update(ConclaveToastDeadline.key(item: item(), isScreenReaderRunning: true)) { dismissed.append($0) }
        clock.waits[0].resume()
        for _ in 0..<20 { await Task.yield() }
        #expect(dismissed.isEmpty)
        deadline.update(ConclaveToastDeadline.key(item: item(), isScreenReaderRunning: false)) { dismissed.append($0) }
        #expect(await settle { clock.waits.count == 2 })
        if clock.waits.count == 2 { clock.waits[1].resume() }
        #expect(await settle { dismissed.count == 1 })
        #expect(clock.delays.count == 2 && clock.delays[0] == clock.delays[1])
        deadline.cancel()
    }

    @Test func progressEligibilityAlsoCancelsAndRearmsTheSameToast() async {
        let clock = Clock()
        let deadline = ConclaveToastDeadline()
        deadline.sleep = { millis in await clock.sleep(millis) }
        var dismissals = 0
        deadline.update(ConclaveToastDeadline.key(item: item(), isScreenReaderRunning: false)) { _ in dismissals += 1 }
        #expect(await settle { clock.waits.count == 1 })
        deadline.update(ConclaveToastDeadline.key(item: item(progress: true), isScreenReaderRunning: false)) { _ in dismissals += 1 }
        clock.waits[0].resume()
        for _ in 0..<20 { await Task.yield() }
        #expect(dismissals == 0)
        deadline.update(ConclaveToastDeadline.key(item: item(), isScreenReaderRunning: false)) { _ in dismissals += 1 }
        #expect(await settle { clock.waits.count == 2 })
        if clock.waits.count == 2 { clock.waits[1].resume() }
        #expect(await settle { dismissals == 1 })
        deadline.cancel()
    }
}
#endif
