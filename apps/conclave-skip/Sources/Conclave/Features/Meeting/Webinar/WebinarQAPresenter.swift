import Foundation
import Observation

/// S50 0.5 and 11 (PPL-6): the Webinar Q&A presenter, a child of `PeoplePresenter` (created and reset with it). Every
/// action dispatches through the parent, so Q&A shares the one ledger and the one failure path with People and Host
/// Controls (PH2): keys `qaSubmit:composer`, `qaUpvote:<id>`, `qaModerate:<id>`. Views read only `snapshot`, `unseen`
/// (its own stored property: only the badges read it) and one `QaQuestionEntry` per row; field text stays view state
/// written back into `drafts`, so a keystroke never publishes (S50 11 k).
///
/// Inputs come from the core on the PH7 path only (`apply`); the presenter never observes the core. The unseen counter
/// is the core's (PH7, RECONCILE R18): this presenter only reports the open presentation, so the core zeroes it on
/// open and counts again after close.
@MainActor
@Observable
final class WebinarQAPresenter {
    private(set) var snapshot: QaPanelSnapshot = QaPanelSnapshot.empty
    /// The role-appropriate unseen count (S20 12 bar badge, S30 More row, the Participants "%lld new" row).
    private(set) var unseen: Int = 0

    @ObservationIgnored let questions = QaQuestionStore()
    @ObservationIgnored let drafts = QaDrafts()
    /// Dispatch, ledger and failure path. `weak` (Kotlin has no unowned reference); set once by the parent.
    @ObservationIgnored weak var parent: PeoplePresenter?

    @ObservationIgnored private(set) var inputs = QaInputs.make()
    @ObservationIgnored private(set) var applyCount = 0
    @ObservationIgnored private(set) var openPresentationID = 0
    @ObservationIgnored private var sort = QaSort.top
    @ObservationIgnored private var filter = QaHostFilter.open
    @ObservationIgnored private var submitPhase = QaSubmitPhase.idle
    @ObservationIgnored private var submitSerial = 0
    @ObservationIgnored private var answeredQuestionId = ""
    @ObservationIgnored private var answerSerial = 0
    /// `qa.recompose.<id>` (PL12): row evaluations per question; nil in production.
    @ObservationIgnored var recompose: PeopleRecomposeLedger? = nil

    init() {}

    // MARK: Core hooks

    /// Core only (PH7 path): entries, Q&A state, role, connection and the unseen counter.
    func apply(_ next: QaInputs) {
        applyCount += 1
        let previous = inputs
        if previous.callSession != 0 && next.callSession != previous.callSession {
            reset()
        }
        inputs = next
        if unseen != next.unseen { unseen = next.unseen }
        // The Participants "Questions and Answers" row shows the host counter (S50 11 f).
        parent?.qaUnseenChanged(next.role == QaRole.host ? next.unseen : 0)
        // S50 11 f, 12 f: the panel closes itself when the host turns Attendee Q&A off or webinar mode ends, with the
        // "Q&A is off." announcement; a role change that removes Q&A closes it quietly.
        if openPresentationID != 0 && previous.isAvailableToRole && !next.isAvailableToRole
            && previous.callSession == next.callSession {
            let turnedOff = (previous.isQaEnabled && !next.isQaEnabled) || (previous.isWebinarEnabled && !next.isWebinarEnabled)
            closeOpenPanel(announcesOff: turnedOff)
        }
        rebuild()
    }

    /// The panel host's presentation lifecycle (S50 11 c `.task(id: presentationID)`, Android `onMounted`); pushing the
    /// iOS answer page is not a close.
    func panelDidOpen(presentationID: Int) {
        if presentationID == 0 || presentationID == openPresentationID { return }
        openPresentationID = presentationID
        // A host lands on Open each presentation; the attendee sort is kept (a choice, not a filter).
        if filter != QaHostFilter.open {
            filter = QaHostFilter.open
            rebuild()
        }
    }

    /// From the coordinator's dismissal (through the parent's `panelSnapshotChanged`): inline failures of this panel
    /// clear (PL14) and the core stores the last-seen marker.
    func panelDidClose(presentationID: Int) {
        if presentationID == 0 || presentationID != openPresentationID { return }
        openPresentationID = 0
        parent?.clearFailures(sourcePrefix: QaFieldID.answerPrefix)
        parent?.clearFailures(sourceKey: QaFieldID.composer)
        for id in snapshot.questionIds {
            parent?.clearFailures(sourceKey: id)
        }
    }

    /// The coordinator's snapshot changed: the presentation this presenter opened is gone, so the panel closed.
    func panelSnapshotChanged(current: PanelRequest?) {
        guard openPresentationID != 0 else { return }
        if current == nil || current?.presentationID != openPresentationID || current?.panel != MeetingPanel.webinarQA {
            panelDidClose(presentationID: openPresentationID)
        }
    }

    var isPanelOpen: Bool { openPresentationID != 0 }

    // MARK: Sort and filter (S50 11 c, d)

    func setSort(_ next: QaSort) {
        let resolved = QaOrderingPolicy.effectiveSort(next, role: inputs.role)
        if resolved == sort { return }
        sort = resolved
        rebuild()
    }

    func setFilter(_ next: QaHostFilter) {
        if next == filter { return }
        filter = next
        rebuild()
    }

    // MARK: Actions (S50 11 j)

    /// Attendees only: 2 to 500 characters, Q&A on and connected. The draft stays until the acknowledgement.
    @discardableResult
    func submit(_ text: String) -> ControlTapResult {
        guard snapshot.isAttendee, let parent,
              QaComposerPolicy.canSubmit(text, composerEnabled: snapshot.composerEnabled,
                                         isSending: submitPhase == QaSubmitPhase.sending) else {
            return ControlTapResult.ignored
        }
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        let result = parent.dispatch(PeopleCommand.make(PeopleCommandKind.qaSubmit, text: trimmed),
                                     key: WebinarQAPresenter.submitKey, source: PeopleActionSource.qa,
                                     sourceKey: QaFieldID.composer, targetName: "")
        if result == ControlTapResult.dispatched {
            submitPhase = QaSubmitPhase.sending
            rebuild()
        }
        return result
    }

    /// Attendees only: toggles your vote; the control stays disabled until the acknowledgement (S50 11 f).
    @discardableResult
    func toggleUpvote(id: String) -> ControlTapResult {
        guard snapshot.isAttendee, let parent, let model = questions.model(id), model.isEnabled else {
            return ControlTapResult.ignored
        }
        return parent.dispatch(PeopleCommand.make(PeopleCommandKind.qaUpvote, targetId: id, flag: !model.hasUpvoted),
                               key: WebinarQAPresenter.upvoteKey(id), source: PeopleActionSource.qa, sourceKey: id,
                               targetName: "")
    }

    /// Hosts only (S50 11 c): Answer Live (`answering`), Mark Answered (`answered`), Dismiss (`dismissed`), Reopen
    /// (`reopen: true`), or a written answer (`answered` with `answerText`, up to 1,000 characters, Q6). One action per
    /// question at a time.
    @discardableResult
    func moderate(id: String, action: QaStatus, reopen: Bool, answerText: String) -> ControlTapResult {
        guard snapshot.isHost, let parent, let model = questions.model(id), model.isEnabled else {
            return ControlTapResult.ignored
        }
        let written = answerText.trimmingCharacters(in: .whitespacesAndNewlines)
        var actionRaw = action.rawValue
        if reopen {
            actionRaw = QaModerationAction.reopen
        } else if action == QaStatus.pending {
            return ControlTapResult.ignored
        }
        if !written.isEmpty {
            guard answerText.count <= QaLimits.answerMax else { return ControlTapResult.ignored }
            actionRaw = QaModerationAction.answered
        }
        let allowed = QaOrderingPolicy.hostActions(model.status)
        let requested = written.isEmpty ? actionRaw : QaHostAction.answerText
        guard allowed.contains(requested) else { return ControlTapResult.ignored }
        return parent.dispatch(PeopleCommand.make(PeopleCommandKind.qaModerate, targetId: id, text: written, detail: actionRaw),
                               key: WebinarQAPresenter.moderateKey(id), source: PeopleActionSource.qa,
                               sourceKey: written.isEmpty ? id : QaFieldID.answer(id), targetName: "")
    }

    /// A host action by its id as `QaOrderingPolicy.hostActions` lists them (menus and swipes pass these).
    @discardableResult
    func perform(hostAction: String, id: String) -> ControlTapResult {
        switch hostAction {
        case QaModerationAction.answering:
            return moderate(id: id, action: QaStatus.answering, reopen: false, answerText: "")
        case QaModerationAction.answered:
            return moderate(id: id, action: QaStatus.answered, reopen: false, answerText: "")
        case QaModerationAction.dismissed:
            return moderate(id: id, action: QaStatus.dismissed, reopen: false, answerText: "")
        case QaModerationAction.reopen:
            return moderate(id: id, action: QaStatus.pending, reopen: true, answerText: "")
        default:
            return ControlTapResult.ignored
        }
    }

    // MARK: Results (from the parent's finish)

    func actionFinished(_ entry: HostLedgerEntry, result: HostActionResult) {
        let completed = result.kind == HostActionResultKind.completed
        switch entry.command.kind {
        case .qaSubmit:
            if completed {
                drafts.question = ""
                submitSerial += 1
                submitPhase = QaSubmitPhase.idle
            } else {
                submitPhase = result.kind == HostActionResultKind.failed ? QaSubmitPhase.failed : QaSubmitPhase.idle
            }
        case .qaModerate:
            if completed && !entry.command.text.isEmpty {
                drafts.answers[entry.command.targetId] = nil
                answeredQuestionId = entry.command.targetId
                answerSerial += 1
            }
        default:
            break
        }
        rebuild()
    }

    /// With the parent's reset (S1C 3.3 TEAR): drafts, sort, filter and phases clear; revisions keep growing.
    func reset() {
        drafts.reset()
        questions.removeAll()
        inputs = QaInputs.make()
        sort = QaSort.top
        filter = QaHostFilter.open
        submitPhase = QaSubmitPhase.idle
        openPresentationID = 0
        if snapshot.withRevision(0) != QaPanelSnapshot.empty {
            snapshot = QaPanelSnapshot.empty.withRevision(snapshot.revision + 1)
        }
        if unseen != 0 { unseen = 0 }
    }

    // MARK: Keys

    static let submitKey = "qaSubmit:composer"

    static func upvoteKey(_ id: String) -> String { PeopleCommandKind.qaUpvote.rawValue + ":" + id }

    static func moderateKey(_ id: String) -> String { PeopleCommandKind.qaModerate.rawValue + ":" + id }

    // MARK: Rebuild

    /// Recomputes rows and structure from the inputs and the parent's ledger; publishes only what changed.
    func rebuild() {
        let pending = parent?.pendingLedgerEntries() ?? []
        var pendingByQuestion: [String: String] = [:]
        var submitting = false
        for item in pending {
            switch item.command.kind {
            case .qaUpvote:
                pendingByQuestion[item.command.targetId] = "upvote"
            case .qaModerate:
                pendingByQuestion[item.command.targetId] = item.command.text.isEmpty ? item.command.detail : QaHostAction.answerText
            case .qaSubmit:
                submitting = true
            default:
                break
            }
        }
        if !submitting && submitPhase == QaSubmitPhase.sending {
            submitPhase = QaSubmitPhase.idle
        }
        let role = inputs.role
        let blocked = inputs.blockedReason
        let localKey = WebinarStageInvitePolicy.userKeyPart(inputs.localUserId)
        var models: [QaQuestionModel] = []
        var ids: [String] = []
        for entry in inputs.entries {
            if entry.id.isEmpty || ids.contains(entry.id) { continue }
            ids.append(entry.id)
            let isMine = !entry.userId.isEmpty
                && (entry.userId == inputs.localUserId || (!localKey.isEmpty && WebinarStageInvitePolicy.userKeyPart(entry.userId) == localKey))
            let model = QaQuestionModel(
                id: entry.id,
                askerName: entry.askerName.trimmingCharacters(in: .whitespacesAndNewlines),
                isMine: isMine,
                text: entry.question,
                status: QaStatus(rawValue: entry.status) ?? QaStatus.pending,
                askedAtMillis: entry.askedAtMillis,
                upvotes: max(0, entry.upvotes),
                hasUpvoted: entry.hasUpvoted,
                answerText: entry.answerText.trimmingCharacters(in: .whitespacesAndNewlines),
                answeredByName: entry.answeredByName.trimmingCharacters(in: .whitespacesAndNewlines),
                pendingAction: pendingByQuestion[entry.id] ?? "",
                blockedReason: blocked
            )
            models.append(model)
            questions.write(model)
        }
        questions.prune(keeping: ids)

        let resolvedSort = QaOrderingPolicy.effectiveSort(sort, role: role)
        if resolvedSort != sort { sort = resolvedSort }
        var sorts: [String] = []
        for item in QaOrderingPolicy.availableSorts(role: role) {
            sorts.append(item.rawValue)
        }
        let reason = QaComposerPolicy.composerReason(isQaEnabled: inputs.isWebinarEnabled && inputs.isQaEnabled,
                                                     blockedReason: blocked)
        let availability = role == QaRole.host && !inputs.isSnapshotReceived && inputs.becameHostAfterJoin
            ? QaAvailability.needsRejoin
            : QaAvailability.available
        let candidate = QaPanelSnapshot(
            revision: snapshot.revision,
            role: role,
            isEnabled: inputs.isAvailableToRole,
            isLoaded: inputs.isSnapshotReceived,
            availability: availability,
            availableSorts: sorts,
            sort: resolvedSort,
            filter: filter,
            questionIds: QaOrderingPolicy.orderedIds(models, role: role, sort: resolvedSort, filter: filter),
            counts: role == QaRole.host ? QaOrderingPolicy.counts(models) : [0, 0, 0],
            composerEnabled: role == QaRole.attendee && reason == QaComposerReason.none,
            composerReason: reason,
            submitPhase: submitPhase,
            submitSerial: submitSerial,
            answeredQuestionId: answeredQuestionId,
            answerSerial: answerSerial
        )
        if candidate != snapshot {
            snapshot = candidate.withRevision(snapshot.revision + 1)
        }
    }

    private func closeOpenPanel(announcesOff: Bool) {
        guard let parent else { return }
        let current = parent.shell.panels.snapshot.current
        if let shown = current, shown.panel == MeetingPanel.webinarQA, shown.presentationID == openPresentationID {
            parent.shell.panels.dismiss(cancelPending: true)
        }
        if announcesOff {
            parent.stage.announce(kind: PeopleAnnouncementKind.qaOff, name: "")
        }
    }

    // MARK: Readouts (Debug fixture and tests)

    /// `qa.revision` with the visible ids, for example `rev=3 ids=q1,q2`.
    func revisionReadout() -> String {
        "rev=" + String(snapshot.revision) + " ids=" + (snapshot.questionIds.isEmpty ? "none" : snapshot.questionIds.joined(separator: ","))
    }
}
