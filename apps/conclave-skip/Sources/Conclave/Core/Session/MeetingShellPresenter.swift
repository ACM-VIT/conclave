import Foundation
import Observation

/// WP2-S1 meeting shell presenter (contract-wp2-first-slice 3.2 to 3.4). One per view model, keyed by call session.
/// The view model pushes `MeetingShellInputs` through `apply(_:)`; the presenter publishes three cached,
/// equality-guarded snapshots (`session`, `controls`, `entry`) plus `feedbackState`, owns the action ledger and a
/// per-session `PanelCoordinator`, and forwards intents through one closure. It never stores microphone or camera
/// intent (S1C MUTE): rows derive from the authoritative inputs.
///
/// Shells read these snapshots, never view model fields (`MeetingViewModel.shared.shell`). It follows the
/// transpile-proven `NativeHostingPresenter` shape; it cannot self-observe `MeetingState` (SkipModel has no
/// `withObservationTracking`), which is why the core pushes inputs.
@MainActor
@Observable
final class MeetingShellPresenter {
    private(set) var session: MeetingSessionSnapshot = MeetingShellPresenter.initialSession()
    private(set) var controls: MeetingControlRowsState = MeetingShellPresenter.initialControls()
    private(set) var entry: MeetingEntrySnapshot = MeetingShellPresenter.entrySnapshot(MeetingShellInputs.make())
    private(set) var feedbackState = MeetingShellFeedbackState(session: 0, token: FeedbackToken.baseline)
    /// Reset to the new call session on every call-session change (S1C SES). Instantiated here; its API is the
    /// WP1 `PanelCoordinator` (`S/Features/Meeting/Panels/PanelCoordinator.swift`).
    let panels = PanelCoordinator(session: 0)
    /// The action ledger (S1C LED). Not observable; rows publish its pending state.
    let ledger = MeetingActionLedger()
    /// Core only: the view model forwards each intent to its existing implementation (S1C E8). Never called from
    /// `apply(_:)`.
    @ObservationIgnored var onCommand: ((MeetingShellCommand, MeetingActionTicket?) -> Void)? = nil
    /// Test seam (S1C 5.2 coherence spy): called after every publication with the published snapshots. Never set in
    /// production code.
    @ObservationIgnored var onPublish: ((MeetingSessionSnapshot, MeetingControlRowsState, MeetingShellFeedbackState) -> Void)? = nil
    @ObservationIgnored private var inputs = MeetingShellInputs.make()
    @ObservationIgnored private var publishedPhase: MeetingPhaseKind = .home
    @ObservationIgnored private var confirmation: MeetingConfirmation? = nil
    @ObservationIgnored private var nextConfirmationID = 0
    @ObservationIgnored private var handFailure: MeetingActionFailure = .none
    @ObservationIgnored private var leaveFailure: MeetingActionFailure = .none
    @ObservationIgnored private var endFailure: MeetingActionFailure = .none
    @ObservationIgnored private var admittedThisSession = false
    @ObservationIgnored private var joinedThisSession = false
    @ObservationIgnored private var lastOutcomeTokenID = 0
    @ObservationIgnored private var publishCount = 0
    @ObservationIgnored private var publishedCountAtLastSpy = 0

    private static func initialSession() -> MeetingSessionSnapshot {
        let initial = MeetingShellInputs.make()
        let resolution = MeetingPhasePolicy.resolve(initial)
        return MeetingSessionSnapshot(
            revision: 0,
            identity: initial.identity,
            phase: resolution.phase,
            notice: resolution.notice,
            noticeText: resolution.noticeText,
            outcome: nil,
            roomLabel: initial.roomId,
            isLocalHost: initial.isAdmin,
            isWebinarAttendee: initial.isWebinarAttendee,
            canEndForEveryone: false,
            confirmation: nil
        )
    }

    private static func initialControls() -> MeetingControlRowsState {
        let initial = MeetingShellInputs.make()
        let phase = MeetingPhasePolicy.resolve(initial).phase
        return MeetingControlRowsState(
            revision: 0,
            rows: MeetingControlAvailabilityPolicy.rows(initial, context: MeetingControlRowContext.make(phase: phase))
        )
    }

    /// The inputs the presenter last accepted (diagnostics and tests).
    var currentInputs: MeetingShellInputs { inputs }

    /// How many times any snapshot was assigned (S1C risk row "publish storms"; tests read it).
    var snapshotPublishCount: Int { publishCount }

    // MARK: - Core

    func apply(_ next: MeetingShellInputs) {
        guard next != inputs else { return }
        let previous = inputs
        inputs = next
        var pendingToken: FeedbackKind = .none

        if next.identity.callSession != previous.identity.callSession {
            // S1C SES: a new call session cancels everything in one coherent publish.
            ledger.cancelAll()
            confirmation = nil
            handFailure = .none
            leaveFailure = .none
            endFailure = .none
            admittedThisSession = false
            joinedThisSession = false
            panels.reset(session: next.identity.callSession)
            setFeedback(MeetingShellFeedbackState(session: next.identity.callSession, token: FeedbackToken.baseline))
        } else if next.identity.attempt != previous.identity.attempt
                    || next.identity.attemptToken != previous.identity.attemptToken {
            // A recovery rejoin, an admission or a cleanup: pending tickets are interrupted, so the UI never waits
            // for an acknowledgement that can no longer land.
            ledger.interruptAll()
        }

        if !previous.isRecoveringConnection && next.isRecoveringConnection {
            // S1C ACK: R10 disables socket mutations during recovery.
            ledger.interrupt(kinds: [MeetingActionKind.hand, MeetingActionKind.endForEveryone])
        }
        if previous.isAdmin && !next.isAdmin {
            // S1C ROLE: host loss clears the confirmation; a pending end keeps waiting for its result.
            confirmation = nil
        }
        if !previous.isWebinarAttendee && next.isWebinarAttendee {
            ledger.interrupt(kinds: [MeetingActionKind.microphone, MeetingActionKind.camera, MeetingActionKind.screenShare, MeetingActionKind.hand])
            confirmation = nil
        }

        if let outcome = next.currentOutcome, outcome.id != lastOutcomeTokenID {
            // S1C TEAR: after a terminal outcome nothing is pending and no panel is open.
            lastOutcomeTokenID = outcome.id
            ledger.cancelAll()
            confirmation = nil
            panels.reset(session: next.identity.callSession)
            pendingToken = MeetingFeedbackTokenPolicy.outcomeKind(outcome.kind)
        }

        let resolution = MeetingPhasePolicy.resolve(next)
        if resolution.phase != publishedPhase {
            let phaseToken = MeetingFeedbackTokenPolicy.phaseKind(
                from: publishedPhase,
                to: resolution.phase,
                admittedThisSession: admittedThisSession,
                joinedThisSession: joinedThisSession
            )
            if phaseToken == .admitted {
                admittedThisSession = true
            }
            if resolution.phase == .inCall {
                joinedThisSession = true
            }
            if pendingToken == .none {
                pendingToken = phaseToken
            }
            publishedPhase = resolution.phase
        }
        if pendingToken != .none {
            advanceFeedback(pendingToken)
        }
        publishAll(resolution: resolution)
    }

    /// Resolves a ticket the view model dispatched. Stale (another identity), duplicate and interrupted completions
    /// are dropped quietly and publish nothing.
    @discardableResult
    func finish(_ ticket: MeetingActionTicket, _ result: MeetingActionResult) -> Bool {
        guard ledger.finish(ticket, result: result, currentIdentity: inputs.identity) else { return false }
        if result.kind == .failed {
            setFailure(result.failure, for: ticket.kind)
            advanceFeedback(.actionRejected)
        }
        publishAll(resolution: MeetingPhasePolicy.resolve(inputs))
        return true
    }

    // MARK: - Intents (views)

    @discardableResult
    func toggleMicrophone() -> MeetingDispatch {
        let row = currentRow(.microphone)
        guard row.isVisible, row.isEnabled else { return .unavailable }
        // CC21: a tap toward muted while an unmute is pending still dispatches; the view model applies it at once.
        let dispatch = MeetingPendingMediaTapPolicy.microphoneTap(isPending: row.isPending, isMuted: inputs.isMuted)
        guard dispatch == .dispatched else { return dispatch }
        onCommand?(.toggleMicrophone, nil)
        return .dispatched
    }

    @discardableResult
    func toggleCamera() -> MeetingDispatch {
        let row = currentRow(.camera)
        guard row.isVisible, row.isEnabled else { return .unavailable }
        let dispatch = MeetingPendingMediaTapPolicy.cameraTap(isPending: row.isPending, isCameraOff: inputs.isCameraOff)
        guard dispatch == .dispatched else { return dispatch }
        onCommand?(.toggleCamera, nil)
        return .dispatched
    }

    @discardableResult
    func toggleScreenShare() -> MeetingDispatch {
        let row = currentRow(.screenShare)
        guard row.isVisible, row.isEnabled else { return .unavailable }
        guard !row.isPending else { return .duplicate }
        onCommand?(.toggleScreenShare, nil)
        return .dispatched
    }

    @discardableResult
    func toggleHand() -> MeetingDispatch {
        let row = currentRow(.hand)
        guard row.isVisible, row.isEnabled else { return .unavailable }
        guard !row.isPending,
              let ticket = ledger.begin(.hand, identity: inputs.identity) else { return .duplicate }
        handFailure = .none
        // Pending is visible in the same frame as the tap (S1C PUB).
        publishAll(resolution: MeetingPhasePolicy.resolve(inputs))
        onCommand?(.toggleHand, ticket)
        return .dispatched
    }

    func requestEndForEveryone(from invoker: PanelInvoker) {
        let row = currentRow(.endForEveryone)
        guard row.isVisible, row.isEnabled, !row.isPending, confirmation == nil else { return }
        nextConfirmationID += 1
        confirmation = MeetingConfirmation(id: nextConfirmationID, kind: .endForEveryone, invoker: invoker)
        publishAll(resolution: MeetingPhasePolicy.resolve(inputs))
    }

    /// Accepts only the current confirmation id, once.
    @discardableResult
    func confirmEndForEveryone(id: Int) -> MeetingDispatch {
        guard let current = confirmation, current.id == id else { return .duplicate }
        confirmation = nil
        let row = currentRow(.endForEveryone)
        guard row.isVisible, row.isEnabled else {
            publishAll(resolution: MeetingPhasePolicy.resolve(inputs))
            return .unavailable
        }
        guard let ticket = ledger.begin(.endForEveryone, identity: inputs.identity) else {
            publishAll(resolution: MeetingPhasePolicy.resolve(inputs))
            return .duplicate
        }
        endFailure = .none
        publishAll(resolution: MeetingPhasePolicy.resolve(inputs))
        onCommand?(.endForEveryone, ticket)
        return .dispatched
    }

    func cancelConfirmation(id: Int) {
        guard let current = confirmation, current.id == id else { return }
        confirmation = nil
        publishAll(resolution: MeetingPhasePolicy.resolve(inputs))
    }

    @discardableResult
    func leave() -> MeetingDispatch {
        let row = currentRow(.leave)
        guard row.isVisible, row.isEnabled else { return .unavailable }
        guard !row.isPending,
              let ticket = ledger.begin(.leave, identity: inputs.identity) else { return .duplicate }
        leaveFailure = .none
        publishAll(resolution: MeetingPhasePolicy.resolve(inputs))
        onCommand?(.leave, ticket)
        return .dispatched
    }

    func retry() {
        onCommand?(.retry, nil)
    }

    func dismissOutcome() {
        onCommand?(.dismissOutcome, nil)
    }

    // MARK: - Publication

    private func currentRow(_ id: MeetingControlID) -> MeetingControlRow {
        for row in controls.rows {
            if row.id == id.rawValue { return row }
        }
        return MeetingControlAvailabilityPolicy.row(id, inputs: inputs, context: rowContext(phase: publishedPhase))
    }

    private func rowContext(phase: MeetingPhaseKind) -> MeetingControlRowContext {
        MeetingControlRowContext(
            phase: phase,
            handTicketPending: ledger.isPending(.hand),
            leaveTicketPending: ledger.isPending(.leave),
            endTicketPending: ledger.isPending(.endForEveryone),
            handFailure: handFailure,
            leaveFailure: leaveFailure,
            endFailure: endFailure
        )
    }

    private func setFailure(_ failure: MeetingActionFailure, for kind: MeetingActionKind) {
        switch kind {
        case .hand: handFailure = failure
        case .leave: leaveFailure = failure
        case .endForEveryone: endFailure = failure
        case .microphone, .camera, .screenShare: break
        }
    }

    private func advanceFeedback(_ kind: FeedbackKind) {
        // Only accepted async outcomes advance the sequence (F1 rules, FeedbackKind.isAsyncOutcome).
        guard kind != .none, kind.isAsyncOutcome else { return }
        let token = FeedbackToken(sequence: feedbackState.token.sequence + 1, kind: kind)
        setFeedback(MeetingShellFeedbackState(session: feedbackState.session, token: token))
    }

    private func setFeedback(_ next: MeetingShellFeedbackState) {
        guard next != feedbackState else { return }
        feedbackState = next
        publishCount += 1
    }

    private func publishAll(resolution: MeetingPhaseResolution) {
        let publishesBefore = publishedCountAtLastSpy
        defer { publishedCountAtLastSpy = publishCount }
        let nextSession = MeetingSessionSnapshot(
            revision: session.revision,
            identity: inputs.identity,
            phase: resolution.phase,
            notice: resolution.notice,
            noticeText: resolution.noticeText,
            outcome: inputs.currentOutcome,
            roomLabel: inputs.roomId,
            isLocalHost: inputs.isAdmin,
            isWebinarAttendee: inputs.isWebinarAttendee,
            canEndForEveryone: MeetingControlAvailabilityPolicy.canEndForEveryone(inputs),
            confirmation: confirmation
        )
        if nextSession != session {
            session = MeetingSessionSnapshot(
                revision: session.revision + 1,
                identity: nextSession.identity,
                phase: nextSession.phase,
                notice: nextSession.notice,
                noticeText: nextSession.noticeText,
                outcome: nextSession.outcome,
                roomLabel: nextSession.roomLabel,
                isLocalHost: nextSession.isLocalHost,
                isWebinarAttendee: nextSession.isWebinarAttendee,
                canEndForEveryone: nextSession.canEndForEveryone,
                confirmation: nextSession.confirmation
            )
            publishCount += 1
        }

        let rows = MeetingControlAvailabilityPolicy.rows(inputs, context: rowContext(phase: resolution.phase))
        if rows != controls.rows {
            controls = MeetingControlRowsState(revision: controls.revision + 1, rows: rows)
            publishCount += 1
        }

        let nextEntry = MeetingShellPresenter.entrySnapshot(inputs)
        if nextEntry != entry {
            entry = nextEntry
            publishCount += 1
        }
        if publishCount != publishesBefore {
            onPublish?(session, controls, feedbackState)
        }
    }

    private static func entrySnapshot(_ inputs: MeetingShellInputs) -> MeetingEntrySnapshot {
        MeetingEntrySnapshot(
            roomId: inputs.roomId,
            displayName: inputs.displayName,
            micIntentOn: !inputs.isMuted,
            cameraIntentOn: !inputs.isCameraOff,
            formError: inputs.joinFormErrorMessage,
            showsEntryOverlayIntent: inputs.isEnteringMeeting,
            entryAction: inputs.meetingEntryAction
        )
    }
}
