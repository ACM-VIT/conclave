import Foundation

/// The inputs `StageOrderPolicy.plan` needs to turn an ordered roster into slots (one struct so the call stays
/// readable on both platforms; no tuples).
struct StageSlotPlanInputs: Equatable {
    let kind: StageKind
    let isCompactPortrait: Bool
    let capacity: StageCapacity
    let localUserId: String
    /// Remote ids in display order (join order, then promotions), already filtered by "hide tiles without video".
    let remoteOrder: [String]
    let participants: [StageParticipantInput]
    let pinnedUserId: String
    let featuredUserId: String
    let presenterUserId: String
    let selfViewMode: String
    let webinarSpeakerUserId: String
    /// SC4: per-session fit overrides, user id to `StageVideoFit` raw value.
    let fitOverrides: [String: String]
}

struct StageRailPlan: Equatable {
    let slots: [StageSlot]
    let hidden: [String]
    let overflowCount: Int
}

struct StageSlotPlan: Equatable {
    let slots: [StageSlot]
    let overflowCount: Int
    let overflowSeeds: [String]
}

/// S20 SL2: stable stage order. Join order comes from the core (`MeetingState.participantJoinSerials`, S50 PH19,
/// RECONCILE R20); you sit last (S20 Q3); presenters lead strips; nothing reorders while everyone fits. Past the cap a
/// hidden participant who keeps speaking for 1.2 s takes the slot of the visible remote who spoke longest ago, at most
/// once per 8 s and only with 4 or more people (web STG-07). Timing lives in the presenter's single promotion task;
/// these functions are pure.
enum StageOrderPolicy {
    static let promotionDelayMillis = 1200.0
    static let swapIntervalMillis = 8000.0
    static let minimumParticipantsForSwap = 4
    /// Before the first swap the interval rule never blocks.
    static let neverSwappedMillis = -1_000_000_000_000.0

    // MARK: Order

    /// Remote ids by join serial, ties by id; an id the core has not numbered yet (serial 0) sorts last.
    static func joinOrder(_ participants: [StageParticipantInput]) -> [String] {
        var remotes: [StageParticipantInput] = []
        for participant in participants {
            if !participant.isLocal && !participant.isLeaving { remotes.append(participant) }
        }
        let sorted = remotes.sorted { a, b in
            let left = a.joinSerial > 0 ? a.joinSerial : Int.max
            let right = b.joinSerial > 0 ? b.joinSerial : Int.max
            if left != right { return left < right }
            return a.userId < b.userId
        }
        var ids: [String] = []
        for participant in sorted {
            ids.append(participant.userId)
        }
        return ids
    }

    /// Keeps the previous display order for people still present, drops people who left and appends newcomers in join
    /// order, so a join never moves a visible slot (S20 2 c "no reordering while everyone fits").
    static func reconcile(previous: [String], participants: [StageParticipantInput]) -> [String] {
        let joined = joinOrder(participants)
        var result: [String] = []
        for id in previous {
            if joined.contains(id) && !result.contains(id) { result.append(id) }
        }
        for id in joined {
            if !result.contains(id) { result.append(id) }
        }
        return result
    }

    /// Exchanges two ids in the display order.
    static func swapped(_ order: [String], promote: String, demote: String) -> [String] {
        var result = order
        var promoteIndex = -1
        var demoteIndex = -1
        var index = 0
        for id in order {
            if id == promote { promoteIndex = index }
            if id == demote { demoteIndex = index }
            index += 1
        }
        if promoteIndex < 0 || demoteIndex < 0 { return order }
        result[promoteIndex] = demote
        result[demoteIndex] = promote
        return result
    }

    /// "Hide tiles without video" (web STG-41): camera-off people leave the stage except the featured speaker and the
    /// pin; if nobody has video the first remote stays. Audio is never touched by this filter (D16, SC6).
    static func applyHideFilter(_ order: [String], participants: [StageParticipantInput], hideTilesWithoutVideo: Bool,
                                featuredUserId: String, pinnedUserId: String) -> [String] {
        if !hideTilesWithoutVideo { return order }
        var result: [String] = []
        for id in order {
            let cameraOff = participant(id, in: participants)?.isCameraOff ?? true
            if !cameraOff || id == featuredUserId || id == pinnedUserId { result.append(id) }
        }
        if result.isEmpty, let first = order.first {
            result.append(first)
        }
        return result
    }

    static func participant(_ userId: String, in participants: [StageParticipantInput]) -> StageParticipantInput? {
        for participant in participants {
            if participant.userId == userId { return participant }
        }
        return nil
    }

    /// The self view role for the local person, or nil when they are an ordinary tile (S20 2 c: Auto floats you only in
    /// 1:1 without a share; the self tile sits in the strip over an activity, never floating over a game).
    static func selfRole(selfViewMode: String, kind: StageKind) -> StageSlotRole? {
        if kind == StageKind.solo || kind.isActivity || kind == StageKind.attendeeLive || kind == StageKind.attendeeWaiting {
            return nil
        }
        switch selfViewMode {
        case "floating": return StageSlotRole.selfFloating
        case "minimized": return StageSlotRole.selfMinimized
        case "tile": return nil
        default: return kind == StageKind.oneOnOne ? StageSlotRole.selfFloating : nil
        }
    }

    /// Featured speaker fallback before anyone spoke: the presenter, then the first remote in display order.
    static func defaultFeatured(remoteOrder: [String], presenterUserId: String, localUserId: String) -> String {
        if !presenterUserId.isEmpty && presenterUserId != localUserId { return presenterUserId }
        return remoteOrder.first ?? ""
    }

    // MARK: Slots

    static func plan(_ inputs: StageSlotPlanInputs) -> StageSlotPlan {
        let local = participant(inputs.localUserId, in: inputs.participants)
        let hasLocal = local != nil && !(local?.isLeaving ?? true)
        let localRole: StageSlotRole? = hasLocal ? StageOrderPolicy.selfRole(selfViewMode: inputs.selfViewMode, kind: inputs.kind) : nil
        var slots: [StageSlot] = []
        var overflowCount = 0
        var hidden: [String] = []
        switch inputs.kind {
        case .solo:
            if hasLocal {
                slots.append(person(inputs.localUserId, role: StageSlotRole.spotlightMain, inputs: inputs))
            }
        case .oneOnOne:
            if let remote = inputs.remoteOrder.first {
                slots.append(person(remote, role: StageSlotRole.spotlightMain, inputs: inputs))
            }
            if hasLocal {
                slots.append(person(inputs.localUserId, role: localRole ?? StageSlotRole.selfFloating, inputs: inputs))
            }
        case .grid:
            var tiles: [String] = inputs.remoteOrder
            if hasLocal && localRole == nil { tiles.append(inputs.localUserId) }
            let cap = max(2, inputs.capacity.gridSlots)
            var shown: [String] = tiles
            if tiles.count > cap {
                // cap - 1 people plus "+N"; you stay second to last (S20 2 c "above the cap").
                let localIsTile = hasLocal && localRole == nil
                let remoteRoom = cap - 1 - (localIsTile ? 1 : 0)
                shown = []
                var index = 0
                for id in inputs.remoteOrder {
                    if index < remoteRoom { shown.append(id) } else { hidden.append(id) }
                    index += 1
                }
                if localIsTile { shown.append(inputs.localUserId) }
                overflowCount = hidden.count
            }
            let wide = inputs.isCompactPortrait && overflowCount == 0 && shown.count >= 3 && shown.count % 2 == 1
            var index = 0
            for id in shown {
                let role = (wide && index == 0) ? StageSlotRole.gridWide : StageSlotRole.grid
                slots.append(person(id, role: role, inputs: inputs))
                index += 1
            }
            if overflowCount > 0 {
                slots.append(StageSlot(id: StageSlot.overflowId, role: StageSlotRole.overflow, userId: "", fit: StageVideoFit.fill))
            }
        case .spotlight, .sidebar:
            let main = !inputs.pinnedUserId.isEmpty && participant(inputs.pinnedUserId, in: inputs.participants) != nil
                ? inputs.pinnedUserId
                : (inputs.featuredUserId.isEmpty ? (inputs.remoteOrder.first ?? inputs.localUserId) : inputs.featuredUserId)
            slots.append(person(main, role: StageSlotRole.spotlightMain, inputs: inputs))
            var rail: [StageSlot] = []
            if !inputs.presenterUserId.isEmpty {
                rail.append(StageSlot(id: StageSlot.shareId(inputs.presenterUserId), role: StageSlotRole.rail,
                                      userId: inputs.presenterUserId, fit: StageVideoFit.fit))
            }
            for id in inputs.remoteOrder {
                if id != main { rail.append(person(id, role: StageSlotRole.rail, inputs: inputs)) }
            }
            if hasLocal && localRole == nil && main != inputs.localUserId {
                rail.append(person(inputs.localUserId, role: StageSlotRole.rail, inputs: inputs))
            }
            let railResult = railSlots(rail, localUserId: inputs.localUserId, capacity: inputs.capacity.railSlots)
            for slot in railResult.slots {
                slots.append(slot)
            }
            for id in railResult.hidden {
                hidden.append(id)
            }
            overflowCount = railResult.overflowCount
        case .presentation:
            slots.append(StageSlot(id: StageSlot.shareId(inputs.presenterUserId), role: StageSlotRole.share,
                                   userId: inputs.presenterUserId, fit: fit(for: StageSlot.shareId(inputs.presenterUserId), inputs: inputs, fallback: StageVideoFit.fit)))
            var rail: [StageSlot] = []
            var ordered: [String] = []
            if inputs.presenterUserId != inputs.localUserId && inputs.remoteOrder.contains(inputs.presenterUserId) {
                ordered.append(inputs.presenterUserId)
            }
            for id in inputs.remoteOrder {
                if !ordered.contains(id) { ordered.append(id) }
            }
            for id in ordered {
                rail.append(person(id, role: StageSlotRole.rail, inputs: inputs))
            }
            if hasLocal && localRole == nil {
                rail.append(person(inputs.localUserId, role: StageSlotRole.rail, inputs: inputs))
            }
            let railResult = railSlots(rail, localUserId: inputs.localUserId, capacity: inputs.capacity.railSlots)
            for slot in railResult.slots {
                slots.append(slot)
            }
            for id in railResult.hidden {
                hidden.append(id)
            }
            overflowCount = railResult.overflowCount
        case .game, .app, .browser:
            slots.append(StageSlot(id: StageSlot.activityId, role: StageSlotRole.activity, userId: "", fit: StageVideoFit.fill))
            var rail: [StageSlot] = []
            for id in inputs.remoteOrder {
                rail.append(person(id, role: StageSlotRole.rail, inputs: inputs))
            }
            if hasLocal {
                rail.append(person(inputs.localUserId, role: StageSlotRole.rail, inputs: inputs))
            }
            let railResult = railSlots(rail, localUserId: inputs.localUserId, capacity: inputs.capacity.railSlots)
            for slot in railResult.slots {
                slots.append(slot)
            }
            for id in railResult.hidden {
                hidden.append(id)
            }
            overflowCount = railResult.overflowCount
        case .attendeeLive:
            if !inputs.webinarSpeakerUserId.isEmpty {
                slots.append(StageSlot(id: StageSlot.participantId(inputs.webinarSpeakerUserId), role: StageSlotRole.programFeed,
                                       userId: inputs.webinarSpeakerUserId, fit: StageVideoFit.fit))
            }
        case .attendeeWaiting:
            break
        }
        if let role = localRole, hasLocal, inputs.kind != StageKind.oneOnOne {
            slots.append(person(inputs.localUserId, role: role, inputs: inputs))
        }
        var seeds: [String] = []
        for id in hidden {
            if seeds.count >= TileChromePolicy.overflowAvatarLimit { break }
            let row = participant(id, in: inputs.participants)
            seeds.append(FacehashPresentation.seed(name: row?.displayName ?? "", id: id))
        }
        return StageSlotPlan(slots: slots, overflowCount: overflowCount, overflowSeeds: seeds)
    }

    /// Rail slots up to `capacity`; past it, the first capacity - 2 others, then you (the last visible slot before
    /// "+N", S20 Q3; over an activity you are always in the strip), then "+N".
    static func railSlots(_ rail: [StageSlot], localUserId: String, capacity: Int) -> StageRailPlan {
        var localSlot: StageSlot? = nil
        var others: [StageSlot] = []
        for slot in rail {
            if slot.userId == localUserId && slot.id.hasPrefix("p:") {
                localSlot = slot
            } else {
                others.append(slot)
            }
        }
        let cap = max(localSlot == nil ? 1 : 2, capacity)
        if rail.count <= cap {
            return StageRailPlan(slots: rail, hidden: [], overflowCount: 0)
        }
        let room = cap - 1 - (localSlot == nil ? 0 : 1)
        var shown: [StageSlot] = []
        var hidden: [String] = []
        var hiddenCount = 0
        var index = 0
        for slot in others {
            if index < room {
                shown.append(slot)
            } else {
                hiddenCount += 1
                if !slot.userId.isEmpty && !hidden.contains(slot.userId) { hidden.append(slot.userId) }
            }
            index += 1
        }
        if let local = localSlot {
            shown.append(local)
        }
        shown.append(StageSlot(id: StageSlot.overflowId, role: StageSlotRole.overflow, userId: "", fit: StageVideoFit.fill))
        return StageRailPlan(slots: shown, hidden: hidden, overflowCount: hiddenCount)
    }

    static func person(_ userId: String, role: StageSlotRole, inputs: StageSlotPlanInputs) -> StageSlot {
        let id = StageSlot.participantId(userId)
        return StageSlot(id: id, role: role, userId: userId, fit: fit(for: id, inputs: inputs, fallback: StageVideoFit.fill))
    }

    static func fit(for slotId: String, inputs: StageSlotPlanInputs, fallback: StageVideoFit) -> StageVideoFit {
        if let raw = inputs.fitOverrides[slotId], let fit = StageVideoFit(rawValue: raw) {
            return fit
        }
        return fallback
    }

    /// Remote ids shown in a participant slot (grid, rail, main), for promotion and visibility.
    static func visibleRemoteIds(_ slots: [StageSlot], localUserId: String) -> [String] {
        var ids: [String] = []
        for slot in slots {
            if slot.id.hasPrefix("p:") && slot.userId != localUserId && !ids.contains(slot.userId) {
                ids.append(slot.userId)
            }
        }
        return ids
    }

    // MARK: Featured speaker and promotion (hysteresis 1.2 s and 8 s)

    /// The visible remote whose last speech is oldest (never spoke counts as oldest; ties to the highest join serial).
    /// Protected ids (the pin, the presenter) never leave.
    static func swapTarget(visibleRemoteIds: [String], lastSpokeAt: [String: Double], participants: [StageParticipantInput],
                           protected: [String]) -> String? {
        var best: String? = nil
        var bestSpoke = 1.0e300
        var bestSerial = -1
        for id in visibleRemoteIds {
            if protected.contains(id) { continue }
            let spoke = lastSpokeAt[id] ?? -1.0
            let serial = participant(id, in: participants)?.joinSerial ?? 0
            if spoke < bestSpoke || (spoke == bestSpoke && serial > bestSerial) {
                best = id
                bestSpoke = spoke
                bestSerial = serial
            }
        }
        return best
    }

    /// How long the promotion task waits: until the speaker has held the floor for 1.2 s and 8 s have passed since
    /// the last swap.
    static func promotionDelay(nowMillis: Double, speakerSinceMillis: Double, lastSwapMillis: Double) -> Double {
        let hold = speakerSinceMillis + promotionDelayMillis - nowMillis
        let interval = lastSwapMillis + swapIntervalMillis - nowMillis
        return max(0.0, max(hold, interval))
    }

    /// Whether a swap or featured change may fire now (re-checked when the task wakes).
    static func mayPromote(nowMillis: Double, speakerSinceMillis: Double, lastSwapMillis: Double) -> Bool {
        nowMillis - speakerSinceMillis >= promotionDelayMillis - 0.5 && nowMillis - lastSwapMillis >= swapIntervalMillis - 0.5
    }
}
