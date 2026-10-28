import Foundation

enum PeopleActionPolicy {
    static let sectionPrefix = "people.g"

    static let selfTarget = "self"

    static func actions(_ person: PeopleParticipantInput, role: PersonRole, context: PeopleActionContext,
                        pendingAction: String) -> [PersonActionModel] {
        let viewer = context.viewerRole
        let isSelf = person.isLocal
        let blocked = context.blockedReason
        let isBlocked = blocked != MeetingBlockedReason.none.rawValue
        let hostReason = isBlocked ? blocked : (pendingAction.isEmpty ? PeopleActionReason.none : PeopleActionReason.pending)
        let hostEnabled = hostReason == PeopleActionReason.none
        let isAttendeeTarget = role == PersonRole.attendee
        let hostViewer = viewer.isHostRole && viewer != PersonRole.attendee

        var group0: [PersonActionModel] = []
        if viewer != PersonRole.attendee {
            let pinned = !context.pinnedUserId.isEmpty && context.pinnedUserId == person.userId
            group0.append(item(pinned ? PersonActionID.unpin : PersonActionID.pin, group: 0, reason: PeopleActionReason.none))
        }
        if !isSelf && (context.isDmEnabled || hostViewer) && !isAttendeeTarget {
            group0.append(item(PersonActionID.sendPrivateMessage, group: 0, reason: isBlocked ? blocked : PeopleActionReason.none))
        }
        if !isSelf {
            group0.append(item(person.messagesHidden ? PersonActionID.showMessages : PersonActionID.hideMessages, group: 0,
                               reason: PeopleActionReason.none))
        }
        if isSelf && viewer != PersonRole.attendee {
            var reason = PeopleActionReason.none
            if isBlocked {
                reason = blocked
            } else if context.isRenameDisabled {
                reason = PeopleActionReason.renameDisabled
            } else if context.isRenamePending {
                reason = PeopleActionReason.pending
            }
            group0.append(item(PersonActionID.changeName, group: 0, reason: reason))
        }
        if isSelf && person.isHandRaised {
            group0.append(item(PersonActionID.lowerOwnHand, group: 0, reason: isBlocked ? blocked : PeopleActionReason.none))
        }

        var group1: [PersonActionModel] = []
        var group2: [PersonActionModel] = []
        var group3: [PersonActionModel] = []
        if hostViewer && !isSelf && !isAttendeeTarget {
            if !person.isMuted {
                group1.append(item(PersonActionID.mute, group: 1, reason: hostReason, isSwipe: hostEnabled))
            }
            if !person.isCameraOff {
                group1.append(item(PersonActionID.turnOffCamera, group: 1, reason: hostReason))
            }
            if person.isScreenSharing {
                group1.append(item(PersonActionID.stopScreenShare, group: 1, reason: hostReason))
            }
            if person.hasScreenAudio && !person.isScreenSharing {
                group1.append(item(PersonActionID.stopScreenAudio, group: 1, reason: hostReason))
            }

            if role == PersonRole.participant {
                group2.append(item(PersonActionID.makeCoHost, group: 2, reason: hostReason, needsConfirmation: true))
            }

            if context.isPrimaryHostViewer && (role == PersonRole.coHost || role == PersonRole.participant) {
                group2.append(item(PersonActionID.makeHost, group: 2, reason: hostReason, needsConfirmation: true))
            }

            if context.isWebinarEnabled && context.supportsMoveToAudience && role == PersonRole.participant {
                group2.append(item(PersonActionID.moveToAudience, group: 2, reason: hostReason, isDestructive: true,
                                   needsConfirmation: true))
            }

            if !(viewer == PersonRole.coHost && role == PersonRole.host) {
                group3.append(item(PersonActionID.remove, group: 3, reason: hostReason, isDestructive: true,
                                   needsConfirmation: true, isSwipe: hostEnabled))
            }
        }

        var result: [PersonActionModel] = []
        if hostViewer && !group1.isEmpty {
            result.append(contentsOf: group1)
            result.append(contentsOf: group0)
        } else {
            result.append(contentsOf: group0)
            result.append(contentsOf: group1)
        }
        result.append(contentsOf: group2)
        result.append(contentsOf: group3)
        return result
    }

    private static func item(_ action: PersonActionID, group: Int, reason: String, isDestructive: Bool = false,
                             needsConfirmation: Bool = false, isSwipe: Bool = false) -> PersonActionModel {
        PersonActionModel(action: action, group: group, isEnabled: reason == PeopleActionReason.none, reason: reason,
                          isDestructive: isDestructive, needsConfirmation: needsConfirmation, isSwipe: isSwipe)
    }

    static func groupOrder(_ actions: [PersonActionModel]) -> [Int] {
        var order: [Int] = []
        for action in actions {
            if !order.contains(action.group) { order.append(action.group) }
        }
        return order
    }

    static func tileActions(_ actions: [PersonActionModel]) -> [PersonActionModel] {
        var result: [PersonActionModel] = []
        for action in actions {
            if action.action != PersonActionID.admit && action.action != PersonActionID.deny {
                result.append(action)
            }
        }
        return result
    }

    static func swipeActions(_ actions: [PersonActionModel]) -> [PersonActionModel] {
        var mute: [PersonActionModel] = []
        var remove: [PersonActionModel] = []
        for action in actions {
            if !action.isSwipe || !action.isEnabled { continue }
            if action.action == PersonActionID.mute { mute.append(action) }
            if action.action == PersonActionID.remove { remove.append(action) }
        }
        return mute + remove
    }

    static func availableActions(_ actions: [PersonActionModel]) -> [PersonActionModel] {
        var result: [PersonActionModel] = []
        for action in actions {
            if action.isEnabled { result.append(action) }
        }
        return result
    }

    static func menuSections(_ actions: [PersonActionModel], titles: PeopleActionTitles) -> [MenuSectionModel] {
        var sections: [MenuSectionModel] = []
        var currentGroup = -1
        var items: [MenuItemModel] = []
        for action in actions {
            if action.group != currentGroup {
                if !items.isEmpty {
                    sections.append(MenuSectionModel(id: sectionPrefix + String(currentGroup), items: iconConsistent(items)))
                }
                items = []
                currentGroup = action.group
            }
            items.append(MenuItemModel(id: action.action.rawValue, title: title(action.action, titles: titles),
                                       concept: concept(action.action),
                                       role: action.isDestructive ? MenuItemRole.destructive : MenuItemRole.normal,
                                       isOn: false, isEnabled: action.isEnabled,
                                       disabledReason: action.isEnabled ? "" : reasonText(action.reason, titles: titles)))
        }
        if !items.isEmpty {
            sections.append(MenuSectionModel(id: sectionPrefix + String(currentGroup), items: iconConsistent(items)))
        }
        return sections
    }

    private static func iconConsistent(_ items: [MenuItemModel]) -> [MenuItemModel] {
        var complete = true
        for item in items {
            if item.concept.isEmpty { complete = false }
        }
        if complete { return items }
        var result: [MenuItemModel] = []
        for item in items {
            result.append(MenuItemModel(id: item.id, title: item.title, concept: "", role: item.role, isOn: item.isOn,
                                        isEnabled: item.isEnabled, disabledReason: item.disabledReason))
        }
        return result
    }

    static func title(_ action: PersonActionID, titles: PeopleActionTitles) -> String {
        switch action {
        case .pin: return titles.pin
        case .unpin: return titles.unpin
        case .sendPrivateMessage: return titles.sendPrivateMessage
        case .hideMessages: return titles.hideMessages
        case .showMessages: return titles.showMessages
        case .changeName: return titles.changeName
        case .lowerOwnHand: return titles.lowerHand
        case .mute: return titles.mute
        case .turnOffCamera: return titles.turnOffCamera
        case .stopScreenShare: return titles.stopScreenShare
        case .stopScreenAudio: return titles.stopScreenAudio
        case .makeCoHost: return titles.makeCoHost
        case .makeHost: return titles.makeHost
        case .moveToAudience: return titles.moveToAudience
        case .remove: return titles.remove
        case .admit, .deny, .bringOnStage, .cancelStageInvite: return ""
        }
    }

    static func reasonText(_ reason: String, titles: PeopleActionTitles) -> String {
        switch reason {
        case PeopleActionReason.reconnecting: return titles.reasonReconnecting
        case PeopleActionReason.offline: return titles.reasonOffline
        case PeopleActionReason.notJoined: return titles.reasonNotJoined
        case PeopleActionReason.pending: return titles.reasonPending
        case PeopleActionReason.renameDisabled: return titles.reasonRenameDisabled
        default: return ""
        }
    }

    static func concept(_ action: PersonActionID) -> String {
        switch action {
        case .pin: return "pin"
        case .unpin: return "unpin"
        case .sendPrivateMessage: return "private_message"
        case .mute: return "mute_person"
        case .turnOffCamera: return "camera_off_person"
        case .stopScreenShare: return "stop_sharing"
        case .makeCoHost, .makeHost: return "host"
        case .remove: return "remove_person"
        case .hideMessages: return "hide_sender"
        case .showMessages: return "visibility"
        case .changeName: return "change_name"
        case .lowerOwnHand: return "lower_hand"
        case .stopScreenAudio: return "speaker_off"
        case .moveToAudience: return "move_to_audience"
        case .admit: return "admit"
        case .deny: return "request_declined"
        case .bringOnStage: return "bring_on_stage"
        case .cancelStageInvite: return "close"
        }
    }

    static func confirmationKind(_ action: PersonActionID) -> PeopleConfirmationKind? {
        switch action {
        case .remove: return PeopleConfirmationKind.remove
        case .makeCoHost: return PeopleConfirmationKind.makeCoHost
        case .makeHost: return PeopleConfirmationKind.makeHost
        case .moveToAudience: return PeopleConfirmationKind.moveToAudience
        default: return nil
        }
    }

    static func commandKind(_ action: PersonActionID) -> PeopleCommandKind? {
        switch action {
        case .mute: return PeopleCommandKind.mute
        case .turnOffCamera: return PeopleCommandKind.turnOffCamera
        case .stopScreenShare: return PeopleCommandKind.stopScreenShare
        case .stopScreenAudio: return PeopleCommandKind.stopScreenAudio
        case .remove: return PeopleCommandKind.remove
        case .makeCoHost: return PeopleCommandKind.makeCoHost
        case .makeHost: return PeopleCommandKind.makeHost
        case .moveToAudience: return PeopleCommandKind.moveToAudience
        case .admit: return PeopleCommandKind.admit
        case .deny: return PeopleCommandKind.deny
        case .bringOnStage: return PeopleCommandKind.bringOnStage
        case .cancelStageInvite: return PeopleCommandKind.cancelStageInvite
        case .pin, .unpin, .sendPrivateMessage, .hideMessages, .showMessages, .changeName, .lowerOwnHand:
            return nil
        }
    }

    static func ledgerKey(_ kind: PeopleCommandKind, target: String) -> String {
        kind.rawValue + ":" + target
    }

    static func rowPendingAction(_ keyKind: String) -> String {
        if keyKind == PeopleCommandKind.block.rawValue { return PersonActionID.remove.rawValue }
        if PersonActionID(rawValue: keyKind) != nil { return keyKind }
        return ""
    }

    static func isGuestUserId(_ userId: String) -> Bool {
        let key = userId.components(separatedBy: "#").first ?? userId
        return key.hasPrefix("guest-")
    }
}
