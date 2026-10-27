#if os(iOS) && !SKIP
import SwiftUI

// Menus, context menus and the reaction palette (F00 C16, C22). The system `Menu` and `contextMenu` keep their own
// rendering, motion, semantics and haptics; menus inherit the invoker's dark environment over the stage. These
// helpers build menu content from the shared `MenuSectionModel`, so the iOS menu, the iOS fallback sheet and the
// Android sheet read one model. Content is built only when the menu opens (the system calls the builder then).

/// The SF Symbol for a manifest concept used in menus, nil for a concept with no glyph. Screens may pass their own.
enum ConclaveMenuSymbols {
    static func symbol(for concept: String) -> String? {
        switch concept {
        case "raise_hand": return ConclaveSymbols.handRaised
        case "share_screen": return ConclaveSymbols.rectangleOnRectangle
        case "stop_sharing": return ConclaveSymbols.rectangleOnRectangleSlash
        case "captions": return ConclaveSymbols.captionsBubble
        case "settings": return ConclaveSymbols.gearshape
        case "participants": return ConclaveSymbols.person2
        case "lock_meeting": return ConclaveSymbols.lockFill
        case "pin": return ConclaveSymbols.pin
        case "unpin": return ConclaveSymbols.pinSlash
        case "mute_person": return ConclaveSymbols.micSlash
        case "camera_off_person": return ConclaveSymbols.videoSlash
        case "remove_person": return ConclaveSymbols.personFillXmark
        case "more": return ConclaveSymbols.ellipsis
        case "chat": return ConclaveSymbols.message
        case "copy_link": return ConclaveSymbols.docOnDoc
        case "invite": return ConclaveSymbols.squareAndArrowUp
        case "reactions": return ConclaveSymbols.faceSmiling
        case "activities_games": return ConclaveSymbols.gamecontrollerFill
        case "info": return ConclaveSymbols.infoCircle
        case "search": return ConclaveSymbols.magnifyingglass
        case "host": return ConclaveSymbols.crownFill
        case "delete": return ConclaveSymbols.trash
        default: return nil
        }
    }
}

/// Menu rows from sections, in stable order. Sections become system sections (separators between them); a toggle
/// row is a system `Toggle` (checkmark); a destructive row takes the destructive role; an unavailable row stays,
/// disabled, with its reason as a second line (R10). Items that need another step end with an ellipsis in their
/// title (the caller's copy).
struct ConclaveMenuContent: View {
    let sections: [MenuSectionModel]
    let symbol: (MenuItemModel) -> String?
    let onSelect: (MenuItemModel) -> Void

    init(sections: [MenuSectionModel], symbol: @escaping (MenuItemModel) -> String? = { ConclaveMenuSymbols.symbol(for: $0.concept) },
         onSelect: @escaping (MenuItemModel) -> Void) {
        self.sections = sections
        self.symbol = symbol
        self.onSelect = onSelect
    }

    var body: some View {
        ForEach(sections) { section in
            Section {
                ForEach(section.items) { item in
                    ConclaveMenuRow(item: item, systemImage: symbol(item), onSelect: onSelect)
                }
            }
        }
    }
}

private struct ConclaveMenuRow: View {
    let item: MenuItemModel
    let systemImage: String?
    let onSelect: (MenuItemModel) -> Void

    var body: some View {
        switch item.role {
        case .toggle:
            Toggle(isOn: Binding(get: { item.isOn }, set: { _ in onSelect(item) })) {
                label
            }
            .disabled(!item.isEnabled)
        case .destructive:
            Button(role: .destructive) { onSelect(item) } label: { label }
                .disabled(!item.isEnabled)
        case .normal:
            Button { onSelect(item) } label: { label }
                .disabled(!item.isEnabled)
        }
    }

    @ViewBuilder
    private var label: some View {
        if let systemImage {
            Label {
                titleAndReason
            } icon: {
                Image(systemName: systemImage)
            }
        } else {
            titleAndReason
        }
    }

    @ViewBuilder
    private var titleAndReason: some View {
        Text(item.title)
        if !item.isEnabled && !item.disabledReason.isEmpty {
            Text(item.disabledReason)
        }
    }
}

/// Where a menu's first item sits. Menus opened from the bottom bar keep the first declared item nearest the control
/// (`.priority`); other menus keep the declared order (S30 CL5, D23).
enum ConclaveMenuOrder: String, CaseIterable {
    case fromBar, fixed
}

/// An anchored menu (F00 C16) over a label the caller draws (the More control, a row's More, the host Leave).
struct ConclaveMenuButton<MenuLabel: View>: View {
    let sections: [MenuSectionModel]
    let order: ConclaveMenuOrder
    let identifier: String
    let onSelect: (MenuItemModel) -> Void
    @ViewBuilder let label: () -> MenuLabel

    init(sections: [MenuSectionModel], order: ConclaveMenuOrder = .fixed, identifier: String,
         onSelect: @escaping (MenuItemModel) -> Void, @ViewBuilder label: @escaping () -> MenuLabel) {
        self.sections = sections
        self.order = order
        self.identifier = identifier
        self.onSelect = onSelect
        self.label = label
    }

    var body: some View {
        Menu {
            ConclaveMenuContent(sections: sections, onSelect: onSelect)
        } label: {
            label()
        }
        .menuOrder(order == .fromBar ? .priority : .fixed)
        .accessibilityIdentifier(identifier)
    }
}

/// The reaction palette (F00 C22): one row of emoji in a palette `ControlGroup` inside a menu. Each emoji is
/// labelled; already-used reactions carry the selected trait. While reactions are off the row stays, disabled,
/// with the reason as its value. The owning control plays `reactionSent` (a menu item may unmount first).
struct ConclaveReactionPalette: View {
    let options: [ConclavePaletteOption]
    let isEnabled: Bool
    let identifier: String
    let onSelect: (ConclavePaletteOption) -> Void

    init(options: [ConclavePaletteOption], isEnabled: Bool = true, identifier: String,
         onSelect: @escaping (ConclavePaletteOption) -> Void) {
        self.options = options
        self.isEnabled = isEnabled
        self.identifier = identifier
        self.onSelect = onSelect
    }

    var body: some View {
        ControlGroup {
            ForEach(options) { option in
                Button {
                    onSelect(option)
                } label: {
                    Text(option.emoji)
                }
                .accessibilityLabel(option.label)
                .accessibilityAddTraits(option.isSelected ? [.isSelected] : [])
                .modifier(PaletteReason(isEnabled: isEnabled))
                .accessibilityIdentifier(identifier + "." + option.id)
            }
        }
        .controlGroupStyle(.palette)
        .disabled(!isEnabled)
        .accessibilityIdentifier(identifier)
    }
}

private struct PaletteReason: ViewModifier {
    let isEnabled: Bool

    @ViewBuilder
    func body(content: Content) -> some View {
        if isEnabled {
            content
        } else {
            content.accessibilityValue(ConclaveStrings.text("Reactions are off"))
        }
    }
}
#endif
