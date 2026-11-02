#if os(iOS) && !SKIP
import SwiftUI

struct MoreSheet: View {
    let controls: CallControlsPresenter
    let actions: MoreActions
    let onClose: () -> Void
    @State private var mainHeight: CGFloat = 0
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    var body: some View {
        let more = controls.more
        let hostItems = MoreMenuPolicy.hostItems(more)
        let groups = MoreSheetLayout.groups(more)
        ScrollView {
            VStack(spacing: 20) {
                VStack(spacing: 20) {
                    MoreSheetReactionStrip(controls: controls, actions: actions)
                    MoreSheetQuickActions(items: MoreSheetLayout.quickActions(more), controls: controls, actions: actions)
                    ForEach(groups.indices, id: \.self) { index in
                        MoreSheetGroup(items: groups[index], more: more, controls: controls, actions: actions)
                    }
                }
                .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { mainHeight = $0 }
                if !hostItems.isEmpty {
                    MoreSheetHostBlock(items: hostItems, more: more, controls: controls, actions: actions)
                }
            }
            .padding(.horizontal, 16)
            .padding(.top, 28)
            .padding(.bottom, 16)
        }
        .scrollBounceBehavior(.basedOnSize)
        .presentationDetents(MoreSheetDetents.detents(mainHeight: mainHeight, hasHost: !hostItems.isEmpty,
                                                      isAccessibilitySize: dynamicTypeSize.isAccessibilitySize))
        .presentationDragIndicator(.visible)
        .presentationBackground(Color(uiColor: .systemGroupedBackground))
        .presentationCornerRadius(28)
        .accessibilityIdentifier("sheet.more.ios")
        .accessibilityAction(.escape, onClose)
    }
}

enum MoreSheetDetents {
    static let chrome: CGFloat = 44
    static let hostPeek: CGFloat = 56

    static func detents(mainHeight: CGFloat, hasHost: Bool, isAccessibilitySize: Bool) -> Set<PresentationDetent> {
        if isAccessibilitySize || mainHeight <= 0 { return [.large] }
        let resting = PresentationDetent.height(mainHeight + chrome + (hasHost ? hostPeek : 0))
        return hasHost ? [resting, .large] : [resting]
    }
}

enum MoreSheetLayout {
    static let quickKinds: [MoreItemID] = [MoreItemID.hand, MoreItemID.screenShare, MoreItemID.captions, MoreItemID.flipCamera]
    static let shareKinds: [MoreItemID] = [MoreItemID.invite, MoreItemID.copyLink, MoreItemID.meetingDetails, MoreItemID.settings]
    static let skipped: [MoreItemID] = [MoreItemID.reactions, MoreItemID.moreReactions, MoreItemID.hostControls,
                                        MoreItemID.lockMeeting, MoreItemID.endForEveryone]

    static func quickActions(_ more: MoreSnapshot) -> [MoreItem] {
        quickKinds.compactMap { more.item($0) }
    }

    static func groups(_ more: MoreSnapshot) -> [[MoreItem]] {
        let all = more.sections.flatMap(\.items)
        let places = all.filter { !quickKinds.contains($0.kind) && !shareKinds.contains($0.kind) && !skipped.contains($0.kind)
            && !MoreMenuPolicy.hostItems(more).contains($0) }
        let share = shareKinds.compactMap { more.item($0) }
        return [places, share].filter { !$0.isEmpty }
    }
}

private struct MoreSheetReactionStrip: View {
    let controls: CallControlsPresenter
    let actions: MoreActions

    var body: some View {
        let reactions = controls.reactions
        let more = controls.more
        if reactions.isAvailable {
            HStack(spacing: 0) {
                ForEach(reactions.emoji) { option in
                    Button {
                        actions.sendReaction(option.id, controls: controls)
                    } label: {
                        ReactionGlyph(option: option)
                            .frame(maxWidth: .infinity, minHeight: 52)
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(MoreSheetPressStyle())
                    .accessibilityLabel(MoreCopy.reactionLabel(option))
                    .accessibilityIdentifier("sheet.more.ios.reactions." + option.nameKey)
                }
                if let extra = more.item(MoreItemID.moreReactions) {
                    Button {
                        actions.choose(extra, controls: controls)
                    } label: {
                        Image(systemName: ConclaveSymbols.plus)
                            .font(.body.weight(.semibold))
                            .foregroundStyle(.secondary)
                            .frame(width: 36, height: 36)
                            .background(Color(uiColor: .tertiarySystemFill), in: Circle())
                            .frame(maxWidth: .infinity, minHeight: 52)
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(MoreSheetPressStyle())
                    .disabled(!extra.isEnabled)
                    .accessibilityLabel(MoreCopy.title(extra))
                    .accessibilityIdentifier("sheet.more.ios.moreReactions")
                }
            }
            .padding(.horizontal, 6)
            .background(Color(uiColor: .secondarySystemGroupedBackground), in: Capsule())
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier("sheet.more.ios.reactions")
        } else if let item = more.item(MoreItemID.reactions) {
            Label(MoreCopy.subtitle(item) ?? MoreCopy.title(item), systemImage: ConclaveSymbols.faceSmiling)
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .frame(maxWidth: .infinity, minHeight: 52)
                .background(Color(uiColor: .secondarySystemGroupedBackground), in: Capsule())
        }
    }
}

private struct MoreSheetQuickActions: View {
    let items: [MoreItem]
    let controls: CallControlsPresenter
    let actions: MoreActions

    var body: some View {
        HStack(alignment: .top, spacing: 8) {
            ForEach(items) { item in
                MoreSheetQuickButton(item: item, controls: controls, actions: actions)
            }
        }
    }
}

private struct MoreSheetQuickButton: View {
    let item: MoreItem
    let controls: CallControlsPresenter
    let actions: MoreActions

    var body: some View {
        let on = item.isOn
        Button {
            if item.kind == MoreItemID.captions {
                _ = controls.setCaptions(!on)
            } else {
                actions.choose(item, controls: controls)
            }
        } label: {
            VStack(spacing: 8) {
                ZStack {
                    Circle()
                        .fill(on ? AnyShapeStyle(HostingTheme.coralFill) : AnyShapeStyle(Color(uiColor: .secondarySystemGroupedBackground)))
                    if item.isPending {
                        ProgressView().tint(on ? HostingTheme.inCallOnCoral : Color.primary)
                    } else {
                        Image(systemName: MoreCopy.glyph(item))
                            .font(.title3.weight(.medium))
                            .foregroundStyle(on ? HostingTheme.inCallOnCoral : Color.primary)
                    }
                }
                .frame(width: 60, height: 60)
                Text(MoreSheetLayout.quickTitle(item))
                    .font(.caption.weight(.medium))
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
                    .lineLimit(2)
                    .minimumScaleFactor(0.85)
            }
            .frame(maxWidth: .infinity)
            .contentShape(Rectangle())
        }
        .buttonStyle(MoreSheetPressStyle())
        .disabled(!item.isEnabled || item.isPending)
        .opacity(item.isEnabled ? 1 : HostingTheme.disabledOpacity)
        .accessibilityLabel(MoreCopy.accessibilityTitle(item))
        .accessibilityValue(item.kind == MoreItemID.captions ? MoreCopy.captionsStateTitle(item) : "")
        .accessibilityAddTraits(on ? [.isSelected] : [])
        .accessibilityHint(MoreCopy.subtitle(item) ?? "")
        .accessibilityIdentifier("sheet.more.ios." + item.id)
    }
}

struct MoreSheetStatusNote: Equatable {
    let text: String
    let isWarning: Bool
}

extension MoreSheetLayout {
    static func statusNote(_ item: MoreItem) -> MoreSheetStatusNote? {
        guard let text = MoreCopy.subtitle(item) else { return nil }
        switch item.status {
        case .paused, .notesOff: return MoreSheetStatusNote(text: text, isWarning: false)
        case .attention: return MoreSheetStatusNote(text: text, isWarning: true)
        default: return nil
        }
    }

    static func quickTitle(_ item: MoreItem) -> String {
        switch item.kind {
        case .hand: return item.isOn ? ConclaveStrings.text("Lower Hand") : ConclaveStrings.text("Raise Hand")
        default: return MoreCopy.title(item)
        }
    }
}

private struct MoreSheetGroup: View {
    let items: [MoreItem]
    let more: MoreSnapshot
    let controls: CallControlsPresenter
    let actions: MoreActions

    var body: some View {
        VStack(spacing: 0) {
            ForEach(items) { item in
                MoreSheetListRow(item: item, more: more, controls: controls, actions: actions)
                if item.id != items.last?.id {
                    Divider().padding(.leading, 56)
                }
            }
        }
        .background(Color(uiColor: .secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 16, style: .continuous))
    }
}

private struct MoreSheetListRow: View {
    let item: MoreItem
    let more: MoreSnapshot
    let controls: CallControlsPresenter
    let actions: MoreActions

    var body: some View {
        switch item.kind {
        case .lockMeeting:
            Toggle(isOn: Binding(get: { item.isOn }, set: { _ in actions.choose(item, controls: controls) })) {
                Label {
                    Text(MoreCopy.title(item)).font(.body)
                } icon: {
                    Image(systemName: MoreCopy.glyph(item))
                        .font(.body.weight(.medium))
                        .frame(width: 26)
                }
                .labelStyle(MoreSheetRowLabelStyle())
            }
            .tint(HostingTheme.coralFill)
            .padding(.horizontal, 16)
            .frame(minHeight: 50)
            .disabled(!item.isEnabled || item.isPending)
            .accessibilityIdentifier("sheet.more.ios." + item.id)
        case .endForEveryone:
            Button(role: .destructive) {
                actions.choose(item, controls: controls)
            } label: {
                row(chevron: false, tint: Color(uiColor: .systemRed))
            }
            .buttonStyle(MoreSheetRowPressStyle())
            .disabled(!item.isEnabled)
            .accessibilityIdentifier("sheet.more.ios.endForEveryone")
        case .invite:
            if let url = URL(string: more.meetingLink) {
                ShareLink(item: url, subject: Text(ConclaveStrings.text("Join My Conclave Meeting")),
                          message: Text(ConclaveStrings.text("Join me in this Conclave meeting.")),
                          preview: SharePreview(Text(more.roomLabel))) {
                    row(chevron: false)
                }
                .buttonStyle(MoreSheetRowPressStyle())
                .accessibilityLabel(MoreCopy.accessibilityTitle(item))
                .accessibilityIdentifier("sheet.more.ios.invite")
            }
        case .copyLink:
            Button {
                actions.copyLink(more.meetingLink, controls: controls)
            } label: {
                row(chevron: false)
            }
            .buttonStyle(MoreSheetRowPressStyle())
            .accessibilityIdentifier("sheet.more.ios.copyLink")
        case .layout:
            Menu {
                Picker(selection: Binding(get: { more.layoutMode }, set: { raw in _ = controls.setLayoutMode(raw) })) {
                    ForEach(more.layoutModes, id: \.self) { raw in
                        Text(MoreCopy.layoutTitle(raw)).tag(raw)
                    }
                } label: {
                    EmptyView()
                }
                .pickerStyle(.inline)
                Button(ConclaveStrings.text("Layout Options")) {
                    actions.choose(item, controls: controls)
                }
            } label: {
                row(chevron: true, value: MoreCopy.layoutTitle(more.layoutMode), chevronSymbol: ConclaveSymbols.chevronUpChevronDown)
            }
            .buttonStyle(MoreSheetRowPressStyle())
            .disabled(!item.isEnabled)
            .accessibilityIdentifier("sheet.more.ios.layout")
        default:
            Button {
                actions.choose(item, controls: controls)
            } label: {
                row(chevron: true)
            }
            .buttonStyle(MoreSheetRowPressStyle())
            .disabled(!item.isEnabled)
            .accessibilityLabel(MoreCopy.accessibilityTitle(item))
            .accessibilityHint(MoreCopy.subtitle(item) ?? "")
            .accessibilityIdentifier("sheet.more.ios." + item.id)
        }
    }

    private var badge: Int {
        item.kind == MoreItemID.participants || item.kind == MoreItemID.qa || item.kind == MoreItemID.chat ? item.count : 0
    }

    private func row(chevron: Bool, value: String? = nil, chevronSymbol: String = ConclaveSymbols.chevronRight,
                     tint: Color? = nil) -> some View {
        HStack(spacing: 14) {
            Image(systemName: MoreCopy.glyph(item))
                .font(.body.weight(.medium))
                .foregroundStyle(tint ?? (item.isOn ? HostingTheme.coralFill : Color.primary))
                .frame(width: 26)
            Text(MoreCopy.accessibilityTitle(item))
                .font(.body)
                .foregroundStyle(tint ?? Color.primary)
                .lineLimit(1)
            Spacer(minLength: 8)
            if badge > 0 {
                Text(badge.formatted(.number))
                    .font(.subheadline.weight(.semibold))
                    .monospacedDigit()
                    .foregroundStyle(HostingTheme.inCallOnCoral)
                    .padding(.horizontal, 7)
                    .frame(minWidth: 24, minHeight: 22)
                    .background(HostingTheme.coralFill, in: Capsule())
                    .accessibilityHidden(true)
            } else if value == nil, let note = MoreSheetLayout.statusNote(item) {
                HStack(spacing: 4) {
                    if note.isWarning {
                        Image(systemName: ConclaveSymbols.exclamationmarkTriangleFill)
                            .font(.footnote)
                    }
                    Text(note.text)
                        .font(.subheadline)
                        .lineLimit(1)
                }
                .foregroundStyle(note.isWarning ? AnyShapeStyle(HostingTheme.coralFill) : AnyShapeStyle(.secondary))
                .accessibilityHidden(true)
            } else if item.status != MoreItemStatus.none && value == nil {
                Circle()
                    .fill(HostingTheme.coralFill)
                    .frame(width: 8, height: 8)
                    .accessibilityHidden(true)
            }
            if let value {
                Text(value)
                    .font(.body)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
            if chevron {
                Image(systemName: chevronSymbol)
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(.tertiary)
                    .accessibilityHidden(true)
            }
        }
        .padding(.horizontal, 16)
        .frame(minHeight: 50)
        .opacity(item.isEnabled ? 1 : HostingTheme.disabledOpacity)
        .contentShape(Rectangle())
    }
}

private struct MoreSheetRowLabelStyle: LabelStyle {
    func makeBody(configuration: Configuration) -> some View {
        HStack(spacing: 14) {
            configuration.icon
            configuration.title
        }
    }
}

private struct MoreSheetPressStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .scaleEffect(configuration.isPressed ? 0.94 : 1)
            .animation(.snappy(duration: 0.18), value: configuration.isPressed)
    }
}

private struct MoreSheetRowPressStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .background(configuration.isPressed ? Color(uiColor: .tertiarySystemFill) : Color.clear)
    }
}

private struct MoreSheetHostBlock: View {
    let items: [MoreItem]
    let more: MoreSnapshot
    let controls: CallControlsPresenter
    let actions: MoreActions

    var body: some View {
        let regular = items.filter { $0.kind != MoreItemID.endForEveryone }
        let end = items.filter { $0.kind == MoreItemID.endForEveryone }
        VStack(alignment: .leading, spacing: 8) {
            Text(ConclaveStrings.text("Host"))
                .font(.footnote.weight(.semibold))
                .foregroundStyle(.secondary)
                .padding(.horizontal, 16)
                .accessibilityAddTraits(.isHeader)
            VStack(spacing: 20) {
                if !regular.isEmpty {
                    MoreSheetGroup(items: regular, more: more, controls: controls, actions: actions)
                }
                if !end.isEmpty {
                    MoreSheetGroup(items: end, more: more, controls: controls, actions: actions)
                }
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("sheet.more.ios.host")
    }
}
#endif
