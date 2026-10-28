#if os(iOS) && !SKIP
import SwiftUI

// S60 3 c (SET-5) on iOS: `MeetingPanel.layout`, always dark (owner default Q8 6, D19): `PanelShell` scopes the dark
// scheme from `resolved.appearance == .inCall` (the presentation's preferred scheme in the sheet, the environment in the
// iPad inspector), so no view here sets a color scheme. Detents `[.medium, .large]` opening medium, large at accessibility
// sizes, with background interaction up through medium (RECONCILE R9, the PNL-1 sheet host), so the stage reflows live
// above the sheet while the person changes it. One grouped `Form` of system controls: the mode and self view inline
// pickers (selected trait), one adjustable Stepper for Maximum Tiles, switches for Hide Tiles Without Video and Audio
// Only, and Position only while the self view floats (3 f). Every change applies at once through `LayoutPanelPresenter`
// (no Done); iOS plays no haptic (system controls, 3 h). Mounted by the native call root (`CallPanelContent`).

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

/// The form reads only `layout.snapshot` (3 k), so a stage revision that changes nothing here never redraws it.
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

/// A mode row: the title, the Auto detail while someone is pinned (S20 4) and a disabled mode's reason line (3 f).
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

/// L6-14 for the Layout panel on iOS (Apple title case, Q13): every mode, self view mode, corner and reason to a catalog
/// key. The S60 copy table names `SettingsCopy+iOS.swift` for Layout too; that file belongs to SET-3 this batch, so the
/// Layout half lives here (HD record B7-T2).
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

    /// nil while the mode is enabled.
    static func reason(_ raw: String) -> String? {
        switch LayoutModeReason(rawValue: raw) ?? LayoutModeReason.none {
        case .none: return nil
        case .attendee: return ConclaveStrings.text("Attendees watch the webinar layout.")
        }
    }

    /// Phones state their cap (S20 2 g); tablets omit it (3 f).
    static func tilesFooter(phoneCap: Int) -> String {
        if phoneCap > 0 {
            return ConclaveStrings.format("Phones show up to %lld tiles. People who are speaking or pinned always show.", phoneCap)
        }
        return ConclaveStrings.text("People who are speaking or pinned always show.")
    }
}
#endif
