import Foundation
import Observation

@MainActor
@Observable
final class WebinarQAPresenter {
    private(set) var snapshot: QaPanelSnapshot = QaPanelSnapshot.empty

    private(set) var unseen: Int = 0

    @ObservationIgnored let questions = QaQuestionStore()
    @ObservationIgnored let drafts = QaDrafts()

    @ObservationIgnored weak var parent: PeoplePresenter?

    @ObservationIgnored private(set) var inputs = QaInputs.make()
    @ObservationIgnored private(set) var applyCount = 0
    @ObservationIgnored private(set) var openPresentationID = 0
    @ObservationIgnored private var sort = QaSort.top
    @ObservationIgnored private var filter = QaHostFilter.openQuestions
    @ObservationIgnored private var submitPhase = QaSubmitPhase.idle
    @ObservationIgnored private var submitSerial = 0
    @ObservationIgnored private var answeredQuestionId = ""
    @ObservationIgnored private var answerSerial = 0

    @ObservationIgnored var recompose: PeopleRecomposeLedger? = nil

    init() {}

    func apply(_ next: QaInputs) {
        applyCount += 1
        let previous = inputs
        if previous.callSession != 0 && next.callSession != previous.callSession {
            reset()
        }
        inputs = next
        if unseen != next.unseen { unseen = next.unseen }

        parent?.qaUnseenChanged(next.role == QaRole.host ? next.unseen : 0)

        if openPresentationID != 0 && previous.isAvailableToRole && !next.isAvailableToRole
            && previous.callSession == next.callSession {
            let turnedOff = (previous.isQaEnabled && !next.isQaEnabled) || (previous.isWebinarEnabled && !next.isWebinarEnabled)
            closeOpenPanel(announcesOff: turnedOff)
        }
        rebuild()
    }

    func panelDidOpen(presentationID: Int) {
        if presentationID == 0 || presentationID == openPresentationID { return }
        openPresentationID = presentationID

        if filter != QaHostFilter.openQuestions {
            filter = QaHostFilter.openQuestions
            rebuild()
        }
    }

    func panelDidClose(presentationID: Int) {
        if presentationID == 0 || presentationID != openPresentationID { return }
        openPresentationID = 0
        parent?.clearFailures(sourcePrefix: QaFieldID.answerPrefix)
        parent?.clearFailures(sourceKey: QaFieldID.composer)
        for id in snapshot.questionIds {
            parent?.clearFailures(sourceKey: id)
        }
    }

    func panelSnapshotChanged(current: PanelRequest?) {
        guard openPresentationID != 0 else { return }
        if current == nil || current?.presentationID != openPresentationID || current?.panel != MeetingPanel.webinarQA {
            panelDidClose(presentationID: openPresentationID)
        }
    }

    var isPanelOpen: Bool { openPresentationID != 0 }

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

    @discardableResult
    func toggleUpvote(id: String) -> ControlTapResult {
        guard snapshot.isAttendee, let parent, let model = questions.model(id), model.isEnabled else {
            return ControlTapResult.ignored
        }
        return parent.dispatch(PeopleCommand.make(PeopleCommandKind.qaUpvote, targetId: id, flag: !model.hasUpvoted),
                               key: WebinarQAPresenter.upvoteKey(id), source: PeopleActionSource.qa, sourceKey: id,
                               targetName: "")
    }

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

    func reset() {
        drafts.reset()
        questions.removeAll()
        inputs = QaInputs.make()
        sort = QaSort.top
        filter = QaHostFilter.openQuestions
        submitPhase = QaSubmitPhase.idle
        openPresentationID = 0
        if snapshot.withRevision(0) != QaPanelSnapshot.empty {
            snapshot = QaPanelSnapshot.empty.withRevision(snapshot.revision + 1)
        }
        if unseen != 0 { unseen = 0 }
    }

    static let submitKey = "qaSubmit:composer"

    static func upvoteKey(_ id: String) -> String { PeopleCommandKind.qaUpvote.rawValue + ":" + id }

    static func moderateKey(_ id: String) -> String { PeopleCommandKind.qaModerate.rawValue + ":" + id }

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

    func revisionReadout() -> String {
        "rev=" + String(snapshot.revision) + " ids=" + (snapshot.questionIds.isEmpty ? "none" : snapshot.questionIds.joined(separator: ","))
    }
}
