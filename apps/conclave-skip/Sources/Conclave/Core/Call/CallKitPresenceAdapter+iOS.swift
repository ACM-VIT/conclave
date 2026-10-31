#if os(iOS) && !SKIP
import Foundation

@MainActor
protocol CallProviding: AnyObject {
    var actionHandler: CallProviderActionHandler? { get set }
    func requestStart(uuid: UUID, handle: String, isVideo: Bool, completion: @escaping (Bool) -> Void)
    func reportConnecting(uuid: UUID)
    func reportConnected(uuid: UUID, at date: Date)
    func reportUpdate(uuid: UUID, handle: String, callerName: String, hasVideo: Bool)
    func requestSetMuted(uuid: UUID, muted: Bool, completion: @escaping (Bool) -> Void)
    func requestSetHeld(uuid: UUID, onHold: Bool, completion: @escaping (Bool) -> Void)
    func requestEnd(uuid: UUID, completion: @escaping (Bool) -> Void)
    func reportEnded(uuid: UUID, failed: Bool)
}

@MainActor
protocol CallProviderActionHandler: AnyObject {
    func providerSetMuted(uuid: UUID, muted: Bool) -> Bool
    func providerSetHeld(uuid: UUID, held: Bool) -> Bool
    func providerEnd(uuid: UUID) -> Bool
    func providerDidReset()
}

@MainActor
final class FakeCallProvider: CallProviding {
    weak var actionHandler: CallProviderActionHandler?
    private(set) var log: [String] = []

    func requestStart(uuid: UUID, handle: String, isVideo: Bool, completion: @escaping (Bool) -> Void) {
        log.append("start:\(handle):video=\(isVideo ? 1 : 0)")
        completion(true)
    }

    func reportConnecting(uuid: UUID) {
        log.append("connecting")
    }

    func reportConnected(uuid: UUID, at date: Date) {
        log.append("connected")
    }

    func reportUpdate(uuid: UUID, handle: String, callerName: String, hasVideo: Bool) {
        log.append("update:\(callerName):video=\(hasVideo ? 1 : 0)")
    }

    func requestSetMuted(uuid: UUID, muted: Bool, completion: @escaping (Bool) -> Void) {
        log.append("setMuted:\(muted ? 1 : 0)")
        completion(true)
        let fulfilled = actionHandler?.providerSetMuted(uuid: uuid, muted: muted) ?? false
        log.append("setMutedEcho:\(fulfilled ? "fulfilled" : "failed")")
    }

    func requestSetHeld(uuid: UUID, onHold: Bool, completion: @escaping (Bool) -> Void) {
        log.append("setHeld:\(onHold ? 1 : 0)")
        completion(true)
        let fulfilled = actionHandler?.providerSetHeld(uuid: uuid, held: onHold) ?? false
        log.append("setHeldEcho:\(fulfilled ? "fulfilled" : "failed")")
    }

    func requestEnd(uuid: UUID, completion: @escaping (Bool) -> Void) {
        log.append("endRequest")
        completion(true)
        _ = actionHandler?.providerEnd(uuid: uuid)
    }

    func reportEnded(uuid: UUID, failed: Bool) {
        log.append(failed ? "ended:failed" : "ended:remoteEnded")
    }
}

@MainActor
final class CallKitPresenceAdapter: CallProviderActionHandler {
    static let shared = CallKitPresenceAdapter(provider: CallKitManager.shared)

    private let provider: CallProviding
    private weak var presence: CallPresence?
    private var activeUUID: UUID?
    private var activePresenceSession = 0
    private var hasReportedConnected = false
    private var reportedMuted: Bool?
    private var pendingLocalEndUUID: UUID?
    private var pendingUpdate: CallKitReport?
    private var updateDebounceTask: Task<Void, Never>?
    private let updateDebounceNanoseconds: UInt64 = 1_000_000_000

    init(provider: CallProviding) {
        self.provider = provider
        provider.actionHandler = self
    }

    func makeAdapter(for presence: CallPresence) -> CallPresenceAdapter {
        self.presence = presence
        return CallPresenceAdapter(name: "callKit") { [weak self] old, new in
            self?.presenceDidChange(from: old, to: new)
        }
    }

    func presenceDidChange(from old: CallPresenceSnapshot, to new: CallPresenceSnapshot) {
        let reports = CallKitReportPolicy.reports(old: old, new: new, hasReportedConnected: hasReportedConnected)
        for report in reports {
            perform(report)
        }
    }

    private func perform(_ report: CallKitReport) {
        switch report.kind {
        case .startCall:
            startCall(report)
        case .reportConnecting:
            guard let uuid = activeUUID else { return }
            provider.reportConnecting(uuid: uuid)
        case .updateCall:
            scheduleUpdate(report)
        case .reportConnected:
            guard let uuid = activeUUID, !hasReportedConnected else { return }
            hasReportedConnected = true
            let connectedAt = report.connectedAtMillis > 0
                ? Date(timeIntervalSince1970: report.connectedAtMillis / 1000)
                : Date()
            provider.reportConnected(uuid: uuid, at: connectedAt)
        case .setMuted:
            requestMuted(report.muted)
        case .endCall:
            endCall(report.endKind)
        }
    }

    private func startCall(_ report: CallKitReport) {
        if let previous = activeUUID {

            provider.reportEnded(uuid: previous, failed: true)
        }
        let uuid = UUID()
        activeUUID = uuid
        activePresenceSession = report.presenceSession
        hasReportedConnected = false
        reportedMuted = nil
        pendingUpdate = nil
        updateDebounceTask?.cancel()
        updateDebounceTask = nil
        presence?.reportSurface(.callKit, status: .starting)
        provider.requestStart(uuid: uuid, handle: handleValue(report), isVideo: report.hasVideo) { [weak self] accepted in
            guard let self, self.activeUUID == uuid else { return }
            if accepted {
                self.presence?.reportSurface(.callKit, status: .active)
            } else {

                self.activeUUID = nil
                self.hasReportedConnected = false
                self.reportedMuted = nil
                self.presence?.reportSurface(.callKit, status: .refused)
            }
        }
    }

    private func scheduleUpdate(_ report: CallKitReport) {
        guard let uuid = activeUUID else { return }
        if !hasReportedConnected && pendingUpdate == nil && updateDebounceTask == nil {
            sendUpdate(report, uuid: uuid)
            return
        }
        pendingUpdate = report
        guard updateDebounceTask == nil else { return }
        updateDebounceTask = Task { @MainActor [weak self] in
            try? await Task.sleep(nanoseconds: self?.updateDebounceNanoseconds ?? 1_000_000_000)
            guard let self, !Task.isCancelled else { return }
            self.updateDebounceTask = nil
            guard let pending = self.pendingUpdate, let current = self.activeUUID else { return }
            self.pendingUpdate = nil
            self.sendUpdate(pending, uuid: current)
        }
    }

    private func sendUpdate(_ report: CallKitReport, uuid: UUID) {
        provider.reportUpdate(uuid: uuid, handle: handleValue(report), callerName: callerName(report), hasVideo: report.hasVideo)
    }

    private func requestMuted(_ muted: Bool) {
        guard let uuid = activeUUID else { return }
        let previousMuted = reportedMuted
        guard previousMuted != muted else { return }

        reportedMuted = muted
        provider.requestSetMuted(uuid: uuid, muted: muted) { [weak self] accepted in
            guard let self, !accepted, self.activeUUID == uuid, self.reportedMuted == muted else { return }
            self.reportedMuted = previousMuted
        }
    }

    func requestResumeFromHold() {
        guard let uuid = activeUUID else { return }
        provider.requestSetHeld(uuid: uuid, onHold: false) { _ in }
    }

    private func endCall(_ kind: CallKitEndKind) {
        guard let uuid = activeUUID else { return }
        activeUUID = nil
        hasReportedConnected = false
        reportedMuted = nil
        pendingUpdate = nil
        updateDebounceTask?.cancel()
        updateDebounceTask = nil
        switch kind {
        case .localEndRequest:

            pendingLocalEndUUID = uuid
            provider.requestEnd(uuid: uuid) { [weak self] accepted in
                guard let self, !accepted, self.pendingLocalEndUUID == uuid else { return }
                self.pendingLocalEndUUID = nil
                self.provider.reportEnded(uuid: uuid, failed: false)
            }
        case .remoteEnded:
            provider.reportEnded(uuid: uuid, failed: false)
        case .failed:
            provider.reportEnded(uuid: uuid, failed: true)
        }
        presence?.reportSurface(.callKit, status: .inactive)
    }

    private func handleValue(_ report: CallKitReport) -> String {
        report.handle.isEmpty ? callerName(report) : report.handle
    }

    private func callerName(_ report: CallKitReport) -> String {
        report.title.isEmpty ? ConclaveStrings.text("Conclave Meeting") : report.title
    }

    func providerSetMuted(uuid: UUID, muted: Bool) -> Bool {
        guard uuid == activeUUID, let presence else { return false }
        let previousMuted = reportedMuted
        reportedMuted = muted
        let result = presence.handle(muted ? .mute : .unmute, source: .callKit, presenceSession: activePresenceSession)
        if !result.fulfillsSystemAction {

            reportedMuted = previousMuted
        }
        return result.fulfillsSystemAction
    }

    func providerSetHeld(uuid: UUID, held: Bool) -> Bool {
        guard uuid == activeUUID, let presence else { return false }
        let result = presence.handle(held ? .hold : .resume, source: .callKit, presenceSession: activePresenceSession)
        return result.fulfillsSystemAction
    }

    func providerEnd(uuid: UUID) -> Bool {
        if uuid == pendingLocalEndUUID {

            pendingLocalEndUUID = nil
            return true
        }
        guard uuid == activeUUID, let presence else { return true }

        let session = activePresenceSession
        activeUUID = nil
        hasReportedConnected = false
        reportedMuted = nil
        presence.handle(.leave, source: .callKit, presenceSession: session)
        presence.reportSurface(.callKit, status: .inactive)
        return true
    }

    func providerDidReset() {
        let shouldLeave = activeUUID != nil && hasReportedConnected
        let session = activePresenceSession
        activeUUID = nil
        hasReportedConnected = false
        reportedMuted = nil
        pendingLocalEndUUID = nil
        presence?.reportSurface(.callKit, status: .inactive)
        guard shouldLeave else { return }
        presence?.handle(.leave, source: .callKit, presenceSession: session)
    }
}
#endif
