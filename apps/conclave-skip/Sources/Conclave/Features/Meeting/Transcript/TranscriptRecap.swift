import Foundation

// TRN-2 (S30 CC8, S60 C6-12; web `MeetsMainContent.tsx` wrap-up intercept): the recap. A host ending the call while live
// notes run with content may first ask Conclave to post a recap to the room chat; the call ends when the answer lands
// (done or failed) or after 30 s, whichever comes first, and "End Now" on the posting banner ends at once. The Minutes
// tab's "Post Recap to Chat" posts the same recap without ending. One `RecapCoordinator` per view model owns the phase
// and the 30 s cap; the core wires its three closures (send the recap prompt, end through the S1 End path, refresh)
// and tells it when an assistant answer settles. Shared (transpiled) Swift; injectable clock and sleep.

/// The core's recap capability and the End flow's posting state, pushed into `CallControlsPresenter.applyRecap(_:)`.
struct RecapControlsState: Equatable {
    /// S30 CC8: live notes have content and the host may post to chat; the End dialog offers the recap variant.
    let offersRecap: Bool
    /// The recap was asked for by "Post Recap and End" and the call has not ended yet (`EndPhase.postingRecap`).
    let isPostingBeforeEnd: Bool

    static let none = RecapControlsState(offersRecap: false, isPostingBeforeEnd: false)
}

/// What a recap request does. The controls presenter sends `postAndEnd` and `endNow`; the Transcript panel `postOnly`.
enum RecapCommandKind: String, CaseIterable, Equatable {
    case postOnly, postAndEnd, endNow
}

enum RecapPolicy {
    /// The web 30 s safety cap (`MeetsMainContent.tsx`): a stalled stream never traps the host in the meeting.
    static let capMillis = 30_000.0
    /// The web wrap-up prompt, sent as a chat message so the room sees the recap through the assistant relay.
    static let prompt = "@Conclave wrap up the meeting. Post a short recap: what we covered, decisions made, and action items with owners."

    /// Web `canPostRecapToChat`: chat is open to the person or they are a host; never for an attendee.
    static func canPostToChat(isChatLocked: Bool, isHost: Bool, isAttendee: Bool, isJoined: Bool) -> Bool {
        isJoined && !isAttendee && (!isChatLocked || isHost)
    }

    /// S30 CC8: live notes running (live or paused) with content, and the person may post to chat. Paused counts as
    /// running (the worker still holds the transcript); the web offers it while live.
    static func offersRecap(canPostToChat: Bool, phase: LiveNotesPhase, hasContent: Bool) -> Bool {
        canPostToChat && hasContent && (phase == LiveNotesPhase.live || phase == LiveNotesPhase.paused)
    }

    /// The End dialog's Leave snapshot with the recap capability and the posting phase (the S1 End row decides the
    /// rest): `offersRecap` only for someone who can end for everyone; `postingRecap` replaces an idle End phase while
    /// the recap posts (an End ticket in flight or a confirmation wins).
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

/// The core's recap owner (S30 CC8). Not observable: the core reads `phase` and `isPostingBeforeEnd` on its refresh
/// paths after `onChange`.
@MainActor
final class RecapCoordinator {
    /// The Minutes row (S60 6 f Recap).
    private(set) var phase = RecapPhase.idle
    /// "Post Recap and End" is waiting for the answer (the stage banner with End Now, `EndPhase.postingRecap`).
    private(set) var isPostingBeforeEnd = false
    /// When the recap was asked (epoch milliseconds); an answer that settled before it does not count.
    private(set) var requestedAtMillis = 0.0
    /// Diagnostics (tests, readouts).
    private(set) var postCount = 0
    private(set) var endCount = 0

    /// Core: sends `RecapPolicy.prompt` to the room chat; false when it cannot (not joined, chat locked).
    var sendRecap: (() -> Bool)? = nil
    /// Core: ends the call for everyone through the S1 End path (`CallControlsPresenter.finishRecapAndEnd()`).
    var endCall: (() -> Void)? = nil
    /// Core: refreshes the controls, the stage notices and the Transcript inputs.
    var onChange: (() -> Void)? = nil
    var now: () -> Double = { Date().timeIntervalSince1970 * 1000.0 }
    var sleep: (Double) async -> Void = { millis in
        try? await Task.sleep(nanoseconds: UInt64(max(0.0, millis) * 1_000_000.0))
    }

    private var capTask: Task<Void, Never>? = nil
    private var generation = 0

    init() {}

    var hasCapTimer: Bool { capTask != nil }

    /// Minutes "Post Recap to Chat": one recap message per tap while none is posting (C6-12).
    @discardableResult
    func postToChat() -> Bool {
        if phase == RecapPhase.posting { return false }
        guard let send = sendRecap, send() else {
            setPhase(RecapPhase.failed)
            return false
        }
        postCount += 1
        requestedAtMillis = now()
        setPhase(RecapPhase.posting)
        armCap()
        return true
    }

    /// "Post Recap and End": posts, then ends when the answer settles or after 30 s. False when the recap could not be
    /// sent; the caller then ends at once (web `handlePostRecapAndEnd`).
    @discardableResult
    func postAndEnd() -> Bool {
        if isPostingBeforeEnd { return true }
        guard let send = sendRecap, send() else {
            setPhase(RecapPhase.failed)
            return false
        }
        postCount += 1
        requestedAtMillis = now()
        isPostingBeforeEnd = true
        phase = RecapPhase.posting
        armCap()
        onChange?()
        return true
    }

    /// The posting banner's End Now (S30 CC8): ends at once.
    func endNow() {
        if !isPostingBeforeEnd { return }
        finishEnd()
    }

    /// Core: a Conclave AI answer settled (done or failed) at `atMillis`. Answers older than the request do not count.
    func noteAssistantAnswerSettled(atMillis: Double, failed: Bool) {
        if phase != RecapPhase.posting && !isPostingBeforeEnd { return }
        if atMillis + 1.0 < requestedAtMillis { return }
        if isPostingBeforeEnd {
            finishEnd()
            return
        }
        cancelCap()
        setPhase(failed ? RecapPhase.failed : RecapPhase.posted)
    }

    /// The 30 s cap (tests call it after advancing the injected clock).
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

    /// A new call or leaving: nothing posts, no timer runs.
    func reset() {
        cancelCap()
        generation += 1
        let changed = phase != RecapPhase.idle || isPostingBeforeEnd
        phase = RecapPhase.idle
        isPostingBeforeEnd = false
        requestedAtMillis = 0.0
        if changed { onChange?() }
    }

    private func finishEnd() {
        cancelCap()
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
