#if os(iOS) && !SKIP
import SwiftUI

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

enum TileAnnouncementText {
    static func text(_ announcement: StageAnnouncement) -> String? {
        switch announcement.kind {
        case TileFeaturePolicy.pinnedKind:
            return ConclaveStrings.format("Pinned %@", announcement.name)
        case TileFeaturePolicy.pinClearedKind:
            return ConclaveStrings.format("%@ left. Spotlight follows the speaker.", announcement.name)
        default:

            return PeopleActionText.announcement(announcement)
        }
    }
}

struct TileMenuModel {
    let context: TileMenuContext
    let sections: [MenuSectionModel]

    @MainActor
    static func make(slot: StageSlot, model: TileChromeModel, stage: StagePresenter,
                     people: [MenuSectionModel] = []) -> TileMenuModel {
        let canFlip = model.isLocal ? stage.chrome.canFlipCamera : false
        let context = TileMenuContext.make(slot: slot, model: model, kind: stage.kind, canFlipCamera: canFlip, offersFlipItem: true)
        let peopleSections = TilePeopleMenu.sections(context, stage: stage) + people
        return TileMenuModel(context: context,
                             sections: TileMenuPolicy.sections(context, titles: TileMenuText.titles(), people: peopleSections))
    }

    var contextSections: [MenuSectionModel] { TileMenuPolicy.contextMenuSections(sections) }

    @MainActor
    func accessibilityActions(stage: StagePresenter, onDispatched: @escaping (String) -> Void) -> [ConclaveTileAction] {
        var result: [ConclaveTileAction] = []
        let menuContext = self.context
        for item in TileMenuPolicy.accessibilityItems(sections) {
            let id = item.id
            result.append(ConclaveTileAction(id: id, title: item.title, action: {
                if TileMenuDispatcher.perform(id, context: menuContext, stage: stage) {
                    onDispatched(id)
                } else {
                    TilePeopleMenu.perform(id, context: menuContext, stage: stage)
                }
            }))
        }
        return result
    }
}

extension View {

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

            ConclaveMenuContent(sections: menu.contextSections, onSelect: { item in
                if TileMenuDispatcher.perform(item.id, context: menu.context, stage: stage) {
                    onDispatched(item.id)
                } else {
                    TilePeopleMenu.perform(item.id, context: menu.context, stage: stage)
                }
            })
        } preview: {
            TileMenuPreview(model: model, speaking: speaking)
        }
    }
}

enum TilePeopleMenu {
    @MainActor
    static func sections(_ context: TileMenuContext, stage: StagePresenter) -> [MenuSectionModel] {
        guard TileMenuPolicy.hasMenu(slotId: context.slotId, role: context.role, kind: context.kind),
              let people = stage.people, people.rows.contains(context.userId) else { return [] }
        let row = people.rows.entry(for: context.userId).model
        let actions = PeopleActionPolicy.tileActions(row.actions)
        if actions.isEmpty { return [] }
        return PeopleActionPolicy.menuSections(actions, titles: PeopleActionText.titles(name: PeopleActionText.displayName(row)))
    }

    @MainActor
    @discardableResult
    static func perform(_ itemId: String, context: TileMenuContext, stage: StagePresenter) -> Bool {
        guard let action = PersonActionID(rawValue: itemId), let people = stage.people else { return false }
        return people.perform(action, rowId: context.userId, source: PeopleActionSource.tileMenu) == ControlTapResult.dispatched
    }
}

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

    static func faceModel(_ model: TileChromeModel) -> TileChromeModel {
        TileChromeModel(userId: model.userId, displayName: model.displayName, avatarSeed: model.avatarSeed, isLocal: model.isLocal,
                        isMuted: model.isMuted, isCameraOff: true, isHandRaised: model.isHandRaised, isPinned: model.isPinned,
                        isPresenting: model.isPresenting, isWeakConnection: model.isWeakConnection,
                        isReconnecting: model.isReconnecting, reconnectReason: model.reconnectReason, isHost: model.isHost,
                        isVoiceAgent: model.isVoiceAgent)
    }
}
#endif
