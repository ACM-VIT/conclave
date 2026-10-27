import Foundation
import Observation

/// S30 0.5 (CTL-1): the one session-owned controls presenter, created with the S1 `MeetingShellPresenter` and the S20
/// `StagePresenter` and reset with them (S1C 3.2). The core pushes `CallControlsInputs` through `apply(_:)` on its own
/// refresh path (CC1: after each shell refresh, on the CC1 MS hooks and on every panel snapshot change, CC18); the
/// view reports its window classes through `setWindow`. Publishing is equality guarded per property and the presenter
/// never observes the core (SkipModel has no `withObservationTracking`). Every intent goes through S1, so a bar tap,
/// CallKit, the notification and Magic Tap share one media path (D18, S1C 3.3 MUTE).
///
/// Extension points (later slices add their snapshots here, keeping one presenter): CTL-2 (here) the Leave control,
/// the host Leave menu and the End dialog over `leaveState`, with the End progress and failure toasts (CC7); CTL-3
/// `route`; CTL-5 `more`, `moreMetrics`, `commands` and `select(_:)`; CTL-6 `reactions` and `sendReaction(id:)`.
@MainActor
@Observable
final class CallControlsPresenter {
    /// The bar and its cells only.
    private(set) var bar: ControlBarSnapshot = ControlBarSnapshot.empty
    /// The Leave control, the host Leave menu and the End dialog only (CTL-2).
    private(set) var leaveState: LeaveSnapshot = LeaveSnapshot.idle
    /// The last blocked-tap explanation (CL6); the toast lane shows it once per `id`.
    private(set) var explanation: ControlExplanation? = nil
    /// The permission alert a permission-denied tap opens (S10 7 copy); nil while none shows.
    private(set) var permissionPrompt: ControlPermissionPrompt? = nil

    @ObservationIgnored let shell: MeetingShellPresenter
    /// S20; the local explanation toasts (CC7) and the bar hold (CC16).
    @ObservationIgnored let stage: StagePresenter

    /// Observers of explanations (the Debug fixture and the tests); the toast itself is posted to the stage (CC7).
    @ObservationIgnored var onExplain: ((ControlExplanation) -> Void)? = nil
    /// Core only: commands S1 has no intent for (the in-context permission request).
    @ObservationIgnored var onCommand: ((CallControlsCommand) -> Void)? = nil

    @ObservationIgnored private(set) var inputs = CallControlsInputs.make()
    @ObservationIgnored private(set) var windowWidth = ControlsWindowClass.compact
    @ObservationIgnored private(set) var windowHeight = ControlsWindowClass.regular
    @ObservationIgnored private(set) var isPhone = true
    /// Debug fixtures only (CL13 `controls-wide` on a phone): forces a composition whatever window the view reports.
    @ObservationIgnored private(set) var compositionOverride: ControlBarComposition? = nil
    /// Controls the view's fit moved into More (F00 C05 f); More (CTL-5) lists them.
    @ObservationIgnored private(set) var overflowIds: [String] = []
    /// The last fit the bar view drew ("Bar W of A ..."), for the `controls.bar` readout; never observed.
    @ObservationIgnored private(set) var fitReadout = "none"
    /// Diagnostics for readouts and tests (never observed).
    @ObservationIgnored private(set) var applyCount = 0
    @ObservationIgnored private(set) var barPublishCount = 0
    @ObservationIgnored private(set) var explainCount = 0
    @ObservationIgnored private(set) var promptCount = 0
    @ObservationIgnored private(set) var commandCount = 0
    @ObservationIgnored private var nextExplanationId = 0
    @ObservationIgnored private var nextPromptId = 0
    /// CTL-2 diagnostics (never observed): End requests through the presenter, dispatched End confirmations, and the
    /// End notices posted to the stage toast lane (CL13 `controls.counters`, the tests).
    @ObservationIgnored private(set) var endRequestCount = 0
    @ObservationIgnored private(set) var endDispatchCount = 0
    @ObservationIgnored private(set) var endingNoticeCount = 0
    @ObservationIgnored private(set) var endFailedNoticeCount = 0
    /// The `endingForEveryone` progress toast posted for the End ticket in flight; "" when none.
    @ObservationIgnored private(set) var endingNoticeId = ""
    /// A dispatched End whose result this presenter has not seen yet (S30 4: ending, then a failure or the end).
    @ObservationIgnored private var endResultOwed = false
    /// True while S1 runs `confirmEndForEveryone`: publishes nested in that call (a synchronous acknowledgment) wait for
    /// the dispatch answer before the End notices are decided, so a refused confirm never posts a failure.
    @ObservationIgnored private var isConfirmingEnd = false
    @ObservationIgnored private var nextEndingNoticeSerial = 0

    init(shell: MeetingShellPresenter, stage: StagePresenter) {
        self.shell = shell
        self.stage = stage
    }

    // MARK: Core

    /// Core only (CC1): the whole input set, equality guarded per published property. A new call session clears the
    /// one-shots so nothing from the previous call is shown again.
    func apply(_ next: CallControlsInputs) {
        applyCount += 1
        absorb(next)
    }

    // MARK: View

    /// The view's window classes (S30 1 c and 1 d); equality guarded, so a resize that keeps the classes publishes
    /// nothing.
    func setWindow(width: ControlsWindowClass, height: ControlsWindowClass, isPhone: Bool) {
        if width == windowWidth && height == windowHeight && isPhone == self.isPhone { return }
        windowWidth = width
        windowHeight = height
        self.isPhone = isPhone
        recompute()
    }

    func setCompositionOverride(_ composition: ControlBarComposition?) {
        if composition == compositionOverride { return }
        compositionOverride = composition
        recompute()
    }

    /// The ids the view's fit moved to More; never published (More reads it when it opens).
    func setOverflow(ids: [String]) {
        if ids != overflowIds { overflowIds = ids }
    }

    /// Records the drawn fit for the readout; never published.
    func reportFit(_ readout: String) {
        if readout != fitReadout { fitReadout = readout }
    }

    /// The current layout (composition and axis) for the reported window.
    var layout: ControlBarLayout {
        let picked = ControlBarPolicy.layout(width: windowWidth, height: windowHeight, isPhone: isPhone,
                                             isAttendee: inputs.isWebinarAttendee)
        if let forced = compositionOverride, !inputs.isWebinarAttendee {
            return ControlBarLayout(composition: forced, axis: picked.axis)
        }
        return picked
    }

    /// A control's current model whether or not the composition shows it (keyboard commands and More rows act on
    /// controls the compact bar does not carry). Nil when the control does not exist for this person.
    func model(_ kind: CallControlKind) -> CallControlModel? {
        let composition = layout.composition
        if let shown = bar.control(kind) { return shown }
        return ControlBarPolicy.control(kind, inputs: inputs, composition: composition)
    }

    /// One tap on a bar control (S30 0.5 mapping). A blocked control explains instead of dispatching (Q11, CL6) and
    /// stays hit-testable; a permission-denied tap opens the alert; a not-yet-determined permission asks the system.
    /// Pending media taps go to S1 unfiltered, because S1 decides CC21 (a mic tap toward muted, or a camera tap toward
    /// off, while the row is pending still dispatches; the opposite direction is a duplicate).
    @discardableResult
    func tap(_ kind: CallControlKind) -> ControlTapResult {
        stage.noteControlAction()
        guard let current = model(kind) else { return ControlTapResult.ignored }
        if current.isBlocked {
            return explainBlocked(current)
        }
        switch kind {
        case .microphone:
            return result(shell.toggleMicrophone(), kind: kind)
        case .camera:
            return result(shell.toggleCamera(), kind: kind)
        case .screenShare:
            return result(shell.toggleScreenShare(), kind: kind)
        case .hand:
            return result(shell.toggleHand(), kind: kind)
        case .chat, .participants, .qa:
            guard let panel = ControlBarPolicy.panel(kind) else { return ControlTapResult.ignored }
            shell.panels.toggle(panel, from: PanelInvoker.call)
            return ControlTapResult.dispatched
        case .more:
            // CTL-5 attaches the native menu (iOS) and the in-call sheet (Android) to the More control; the tap itself
            // only counts as a control action (it clears the bar hold, CC16).
            return ControlTapResult.dispatched
        case .leave:
            return leave()
        }
    }

    /// Leave works on one tap for everyone (S30 D24, R09); no haptic (Q11). The leaving state is published in the same
    /// frame (S1 PUB): the S1 fields are re-read right after the intent.
    @discardableResult
    func leave() -> ControlTapResult {
        stage.noteControlAction()
        let dispatch = shell.leave()
        refreshFromShell()
        switch dispatch {
        case .dispatched: return ControlTapResult.dispatched
        default: return ControlTapResult.ignored
        }
    }

    /// Mirrors S1 (S50 PH17): `invoker` is a `MeetingConfirmationInvoker` value ("call" from the Leave menu, its
    /// accessibility action and the failure toast's Retry; "more" from the More row, CTL-5). S1 refuses a request while
    /// End is blocked, pending or already confirming; the confirmation (or nothing) shows in the same frame.
    func requestEndForEveryone(from invoker: String) {
        stage.noteControlAction()
        endRequestCount += 1
        shell.requestEndForEveryone(from: invoker)
        refreshFromShell()
    }

    /// One confirm per confirmation id (S1C DUP: a second confirm is a duplicate and returns `ignored`). A dispatched End
    /// owes a result: the presenter posts the `endingForEveryone` progress toast while the ticket is in flight and the
    /// `endFailed` toast with Retry if it fails, and Leave stays available throughout (R09). `postRecap` waits for the
    /// WP8 recap owner (CC8, TRN-2); until then End goes straight to the S1 ticket.
    @discardableResult
    func confirmEndForEveryone(id: Int, postRecap: Bool) -> ControlTapResult {
        stage.noteControlAction()
        isConfirmingEnd = true
        let dispatch = shell.confirmEndForEveryone(id: id)
        isConfirmingEnd = false
        if dispatch == MeetingDispatch.dispatched {
            endDispatchCount += 1
            endResultOwed = true
        }
        refreshFromShell()
        switch dispatch {
        case .dispatched: return ControlTapResult.dispatched
        default: return ControlTapResult.ignored
        }
    }

    /// Cancel, Back, a scrim tap or a tap outside the iPad popover: the confirmation closes and nothing else changes.
    func cancelEnd(id: Int) {
        stage.noteControlAction()
        shell.cancelConfirmation(id: id)
        refreshFromShell()
    }

    /// A host Leave menu row (S30 4 b): Leave leaves; End asks for the confirmation from the Leave control ("call").
    @discardableResult
    func selectLeaveMenuItem(_ id: String) -> ControlTapResult {
        if id == LeaveControlPolicy.leaveItemId {
            return leave()
        }
        if id == LeaveControlPolicy.endItemId {
            if !LeaveControlPolicy.offersEndAction(leaveState) {
                stage.noteControlAction()
                return ControlTapResult.ignored
            }
            requestEndForEveryone(from: MeetingConfirmationInvoker.call)
            return leaveState.confirmationId != 0 ? ControlTapResult.dispatched : ControlTapResult.ignored
        }
        return ControlTapResult.ignored
    }

    /// The alert closed (Open Settings or Not Now).
    func dismissPermissionPrompt(id: Int) {
        guard let prompt = permissionPrompt, prompt.id == id else { return }
        permissionPrompt = nil
    }

    /// With the S1 reset (S1C 3.3 TEAR): no task to cancel; one-shots and window facts stay consistent, revisions keep
    /// growing so a view never mistakes a reset for "unchanged".
    func reset() {
        inputs = CallControlsInputs.make()
        clearOneShots()
        clearEndTracking()
        overflowIds = []
        fitReadout = "none"
        recompute()
    }

    // MARK: Private

    /// The whole input set: a new call session clears the one-shots and the End tracking, so nothing from the previous
    /// call is shown again.
    private func absorb(_ next: CallControlsInputs) {
        if inputs.callSession != 0 && next.callSession != inputs.callSession {
            clearOneShots()
            clearEndTracking()
        }
        inputs = next
        recompute()
    }

    /// CTL-2: S1 publishes that this presenter's own intents cause (the End confirmation, its cancel, a dispatched End
    /// or Leave ticket) change no core field, so the core may not refresh the controls for them; the S1 fields are re-read
    /// from the shell snapshots and the controls-only fields stay (the view model's publish hook, HD/requests/B5-T3.md
    /// R1, brings ticket results that arrive later). Equality guarded like `apply`.
    private func refreshFromShell() {
        absorb(inputs.refreshed(from: shell))
    }

    private func recompute() {
        let candidate = ControlBarPolicy.bar(inputs: inputs, layout: layout, revision: bar.revision)
        if candidate != bar {
            bar = candidate.withRevision(bar.revision + 1)
            barPublishCount += 1
        }
        let leaveCandidate = ControlBarPolicy.leaveSnapshot(inputs: inputs, revision: leaveState.revision)
        if leaveCandidate != leaveState {
            leaveState = leaveCandidate.withRevision(leaveState.revision + 1)
            // S30 CC16: an open End confirmation keeps chrome up on both platforms (the iOS dialog reports nothing of its
            // own); equality guarded in the stage.
            stage.setTransientChrome(id: ChromeAutoHidePolicy.endDialog, open: leaveState.confirmationId != 0)
        }
        followEndResult()
    }

    /// S30 4 c and CC7: while a dispatched End is in flight the toast lane holds "Ending the call for everyone…"; a
    /// failure replaces it with the Retry toast (S1 already delivered `actionRejected`); the end of the call, an
    /// interruption or a cancelled ticket clears it. Decided only after S1 answered the confirm.
    private func followEndResult() {
        if !endResultOwed || isConfirmingEnd { return }
        switch leaveState.endPhase {
        case .ending:
            if endingNoticeId.isEmpty {
                nextEndingNoticeSerial += 1
                endingNoticeId = LeaveControlPolicy.endingNoticePrefix + String(nextEndingNoticeSerial)
                endingNoticeCount += 1
                stage.postLocal(LeaveControlPolicy.endingNotice(id: endingNoticeId))
            }
        case .failed:
            endResultOwed = false
            // STG-5 `postLocal` swaps a showing progress toast for the failure in place and drops a queued one.
            endingNoticeId = ""
            endFailedNoticeCount += 1
            stage.postLocal(LeaveControlPolicy.endFailedNotice())
        case .idle, .confirming, .postingRecap:
            endResultOwed = false
            clearEndingNotice()
        }
    }

    private func clearEndTracking() {
        endResultOwed = false
        clearEndingNotice()
    }

    private func clearEndingNotice() {
        if endingNoticeId.isEmpty { return }
        let id = endingNoticeId
        endingNoticeId = ""
        stage.clearLocalNotice(id: id)
    }

    private func clearOneShots() {
        if explanation != nil { explanation = nil }
        if permissionPrompt != nil { permissionPrompt = nil }
    }

    /// S30 0.5 tap results: `dispatched` stays dispatched; `duplicate` (and pending taps S1 refuses) is ignored;
    /// `unavailable` explains when the row's reason has copy, else it is ignored.
    private func result(_ dispatch: MeetingDispatch, kind: CallControlKind) -> ControlTapResult {
        switch dispatch {
        case .dispatched:
            return ControlTapResult.dispatched
        case .duplicate:
            return ControlTapResult.ignored
        case .unavailable:
            guard let fresh = ControlBarPolicy.control(kind, inputs: inputs, composition: layout.composition) else {
                return ControlTapResult.ignored
            }
            return explainBlocked(fresh)
        }
    }

    private func explainBlocked(_ model: CallControlModel) -> ControlTapResult {
        switch model.reason {
        case .permissionDenied:
            nextPromptId += 1
            promptCount += 1
            let kind = model.kind == CallControlKind.camera ? ControlPermissionKind.camera : ControlPermissionKind.microphone
            permissionPrompt = ControlPermissionPrompt(id: nextPromptId, kind: kind)
            return ControlTapResult.explained
        case .permissionUndetermined:
            commandCount += 1
            onCommand?(model.kind == CallControlKind.camera ? CallControlsCommand.requestCameraPermission
                                                            : CallControlsCommand.requestMicrophonePermission)
            return ControlTapResult.explained
        default:
            guard ControlBarPolicy.explains(model.reason) else { return ControlTapResult.ignored }
            nextExplanationId += 1
            explainCount += 1
            let next = ControlExplanation(id: nextExplanationId, kind: model.kind, reason: model.reason, reasonName: model.reasonName,
                                          actionId: ControlBarPolicy.explanationActionId(model.reason))
            explanation = next
            // S30 CC7: the presenter-originated toast goes to the one stage toast lane (STG-5 `postLocal`).
            stage.postLocal(ControlBarPolicy.explanationNotice(next))
            onExplain?(next)
            return ControlTapResult.explained
        }
    }
}
