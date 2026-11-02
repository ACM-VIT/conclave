#if os(iOS) && !SKIP
import SwiftUI

struct LayoutPanel: View {
    let layout: LayoutPanelPresenter
    let shell: MeetingShellPresenter
    let adapter: NativePanelHostAdapter
    let presentation: NativePanelPresentation
    let resolved: PanelPresentation
    @Environment(\.conclaveSystemColorScheme) private var systemScheme

    var body: some View {
        PanelShell(title: LayoutCopy.title(), presentation: resolved, hostStyle: resolved.style, systemScheme: systemScheme,
                   onClose: { shell.panels.dismiss(cancelPending: true) },
                   onPromoteToLarge: { adapter.promoteToLarge() }) {
            LayoutForm(layout: layout)
        }
        .accessibilityIdentifier("layout.panel")
    }
}

private struct LayoutForm: View {
    let layout: LayoutPanelPresenter

    var body: some View {
        let snapshot = layout.snapshot
        Form {
            Section {
                Picker(LayoutCopy.title(), selection: Binding(get: { snapshot.mode }, set: { layout.setViewMode($0) })) {
                    ForEach(snapshot.modes) { mode in
                        LayoutModeLabel(mode: mode, showsPinnedDetail: mode.id == "auto" && snapshot.isPinActive)
                            .tag(mode.id)
                            .disabled(!mode.isEnabled)
                    }
                }
                .pickerStyle(.inline)
                .labelsHidden()
                .tint(HostingTheme.inCallCoralText)
                .accessibilityIdentifier("layout.mode")
            } header: {
                Text(LayoutCopy.title())
            } footer: {
                Text(ConclaveStrings.text("Only you see this layout."))
            }
            Section {
                Stepper(value: Binding(get: { snapshot.maxTiles }, set: { layout.setMaxTiles($0) }),
                        in: LayoutPanelPolicy.minimumTiles...LayoutPanelPolicy.maximumTiles) {
                    LabeledContent(ConclaveStrings.text("Maximum Tiles"), value: snapshot.maxTiles.formatted())
                }
                .accessibilityIdentifier("layout.maxTiles")
                Toggle(ConclaveStrings.text("Hide Tiles Without Video"),
                       isOn: Binding(get: { snapshot.hideTilesWithoutVideo }, set: { layout.setHideTilesWithoutVideo($0) }))
                    .accessibilityIdentifier("layout.hideVideoOff")
            } header: {
                Text(ConclaveStrings.text("Tiles"))
            } footer: {
                Text(LayoutCopy.tilesFooter(phoneCap: snapshot.phoneCap))
            }
            Section {
                Picker(ConclaveStrings.text("Self View"), selection: Binding(get: { snapshot.selfMode }, set: { layout.setSelfViewMode($0) })) {
                    ForEach(LayoutPanelPolicy.selfModeIds, id: \.self) { id in
                        Text(LayoutCopy.selfModeTitle(id)).tag(id)
                    }
                }
                .pickerStyle(.inline)
                .labelsHidden()
                .tint(HostingTheme.inCallCoralText)
                .accessibilityIdentifier("layout.selfMode")
                if snapshot.showsPosition {
                    Picker(ConclaveStrings.text("Position"), selection: Binding(get: { snapshot.selfCorner }, set: { layout.setSelfViewCorner($0) })) {
                        ForEach(LayoutPanelPolicy.cornerIds, id: \.self) { id in
                            Text(LayoutCopy.cornerTitle(id)).tag(id)
                        }
                    }
                    .pickerStyle(.menu)
                    .tint(HostingTheme.inCallCoralText)
                    .accessibilityIdentifier("layout.position")
                }
            } header: {
                Text(ConclaveStrings.text("Self View"))
            }
            Section {
                Toggle(ConclaveStrings.text("Audio Only"),
                       isOn: Binding(get: { snapshot.isAudioOnly }, set: { layout.setAudioOnly($0) }))
                    .accessibilityIdentifier("layout.audioOnly")
            } footer: {
                Text(ConclaveStrings.text("Turns off the video you send and receive in this call. Your camera stays off until you turn it on."))
            }
        }
        .formStyle(.grouped)
        .accessibilityIdentifier("layout.form")
    }
}

private struct LayoutModeLabel: View {
    let mode: LayoutModeModel
    let showsPinnedDetail: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(LayoutCopy.modeTitle(mode.id))
            if showsPinnedDetail {
                Text(ConclaveStrings.text("Spotlight while someone is pinned"))
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
            if let reason = LayoutCopy.reason(mode.reason) {
                Text(reason)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
        }
    }
}

enum LayoutCopy {
    static func title() -> String {
        ConclaveStrings.text("Layout")
    }

    static func modeTitle(_ id: String) -> String {
        switch id {
        case "tiled": return ConclaveStrings.text("Tiled")
        case "spotlight": return ConclaveStrings.text("Spotlight")
        case "sidebar": return ConclaveStrings.text("Sidebar")
        default: return ConclaveStrings.text("Auto")
        }
    }

    static func selfModeTitle(_ id: String) -> String {
        switch id {
        case "tile": return ConclaveStrings.text("In a Tile")
        case "floating": return ConclaveStrings.text("Floating")
        case "minimized": return ConclaveStrings.text("Minimized")
        default: return ConclaveStrings.text("Auto")
        }
    }

    static func cornerTitle(_ id: String) -> String {
        switch id {
        case "top-left": return ConclaveStrings.text("Top Left")
        case "top-right": return ConclaveStrings.text("Top Right")
        case "bottom-left": return ConclaveStrings.text("Bottom Left")
        default: return ConclaveStrings.text("Bottom Right")
        }
    }

    static func reason(_ raw: String) -> String? {
        switch LayoutModeReason(rawValue: raw) ?? LayoutModeReason.none {
        case .none: return nil
        case .attendee: return ConclaveStrings.text("Attendees watch the webinar layout.")
        }
    }

    static func tilesFooter(phoneCap: Int) -> String {
        if phoneCap > 0 {
            return ConclaveStrings.format("Phones show up to %lld tiles. People who are speaking or pinned always show.", phoneCap)
        }
        return ConclaveStrings.text("People who are speaking or pinned always show.")
    }
}
#endif
