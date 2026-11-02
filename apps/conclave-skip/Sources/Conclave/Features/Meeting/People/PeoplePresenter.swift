import Foundation
import Observation

@MainActor
@Observable
final class PeoplePresenter {
    private(set) var snapshot: PeopleSnapshot = PeopleSnapshot.empty

    private(set) var attendeeCount: Int = 0

    private(set) var qaUnseen: Int = 0

    private(set) var focusRequest: PeopleFocusRequest? = nil

    private(set) var confirmation: PeopleConfirmation? = nil

    private(set) var lastFailure: HostActionFailureModel? = nil

    private(set) var feedbackState = MeetingShellFeedbackState(session: 0, token: FeedbackToken.baseline)

    private(set) var rename: PeopleRenameState = PeopleRenameState.idle

    private(set) var stageInvitation: StageInvitationModel? = nil

    private(set) var headerActions: PeopleHeaderActions = PeopleHeaderActions.none

    @ObservationIgnored let rows = PersonRowStore()
    @ObservationIgnored let waiting = WaitingRowStore()
    @ObservationIgnored let shell: MeetingShellPresenter

    @ObservationIgnored let stage: StagePresenter

    @ObservationIgnored var recompose: PeopleRecomposeLedger? = nil

    @ObservationIgnored var initialSearchQuery = ""

    @ObservationIgnored let host = HostControlsPresenter()

    @ObservationIgnored let qa = WebinarQAPresenter()

    @ObservationIgnored var onAcceptStageInvitation: ((StageInvitationModel) -> Void)? = nil

    @ObservationIgnored var onCommand: ((PeopleCommand, HostActionTicket) -> Void)? = nil

    @ObservationIgnored var platform = ""

    @ObservationIgnored private(set) var inputs = PeopleInputs.make()

    @ObservationIgnored private(set) var applyCount = 0
    @ObservationIgnored private(set) var rowWriteCount = 0
    @ObservationIgnored private(set) var coverage = PanelStageCoverage.none
    @ObservationIgnored private(set) var isOnHostPage = false
    @ObservationIgnored private(set) var openPresentationID = 0
    @ObservationIgnored private(set) var openDestination = PanelDestination.none

    @ObservationIgnored private(set) var hostPresentationID = 0

    @ObservationIgnored private(set) var focusDestinations: [String] = []
    @ObservationIgnored private(set) var focusScrollCount = 0
    @ObservationIgnored private(set) var focusRevision = 0

    @ObservationIgnored private(set) var counterLog: [String] = []

    @ObservationIgnored private var nextFocusId = 0
    @ObservationIgnored private var lastDestinationSequence = -1
    @ObservationIgnored private var showsLostHost = false
    @ObservationIgnored private let ledger = HostActionLedger()
    @ObservationIgnored private var nextConfirmationId = 0
    @ObservationIgnored private var nextFailureId = 0
    @ObservationIgnored private var nextRenameId = 0
    @ObservationIgnored private var nextInvitationId = 0

    @ObservationIgnored private(set) var lastRoleChange: [String] = []

    @ObservationIgnored private var retryable: [Int: HostLedgerEntry] = [:]
    @ObservationIgnored private var retryOrder: [Int] = []

    @ObservationIgnored private var renameDisabledLocally = false

    @ObservationIgnored private var knownWaitingIds: [String] = []
    @ObservationIgnored private var waitingBaselineReady = false

    init(shell: MeetingShellPresenter, stage: StagePresenter) {
        self.shell = shell
        self.stage = stage
        host.parent = self
        qa.parent = self

        stage.people = self
    }

    var speaking: TileSpeakingStore { stage.speaking }

    func apply(_ next: PeopleInputs) {
        applyCount += 1

        let effects = PeopleRolePolicy.effects(previous: PeopleRoleState.from(inputs), next: PeopleRoleState.from(next))
        lastRoleChange = effects.kinds

        if effects.has(PeopleRoleChangeKind.sessionChanged) {
            reset()
        } else if effects.interruptsAllTickets {

            interruptPending()
        } else if effects.interruptsHostTickets {

            ledger.interruptHostActions()
            host.rebuild()
            qa.rebuild()
        }
        let previousViewer = snapshot.viewerRole
        inputs = next
        applyRoleEffects(effects)
        rebuild(previousViewer: previousViewer)
    }

    private func applyRoleEffects(_ effects: PeopleRoleEffects) {
        if effects.kinds.isEmpty || effects.has(PeopleRoleChangeKind.sessionChanged) { return }
        if effects.clearsHostConfirmations {

            clearConfirmation()

            if let open = shell.session.confirmation, open.invoker == MeetingConfirmationInvoker.hostControls {
                shell.cancelConfirmation(id: open.id)
            }
        } else if effects.closesMakeHostDialog, let current = confirmation, current.kind == PeopleConfirmationKind.makeHost {
            clearConfirmation()
        }
        if effects.dismissesPanels {

            if let current = shell.panels.snapshot.current,
               current.panel == MeetingPanel.participants || current.panel == MeetingPanel.hostControls {
                shell.panels.dismiss(cancelPending: true)
            }
        }
        if !effects.announcement.isEmpty {
            stage.announce(kind: effects.announcement, name: effects.announcementName)
        }
    }

    func panelSnapshotChanged() {

        qa.panelSnapshotChanged(current: shell.panels.snapshot.current)
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

    func destinationRequested(_ request: PanelDestinationRequest) {
        guard openPresentationID != 0, request.panel == MeetingPanel.participants,
              request.presentationID == openPresentationID, request.session == shell.panels.snapshot.session,
              request.sequence != lastDestinationSequence else { return }
        lastDestinationSequence = request.sequence
        openDestination = request.destination
        publishFocus(request.destination)
    }

    func focusRequestHandled(id: Int) {
        guard let request = focusRequest, request.id == id else { return }
        focusRequest = nil
        focusScrollCount += 1
    }

    func focusStep(id: Int, isShown: Bool, isSearching: Bool, revision: Int) -> PeopleFocusStep {
        guard let request = focusRequest, request.id == id else { return PeopleFocusStep.idle }
        return PeopleFocusPolicy.step(isShown: isShown, isSearching: isSearching, revision: revision,
                                      requestRevision: focusRevision)
    }

    func presentationDidChange(coverage: PanelStageCoverage, onHostPage: Bool) {
        self.coverage = coverage
        isOnHostPage = onHostPage
    }

    func openQuestionsAndAnswers() {
        shell.panels.present(MeetingPanel.webinarQA, from: PanelInvoker.call)
    }

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
        qa.reset()
        if stageInvitation != nil { stageInvitation = nil }
        lastRoleChange = []
        openPresentationID = 0
        hostPresentationID = 0
        openDestination = PanelDestination.none
        coverage = PanelStageCoverage.none
        isOnHostPage = false
        focusDestinations = []
        focusScrollCount = 0
        focusRevision = 0
        lastDestinationSequence = -1
        showsLostHost = false
        if focusRequest != nil { focusRequest = nil }
        if snapshot.withRevision(0) != PeopleSnapshot.empty {
            snapshot = PeopleSnapshot.empty.withRevision(snapshot.revision + 1)
        }
        if attendeeCount != 0 { attendeeCount = 0 }
        if qaUnseen != 0 { qaUnseen = 0 }
        if headerActions != PeopleHeaderActions.none { headerActions = PeopleHeaderActions.none }
        knownWaitingIds = []
        waitingBaselineReady = false
        stage.setKnockActionsPending(false)
    }

    var isPanelOpen: Bool { openPresentationID != 0 || hostPresentationID != 0 }

    func hostPanelDidOpen(presentationID: Int) {
        if presentationID == 0 { return }
        hostPresentationID = presentationID
    }

    func pendingKeys() -> [String] {
        ledger.pendingKeys()
    }

    @discardableResult
    func perform(_ action: PersonActionID, rowId: String, source: String) -> ControlTapResult {

        if PeopleOrderPolicy.isWaitingKey(rowId) { return performWaiting(action, rowId: rowId, source: source) }
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

    @discardableResult
    func admitAll() -> ControlTapResult {
        dispatchAdmitAll(source: PeopleActionSource.sectionHeader)
    }

    @discardableResult
    func admitAllFromStage() -> ControlTapResult {
        dispatchAdmitAll(source: PeopleActionSource.stage)
    }

    @discardableResult
    func admitFromStage(pendingId: String) -> ControlTapResult {
        if pendingId.isEmpty { return ControlTapResult.ignored }
        let key = PeopleOrderPolicy.waitingKey(pendingId)
        if waiting.contains(key) {
            return performWaiting(PersonActionID.admit, rowId: key, source: PeopleActionSource.stage)
        }

        guard snapshot.canUseHostActions else { return ControlTapResult.ignored }
        return dispatch(PeopleCommand.make(PeopleCommandKind.admit, targetId: pendingId), key: PeopleAdmissionsPolicy.admitKey(key),
                        source: PeopleActionSource.stage, sourceKey: key, targetName: "")
    }

    func requestDenyAll() {
        guard snapshot.canUseHostActions, headerActions.showsAdmitAll, headerActions.isDenyAllEnabled,
              let section = snapshot.section(PeopleSectionID.waiting) else { return }
        nextConfirmationId += 1
        present(PeopleConfirmation(id: nextConfirmationId, kind: PeopleConfirmationKind.denyAll,
                                   targetId: PeopleSectionID.waiting.rawValue, targetName: "", count: section.count,
                                   source: PeopleActionSource.sectionHeader, canBlock: false, isGuest: false,
                                   isConfirmEnabled: true, reason: PeopleActionReason.none))
    }

    @discardableResult
    func lowerAllHands() -> ControlTapResult {
        guard snapshot.canUseHostActions, headerActions.showsLowerAll, headerActions.isLowerAllEnabled else {
            return ControlTapResult.ignored
        }
        return dispatch(PeopleCommand.make(PeopleCommandKind.bulk, text: HostBulkID.lowerAllHands.rawValue),
                        key: PeopleAdmissionsPolicy.lowerAllKey, source: PeopleActionSource.sectionHeader,
                        sourceKey: PeopleSectionID.raisedHands.rawValue, targetName: "")
    }

    func requestMuteAll() {
        guard snapshot.canUseHostActions, headerActions.showsMuteAll, headerActions.isMuteAllEnabled else { return }
        nextConfirmationId += 1
        present(PeopleConfirmation(id: nextConfirmationId, kind: PeopleConfirmationKind.muteAll,
                                   targetId: HostBulkID.muteAll.rawValue, targetName: "", count: 0,
                                   source: PeopleActionSource.sectionHeader, canBlock: false, isGuest: false,
                                   isConfirmEnabled: true, reason: PeopleActionReason.none))
    }

    private func performWaiting(_ action: PersonActionID, rowId: String, source: String) -> ControlTapResult {
        guard action == PersonActionID.admit || action == PersonActionID.deny, waiting.contains(rowId),
              snapshot.canUseHostActions else { return ControlTapResult.ignored }
        let model = waiting.entry(for: rowId).model
        guard model.isEnabled else { return ControlTapResult.ignored }
        record("perform:" + action.rawValue)
        let kind = action == PersonActionID.admit ? PeopleCommandKind.admit : PeopleCommandKind.deny
        return dispatch(PeopleCommand.make(kind, targetId: model.serverId), key: PeopleActionPolicy.ledgerKey(kind, target: rowId),
                        source: source, sourceKey: rowId, targetName: model.name)
    }

    private func dispatchAdmitAll(source: String) -> ControlTapResult {
        guard snapshot.canUseHostActions, headerActions.isAdmitAllEnabled,
              let section = snapshot.section(PeopleSectionID.waiting) else { return ControlTapResult.ignored }
        return dispatch(PeopleCommand.make(PeopleCommandKind.admitAll, number: section.count), key: PeopleAdmissionsPolicy.admitAllKey,
                        source: source, sourceKey: PeopleSectionID.waiting.rawValue, targetName: "")
    }

    private func rosterSectionId() -> String {
        snapshot.section(PeopleSectionID.panelists) != nil ? PeopleSectionID.panelists.rawValue : PeopleSectionID.inMeeting.rawValue
    }

    func presentHostConfirmation(kind: PeopleConfirmationKind, targetId: String, targetName: String) {
        nextConfirmationId += 1
        present(PeopleConfirmation(id: nextConfirmationId, kind: kind, targetId: targetId, targetName: targetName, count: 0,
                                   source: PeopleActionSource.hostControls, canBlock: false, isGuest: false,
                                   isConfirmEnabled: true, reason: PeopleActionReason.none))
    }

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
            dispatch(PeopleCommand.make(PeopleCommandKind.denyAll, number: current.count), key: PeopleAdmissionsPolicy.denyAllKey,
                     source: current.source, sourceKey: PeopleSectionID.waiting.rawValue, targetName: "")
        case .muteAll, .camerasOff, .stopAllShares:
            if let bulk = HostControlsPolicy.bulk(for: current.kind) {
                if current.source == PeopleActionSource.sectionHeader {

                    dispatch(PeopleCommand.make(PeopleCommandKind.bulk, text: bulk.rawValue), key: HostControlsPolicy.bulkKey(bulk),
                             source: current.source, sourceKey: rosterSectionId(), targetName: "")
                } else {
                    host.dispatchBulk(bulk)
                }
            }
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

    func beginRename() {
        nextRenameId += 1
        rename = PeopleRenameState(id: nextRenameId, phase: PeopleRenamePhase.editing, draft: localDisplayName(), refusal: "")
    }

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
        qa.actionFinished(entry, result: result)
        rebuild(previousViewer: snapshot.viewerRole)
        return true
    }

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
        qa.rebuild()
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

            if entry.command.number > 0 {
                stage.announce(kind: PeopleAnnouncementKind.admittedAll, name: String(entry.command.number))
            }
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
            stage.announce(kind: PeopleAnnouncementKind.invitedToStage, name: name)
        case .moveToAudience:
            publishFeedback(FeedbackKind.hostMovedToAudience)
            stage.announce(kind: PeopleAnnouncementKind.movedToAudience, name: name)
        case .qaSubmit:

            publishFeedback(FeedbackKind.questionSent)
            stage.announce(kind: PeopleAnnouncementKind.questionSent, name: "")
        case .sendNotice:
            stage.announce(kind: PeopleAnnouncementKind.noticeSent, name: "")
        default:
            break
        }
    }

    private func failed(_ entry: HostLedgerEntry, failure: String) {

        if !snapshot.isHostViewer && PeopleRolePolicy.isHostCommand(entry.command.kind) { return }

        if PeopleAdmissionsPolicy.isSilentFailure(kind: entry.command.kind, failure: failure) { return }
        publishFeedback(entry.command.kind == PeopleCommandKind.qaSubmit ? FeedbackKind.questionFailed : FeedbackKind.hostActionFailed)
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
        qa.rebuild()
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

    private func validateConfirmation(rowKeys: [String], blockedReason: String) {
        guard let current = confirmation else { return }
        let shown = rowKeys.contains(current.targetId)
        var offered = true
        if shown, let action = personAction(for: current.kind) {
            offered = false
            for item in rows.entry(for: current.targetId).model.actions {
                if item.action == action { offered = true }
            }
        }
        let keep = PeopleRolePolicy.keepsConfirmation(kind: current.kind, targetShown: shown, actionOffered: offered,
                                                      viewerIsHost: PeopleOrderPolicy.viewerRole(inputs).isHostRole)
        if !keep {
            clearConfirmation()
            return
        }

        let enabled = blockedReason == MeetingBlockedReason.none.rawValue
        let reason = enabled ? PeopleActionReason.none : blockedReason
        if current.isConfirmEnabled != enabled || current.reason != reason {
            present(PeopleConfirmation(id: current.id, kind: current.kind, targetId: current.targetId,
                                       targetName: current.targetName, count: current.count, source: current.source,
                                       canBlock: current.canBlock, isGuest: current.isGuest, isConfirmEnabled: enabled,
                                       reason: reason))
        }
    }

    private func validateHeaderConfirmation(_ header: PeopleHeaderActions, waitingCount: Int) {
        guard let current = confirmation, current.source == PeopleActionSource.sectionHeader else { return }
        if current.kind == PeopleConfirmationKind.denyAll {
            if !header.showsAdmitAll {
                clearConfirmation()
            } else if current.count != waitingCount {
                present(PeopleConfirmation(id: current.id, kind: current.kind, targetId: current.targetId,
                                           targetName: current.targetName, count: waitingCount, source: current.source,
                                           canBlock: current.canBlock, isGuest: current.isGuest,
                                           isConfirmEnabled: current.isConfirmEnabled, reason: current.reason))
            }
        } else if current.kind == PeopleConfirmationKind.muteAll && !header.showsMuteAll {
            clearConfirmation()
        }
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

    func localName() -> String {
        localDisplayName()
    }

    func pendingLedgerEntries() -> [HostLedgerEntry] {
        ledger.pending
    }

    func qaUnseenChanged(_ value: Int) {
        let next = max(0, value)
        if qaUnseen != next { qaUnseen = next }
    }

    func clearFailures(sourceKey: String) {
        if let failure = lastFailure, failure.sourceKey == sourceKey { lastFailure = nil }
    }

    func clearFailures(sourcePrefix: String) {
        if let failure = lastFailure, failure.sourceKey.hasPrefix(sourcePrefix) { lastFailure = nil }
    }

    func presentStageInvitation(promotedByName: String, rejoinRoomId: String) {
        guard PeopleOrderPolicy.viewerRole(inputs) == PersonRole.attendee else { return }
        nextInvitationId += 1
        stageInvitation = StageInvitationModel(id: nextInvitationId,
                                               promotedByName: promotedByName.trimmingCharacters(in: .whitespacesAndNewlines),
                                               rejoinRoomId: rejoinRoomId, session: inputs.callSession)
    }

    func acceptStageInvitation(id: Int) {
        guard let invitation = stageInvitation, invitation.id == id else { return }
        stageInvitation = nil
        guard PeopleRolePolicy.acceptsInvitation(invitationSession: invitation.session, currentSession: inputs.callSession,
                                                 viewerRole: PeopleOrderPolicy.viewerRole(inputs)) else { return }
        record("acceptStage")
        onAcceptStageInvitation?(invitation)
    }

    func declineStageInvitation(id: Int) {
        guard let invitation = stageInvitation, invitation.id == id else { return }
        stageInvitation = nil
        declineStage()
    }

    @discardableResult
    func declineStage() -> ControlTapResult {
        guard PeopleOrderPolicy.viewerRole(inputs) == PersonRole.attendee else { return ControlTapResult.ignored }
        record("declineStage")
        return dispatch(PeopleCommand.make(PeopleCommandKind.declineStage),
                        key: PeopleActionPolicy.ledgerKey(PeopleCommandKind.declineStage, target: PeopleActionPolicy.selfTarget),
                        source: PeopleActionSource.stage, sourceKey: PeopleActionPolicy.selfTarget, targetName: "")
    }

    func revisionReadout() -> String {
        "rev=" + String(snapshot.revision) + " sections=" + sectionSummary()
    }

    func focusReadout() -> String {
        let destinations = focusDestinations.isEmpty ? "none" : focusDestinations.joined(separator: ",")
        return "destination=" + destinations + " scrolls=" + String(focusScrollCount)
    }

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

    func sectionSummary() -> String {
        var parts: [String] = []
        for section in snapshot.sections {
            parts.append(section.id + ":" + String(section.count))
        }
        return parts.isEmpty ? "none" : parts.joined(separator: ",")
    }

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
        focusRevision = snapshot.revision
        focusRequest = PeopleFocusRequest(id: nextFocusId, sectionId: sectionId)
    }

    private func announceNewKnocks(_ requests: [PeopleWaitingInput], viewerIsHost: Bool) {
        if !viewerIsHost {
            knownWaitingIds = []
            waitingBaselineReady = false
            return
        }
        if waitingBaselineReady && openPresentationID != 0 {
            let fresh = PeopleAdmissionsPolicy.newRequests(previous: knownWaitingIds, current: requests)
            if fresh.count == 1 {
                let name = fresh[0].displayName.trimmingCharacters(in: .whitespacesAndNewlines)
                stage.announce(kind: PeopleAnnouncementKind.knock, name: name.isEmpty ? fresh[0].id : name)
            } else if fresh.count > 1 {
                stage.announce(kind: PeopleAnnouncementKind.knockMany, name: String(fresh.count))
            }
        }
        var ids: [String] = []
        for request in requests {
            ids.append(request.id)
        }
        knownWaitingIds = ids
        waitingBaselineReady = true
    }

    private func rebuild(previousViewer: PersonRole) {
        let ordered = PeopleOrderPolicy.order(inputs)
        let viewer = ordered.viewerRole

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

        let webinarHost = WebinarPeoplePolicy.showsWebinarSections(isWebinarEnabled: inputs.isWebinarEnabled, viewerRole: viewer)
        var attendeeHandKeys: [String] = []
        var attendeeHandSearch: [String] = []
        var attendeeHandNames: [String] = []
        var invitedKeys: [String] = []
        var invitedSearch: [String] = []
        var invitedNames: [String] = []
        if webinarHost {
            let queue = WebinarPeoplePolicy.queueOrder(inputs.webinarHandQueue)
            var queuePosition = 0
            for entry in queue {
                queuePosition += 1
                let key = PeopleOrderPolicy.attendeeKey(entry.userId)
                let pending = PeopleActionPolicy.rowPendingAction(ledger.pendingAction(forRow: key))
                let actions = WebinarPeoplePolicy.attendeeActions(isInvited: false, blockedReason: blocked.rawValue,
                                                                  pendingAction: pending)
                let model = WebinarPeoplePolicy.handRowModel(entry, position: queuePosition, actions: actions, pendingAction: pending)
                if rows.write(model) { rowWriteCount += 1 }
                rowKeys.append(key)
                attendeeHandKeys.append(key)
                attendeeHandSearch.append(model.name.lowercased())
                attendeeHandNames.append(model.name)
            }
            for invite in WebinarPeoplePolicy.invitedRows(inputs.stageInvites, queue: queue) {
                let key = PeopleOrderPolicy.attendeeKey(invite.userId)
                let pending = PeopleActionPolicy.rowPendingAction(ledger.pendingAction(forRow: key))
                let actions = WebinarPeoplePolicy.attendeeActions(isInvited: true, blockedReason: blocked.rawValue,
                                                                  pendingAction: pending)
                let model = WebinarPeoplePolicy.invitedRowModel(invite, actions: actions, pendingAction: pending)
                if rows.write(model) { rowWriteCount += 1 }
                rowKeys.append(key)
                invitedKeys.append(key)
                invitedSearch.append(model.name.lowercased())
                invitedNames.append(model.name)
            }
        }

        validateConfirmation(rowKeys: rowKeys, blockedReason: blocked.rawValue)
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

        let pendingKeys = ledger.pendingKeys()
        let bulkAdmission = pendingKeys.contains(PeopleAdmissionsPolicy.admitAllKey)
            || pendingKeys.contains(PeopleAdmissionsPolicy.denyAllKey)
        var waitingKeys: [String] = []
        var waitingSearch: [String] = []
        var waitingNames: [String] = []
        for request in ordered.waiting {
            let key = PeopleOrderPolicy.waitingKey(request.id)
            let pending = PeopleActionPolicy.rowPendingAction(ledger.pendingAction(forRow: key))
            let model = PeopleAdmissionsPolicy.waitingRow(request, pendingAction: pending, blockedReason: blocked.rawValue,
                                                          bulkPending: bulkAdmission)
            waiting.write(model)
            waitingKeys.append(model.id)
            waitingSearch.append(model.name.lowercased())
            waitingNames.append(model.name)
        }
        waiting.prune(keeping: waitingKeys)
        announceNewKnocks(ordered.waiting, viewerIsHost: viewer.isHostRole)
        stage.setKnockActionsPending(PeopleAdmissionsPolicy.hasAdmissionPending(pendingKeys))
        let header = PeopleAdmissionsPolicy.headerActions(viewerIsHost: viewer.isHostRole, blockedReason: blocked.rawValue,
                                                          waitingCount: ordered.waiting.count,
                                                          showsMeetingHands: !webinarHost && !ordered.raisedHands.isEmpty,
                                                          rosterCount: meetingKeys.count, pendingKeys: pendingKeys)
        if header != headerActions { headerActions = header }
        validateHeaderConfirmation(header, waitingCount: ordered.waiting.count)

        var sections: [PeopleSection] = []
        if !waitingKeys.isEmpty {
            sections.append(PeopleSection(id: PeopleSectionID.waiting.rawValue, count: waitingKeys.count, rowIds: waitingKeys,
                                          searchKeys: waitingSearch, names: waitingNames))
        }
        if webinarHost {

            if !attendeeHandKeys.isEmpty {
                sections.append(PeopleSection(id: PeopleSectionID.raisedHands.rawValue, count: attendeeHandKeys.count,
                                              rowIds: attendeeHandKeys, searchKeys: attendeeHandSearch, names: attendeeHandNames))
            }
            sections.append(PeopleSection(id: PeopleSectionID.panelists.rawValue, count: meetingKeys.count, rowIds: meetingKeys,
                                          searchKeys: meetingSearch, names: meetingNames))
            sections.append(PeopleSection(id: PeopleSectionID.attendees.rawValue, count: invitedKeys.count, rowIds: invitedKeys,
                                          searchKeys: invitedSearch, names: invitedNames))
        } else {
            if !handKeys.isEmpty {
                sections.append(PeopleSection(id: PeopleSectionID.raisedHands.rawValue, count: handKeys.count, rowIds: handKeys,
                                              searchKeys: handSearch, names: handNames))
            }
            sections.append(PeopleSection(id: PeopleSectionID.inMeeting.rawValue, count: meetingKeys.count, rowIds: meetingKeys,
                                          searchKeys: meetingSearch, names: meetingNames))
        }

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
            webinarQueueKnown: webinarHost ? inputs.webinarQueueKnown : true,
            showsLostHostNotice: showsLostHost
        )
        if candidate != snapshot {
            snapshot = candidate.withRevision(snapshot.revision + 1)
        }
        if attendeeCount != inputs.webinarAttendeeCount { attendeeCount = inputs.webinarAttendeeCount }
    }
}

enum PeopleFocusStep: String, Equatable {
    case idle, awaitSection, placeHeader, consumeNow
}

enum PeopleFocusPolicy {
    static let placementTolerance = 1.0

    static func step(isShown: Bool, isSearching: Bool, revision: Int, requestRevision: Int) -> PeopleFocusStep {
        if isShown { return PeopleFocusStep.placeHeader }
        if isSearching || revision > requestRevision { return PeopleFocusStep.consumeNow }
        return PeopleFocusStep.awaitSection
    }

    static func isHeaderPlaced(headerTop: Double, headerBottom: Double, viewportTop: Double, viewportBottom: Double) -> Bool {
        if headerBottom <= headerTop || viewportBottom <= viewportTop { return false }
        let tolerance = PeopleFocusPolicy.placementTolerance
        return headerTop >= viewportTop - tolerance && headerBottom <= viewportBottom + tolerance
    }

    static func promotesToLarge(isPlaced: Bool, isMediumDetent: Bool) -> Bool {
        isMediumDetent && !isPlaced
    }
}
