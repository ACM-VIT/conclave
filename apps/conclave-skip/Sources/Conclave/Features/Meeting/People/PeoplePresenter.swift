import Foundation
import Observation

/// S50 0.5: the session-owned People presenter, created with the S1 `MeetingShellPresenter` and the S20
/// `StagePresenter` and reset with them (S1C 3.2, 3.3 TEAR). The core pushes `PeopleInputs` through `apply(_:)` on its
/// own refresh path (PH1); the presenter never observes the core (SkipModel has no `withObservationTracking`). Views
/// read only this presenter: the container observes `snapshot` (structure), each row its own `PersonRowEntry` or
/// `WaitingRowEntry`, the speaking glyph the S20 `TileSpeakingStore` leaf, and the count leaves `attendeeCount` and
/// `qaUnseen`. A speaker change publishes nothing here (the presenter has no speaker hook).
///
/// PPL-1 scope: rows, sections, search inputs, the Host Controls row value, the panel lifecycle and the destination
/// scroll. PPL-2 adds the action half: `PersonRowModel.actions` from `PeopleActionPolicy` (PL7), `perform`, the one
/// `HostActionLedger` (PH2), `onCommand` and `finish`, confirmations (row-anchored for the row sources, S50 3 j),
/// `lastFailure` placed by origin (PL14, RECONCILE R2), the host outcome tokens in `feedbackState` and the rename flow
/// (Q14, RECONCILE R38). PPL-4 adds `host` (`HostControlsPresenter`), which dispatches through `dispatch(...)`.
/// Extension points: PPL-3 the waiting and hand actions; PPL-5 the webinar sections and `webinarQueueKnown`; PPL-6
/// `qa` and `qaUnseen`; PPL-7 the full role-change table and `stageInvitation`.
@MainActor
@Observable
final class PeoplePresenter {
    private(set) var snapshot: PeopleSnapshot = PeopleSnapshot.empty
    /// Own stored property: only the Attendees count row reads it (S50 1 k).
    private(set) var attendeeCount: Int = 0
    /// Own stored property: only the Q&A row value reads it (PH7 feeds it with PPL-6).
    private(set) var qaUnseen: Int = 0
    /// The destination scroll target (S20 SR7); cleared by `focusRequestHandled(id:)`.
    private(set) var focusRequest: PeopleFocusRequest? = nil
    /// Read only by the confirmation hosts of S50 3 j (each filters by source or kind); row sources also set the target
    /// row's `PersonRowEntry.confirmation`.
    private(set) var confirmation: PeopleConfirmation? = nil
    /// The panel failure (PL14 `panelInline` or `panelSnackbar`); stage placement goes to `stage.postLocal` instead.
    private(set) var lastFailure: HostActionFailureModel? = nil
    /// Host outcome tokens (S50 0.5 token table; delivery is record-only until the S50 publisher joins the root).
    private(set) var feedbackState = MeetingShellFeedbackState(session: 0, token: FeedbackToken.baseline)
    /// The Change Name dialog (S50 3 c, 3 d).
    private(set) var rename: PeopleRenameState = PeopleRenameState.idle

    @ObservationIgnored let rows = PersonRowStore()
    @ObservationIgnored let waiting = WaitingRowStore()
    @ObservationIgnored let shell: MeetingShellPresenter
    /// The speaking leaf reads `stage.speaking` (S20 SL4); PPL-2 forwards Pin to `stage.togglePin(userId:)`.
    @ObservationIgnored let stage: StagePresenter
    /// Debug readout `people.recompose.<rowId>` (PL12); nil in production.
    @ObservationIgnored var recompose: PeopleRecomposeLedger? = nil
    /// The search text a panel opens with: always empty in production; the people-search-none fixture seeds "zz"
    /// (PL12). Read once when the panel mounts; the query itself stays view state (PL8).
    @ObservationIgnored var initialSearchQuery = ""
    /// S50 PPL-4: Host Controls, a child that dispatches through this presenter (one ledger, one failure path).
    @ObservationIgnored let host = HostControlsPresenter()
    /// PH2: set once by the view model (`performPeopleCommand`); PL12 fixtures install a scripted one.
    @ObservationIgnored var onCommand: ((PeopleCommand, HostActionTicket) -> Void)? = nil
    /// The platform the panel runs on (`NoticePlatform` value) for PL14; the panel reports it, else the stage's.
    @ObservationIgnored var platform = ""

    @ObservationIgnored private(set) var inputs = PeopleInputs.make()
    /// Diagnostics for readouts and tests (never observed).
    @ObservationIgnored private(set) var applyCount = 0
    @ObservationIgnored private(set) var rowWriteCount = 0
    @ObservationIgnored private(set) var coverage = PanelStageCoverage.none
    @ObservationIgnored private(set) var isOnHostPage = false
    @ObservationIgnored private(set) var openPresentationID = 0
    @ObservationIgnored private(set) var openDestination = PanelDestination.none
    /// The root Host Controls presentation, 0 when closed.
    @ObservationIgnored private(set) var hostPresentationID = 0
    /// `people.focus` (PL12): destinations requested this presentation and the scrolls the views performed.
    @ObservationIgnored private(set) var focusDestinations: [String] = []
    @ObservationIgnored private(set) var focusScrollCount = 0

    /// `people.counters` (PL12): perform by action id, confirm, cancel, retry and command kinds, newest last.
    @ObservationIgnored private(set) var counterLog: [String] = []

    @ObservationIgnored private var nextFocusId = 0
    @ObservationIgnored private var lastDestinationSequence = -1
    @ObservationIgnored private var showsLostHost = false
    @ObservationIgnored private let ledger = HostActionLedger()
    @ObservationIgnored private var nextConfirmationId = 0
    @ObservationIgnored private var nextFailureId = 0
    @ObservationIgnored private var nextRenameId = 0
    /// Failures Retry can re-dispatch (panel and stage), bounded.
    @ObservationIgnored private var retryable: [Int: HostLedgerEntry] = [:]
    @ObservationIgnored private var retryOrder: [Int] = []
    /// Q14 fallback when no core flag arrives (fixtures): a renameDisabled refusal seen by this presenter.
    @ObservationIgnored private var renameDisabledLocally = false

    init(shell: MeetingShellPresenter, stage: StagePresenter) {
        self.shell = shell
        self.stage = stage
        host.parent = self
        // RECONCILE R19: the tile menu reads this presenter's action table for the person under the finger.
        stage.people = self
    }

    /// The S20 speaking store the row leaves read.
    var speaking: TileSpeakingStore { stage.speaking }

    // MARK: Core hooks

    /// Core only (PH1): the whole input set, equality guarded per published property and per row.
    func apply(_ next: PeopleInputs) {
        applyCount += 1
        // A new call session starts clean (S1C SES): rows, focus and the lost-host notice never carry over.
        if inputs.callSession != 0 && next.callSession != inputs.callSession {
            reset()
        } else if inputs.attempt != 0 && next.attempt != inputs.attempt {
            // PH2: an attempt change interrupts pending host actions with no feedback; late completions then drop.
            interruptPending()
        }
        let previousViewer = snapshot.viewerRole
        inputs = next
        rebuild(previousViewer: previousViewer)
    }

    /// Core only: the S1 panel snapshot changed. When the presentation this presenter opened is no longer current the
    /// panel has closed (S50 1 c: `panelDidClose` comes from the coordinator's dismissal, never a root view's
    /// disappearance, so an iPad sheet-to-inspector move never closes it).
    func panelSnapshotChanged() {
        if hostPresentationID != 0 {
            let shown = shell.panels.snapshot.current
            if shown == nil || shown?.presentationID != hostPresentationID || shown?.panel != MeetingPanel.hostControls {
                hostPresentationID = 0
                if openPresentationID == 0 {
                    if lastFailure != nil { lastFailure = nil }
                    if let open = confirmation, open.source == PeopleActionSource.hostControls { clearConfirmation() }
                }
            }
        }
        guard openPresentationID != 0 else { return }
        let current = shell.panels.snapshot.current
        if current == nil || current?.presentationID != openPresentationID || current?.panel != MeetingPanel.participants {
            panelDidClose(presentationID: openPresentationID)
        }
    }

    // MARK: Presentation lifecycle (the panel host)

    /// From the presentation lifecycle only (S50 1 c `.task(id: presentationID)`, 1 d `onMounted`): publishes the
    /// destination's scroll target once. A repeat for the same presentation (a host migration) does nothing, so the
    /// list never scrolls twice.
    func panelDidOpen(destination: PanelDestination, presentationID: Int) {
        if presentationID == 0 || presentationID == openPresentationID { return }
        openPresentationID = presentationID
        openDestination = destination
        focusDestinations = []
        focusScrollCount = 0
        if showsLostHost {
            showsLostHost = false
            rebuild(previousViewer: snapshot.viewerRole)
        }
        publishFocus(destination)
    }

    /// Clears the lost-host notice, coverage, any unhandled focus, the panel's inline failure and its confirmations
    /// (PL14: inline failures clear on panel close and are never re-posted to the stage).
    func panelDidClose(presentationID: Int) {
        if presentationID == 0 || presentationID != openPresentationID { return }
        openPresentationID = 0
        openDestination = PanelDestination.none
        coverage = PanelStageCoverage.none
        isOnHostPage = false
        if focusRequest != nil { focusRequest = nil }
        if lastFailure != nil { lastFailure = nil }
        if let current = confirmation, current.source != PeopleActionSource.tileMenu { clearConfirmation() }
        if rename.isPresented && rename.phase != PeopleRenamePhase.pending { rename = PeopleRenameState.idle }
        if showsLostHost {
            showsLostHost = false
            rebuild(previousViewer: snapshot.viewerRole)
        }
    }

    /// A same-panel destination while Participants is open (S20 SR7, PNL-1 `destinationRequest`), for example the
    /// knock banner's View: the shown list scrolls to the section without a new presentation.
    func destinationRequested(_ request: PanelDestinationRequest) {
        guard openPresentationID != 0, request.panel == MeetingPanel.participants,
              request.presentationID == openPresentationID, request.session == shell.panels.snapshot.session,
              request.sequence != lastDestinationSequence else { return }
        lastDestinationSequence = request.sequence
        openDestination = request.destination
        publishFocus(request.destination)
    }

    /// The view scrolled (or found nothing to scroll to); a pop back from a pushed page finds `nil` and stays put.
    func focusRequestHandled(id: Int) {
        guard let request = focusRequest, request.id == id else { return }
        focusRequest = nil
        focusScrollCount += 1
    }

    /// The panel host reports the same coverage PS 6.2 reports to the stage (sheet medium partial, large full,
    /// inspector none, Android overlay full, side pane none) and whether a host page is on top; PPL-2's failure
    /// placement reads it (PL14 by origin, RECONCILE R2).
    func presentationDidChange(coverage: PanelStageCoverage, onHostPage: Bool) {
        self.coverage = coverage
        isOnHostPage = onHostPage
    }

    /// Questions and Answers replaces the panel (S50 1 a, 11); the row shows only while `snapshot.qaVisible`.
    func openQuestionsAndAnswers() {
        shell.panels.present(MeetingPanel.webinarQA, from: PanelInvoker.call)
    }

    /// With the S1 reset (S1C 3.3 TEAR): stores, focus and the open presentation clear; revisions keep growing so a
    /// view never mistakes a reset for "unchanged".
    func reset() {
        ledger.interruptAll()
        clearConfirmation()
        rows.removeAll()
        waiting.removeAll()
        inputs = PeopleInputs.make()
        retryable = [:]
        retryOrder = []
        renameDisabledLocally = false
        if lastFailure != nil { lastFailure = nil }
        if rename != PeopleRenameState.idle { rename = PeopleRenameState.idle }
        host.reset()
        openPresentationID = 0
        hostPresentationID = 0
        openDestination = PanelDestination.none
        coverage = PanelStageCoverage.none
        isOnHostPage = false
        focusDestinations = []
        focusScrollCount = 0
        lastDestinationSequence = -1
        showsLostHost = false
        if focusRequest != nil { focusRequest = nil }
        if snapshot.withRevision(0) != PeopleSnapshot.empty {
            snapshot = PeopleSnapshot.empty.withRevision(snapshot.revision + 1)
        }
        if attendeeCount != 0 { attendeeCount = 0 }
        if qaUnseen != 0 { qaUnseen = 0 }
    }

    // MARK: Actions (S50 3, PPL-2)

    /// True while Participants or the root Host Controls panel is open (Host Controls announcements, S50 6 f).
    var isPanelOpen: Bool { openPresentationID != 0 || hostPresentationID != 0 }

    /// The root Host Controls panel (`MeetingPanel.hostControls`) opened; its inline failures and confirmations clear
    /// when the coordinator dismisses it (PL14), like Participants'.
    func hostPanelDidOpen(presentationID: Int) {
        if presentationID == 0 { return }
        hostPresentationID = presentationID
    }

    /// The ledger's pending keys, for the host child's pending rows (PH2).
    func pendingKeys() -> [String] {
        ledger.pendingKeys()
    }

    /// One row action from any surface (row menu, swipe, accessibility, the S20 tile menu). `rowId` is a store key.
    /// Pin, Send Private Message, Hide or Show Messages and Lower Hand are local (no ticket): they go to the stage, the
    /// chat presenter and S1. Confirming actions open their confirmation; the rest take a ticket and emit one command.
    /// Returns `.ignored` synchronously for a missing row, an unavailable item or a duplicate.
    @discardableResult
    func perform(_ action: PersonActionID, rowId: String, source: String) -> ControlTapResult {
        guard rows.contains(rowId) else { return ControlTapResult.ignored }
        let model = rows.entry(for: rowId).model
        var item: PersonActionModel? = nil
        for candidate in model.actions {
            if candidate.action == action { item = candidate }
        }
        guard let available = item, available.isEnabled else { return ControlTapResult.ignored }
        record("perform:" + action.rawValue)
        switch action {
        case .pin:
            stage.togglePin(userId: model.serverId)
            return ControlTapResult.dispatched
        case .unpin:
            stage.clearPin()
            return ControlTapResult.dispatched
        case .sendPrivateMessage:
            stage.openChat(privateTo: model.serverId)
            return ControlTapResult.dispatched
        case .hideMessages:
            shell.chat.hideSender(userId: model.serverId)
            rebuild(previousViewer: snapshot.viewerRole)
            return ControlTapResult.dispatched
        case .showMessages:
            shell.chat.showSender(userId: model.serverId)
            rebuild(previousViewer: snapshot.viewerRole)
            return ControlTapResult.dispatched
        case .lowerOwnHand:
            _ = shell.toggleHand()
            return ControlTapResult.dispatched
        case .changeName:
            beginRename()
            return ControlTapResult.dispatched
        default:
            break
        }
        if let kind = PeopleActionPolicy.confirmationKind(action) {
            let person = inputs.participant(model.serverId)
            let userKey = person?.userKey ?? ""
            nextConfirmationId += 1
            present(PeopleConfirmation(id: nextConfirmationId, kind: kind, targetId: rowId, targetName: displayName(model),
                                       count: 0, source: source,
                                       canBlock: kind == PeopleConfirmationKind.remove && !userKey.isEmpty,
                                       isGuest: PeopleActionPolicy.isGuestUserId(model.serverId), isConfirmEnabled: true,
                                       reason: PeopleActionReason.none))
            return ControlTapResult.dispatched
        }
        guard let kind = PeopleActionPolicy.commandKind(action) else { return ControlTapResult.ignored }
        return dispatch(PeopleCommand.make(kind, targetId: model.serverId), key: PeopleActionPolicy.ledgerKey(kind, target: rowId),
                        source: source, sourceKey: rowId, targetName: displayName(model))
    }

    /// PPL-3 header action (S50 4): Admit All never confirms.
    @discardableResult
    func admitAll() -> ControlTapResult {
        guard snapshot.canUseHostActions, snapshot.section(PeopleSectionID.waiting) != nil else { return ControlTapResult.ignored }
        return dispatch(PeopleCommand.make(PeopleCommandKind.admitAll), key: "admitAll:" + PeopleSectionID.waiting.rawValue,
                        source: PeopleActionSource.sectionHeader, sourceKey: PeopleSectionID.waiting.rawValue, targetName: "")
    }

    /// PPL-3 header action (S50 4): Deny All confirms from the Waiting header.
    func requestDenyAll() {
        guard snapshot.canUseHostActions, let section = snapshot.section(PeopleSectionID.waiting) else { return }
        nextConfirmationId += 1
        present(PeopleConfirmation(id: nextConfirmationId, kind: PeopleConfirmationKind.denyAll,
                                   targetId: PeopleSectionID.waiting.rawValue, targetName: "", count: section.count,
                                   source: PeopleActionSource.sectionHeader, canBlock: false, isGuest: false,
                                   isConfirmEnabled: true, reason: PeopleActionReason.none))
    }

    /// The In This Meeting header's Mute All (S50 1 c): the same confirmation as Host Controls, from the header.
    func requestMuteAll() {
        guard snapshot.canUseHostActions else { return }
        nextConfirmationId += 1
        present(PeopleConfirmation(id: nextConfirmationId, kind: PeopleConfirmationKind.muteAll,
                                   targetId: HostBulkID.muteAll.rawValue, targetName: "", count: 0,
                                   source: PeopleActionSource.sectionHeader, canBlock: false, isGuest: false,
                                   isConfirmEnabled: true, reason: PeopleActionReason.none))
    }

    /// Host Controls confirmations (bulk, Remove Code, Block, Rotate Link, Remove Attendee Code; source `hostControls`).
    func presentHostConfirmation(kind: PeopleConfirmationKind, targetId: String, targetName: String) {
        nextConfirmationId += 1
        present(PeopleConfirmation(id: nextConfirmationId, kind: kind, targetId: targetId, targetName: targetName, count: 0,
                                   source: PeopleActionSource.hostControls, canBlock: false, isGuest: false,
                                   isConfirmEnabled: true, reason: PeopleActionReason.none))
    }

    /// Accepts only the current confirmation id, once. `block` is the iOS "Remove and Block" button or the Android
    /// "Also block" checkbox; the block alone removes present sessions (the server kicks them, S50 3 l5).
    func confirm(id: Int, block: Bool) {
        guard let current = confirmation, current.id == id, current.isConfirmEnabled else { return }
        clearConfirmation()
        record("confirm:" + current.kind.rawValue + (block ? ":block" : ""))
        switch current.kind {
        case .remove, .makeCoHost, .makeHost, .moveToAudience:
            guard rows.contains(current.targetId) else { return }
            let model = rows.entry(for: current.targetId).model
            var kind = PeopleCommandKind.remove
            var text = ""
            if current.kind == PeopleConfirmationKind.remove && block && current.canBlock {
                kind = PeopleCommandKind.block
                text = inputs.participant(model.serverId)?.userKey ?? ""
            } else if current.kind == PeopleConfirmationKind.makeCoHost {
                kind = PeopleCommandKind.makeCoHost
            } else if current.kind == PeopleConfirmationKind.makeHost {
                kind = PeopleCommandKind.makeHost
            } else if current.kind == PeopleConfirmationKind.moveToAudience {
                kind = PeopleCommandKind.moveToAudience
            }
            dispatch(PeopleCommand.make(kind, targetId: model.serverId, text: text),
                     key: PeopleActionPolicy.ledgerKey(kind, target: current.targetId), source: current.source,
                     sourceKey: current.targetId, targetName: current.targetName)
        case .denyAll:
            dispatch(PeopleCommand.make(PeopleCommandKind.denyAll), key: "denyAll:" + PeopleSectionID.waiting.rawValue,
                     source: current.source, sourceKey: PeopleSectionID.waiting.rawValue, targetName: "")
        case .muteAll, .camerasOff, .stopAllShares:
            if let bulk = HostControlsPolicy.bulk(for: current.kind) { host.dispatchBulk(bulk) }
        case .clearInviteCode:
            host.dispatchClearMeetingInviteCode()
        case .block:
            host.dispatchBlock(current.targetId)
        case .rotateWebinarLink:
            host.dispatchRotateLink()
        case .clearAttendeeCode:
            host.dispatchClearAttendeeCode()
        }
    }

    func cancelConfirmation(id: Int) {
        guard let current = confirmation, current.id == id else { return }
        record("cancel:" + current.kind.rawValue)
        clearConfirmation()
    }

    /// Re-dispatches the failed command (same key, source and slot) with a new ticket.
    func retry(failureId: Int) {
        guard let entry = retryable[failureId] else { return }
        record("retry:" + entry.command.kind.rawValue)
        retryable[failureId] = nil
        if let failure = lastFailure, failure.id == failureId { lastFailure = nil }
        host.willRetry(entry)
        dispatch(entry.command, key: entry.ticket.key, source: entry.source, sourceKey: entry.sourceKey,
                 targetName: entry.targetName)
    }

    func dismissFailure(id: Int) {
        if let failure = lastFailure, failure.id == id { lastFailure = nil }
    }

    // MARK: Rename (S50 3 c, 3 d; RECONCILE R38)

    /// "Change Name..." opens the dialog with your current name.
    func beginRename() {
        nextRenameId += 1
        rename = PeopleRenameState(id: nextRenameId, phase: PeopleRenamePhase.editing, draft: localDisplayName(), refusal: "")
    }

    /// Save: one rename intent through the core's single flight (S60 C6-10); the dialog keeps the draft until the
    /// acknowledgement (Android shows the spinner; iOS re-presents on a refusal).
    @discardableResult
    func submitRename(_ name: String) -> ControlTapResult {
        let normalized = DisplayNamePolicy.normalized(DisplayNamePolicy.capped(name))
        if normalized.isEmpty { return ControlTapResult.ignored }
        if normalized == DisplayNamePolicy.normalized(localDisplayName()) {
            rename = PeopleRenameState.idle
            return ControlTapResult.ignored
        }
        let key = PeopleActionPolicy.ledgerKey(PeopleCommandKind.changeName, target: PeopleActionPolicy.selfTarget)
        rename = PeopleRenameState(id: rename.id, phase: PeopleRenamePhase.pending, draft: name, refusal: "")
        let result = dispatch(PeopleCommand.make(PeopleCommandKind.changeName, text: normalized), key: key,
                              source: PeopleActionSource.rowMenu, sourceKey: inputs.localUserId, targetName: "")
        if result != ControlTapResult.dispatched {
            rename = PeopleRenameState(id: rename.id, phase: PeopleRenamePhase.editing, draft: name, refusal: "")
        }
        return result
    }

    func cancelRename() {
        if rename.phase == PeopleRenamePhase.pending { return }
        if rename != PeopleRenameState.idle { rename = PeopleRenameState.idle }
    }

    // MARK: Command seam (PH2)

    /// Core only: the result of one ticket. False for a late, stale or unknown ticket (interrupted, reset, finished).
    @discardableResult
    func finish(_ ticket: HostActionTicket, _ result: HostActionResult) -> Bool {
        guard ticket.session == inputs.callSession, let entry = ledger.finish(ticket) else { return false }
        record("finish:" + entry.command.kind.rawValue + ":" + result.kind.rawValue)
        let isRename = entry.command.kind == PeopleCommandKind.changeName
        switch result.kind {
        case .completed:
            if isRename { rename = PeopleRenameState.idle }
            succeeded(entry)
        case .failed:
            if isRename {
                let failure = result.typedFailure ?? HostActionFailure.unknown
                if failure == HostActionFailure.renameDisabled { renameDisabledLocally = true }
                nextRenameId += 1
                rename = PeopleRenameState(id: nextRenameId, phase: PeopleRenamePhase.refused, draft: rename.draft,
                                           refusal: failure.rawValue)
            } else {
                failed(entry, failure: result.failure)
            }
        case .interrupted, .cancelled:
            if isRename && rename.phase == PeopleRenamePhase.pending { rename = PeopleRenameState.idle }
        }
        host.actionFinished(entry, result: result)
        rebuild(previousViewer: snapshot.viewerRole)
        return true
    }

    /// Takes a ticket for `key` and emits one command. Pending shows in the same frame (rows and host switches read
    /// the ledger); a duplicate key returns `.ignored` with no command. Used by `perform`, the host child and Retry.
    @discardableResult
    func dispatch(_ command: PeopleCommand, key: String, source: String, sourceKey: String, targetName: String) -> ControlTapResult {
        guard let ticket = ledger.begin(key: key, command: command, source: source, sourceKey: sourceKey, targetName: targetName,
                                        session: inputs.callSession, attempt: inputs.attempt) else {
            return ControlTapResult.ignored
        }
        if let failure = lastFailure, failure.sourceKey == sourceKey { lastFailure = nil }
        record("command:" + command.kind.rawValue)
        rebuild(previousViewer: snapshot.viewerRole)
        host.rebuild()
        onCommand?(command, ticket)
        return ControlTapResult.dispatched
    }

    private func succeeded(_ entry: HostLedgerEntry) {
        let name = entry.targetName
        switch entry.command.kind {
        case .admit:
            publishFeedback(FeedbackKind.hostAdmitted)
        case .admitAll:
            publishFeedback(FeedbackKind.hostAdmittedAll)
        case .deny, .denyAll:
            publishFeedback(FeedbackKind.hostDenied)
        case .remove, .block:
            publishFeedback(FeedbackKind.hostRemoved)
            stage.announce(kind: PeopleAnnouncementKind.removed, name: name)
        case .makeCoHost:
            publishFeedback(FeedbackKind.hostMadeHost)
            stage.announce(kind: PeopleAnnouncementKind.madeCoHost, name: name)
        case .makeHost:
            publishFeedback(FeedbackKind.hostMadeHost)
            stage.announce(kind: PeopleAnnouncementKind.madeHost, name: name)
        case .bulk:
            publishFeedback(FeedbackKind.hostBulkApplied)
        case .setPolicy:
            publishFeedback(FeedbackKind.hostPolicyChanged)
        case .bringOnStage:
            publishFeedback(FeedbackKind.hostInvitedToStage)
        case .moveToAudience:
            publishFeedback(FeedbackKind.hostMovedToAudience)
        case .sendNotice:
            stage.announce(kind: PeopleAnnouncementKind.noticeSent, name: "")
        default:
            break
        }
    }

    private func failed(_ entry: HostLedgerEntry, failure: String) {
        // Lost host while it was in flight: the action finishes silently (S50 6 f, 12; PH2).
        if !snapshot.isHostViewer && entry.command.kind != PeopleCommandKind.changeName { return }
        publishFeedback(FeedbackKind.hostActionFailed)
        nextFailureId += 1
        let placement = PeopleFailurePlacementPolicy.placement(origin: PeopleActionSource.origin(entry.source),
                                                               platform: currentPlatform())
        let model = HostActionFailureModel(id: nextFailureId, actionKey: entry.ticket.key, sourceKey: entry.sourceKey,
                                           action: entry.command.kind.rawValue,
                                           failure: failure.isEmpty ? HostActionFailure.unknown.rawValue : failure,
                                           targetName: entry.targetName, placement: placement.rawValue)
        rememberRetry(model.id, entry)
        if placement == HostFailurePlacement.stage {
            stage.postLocal(PeopleFailurePlacementPolicy.stageNotice(model, userId: entry.command.targetId))
        } else {
            lastFailure = model
        }
    }

    private func rememberRetry(_ id: Int, _ entry: HostLedgerEntry) {
        retryable[id] = entry
        retryOrder.append(id)
        while retryOrder.count > 8 {
            let oldest = retryOrder.removeFirst()
            retryable[oldest] = nil
        }
    }

    private func interruptPending() {
        ledger.interruptAll()
        if rename.phase == PeopleRenamePhase.pending { rename = PeopleRenameState.idle }
        host.rebuild()
    }

    private func present(_ next: PeopleConfirmation) {
        clearConfirmation()
        confirmation = next
        if PeopleActionSource.isRowSource(next.source) && rows.contains(next.targetId) {
            rows.entry(for: next.targetId).setConfirmation(next)
        }
    }

    private func clearConfirmation() {
        guard let current = confirmation else { return }
        if PeopleActionSource.isRowSource(current.source) && rows.contains(current.targetId) {
            rows.entry(for: current.targetId).setConfirmation(nil)
        }
        confirmation = nil
    }

    /// S50 3 f: a person dialog closes when its target leaves or its action no longer applies (the target became a
    /// host while Make Co-Host was open); host role loss closes every host dialog (PPL-7 completes the PL13 table).
    private func validateConfirmation(rowKeys: [String]) {
        guard let current = confirmation else { return }
        var keep = true
        switch current.kind {
        case .remove, .makeCoHost, .makeHost, .moveToAudience:
            if !rowKeys.contains(current.targetId) {
                keep = false
            } else if let action = personAction(for: current.kind) {
                var present = false
                for item in rows.entry(for: current.targetId).model.actions {
                    if item.action == action { present = true }
                }
                keep = present
            }
        default:
            keep = PeopleOrderPolicy.viewerRole(inputs).isHostRole
        }
        if !keep { clearConfirmation() }
    }

    private func personAction(for kind: PeopleConfirmationKind) -> PersonActionID? {
        switch kind {
        case .remove: return PersonActionID.remove
        case .makeCoHost: return PersonActionID.makeCoHost
        case .makeHost: return PersonActionID.makeHost
        case .moveToAudience: return PersonActionID.moveToAudience
        default: return nil
        }
    }

    private func publishFeedback(_ kind: FeedbackKind) {
        feedbackState = MeetingShellFeedbackState(session: inputs.callSession,
                                                  token: FeedbackToken(sequence: feedbackState.token.sequence + 1, kind: kind))
    }

    private func record(_ entry: String) {
        counterLog.append(entry)
        if counterLog.count > 40 { counterLog.removeFirst() }
    }

    private func currentPlatform() -> String {
        platform.isEmpty ? stage.notices.platform : platform
    }

    private func displayName(_ model: PersonRowModel) -> String {
        model.name
    }

    private func localDisplayName() -> String {
        inputs.participant(inputs.localUserId)?.displayName ?? ""
    }

    /// Your display name as People shows it (the notice preview names the sender, S50 8 b).
    func localName() -> String {
        localDisplayName()
    }

    // MARK: Readouts (Debug fixture and tests)

    /// `people.revision`.
    func revisionReadout() -> String {
        "rev=" + String(snapshot.revision) + " sections=" + sectionSummary()
    }

    /// `people.focus`: the destinations requested this presentation and the scrolls performed.
    func focusReadout() -> String {
        let destinations = focusDestinations.isEmpty ? "none" : focusDestinations.joined(separator: ",")
        return "destination=" + destinations + " scrolls=" + String(focusScrollCount)
    }

    /// `people.counters` (PL12): the last actions, confirmations, retries and commands, newest last.
    func countersReadout() -> String {
        if counterLog.isEmpty { return "none" }
        var recent: [String] = []
        let start = counterLog.count > 8 ? counterLog.count - 8 : 0
        var index = start
        while index < counterLog.count {
            recent.append(counterLog[index])
            index += 1
        }
        return recent.joined(separator: " ")
    }

    /// Section ids with counts in display order, for example `raisedHands:1,inMeeting:6`.
    func sectionSummary() -> String {
        var parts: [String] = []
        for section in snapshot.sections {
            parts.append(section.id + ":" + String(section.count))
        }
        return parts.isEmpty ? "none" : parts.joined(separator: ",")
    }

    // MARK: Rebuild

    private func publishFocus(_ destination: PanelDestination) {
        var sectionId = ""
        if destination == PanelDestination.peopleWaiting {
            sectionId = PeopleSectionID.waiting.rawValue
        } else if destination == PanelDestination.peopleRaisedHands {
            sectionId = PeopleSectionID.raisedHands.rawValue
        }
        if sectionId.isEmpty { return }
        focusDestinations.append(destination.rawValue)
        nextFocusId += 1
        focusRequest = PeopleFocusRequest(id: nextFocusId, sectionId: sectionId)
    }

    private func rebuild(previousViewer: PersonRole) {
        let ordered = PeopleOrderPolicy.order(inputs)
        let viewer = ordered.viewerRole
        // Lost host while the panel is open (S50 1 f, 12): host rows and sections leave in place and the notice stays
        // until the panel closes; regaining the role clears it. Becoming an attendee dismisses the panel (S1 ROLE).
        if openPresentationID != 0 && previousViewer.isHostRole && viewer == PersonRole.participant {
            showsLostHost = true
        }
        if viewer.isHostRole {
            showsLostHost = false
        }
        let blocked = PeopleRowPolicy.blockedReason(phase: inputs.phase, isNetworkOffline: inputs.isNetworkOffline)

        var handPosition: [String: Int] = [:]
        var position = 0
        for person in ordered.raisedHands {
            position += 1
            handPosition[person.userId] = position
        }

        // PL7: the action table reads the viewer, the S1 blocked reason, DMs, webinar, the pin and the rename flag.
        let context = PeopleActionContext.make(
            viewerRole: viewer,
            isPrimaryHostViewer: viewer == PersonRole.host,
            blockedReason: blocked.rawValue,
            isDmEnabled: inputs.isDmEnabled,
            isWebinarEnabled: inputs.isWebinarEnabled,
            supportsMoveToAudience: inputs.supportsMoveToAudience,
            isRenameDisabled: inputs.isRenameDisabled || renameDisabledLocally,
            isRenamePending: rename.phase == PeopleRenamePhase.pending,
            pinnedUserId: inputs.pinnedUserId
        )
        let renameKey = PeopleActionPolicy.ledgerKey(PeopleCommandKind.changeName, target: PeopleActionPolicy.selfTarget)
        var rowKeys: [String] = []
        var meetingKeys: [String] = []
        var meetingSearch: [String] = []
        var meetingNames: [String] = []
        var namesById: [String: String] = [:]
        var hasActiveShare = false
        for raw in ordered.inMeeting {
            // S40 CH21: the chat presenter is the source of truth for hidden senders.
            let person = raw.withMessagesHidden(raw.messagesHidden || shell.chat.isSenderHidden(raw.userId))
            if person.isScreenSharing { hasActiveShare = true }
            let role = PeopleOrderPolicy.role(person, inputs: inputs)
            let key = PeopleOrderPolicy.rosterKey(person.userId)
            var pending = PeopleActionPolicy.rowPendingAction(ledger.pendingAction(forRow: key))
            if person.isLocal && pending.isEmpty && ledger.isPending(renameKey) {
                pending = PersonActionID.changeName.rawValue
            }
            let actions = PeopleActionPolicy.actions(person, role: role, context: context, pendingAction: pending)
            let model = PeopleRowPolicy.rowModel(person, role: role, handOrder: handPosition[person.userId] ?? 0,
                                                 actions: actions, pendingAction: pending)
            if rows.write(model) { rowWriteCount += 1 }
            rowKeys.append(model.id)
            meetingKeys.append(model.id)
            meetingSearch.append(model.name.lowercased())
            meetingNames.append(model.name)
            namesById[person.userId] = model.name
        }
        validateConfirmation(rowKeys: rowKeys)
        rows.prune(keeping: rowKeys)
        host.peopleChanged(isHostViewer: viewer.isHostRole, blockedReason: blocked.rawValue, hasActiveShare: hasActiveShare,
                           anyHandRaised: !ordered.raisedHands.isEmpty)

        var handKeys: [String] = []
        var handSearch: [String] = []
        var handNames: [String] = []
        for person in ordered.raisedHands {
            let name = namesById[person.userId] ?? ""
            handKeys.append(PeopleOrderPolicy.rosterKey(person.userId))
            handSearch.append(name.lowercased())
            handNames.append(name)
        }

        var waitingKeys: [String] = []
        var waitingSearch: [String] = []
        var waitingNames: [String] = []
        let waitingEnabled = blocked == MeetingBlockedReason.none
        for request in ordered.waiting {
            let model = PeopleRowPolicy.waitingModel(request, isEnabled: waitingEnabled, reason: blocked.rawValue)
            waiting.write(model)
            waitingKeys.append(model.id)
            waitingSearch.append(model.name.lowercased())
            waitingNames.append(model.name)
        }
        waiting.prune(keeping: waitingKeys)

        var sections: [PeopleSection] = []
        if !waitingKeys.isEmpty {
            sections.append(PeopleSection(id: PeopleSectionID.waiting.rawValue, count: waitingKeys.count, rowIds: waitingKeys,
                                          searchKeys: waitingSearch, names: waitingNames))
        }
        if !handKeys.isEmpty {
            sections.append(PeopleSection(id: PeopleSectionID.raisedHands.rawValue, count: handKeys.count, rowIds: handKeys,
                                          searchKeys: handSearch, names: handNames))
        }
        sections.append(PeopleSection(id: PeopleSectionID.inMeeting.rawValue, count: meetingKeys.count, rowIds: meetingKeys,
                                      searchKeys: meetingSearch, names: meetingNames))

        let candidate = PeopleSnapshot(
            revision: snapshot.revision,
            sections: sections,
            isRosterLoaded: inputs.isRosterLoaded,
            viewerRole: viewer,
            isPrimaryHost: viewer == PersonRole.host,
            canUseHostActions: viewer.isHostRole && blocked == MeetingBlockedReason.none,
            blockedReason: blocked.rawValue,
            inviteLink: inputs.meetingLink,
            roomLabel: inputs.roomLabel,
            webinarEnabled: inputs.isWebinarEnabled,
            webinarLink: inputs.webinarLink,
            webinarPublic: inputs.isWebinarPublic,
            accessSummary: PeopleRowPolicy.accessSummary(isRoomLocked: inputs.isRoomLocked, isNoGuests: inputs.isNoGuests).rawValue,
            qaVisible: PeopleRowPolicy.qaVisible(viewerRole: viewer, isWebinarEnabled: inputs.isWebinarEnabled,
                                                 isWebinarQaEnabled: inputs.isWebinarQaEnabled),
            webinarQueueKnown: false,
            showsLostHostNotice: showsLostHost
        )
        if candidate != snapshot {
            snapshot = candidate.withRevision(snapshot.revision + 1)
        }
        if attendeeCount != inputs.webinarAttendeeCount { attendeeCount = inputs.webinarAttendeeCount }
    }
}
