import Foundation

struct RecapControlsState: Equatable {

    let offersRecap: Bool

    let isPostingBeforeEnd: Bool

    static let none = RecapControlsState(offersRecap: false, isPostingBeforeEnd: false)
}

enum RecapCommandKind: String, CaseIterable, Equatable {
    case postOnly, postAndEnd, endNow
}

enum RecapPolicy {

    static let capMillis = 30_000.0

    static let prompt = "@Conclave wrap up the meeting. Post a short recap: what we covered, decisions made, and action items with owners."

    static func canPostToChat(isChatLocked: Bool, isHost: Bool, isAttendee: Bool, isJoined: Bool) -> Bool {
        isJoined && !isAttendee && (!isChatLocked || isHost)
    }

    static func offersRecap(canPostToChat: Bool, phase: LiveNotesPhase, hasContent: Bool) -> Bool {
        canPostToChat && hasContent && (phase == LiveNotesPhase.live || phase == LiveNotesPhase.paused)
    }

    static func leaveSnapshot(_ base: LeaveSnapshot, recap: RecapControlsState) -> LeaveSnapshot {
        let offers = recap.offersRecap && base.canEndForEveryone && !recap.isPostingBeforeEnd
        var phase = base.endPhase
        if recap.isPostingBeforeEnd && (base.endPhase == EndPhase.idle || base.endPhase == EndPhase.failed) {
            phase = EndPhase.postingRecap
        }
        if offers == base.offersRecap && phase == base.endPhase { return base }
        return LeaveSnapshot(revision: base.revision, canEndForEveryone: base.canEndForEveryone, leavePhase: base.leavePhase,
                             endPhase: phase, confirmationId: base.confirmationId, confirmationInvoker: base.confirmationInvoker,
                             offersRecap: offers, endFailure: base.endFailure, showsEndForEveryone: base.showsEndForEveryone,
                             endBlockedReason: base.endBlockedReason)
    }
}

@MainActor
final class RecapCoordinator {

    private(set) var phase = RecapPhase.idle

    private(set) var isPostingBeforeEnd = false

    private(set) var requestedAtMillis = 0.0
    private(set) var requestedAnswerId = ""

    private(set) var postCount = 0
    private(set) var endCount = 0

    var sendRecap: ((String) -> Bool)? = nil

    var endCall: (() -> Void)? = nil

    var onChange: (() -> Void)? = nil
    var now: () -> Double = { Date().timeIntervalSince1970 * 1000.0 }
    var sleep: (Double) async -> Void = { millis in
        try? await Task.sleep(nanoseconds: UInt64(max(0.0, millis) * 1_000_000.0))
    }

    private var capTask: Task<Void, Never>? = nil
    private var generation = 0

    init() {}

    var hasCapTimer: Bool { capTask != nil }

    @discardableResult
    func postToChat() -> Bool {
        if phase == RecapPhase.posting { return false }
        return post(ending: false)
    }

    @discardableResult
    func postAndEnd() -> Bool {
        if isPostingBeforeEnd { return true }
        return post(ending: true)
    }

    private func post(ending: Bool) -> Bool {
        let answerId = "conclave-recap-" + UUID().uuidString.lowercased()
        requestedAnswerId = answerId
        requestedAtMillis = now()
        isPostingBeforeEnd = ending
        phase = RecapPhase.posting
        guard let send = sendRecap, send(answerId) else {
            isPostingBeforeEnd = false
            requestedAnswerId = ""
            cancelCap()
            setPhase(RecapPhase.failed)
            return false
        }
        postCount += 1
        if phase == .posting && requestedAnswerId == answerId {
            armCap()
            onChange?()
        }
        return true
    }

    func endNow() {
        if !isPostingBeforeEnd { return }
        finishEnd()
    }

    func noteAssistantAnswerSettled(answerId: String, atMillis: Double, failed: Bool) {
        guard !answerId.isEmpty, answerId == requestedAnswerId else { return }
        if phase != RecapPhase.posting && !isPostingBeforeEnd { return }
        if atMillis + 1.0 < requestedAtMillis { return }
        if isPostingBeforeEnd {
            finishEnd()
            return
        }
        cancelCap()
        requestedAnswerId = ""
        setPhase(failed ? RecapPhase.failed : RecapPhase.posted)
    }

    func expireIfDue() {
        if phase != RecapPhase.posting && !isPostingBeforeEnd { return }
        if now() - requestedAtMillis < RecapPolicy.capMillis {
            armCap()
            return
        }
        if isPostingBeforeEnd {
            finishEnd()
            return
        }
        cancelCap()
        setPhase(RecapPhase.failed)
    }

    func reset() {
        cancelCap()
        generation += 1
        let changed = phase != RecapPhase.idle || isPostingBeforeEnd
        phase = RecapPhase.idle
        isPostingBeforeEnd = false
        requestedAtMillis = 0.0
        requestedAnswerId = ""
        if changed { onChange?() }
    }

    private func finishEnd() {
        cancelCap()
        requestedAnswerId = ""
        isPostingBeforeEnd = false
        phase = RecapPhase.posted
        endCount += 1
        onChange?()
        endCall?()
    }

    private func setPhase(_ next: RecapPhase) {
        if phase == next { return }
        phase = next
        onChange?()
    }

    private func armCap() {
        cancelCap()
        let wait = max(0.0, RecapPolicy.capMillis - (now() - requestedAtMillis))
        let delay = sleep
        let current = generation
        capTask = Task { @MainActor [weak self] in
            await delay(wait)
            if Task.isCancelled { return }
            guard let self = self, self.generation == current else { return }
            self.capTask = nil
            self.expireIfDue()
        }
    }

    private func cancelCap() {
        capTask?.cancel()
        capTask = nil
    }
}
