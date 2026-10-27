#if os(iOS) && !SKIP
import SwiftUI

// S30 5 c, CL16 (CTL-5): the dark fallback sheet the More control opens instead of the native menu whenever the menu
// would need to scroll (accessibility sizes, the iPhone compact-height column, a long host or webinar menu on a short
// iPhone). The same `MoreSnapshot` as a List, top to bottom like Android: reactions (the emoji row inline; the sheet
// stays open across sends), You, Panels, Share, Host (End last in its own section). An action surface, not a content
// panel, so no background interaction (OD Q8 1 is for content panels); detents medium and large; a "More" heading and
// a Close button (S30 5 i). Rows that open something (panels, End, a share start) go through `selectAfterDismiss`, so
// the panel or the End dialog presents from the sheet's `onDismiss`, never from a dismissing sheet (NF 9.1). Rows grow
// with Dynamic Type (the More control passes the uncapped size). No custom fills: the in-call dark system List (D3).

struct MoreSheet: View {
    let controls: CallControlsPresenter
    let actions: MoreActions
    let onClose: () -> Void

    var body: some View {
        NavigationStack {
            MoreSheetList(controls: controls, actions: actions)
                .navigationTitle(ConclaveStrings.text("More"))
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .topBarTrailing) {
                        Button(action: onClose) {
                            Image(systemName: ConclaveSymbols.xmark)
                        }
                        .accessibilityLabel(ConclaveStrings.text("Close"))
                        .accessibilityIdentifier("sheet.more.ios.close")
                    }
                }
        }
        .accessibilityIdentifier("sheet.more.ios")
    }
}

/// The list reads `more` (rows) and, in its reactions section only, `reactions`.
private struct MoreSheetList: View {
    let controls: CallControlsPresenter
    let actions: MoreActions

    var body: some View {
        let more = controls.more
        List {
            ForEach(more.sections) { section in
                switch section.id {
                case MoreSectionID.reactions:
                    Section {
                        MoreSheetReactions(section: section, controls: controls, actions: actions)
                    }
                case MoreSectionID.host:
                    Section(ConclaveStrings.text("Host")) {
                        ForEach(section.items) { item in
                            if item.kind != MoreItemID.endForEveryone {
                                MoreSheetRow(item: item, more: more, controls: controls, actions: actions)
                            }
                        }
                    }
                    if let end = section.items.first(where: { $0.kind == MoreItemID.endForEveryone }) {
                        Section {
                            MoreSheetRow(item: end, more: more, controls: controls, actions: actions)
                        }
                    }
                default:
                    Section {
                        ForEach(section.items) { item in
                            MoreSheetRow(item: item, more: more, controls: controls, actions: actions)
                        }
                    }
                }
            }
        }
    }
}

/// The emoji row inline (44 pt targets, labelled), the art row once flat art ships, or the reason row while reactions
/// cannot send. Sends keep the sheet open (S30 5 f row 1).
private struct MoreSheetReactions: View {
    let section: MoreSection
    let controls: CallControlsPresenter
    let actions: MoreActions

    var body: some View {
        let reactions = controls.reactions
        if reactions.isAvailable {
            MoreSheetReactionRow(options: reactions.emoji, controls: controls, actions: actions, identifier: "sheet.more.ios.reactions")
            if !reactions.art.isEmpty {
                MoreSheetReactionRow(options: reactions.art, controls: controls, actions: actions, identifier: "sheet.more.ios.art")
            }
        } else if let item = section.items.first {
            MoreRowLabel(title: MoreCopy.title(item), subtitle: MoreCopy.subtitle(item), systemImage: MoreCopy.glyph(item))
                .foregroundStyle(.secondary)
                .accessibilityElement(children: .combine)
        }
    }
}

private struct MoreSheetReactionRow: View {
    let options: [ReactionOptionModel]
    let controls: CallControlsPresenter
    let actions: MoreActions
    let identifier: String

    var body: some View {
        HStack(spacing: 4) {
            ForEach(options) { option in
                Button {
                    actions.sendReaction(option.id, controls: controls)
                } label: {
                    ReactionGlyph(option: option)
                        .frame(maxWidth: .infinity, minHeight: 44)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.borderless)
                .accessibilityLabel(MoreCopy.reactionLabel(option))
                .accessibilityIdentifier(identifier + "." + option.nameKey)
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier(identifier)
    }
}

/// One sheet row: the same titles, subtitles and glyphs as the menu. Captions and Lock Meeting are toggles; Layout is
/// an inline picker plus "Layout Options"; Invite is the same `ShareLink`; Copy Link acts in place with its toast.
private struct MoreSheetRow: View {
    let item: MoreItem
    let more: MoreSnapshot
    let controls: CallControlsPresenter
    let actions: MoreActions

    var body: some View {
        switch item.kind {
        case .captions:
            Toggle(isOn: Binding(get: { item.isOn }, set: { on in _ = controls.setCaptions(on) })) {
                MoreRowLabel(title: MoreCopy.title(item), subtitle: MoreCopy.subtitle(item), systemImage: MoreCopy.glyph(item))
            }
            .disabled(!item.isEnabled)
            .accessibilityIdentifier("sheet.more.ios." + item.id)
        case .lockMeeting:
            Toggle(isOn: Binding(get: { item.isOn }, set: { _ in actions.choose(item, controls: controls) })) {
                MoreRowLabel(title: MoreCopy.title(item), subtitle: MoreCopy.subtitle(item), systemImage: MoreCopy.glyph(item))
            }
            .disabled(!item.isEnabled)
            .accessibilityIdentifier("sheet.more.ios." + item.id)
        case .layout:
            Picker(selection: Binding(get: { more.layoutMode }, set: { raw in _ = controls.setLayoutMode(raw) })) {
                ForEach(more.layoutModes, id: \.self) { raw in
                    Text(MoreCopy.layoutTitle(raw)).tag(raw)
                }
            } label: {
                MoreRowLabel(title: MoreCopy.title(item), subtitle: nil, systemImage: MoreCopy.glyph(item))
            }
            .pickerStyle(.menu)
            .disabled(!item.isEnabled)
            .accessibilityIdentifier("sheet.more.ios.layout")
            Button(ConclaveStrings.text("Layout Options")) {
                actions.choose(item, controls: controls)
            }
            .disabled(!item.isEnabled)
            .accessibilityIdentifier("sheet.more.ios.layoutOptions")
        case .invite:
            if let url = URL(string: more.meetingLink) {
                ShareLink(item: url, subject: Text(ConclaveStrings.text("Join My Conclave Meeting")),
                          message: Text(ConclaveStrings.text("Join me in this Conclave meeting.")),
                          preview: SharePreview(Text(more.roomLabel))) {
                    MoreRowLabel(title: ConclaveStrings.text("Share Invite"), subtitle: nil, systemImage: MoreCopy.glyph(item))
                }
                .accessibilityIdentifier("sheet.more.ios.invite")
            }
        case .copyLink:
            Button {
                actions.copyLink(more.meetingLink, controls: controls)
            } label: {
                MoreRowLabel(title: MoreCopy.title(item), subtitle: nil, systemImage: MoreCopy.glyph(item))
            }
            .accessibilityIdentifier("sheet.more.ios.copyLink")
        case .endForEveryone:
            Button(role: .destructive) {
                actions.choose(item, controls: controls)
            } label: {
                MoreRowLabel(title: MoreCopy.title(item), subtitle: MoreCopy.subtitle(item), systemImage: MoreCopy.glyph(item))
            }
            .disabled(!item.isEnabled)
            .accessibilityIdentifier("sheet.more.ios.endForEveryone")
        default:
            Button {
                actions.choose(item, controls: controls)
            } label: {
                MoreRowLabel(title: MoreCopy.accessibilityTitle(item), subtitle: MoreCopy.subtitle(item), systemImage: MoreCopy.glyph(item))
            }
            .disabled(!item.isEnabled)
            .accessibilityIdentifier("sheet.more.ios." + item.id)
        }
    }
}
#endif
