#if !SKIP
import Foundation
import Testing
@testable import Conclave

@MainActor
struct SYS6MemoryHooksTests {
    @Test func aSignalRunsEverySubscriberOnceInIdOrder() {
        let pressure = MemoryPressure()
        var calls: [String] = []
        pressure.subscribe("transcript") { calls.append("transcript") }
        pressure.subscribe("chat.images") { calls.append("chat.images") }
        pressure.signal()
        #expect(calls == ["chat.images", "transcript"])
        #expect(pressure.signalCount == 1)
    }

    @Test func subscribingAgainUnderTheSameIdReplacesTheHandler() {
        let pressure = MemoryPressure()
        var first = 0
        var second = 0
        pressure.subscribe("chat.images") { first += 1 }
        pressure.subscribe("chat.images") { second += 1 }
        pressure.signal()
        #expect(first == 0)
        #expect(second == 1)
        #expect(pressure.subscriberIds == ["chat.images"])
    }

    @Test func anUnsubscribedHandlerStopsReceivingSignals() {
        let pressure = MemoryPressure()
        var calls = 0
        pressure.subscribe("chat.images") { calls += 1 }
        pressure.signal()
        pressure.unsubscribe("chat.images")
        pressure.signal()
        #expect(calls == 1)
        #expect(pressure.subscriberIds.isEmpty)
        #expect(pressure.signalCount == 2)
    }

    @Test func installingTheHooksRepeatedlyKeepsASingleChatImageSubscriber() {
        MemoryPressureHooks.install()
        MemoryPressureHooks.install()
        let ids = MemoryPressure.shared.subscriberIds.filter { $0 == MemoryPressureHooks.chatImages }
        #expect(ids == [MemoryPressureHooks.chatImages])
    }

    @Test func theAppDelegateLowMemoryCallbackReachesTheSharedSignal() async {
        MemoryPressureHooks.install()
        let before = MemoryPressure.shared.signalCount
        ConclaveAppDelegate.shared.onLowMemory()
        for _ in 0..<50 where MemoryPressure.shared.signalCount == before {
            await Task.yield()
        }
        #expect(MemoryPressure.shared.signalCount == before + 1)
    }
}
#endif
