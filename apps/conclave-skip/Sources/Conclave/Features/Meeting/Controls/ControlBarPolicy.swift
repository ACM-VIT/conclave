import Foundation

// S30 1 j and 7 (CTL-1): the pure bar policy both platforms and both test hosts read. Composition and axis from the
// window (0.6, D25, D27, RECONCILE R7), the fixed order (1 c), the visual and gesture mapping (CL1, CL20, 1 h), the
// blocked-action matrix for the bar (7, BlockedReasonPolicy rules 1 to 5), and the fit arithmetic on top of the WP1-2b
// `CompactBarFit` (PN A1). No view and no presenter state: every function takes values and returns values.

enum ControlBarPolicy {
    /// Composition and axis (S30 0.6): attendee first, wide only when neither dimension is compact (iPad regular x
    /// regular; Android 600 dp wide and 480 dp tall, Q13), compact otherwise. The trailing vertical stack is the iPhone
    /// compact-height form only (D27).
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

    /// Reading order per composition (S30 1 b, 1 i); Leave is always last.
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

    /// The S1 row behind a control; Q&A and More have none.
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

    /// The panel a bar invoker opens (S30 1 a); nil for toggles, More and Leave.
    static func panel(_ kind: CallControlKind) -> MeetingPanel? {
        switch kind {
        case .chat: return MeetingPanel.chat
        case .participants: return MeetingPanel.participants
        case .qa: return MeetingPanel.webinarQA
        default: return nil
        }
    }

    /// CL1 and CL20: Mic and Camera draw on or off; Raise Hand and Share Screen draw On while idle and Engaged while
    /// active, never Off (Off is reserved for a muted mic or a camera that is off); invokers draw Engaged while their
    /// panel is current; More and Leave draw On (More's Engaged state while its sheet shows is view-local).
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

    /// S30 1 h: the gesture kind a tap plays, from `isOn` before the tap (the intended new state), so the optimistic
    /// mic and the non-optimistic hand give the same answer. Nil for Share (outcome tokens), invokers, More and Leave.
    static func gestureKind(_ model: CallControlModel) -> FeedbackKind? {
        switch model.kind {
        case .microphone: return model.isOn ? FeedbackKind.micOff : FeedbackKind.micOn
        case .camera: return model.isOn ? FeedbackKind.cameraOff : FeedbackKind.cameraOn
        case .hand: return model.isOn ? FeedbackKind.handLowered : FeedbackKind.handRaised
        default: return nil
        }
    }

    /// The S1 reason in the controls vocabulary (same raw values).
    static func controlReason(_ blocked: MeetingBlockedReason) -> ControlBlockedReason {
        ControlBlockedReason(rawValue: blocked.rawValue) ?? ControlBlockedReason.none
    }

    /// Q11 and the S30 7 reason copy: the reasons a blocked bar tap explains with a toast. Permission reasons open the
    /// alert or the system prompt instead; interruption and hold leave it to the S20 banners (R29); the rest
    /// (not joined, attendee, unsupported, host only, leaving, ending) are silent.
    static func explains(_ reason: ControlBlockedReason) -> Bool {
        switch reason {
        case .reconnecting, .offline, .remoteShareActive, .audioOnly, .disabledByHost:
            return true
        default:
            return false
        }
    }

    /// The toast action an explanation offers (S30 7: audio-only offers Turn Off, S20 `turnOffAudioOnly`).
    static func explanationActionId(_ reason: ControlBlockedReason) -> String {
        reason == ControlBlockedReason.audioOnly ? NoticeAction.turnOffAudioOnly : ""
    }

    /// S30 CC7: the STG-5 local toast for an explanation. Toast lane, info, no presenter expiry (the platform host times
    /// toasts); the notice center assigns the id. The lanes read the copy back through `explanation(fromNotice:)`:
    /// `userId` carries the control, `detail` the reason, `name` the presenter, the one action the Turn Off button.
    static func explanationNotice(_ explanation: ControlExplanation) -> MeetingNotice {
        var actions: [NoticeAction] = []
        if !explanation.actionId.isEmpty {
            actions.append(NoticeAction.make(explanation.actionId))
        }
        return MeetingNotice.make(kind: NoticeKind.blockedExplanation, userId: explanation.kind.rawValue, name: explanation.reasonName,
                                  actions: actions, detail: explanation.reason.rawValue)
    }

    /// The explanation a `blockedExplanation` notice carries (the lanes resolve its copy with the controls tables:
    /// iOS `CallControlsCopy.toast`, Android `callControlToast`). Nil for any other notice or an unknown control.
    static func explanation(fromNotice notice: MeetingNotice) -> ControlExplanation? {
        guard notice.kind == NoticeKind.blockedExplanation, let kind = CallControlKind(rawValue: notice.userId) else { return nil }
        let reason = ControlBlockedReason(rawValue: notice.detail) ?? ControlBlockedReason.none
        let actionId = notice.actions.first?.id ?? ""
        return ControlExplanation(id: 0, kind: kind, reason: reason, reasonName: notice.name, actionId: actionId)
    }

    /// One control in a composition, or nil when it is hidden (S30 7: an absent capability hides the control instead of
    /// blocking it: unsupported share, Q&A turned off, the attendee hand without its capability, an attendee's media).
    static func control(_ kind: CallControlKind, inputs: CallControlsInputs, composition: ControlBarComposition) -> CallControlModel? {
        let leaving = inputs.phase == MeetingPhaseKind.leaving
        switch kind {
        case .microphone, .camera:
            guard let id = meetingControlID(kind), let row = inputs.row(id), row.isVisible else { return nil }
            var reason = ControlBarPolicy.controlReason(row.blockedReason)
            var blocked = !row.isEnabled
            let hostDisabled = kind == CallControlKind.microphone ? inputs.isMicDisabledByHost : inputs.isCameraDisabledByHost
            // CC10: the host policy blocks only a tap toward live or on; the server already turns live media off.
            if hostDisabled && !row.isOn && !blocked {
                blocked = true
                reason = ControlBlockedReason.disabledByHost
            }
            // CTL-4 (S30 2): the Mic long press (the iOS menu, the Android route sheet) and the Camera long press when one
            // of its items can act.
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
                // S20 Q10: the attendee hand exists only with its capability (PPL-5 adds the server path).
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
            // The waiting count is host information; the badge hides while the panel is open (1 f).
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
            // Compact: the host waiting count rides on More because Participants is not on the bar (1 f). The dot (CTL-5)
            // marks an open vote, live notes needing attention or unseen webinar questions behind More.
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
            // CTL-2: the host Leave menu exists whenever the host's End row does, also while End is blocked (S30 4 f).
            let hostMenu = inputs.row(MeetingControlID.endForEveryone)?.isVisible ?? false
            return CallControlModel(id: kind.rawValue, kind: kind, isOn: false, visual: CallControlVisual.on, isBlocked: !row.isEnabled,
                                    isPending: row.isPending, reason: ControlBarPolicy.controlReason(row.blockedReason), reasonName: "",
                                    appliesAfterReconnect: false, badgeCount: 0, showsDot: false,
                                    hasShortcut: hostMenu)
        }
    }

    /// The bar for a layout: the composition's controls in order, hidden ones dropped (positions of the rest never
    /// move between recovery and normal, S30 7 acceptance).
    /// CHT-8 (HD request B6-T5 R4; S30 5 m, F00 C05 f): the fit moved Chat into More while it has unread messages.
    static func chatMovedWithUnread(inputs: CallControlsInputs, overflowIds: [String]) -> Bool {
        overflowIds.contains(CallControlKind.chat.rawValue) && (inputs.row(MeetingControlID.chat)?.badgeCount ?? 0) > 0
    }

    /// The bar with More's dot on, unless More already shows a badge (a count hides the dot, S30 1 f). The dot never
    /// changes the fit, so this cannot loop.
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

    /// CTL-2's Leave and End state from the S1 rows and confirmation (R09: Leave stays available while End is pending
    /// or failed; `postingRecap` waits for CC8, so `offersRecap` stays false until TRN-2). `showsEndForEveryone` and
    /// `endBlockedReason` come from the S1 End row, so a recovering host keeps the menu with End disabled (S30 4 f).
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

    // MARK: Fit (S30 1 c, 1 d; F00 C05; PN A1 CompactBarFit)

    /// The iOS route control sits above the vertical stack (S20 7): 44 pt plus 12 pt.
    static let iosRouteSlot = 56.0
    /// The Android toolbar never grows past 560 dp (S30 CL4).
    static let androidMaxToolbarWidth = 560.0

    /// What moves to More when even the minimum targets do not fit (F00 C05 f): Chat on the compact bar (S30 1 d);
    /// on the wide bar the controls More already carries in the compact composition, then Chat. Leave never moves.
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

    /// iOS (S30 1 c sizes): every control, Leave included, is one circle; `space12`, then `space8`, then the move order.
    /// Horizontal against the chrome layer width; vertical against its height minus the route slot.
    static func iosPlan(bar: ControlBarSnapshot, width: Double, height: Double, scaledDiameter: Double) -> CompactBarPlan {
        let available = bar.axis == ControlBarAxis.vertical ? height - iosRouteSlot : width
        return CompactBarFit.iosPlan(controlIDs: controlIds(bar), moveOrder: moveOrder(bar.composition),
                                     scaledDiameter: scaledDiameter, available: available)
    }

    /// Android (S30 1 d widths): 48 or 56 dp toggles from the available width, a 72 dp Leave that never moves, the
    /// 1 dp divider, 8 dp padding and spacing, at most 560 dp.
    static func androidPlan(bar: ControlBarSnapshot, availableWidth: Double) -> CompactBarPlan {
        var toggles: [String] = []
        for model in bar.controls {
            if model.kind != CallControlKind.leave { toggles.append(model.id) }
        }
        let available = availableWidth < androidMaxToolbarWidth ? availableWidth : androidMaxToolbarWidth
        return CompactBarFit.androidPlan(toggleIDs: toggles, moveOrder: moveOrder(bar.composition), available: available)
    }

    /// The controls the bar draws after the fit (moved ones live in More, CTL-5).
    static func shownControls(_ bar: ControlBarSnapshot, moved: [String]) -> [CallControlModel] {
        var result: [CallControlModel] = []
        for model in bar.controls {
            if !moved.contains(model.id) { result.append(model) }
        }
        return result
    }

    /// The `controls.bar` readout (CL13): "Bar W of A" with the composition and the target size, ASCII digits.
    static func fitReadout(plan: CompactBarPlan, available: Double, composition: ControlBarComposition) -> String {
        "Bar " + String(Int(plan.requiredWidth + 0.5)) + " of " + String(Int(available + 0.5)) + " "
            + composition.rawValue + " target=" + String(Int(plan.targetWidth + 0.5))
            + (plan.moved.isEmpty ? "" : " moved=" + plan.moved.joined(separator: ","))
    }
}

/// S20 SC14 (IOS 20.3): the narrowest iPad window, where the compact bar still keeps every control at the 44 pt floor
/// with the 8 pt fallback spacing and the 12 pt insets (2 x 12 + 5 x 44 + 4 x 8 = 276 pt). Public because the Darwin
/// app scene reads it for `windowResizability(.contentMinSize)`; iPhones are always wider, so it never constrains one.
public enum ConclaveWindowMetrics {
    public static let minimumWidth: Double = CompactBarFit.requiredWidth(
        targets: [CompactBarFit.iosMinimumTarget, CompactBarFit.iosMinimumTarget, CompactBarFit.iosMinimumTarget,
                  CompactBarFit.iosMinimumTarget, CompactBarFit.iosMinimumTarget],
        spacing: DesignTokens.space8, padding: CompactBarFit.iosPadding)
}
