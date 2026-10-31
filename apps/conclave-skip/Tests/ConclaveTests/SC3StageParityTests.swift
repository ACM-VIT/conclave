#if !SKIP
import Foundation
import Testing
@testable import Conclave

enum SC3Ids {
    static let localId = "you@parity.test#you-session"

    static func remoteId(_ index: Int) -> String {
        bareId(index) + "#s" + padded(index)
    }

    static func bareId(_ index: Int) -> String {
        "p" + padded(index) + "@parity.test"
    }

    static func padded(_ index: Int) -> String {
        let number = index + 1
        return number < 10 ? "0" + String(number) : String(number)
    }

    static func short(_ id: String) -> String {
        id.components(separatedBy: "@").first ?? id
    }
}

struct SC3Fixture: CustomStringConvertible {
    static let local = -1

    let count: Int
    var viewMode = MeetingViewMode.auto
    var selfViewMode = MeetingSelfViewMode.auto
    var viewMaxTiles = MeetingViewConstants.defaultMaxTiles
    var hideTilesWithoutVideo = false
    var reverseJoin = false
    var cameraOff: Set<Int> = []
    var unmuted: Set<Int> = []
    var hands: Set<Int> = []
    var pinned: Int? = nil
    var sharer: Int? = nil
    var speaker: Int? = nil
    var localCameraOn = true
    var aliases: Set<Int> = []
    var staleSharer: Int? = nil

    init(count: Int) {
        self.count = count
    }

    var remoteCount: Int { max(0, count - 1) }

    func with(_ change: (inout SC3Fixture) -> Void) -> SC3Fixture {
        var copy = self
        change(&copy)
        return copy
    }

    var description: String {
        var parts = ["n=" + String(count), "view=" + viewMode.rawValue, "self=" + selfViewMode.rawValue, "max=" + String(viewMaxTiles)]
        if hideTilesWithoutVideo { parts.append("hide") }
        if reverseJoin { parts.append("reverse") }
        if !cameraOff.isEmpty { parts.append("off=" + cameraOff.sorted().map { String($0) }.joined(separator: ",")) }
        if let pinned { parts.append("pin=" + String(pinned)) }
        if let sharer { parts.append("share=" + String(sharer)) }
        if let speaker { parts.append("speaker=" + String(speaker)) }
        if !aliases.isEmpty { parts.append("alias=" + aliases.sorted().map { String($0) }.joined(separator: ",")) }
        if let staleSharer { parts.append("stale=" + String(staleSharer)) }
        return parts.joined(separator: " ")
    }
}

struct SC3Shape: Equatable, CustomStringConvertible {
    static let overflowMark = "+N"

    let kind: String
    let main: String
    let tiles: [String]
    let overflow: Int
    let selfPlacement: String

    var description: String {
        kind + " main=" + SC3Ids.short(main) + " tiles=" + tiles.map { SC3Ids.short($0) }.joined(separator: ",")
            + " overflow=" + String(overflow) + " self=" + selfPlacement
    }
}

struct SC3Planned {
    let kind: StageKind
    let capacity: StageCapacity
    let plan: StageSlotPlan
}

struct SC3Capped {
    let tiles: [String]
    let overflow: Int
}

struct SC3Viewport {
    let name: String
    let viewport: StageViewport
}

struct SC3LayoutFields: Equatable {
    let rows: [String]
    let viewMode: String
    let viewMaxTiles: Int
    let hideTilesWithoutVideo: Bool
    let selfViewMode: String
    let pinnedUserId: String
    let screenShareUserId: String
    let isLocalScreenSharing: Bool
    let activeAppId: String
    let isBrowserActive: Bool
    let isWebinarAttendee: Bool
    let webinarSpeakerUserId: String
}

@MainActor
enum SC3Parity {
    static let viewports = [
        SC3Viewport(name: "375x667", viewport: StagePoliciesTests.iphoneSE),
        SC3Viewport(name: "390x844", viewport: StagePoliciesTests.iphone17e),
        SC3Viewport(name: "800x360", viewport: StagePoliciesTests.androidLandscape),
        SC3Viewport(name: "820x1180", viewport: StagePoliciesTests.ipadPortrait),
    ]

    static func id(_ index: Int) -> String {
        index == SC3Fixture.local ? SC3Ids.localId : SC3Ids.remoteId(index)
    }

    static func sweep() -> [SC3Fixture] {
        var result: [SC3Fixture] = []
        for count in 1...16 {
            let remotes = max(0, count - 1)
            let mixed = Set((0..<remotes).filter { $0 % 3 == 1 })
            let everyone = Set(0..<remotes)
            let middle = max(0, (count - 1) / 2)
            let base = SC3Fixture(count: count)
            result.append(base)
            result.append(base.with { $0.reverseJoin = true; $0.cameraOff = mixed })
            result.append(base.with { $0.viewMode = .tiled; $0.reverseJoin = true })
            result.append(base.with { $0.viewMode = .spotlight; $0.reverseJoin = true; $0.cameraOff = mixed })
            result.append(base.with { $0.viewMode = .sidebar })
            result.append(base.with { $0.viewMode = .tiled; $0.selfViewMode = .floating })
            result.append(base.with { $0.selfViewMode = .minimized; $0.reverseJoin = true })
            if count != 2 {
                result.append(base.with { $0.selfViewMode = .tile })
            }
            result.append(base.with { $0.hideTilesWithoutVideo = true; $0.reverseJoin = true; $0.cameraOff = mixed })
            result.append(base.with { $0.hideTilesWithoutVideo = true; $0.reverseJoin = true; $0.cameraOff = everyone })
            result.append(base.with { $0.viewMaxTiles = 9; $0.reverseJoin = true })
            result.append(base.with { $0.viewMode = .tiled; $0.viewMaxTiles = 2 })
            result.append(base.with { $0.pinned = SC3Fixture.local })
            result.append(base.with { $0.sharer = SC3Fixture.local })
            result.append(base.with { $0.staleSharer = SC3Fixture.local })
            if count >= 2 {
                result.append(base.with { $0.aliases = everyone; $0.cameraOff = mixed })
                result.append(base.with { $0.staleSharer = middle; $0.reverseJoin = true })
                result.append(base.with { $0.pinned = middle; $0.reverseJoin = true })
                result.append(base.with { $0.pinned = middle; $0.hideTilesWithoutVideo = true; $0.cameraOff = everyone })
                result.append(base.with { $0.sharer = 0; $0.reverseJoin = true; $0.cameraOff = mixed })
                result.append(base.with { $0.sharer = middle; $0.selfViewMode = .floating })
                result.append(base.with { $0.viewMode = .tiled; $0.pinned = middle })
            }
            if count >= 3 {
                result.append(base.with { $0.pinned = 1; $0.sharer = 0 })
                result.append(base.with { $0.pinned = SC3Fixture.local; $0.sharer = 0; $0.reverseJoin = true })
            }
        }
        return result
    }

    static func state(_ fixture: SC3Fixture) -> MeetingState {
        let state = MeetingState(userId: SC3Ids.localId, sessionId: "you-session")
        state.sfuUserId = "you@parity.test"
        state.displayName = "You"
        state.connectionState = ConnectionState.joined
        state.viewMode = fixture.viewMode
        state.selfViewMode = fixture.selfViewMode
        state.viewMaxTiles = fixture.viewMaxTiles
        state.hideTilesWithoutVideo = fixture.hideTilesWithoutVideo
        state.isCameraOff = !fixture.localCameraOn
        var roster: [String: Participant] = [:]
        for index in 0..<fixture.remoteCount {
            let remote = SC3Ids.remoteId(index)
            roster[remote] = Participant(id: remote, displayName: "Guest " + String(index + 1),
                                         isMuted: !fixture.unmuted.contains(index),
                                         isCameraOff: fixture.cameraOff.contains(index),
                                         isHandRaised: fixture.hands.contains(index),
                                         isScreenSharing: fixture.sharer == index)
        }
        for index in fixture.aliases where index < fixture.remoteCount {
            let bare = SC3Ids.bareId(index)
            roster[bare] = Participant(id: bare, displayName: "Guest " + String(index + 1))
        }
        state.participants = roster
        let joinIndexes: [Int] = fixture.reverseJoin ? Array((0..<fixture.remoteCount).reversed()) : Array(0..<fixture.remoteCount)
        for index in joinIndexes {
            state.assignParticipantJoinSerial(SC3Ids.remoteId(index))
        }
        if let pinned = fixture.pinned {
            state.pinnedUserId = id(pinned)
        }
        if let sharer = fixture.sharer {
            if sharer == SC3Fixture.local { state.isScreenSharing = true }
            state.activeScreenShareUserId = id(sharer)
        }
        if let stale = fixture.staleSharer {
            state.activeScreenShareUserId = id(stale)
        }
        if let speaker = fixture.speaker {
            state.activeSpeakerId = id(speaker)
        }
        return state
    }

    static func inputs(_ state: MeetingState) -> StageInputs {
        let localId = state.userId
        var rows: [StageParticipantInput] = []
        rows.append(StageParticipantInput.make(userId: localId, displayName: "You", isLocal: true, isMuted: state.isMuted,
                                               isCameraOff: state.isCameraOff, isHandRaised: state.isHandRaised,
                                               isScreenSharing: state.isScreenSharing, isHost: state.isAdmin))
        var seen = Set<String>()
        for rawId in state.participants.keys.sorted() {
            guard let raw = state.participants[rawId], !raw.isLeaving,
                  let canonical = state.canonicalStageUserId(rawId), canonical != localId, !seen.contains(canonical) else { continue }
            seen.insert(canonical)
            let participant = state.participant(for: canonical) ?? raw
            rows.append(StageParticipantInput.make(userId: canonical, displayName: participant.displayName ?? "",
                                                   isMuted: participant.isMuted, isCameraOff: participant.isCameraOff,
                                                   isHandRaised: participant.isHandRaised,
                                                   isScreenSharing: participant.isScreenSharing,
                                                   joinSerial: state.participantJoinSerials[canonical] ?? 0))
        }
        let presenter = state.isScreenSharing ? localId : (state.canonicalStageUserId(state.presentationScreenShareUserId) ?? "")
        return StageInputs.make(callSession: 1, isInCall: true, localUserId: localId, roomLabel: "parity", participants: rows,
                                viewMode: state.viewMode.rawValue, viewMaxTiles: state.viewMaxTiles,
                                hideTilesWithoutVideo: state.hideTilesWithoutVideo, selfViewMode: state.selfViewMode.rawValue,
                                selfViewCorner: state.selfViewCorner.rawValue,
                                pinnedUserId: state.canonicalStageUserId(state.pinnedUserId) ?? "",
                                activeAppId: state.activeAppId ?? "", isBrowserActive: state.isBrowserActive,
                                screenShareUserId: presenter, isLocalScreenSharing: state.isScreenSharing,
                                isWebinarAttendee: state.isWebinarAttendee,
                                webinarSpeakerUserId: state.canonicalStageUserId(state.webinarSpeakerUserId) ?? "")
    }

    static func speaker(_ state: MeetingState) -> String {
        state.canonicalStageUserId(state.effectiveActiveSpeakerId) ?? ""
    }

    static func planned(_ inputs: StageInputs, viewport: StageViewport, speakerUserId: String,
                        showsVideoOverActivity: Bool = false) -> SC3Planned {
        let kind = StageLayoutPolicy.kind(inputs, showsVideoOverActivity: showsVideoOverActivity)
        let capacity = StageLayoutPolicy.capacity(viewport: viewport, kind: kind, count: inputs.presentParticipants.count,
                                                  viewMaxTiles: inputs.viewMaxTiles)
        let plan = StageOrderPolicy.replan(inputs, kind: kind, capacity: capacity,
                                           isCompactPortrait: StageLayoutPolicy.isCompactPortrait(viewport),
                                           featuredUserId: "", speakerUserId: speakerUserId)
        return SC3Planned(kind: kind, capacity: capacity, plan: plan)
    }

    static func presenter(_ inputs: StageInputs, viewport: StageViewport) -> StagePresenter {
        let stage = StagePresenter(shell: MeetingShellPresenter())
        stage.setViewport(viewport)
        stage.apply(inputs)
        return stage
    }

    static func newShape(_ planned: SC3Planned, me: String) -> SC3Shape {
        var main = ""
        var tiles: [String] = []
        var placement = "none"
        for slot in planned.plan.slots {
            switch slot.role {
            case .spotlightMain:
                main = slot.userId
            case .share:
                main = slot.id
            case .grid, .gridWide, .rail:
                tiles.append(slot.id.hasPrefix("share:") ? slot.id : slot.userId)
            case .overflow:
                tiles.append(SC3Shape.overflowMark)
            default:
                break
            }
            if slot.id == StageSlot.participantId(me) {
                switch slot.role {
                case .spotlightMain: placement = "main"
                case .selfFloating: placement = "floating"
                case .selfMinimized: placement = "minimized"
                default: placement = "tile"
                }
            }
        }
        return SC3Shape(kind: planned.kind.rawValue, main: main, tiles: tiles, overflow: planned.plan.overflowCount,
                        selfPlacement: placement)
    }

    static func legacyShape(_ state: MeetingState) -> SC3Shape {
        let me = state.userId
        let count = state.participantCount
        let pinned = state.canonicalStageUserId(state.pinnedUserId) ?? ""
        let selfMode = state.resolvedSelfViewMode
        if state.hasActiveScreenShare {
            let strip = state.tileStripSnapshot()
            var tiles: [String] = strip.shouldShowSelfTile ? [me] : []
            for participant in strip.participants {
                tiles.append(participant.id)
            }
            return legacyShaped("presentation", main: "share:" + (state.presentationScreenShareUserId ?? ""), tiles: tiles,
                                overflow: 0, state: state)
        }
        if state.usesSpotlightLayout {
            let snapshot = state.spotlightSnapshot()
            var kind = state.usesSidebarLayout ? "sidebar" : "spotlight"
            if count == 1 {
                kind = "solo"
            } else if count == 2 && pinned.isEmpty && state.viewMode == .auto && (selfMode == .floating || selfMode == .minimized) {
                kind = "oneOnOne"
            }
            return legacyShaped(kind, main: snapshot.pinnedUserId, tiles: snapshot.railUserIds, overflow: 0, state: state)
        }
        let grid = state.visibleGridSnapshot()
        if count == 1 {
            return legacyShaped("solo", main: me, tiles: [], overflow: 0, state: state)
        }
        return legacyShaped("grid", main: "", tiles: grid.userIds, overflow: grid.hiddenParticipantCount, state: state)
    }

    static func legacyShaped(_ kind: String, main: String, tiles raw: [String], overflow: Int, state: MeetingState) -> SC3Shape {
        let me = state.userId
        var tiles: [String] = []
        for entry in raw {
            tiles.append(entry == MeetingState.overflowTileId ? SC3Shape.overflowMark : entry)
        }
        let placement: String
        if main == me {
            placement = "main"
        } else if tiles.contains(me) {
            placement = "tile"
        } else if state.resolvedSelfViewMode == .floating {
            placement = "floating"
        } else if state.resolvedSelfViewMode == .minimized {
            placement = "minimized"
        } else {
            placement = "none"
        }
        return SC3Shape(kind: kind, main: main, tiles: tiles, overflow: overflow, selfPlacement: placement)
    }

    static func joinOrdered(_ ids: [String], _ state: MeetingState) -> [String] {
        ids.sorted { left, right in
            let a = state.participantJoinSerials[left] ?? Int.max
            let b = state.participantJoinSerials[right] ?? Int.max
            return a != b ? a < b : left < right
        }
    }

    static func isHideFallback(_ state: MeetingState) -> Bool {
        let present = state.presentParticipants
        if !state.hideTilesWithoutVideo || present.isEmpty { return false }
        for participant in present {
            if !participant.isCameraOff || participant.isScreenSharing || state.isEffectiveActiveSpeaker(participant.id)
                || state.isPinnedParticipant(participant.id) {
                return false
            }
        }
        return true
    }

    static func legacyVisible(_ state: MeetingState) -> [String] {
        if isHideFallback(state) {
            return Array(joinOrdered(state.presentParticipants.map { $0.id }, state).prefix(1))
        }
        return state.visibleTileParticipants.map { $0.id }
    }

    static func firstWithVideo(_ ids: [String], _ state: MeetingState) -> String {
        for candidate in ids {
            if let participant = state.participant(for: candidate), !participant.isCameraOff { return candidate }
        }
        return ids.first ?? state.userId
    }

    static func capGrid(remotes: [String], selfTile: Bool, me: String, cap: Int) -> SC3Capped {
        var all = remotes
        if selfTile { all.append(me) }
        let limit = max(2, cap)
        if all.count <= limit { return SC3Capped(tiles: all, overflow: 0) }
        let room = limit - 1 - (selfTile ? 1 : 0)
        var shown = Array(remotes.prefix(room))
        if selfTile { shown.append(me) }
        shown.append(SC3Shape.overflowMark)
        return SC3Capped(tiles: shown, overflow: remotes.count - room)
    }

    static func capRail(others: [String], selfTile: Bool, me: String, cap: Int) -> SC3Capped {
        var all = others
        if selfTile { all.append(me) }
        let limit = max(selfTile ? 2 : 1, cap)
        if all.count <= limit { return SC3Capped(tiles: all, overflow: 0) }
        let room = limit - 1 - (selfTile ? 1 : 0)
        var shown = Array(others.prefix(room))
        if selfTile { shown.append(me) }
        shown.append(SC3Shape.overflowMark)
        return SC3Capped(tiles: shown, overflow: others.count - room)
    }

    static func expectedShape(_ state: MeetingState, inputs: StageInputs, viewport: StageViewport) -> SC3Shape {
        expectedShape(state) { kind in
            StageLayoutPolicy.capacity(viewport: viewport, kind: kind, count: inputs.presentParticipants.count,
                                       viewMaxTiles: inputs.viewMaxTiles)
        }
    }

    static func unmeasuredExpectedShape(_ state: MeetingState, inputs: StageInputs) -> SC3Shape {
        let tiles = MeetingViewConstants.clampTiles(inputs.viewMaxTiles)
        return expectedShape(state) { kind in
            kind == StageKind.grid ? StageCapacity(gridSlots: tiles, railSlots: 0) : StageCapacity(gridSlots: 0, railSlots: tiles)
        }
    }

    static func expectedShape(_ state: MeetingState, capacityFor: (StageKind) -> StageCapacity) -> SC3Shape {
        let me = state.userId
        let legacy = legacyShape(state)
        let pinned = state.canonicalStageUserId(state.pinnedUserId) ?? ""
        let sharer = state.canonicalStageUserId(state.presentationScreenShareUserId) ?? ""
        let pinOverShare = legacy.kind == "presentation" && !pinned.isEmpty && state.participantCount > 1
        let kind = pinOverShare ? "spotlight" : legacy.kind
        var visible = joinOrdered(legacyVisible(state), state)
        if kind == "presentation", let index = visible.firstIndex(of: sharer) {
            visible.remove(at: index)
            visible.insert(sharer, at: 0)
        }
        let capacity = capacityFor(StageKind(rawValue: kind) ?? StageKind.grid)
        switch kind {
        case "solo":
            return SC3Shape(kind: kind, main: me, tiles: [], overflow: 0, selfPlacement: "main")
        case "oneOnOne":
            return SC3Shape(kind: kind, main: visible.first ?? me, tiles: [], overflow: 0, selfPlacement: legacy.selfPlacement)
        case "grid":
            let capped = capGrid(remotes: visible, selfTile: legacy.selfPlacement == "tile", me: me, cap: capacity.gridSlots)
            return SC3Shape(kind: kind, main: "", tiles: capped.tiles, overflow: capped.overflow, selfPlacement: legacy.selfPlacement)
        case "presentation":
            let capped = capRail(others: visible, selfTile: legacy.selfPlacement == "tile", me: me, cap: capacity.railSlots)
            return SC3Shape(kind: kind, main: "share:" + sharer, tiles: capped.tiles, overflow: capped.overflow,
                            selfPlacement: legacy.selfPlacement)
        default:
            let main = pinned.isEmpty ? firstWithVideo(visible, state) : pinned
            let placement = main == me ? "main" : legacy.selfPlacement
            var others: [String] = pinOverShare ? ["share:" + sharer] : []
            for candidate in visible where candidate != main {
                others.append(candidate)
            }
            let capped = capRail(others: others, selfTile: placement == "tile", me: me, cap: capacity.railSlots)
            return SC3Shape(kind: kind, main: main, tiles: capped.tiles, overflow: capped.overflow, selfPlacement: placement)
        }
    }

    static func expectLegacyIsConsistent(_ state: MeetingState, _ fixture: SC3Fixture) {
        let me = state.userId
        let order = state.visibleTileParticipants.map { $0.id }
        if state.hasActiveScreenShare {
            let strip = state.tileStripSnapshot().participants.map { $0.id }
            #expect(strip == Array(order.prefix(strip.count)), "legacy strip \(fixture)")
        } else if state.usesSpotlightLayout {
            let snapshot = state.spotlightSnapshot()
            let rail = snapshot.railUserIds.filter { $0 != me }
            let others = order.filter { $0 != snapshot.pinnedUserId }
            #expect(rail == Array(others.prefix(rail.count)), "legacy rail \(fixture)")
            if state.canonicalStageUserId(state.pinnedUserId) == nil && state.participantCount > 1 {
                #expect(snapshot.pinnedUserId == (order.first ?? me), "legacy main \(fixture)")
            }
        } else {
            let grid = state.visibleGridSnapshot()
            let shown = grid.userIds.filter { $0 != me && $0 != MeetingState.overflowTileId }
            #expect(shown == Array(order.prefix(shown.count)), "legacy grid \(fixture)")
            #expect(shown.count + grid.hiddenParticipantCount == order.count, "legacy hidden count \(fixture)")
        }
    }

    static func legacyConsumerIds(_ state: MeetingState) -> Set<String> {
        var ids = Set<String>()
        var add: [String?] = []
        for entry in state.visibleGridUserIds {
            add.append(entry)
        }
        for participant in state.tileStripSnapshot().participants {
            add.append(participant.id)
        }
        add.append(state.spotlightUserId)
        add.append(state.presentationScreenShareUserId)
        for entry in add {
            if let remote = state.presentRemoteParticipantId(for: entry) { ids.insert(remote) }
        }
        let raw = state.visibleTileParticipants.map { $0.id }
        let normalized = legacyVisible(state)
        if isHideFallback(state), let legacyFirst = raw.first, let joinFirst = normalized.first, legacyFirst != joinFirst {
            ids.remove(legacyFirst)
            ids.insert(joinFirst)
        }
        return ids
    }

    static func fallbackConsumerIds(_ stage: StagePresenter, state: MeetingState) -> Set<String> {
        var ids = Set<String>()
        for entry in StageOrderPolicy.consumerFallbackRemoteIds(layout: stage.layout, inputs: stage.inputs,
                                                                speakerUserId: stage.speakerUserId) {
            if let remote = state.presentRemoteParticipantId(for: entry) { ids.insert(remote) }
        }
        if let share = state.presentRemoteParticipantId(for: state.presentationScreenShareUserId) {
            ids.insert(share)
        }
        return ids
    }

    static func shapeConsumerIds(_ shape: SC3Shape, state: MeetingState) -> Set<String> {
        var entries = [shape.main]
        entries.append(contentsOf: shape.tiles)
        return remoteConsumerIds(entries.filter { $0 != SC3Shape.overflowMark && !$0.hasPrefix("share:") }, state: state)
    }

    static func legacyVisibleConsumerIds(_ state: MeetingState) -> Set<String> {
        remoteConsumerIds(legacyVisible(state), state: state)
    }

    static func remoteConsumerIds(_ entries: [String], state: MeetingState) -> Set<String> {
        var ids = Set<String>()
        for entry in entries {
            if let remote = state.presentRemoteParticipantId(for: entry) { ids.insert(remote) }
        }
        if let share = state.presentRemoteParticipantId(for: state.presentationScreenShareUserId) {
            ids.insert(share)
        }
        return ids
    }

    static func layoutFields(_ inputs: StageInputs) -> SC3LayoutFields {
        var rows: [String] = []
        for row in inputs.participants {
            rows.append([row.userId, String(row.isLocal), String(row.isMuted), String(row.isCameraOff), String(row.isHandRaised),
                         String(row.isScreenSharing), String(row.isLeaving), String(row.joinSerial)].joined(separator: "|"))
        }
        return SC3LayoutFields(rows: rows, viewMode: inputs.viewMode, viewMaxTiles: inputs.viewMaxTiles,
                               hideTilesWithoutVideo: inputs.hideTilesWithoutVideo, selfViewMode: inputs.selfViewMode,
                               pinnedUserId: inputs.pinnedUserId, screenShareUserId: inputs.screenShareUserId,
                               isLocalScreenSharing: inputs.isLocalScreenSharing, activeAppId: inputs.activeAppId,
                               isBrowserActive: inputs.isBrowserActive, isWebinarAttendee: inputs.isWebinarAttendee,
                               webinarSpeakerUserId: inputs.webinarSpeakerUserId)
    }
}

@MainActor
struct SC3StageParityTests {
    private let me = SC3Ids.localId

    private func p(_ index: Int) -> String {
        SC3Ids.remoteId(index)
    }

    private func shape(_ state: MeetingState, _ viewport: StageViewport) -> SC3Shape {
        SC3Parity.newShape(SC3Parity.planned(SC3Parity.inputs(state), viewport: viewport, speakerUserId: SC3Parity.speaker(state)),
                           me: state.userId)
    }

    @Test func oneToSixteenParticipantsMatchTheLegacySnapshotsUpToTheIntendedDeltas() {
        var compared = 0
        var counts = Set<Int>()
        var kinds = Set<String>()
        for fixture in SC3Parity.sweep() {
            let state = SC3Parity.state(fixture)
            SC3Parity.expectLegacyIsConsistent(state, fixture)
            let inputs = SC3Parity.inputs(state)
            for viewport in SC3Parity.viewports {
                let planned = SC3Parity.planned(inputs, viewport: viewport.viewport, speakerUserId: SC3Parity.speaker(state))
                let actual = SC3Parity.newShape(planned, me: state.userId)
                let expected = SC3Parity.expectedShape(state, inputs: inputs, viewport: viewport.viewport)
                #expect(actual == expected, "\(fixture) on \(viewport.name): new \(actual) legacy \(SC3Parity.legacyShape(state))")
                compared += 1
                kinds.insert(actual.kind)
            }
            counts.insert(fixture.count)
        }
        #expect(counts == Set(1...16))
        #expect(kinds == Set(["solo", "oneOnOne", "grid", "spotlight", "sidebar", "presentation"]))
        #expect(compared >= 16 * 14 * SC3Parity.viewports.count)
    }

    @Test func intendedDeltaPhoneCapAndPlusN() {
        let twelve = SC3Parity.state(SC3Fixture(count: 12))
        let legacyGrid = twelve.visibleGridSnapshot()
        #expect(legacyGrid.userIds.count == 12 && legacyGrid.hiddenParticipantCount == 0)
        #expect(!legacyGrid.userIds.contains(MeetingState.overflowTileId))
        let se = shape(twelve, StagePoliciesTests.iphoneSE)
        #expect(se.tiles == [p(0), p(1), p(2), p(3), me, SC3Shape.overflowMark] && se.overflow == 7)
        let phone = shape(twelve, StagePoliciesTests.iphone17e)
        #expect(phone.tiles == [p(0), p(1), p(2), p(3), p(4), p(5), me, SC3Shape.overflowMark] && phone.overflow == 5)
        let tablet = shape(twelve, StagePoliciesTests.ipadPortrait)
        #expect(tablet.tiles.count == 12 && tablet.overflow == 0)

        let tight = SC3Parity.state(SC3Fixture(count: 4).with { $0.viewMode = .tiled; $0.viewMaxTiles = 2 })
        let tightLegacy = tight.visibleGridSnapshot()
        #expect(tightLegacy.userIds == [me, p(0)] && tightLegacy.hiddenParticipantCount == 2)
        let tightNew = shape(tight, StagePoliciesTests.ipadPortrait)
        #expect(tightNew.tiles == [me, SC3Shape.overflowMark] && tightNew.overflow == 3)

        let fourteen = SC3Parity.state(SC3Fixture(count: 14))
        #expect(fourteen.usesSidebarLayout)
        let rail = fourteen.spotlightSnapshot()
        #expect(rail.pinnedUserId == p(0))
        #expect(rail.railUserIds == [me, p(1), p(2), p(3), p(4), p(5), p(6)])
        let tabletRail = shape(fourteen, StagePoliciesTests.ipadPortrait)
        #expect(tabletRail.kind == "sidebar" && tabletRail.main == p(0))
        #expect(tabletRail.tiles == [p(1), p(2), p(3), p(4), p(5), p(6), me, SC3Shape.overflowMark] && tabletRail.overflow == 6)
        let phoneRail = shape(fourteen, StagePoliciesTests.iphone17e)
        #expect(phoneRail.tiles == [p(1), p(2), me, SC3Shape.overflowMark] && phoneRail.overflow == 10)
    }

    @Test func intendedDeltaYouLast() {
        let four = SC3Parity.state(SC3Fixture(count: 4).with { $0.viewMode = .tiled })
        #expect(four.visibleGridSnapshot().userIds == [me, p(0), p(1), p(2)])
        #expect(shape(four, StagePoliciesTests.ipadPortrait).tiles == [p(0), p(1), p(2), me])

        let spotlight = SC3Parity.state(SC3Fixture(count: 4).with { $0.viewMode = .spotlight })
        #expect(spotlight.spotlightSnapshot().railUserIds == [me, p(1), p(2)])
        let spotlightNew = shape(spotlight, StagePoliciesTests.ipadPortrait)
        #expect(spotlightNew.main == p(0) && spotlightNew.tiles == [p(1), p(2), me])

        let sharing = SC3Parity.state(SC3Fixture(count: 4).with { $0.sharer = 0 })
        let strip = sharing.tileStripSnapshot()
        #expect(strip.shouldShowSelfTile && strip.participants.map { $0.id } == [p(0), p(1), p(2)])
        let sharingNew = shape(sharing, StagePoliciesTests.ipadPortrait)
        #expect(sharingNew.kind == "presentation" && sharingNew.main == "share:" + p(0))
        #expect(sharingNew.tiles == [p(0), p(1), p(2), me])
    }

    @Test func intendedDeltaNoSpeakerFirstSort() {
        let grid = SC3Parity.state(SC3Fixture(count: 5).with {
            $0.viewMode = .tiled; $0.reverseJoin = true; $0.cameraOff = [0]; $0.hands = [3]; $0.speaker = 1
        })
        #expect(grid.visibleGridSnapshot().userIds == [me, p(1), p(3), p(2), p(0)])
        #expect(shape(grid, StagePoliciesTests.ipadPortrait).tiles == [p(3), p(2), p(1), p(0), me])

        let spotlight = SC3Parity.state(SC3Fixture(count: 5).with {
            $0.viewMode = .spotlight; $0.reverseJoin = true; $0.cameraOff = [0]; $0.hands = [3]; $0.speaker = 1
        })
        let legacy = spotlight.spotlightSnapshot()
        #expect(legacy.pinnedUserId == p(1) && legacy.railUserIds == [me, p(3), p(2), p(0)])
        let spotlightNew = shape(spotlight, StagePoliciesTests.ipadPortrait)
        #expect(spotlightNew.main == p(3) && spotlightNew.tiles == [p(2), p(1), p(0), me])

        let talking = SC3Parity.state(SC3Fixture(count: 3).with { $0.viewMode = .spotlight; $0.speaker = SC3Fixture.local })
        #expect(talking.spotlightSnapshot().pinnedUserId == me && talking.spotlightSnapshot().railUserIds == [p(0), p(1)])
        let talkingNew = shape(talking, StagePoliciesTests.ipadPortrait)
        #expect(talkingNew.main == p(0) && talkingNew.tiles == [p(1), me] && talkingNew.selfPlacement == "tile")

        let pair = SC3Parity.state(SC3Fixture(count: 2).with { $0.speaker = SC3Fixture.local })
        #expect(pair.spotlightSnapshot().pinnedUserId == me && pair.spotlightSnapshot().railUserIds == [p(0)])
        let pairNew = shape(pair, StagePoliciesTests.iphone17e)
        #expect(pairNew == SC3Shape(kind: "oneOnOne", main: p(0), tiles: [], overflow: 0, selfPlacement: "floating"))
    }

    @Test func intendedDeltaPinOverShare() {
        let state = SC3Parity.state(SC3Fixture(count: 5).with { $0.sharer = 0; $0.pinned = 2 })
        #expect(state.hasActiveScreenShare && state.usesSpotlightLayout)
        let strip = state.tileStripSnapshot()
        #expect(strip.shouldShowSelfTile && strip.participants.map { $0.id } == [p(0), p(1), p(2), p(3)])
        #expect(SC3Parity.legacyShape(state).kind == "presentation")
        let pinned = shape(state, StagePoliciesTests.ipadPortrait)
        #expect(pinned == SC3Shape(kind: "spotlight", main: p(2), tiles: ["share:" + p(0), p(0), p(1), p(3), me], overflow: 0,
                                   selfPlacement: "tile"))
    }

    @Test func pinningTheOtherPersonInAOneOnOneKeepsYouFloating() {
        let pinned = SC3Parity.state(SC3Fixture(count: 2).with { $0.pinned = 0 })
        #expect(pinned.resolvedSelfViewMode == .floating)
        #expect(pinned.spotlightSnapshot().pinnedUserId == p(0) && pinned.spotlightSnapshot().railUserIds.isEmpty)
        #expect(shape(pinned, StagePoliciesTests.iphone17e)
                == SC3Shape(kind: "spotlight", main: p(0), tiles: [], overflow: 0, selfPlacement: "floating"))

        let tiled = SC3Parity.state(SC3Fixture(count: 2).with { $0.pinned = 0; $0.viewMode = .tiled })
        #expect(tiled.resolvedSelfViewMode == .tile)
        #expect(shape(tiled, StagePoliciesTests.iphone17e)
                == SC3Shape(kind: "spotlight", main: p(0), tiles: [me], overflow: 0, selfPlacement: "tile"))

        let roster = [StageParticipantInput.make(userId: "you", isLocal: true), StageParticipantInput.make(userId: "r1", joinSerial: 1)]
        let auto = StageSlotPlanInputs(kind: .spotlight, isCompactPortrait: true, capacity: StageCapacity(gridSlots: 0, railSlots: 4),
                                       localUserId: "you", remoteOrder: ["r1"], participants: roster, pinnedUserId: "r1",
                                       featuredUserId: "r1", presenterUserId: "", selfViewMode: "auto", webinarSpeakerUserId: "",
                                       fitOverrides: [:], viewMode: "auto")
        #expect(StageOrderPolicy.resolvedSelfRole(auto) == .selfFloating)
        var unknown = auto
        unknown.viewMode = ""
        #expect(StageOrderPolicy.resolvedSelfRole(unknown) == nil)
        var chosen = auto
        chosen.viewMode = "spotlight"
        #expect(StageOrderPolicy.resolvedSelfRole(chosen) == nil)
        var overActivity = auto
        overActivity.hasActivitySurface = true
        #expect(StageOrderPolicy.resolvedSelfRole(overActivity) == nil)
        let tile = StageSlotPlanInputs(kind: .spotlight, isCompactPortrait: true, capacity: auto.capacity, localUserId: "you",
                                       remoteOrder: ["r1"], participants: roster, pinnedUserId: "r1", featuredUserId: "r1",
                                       presenterUserId: "", selfViewMode: "tile", webinarSpeakerUserId: "", fitOverrides: [:],
                                       viewMode: "auto")
        #expect(StageOrderPolicy.resolvedSelfRole(tile) == nil)
        let sharing = StageSlotPlanInputs(kind: .spotlight, isCompactPortrait: true, capacity: auto.capacity, localUserId: "you",
                                          remoteOrder: ["r1"], participants: roster, pinnedUserId: "r1", featuredUserId: "r1",
                                          presenterUserId: "r1", selfViewMode: "auto", webinarSpeakerUserId: "", fitOverrides: [:],
                                          viewMode: "auto")
        #expect(StageOrderPolicy.resolvedSelfRole(sharing) == nil)
        #expect(StageOrderPolicy.resolvedSelfRole(StageSlotPlanInputs(
            kind: .oneOnOne, isCompactPortrait: true, capacity: StageCapacity.zero, localUserId: "you", remoteOrder: ["r1"],
            participants: roster, pinnedUserId: "", featuredUserId: "r1", presenterUserId: "", selfViewMode: "auto",
            webinarSpeakerUserId: "", fitOverrides: [:])) == .selfFloating)
    }

    @Test func showingVideoOverAnAppOrBrowserKeepsYouATileInAPinnedOneOnOne() {
        for browser in [false, true] {
            let state = SC3Parity.state(SC3Fixture(count: 2).with { $0.pinned = 0 })
            if browser {
                state.isBrowserActive = true
            } else {
                state.activeAppId = "whiteboard"
            }
            #expect(state.hasPresentationSurface && state.resolvedSelfViewMode == .tile, "browser \(browser)")
            let inputs = SC3Parity.inputs(state)
            #expect(StageLayoutPolicy.kind(inputs, showsVideoOverActivity: false).isActivity, "browser \(browser)")
            let planned = SC3Parity.planned(inputs, viewport: StagePoliciesTests.iphone17e, speakerUserId: "",
                                            showsVideoOverActivity: true)
            #expect(SC3Parity.newShape(planned, me: me)
                    == SC3Shape(kind: "spotlight", main: p(0), tiles: [me], overflow: 0, selfPlacement: "tile"), "browser \(browser)")
            let stage = SC3Parity.presenter(inputs, viewport: StagePoliciesTests.iphone17e)
            stage.setShowsVideoOverActivity(true)
            #expect(stage.layout.kind == .spotlight && stage.layout.showsVideoOverActivity, "browser \(browser)")
            #expect(stage.layout.slots == planned.plan.slots, "browser \(browser)")
        }
    }

    @Test func aliasRowsAndAStaleShareIdFollowTheLegacyMergeAndShareRules() {
        let pair = SC3Parity.state(SC3Fixture(count: 2).with { $0.aliases = [0] })
        #expect(pair.participants.count == 2 && pair.participantCount == 2 && pair.presentParticipants.count == 1)
        #expect(pair.participants[SC3Ids.bareId(0)]?.isCameraOff == true && pair.participant(for: p(0))?.isCameraOff == false)
        let pairInputs = SC3Parity.inputs(pair)
        #expect(pairInputs.presentParticipants.count == 2 && pairInputs.participant(p(0))?.isCameraOff == false)
        #expect(SC3Parity.legacyShape(pair).kind == "oneOnOne")
        #expect(shape(pair, StagePoliciesTests.iphone17e)
                == SC3Shape(kind: "oneOnOne", main: p(0), tiles: [], overflow: 0, selfPlacement: "floating"))

        let remote = SC3Parity.state(SC3Fixture(count: 4).with { $0.staleSharer = 1 })
        #expect(remote.activeScreenShareUserId == p(1) && remote.participant(for: p(1))?.isScreenSharing == false)
        #expect(!remote.hasActiveScreenShare && remote.presentationScreenShareUserId == nil)
        let remoteInputs = SC3Parity.inputs(remote)
        #expect(remoteInputs.screenShareUserId.isEmpty)
        #expect(shape(remote, StagePoliciesTests.ipadPortrait)
                == SC3Shape(kind: "grid", main: "", tiles: [p(0), p(1), p(2), me], overflow: 0, selfPlacement: "tile"))

        let local = SC3Parity.state(SC3Fixture(count: 3).with { $0.staleSharer = SC3Fixture.local })
        #expect(local.activeScreenShareUserId == me && !local.isScreenSharing && !local.hasActiveScreenShare)
        #expect(SC3Parity.inputs(local).screenShareUserId.isEmpty)
        #expect(shape(local, StagePoliciesTests.ipadPortrait).kind == "grid")
    }

    @Test func twoPeopleWithYouInATileKeepTheLegacySpotlightLayout() {
        let pair = SC3Parity.state(SC3Fixture(count: 2).with { $0.selfViewMode = .tile })
        #expect(pair.usesSpotlightLayout && !pair.hasActiveScreenShare)
        #expect(pair.spotlightSnapshot().pinnedUserId == p(0) && pair.spotlightSnapshot().railUserIds == [me])
        let inputs = SC3Parity.inputs(pair)
        for viewport in SC3Parity.viewports {
            let actual = shape(pair, viewport.viewport)
            #expect(actual == SC3Parity.expectedShape(pair, inputs: inputs, viewport: viewport.viewport), "\(viewport.name)")
            #expect(actual == SC3Shape(kind: "spotlight", main: p(0), tiles: [me], overflow: 0, selfPlacement: "tile"), "\(viewport.name)")
        }
    }

    @Test func hideTilesKeepsACameraOffPresenterLikeTheLegacyFilter() {
        let roster = [
            StageParticipantInput.make(userId: "you", isLocal: true),
            StageParticipantInput.make(userId: "r1", isCameraOff: true, isScreenSharing: true, joinSerial: 1),
            StageParticipantInput.make(userId: "r2", isCameraOff: true, joinSerial: 2),
            StageParticipantInput.make(userId: "r3", isCameraOff: false, joinSerial: 3),
        ]
        #expect(StageOrderPolicy.applyHideFilter(["r1", "r2", "r3"], participants: roster, hideTilesWithoutVideo: true,
                                                 featuredUserId: "", pinnedUserId: "") == ["r1", "r3"])
        let state = SC3Parity.state(SC3Fixture(count: 4).with { $0.hideTilesWithoutVideo = true; $0.cameraOff = [0, 1]; $0.sharer = 0 })
        #expect(state.visibleTileParticipants.map { $0.id } == [p(0), p(2)])
        #expect(shape(state, StagePoliciesTests.ipadPortrait).tiles == [p(0), p(2), me])
    }

    @Test func joinOrderListsADuplicatedRosterRowOnce() {
        let roster = [
            StageParticipantInput.make(userId: "you", isLocal: true),
            StageParticipantInput.make(userId: "r1", joinSerial: 2),
            StageParticipantInput.make(userId: "r1", isCameraOff: false, joinSerial: 2),
            StageParticipantInput.make(userId: "r2", joinSerial: 1),
        ]
        #expect(StageOrderPolicy.joinOrder(roster) == ["r2", "r1"])
        #expect(StageOrderPolicy.reconcile(previous: ["r1"], participants: roster) == ["r1", "r2"])
    }

    @Test func activityStripsAlwaysCarryYouByTheOwnersGameRule() {
        let app = SC3Parity.state(SC3Fixture(count: 4).with { $0.selfViewMode = .floating })
        app.activeAppId = "whiteboard"
        #expect(app.resolvedSelfViewMode == .floating)
        #expect(!app.tileStripSnapshot().shouldShowSelfTile)
        #expect(app.tileStripSnapshot(forceSelfTile: true).shouldShowSelfTile)
        let inputs = SC3Parity.inputs(app)
        #expect(StageLayoutPolicy.kind(inputs, showsVideoOverActivity: false) == .app)
        let appNew = SC3Parity.newShape(SC3Parity.planned(inputs, viewport: StagePoliciesTests.ipadPortrait, speakerUserId: ""), me: me)
        #expect(appNew.kind == "app" && appNew.tiles == [p(0), p(1), p(2), me] && appNew.selfPlacement == "tile")

        let game = StageFixtureScript.copy(SC3Parity.inputs(SC3Parity.state(SC3Fixture(count: 4))), isGameActive: true, gameName: "Trivia")
        let gameNew = SC3Parity.newShape(SC3Parity.planned(game, viewport: StagePoliciesTests.iphone17e, speakerUserId: ""), me: me)
        #expect(gameNew.kind == "game" && gameNew.tiles.contains(me) && gameNew.selfPlacement == "tile")
    }

    @Test func theConsumerFallbackMatchesTheLegacyUnionBeforeTheStageIsMeasured() {
        var compared = 0
        var capped = 0
        for fixture in SC3Parity.sweep() {
            let state = SC3Parity.state(fixture)
            let inputs = SC3Parity.inputs(state)
            let stage = SC3Parity.presenter(inputs, viewport: StageViewport.zero)
            let fallback = SC3Parity.fallbackConsumerIds(stage, state: state)
            let legacy = SC3Parity.legacyConsumerIds(state)
            let expected = SC3Parity.shapeConsumerIds(SC3Parity.unmeasuredExpectedShape(state, inputs: inputs), state: state)
            #expect(fallback == expected, "\(fixture): fallback \(fallback.sorted()) expected \(expected.sorted())")
            if fixture.viewMaxTiles >= fixture.count {
                #expect(fallback == legacy, "\(fixture): fallback \(fallback.sorted()) legacy \(legacy.sorted())")
            } else {
                let tiled = fixture.count <= MeetingViewConstants.autoTiledThreshold || fixture.viewMode == .tiled
                let remotes = fixture.viewMaxTiles == 2 ? 0 : (tiled ? 7 : 8)
                #expect(fixture.viewMaxTiles == 2 || fixture.viewMaxTiles == 9, "\(fixture)")
                #expect(fallback.count == remotes, "\(fixture): fallback \(fallback.sorted())")
                #expect(fallback.count <= legacy.count, "\(fixture): fallback \(fallback.sorted()) legacy \(legacy.sorted())")
                #expect(fallback.isSubset(of: SC3Parity.legacyVisibleConsumerIds(state)), "\(fixture): fallback \(fallback.sorted())")
                capped += 1
            }
            compared += 1
        }
        #expect(compared >= 16 * 14)
        #expect(capped == 21)
    }

    @Test func anUnmeasuredStageWouldStarveTheFallbackWithoutTheHelper() {
        let state = SC3Parity.state(SC3Fixture(count: 12))
        let everyone = Set((0..<11).map { SC3Ids.remoteId($0) })
        let unmeasured = SC3Parity.presenter(SC3Parity.inputs(state), viewport: StageViewport.zero)
        #expect(unmeasured.layout.kind == .grid && unmeasured.layout.capacity == StageCapacity.zero)
        #expect(StageOrderPolicy.visibleRemoteIds(unmeasured.layout.slots, localUserId: me).isEmpty)
        #expect(Set(StageOrderPolicy.consumerFallbackRemoteIds(layout: unmeasured.layout, inputs: unmeasured.inputs,
                                                               speakerUserId: "")) == everyone)
        #expect(SC3Parity.legacyConsumerIds(state) == everyone)
        #expect(StageOrderPolicy.unmeasuredCapacity(kind: .grid, viewMaxTiles: 16) == StageCapacity(gridSlots: 16, railSlots: 0))
        #expect(StageOrderPolicy.unmeasuredCapacity(kind: .sidebar, viewMaxTiles: 60) == StageCapacity(gridSlots: 0, railSlots: 49))
        #expect(StageOrderPolicy.unmeasuredCapacity(kind: .oneOnOne, viewMaxTiles: 16) == StageCapacity.zero)

        let measured = SC3Parity.presenter(SC3Parity.inputs(state), viewport: StagePoliciesTests.iphoneSE)
        #expect(StageOrderPolicy.consumerFallbackRemoteIds(layout: measured.layout, inputs: measured.inputs, speakerUserId: "")
                == [p(0), p(1), p(2), p(3)])
    }

    @Test func thePresenterPlansWhatTheParityCompositionPlans() {
        for fixture in SC3Parity.sweep() {
            let state = SC3Parity.state(fixture)
            let inputs = SC3Parity.inputs(state)
            for viewport in [StagePoliciesTests.iphone17e, StagePoliciesTests.ipadPortrait] {
                let stage = SC3Parity.presenter(inputs, viewport: viewport)
                let planned = SC3Parity.planned(inputs, viewport: viewport, speakerUserId: "")
                #expect(stage.layout.kind == planned.kind, "\(fixture)")
                #expect(stage.layout.slots == planned.plan.slots, "\(fixture) at \(viewport.width)")
                #expect(stage.layout.overflowCount == planned.plan.overflowCount, "\(fixture) at \(viewport.width)")
                if fixture.viewMaxTiles >= fixture.count {
                    let measured = SC3Parity.fallbackConsumerIds(stage, state: state)
                    #expect(measured.isSubset(of: SC3Parity.legacyConsumerIds(state)), "\(fixture) at \(viewport.width)")
                }
            }
        }
    }

    @Test func hideTilesHidesAQuietCameraOffFirstJoinerOnTheStage() {
        let state = SC3Parity.state(SC3Fixture(count: 4).with { $0.hideTilesWithoutVideo = true; $0.cameraOff = [0] })
        #expect(state.visibleTileParticipants.map { $0.id } == [p(1), p(2)])
        let stage = SC3Parity.presenter(SC3Parity.inputs(state), viewport: StagePoliciesTests.ipadPortrait)
        #expect(stage.layout.featuredUserId == p(0))
        #expect(stage.layout.slots.filter { $0.id.hasPrefix("p:") }.map { $0.userId } == [p(1), p(2), me])
        stage.speakerChanged(p(0), atMillis: 1_000)
        #expect(stage.layout.slots.filter { $0.id.hasPrefix("p:") }.map { $0.userId } == [p(0), p(1), p(2), me])
    }
}

#if os(macOS)

@MainActor
@Suite(.serialized)
struct SC3StageParityViewModelTests {
    @Test func theParityInputsMatchTheViewModelStageInputs() {
        let fixtures = [
            SC3Fixture(count: 6).with { $0.reverseJoin = true; $0.cameraOff = [1, 4] },
            SC3Fixture(count: 5).with { $0.pinned = 2; $0.sharer = 0; $0.hideTilesWithoutVideo = true },
            SC3Fixture(count: 3).with { $0.sharer = SC3Fixture.local; $0.viewMode = .sidebar; $0.selfViewMode = .minimized },
            SC3Fixture(count: 2).with { $0.aliases = [0] },
            SC3Fixture(count: 5).with { $0.aliases = [1, 3]; $0.cameraOff = [3]; $0.reverseJoin = true },
            SC3Fixture(count: 4).with { $0.staleSharer = 1 },
            SC3Fixture(count: 3).with { $0.staleSharer = SC3Fixture.local },
        ]
        for fixture in fixtures {
            let viewModel = MeetingViewModel()
            viewModel.state = SC3Parity.state(fixture)
            let production = SC3Parity.layoutFields(viewModel.makeStageInputs())
            let parity = SC3Parity.layoutFields(SC3Parity.inputs(viewModel.state))
            #expect(production == parity, "\(fixture)")
        }
    }
}
#endif
#endif
