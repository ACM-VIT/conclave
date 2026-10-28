import Foundation

// STG-2 (OUT/PLAN-screens.md section 5; S20 3, 4, 0.6 SR4, 0.7 SC2, SC4; RECONCILE R19; F00 C08, C16): the pure rules
// behind tile anatomy, the tile menu, spotlight and pinning. Shared (transpiled) Swift under the S1C 3.6 rules: String
// raw-value enums, scalar structs and arrays of structs, no associated values, no tuples, no protocols, no platform
// branches. Views resolve every string; nothing here localizes.
//
// What STG-1 already owns and this file does not duplicate: the featured-speaker timing (hold 1.2 s, at most one change
// per 8 s) is `StageOrderPolicy.promotionDelay` / `mayPromote`, driven by the presenter's single promotion task with
// its injected `now` and `sleep`; the per-session fit override map (slot id to `StageVideoFit`, kept across stage kinds,
// cleared by `reset()`) is `StagePresenter.setSlotFit`. STG-2 adds the camera-on featured rule, the spotlight main
// choice, the pin announcements, the spotlight rail geometry, the tile menu and the tile overlays' small decisions.

// MARK: Tile menu (S20 3 c, d, f, g; F00 C16; RECONCILE R19)

/// The stage's own tile menu items (S20 3 g; RECONCILE R19: S20 keeps Pin, the fit items and the own-tile items; the
/// people items arrive from the S50 `PeopleActionPolicy` with PPL-2). Raw values are the `MenuItemModel` ids.
enum TileMenuItemId: String, CaseIterable, Equatable {
    case pin, unpin, flipCamera, minimizeSelfView, showSelfView, showFullVideo, cropToFill
}

/// Item titles resolved per platform (iOS String Catalog, Android `ppl_` / `stg_` resources by name).
struct TileMenuTitles: Equatable {
    let pin: String
    let unpin: String
    let flipCamera: String
    let minimizeSelfView: String
    let showSelfView: String
    let showFullVideo: String
    let cropToFill: String
}

/// What the tile menu needs about one slot, read when the menu opens (F00 C16 k: content builds only when opened).
struct TileMenuContext: Equatable {
    let slotId: String
    let userId: String
    let role: StageSlotRole
    let kind: StageKind
    /// The slot's current fit (the presenter already folded the per-session override in, SC4).
    let fit: StageVideoFit
    let isLocal: Bool
    let isPinned: Bool
    let isCameraOff: Bool
    /// `StageChromeSnapshot.canFlipCamera` (your camera is on and a second camera exists).
    let canFlipCamera: Bool
    /// iOS offers Flip Camera in your own tile menu (S20 3 f, 6 c); Android keeps Flip in the top row and leaves it out
    /// of the self view menu (S20 6 d).
    let offersFlipItem: Bool

    static func make(slot: StageSlot, model: TileChromeModel, kind: StageKind, canFlipCamera: Bool,
                     offersFlipItem: Bool) -> TileMenuContext {
        TileMenuContext(slotId: slot.id, userId: slot.userId, role: slot.role, kind: kind, fit: slot.fit, isLocal: model.isLocal,
                        isPinned: model.isPinned, isCameraOff: model.isCameraOff, canFlipCamera: canFlipCamera,
                        offersFlipItem: offersFlipItem)
    }
}

enum TileMenuPolicy {
    /// The stage's section id; the people sections (PPL-2) keep their own ids.
    static let stageSectionId = "tile.stage"
    /// S30 CC16: the Android tile menu reports itself open so chrome never hides under it.
    static let menuTransientId = "tile.menu"

    /// Participant slots open a tile menu. The overflow, activity and share slots (STG-3 owns share viewing), the
    /// program feed and the speaker inset never do, and the attendee viewer has no tile menu (S20 4 f, 12).
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

    /// Pin is local and never blocked (S50 3 f group 0). Nobody pins in solo; you never pin yourself in 1:1 (S20 3 f)
    /// or from the floating or minimized self view, which is not a stage tile (pin yourself from your grid or rail tile).
    static func offersPin(_ context: TileMenuContext) -> Bool {
        if context.kind == StageKind.solo { return false }
        if context.isLocal && (context.kind == StageKind.oneOnOne || context.role.isSelfView) { return false }
        return true
    }

    /// The stage items in menu order: Pin or Unpin, then your own Flip Camera, Minimize or Show Self View, then the
    /// fit item while the camera is on (S20 3 b, f). A camera-off tile draws an avatar, so it has no fit item.
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

    /// The whole tile menu: the stage section first, then the people sections (PPL-2: the S50 `PeopleActionPolicy`
    /// items for that person in the People row order, minus Admit and Deny; RECONCILE R19) without their own Pin and
    /// Unpin, because S20 keeps Pin. Every stage item has a canonical glyph (F00 C16 c, H-06).
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

    /// The iOS context menu hides unavailable items (HIG, H-21; F00 C16 c; S20 3 f "menu in recovery"); the Android
    /// `DropdownMenu` keeps them disabled with their reason, so Android shows `sections` unchanged.
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

    /// Every available item as a named accessibility action on the tile (AX4; S20 3 c, d, i), in menu order.
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

/// Performs the stage's own tile menu items through the presenter (the S1 `onCommand` pattern behind it). Shared so
/// both platforms dispatch identically. People items (PPL-2) are not the stage's: `perform` returns false for them.
enum TileMenuDispatcher {
    @MainActor
    static func perform(_ itemId: String, context: TileMenuContext, stage: StagePresenter) -> Bool {
        // STG-3 (S20 6 c, d, i): the self view's Move items commit a corner through the presenter.
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
            // The view plays `selectionChanged` only after a dispatched flip (RECONCILE R13; nothing while in flight).
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

// MARK: Spotlight, pinning and tile decisions (S20 3, 4)

/// A one-shot pin announcement for `StagePresenter.announce(kind:name:)` (S20 4 g): kinds `pinned` and `pinCleared`.
struct TilePinAnnouncement: Equatable {
    let kind: String
    let name: String

    static let none = TilePinAnnouncement(kind: "", name: "")
}

enum TileFeaturePolicy {
    static let pinnedKind = "pinned"
    static let pinClearedKind = "pinCleared"
    /// `MeetingSelfViewMode` raw values the own-tile items write (S20 6).
    static let minimizedSelfViewMode = "minimized"
    static let floatingSelfViewMode = "floating"
    /// "Back Online" stays 4.5 s after a remote reconnects (web STG-15; the core keeps the reconnected status as long,
    /// `ParticipantConnectionStatusDismissPolicy`).
    static let backOnlineMillis = 4500.0
    /// A spotlight main on regular width fits when the video aspect differs from the slot by more than 30% (S20 4 c).
    static let mainAspectTolerance = 0.3
    /// The Unpin hit target: 44 pt on iOS, 48 dp on Android (S20 4 c, d).
    static let unpinTargetIos = 44.0
    static let unpinTargetAndroid = 48.0
    /// F00 C08: the trailing badges sit `inset` from the tile edge with 4 between them.
    static let badgeSpacing = 4.0

    // MARK: Featured speaker and the spotlight main

    /// Whether any present remote has their camera on (an audio-only meeting keeps following the speaker).
    static func anyRemoteVideo(_ participants: [StageParticipantInput]) -> Bool {
        for participant in participants {
            if !participant.isLocal && !participant.isLeaving && !participant.isCameraOff { return true }
        }
        return false
    }

    /// The speaker who should become featured in spotlight or sidebar, or "" (S20 4 c: main is the featured speaker
    /// with the camera on). Never you, never while a pin holds the main slot, never the current featured speaker; a
    /// camera-off speaker is featured only when no remote has video. The 1.2 s hold and the 8 s interval stay in the
    /// presenter's promotion task (`StageOrderPolicy.promotionDelay`, injected clock).
    static func spotlightCandidate(speakerUserId: String, featuredUserId: String, pinnedUserId: String,
                                   participants: [StageParticipantInput]) -> String {
        if speakerUserId.isEmpty || !pinnedUserId.isEmpty || speakerUserId == featuredUserId { return "" }
        guard let speaker = StageOrderPolicy.participant(speakerUserId, in: participants) else { return "" }
        if speaker.isLocal || speaker.isLeaving { return "" }
        if speaker.isCameraOff && anyRemoteVideo(participants) { return "" }
        return speakerUserId
    }

    /// The spotlight and sidebar main (S20 4 c): the pin, else the featured speaker with the camera on, else the first
    /// remote with the camera on, else the first remote; never you automatically (fixes INM A7). You are main only
    /// when you pinned yourself or nobody else is on stage. `remoteOrder` is the display order after the hide filter.
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

    /// Whether a slot id is already planned (the floating self view never duplicates your pinned main tile).
    static func containsSlot(_ slots: [StageSlot], id: String) -> Bool {
        for slot in slots {
            if slot.id == id { return true }
        }
        return false
    }

    // MARK: Pin announcements (S20 4 f, g, i)

    /// "Pinned %@" when a present person becomes pinned; "%@ left. Spotlight follows the speaker." when the pinned
    /// person leaves (whether or not the core already cleared the pin). Unpinning by choice has no copy in S20 4 g and
    /// stays silent. The first snapshot of a call and a new call session never announce: the entry announcement owns
    /// that moment and the one-shot channel holds a single announcement.
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

    // MARK: Fit (S20 3 f, 4 c; SC4)

    static func toggledFit(_ fit: StageVideoFit) -> StageVideoFit {
        fit == StageVideoFit.fit ? StageVideoFit.fill : StageVideoFit.fit
    }

    /// The default for a spotlight main without an override: fill on compact width; on regular width fit when the
    /// decoded video aspect differs from the slot by more than 30% (keeps faces uncropped on iPad). An unknown video
    /// size (0) keeps fill. Wiring waits for the WP3 decoded frame size (S70 R70-10).
    static func mainFit(widthClass: String, slotWidth: Double, slotHeight: Double, videoWidth: Double,
                        videoHeight: Double) -> StageVideoFit {
        if StageSizeClass.isCompact(widthClass) { return StageVideoFit.fill }
        if slotWidth <= 0 || slotHeight <= 0 || videoWidth <= 0 || videoHeight <= 0 { return StageVideoFit.fill }
        let slotAspect = slotWidth / slotHeight
        let videoAspect = videoWidth / videoHeight
        let ratio = max(slotAspect, videoAspect) / min(slotAspect, videoAspect)
        return ratio - 1.0 > mainAspectTolerance ? StageVideoFit.fit : StageVideoFit.fill
    }

    // MARK: Tile overlays (S20 3 c, d, f; 4 c, d)

    /// Your own flip control on the tile (iOS, S20 3 c, 6 c): camera on, never on a share slot or the minimized chip,
    /// always on the floating self view, and on other roles only when the slot is not dense (no room for 44 pt).
    /// Chrome visibility is the view's half (it fades with chrome, S20 8).
    static func showsFlipControl(isLocal: Bool, isShare: Bool, role: StageSlotRole, canFlipCamera: Bool,
                                 density: TileChromeDensity) -> Bool {
        if !isLocal || isShare || !canFlipCamera { return false }
        if role == StageSlotRole.selfMinimized { return false }
        if role == StageSlotRole.selfFloating { return true }
        return density != TileChromeDensity.dense
    }

    /// The pinned badge on the spotlight main is itself the Unpin button (S20 4 c, d).
    static func showsUnpinTarget(role: StageSlotRole, isPinned: Bool, isShare: Bool) -> Bool {
        role == StageSlotRole.spotlightMain && isPinned && !isShare
    }

    /// The trailing inset that centers the Unpin hit target on the pinned badge, the leading-most top trailing badge
    /// (F00 C08: pinned, presenting, weak connection, `inset` from the edge, `badgeSpacing` apart), clamped at the edge.
    static func unpinTargetTrailingInset(model: TileChromeModel, density: TileChromeDensity, targetSize: Double) -> Double {
        let badge = TileChromePolicy.badgeSize(density)
        let inset = density == TileChromeDensity.dense ? 4.0 : 8.0
        let after = max(0, TileChromePolicy.trailingBadges(model).count - 1)
        let center = inset + Double(after) * (badge + badgeSpacing) + badge / 2.0
        return max(0.0, center - targetSize / 2.0)
    }

    /// The top inset of the same target, clamped at the tile edge.
    static func unpinTargetTopInset(density: TileChromeDensity, targetSize: Double) -> Double {
        let badge = TileChromePolicy.badgeSize(density)
        let inset = density == TileChromeDensity.dense ? 4.0 : 8.0
        return max(0.0, inset + badge / 2.0 - targetSize / 2.0)
    }

    /// 1:1 with the remote camera off: 96 pt avatar, name and "Camera off" (S20 3 c, d; 3 l4).
    static func showsOneOnOneCaption(kind: StageKind, role: StageSlotRole, isLocal: Bool, isCameraOff: Bool) -> Bool {
        kind == StageKind.oneOnOne && role == StageSlotRole.spotlightMain && !isLocal && isCameraOff
    }

    /// The reconnect reason under the "Reconnecting" pill (web STG-15 `getReasonLabel`): "timeout", "network" or
    /// "interrupted" from the SFU's raw reason.
    static func reconnectReasonKind(_ raw: String) -> String {
        let value = raw.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        if value == "ping timeout" { return "timeout" }
        if value == "transport close" || value == "transport error" { return "network" }
        return "interrupted"
    }
}

// MARK: Spotlight rail geometry (S20 4 c, d)

/// The spotlight, sidebar, presentation and activity rail. Compact portrait: one horizontal strip of 3:4 tiles, 80 x 107,
/// gap 8, side padding 8, directly above the bar slot (4 slots, "+N" included, on 360 dp, 375 pt and 390 pt).
/// Elsewhere (landscape, compact height, iPad, Android 600 dp and wider): a trailing column of 16:9 tiles, 160 wide
/// (200 on iPad regular width and Android expanded width), the same capacity formula along the height. Never a scroll
/// view (renderers are not lazy); capped at `MeetingViewConstants.stageRailMaxTiles`. `StageLayoutPolicy` calls these.
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

    /// Slots in the rail, "+N" included: min(8, floor((content + gap) / (tile + gap))) along the rail axis, at least 1.
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
