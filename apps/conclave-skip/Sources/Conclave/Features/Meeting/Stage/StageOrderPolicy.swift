import Foundation

struct StageSlotPlanInputs: Equatable {
    let kind: StageKind
    let isCompactPortrait: Bool
    let capacity: StageCapacity
    let localUserId: String

    let remoteOrder: [String]
    let participants: [StageParticipantInput]
    let pinnedUserId: String
    let featuredUserId: String
    let presenterUserId: String
    let selfViewMode: String
    let webinarSpeakerUserId: String

    let fitOverrides: [String: String]
    var viewMode: String = ""
    var hasActivitySurface: Bool = false
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

enum StageOrderPolicy {
    static let promotionDelayMillis = 1200.0
    static let swapIntervalMillis = 8000.0
    static let minimumParticipantsForSwap = 4

    static let neverSwappedMillis = -1_000_000_000_000.0

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
            if !ids.contains(participant.userId) { ids.append(participant.userId) }
        }
        return ids
    }

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

    static func applyHideFilter(_ order: [String], participants: [StageParticipantInput], hideTilesWithoutVideo: Bool,
                                featuredUserId: String, pinnedUserId: String) -> [String] {
        if !hideTilesWithoutVideo { return order }
        var result: [String] = []
        for id in order {
            let row = participant(id, in: participants)
            let cameraOff = row?.isCameraOff ?? true
            let sharing = row?.isScreenSharing ?? false
            if !cameraOff || sharing || id == featuredUserId || id == pinnedUserId { result.append(id) }
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

    static func resolvedSelfRole(_ inputs: StageSlotPlanInputs) -> StageSlotRole? {
        if let role = selfRole(selfViewMode: inputs.selfViewMode, kind: inputs.kind) { return role }
        let pinnedOneOnOne = inputs.kind == StageKind.spotlight && inputs.viewMode == "auto" && inputs.selfViewMode != "tile" &&
            inputs.presenterUserId.isEmpty && !inputs.hasActivitySurface && joinOrder(inputs.participants).count == 1
        return pinnedOneOnOne ? StageSlotRole.selfFloating : nil
    }

    static func defaultFeatured(remoteOrder: [String], presenterUserId: String, localUserId: String) -> String {
        if !presenterUserId.isEmpty && presenterUserId != localUserId { return presenterUserId }
        return remoteOrder.first ?? ""
    }

    static func plan(_ inputs: StageSlotPlanInputs) -> StageSlotPlan {
        let local = participant(inputs.localUserId, in: inputs.participants)
        let hasLocal = local != nil && !(local?.isLeaving ?? true)
        let localRole: StageSlotRole? = hasLocal ? StageOrderPolicy.resolvedSelfRole(inputs) : nil
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
            let main = TileFeaturePolicy.spotlightMainUserId(pinnedUserId: inputs.pinnedUserId,
                                                             featuredUserId: inputs.featuredUserId,
                                                             remoteOrder: inputs.remoteOrder,
                                                             participants: inputs.participants,
                                                             localUserId: inputs.localUserId)
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
        if let role = localRole, hasLocal, inputs.kind != StageKind.oneOnOne,
           !TileFeaturePolicy.containsSlot(slots, id: StageSlot.participantId(inputs.localUserId)) {
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

    static func visibleRemoteIds(_ slots: [StageSlot], localUserId: String) -> [String] {
        var ids: [String] = []
        for slot in slots {
            if slot.id.hasPrefix("p:") && slot.userId != localUserId && !ids.contains(slot.userId) {
                ids.append(slot.userId)
            }
        }
        return ids
    }

    static func isCapped(_ kind: StageKind) -> Bool {
        switch kind {
        case .grid, .spotlight, .sidebar, .presentation, .game, .app, .browser:
            return true
        case .solo, .oneOnOne, .attendeeWaiting, .attendeeLive:
            return false
        }
    }

    static func unmeasuredCapacity(kind: StageKind, viewMaxTiles: Int) -> StageCapacity {
        if !isCapped(kind) { return StageCapacity.zero }
        let tiles = MeetingViewConstants.clampTiles(viewMaxTiles)
        if kind == StageKind.grid { return StageCapacity(gridSlots: tiles, railSlots: 0) }
        return StageCapacity(gridSlots: 0, railSlots: tiles)
    }

    static func replan(_ inputs: StageInputs, kind: StageKind, capacity: StageCapacity, isCompactPortrait: Bool,
                       featuredUserId: String, speakerUserId: String) -> StageSlotPlan {
        let present = inputs.presentParticipants
        let order = reconcile(previous: [], participants: present)
        var featured = featuredUserId
        if featured.isEmpty || !order.contains(featured) {
            featured = defaultFeatured(remoteOrder: order, presenterUserId: inputs.screenShareUserId, localUserId: inputs.localUserId)
        }
        let filtered = applyHideFilter(order, participants: present, hideTilesWithoutVideo: inputs.hideTilesWithoutVideo,
                                       featuredUserId: speakerUserId, pinnedUserId: inputs.pinnedUserId)
        return plan(StageSlotPlanInputs(
            kind: kind,
            isCompactPortrait: isCompactPortrait,
            capacity: capacity,
            localUserId: inputs.localUserId,
            remoteOrder: filtered,
            participants: present,
            pinnedUserId: inputs.pinnedUserId,
            featuredUserId: featured,
            presenterUserId: inputs.screenShareUserId,
            selfViewMode: inputs.selfViewMode,
            webinarSpeakerUserId: inputs.webinarSpeakerUserId,
            fitOverrides: [:],
            viewMode: inputs.viewMode,
            hasActivitySurface: !inputs.activeAppId.isEmpty || inputs.isBrowserActive
        ))
    }

    static func consumerFallbackRemoteIds(layout: StageLayoutSnapshot, inputs: StageInputs, speakerUserId: String) -> [String] {
        if !isCapped(layout.kind) || layout.capacity != StageCapacity.zero {
            return visibleRemoteIds(layout.slots, localUserId: inputs.localUserId)
        }
        let planned = replan(inputs, kind: layout.kind,
                             capacity: unmeasuredCapacity(kind: layout.kind, viewMaxTiles: inputs.viewMaxTiles),
                             isCompactPortrait: false, featuredUserId: layout.featuredUserId, speakerUserId: speakerUserId)
        return visibleRemoteIds(planned.slots, localUserId: inputs.localUserId)
    }

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

    static func promotionDelay(nowMillis: Double, speakerSinceMillis: Double, lastSwapMillis: Double) -> Double {
        let hold = speakerSinceMillis + promotionDelayMillis - nowMillis
        let interval = lastSwapMillis + swapIntervalMillis - nowMillis
        return max(0.0, max(hold, interval))
    }

    static func mayPromote(nowMillis: Double, speakerSinceMillis: Double, lastSwapMillis: Double) -> Bool {
        nowMillis - speakerSinceMillis >= promotionDelayMillis - 0.5 && nowMillis - lastSwapMillis >= swapIntervalMillis - 0.5
    }
}
