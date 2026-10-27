import Foundation
import Observation

/// S30 0.5 (CTL-1): the one session-owned controls presenter, created with the S1 `MeetingShellPresenter` and the S20
/// `StagePresenter` and reset with them (S1C 3.2). The core pushes `CallControlsInputs` through `apply(_:)` on its own
/// refresh path (CC1: after each shell refresh, on the CC1 MS hooks and on every panel snapshot change, CC18); the
/// view reports its window classes through `setWindow`. Publishing is equality guarded per property and the presenter
/// never observes the core (SkipModel has no `withObservationTracking`). Every intent goes through S1, so a bar tap,
/// CallKit, the notification and Magic Tap share one media path (D18, S1C 3.3 MUTE).
///
/// Extension points (later slices add their snapshots here, keeping one presenter): CTL-2 the Leave control and End
/// dialog over `leaveState`; CTL-3 `route`; CTL-5 `more`, `moreMetrics`, `commands` and `select(_:)`; CTL-6 `reactions`
/// and `sendReaction(id:)`.
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

    init(shell: MeetingShellPresenter, stage: StagePresenter) {
        self.shell = shell
        self.stage = stage
    }

    // MARK: Core

    /// Core only (CC1): the whole input set, equality guarded per published property. A new call session clears the
    /// one-shots so nothing from the previous call is shown again.
    func apply(_ next: CallControlsInputs) {
        applyCount += 1
        if inputs.callSession != 0 && next.callSession != inputs.callSession {
            clearOneShots()
        }
        inputs = next
        recompute()
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

    /// Leave works on one tap for everyone (S30 D24, R09); no haptic (Q11).
    @discardableResult
    func leave() -> ControlTapResult {
        stage.noteControlAction()
        switch shell.leave() {
        case .dispatched: return ControlTapResult.dispatched
        default: return ControlTapResult.ignored
        }
    }

    /// Mirrors S1 (S50 PH17): `invoker` is a `MeetingConfirmationInvoker` value ("call" or "more").
    func requestEndForEveryone(from invoker: String) {
        shell.requestEndForEveryone(from: invoker)
    }

    /// `postRecap` waits for the WP8 recap owner (CC8); until then End goes straight to the S1 ticket.
    @discardableResult
    func confirmEndForEveryone(id: Int, postRecap: Bool) -> ControlTapResult {
        switch shell.confirmEndForEveryone(id: id) {
        case .dispatched: return ControlTapResult.dispatched
        default: return ControlTapResult.ignored
        }
    }

    func cancelEnd(id: Int) {
        shell.cancelConfirmation(id: id)
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
        overflowIds = []
        fitReadout = "none"
        recompute()
    }

    // MARK: Private

    private func recompute() {
        let candidate = ControlBarPolicy.bar(inputs: inputs, layout: layout, revision: bar.revision)
        if candidate != bar {
            bar = candidate.withRevision(bar.revision + 1)
            barPublishCount += 1
        }
        let leaveCandidate = ControlBarPolicy.leaveSnapshot(inputs: inputs, revision: leaveState.revision)
        if leaveCandidate != leaveState {
            leaveState = leaveCandidate.withRevision(leaveState.revision + 1)
        }
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
