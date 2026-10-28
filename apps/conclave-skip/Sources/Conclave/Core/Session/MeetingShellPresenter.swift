import Foundation
import Observation

@MainActor
@Observable
final class MeetingShellPresenter {
    private(set) var session: MeetingSessionSnapshot = MeetingShellPresenter.initialSession()
    private(set) var controls: MeetingControlRowsState = MeetingShellPresenter.initialControls()
    private(set) var entry: MeetingEntrySnapshot = MeetingShellPresenter.entrySnapshot(MeetingShellInputs.make())
    private(set) var feedbackState = MeetingShellFeedbackState(session: 0, token: FeedbackToken.baseline)

    let panels = PanelCoordinator(session: 0)

    let ledger = MeetingActionLedger()

    let chat = ChatPresenter()

    let settings = SettingsPresenter(scope: SettingsScope.call)

    let transcript = TranscriptPresenter()

    @ObservationIgnored var onCommand: ((MeetingShellCommand, MeetingActionTicket?) -> Void)? = nil

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
    @ObservationIgnored private var entryOrigin: MeetingEntryOrigin = .initial

    @ObservationIgnored private var micFailure: MeetingActionFailure = .none
    @ObservationIgnored private var micFailureIsOn = false
    @ObservationIgnored private var cameraFailure: MeetingActionFailure = .none
    @ObservationIgnored private var cameraFailureIsOn = false
    @ObservationIgnored private var screenShareFailure: MeetingActionFailure = .none
    @ObservationIgnored private var screenShareFailureIsOn = false

    @ObservationIgnored private var pendingHandDirection: MeetingActionDirection = .none
    @ObservationIgnored private var handFailureDirection: MeetingActionDirection = .none
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
            confirmation: nil,
            hasBeenAdmittedThisSession: false,
            entryOrigin: .initial
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

    var currentInputs: MeetingShellInputs { inputs }

    var snapshotPublishCount: Int { publishCount }

    func apply(_ next: MeetingShellInputs) {
        guard next != inputs else { return }
        let previous = inputs
        inputs = next
        var pendingToken: FeedbackKind = .none

        if next.identity.callSession != previous.identity.callSession {

            ledger.cancelAll()
            confirmation = nil
            handFailure = .none
            leaveFailure = .none
            endFailure = .none
            handFailureDirection = .none
            pendingHandDirection = .none
            clearMediaFailures()
            if next.isRedirectContinuation && joinedThisSession {

                entryOrigin = .recovery
            } else {
                admittedThisSession = false
                joinedThisSession = false
                entryOrigin = .initial
            }
            panels.reset(session: next.identity.callSession)
            setFeedback(MeetingShellFeedbackState(session: next.identity.callSession, token: FeedbackToken.baseline))
        } else if next.identity.attempt != previous.identity.attempt
                    || next.identity.attemptToken != previous.identity.attemptToken {

            ledger.interruptAll()
        }

        if !previous.isRecoveringConnection && next.isRecoveringConnection {

            ledger.interrupt(kinds: [MeetingActionKind.hand, MeetingActionKind.endForEveryone])
        }
        clearMediaFailuresThatChanged(next)
        if previous.isAdmin && !next.isAdmin {

            confirmation = nil
        }
        if !previous.isWebinarAttendee && next.isWebinarAttendee {
            ledger.interrupt(kinds: [MeetingActionKind.microphone, MeetingActionKind.camera, MeetingActionKind.screenShare, MeetingActionKind.hand])
            confirmation = nil
        }

        if let outcome = next.currentOutcome, outcome.id != lastOutcomeTokenID {

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
            if resolution.phase == .recovering && joinedThisSession {
                entryOrigin = .recovery
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

    @discardableResult
    func finish(_ ticket: MeetingActionTicket, _ result: MeetingActionResult) -> Bool {
        guard ledger.finish(ticket, result: result, currentIdentity: inputs.identity) else { return false }
        if result.kind == .failed {
            setFailure(result.failure, for: ticket.kind)
            if ticket.kind == .hand {
                handFailureDirection = result.direction != .none ? result.direction : pendingHandDirection
            }
            advanceFeedback(.actionRejected)
        }
        if ticket.kind == .hand {
            pendingHandDirection = .none
        }
        publishAll(resolution: MeetingPhasePolicy.resolve(inputs))
        return true
    }

    @discardableResult
    func toggleMicrophone() -> MeetingDispatch {
        let row = currentRow(.microphone)
        guard row.isVisible, row.isEnabled else { return .unavailable }

        let dispatch = MeetingPendingMediaTapPolicy.microphoneTap(isPending: row.isPending, isMuted: inputs.isMuted)
        guard dispatch == .dispatched else { return dispatch }
        if micFailure != .none {
            micFailure = .none
            publishAll(resolution: MeetingPhasePolicy.resolve(inputs))
        }
        onCommand?(.toggleMicrophone, nil)
        return .dispatched
    }

    @discardableResult
    func toggleCamera() -> MeetingDispatch {
        let row = currentRow(.camera)
        guard row.isVisible, row.isEnabled else { return .unavailable }
        let dispatch = MeetingPendingMediaTapPolicy.cameraTap(isPending: row.isPending, isCameraOff: inputs.isCameraOff)
        guard dispatch == .dispatched else { return dispatch }
        if cameraFailure != .none {
            cameraFailure = .none
            publishAll(resolution: MeetingPhasePolicy.resolve(inputs))
        }
        onCommand?(.toggleCamera, nil)
        return .dispatched
    }

    @discardableResult
    func toggleScreenShare() -> MeetingDispatch {
        let row = currentRow(.screenShare)
        guard row.isVisible, row.isEnabled else { return .unavailable }
        guard !row.isPending else { return .duplicate }
        if screenShareFailure != .none {
            screenShareFailure = .none
            publishAll(resolution: MeetingPhasePolicy.resolve(inputs))
        }
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
        handFailureDirection = .none
        pendingHandDirection = inputs.isHandRaised ? .lower : .raise

        publishAll(resolution: MeetingPhasePolicy.resolve(inputs))
        onCommand?(.toggleHand, ticket)
        return .dispatched
    }

    func requestEndForEveryone(from invoker: String) {
        let row = currentRow(.endForEveryone)
        guard row.isVisible, row.isEnabled, !row.isPending, confirmation == nil else { return }
        nextConfirmationID += 1
        confirmation = MeetingConfirmation(id: nextConfirmationID, kind: .endForEveryone, invoker: invoker)
        publishAll(resolution: MeetingPhasePolicy.resolve(inputs))
    }

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
        if let onCommand = onCommand { onCommand(.retry, nil) }
    }

    @discardableResult
    func reportFailure(_ kind: MeetingActionKind, _ result: MeetingActionResult) -> Bool {
        guard result.kind == .failed, result.failure != .none else { return false }
        switch kind {
        case .microphone:
            micFailure = result.failure
            micFailureIsOn = !inputs.isMuted
        case .camera:
            cameraFailure = result.failure
            cameraFailureIsOn = !inputs.isCameraOff
        case .screenShare:
            screenShareFailure = result.failure
            screenShareFailureIsOn = inputs.isScreenSharing
        case .hand, .leave, .endForEveryone:
            return false
        }
        publishAll(resolution: MeetingPhasePolicy.resolve(inputs))
        return true
    }

    func dismissOutcome() {
        if let onCommand = onCommand { onCommand(.dismissOutcome, nil) }
    }

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
            endFailure: endFailure,
            micFailure: micFailure,
            cameraFailure: cameraFailure,
            screenShareFailure: screenShareFailure,
            handFailureDirection: handFailureDirection
        )
    }

    private func clearMediaFailures() {
        micFailure = .none
        cameraFailure = .none
        screenShareFailure = .none
    }

    private func clearMediaFailuresThatChanged(_ next: MeetingShellInputs) {
        if micFailure != .none && !next.isMuted != micFailureIsOn {
            micFailure = .none
        }
        if cameraFailure != .none && !next.isCameraOff != cameraFailureIsOn {
            cameraFailure = .none
        }
        if screenShareFailure != .none && next.isScreenSharing != screenShareFailureIsOn {
            screenShareFailure = .none
        }
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
            confirmation: confirmation,
            hasBeenAdmittedThisSession: joinedThisSession,
            entryOrigin: entryOrigin
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
                confirmation: nextSession.confirmation,
                hasBeenAdmittedThisSession: nextSession.hasBeenAdmittedThisSession,
                entryOrigin: nextSession.entryOrigin
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
