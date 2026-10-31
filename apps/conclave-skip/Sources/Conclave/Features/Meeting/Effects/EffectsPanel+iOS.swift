#if os(iOS) && !SKIP
import PhotosUI
import SwiftUI
import UIKit

enum EffectsLayoutMetrics {

    static let navigationBar = 52.0
    static let tileSpacing: CGFloat = 12
    static let gridMinimum: CGFloat = 72
}

enum EffectsTaskLifetime {

    static func waitForCancellation() async {
        while !Task.isCancelled {
            try? await Task.sleep(for: .seconds(60))
        }
    }
}

struct EffectsPanel: View {
    let effects: EffectsPresenter
    let shell: MeetingShellPresenter
    let adapter: NativePanelHostAdapter
    let presentation: NativePanelPresentation
    let resolved: PanelPresentation
    @Environment(\.conclaveSystemColorScheme) private var systemScheme

    var body: some View {
        PanelShell(title: EffectsCopy.title(), presentation: resolved, hostStyle: resolved.style, systemScheme: systemScheme,
                   onClose: { shell.panels.dismiss(cancelPending: true) },
                   onPromoteToLarge: { adapter.promoteToLarge() }) {
            EffectsContent(effects: effects, usesShortLayout: resolved.style == .sheet && adapter.detent == .short)
        }
        .task(id: presentation.request.presentationID) {
            effects.panelDidOpen()
            await EffectsTaskLifetime.waitForCancellation()
            effects.panelDidClose()
        }
        .accessibilityIdentifier("effects.panel")
    }
}

struct EffectsLobbySheet: View {
    let effects: EffectsPresenter
    let onClose: () -> Void
    @Environment(\.conclaveSystemColorScheme) private var systemScheme
    @State private var shortHeight = PanelPresentationPolicy.defaultShortDetentHeight
    @State private var detent: PresentationDetent = .height(CGFloat(PanelPresentationPolicy.defaultShortDetentHeight))

    private var presentation: PanelPresentation {
        PanelPresentationPolicy.resolve(PanelRequest(presentationID: 0, panel: MeetingPanel.effects, invoker: PanelInvoker.call),
                                        window: PanelWindow(width: 390, height: 844, horizontalRegular: false, verticalRegular: true),
                                        platform: PanelPlatform.iOS)
    }

    var body: some View {
        let short = PresentationDetent.height(CGFloat(shortHeight))
        PanelShell(title: EffectsCopy.title(), presentation: presentation, hostStyle: PanelHostStyle.sheet, systemScheme: systemScheme,
                   onClose: onClose, onPromoteToLarge: { detent = .large }) {
            EffectsContent(effects: effects, usesShortLayout: detent != .large)
        }
        .environment(\.panelReportShortDetentHeight, PanelShortDetentHeightAction(action: { height in
            if abs(height - shortHeight) > 0.5 { shortHeight = height }
        }))
        .onChange(of: shortHeight) { _, height in
            if detent != .large { detent = .height(CGFloat(height)) }
        }
        .presentationDetents([short, .large], selection: $detent)
        .presentationBackgroundInteraction(.enabled(upThrough: short))
        .presentationCompactAdaptation(horizontal: .automatic, vertical: .sheet)
        .task {
            effects.panelDidOpen()
            await EffectsTaskLifetime.waitForCancellation()
            effects.panelDidClose()
        }
        .accessibilityIdentifier("effects.lobbySheet")
    }
}

struct EffectsContent: View {
    let effects: EffectsPresenter
    let usesShortLayout: Bool
    @State private var tab = EffectsCatalog.backgrounds
    @State private var selectionTaps = 0
    @State private var showsPhotoPicker = false
    @State private var pickedItem: PhotosPickerItem? = nil
    @State private var replacingId = ""
    @Environment(\.panelReportShortDetentHeight) private var reportShortHeight

    var body: some View {
        let snapshot = effects.snapshot
        Group {
            if usesShortLayout {
                shortLayout(snapshot)
            } else {
                largeLayout(snapshot)
            }
        }
        .conclaveGestureFeedback(.selectionChanged, trigger: selectionTaps)
        .photosPicker(isPresented: $showsPhotoPicker, selection: $pickedItem, matching: .images, preferredItemEncoding: .compatible)
        .onChange(of: pickedItem) { _, item in
            guard let item else { return }
            pickedItem = nil
            importPhoto(item)
        }
    }

    private func shortLayout(_ snapshot: EffectsSnapshot) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            EffectsStatusRows(effects: effects, snapshot: snapshot)
            tabPicker(snapshot)
            if tab == EffectsCatalog.appearance {
                EffectsAppearanceList(effects: effects, snapshot: snapshot)
            } else {
                ScrollView(.horizontal, showsIndicators: false) {
                    LazyHStack(alignment: .top, spacing: EffectsLayoutMetrics.tileSpacing) {
                        ForEach(snapshot.tab(tab)?.items ?? []) { item in
                            tile(item, snapshot: snapshot)
                        }
                    }
                    .padding(.horizontal, 16)
                }
                .accessibilityIdentifier("effects.row")
            }
        }
        .padding(.vertical, 12)

        .onGeometryChange(for: Double.self) { proxy in Double(proxy.size.height) } action: { height in
            reportShortHeight(min(height, 600) + EffectsLayoutMetrics.navigationBar)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
    }

    private func largeLayout(_ snapshot: EffectsSnapshot) -> some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                EffectsStatusRows(effects: effects, snapshot: snapshot)
                tabPicker(snapshot)
                if snapshot.active.count > 1 {
                    EffectsActiveSection(effects: effects, snapshot: snapshot)
                }
                if tab == EffectsCatalog.appearance {
                    EffectsAppearanceList(effects: effects, snapshot: snapshot)
                } else if tab == EffectsCatalog.backgrounds {
                    backgroundSections(snapshot)
                } else {
                    grid(snapshot.tab(tab)?.items ?? [], snapshot: snapshot)
                }
                if snapshot.showsPublishCap {
                    Text(ConclaveStrings.text("While effects are on, video is sent at up to 720p and 30 fps."))
                        .font(.footnote)
                        .foregroundStyle(HostingTheme.inCallTextSecondary)
                        .padding(.horizontal, 16)
                }
            }
            .padding(.vertical, 12)
        }
        .accessibilityIdentifier("effects.grid")
    }

    private func tabPicker(_ snapshot: EffectsSnapshot) -> some View {
        Picker(EffectsCopy.title(), selection: $tab) {
            ForEach(snapshot.tabs) { item in
                Text(EffectsCopy.tabTitle(item.id)).tag(item.id)
            }
        }
        .pickerStyle(.segmented)
        .labelsHidden()
        .padding(.horizontal, 16)
        .accessibilityIdentifier("effects.tabs")
    }

    @ViewBuilder
    private func backgroundSections(_ snapshot: EffectsSnapshot) -> some View {
        let items = snapshot.tab(EffectsCatalog.backgrounds)?.items ?? []
        let blur = items.filter { $0.kind == EffectKind.none || $0.kind == EffectKind.blur }
        let images = items.filter { $0.kind == EffectKind.image }
        let personal = items.filter { $0.kind == EffectKind.personal }
        sectionHeader(EffectsCopy.sectionTitle(EffectKind.blur))
        grid(blur, snapshot: snapshot)
        if !images.isEmpty {
            sectionHeader(EffectsCopy.sectionTitle(EffectKind.image))
            grid(images, snapshot: snapshot)
        }
        sectionHeader(EffectsCopy.sectionTitle(EffectKind.personal))
        LazyVGrid(columns: [GridItem(.adaptive(minimum: EffectsLayoutMetrics.gridMinimum), spacing: EffectsLayoutMetrics.tileSpacing)],
                  spacing: EffectsLayoutMetrics.tileSpacing) {
            ForEach(personal) { item in
                tile(item, snapshot: snapshot)
            }
            Button {
                if effects.canBeginAddingPersonalImage() { showsPhotoPicker = true }
            } label: {
                EffectAddPhotoFace(isEnabled: snapshot.canAddPersonalImage && snapshot.tilesEnabled)
            }
            .buttonStyle(.plain)
            .disabled(!snapshot.canAddPersonalImage || !snapshot.tilesEnabled)
        }
        .padding(.horizontal, 16)
        if !snapshot.canAddPersonalImage {
            Text(ConclaveStrings.text("You can keep up to 8 personal images. Remove one to add another."))
                .font(.footnote)
                .foregroundStyle(HostingTheme.inCallTextSecondary)
                .padding(.horizontal, 16)
        }
    }

    private func sectionHeader(_ title: String) -> some View {
        Text(title)
            .font(.subheadline.weight(.semibold))
            .foregroundStyle(HostingTheme.inCallTextSecondary)
            .accessibilityAddTraits(.isHeader)
            .padding(.horizontal, 16)
    }

    private func grid(_ items: [EffectItem], snapshot: EffectsSnapshot) -> some View {
        LazyVGrid(columns: [GridItem(.adaptive(minimum: EffectsLayoutMetrics.gridMinimum), spacing: EffectsLayoutMetrics.tileSpacing)],
                  spacing: EffectsLayoutMetrics.tileSpacing) {
            ForEach(items) { item in
                tile(item, snapshot: snapshot)
            }
        }
        .padding(.horizontal, 16)
    }

    @ViewBuilder
    private func tile(_ item: EffectItem, snapshot: EffectsSnapshot) -> some View {
        let base = EffectTile(item: item, isEnabled: snapshot.tilesEnabled) {
            if effects.select(id: item.id) == ControlTapResult.dispatched { selectionTaps += 1 }
        }
        if item.kind == EffectKind.personal {
            base
                .contextMenu {
                    Button(ConclaveStrings.text("Change Image")) {
                        replacingId = item.id
                        showsPhotoPicker = true
                    }
                    Button(ConclaveStrings.text("Remove Image"), role: .destructive) {
                        removePersonal(item)
                    }
                }
                .accessibilityAction(named: Text(ConclaveStrings.text("Change Image"))) {
                    replacingId = item.id
                    showsPhotoPicker = true
                }
                .accessibilityAction(named: Text(ConclaveStrings.text("Remove Image"))) {
                    removePersonal(item)
                }
        } else {
            base
        }
    }

    private func removePersonal(_ item: EffectItem) {
        effects.removePersonalImage(id: item.id)
        EffectsPhotoStore.remove(fileName: item.assetName)
    }

    private func importPhoto(_ item: PhotosPickerItem) {
        let replacing = replacingId
        replacingId = ""
        let fileName = effects.nextPersonalFileName(nowMillis: Date().timeIntervalSince1970 * 1000.0)
        let count = effects.snapshot.personalCount - (replacing.isEmpty ? 0 : 1)
        Task { @MainActor in
            guard let data = try? await item.loadTransferable(type: Data.self) else {
                effects.personalImageFailed(EffectsIssue.decode)
                return
            }
            let issue = await Task.detached(priority: .userInitiated) {
                EffectsPhotoStore.store(data, fileName: fileName, personalCount: count)
            }.value
            if issue != EffectsIssue.none {
                effects.personalImageFailed(issue)
                return
            }
            if !replacing.isEmpty {
                effects.removePersonalImage(id: replacing)
                EffectsPhotoStore.remove(fileName: EffectsImagePolicy.fileName(fromPersonalId: replacing))
            }
            effects.personalImageImported(fileName: fileName)
        }
    }
}

private struct EffectsStatusRows: View {
    let effects: EffectsPresenter
    let snapshot: EffectsSnapshot

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if snapshot.isPreparing {
                HStack(spacing: 8) {
                    ProgressView()
                    Text(ConclaveStrings.text("Preparing effects"))
                        .font(.subheadline)
                }
                .accessibilityElement(children: .combine)
                .accessibilityIdentifier("effects.preparing")
            }
            if let line = EffectsCopy.cameraLine(snapshot.camera) {
                Text(line)
                    .font(.subheadline)
                    .foregroundStyle(HostingTheme.inCallTextSecondary)
                    .accessibilityIdentifier("effects.camera")
            }
            if snapshot.camera == EffectsCameraState.off {
                let previewing = snapshot.preview == PreviewState.live || snapshot.preview == PreviewState.starting
                if previewing {
                    Text(ConclaveStrings.text("Only visible to you"))
                        .font(.footnote)
                        .foregroundStyle(HostingTheme.inCallTextSecondary)
                }
                HStack(spacing: 8) {
                    Button(ConclaveStrings.text(previewing ? "Stop Preview" : "Preview")) {
                        if previewing { effects.stopPreview() } else { effects.startPreview() }
                    }
                    .buttonStyle(.bordered)
                    .accessibilityIdentifier("effects.preview")
                    if snapshot.canTurnCameraOn {
                        Button(ConclaveStrings.text("Turn On for Everyone")) {
                            effects.turnCameraOnForEveryone()
                        }
                        .buttonStyle(.borderedProminent)
                        .tint(HostingTheme.coralFill)
                        .foregroundStyle(HostingTheme.inCallOnCoral)
                        .accessibilityIdentifier("effects.turnOn")
                    }
                }
            }
            if snapshot.camera == EffectsCameraState.blocked {
                Button(ConclaveStrings.text("Open Settings")) {
                    effects.openCameraSettings()
                }
                .buttonStyle(.bordered)
            }
            if let message = EffectsCopy.issue(snapshot.issue) {
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Text(message)
                        .font(.footnote)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    Button {
                        effects.dismissIssue()
                    } label: {
                        Image(systemName: ConclaveSymbols.xmark)
                            .accessibilityHidden(true)
                    }
                    .accessibilityLabel(ConclaveStrings.text("Close"))
                }
                .accessibilityIdentifier("effects.issue")
            }
        }
        .padding(.horizontal, 16)
    }
}

private struct EffectsActiveSection: View {
    let effects: EffectsPresenter
    let snapshot: EffectsSnapshot

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            ForEach(snapshot.active) { item in
                HStack {
                    Text(EffectsCopy.itemTitle(item))
                        .font(.subheadline)
                    Spacer()
                    Button(ConclaveStrings.text("Remove")) {
                        remove(item)
                    }
                    .buttonStyle(.borderless)
                    .accessibilityLabel(ConclaveStrings.format("Remove %@", EffectsCopy.itemTitle(item)))
                }
            }
            Button(ConclaveStrings.text("Remove All Effects")) {
                effects.clearAll()
            }
            .buttonStyle(.bordered)
            .accessibilityIdentifier("effects.removeAll")
        }
        .padding(.horizontal, 16)
    }

    private func remove(_ item: EffectItem) {
        switch item.kind {
        case .blur, .image, .personal:
            effects.select(id: EffectsCatalog.noBackground)
        case .filter, .style:
            effects.select(id: EffectsCatalog.noFilter)
        case .appearance:
            effects.setAppearance(id: item.id, isOn: false)
        case .none:
            break
        }
    }
}

private struct EffectsAppearanceList: View {
    let effects: EffectsPresenter
    let snapshot: EffectsSnapshot

    private func isOn(_ id: String) -> Bool {
        for item in snapshot.tab(EffectsCatalog.appearance)?.items ?? [] where item.id == id {
            return item.isSelected
        }
        return false
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            if snapshot.system.centerStageSupported {
                appearanceToggle(title: ConclaveStrings.text("Center Stage"), detail: EffectsCopy.appearanceDetail(id: EffectsCatalog.framing),
                                 isOn: snapshot.system.centerStageOn, identifier: "effects.centerStage") { on in
                    effects.setCenterStage(on)
                }
            } else {
                appearanceToggle(title: EffectsCopy.itemTitle(id: EffectsCatalog.framing),
                                 detail: EffectsCopy.appearanceDetail(id: EffectsCatalog.framing),
                                 isOn: isOn(EffectsCatalog.framing), identifier: "effects.framing") { on in
                    effects.setAppearance(id: EffectsCatalog.framing, isOn: on)
                }
                Button(ConclaveStrings.text("Recenter")) {
                    effects.recenter()
                }
                .buttonStyle(.bordered)
                .disabled(!snapshot.tilesEnabled || !isOn(EffectsCatalog.framing))
            }
            if snapshot.system.studioLightSupported {
                VStack(alignment: .leading, spacing: 4) {
                    LabeledContent(ConclaveStrings.text("Studio Light"),
                                   value: ConclaveStrings.text(snapshot.system.studioLightOn ? "On" : "Off"))
                    Text(ConclaveStrings.text("Change Studio Light in Video Effects."))
                        .font(.footnote)
                        .foregroundStyle(HostingTheme.inCallTextSecondary)
                }
                .accessibilityIdentifier("effects.studioLight")
            } else {
                appearanceToggle(title: EffectsCopy.itemTitle(id: EffectsCatalog.studioLighting),
                                 detail: EffectsCopy.appearanceDetail(id: EffectsCatalog.studioLighting),
                                 isOn: isOn(EffectsCatalog.studioLighting), identifier: "effects.studioLighting") { on in
                    effects.setAppearance(id: EffectsCatalog.studioLighting, isOn: on)
                }
            }
            appearanceToggle(title: EffectsCopy.itemTitle(id: EffectsCatalog.studioLook),
                             detail: EffectsCopy.appearanceDetail(id: EffectsCatalog.studioLook),
                             isOn: isOn(EffectsCatalog.studioLook), identifier: "effects.studioLook") { on in
                effects.setAppearance(id: EffectsCatalog.studioLook, isOn: on)
            }
            Button(ConclaveStrings.text("Video Effects…")) {
                effects.showSystemVideoEffects()
            }
            .buttonStyle(.bordered)
            .accessibilityIdentifier("effects.systemModule")
        }
        .padding(.horizontal, 16)
    }

    private func appearanceToggle(title: String, detail: String, isOn: Bool, identifier: String,
                                  set: @escaping (Bool) -> Void) -> some View {
        Toggle(isOn: Binding(get: { isOn }, set: { set($0) })) {
            VStack(alignment: .leading, spacing: 2) {
                Text(title)
                Text(detail)
                    .font(.footnote)
                    .foregroundStyle(HostingTheme.inCallTextSecondary)
            }
        }
        .disabled(!snapshot.tilesEnabled)
        .accessibilityIdentifier(identifier)
    }
}
#endif
