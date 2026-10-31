import Foundation
import Observation

@MainActor
@Observable
final class HostControlsPresenter {
    private(set) var snapshot: HostControlsSnapshot = HostControlsSnapshot.empty

    private(set) var attendeeCount: Int = 0

    @ObservationIgnored let drafts = HostDrafts()

    @ObservationIgnored weak var parent: PeoplePresenter?

    @ObservationIgnored var linkProvider: (() async -> String?)? = nil

    @ObservationIgnored var configRefresher: (() -> Void)? = nil

    @ObservationIgnored private(set) var inputs = HostControlsInputs.make()
    @ObservationIgnored private var requested: [String: Bool] = [:]
    @ObservationIgnored private var isHostViewer = false
    @ObservationIgnored private var blockedReason = MeetingBlockedReason.notJoined.rawValue
    @ObservationIgnored private var hasActiveShare = false
    @ObservationIgnored private var anyHandRaised = false
    @ObservationIgnored private var noticePhase = HostFieldPhase.idle
    @ObservationIgnored private var noticeSentSerial = 0
    @ObservationIgnored private var inviteCodePhase = HostFieldPhase.idle
    @ObservationIgnored private var inviteCodeSavedSerial = 0
    @ObservationIgnored private var linkPhase = WebinarLinkPhase.idle
    @ObservationIgnored private var linkTask: Task<String?, Never>? = nil
    @ObservationIgnored private var rotatedLinkSerial = 0
    @ObservationIgnored private var savedField = ""
    @ObservationIgnored private var savedSerial = 0
    @ObservationIgnored private(set) var configRefreshCount = 0
    @ObservationIgnored private(set) var applyCount = 0

    init() {}

    func apply(_ next: HostControlsInputs) {
        applyCount += 1
        let previous = inputs
        if previous.callSession != 0 && next.callSession != previous.callSession {
            reset()
        }
        announceRemoteChanges(previous: previous, next: next)
        inputs = next
        if attendeeCount != next.webinarAttendeeCount { attendeeCount = next.webinarAttendeeCount }
        rebuild()
    }

    func peopleChanged(isHostViewer: Bool, blockedReason: String, hasActiveShare: Bool, anyHandRaised: Bool) {
        if self.isHostViewer == isHostViewer && self.blockedReason == blockedReason && self.hasActiveShare == hasActiveShare
            && self.anyHandRaised == anyHandRaised {
            return
        }
        self.isHostViewer = isHostViewer
        self.blockedReason = blockedReason
        self.hasActiveShare = hasActiveShare
        self.anyHandRaised = anyHandRaised
        rebuild()
    }

    @discardableResult
    func setPolicy(_ id: HostPolicyID, on: Bool) -> ControlTapResult {
        guard snapshot.isAvailable, let row = snapshot.policy(id), row.isEnabled, row.isOn != on, let parent else {
            return ControlTapResult.ignored
        }
        requested[id.rawValue] = on
        let result = parent.dispatch(PeopleCommand.make(PeopleCommandKind.setPolicy, text: id.rawValue, flag: on),
                                     key: HostControlsPolicy.policyKey(id), source: PeopleActionSource.hostControls,
                                     sourceKey: id.rawValue, targetName: "")
        if result != ControlTapResult.dispatched { requested[id.rawValue] = nil }
        return result
    }

    @discardableResult
    func requestBulk(_ id: HostBulkID) -> ControlTapResult {
        guard snapshot.isAvailable, let row = snapshot.bulkRow(id), row.isVisible, row.isEnabled, let parent else {
            return ControlTapResult.ignored
        }
        if let kind = HostControlsPolicy.confirmationKind(id) {
            parent.presentHostConfirmation(kind: kind, targetId: id.rawValue, targetName: "")
            return ControlTapResult.dispatched
        }
        return dispatchBulk(id)
    }

    @discardableResult
    func dispatchBulk(_ id: HostBulkID) -> ControlTapResult {
        guard let parent else { return ControlTapResult.ignored }
        return parent.dispatch(PeopleCommand.make(PeopleCommandKind.bulk, text: id.rawValue), key: HostControlsPolicy.bulkKey(id),
                               source: PeopleActionSource.hostControls, sourceKey: id.rawValue, targetName: "")
    }

    @discardableResult
    func setMeetingInviteCode(_ code: String) -> ControlTapResult {
        let trimmed = code.trimmingCharacters(in: .whitespacesAndNewlines)
        guard snapshot.isAvailable, !trimmed.isEmpty, let parent else { return ControlTapResult.ignored }
        let result = parent.dispatch(PeopleCommand.make(PeopleCommandKind.setMeetingInviteCode, text: trimmed),
                                     key: HostControlsPolicy.fieldKey(HostFieldID.inviteCode),
                                     source: PeopleActionSource.hostControls, sourceKey: HostFieldID.inviteCode, targetName: "")
        if result == ControlTapResult.dispatched {
            inviteCodePhase = HostFieldPhase.sending
            rebuild()
        }
        return result
    }

    func requestClearMeetingInviteCode() {
        guard snapshot.isAvailable, snapshot.access.requiresCode, let parent else { return }
        parent.presentHostConfirmation(kind: PeopleConfirmationKind.clearInviteCode, targetId: HostFieldID.inviteCode, targetName: "")
    }

    @discardableResult
    func dispatchClearMeetingInviteCode() -> ControlTapResult {
        guard let parent else { return ControlTapResult.ignored }
        return parent.dispatch(PeopleCommand.make(PeopleCommandKind.clearMeetingInviteCode),
                               key: HostControlsPolicy.fieldKey(HostFieldID.inviteCode), source: PeopleActionSource.hostControls,
                               sourceKey: HostFieldID.inviteCode, targetName: "")
    }

    func refreshAccessLists() {
        guard snapshot.isAvailable, let parent else { return }
        parent.dispatch(PeopleCommand.make(PeopleCommandKind.refreshAccessLists), key: "refreshAccessLists:all",
                        source: PeopleActionSource.hostControls, sourceKey: HostFieldID.accessKey, targetName: "")
    }

    @discardableResult
    func allow(_ key: String) -> ControlTapResult {
        accessAction(PeopleCommandKind.allowKey, key: key)
    }

    func requestBlock(_ key: String) {
        guard snapshot.isAvailable, let normalized = HostControlsPolicy.normalizedAccessKey(key), let parent else { return }
        parent.presentHostConfirmation(kind: PeopleConfirmationKind.block, targetId: normalized, targetName: normalized)
    }

    @discardableResult
    func dispatchBlock(_ key: String) -> ControlTapResult {
        accessAction(PeopleCommandKind.blockKey, key: key)
    }

    @discardableResult
    func unblock(_ key: String) -> ControlTapResult {
        accessAction(PeopleCommandKind.unblockKey, key: key)
    }

    @discardableResult
    func revoke(_ key: String) -> ControlTapResult {
        accessAction(PeopleCommandKind.revokeKey, key: key)
    }

    private func accessAction(_ kind: PeopleCommandKind, key: String) -> ControlTapResult {
        guard snapshot.isAvailable, let normalized = HostControlsPolicy.normalizedAccessKey(key), let parent else {
            return ControlTapResult.ignored
        }
        return parent.dispatch(PeopleCommand.make(kind, targetId: normalized), key: HostControlsPolicy.accessKey(kind, key: normalized),
                               source: PeopleActionSource.hostControls, sourceKey: HostFieldID.accessKey, targetName: normalized)
    }

    @discardableResult
    func sendNotice(_ text: String, level: String) -> ControlTapResult {
        guard snapshot.isAvailable, HostControlsPolicy.canSendNotice(text, isPending: false, isBlocked: false), let parent else {
            return ControlTapResult.ignored
        }
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        let result = parent.dispatch(PeopleCommand.make(PeopleCommandKind.sendNotice, targetId: HostControlsPolicy.normalizedLevel(level),
                                                        text: trimmed),
                                     key: HostControlsPolicy.fieldKey(HostFieldID.notice), source: PeopleActionSource.hostControls,
                                     sourceKey: HostFieldID.notice, targetName: "")
        if result == ControlTapResult.dispatched {
            noticePhase = HostFieldPhase.sending
            rebuild()
        }
        return result
    }

    @discardableResult
    func setMaxAttendees(_ value: Int) -> ControlTapResult {
        guard snapshot.isAvailable, value >= HostControlsPolicy.capacityMin, value <= HostControlsPolicy.capacityMax, let parent else {
            return ControlTapResult.ignored
        }
        return parent.dispatch(PeopleCommand.make(PeopleCommandKind.setMaxAttendees, number: value),
                               key: HostControlsPolicy.fieldKey(HostFieldID.capacity), source: PeopleActionSource.hostControls,
                               sourceKey: HostFieldID.capacity, targetName: "")
    }

    @discardableResult
    func setAttendeeCode(_ code: String) -> ControlTapResult {
        let trimmed = code.trimmingCharacters(in: .whitespacesAndNewlines)
        guard snapshot.isAvailable, !trimmed.isEmpty, let parent else { return ControlTapResult.ignored }
        return parent.dispatch(PeopleCommand.make(PeopleCommandKind.setAttendeeCode, text: trimmed),
                               key: HostControlsPolicy.fieldKey(HostFieldID.attendeeCode), source: PeopleActionSource.hostControls,
                               sourceKey: HostFieldID.attendeeCode, targetName: "")
    }

    func requestClearAttendeeCode() {
        guard snapshot.isAvailable, snapshot.webinar.requiresCode, let parent else { return }
        parent.presentHostConfirmation(kind: PeopleConfirmationKind.clearAttendeeCode, targetId: HostFieldID.attendeeCode,
                                       targetName: "")
    }

    @discardableResult
    func dispatchClearAttendeeCode() -> ControlTapResult {
        guard let parent else { return ControlTapResult.ignored }
        return parent.dispatch(PeopleCommand.make(PeopleCommandKind.clearAttendeeCode),
                               key: HostControlsPolicy.fieldKey(HostFieldID.attendeeCode), source: PeopleActionSource.hostControls,
                               sourceKey: HostFieldID.attendeeCode, targetName: "")
    }

    @discardableResult
    func setLinkSlug(_ slug: String) -> ControlTapResult {
        let trimmed = slug.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard snapshot.isAvailable, HostControlsPolicy.isValidSlug(trimmed), let parent else { return ControlTapResult.ignored }
        return parent.dispatch(PeopleCommand.make(PeopleCommandKind.setLinkSlug, text: trimmed),
                               key: HostControlsPolicy.fieldKey(HostFieldID.customLink), source: PeopleActionSource.hostControls,
                               sourceKey: HostFieldID.customLink, targetName: "")
    }

    @discardableResult
    func clearLinkSlug() -> ControlTapResult {
        guard snapshot.isAvailable, let parent else { return ControlTapResult.ignored }
        return parent.dispatch(PeopleCommand.make(PeopleCommandKind.clearLinkSlug),
                               key: HostControlsPolicy.fieldKey(HostFieldID.customLink), source: PeopleActionSource.hostControls,
                               sourceKey: HostFieldID.customLink, targetName: "")
    }

    func ensureWebinarLink() async -> String? {
        let current = snapshot.webinar.linkURL
        if !current.isEmpty { return current }
        if let running = linkTask {
            return await running.value
        }
        guard let provider = linkProvider else { return nil }
        linkPhase = WebinarLinkPhase.generating
        rebuild()
        let task = Task<String?, Never> {
            await provider()
        }
        linkTask = task
        let value = await task.value
        linkTask = nil
        let link = value ?? ""
        linkPhase = link.isEmpty ? WebinarLinkPhase.failed : WebinarLinkPhase.idle
        rebuild()
        return link.isEmpty ? nil : link
    }

    func refreshWebinarConfig() {
        guard snapshot.isAvailable else { return }
        configRefreshCount += 1
        configRefresher?()
    }

    var isWebinarSettingsReachable: Bool { snapshot.isAvailable && snapshot.webinar.enabled }

    func requestRotateLink() {
        guard snapshot.isAvailable, let parent else { return }
        parent.presentHostConfirmation(kind: PeopleConfirmationKind.rotateWebinarLink, targetId: HostFieldID.customLink,
                                       targetName: "")
    }

    @discardableResult
    func dispatchRotateLink() -> ControlTapResult {
        guard let parent else { return ControlTapResult.ignored }
        let result = parent.dispatch(PeopleCommand.make(PeopleCommandKind.rotateLink), key: "rotateLink:webinar",
                                     source: PeopleActionSource.hostControls, sourceKey: HostFieldID.customLink, targetName: "")
        if result == ControlTapResult.dispatched {
            linkPhase = WebinarLinkPhase.rotating
            rebuild()
        }
        return result
    }

    func requestEndForEveryone() {
        guard snapshot.isAvailable, snapshot.canEndForEveryone, let parent else { return }
        parent.shell.requestEndForEveryone(from: MeetingConfirmationInvoker.hostControls)
    }

    func willRetry(_ entry: HostLedgerEntry) {
        if entry.command.kind == PeopleCommandKind.setPolicy {
            requested[entry.command.text] = entry.command.flag
        }
    }

    func actionFinished(_ entry: HostLedgerEntry, result: HostActionResult) {
        let completed = result.kind == HostActionResultKind.completed
        let failed = result.kind == HostActionResultKind.failed
        switch entry.command.kind {
        case .setPolicy:
            requested[entry.command.text] = nil
        case .setMeetingInviteCode:
            if completed {
                drafts.meetingCode = ""
                inviteCodePhase = HostFieldPhase.sent
                inviteCodeSavedSerial += 1
            } else {
                inviteCodePhase = failed ? HostFieldPhase.failed : HostFieldPhase.idle
            }
        case .allowKey, .blockKey:
            if completed && HostControlsPolicy.normalizedAccessKey(drafts.accessKey) == entry.command.targetId {
                drafts.accessKey = ""
            }
        case .sendNotice:
            if completed {
                drafts.noticeText = ""
                noticePhase = HostFieldPhase.sent
                noticeSentSerial += 1
            } else {
                noticePhase = failed ? HostFieldPhase.failed : HostFieldPhase.idle
            }
        case .setAttendeeCode, .clearAttendeeCode:
            if completed {
                drafts.attendeeCode = ""
                noteSaved(HostFieldID.attendeeCode)
            }
        case .setLinkSlug, .clearLinkSlug:

            if completed {
                drafts.slug = entry.command.kind == PeopleCommandKind.setLinkSlug ? entry.command.text : ""
                noteSaved(HostFieldID.customLink)
            }
        case .setMaxAttendees:
            if completed {
                drafts.capacity = String(entry.command.number)
                noteSaved(HostFieldID.capacity)
            }
        case .rotateLink, .generateLink:
            linkPhase = failed ? WebinarLinkPhase.failed : WebinarLinkPhase.idle
            if completed && entry.command.kind == PeopleCommandKind.rotateLink { rotatedLinkSerial += 1 }
        default:
            break
        }
        rebuild()
    }

    private func noteSaved(_ field: String) {
        savedField = field
        savedSerial += 1
    }

    func reset() {
        drafts.reset()
        requested = [:]
        noticePhase = HostFieldPhase.idle
        inviteCodePhase = HostFieldPhase.idle
        linkPhase = WebinarLinkPhase.idle
        linkTask = nil
        inputs = HostControlsInputs.make()
        isHostViewer = false
        blockedReason = MeetingBlockedReason.notJoined.rawValue
        hasActiveShare = false
        anyHandRaised = false
        if snapshot.withRevision(0) != HostControlsSnapshot.empty {
            snapshot = HostControlsSnapshot.empty.withRevision(snapshot.revision + 1)
        }
        if attendeeCount != 0 { attendeeCount = 0 }
    }

    func rebuild() {
        let pendingKeys = parent?.pendingKeys() ?? []
        var pendingPolicies: [String] = []
        var pendingBulk: [String] = []
        var pendingAccess: [String] = []
        var pendingFields: [String] = []
        for key in pendingKeys {
            let parts = key.components(separatedBy: ":")
            if parts.count < 2 { continue }
            let target = String(key.dropFirst(parts[0].count + 1))
            if parts[0] == "policy" {
                pendingPolicies.append(target)
            } else if parts[0] == "bulk" {
                pendingBulk.append(target)
            } else if parts[0] == "field" {
                pendingFields.append(target)
            } else if parts[0] == PeopleCommandKind.allowKey.rawValue || parts[0] == PeopleCommandKind.blockKey.rawValue
                        || parts[0] == PeopleCommandKind.unblockKey.rawValue || parts[0] == PeopleCommandKind.revokeKey.rawValue {
                pendingAccess.append(target)
            }
        }
        let webinar = WebinarSettingsModel(enabled: inputs.isWebinarEnabled, maxAttendees: inputs.webinarMaxAttendees,
                                           requiresCode: inputs.webinarRequiresCode, linkSlug: inputs.webinarLinkSlug,
                                           linkURL: inputs.webinarLinkURL, linkPhase: linkPhase)
        let candidate = HostControlsSnapshot(
            revision: snapshot.revision,
            isAvailable: isHostViewer,
            blockedReason: blockedReason,
            isConfigLoading: inputs.isConfigLoading,
            bulk: HostControlsPolicy.bulkRows(blockedReason: blockedReason, hasActiveShare: hasActiveShare,
                                              anyHandRaised: anyHandRaised, pendingBulk: pendingBulk),
            policies: HostControlsPolicy.policyRows(inputs, blockedReason: blockedReason, pendingPolicies: pendingPolicies,
                                                    requested: requested),
            access: HostControlsPolicy.accessSummary(inputs),
            noticePhase: noticePhase,
            noticeSentSerial: noticeSentSerial,
            inviteCodePhase: inviteCodePhase,
            inviteCodeSavedSerial: inviteCodeSavedSerial,
            pendingAccessKeys: pendingAccess,
            webinar: webinar,
            canEndForEveryone: inputs.canEndForEveryone && isHostViewer,
            endPhase: inputs.isEnding ? HostEndPhase.ending : HostEndPhase.idle,
            rotatedLinkSerial: rotatedLinkSerial,
            pendingFields: pendingFields,
            savedField: savedField,
            savedSerial: savedSerial
        )
        if candidate != snapshot {
            snapshot = candidate.withRevision(snapshot.revision + 1)
        }
    }

    private func announceRemoteChanges(previous: HostControlsInputs, next: HostControlsInputs) {
        guard let parent, isHostViewer, parent.isPanelOpen, previous.callSession == next.callSession, applyCount > 1 else { return }
        for id in [HostPolicyID.lockMeeting, HostPolicyID.allowGuests, HostPolicyID.allowUnmute, HostPolicyID.allowVideo,
                   HostPolicyID.allowChat, HostPolicyID.directMessages, HostPolicyID.photos, HostPolicyID.readAloud,
                   HostPolicyID.reactions, HostPolicyID.webinarMode, HostPolicyID.webinarPublic, HostPolicyID.webinarLocked,
                   HostPolicyID.webinarQa] {
            let before = HostControlsPolicy.isOn(id, inputs: previous)
            let after = HostControlsPolicy.isOn(id, inputs: next)
            if before == after || requested[id.rawValue] != nil { continue }
            parent.stage.announce(kind: after ? PeopleAnnouncementKind.policyOn : PeopleAnnouncementKind.policyOff,
                                  name: id.rawValue)
        }
    }
}
