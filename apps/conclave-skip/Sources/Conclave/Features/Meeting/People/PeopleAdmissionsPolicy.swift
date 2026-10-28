import Foundation

// S50 4 and 5 (PPL-3, shared and pure): admissions (Waiting rows, Admit, Deny, Admit All, Deny All) and the raised
// hands queue's one Lower All, plus the section header actions every surface reads (S50 1 c: Admit All and the Deny
// All overflow on Waiting, Lower All on Raised Hands, Mute All... on In This Meeting or Panelists). The presenter
// publishes `PeopleHeaderActions` as its own stored property, so a pending Admit All re-evaluates the headers only and
// never the list container (S50 4 k). Everything here crosses into handwritten Kotlin: scalar structs and String
// constants, no tuples, no associated values (S1C 3.6).

/// The section header buttons (S50 1 c, 4 c, 4 d, 5 c, 5 d): which show, whether they can be tapped and what is in
/// flight. Hosts and co-hosts only; a guest sees none.
struct PeopleHeaderActions: Equatable {
    /// Waiting: Admit All and the overflow with Deny All show only while two or more people wait (S50 4 c).
    let showsAdmitAll: Bool
    let isAdmitAllEnabled: Bool
    /// The header button shows a spinner and "Admitting..." while true (S50 4 f).
    let admitAllPending: Bool
    let isDenyAllEnabled: Bool
    let denyAllPending: Bool
    /// Raised Hands (meeting only; a webinar host's Raised Hands is the attendee queue, S50 10): one Lower All, no
    /// confirmation (Q4, Q9).
    let showsLowerAll: Bool
    let isLowerAllEnabled: Bool
    let lowerAllPending: Bool
    /// In This Meeting (Panelists in webinar mode): Mute All... opens the Mute Everyone dialog (S50 1 g, 6 g).
    let showsMuteAll: Bool
    let isMuteAllEnabled: Bool
    let muteAllPending: Bool
    /// `MeetingBlockedReason` raw value while recovering or offline ("none" otherwise): the header actions stay visible
    /// and disabled with this reason (S50 4 f, 5 f).
    let reason: String

    static let none = PeopleHeaderActions(showsAdmitAll: false, isAdmitAllEnabled: false, admitAllPending: false,
                                          isDenyAllEnabled: false, denyAllPending: false, showsLowerAll: false,
                                          isLowerAllEnabled: false, lowerAllPending: false, showsMuteAll: false,
                                          isMuteAllEnabled: false, muteAllPending: false,
                                          reason: MeetingBlockedReason.none.rawValue)

    /// The header of `sectionId` carries at least one action button.
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
    /// Ledger keys (PH2, S50 4 j): `admit:<waiting key>`, `deny:<waiting key>` per row, one key each for the bulk
    /// admissions; Lower All and the header Mute All share the Host Controls bulk keys, so the Host Controls rows show
    /// the same pending state and a tap on either surface is single flight.
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

    /// Any admission in flight (one row's Admit or Deny, Admit All, Deny All): the S20 knock banner's Admit or Admit
    /// All stays visible but disabled meanwhile, so a second tap there cannot race the first.
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

    /// One waiting row (S50 PL2, 4 c to 4 f). `pendingAction` is the row's own Admit or Deny ("" when none); while
    /// Admit All or Deny All is in flight every row is disabled ("In Progress") without its own spinner; recovering or
    /// offline disables both buttons with that reason.
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

    /// The header actions for the current roster (S50 1 c, 4 c, 5 c). `rosterCount` counts the people in In This
    /// Meeting (you included): Mute All shows only when someone besides you is there. `showsMeetingHands` is false in
    /// the webinar host branch, where Raised Hands is the attendee queue.
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

    /// S50 4 f: a stale entry (the server no longer has that pending id) leaves silently; the row is already gone or
    /// leaves with the next pending list, so no failure, banner, snackbar or token is posted.
    static func isSilentFailure(kind: PeopleCommandKind, failure: String) -> Bool {
        (kind == PeopleCommandKind.admit || kind == PeopleCommandKind.deny) && failure == HostActionFailure.notFound.rawValue
    }

    /// Requests in `current` whose ids were not waiting before (S50 4 i: a new knock while Participants is open is
    /// announced once). Order follows `current`.
    static func newRequests(previous: [String], current: [PeopleWaitingInput]) -> [PeopleWaitingInput] {
        var result: [PeopleWaitingInput] = []
        for request in current {
            if !previous.contains(request.id) { result.append(request) }
        }
        return result
    }

    /// The failure slot of a header bulk action: the section it started from (S50 PL14 inline at its source).
    static func isHeaderBulkSource(_ sourceKey: String) -> Bool {
        sourceKey == PeopleSectionID.raisedHands.rawValue || sourceKey == PeopleSectionID.inMeeting.rawValue
            || sourceKey == PeopleSectionID.panelists.rawValue
    }
}
