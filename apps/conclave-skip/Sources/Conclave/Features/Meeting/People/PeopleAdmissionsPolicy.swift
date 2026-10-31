import Foundation

struct PeopleHeaderActions: Equatable {

    let showsAdmitAll: Bool
    let isAdmitAllEnabled: Bool

    let admitAllPending: Bool
    let isDenyAllEnabled: Bool
    let denyAllPending: Bool

    let showsLowerAll: Bool
    let isLowerAllEnabled: Bool
    let lowerAllPending: Bool

    let showsMuteAll: Bool
    let isMuteAllEnabled: Bool
    let muteAllPending: Bool

    let reason: String

    static let none = PeopleHeaderActions(showsAdmitAll: false, isAdmitAllEnabled: false, admitAllPending: false,
                                          isDenyAllEnabled: false, denyAllPending: false, showsLowerAll: false,
                                          isLowerAllEnabled: false, lowerAllPending: false, showsMuteAll: false,
                                          isMuteAllEnabled: false, muteAllPending: false,
                                          reason: MeetingBlockedReason.none.rawValue)

    func hasActions(_ sectionId: String) -> Bool {
        if sectionId == PeopleSectionID.waiting.rawValue { return showsAdmitAll }
        if sectionId == PeopleSectionID.raisedHands.rawValue { return showsLowerAll }
        if sectionId == PeopleSectionID.inMeeting.rawValue || sectionId == PeopleSectionID.panelists.rawValue {
            return showsMuteAll
        }
        return false
    }
}

enum PeopleAdmissionsPolicy {

    static let admitAllKey = "admitAll:" + PeopleSectionID.waiting.rawValue
    static let denyAllKey = "denyAll:" + PeopleSectionID.waiting.rawValue
    static let lowerAllKey = HostControlsPolicy.bulkKey(HostBulkID.lowerAllHands)
    static let muteAllKey = HostControlsPolicy.bulkKey(HostBulkID.muteAll)

    static func admitKey(_ rowKey: String) -> String {
        PeopleActionPolicy.ledgerKey(PeopleCommandKind.admit, target: rowKey)
    }

    static func denyKey(_ rowKey: String) -> String {
        PeopleActionPolicy.ledgerKey(PeopleCommandKind.deny, target: rowKey)
    }

    static func hasAdmissionPending(_ pendingKeys: [String]) -> Bool {
        let admitPrefix = PeopleCommandKind.admit.rawValue + ":" + PeopleOrderPolicy.waitingPrefix
        let denyPrefix = PeopleCommandKind.deny.rawValue + ":" + PeopleOrderPolicy.waitingPrefix
        for key in pendingKeys {
            if key == admitAllKey || key == denyAllKey || key.hasPrefix(admitPrefix) || key.hasPrefix(denyPrefix) {
                return true
            }
        }
        return false
    }

    static func waitingRow(_ request: PeopleWaitingInput, pendingAction: String, blockedReason: String,
                           bulkPending: Bool) -> WaitingRowModel {
        let base = PeopleRowPolicy.waitingModel(request, isEnabled: true, reason: PeopleActionReason.none)
        var reason = PeopleActionReason.none
        if blockedReason != MeetingBlockedReason.none.rawValue {
            reason = blockedReason
        } else if bulkPending || !pendingAction.isEmpty {
            reason = PeopleActionReason.pending
        }
        return WaitingRowModel(id: base.id, serverId: base.serverId, name: base.name, avatarSeed: base.avatarSeed,
                               pendingAction: pendingAction, isEnabled: reason == PeopleActionReason.none, reason: reason)
    }

    static func headerActions(viewerIsHost: Bool, blockedReason: String, waitingCount: Int, showsMeetingHands: Bool,
                              rosterCount: Int, pendingKeys: [String]) -> PeopleHeaderActions {
        if !viewerIsHost { return PeopleHeaderActions.none }
        let available = blockedReason == MeetingBlockedReason.none.rawValue
        let admitAllPending = pendingKeys.contains(admitAllKey)
        let denyAllPending = pendingKeys.contains(denyAllKey)
        let lowerAllPending = pendingKeys.contains(lowerAllKey)
        let muteAllPending = pendingKeys.contains(muteAllKey)
        let bulkAdmission = admitAllPending || denyAllPending
        return PeopleHeaderActions(
            showsAdmitAll: waitingCount > 1,
            isAdmitAllEnabled: available && !bulkAdmission,
            admitAllPending: admitAllPending,
            isDenyAllEnabled: available && !bulkAdmission,
            denyAllPending: denyAllPending,
            showsLowerAll: showsMeetingHands,
            isLowerAllEnabled: available && !lowerAllPending,
            lowerAllPending: lowerAllPending,
            showsMuteAll: rosterCount > 1,
            isMuteAllEnabled: available && !muteAllPending,
            muteAllPending: muteAllPending,
            reason: blockedReason
        )
    }

    static func isSilentFailure(kind: PeopleCommandKind, failure: String) -> Bool {
        (kind == PeopleCommandKind.admit || kind == PeopleCommandKind.deny) && failure == HostActionFailure.notFound.rawValue
    }

    static func newRequests(previous: [String], current: [PeopleWaitingInput]) -> [PeopleWaitingInput] {
        var result: [PeopleWaitingInput] = []
        for request in current {
            if !previous.contains(request.id) { result.append(request) }
        }
        return result
    }

    static func isHeaderBulkSource(_ sourceKey: String) -> Bool {
        sourceKey == PeopleSectionID.raisedHands.rawValue || sourceKey == PeopleSectionID.inMeeting.rawValue
            || sourceKey == PeopleSectionID.panelists.rawValue
    }
}
