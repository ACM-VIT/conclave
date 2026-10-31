import Foundation

enum ControlBarPolicy {

    static func layout(width: ControlsWindowClass, height: ControlsWindowClass, isPhone: Bool, isAttendee: Bool) -> ControlBarLayout {
        let axis = isPhone && height == ControlsWindowClass.compact ? ControlBarAxis.vertical : ControlBarAxis.horizontal
        if isAttendee {
            return ControlBarLayout(composition: ControlBarComposition.attendee, axis: axis)
        }
        if width == ControlsWindowClass.regular && height == ControlsWindowClass.regular {
            return ControlBarLayout(composition: ControlBarComposition.wide, axis: axis)
        }
        return ControlBarLayout(composition: ControlBarComposition.compact, axis: axis)
    }

    static func order(_ composition: ControlBarComposition) -> [CallControlKind] {
        switch composition {
        case .compact:
            return [CallControlKind.microphone, CallControlKind.camera, CallControlKind.chat, CallControlKind.more, CallControlKind.leave]
        case .wide:
            return [CallControlKind.microphone, CallControlKind.camera, CallControlKind.screenShare, CallControlKind.hand,
                    CallControlKind.chat, CallControlKind.participants, CallControlKind.more, CallControlKind.leave]
        case .attendee:
            return [CallControlKind.hand, CallControlKind.qa, CallControlKind.leave]
        }
    }

    static func meetingControlID(_ kind: CallControlKind) -> MeetingControlID? {
        switch kind {
        case .microphone: return MeetingControlID.microphone
        case .camera: return MeetingControlID.camera
        case .screenShare: return MeetingControlID.screenShare
        case .hand: return MeetingControlID.hand
        case .chat: return MeetingControlID.chat
        case .participants: return MeetingControlID.participants
        case .leave: return MeetingControlID.leave
        case .qa, .more: return nil
        }
    }

    static func panel(_ kind: CallControlKind) -> MeetingPanel? {
        switch kind {
        case .chat: return MeetingPanel.chat
        case .participants: return MeetingPanel.participants
        case .qa: return MeetingPanel.webinarQA
        default: return nil
        }
    }

    static func visual(kind: CallControlKind, isOn: Bool) -> CallControlVisual {
        switch kind {
        case .microphone, .camera:
            return isOn ? CallControlVisual.on : CallControlVisual.off
        case .screenShare, .hand, .chat, .participants, .qa:
            return isOn ? CallControlVisual.engaged : CallControlVisual.on
        case .more, .leave:
            return CallControlVisual.on
        }
    }

    static func gestureKind(_ model: CallControlModel) -> FeedbackKind? {
        switch model.kind {
        case .microphone: return model.isOn ? FeedbackKind.micOff : FeedbackKind.micOn
        case .camera: return model.isOn ? FeedbackKind.cameraOff : FeedbackKind.cameraOn
        case .hand: return model.isOn ? FeedbackKind.handLowered : FeedbackKind.handRaised
        default: return nil
        }
    }

    static func controlReason(_ blocked: MeetingBlockedReason) -> ControlBlockedReason {
        ControlBlockedReason(rawValue: blocked.rawValue) ?? ControlBlockedReason.none
    }

    static func explains(_ reason: ControlBlockedReason) -> Bool {
        switch reason {
        case .reconnecting, .offline, .remoteShareActive, .audioOnly, .disabledByHost:
            return true
        default:
            return false
        }
    }

    static func explanationActionId(_ reason: ControlBlockedReason) -> String {
        reason == ControlBlockedReason.audioOnly ? NoticeAction.turnOffAudioOnly : ""
    }

    static func explanationNotice(_ explanation: ControlExplanation) -> MeetingNotice {
        var actions: [NoticeAction] = []
        if !explanation.actionId.isEmpty {
            actions.append(NoticeAction.make(explanation.actionId))
        }
        return MeetingNotice.make(kind: NoticeKind.blockedExplanation, userId: explanation.kind.rawValue, name: explanation.reasonName,
                                  actions: actions, detail: explanation.reason.rawValue)
    }

    static func explanation(fromNotice notice: MeetingNotice) -> ControlExplanation? {
        guard notice.kind == NoticeKind.blockedExplanation, let kind = CallControlKind(rawValue: notice.userId) else { return nil }
        let reason = ControlBlockedReason(rawValue: notice.detail) ?? ControlBlockedReason.none
        let actionId = notice.actions.first?.id ?? ""
        return ControlExplanation(id: 0, kind: kind, reason: reason, reasonName: notice.name, actionId: actionId)
    }

    static func control(_ kind: CallControlKind, inputs: CallControlsInputs, composition: ControlBarComposition) -> CallControlModel? {
        let leaving = inputs.phase == MeetingPhaseKind.leaving
        switch kind {
        case .microphone, .camera:
            guard let id = meetingControlID(kind), let row = inputs.row(id), row.isVisible else { return nil }
            var reason = ControlBarPolicy.controlReason(row.blockedReason)
            var blocked = !row.isEnabled
            let hostDisabled = kind == CallControlKind.microphone ? inputs.isMicDisabledByHost : inputs.isCameraDisabledByHost

            if hostDisabled && !row.isOn && !blocked {
                blocked = true
                reason = ControlBlockedReason.disabledByHost
            }

            let shortcut = kind == CallControlKind.microphone ? MediaShortcutPolicy.microphoneHasShortcut(inputs: inputs)
                                                              : MediaShortcutPolicy.cameraHasShortcut(inputs: inputs)
            return model(kind, isOn: row.isOn, blocked: blocked, pending: row.isPending, reason: reason, name: "",
                         appliesAfterReconnect: row.hint == MeetingControlHint.appliesAfterReconnect, badge: 0, dot: false,
                         shortcut: shortcut)
        case .screenShare:
            guard let row = inputs.row(MeetingControlID.screenShare), row.isVisible else { return nil }
            let reason = ControlBarPolicy.controlReason(row.blockedReason)
            let name = reason == ControlBlockedReason.remoteShareActive ? inputs.presenterName : ""
            return model(kind, isOn: row.isOn, blocked: !row.isEnabled, pending: row.isPending, reason: reason, name: name,
                         appliesAfterReconnect: false, badge: 0, dot: false)
        case .hand:
            guard let row = inputs.row(MeetingControlID.hand) else { return nil }
            if composition == ControlBarComposition.attendee {

                guard inputs.attendeeCanRaiseHand else { return nil }
                return model(kind, isOn: row.isOn, blocked: leaving, pending: row.isPending,
                             reason: leaving ? ControlBlockedReason.leaving : ControlBlockedReason.none, name: "",
                             appliesAfterReconnect: false, badge: 0, dot: false)
            }
            guard row.isVisible else { return nil }
            return model(kind, isOn: row.isOn, blocked: !row.isEnabled, pending: row.isPending,
                         reason: ControlBarPolicy.controlReason(row.blockedReason), name: "", appliesAfterReconnect: false, badge: 0, dot: false)
        case .chat, .participants:
            guard let id = meetingControlID(kind), let row = inputs.row(id), row.isVisible else { return nil }
            let engaged = isCurrent(kind, inputs: inputs)

            var count = kind == CallControlKind.participants && !inputs.isLocalHost ? 0 : max(0, row.badgeCount)
            if engaged { count = 0 }
            return model(kind, isOn: engaged, blocked: !row.isEnabled, pending: false,
                         reason: ControlBarPolicy.controlReason(row.blockedReason), name: "", appliesAfterReconnect: false,
                         badge: count, dot: false)
        case .qa:
            guard inputs.isWebinarAttendee, inputs.isWebinarQaEnabled else { return nil }
            let engaged = isCurrent(kind, inputs: inputs)
            return model(kind, isOn: engaged, blocked: leaving, pending: false,
                         reason: leaving ? ControlBlockedReason.leaving : ControlBlockedReason.none, name: "",
                         appliesAfterReconnect: false, badge: engaged ? 0 : max(0, inputs.webinarQaUnseen), dot: false)
        case .more:
            if inputs.isWebinarAttendee { return nil }

            var count = 0
            if composition != ControlBarComposition.wide && inputs.isLocalHost {
                count = max(0, inputs.row(MeetingControlID.participants)?.badgeCount ?? 0)
            }
            return model(kind, isOn: false, blocked: leaving, pending: false,
                         reason: leaving ? ControlBlockedReason.leaving : ControlBlockedReason.none, name: "",
                         appliesAfterReconnect: false, badge: count,
                         dot: count == 0 && (inputs.moreAttention || MoreMenuPolicy.hasAttention(inputs)))
        case .leave:
            guard let row = inputs.row(MeetingControlID.leave) else { return nil }

            let hostMenu = inputs.row(MeetingControlID.endForEveryone)?.isVisible ?? false
            return CallControlModel(id: kind.rawValue, kind: kind, isOn: false, visual: CallControlVisual.on, isBlocked: !row.isEnabled,
                                    isPending: row.isPending, reason: ControlBarPolicy.controlReason(row.blockedReason), reasonName: "",
                                    appliesAfterReconnect: false, badgeCount: 0, showsDot: false,
                                    hasShortcut: hostMenu)
        }
    }

    static func chatMovedWithUnread(inputs: CallControlsInputs, overflowIds: [String]) -> Bool {
        overflowIds.contains(CallControlKind.chat.rawValue) && (inputs.row(MeetingControlID.chat)?.badgeCount ?? 0) > 0
    }

    static func withMoreDot(_ snapshot: ControlBarSnapshot) -> ControlBarSnapshot {
        var controls: [CallControlModel] = []
        for model in snapshot.controls {
            if model.kind == CallControlKind.more && model.badgeCount == 0 && !model.showsDot {
                controls.append(CallControlModel(id: model.id, kind: model.kind, isOn: model.isOn, visual: model.visual,
                                                 isBlocked: model.isBlocked, isPending: model.isPending, reason: model.reason,
                                                 reasonName: model.reasonName,
                                                 appliesAfterReconnect: model.appliesAfterReconnect,
                                                 badgeCount: model.badgeCount, showsDot: true, hasShortcut: model.hasShortcut))
            } else {
                controls.append(model)
            }
        }
        return ControlBarSnapshot(revision: snapshot.revision, composition: snapshot.composition, axis: snapshot.axis,
                                  controls: controls)
    }

    static func bar(inputs: CallControlsInputs, layout: ControlBarLayout, revision: Int) -> ControlBarSnapshot {
        var controls: [CallControlModel] = []
        for kind in order(layout.composition) {
            if let model = control(kind, inputs: inputs, composition: layout.composition) {
                controls.append(model)
            }
        }
        return ControlBarSnapshot(revision: revision, composition: layout.composition, axis: layout.axis, controls: controls)
    }

    static func leaveSnapshot(inputs: CallControlsInputs, revision: Int) -> LeaveSnapshot {
        let leaveRow = inputs.row(MeetingControlID.leave)
        let endRow = inputs.row(MeetingControlID.endForEveryone)
        let leaving = inputs.phase == MeetingPhaseKind.leaving || (leaveRow?.isPending ?? false)
        var endPhase = EndPhase.idle
        if inputs.confirmationId > 0 {
            endPhase = EndPhase.confirming
        } else if endRow?.isPending ?? false {
            endPhase = EndPhase.ending
        } else if let failure = endRow?.failure, failure != MeetingActionFailure.none {
            endPhase = EndPhase.failed
        }
        let showsEnd = endRow?.isVisible ?? false
        var endReason = ControlBlockedReason.none
        if let row = endRow, showsEnd, !row.isEnabled {
            endReason = ControlBarPolicy.controlReason(row.blockedReason)
        }
        return LeaveSnapshot(revision: revision, canEndForEveryone: inputs.canEndForEveryone,
                             leavePhase: leaving ? LeavePhase.leaving : LeavePhase.idle, endPhase: endPhase,
                             confirmationId: inputs.confirmationId, confirmationInvoker: inputs.confirmationInvoker,
                             offersRecap: false, endFailure: endRow?.failure.rawValue ?? MeetingActionFailure.none.rawValue,
                             showsEndForEveryone: showsEnd, endBlockedReason: endReason)
    }

    private static func isCurrent(_ kind: CallControlKind, inputs: CallControlsInputs) -> Bool {
        guard let panel = panel(kind) else { return false }
        return inputs.currentPanel == panel.rawValue
    }

    private static func model(_ kind: CallControlKind, isOn: Bool, blocked: Bool, pending: Bool, reason: ControlBlockedReason,
                              name: String, appliesAfterReconnect: Bool, badge: Int, dot: Bool,
                              shortcut: Bool = false) -> CallControlModel {
        CallControlModel(id: kind.rawValue, kind: kind, isOn: isOn, visual: visual(kind: kind, isOn: isOn), isBlocked: blocked,
                         isPending: pending, reason: reason, reasonName: name, appliesAfterReconnect: appliesAfterReconnect,
                         badgeCount: badge, showsDot: dot, hasShortcut: shortcut)
    }

    static let iosRouteSlot = 56.0

    static let androidMaxToolbarWidth = 560.0

    static func moveOrder(_ composition: ControlBarComposition) -> [String] {
        switch composition {
        case .compact:
            return [CallControlKind.chat.rawValue]
        case .wide:
            return [CallControlKind.participants.rawValue, CallControlKind.hand.rawValue, CallControlKind.screenShare.rawValue,
                    CallControlKind.chat.rawValue]
        case .attendee:
            return []
        }
    }

    static func controlIds(_ bar: ControlBarSnapshot) -> [String] {
        var ids: [String] = []
        for model in bar.controls {
            ids.append(model.id)
        }
        return ids
    }

    static func iosPlan(bar: ControlBarSnapshot, width: Double, height: Double, scaledDiameter: Double) -> CompactBarPlan {
        let available = bar.axis == ControlBarAxis.vertical ? height - iosRouteSlot : width
        return CompactBarFit.iosPlan(controlIDs: controlIds(bar), moveOrder: moveOrder(bar.composition),
                                     scaledDiameter: scaledDiameter, available: available)
    }

    static func androidPlan(bar: ControlBarSnapshot, availableWidth: Double) -> CompactBarPlan {
        var toggles: [String] = []
        for model in bar.controls {
            if model.kind != CallControlKind.leave { toggles.append(model.id) }
        }
        let available = availableWidth < androidMaxToolbarWidth ? availableWidth : androidMaxToolbarWidth
        return CompactBarFit.androidPlan(toggleIDs: toggles, moveOrder: moveOrder(bar.composition), available: available)
    }

    static func shownControls(_ bar: ControlBarSnapshot, moved: [String]) -> [CallControlModel] {
        var result: [CallControlModel] = []
        for model in bar.controls {
            if !moved.contains(model.id) { result.append(model) }
        }
        return result
    }

    static func fitReadout(plan: CompactBarPlan, available: Double, composition: ControlBarComposition) -> String {
        "Bar " + String(Int(plan.requiredWidth + 0.5)) + " of " + String(Int(available + 0.5)) + " "
            + composition.rawValue + " target=" + String(Int(plan.targetWidth + 0.5))
            + (plan.moved.isEmpty ? "" : " moved=" + plan.moved.joined(separator: ","))
    }
}

public enum ConclaveWindowMetrics {
    public static let minimumWidth: Double = CompactBarFit.requiredWidth(
        targets: [CompactBarFit.iosMinimumTarget, CompactBarFit.iosMinimumTarget, CompactBarFit.iosMinimumTarget,
                  CompactBarFit.iosMinimumTarget, CompactBarFit.iosMinimumTarget],
        spacing: DesignTokens.space8, padding: CompactBarFit.iosPadding)
}
