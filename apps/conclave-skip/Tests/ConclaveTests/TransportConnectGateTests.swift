#if !SKIP
import Foundation
import Testing
@testable import Conclave

@MainActor
struct TransportConnectGateTests {
    private final class EventLog {
        var events: [String] = []
    }

    private final class Latch {
        private var isOpen = false
        private var continuation: CheckedContinuation<Void, Never>?

        func wait() async {
            if isOpen { return }
            await withCheckedContinuation { continuation = $0 }
        }

        func open() {
            isOpen = true
            continuation?.resume()
            continuation = nil
        }
    }

    private struct FirstConsumeFailed: Error {}

    private func yieldUntil(_ condition: () -> Bool) async {
        for _ in 0..<10_000 where !condition() {
            await Task.yield()
        }
    }

    private func heldFirstConsume(
        _ gate: ReceiveTransportConnectGate,
        transportId: String,
        log: EventLog,
        latch: Latch
    ) -> Task<Int, Error> {
        Task {
            try await gate.perform(
                transportId: transportId,
                firstOperation: {
                    log.events.append("\(transportId) held:first")
                    await latch.wait()
                    log.events.append("\(transportId) held:done")
                    return 1
                },
                connectedOperation: {
                    log.events.append("\(transportId) held:connected")
                    return -1
                }
            )
        }
    }

    @Test func laterConsumesWaitForTheFirstAndThenTakeTheConnectedPath() async throws {
        let gate = ReceiveTransportConnectGate()
        let log = EventLog()
        let latch = Latch()

        let first = heldFirstConsume(gate, transportId: "t1", log: log, latch: latch)
        await yieldUntil { log.events.contains("t1 held:first") }

        let second = Task {
            try await gate.perform(
                transportId: "t1",
                firstOperation: {
                    log.events.append("t1 second:first")
                    return -2
                },
                connectedOperation: {
                    log.events.append("t1 second:connected")
                    return 2
                }
            )
        }
        await yieldUntil { gate.waitingCallers == 1 }
        #expect(gate.waitingCallers == 1)
        #expect(gate.isBusy)
        #expect(log.events == ["t1 held:first"])

        latch.open()
        #expect(try await first.value == 1)
        #expect(try await second.value == 2)
        #expect(log.events == ["t1 held:first", "t1 held:done", "t1 second:connected"])
        #expect(!gate.isBusy)
    }

    @Test func aFailedFirstConsumeLeavesTheTransportUnconnected() async throws {
        let gate = ReceiveTransportConnectGate()
        let log = EventLog()

        await #expect(throws: FirstConsumeFailed.self) {
            try await gate.perform(
                transportId: "t1",
                firstOperation: { () async throws -> Int in throw FirstConsumeFailed() },
                connectedOperation: { 0 }
            )
        }
        let value = try await gate.perform(
            transportId: "t1",
            firstOperation: {
                log.events.append("retry:first")
                return 1
            },
            connectedOperation: {
                log.events.append("retry:connected")
                return 0
            }
        )

        #expect(value == 1)
        #expect(log.events == ["retry:first"])
    }

    @Test func aStuckOldTransportDoesNotBlockItsReplacement() async throws {
        let gate = ReceiveTransportConnectGate()
        let log = EventLog()
        let latch = Latch()

        let stuck = heldFirstConsume(gate, transportId: "old", log: log, latch: latch)
        await yieldUntil { log.events.contains("old held:first") }

        let replacement = try await gate.perform(
            transportId: "new",
            firstOperation: {
                log.events.append("new first")
                return 7
            },
            connectedOperation: { -7 }
        )
        #expect(replacement == 7)
        #expect(log.events == ["old held:first", "new first"])

        latch.open()
        #expect(try await stuck.value == 1)
    }

    @Test func waitUntilIdleReturnsOnlyAfterTheFirstConsumeFinishes() async throws {
        let gate = ReceiveTransportConnectGate()
        let log = EventLog()
        let latch = Latch()

        let first = heldFirstConsume(gate, transportId: "t1", log: log, latch: latch)
        await yieldUntil { log.events.contains("t1 held:first") }
        let idle = Task {
            await gate.waitUntilIdle(transportId: "t1")
            log.events.append("idle")
        }
        for _ in 0..<100 { await Task.yield() }
        #expect(log.events == ["t1 held:first"])

        latch.open()
        await idle.value
        #expect(try await first.value == 1)
        #expect(log.events == ["t1 held:first", "t1 held:done", "idle"])
    }

    @Test func aBlockedTransportThreadSeesTheConnectOutcome() async {
        let accepted = TransportConnectAcknowledgement()
        let rejected = TransportConnectAcknowledgement()
        let outcomes = await withCheckedContinuation { continuation in
            DispatchQueue.global(qos: .userInitiated).async {
                continuation.resume(returning: [accepted.wait(timeout: 60), rejected.wait(timeout: 60)])
            }
            Task { @MainActor in
                accepted.resolve(accepted: true)
                rejected.resolve(accepted: false)
                rejected.resolve(accepted: true)
            }
        }

        #expect(outcomes == [.accepted, .rejected])
        #expect(TransportConnectAcknowledgement().wait(timeout: 0.05) == .timedOut)
    }

    @Test func connectOutcomesAreTakenOncePerTransport() {
        let outcomes = TransportConnectOutcomes()
        outcomes.record(.rejected, transportId: "send")
        outcomes.record(.accepted, transportId: "receive")

        #expect(outcomes.take(transportId: "send") == .rejected)
        #expect(outcomes.take(transportId: "send") == nil)
        #expect(outcomes.take(transportId: "receive") == .accepted)
    }
}
#endif
