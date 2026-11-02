import Foundation

enum TileMenuItemId: String, CaseIterable, Equatable {
    case pin, unpin, flipCamera, minimizeSelfView, showSelfView, showFullVideo, cropToFill
}

struct TileMenuTitles: Equatable {
    let pin: String
    let unpin: String
    let flipCamera: String
    let minimizeSelfView: String
    let showSelfView: String
    let showFullVideo: String
    let cropToFill: String
}

struct TileMenuContext: Equatable {
    let slotId: String
    let userId: String
    let role: StageSlotRole
    let kind: StageKind

    let fit: StageVideoFit
    let isLocal: Bool
    let isPinned: Bool
    let isCameraOff: Bool

    let canFlipCamera: Bool

    let offersFlipItem: Bool

    static func make(slot: StageSlot, model: TileChromeModel, kind: StageKind, canFlipCamera: Bool,
                     offersFlipItem: Bool) -> TileMenuContext {
        TileMenuContext(slotId: slot.id, userId: slot.userId, role: slot.role, kind: kind, fit: slot.fit, isLocal: model.isLocal,
                        isPinned: model.isPinned, isCameraOff: model.isCameraOff, canFlipCamera: canFlipCamera,
                        offersFlipItem: offersFlipItem)
    }
}

enum TileMenuPolicy {

    static let stageSectionId = "tile.stage"

    static let menuTransientId = "tile.menu"

    static func hasMenu(slotId: String, role: StageSlotRole, kind: StageKind) -> Bool {
        if !slotId.hasPrefix("p:") { return false }
        switch role {
        case .share, .activity, .overflow, .programFeed, .speakerInset:
            return false
        default:
            break
        }
        return kind != StageKind.attendeeLive && kind != StageKind.attendeeWaiting
    }

    static func offersPin(_ context: TileMenuContext) -> Bool {
        if context.kind == StageKind.solo { return false }
        if context.isLocal && (context.kind == StageKind.oneOnOne || context.role.isSelfView) { return false }
        return true
    }

    static func stageItems(_ context: TileMenuContext) -> [TileMenuItemId] {
        var items: [TileMenuItemId] = []
        if !hasMenu(slotId: context.slotId, role: context.role, kind: context.kind) { return items }
        if offersPin(context) {
            items.append(context.isPinned ? TileMenuItemId.unpin : TileMenuItemId.pin)
        }
        if context.isLocal {
            if context.offersFlipItem && context.canFlipCamera {
                items.append(TileMenuItemId.flipCamera)
            }
            if context.role == StageSlotRole.selfFloating {
                items.append(TileMenuItemId.minimizeSelfView)
            } else if context.role == StageSlotRole.selfMinimized {
                items.append(TileMenuItemId.showSelfView)
            }
        }
        if !context.isCameraOff && context.role != StageSlotRole.selfMinimized {
            items.append(context.fit == StageVideoFit.fit ? TileMenuItemId.cropToFill : TileMenuItemId.showFullVideo)
        }
        return items
    }

    static func title(_ id: TileMenuItemId, titles: TileMenuTitles) -> String {
        switch id {
        case .pin: return titles.pin
        case .unpin: return titles.unpin
        case .flipCamera: return titles.flipCamera
        case .minimizeSelfView: return titles.minimizeSelfView
        case .showSelfView: return titles.showSelfView
        case .showFullVideo: return titles.showFullVideo
        case .cropToFill: return titles.cropToFill
        }
    }

    static func concept(_ id: TileMenuItemId) -> String {
        switch id {
        case .pin: return "pin"
        case .unpin: return "unpin"
        case .flipCamera: return "flip_camera"
        case .minimizeSelfView: return "self_view_minimize"
        case .showSelfView: return "picture_in_picture"
        case .showFullVideo: return "fit_video"
        case .cropToFill: return "fill_video"
        }
    }

    static func sections(_ context: TileMenuContext, titles: TileMenuTitles, people: [MenuSectionModel]) -> [MenuSectionModel] {
        var result: [MenuSectionModel] = []
        var items: [MenuItemModel] = []
        for id in stageItems(context) {
            items.append(MenuItemModel(id: id.rawValue, title: title(id, titles: titles), concept: concept(id), role: MenuItemRole.normal,
                                       isOn: false, isEnabled: true, disabledReason: ""))
        }
        if !items.isEmpty {
            result.append(MenuSectionModel(id: stageSectionId, items: items))
        }
        for section in people {
            var kept: [MenuItemModel] = []
            for item in section.items {
                if item.id != TileMenuItemId.pin.rawValue && item.id != TileMenuItemId.unpin.rawValue {
                    kept.append(item)
                }
            }
            if !kept.isEmpty {
                result.append(MenuSectionModel(id: section.id, items: kept))
            }
        }
        return result
    }

    static func contextMenuSections(_ sections: [MenuSectionModel]) -> [MenuSectionModel] {
        var result: [MenuSectionModel] = []
        for section in sections {
            var kept: [MenuItemModel] = []
            for item in section.items {
                if item.isEnabled { kept.append(item) }
            }
            if !kept.isEmpty {
                result.append(MenuSectionModel(id: section.id, items: kept))
            }
        }
        return result
    }

    static func accessibilityItems(_ sections: [MenuSectionModel]) -> [MenuItemModel] {
        var result: [MenuItemModel] = []
        for section in sections {
            for item in section.items {
                if item.isEnabled { result.append(item) }
            }
        }
        return result
    }

    static func itemCount(_ sections: [MenuSectionModel]) -> Int {
        var count = 0
        for section in sections {
            count += section.items.count
        }
        return count
    }
}

enum TileMenuDispatcher {
    @MainActor
    static func perform(_ itemId: String, context: TileMenuContext, stage: StagePresenter) -> Bool {

        let corner = SelfViewSnapPolicy.corner(forItemId: itemId)
        if !corner.isEmpty {
            stage.moveSelfView(toCorner: corner)
            return true
        }
        guard let id = TileMenuItemId(rawValue: itemId) else { return false }
        switch id {
        case .pin:
            stage.togglePin(userId: context.userId)
        case .unpin:
            stage.clearPin()
        case .flipCamera:

            return StageCameraFlip.perform(stage)
        case .minimizeSelfView:
            stage.setSelfViewMode(TileFeaturePolicy.minimizedSelfViewMode)
        case .showSelfView:
            stage.setSelfViewMode(TileFeaturePolicy.floatingSelfViewMode)
        case .showFullVideo:
            stage.setSlotFit(StageVideoFit.fit, slotId: context.slotId)
        case .cropToFill:
            stage.setSlotFit(StageVideoFit.fill, slotId: context.slotId)
        }
        return true
    }
}

struct TilePinAnnouncement: Equatable {
    let kind: String
    let name: String

    static let none = TilePinAnnouncement(kind: "", name: "")
}

enum TileFeaturePolicy {
    static let pinnedKind = "pinned"
    static let pinClearedKind = "pinCleared"

    static let minimizedSelfViewMode = "minimized"
    static let floatingSelfViewMode = "floating"

    static let backOnlineMillis = 4500.0

    static let mainAspectTolerance = 0.3

    static let unpinTargetIos = 44.0
    static let unpinTargetAndroid = 48.0

    static let badgeSpacing = 4.0

    static func anyRemoteVideo(_ participants: [StageParticipantInput]) -> Bool {
        for participant in participants {
            if !participant.isLocal && !participant.isLeaving && !participant.isCameraOff { return true }
        }
        return false
    }

    static func spotlightCandidate(speakerUserId: String, featuredUserId: String, pinnedUserId: String,
                                   participants: [StageParticipantInput]) -> String {
        if speakerUserId.isEmpty || !pinnedUserId.isEmpty || speakerUserId == featuredUserId { return "" }
        guard let speaker = StageOrderPolicy.participant(speakerUserId, in: participants) else { return "" }
        if speaker.isLocal || speaker.isLeaving { return "" }
        if speaker.isCameraOff && anyRemoteVideo(participants) { return "" }
        return speakerUserId
    }

    static func spotlightMainUserId(pinnedUserId: String, featuredUserId: String, remoteOrder: [String],
                                    participants: [StageParticipantInput], localUserId: String) -> String {
        if !pinnedUserId.isEmpty && StageOrderPolicy.participant(pinnedUserId, in: participants) != nil {
            return pinnedUserId
        }
        let video = anyRemoteVideo(participants)
        if !featuredUserId.isEmpty && featuredUserId != localUserId && remoteOrder.contains(featuredUserId) {
            let featuredCameraOff = StageOrderPolicy.participant(featuredUserId, in: participants)?.isCameraOff ?? true
            if !featuredCameraOff || !video { return featuredUserId }
        }
        for id in remoteOrder {
            let cameraOff = StageOrderPolicy.participant(id, in: participants)?.isCameraOff ?? true
            if !cameraOff { return id }
        }
        if let first = remoteOrder.first { return first }
        return localUserId
    }

    static func containsSlot(_ slots: [StageSlot], id: String) -> Bool {
        for slot in slots {
            if slot.id == id { return true }
        }
        return false
    }

    static func pinAnnouncement(previous: StageInputs, next: StageInputs) -> TilePinAnnouncement {
        if previous.participants.isEmpty || previous.callSession != next.callSession { return TilePinAnnouncement.none }
        let before = previous.pinnedUserId
        let after = next.pinnedUserId
        if !after.isEmpty && after != before {
            if let pinned = next.participant(after) {
                return TilePinAnnouncement(kind: pinnedKind, name: pinned.displayName)
            }
            return TilePinAnnouncement.none
        }
        if !before.isEmpty && (after.isEmpty || after == before) && next.participant(before) == nil {
            if let left = previous.participant(before) {
                if !left.isLocal {
                    return TilePinAnnouncement(kind: pinClearedKind, name: left.displayName)
                }
            }
        }
        return TilePinAnnouncement.none
    }

    static func toggledFit(_ fit: StageVideoFit) -> StageVideoFit {
        fit == StageVideoFit.fit ? StageVideoFit.fill : StageVideoFit.fit
    }

    static func mainFit(widthClass: String, slotWidth: Double, slotHeight: Double, videoWidth: Double,
                        videoHeight: Double) -> StageVideoFit {
        if StageSizeClass.isCompact(widthClass) { return StageVideoFit.fill }
        if slotWidth <= 0 || slotHeight <= 0 || videoWidth <= 0 || videoHeight <= 0 { return StageVideoFit.fill }
        let slotAspect = slotWidth / slotHeight
        let videoAspect = videoWidth / videoHeight
        let ratio = max(slotAspect, videoAspect) / min(slotAspect, videoAspect)
        return ratio - 1.0 > mainAspectTolerance ? StageVideoFit.fit : StageVideoFit.fill
    }

    static func showsFlipControl(isLocal: Bool, isShare: Bool, role: StageSlotRole, canFlipCamera: Bool,
                                 density: TileChromeDensity) -> Bool {
        if !isLocal || isShare || !canFlipCamera { return false }
        if role == StageSlotRole.selfMinimized { return false }
        if role == StageSlotRole.selfFloating { return true }
        return density != TileChromeDensity.dense
    }

    static func showsUnpinTarget(role: StageSlotRole, isPinned: Bool, isShare: Bool) -> Bool {
        role == StageSlotRole.spotlightMain && isPinned && !isShare
    }

    static func unpinTargetTrailingInset(model: TileChromeModel, density: TileChromeDensity, targetSize: Double) -> Double {
        let badge = TileChromePolicy.badgeSize(density)
        let inset = density == TileChromeDensity.dense ? 4.0 : 8.0
        let after = max(0, TileChromePolicy.trailingBadges(model).count - 1)
        let center = inset + Double(after) * (badge + badgeSpacing) + badge / 2.0
        return max(0.0, center - targetSize / 2.0)
    }

    static func unpinTargetTopInset(density: TileChromeDensity, targetSize: Double) -> Double {
        let badge = TileChromePolicy.badgeSize(density)
        let inset = density == TileChromeDensity.dense ? 4.0 : 8.0
        return max(0.0, inset + badge / 2.0 - targetSize / 2.0)
    }

    static func showsOneOnOneCaption(kind: StageKind, role: StageSlotRole, isLocal: Bool, isCameraOff: Bool) -> Bool {
        kind == StageKind.oneOnOne && role == StageSlotRole.spotlightMain && !isLocal && isCameraOff
    }

    static func reconnectReasonKind(_ raw: String) -> String {
        let value = raw.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        if value == "ping timeout" { return "timeout" }
        if value == "transport close" || value == "transport error" { return "network" }
        return "interrupted"
    }
}

enum SpotlightRailPolicy {
    static let stripTileWidth = 80.0
    static let stripTileHeight = 107.0
    static let columnTileWidth = 160.0
    static let largeColumnTileWidth = 200.0
    static let columnAspect = 16.0 / 9.0

    static func isStrip(_ viewport: StageViewport) -> Bool {
        StageLayoutPolicy.isCompactPortrait(viewport)
    }

    static func usesLargeColumn(_ viewport: StageViewport) -> Bool {
        let wide = viewport.widthClass == StageSizeClass.regular || viewport.widthClass == StageSizeClass.expanded
        return wide && !StageLayoutPolicy.isCompactHeight(viewport)
    }

    static func tileWidth(_ viewport: StageViewport) -> Double {
        if isStrip(viewport) { return stripTileWidth }
        return usesLargeColumn(viewport) ? largeColumnTileWidth : columnTileWidth
    }

    static func tileHeight(_ viewport: StageViewport) -> Double {
        if isStrip(viewport) { return stripTileHeight }
        return tileWidth(viewport) / columnAspect
    }

    static func capacity(viewport: StageViewport) -> Int {
        if viewport.isEmpty { return 0 }
        let area = StageLayoutPolicy.contentFrame(viewport)
        let gap = StageLayoutPolicy.gap(viewport)
        let fit: Int
        if isStrip(viewport) {
            fit = Int((area.width + gap) / (stripTileWidth + gap))
        } else {
            fit = Int((area.height + gap) / (tileHeight(viewport) + gap))
        }
        return max(1, min(fit, MeetingViewConstants.stageRailMaxTiles))
    }
}
