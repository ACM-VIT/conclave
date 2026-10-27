#if os(iOS) && !SKIP
import SwiftUI

// STG-2 (S20 3 c, f, g, i; F00 C16; RECONCILE R19): the iOS tile menu. The system context menu over the tile with a
// chrome-only preview, so opening it never creates a second renderer (S20 3 l3); unavailable items are hidden (HIG,
// H-21; F00 C16 c); every available item is also a named accessibility action on the tile (AX4). Items come from the
// shared `TileMenuPolicy` and dispatch through the shared `TileMenuDispatcher`; the people items (S50 3 g `ppl_` copy)
// arrive with PPL-2 through the `people` sections. iOS is silent on open (the system menu, F00 8).

/// The tile menu titles from the String Catalog (S20 3 g; S50 3 g is the single source for Pin and Unpin, R19).
enum TileMenuText {
    static func titles() -> TileMenuTitles {
        TileMenuTitles(
            pin: ConclaveStrings.text("Pin"),
            unpin: ConclaveStrings.text("Unpin"),
            flipCamera: ConclaveStrings.text("Flip Camera"),
            minimizeSelfView: ConclaveStrings.text("Minimize Self View"),
            showSelfView: ConclaveStrings.text("Show Self View"),
            showFullVideo: ConclaveStrings.text("Show Full Video"),
            cropToFill: ConclaveStrings.text("Crop to Fill")
        )
    }
}

/// The pin announcements' words (S20 4 g), for the one stage announcement channel (`StageAnnouncementText` falls back
/// to this for the kinds it does not know; HD/requests/B4-T5.md).
enum TileAnnouncementText {
    static func text(_ announcement: StageAnnouncement) -> String? {
        switch announcement.kind {
        case TileFeaturePolicy.pinnedKind:
            return ConclaveStrings.format("Pinned %@", announcement.name)
        case TileFeaturePolicy.pinClearedKind:
            return ConclaveStrings.format("%@ left. Spotlight follows the speaker.", announcement.name)
        default:
            return nil
        }
    }
}

/// One tile's menu, built in the tile body from values the tile already holds (its slot, its model, the stage kind and,
/// for your own tile only, the flip capability), so a remote tile observes nothing new.
struct TileMenuModel {
    let context: TileMenuContext
    let sections: [MenuSectionModel]

    @MainActor
    static func make(slot: StageSlot, model: TileChromeModel, stage: StagePresenter,
                     people: [MenuSectionModel] = []) -> TileMenuModel {
        let canFlip = model.isLocal ? stage.chrome.canFlipCamera : false
        let context = TileMenuContext.make(slot: slot, model: model, kind: stage.kind, canFlipCamera: canFlip, offersFlipItem: true)
        return TileMenuModel(context: context, sections: TileMenuPolicy.sections(context, titles: TileMenuText.titles(), people: people))
    }

    /// The context menu shows only available items (H-21).
    var contextSections: [MenuSectionModel] { TileMenuPolicy.contextMenuSections(sections) }

    /// The same items as named accessibility actions; `onDispatched` receives the item id after a stage dispatch.
    @MainActor
    func accessibilityActions(stage: StagePresenter, onDispatched: @escaping (String) -> Void) -> [ConclaveTileAction] {
        var result: [ConclaveTileAction] = []
        let menuContext = self.context
        for item in TileMenuPolicy.accessibilityItems(sections) {
            let id = item.id
            result.append(ConclaveTileAction(id: id, title: item.title, action: {
                if TileMenuDispatcher.perform(id, context: menuContext, stage: stage) {
                    onDispatched(id)
                }
            }))
        }
        return result
    }
}

extension View {
    /// Attaches the tile menu (S20 3 c). The modifier is applied for every role so the tile's structure never changes
    /// with the role or the stage kind (D15); a slot without items shows no menu.
    func stageTileMenu(_ menu: TileMenuModel, model: TileChromeModel, speaking: TileSpeakingState, stage: StagePresenter,
                       onDispatched: @escaping (String) -> Void) -> some View {
        modifier(StageTileMenuModifier(menu: menu, model: model, speaking: speaking, stage: stage, onDispatched: onDispatched))
    }
}

private struct StageTileMenuModifier: ViewModifier {
    let menu: TileMenuModel
    let model: TileChromeModel
    let speaking: TileSpeakingState
    let stage: StagePresenter
    let onDispatched: (String) -> Void

    func body(content: Content) -> some View {
        content.contextMenu {
            // The system builds these rows when the menu opens; the dark stage environment carries into the menu.
            ConclaveMenuContent(sections: menu.contextSections, onSelect: { item in
                if TileMenuDispatcher.perform(item.id, context: menu.context, stage: stage) {
                    onDispatched(item.id)
                }
            })
        } preview: {
            TileMenuPreview(model: model, speaking: speaking)
        }
    }
}

/// The context menu preview (S20 3 c): the tile's chrome over the flat tile fill with the avatar face, never a live
/// renderer, so the renderer ledger's `created` count stays unchanged when the menu opens (S20 3 l3).
struct TileMenuPreview: View {
    let model: TileChromeModel
    let speaking: TileSpeakingState

    var body: some View {
        ConclaveTileChrome(model: TileMenuPreview.faceModel(model), speaking: speaking, identifier: "stage.tile.menuPreview") {
            HostingTheme.token(DesignTokens.iosInCallTile)
        }
        .frame(width: 240, height: 180)
        .accessibilityHidden(true)
    }

    /// The preview draws the avatar face because it shows no video.
    static func faceModel(_ model: TileChromeModel) -> TileChromeModel {
        TileChromeModel(userId: model.userId, displayName: model.displayName, avatarSeed: model.avatarSeed, isLocal: model.isLocal,
                        isMuted: model.isMuted, isCameraOff: true, isHandRaised: model.isHandRaised, isPinned: model.isPinned,
                        isPresenting: model.isPresenting, isWeakConnection: model.isWeakConnection,
                        isReconnecting: model.isReconnecting, reconnectReason: model.reconnectReason, isHost: model.isHost,
                        isVoiceAgent: model.isVoiceAgent)
    }
}
#endif
