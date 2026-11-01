#if !SKIP
import Foundation

final class TransportConnectAcknowledgement: @unchecked Sendable {
    enum Outcome: Equatable {
        case accepted
        case rejected
        case timedOut
    }

    static let timeoutSeconds: TimeInterval = 35

    private let lock = NSLock()
    private let semaphore = DispatchSemaphore(value: 0)
    private var accepted: Bool?

    func resolve(accepted: Bool) {
        lock.lock()
        defer { lock.unlock() }
        guard self.accepted == nil else { return }
        self.accepted = accepted
        semaphore.signal()
    }

    func wait(timeout: TimeInterval) -> Outcome {
        guard semaphore.wait(timeout: .now() + timeout) == .success else { return .timedOut }
        lock.lock()
        defer { lock.unlock() }
        return accepted == true ? .accepted : .rejected
    }
}

final class TransportConnectOutcomes: @unchecked Sendable {
    private let lock = NSLock()
    private var outcomes: [String: TransportConnectAcknowledgement.Outcome] = [:]

    func record(_ outcome: TransportConnectAcknowledgement.Outcome, transportId: String) {
        lock.lock()
        defer { lock.unlock() }
        outcomes[transportId] = outcome
    }

    func take(transportId: String) -> TransportConnectAcknowledgement.Outcome? {
        lock.lock()
        defer { lock.unlock() }
        return outcomes.removeValue(forKey: transportId)
    }
}

@MainActor
final class ReceiveTransportConnectGate {
    private var connectedTransportId: String?
    private var pending: [String: Task<Void, Never>] = [:]
    private(set) var waitingCallers = 0

    var isBusy: Bool { !pending.isEmpty }

    func perform<T: Sendable>(
        transportId: String,
        firstOperation: @escaping @MainActor () async throws -> T,
        connectedOperation: @MainActor () throws -> T
    ) async throws -> T {
        while let task = pending[transportId] {
            waitingCallers += 1
            await task.value
            waitingCallers -= 1
        }
        if connectedTransportId == transportId {
            return try connectedOperation()
        }
        let work = Task { @MainActor in
            try await firstOperation()
        }
        pending[transportId] = Task { @MainActor [weak self] in
            let outcome = await work.result
            guard let self else { return }
            if case .success = outcome {
                self.connectedTransportId = transportId
            }
            self.pending[transportId] = nil
        }
        return try await work.value
    }

    func waitUntilIdle(transportId: String) async {
        while let task = pending[transportId] {
            await task.value
        }
    }
}
#endif
