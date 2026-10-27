import Foundation
import Observation

/// S30 0.5 (CTL-1): the one session-owned controls presenter, created with the S1 `MeetingShellPresenter` and the S20
/// `StagePresenter` and reset with them (S1C 3.2). The core pushes `CallControlsInputs` through `apply(_:)` on its own
/// refresh path (CC1: after each shell refresh, on the CC1 MS hooks and on every panel snapshot change, CC18); the
/// view reports its window classes through `setWindow`. Publishing is equality guarded per property and the presenter
/// never observes the core (SkipModel has no `withObservationTracking`). Every intent goes through S1, so a bar tap,
/// CallKit, the notification and Magic Tap share one media path (D18, S1C 3.3 MUTE).
///
/// Extension points (later slices add their snapshots here, keeping one presenter): CTL-2 the Leave control, the host
/// Leave menu and the End dialog over `leaveState`, with the End progress and failure toasts (CC7); CTL-3 `route`;
/// CTL-5 (here) `more`, `moreMetrics`, `commands`, `select(_:)`, `setCaptions(_:)`, `setLayoutMode(_:)`,
/// `copyLink(postsToast:)` and `perform(_:)`; CTL-6 (here) `reactions` and `sendReaction(id:)`. Local actions the core
/// performs (a reaction, captions, the layout, Flip, Lock, the iOS system effects) go out through `onRequest`.
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
    /// CTL-5: the More content only (iOS menu and fallback sheet, Android sheet), read when it opens (S30 5 k).
    private(set) var more: MoreSnapshot = MoreSnapshot.empty
    /// CTL-5: the iOS More control only: menu or fallback sheet form (CL16). Changes only with the row structure.
    private(set) var moreMetrics: MoreMenuMetrics = MoreMenuMetrics.empty
    /// CTL-6: the palette, the tray and the Android reaction rows only (S30 6 k).
    private(set) var reactions: ReactionPaletteSnapshot = ReactionPaletteSnapshot.empty
    /// CTL-5: the iOS scene commands and the Android key handler only (S30 1 g, CL21).
    private(set) var commands: CallCommandsSnapshot = CallCommandsSnapshot.empty

    @ObservationIgnored let shell: MeetingShellPresenter
    /// S20; the local explanation toasts (CC7) and the bar hold (CC16).
    @ObservationIgnored let stage: StagePresenter

    /// Observers of explanations (the Debug fixture and the tests); the toast itself is posted to the stage (CC7).
    @ObservationIgnored var onExplain: ((ControlExplanation) -> Void)? = nil
    /// Core only: commands S1 has no intent for (the in-context permission request).
    @ObservationIgnored var onCommand: ((CallControlsCommand) -> Void)? = nil
    /// Core only (CTL-5, CTL-6): local actions with a value (S30 0.5 mapping). The core answers true when it accepted
    /// the request (the presenter then returns `dispatched`, and the view plays its gesture); nil answers nothing.
    @ObservationIgnored var onRequest: ((CallControlsRequest) -> Bool)? = nil

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
    /// CTL-5 and CTL-6 diagnostics (never observed): the CL13 `controls.counters` readout and the tests.
    @ObservationIgnored private(set) var reactionCount = 0
    @ObservationIgnored private(set) var panelRequestCount = 0
    @ObservationIgnored private(set) var captionsRequestCount = 0
    @ObservationIgnored private(set) var layoutRequestCount = 0
    @ObservationIgnored private(set) var flipRequestCount = 0
    @ObservationIgnored private(set) var lockRequestCount = 0
    @ObservationIgnored private(set) var copyLinkCount = 0
    @ObservationIgnored private(set) var inviteCount = 0
    @ObservationIgnored private(set) var systemEffectsRequestCount = 0
    @ObservationIgnored private(set) var keyboardCommandCount = 0
    /// Android: the More sheet finished dismissing (S30 5 l5: before the panel presents).
    @ObservationIgnored private(set) var moreSheetDismissCount = 0
    /// The last iOS menu budget the More control drew ("estimate E of space S form menu"), for `controls.menuHeight`.
    @ObservationIgnored private(set) var menuHeightReadout = "none"
    /// CTL-6: the direction of the hand ticket this presenter dispatched, until the S1 row stops pending (S30 6 f).
    @ObservationIgnored private(set) var handIntent = MeetingActionDirection.none

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

    /// The ids the view's fit moved to More. Never published itself; More's rows follow it (a moved Chat gets a row; the
    /// wide bar's moved Raise Hand, Share Screen and Participants come back), equality guarded. CHT-8: a moved Chat with
    /// unread messages also puts the dot on More, so the bar is republished when the moved set changes.
    func setOverflow(ids: [String]) {
        if ids == overflowIds { return }
        overflowIds = ids
        recompute()
    }

    /// The iOS More control's last menu budget (CL13 `controls.menuHeight`); never published.
    func reportMenuHeight(_ readout: String) {
        if readout != menuHeightReadout { menuHeightReadout = readout }
    }

    /// Android (S30 5 l5): the More sheet finished dismissing; counted before a panel it chose presents.
    func noteMoreSheetDismissed() {
        moreSheetDismissCount += 1
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
            return toggleHand(current.isOn)
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

    // MARK: More (CTL-5)

    /// One More row, a tile or a keyboard command (S30 0.5 mapping). A disabled row already shows its reason, so it is
    /// ignored without a toast (S30 7 rule 4). Panels open through `PanelCoordinator.presentFromMore` with invoker
    /// `.more` (iOS after the menu or the fallback sheet closed, Android after the sheet finished dismissing, D17).
    @discardableResult
    func select(_ id: MoreItemID) -> ControlTapResult {
        stage.noteControlAction()
        guard let item = more.item(id), item.isEnabled else { return ControlTapResult.ignored }
        switch id {
        case .reactions:
            // The palette sends through `sendReaction(id:)`.
            return ControlTapResult.ignored
        case .moreReactions:
            return reactions.art.isEmpty ? ControlTapResult.ignored : ControlTapResult.dispatched
        case .hand:
            // Non-optimistic (INM B5): the row reads "Raising Hand…" until the acknowledgment.
            return toggleHand(item.isOn)
        case .screenShare:
            return result(shell.toggleScreenShare(), kind: CallControlKind.screenShare)
        case .captions:
            return setCaptions(!item.isOn)
        case .flipCamera:
            flipRequestCount += 1
            return submit(CallControlsRequest.make(CallControlsRequestKind.flipCamera))
        case .systemVideoEffects:
            systemEffectsRequestCount += 1
            return submit(CallControlsRequest.make(CallControlsRequestKind.showSystemVideoEffects))
        case .chat, .participants, .activities, .transcript, .qa, .layout, .effects, .settings, .meetingDetails, .hostControls:
            guard let panel = MoreMenuPolicy.panel(id) else { return ControlTapResult.ignored }
            panelRequestCount += 1
            return shell.panels.presentFromMore(panel) ? ControlTapResult.dispatched : ControlTapResult.ignored
        case .invite:
            // The view shares (iOS `ShareLink`, Android the chooser after the sheet is gone); counted here.
            inviteCount += 1
            return ControlTapResult.dispatched
        case .copyLink:
            return copyLink(postsToast: true)
        case .lockMeeting:
            // The S50 host-actions owner over `toggleRoomLock()` (its pending state and failure toast are its own).
            lockRequestCount += 1
            return submit(CallControlsRequest.make(CallControlsRequestKind.setRoomLock,
                                                    value: item.isOn ? CallControlsRequest.off : CallControlsRequest.on))
        case .endForEveryone:
            requestEndForEveryone(from: MeetingConfirmationInvoker.more)
            return MoreMenuPolicy.presentsEndDialog(leaveState) ? ControlTapResult.dispatched : ControlTapResult.ignored
        }
    }

    /// The local captions preference (S20 SC13); never blocked except while leaving, and attendees hold no captions.
    @discardableResult
    func setCaptions(_ on: Bool) -> ControlTapResult {
        stage.noteControlAction()
        if inputs.phase == MeetingPhaseKind.leaving || inputs.isWebinarAttendee { return ControlTapResult.ignored }
        captionsRequestCount += 1
        return submit(CallControlsRequest.make(CallControlsRequestKind.setCaptions,
                                                value: on ? CallControlsRequest.on : CallControlsRequest.off))
    }

    /// A `MeetingViewMode` raw value from the iOS Layout submenu (S20 SC2 rules in the core, persisted there).
    @discardableResult
    func setLayoutMode(_ raw: String) -> ControlTapResult {
        stage.noteControlAction()
        if !MoreMenuPolicy.layoutModes.contains(raw) || raw == inputs.layoutMode { return ControlTapResult.ignored }
        layoutRequestCount += 1
        return submit(CallControlsRequest.make(CallControlsRequestKind.setLayoutMode, value: raw))
    }

    /// Copy Link (S30 5 c, d): the view writes the pasteboard or clipboard first. `postsToast` is true on iOS (the toast
    /// "Link copied") and on Android API 28 to 32 only (API 33 and later show the system clipboard confirmation).
    @discardableResult
    func copyLink(postsToast: Bool) -> ControlTapResult {
        stage.noteControlAction()
        guard let item = more.item(MoreItemID.copyLink), item.isEnabled else { return ControlTapResult.ignored }
        copyLinkCount += 1
        if postsToast {
            stage.postLocal(MeetingNotice.make(kind: NoticeKind.linkCopied))
        }
        return ControlTapResult.dispatched
    }

    /// One keyboard command (S30 1 g): the same intents as the bar and More, gated by `commands`; nothing plays.
    @discardableResult
    func perform(_ command: CallCommandID) -> ControlTapResult {
        guard let item = commands.item(command), item.isVisible, item.isEnabled else { return ControlTapResult.ignored }
        keyboardCommandCount += 1
        switch command {
        case .microphone: return tap(CallControlKind.microphone)
        case .camera: return tap(CallControlKind.camera)
        case .hand: return tap(CallControlKind.hand)
        case .screenShare: return tap(CallControlKind.screenShare)
        case .chat, .participants:
            stage.noteControlAction()
            let panel = command == CallCommandID.chat ? MeetingPanel.chat : MeetingPanel.participants
            shell.panels.present(panel, from: PanelInvoker.call)
            return ControlTapResult.dispatched
        case .lockMeeting:
            return select(MoreItemID.lockMeeting)
        }
    }

    // MARK: Reactions and hand (CTL-6)

    /// One palette, tray or row tap (S30 0.5): the id resolves to a `MeetingReactionOption` or the tap is ignored; the
    /// core keeps its cooldown and the local echo. The iOS menu closes after it, the tray and the Android sheet stay.
    @discardableResult
    func sendReaction(id: String) -> ControlTapResult {
        stage.noteControlAction()
        guard reactions.isAvailable, ReactionPalettePolicy.offers(reactions, id: id), ReactionPalettePolicy.option(id: id) != nil else {
            return ControlTapResult.ignored
        }
        let sent = submit(CallControlsRequest.make(CallControlsRequestKind.sendReaction, value: id))
        if sent == ControlTapResult.dispatched { reactionCount += 1 }
        return sent
    }

    /// The local hand as the S20 SC12 state, from the S1 hand row (ticket pending plus the server state) and the
    /// direction this presenter dispatched: lowered, raising, raised, lowering. Never observed (readouts and tests).
    var handState: LocalHandState {
        guard let row = inputs.row(MeetingControlID.hand) else { return LocalHandState.lowered }
        let intent = handIntent == MeetingActionDirection.none ? "" : handIntent.rawValue
        return MoreMenuPolicy.handState(isOn: row.isOn, isPending: row.isPending, intent: intent)
    }

    /// One hand toggle from the bar, More or a keyboard command: the direction is recorded before S1 publishes the
    /// pending row (the publish hook recomputes More in the same call), and dropped when S1 refuses.
    private func toggleHand(_ isOn: Bool) -> ControlTapResult {
        if inputs.row(MeetingControlID.hand)?.isPending ?? false {
            // S1 DUP: the ticket in flight keeps its direction; this tap is a duplicate.
            return result(shell.toggleHand(), kind: CallControlKind.hand)
        }
        let previous = handIntent
        handIntent = isOn ? MeetingActionDirection.lower : MeetingActionDirection.raise
        let dispatch = shell.toggleHand()
        if dispatch != MeetingDispatch.dispatched {
            handIntent = previous
            recompute()
        }
        return result(dispatch, kind: CallControlKind.hand)
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
        menuHeightReadout = "none"
        handIntent = MeetingActionDirection.none
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
        var candidate = ControlBarPolicy.bar(inputs: inputs, layout: layout, revision: bar.revision)
        // CHT-8 (HD request B6-T5 R4): a moved Chat with unread messages puts the dot on More (`setOverflow` recomputes).
        if ControlBarPolicy.chatMovedWithUnread(inputs: inputs, overflowIds: overflowIds) {
            candidate = ControlBarPolicy.withMoreDot(candidate)
        }
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
        // CTL-6, CTL-5: each snapshot publishes only on a change, so a reaction never touches `bar` or `more` and More's
        // metrics change only with the row structure (S30 5 k, 6 k).
        let reactionsCandidate = ReactionPalettePolicy.snapshot(inputs: inputs, artShipped: ReactionPalettePolicy.artShipped,
                                                                revision: reactions.revision)
        if reactionsCandidate != reactions {
            reactions = reactionsCandidate.withRevision(reactions.revision + 1)
        }
        let composition = layout.composition
        if !(inputs.row(MeetingControlID.hand)?.isPending ?? false) {
            handIntent = MeetingActionDirection.none
        }
        let moreCandidate = MoreMenuPolicy.snapshot(inputs: inputs, composition: composition, overflowIds: overflowIds,
                                                    reactions: reactions, revision: more.revision, handIntent: handIntent)
        if moreCandidate != more {
            more = moreCandidate.withRevision(more.revision + 1)
        }
        let metricsCandidate = MoreMenuPolicy.metrics(more)
        if metricsCandidate != moreMetrics {
            moreMetrics = metricsCandidate
        }
        let commandsCandidate = MoreMenuPolicy.commands(inputs: inputs, composition: composition,
                                                        lock: more.item(MoreItemID.lockMeeting), revision: commands.revision)
        if commandsCandidate != commands {
            commands = commandsCandidate.withRevision(commands.revision + 1)
        }
        followEndResult()
    }

    /// Hands a local request to the core (S30 0.5): `dispatched` when it accepted, `ignored` without a core.
    private func submit(_ next: CallControlsRequest) -> ControlTapResult {
        guard let handler = onRequest else { return ControlTapResult.ignored }
        return handler(next) ? ControlTapResult.dispatched : ControlTapResult.ignored
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
