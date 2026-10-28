#if os(iOS) && !SKIP
import SwiftUI
import UIKit

enum SettingsAnchor {
    static let audio = "settings.section.audio"
}

enum SettingsTaskLifetime {
    static func waitForCancellation() async {
        while !Task.isCancelled {
            try? await Task.sleep(for: .seconds(60))
        }
    }

    static func announce(_ text: String) {
        UIAccessibility.post(notification: .announcement, argument: text)
    }
}

struct SettingsPanel: View {
    let settings: SettingsPresenter
    let shell: MeetingShellPresenter
    let people: PeoplePresenter?
    let adapter: NativePanelHostAdapter
    let presentation: NativePanelPresentation
    let resolved: PanelPresentation
    @Environment(\.conclaveSystemColorScheme) private var systemScheme
    @State private var path: [SettingsRoute] = []

    var body: some View {
        PanelShell(title: SettingsCopy.panelTitle(), presentation: resolved, hostStyle: resolved.style, systemScheme: systemScheme,
                   path: $path,
                   onClose: { shell.panels.dismiss(cancelPending: true) },
                   onPromoteToLarge: { adapter.promoteToLarge() }) {
            ScrollViewReader { proxy in
                SettingsRootList(settings: settings, link: { route in route },
                                 onOpenTranscript: { shell.panels.present(MeetingPanel.transcript, from: PanelInvoker.settings) })
                    .navigationDestination(for: SettingsRoute.self) { route in
                        SettingsPage(route: route, settings: settings, people: people)
                    }
                    .environment(\.settingsPresentationID, presentation.request.presentationID)
                    .task(id: presentation.request.presentationID) {
                        let destination = presentation.request.destination
                        if SettingsRoutePolicy.scrollsToAudio(destination: destination) {
                            proxy.scrollTo(SettingsAnchor.audio, anchor: .top)
                        }
                        let initial = SettingsRoutePolicy.initialPath(destination: destination)
                        if !initial.isEmpty && path.isEmpty { path = initial }
                    }
            }
        }
        .onChange(of: path.count) { previous, next in
            if next > previous { adapter.promoteToLarge() }
        }
        .background {
            SettingsPanelLeaves(settings: settings, panels: shell.panels, presentationID: presentation.request.presentationID,
                                path: $path)
        }
        .accessibilityIdentifier("settings.panel")
    }
}

private struct SettingsPanelLeaves: View {
    let settings: SettingsPresenter
    let panels: PanelCoordinator
    let presentationID: Int
    @Binding var path: [SettingsRoute]

    private var destinationSequence: Int {
        panels.latestDestination(for: presentationID)?.sequence ?? 0
    }

    var body: some View {
        Color.clear
            .frame(width: 0, height: 0)
            .accessibilityHidden(true)
            .task(id: presentationID) {
                settings.panelDidOpen()
                await SettingsTaskLifetime.waitForCancellation()
                settings.panelDidClose()
                SettingsPreviewRendererCache.shared.release(presentationID: presentationID)
            }
            .onChange(of: destinationSequence) { _, _ in
                guard let request = panels.latestDestination(for: presentationID) else { return }
                let pages = SettingsRoutePolicy.initialPath(destination: request.destination)
                if !pages.isEmpty { path = pages }
            }
            .onChange(of: settings.general.showsHostSection) { _, shows in
                if !shows { path = SettingsRoutePolicy.pathAfterHostLoss(path) }
            }
            .onChange(of: settings.general.isAttendee) { _, attendee in
                guard attendee else { return }
                SettingsTaskLifetime.announce(ConclaveStrings.text("Settings closed."))
                panels.dismiss(cancelPending: true)
            }
    }
}

struct SettingsRootList<Route: Hashable>: View {
    let settings: SettingsPresenter
    let link: (SettingsRoute) -> Route?
    var onOpenTranscript: (() -> Void)? = nil

    var body: some View {
        Form {
            Section { AppearanceSettingRow() }
            ForEach(settings.sections) { section in
                SettingsSectionView(section: section, settings: settings, link: link, onOpenTranscript: onOpenTranscript)
            }
        }
        .formStyle(.grouped)
        .scrollDismissesKeyboard(.interactively)
        .tint(HostingTheme.coralText)
        .accessibilityIdentifier("settings.root")
    }
}

private struct SettingsSectionView<Route: Hashable>: View {
    let section: SettingsRowSection
    let settings: SettingsPresenter
    let link: (SettingsRoute) -> Route?
    let onOpenTranscript: (() -> Void)?

    var body: some View {
        switch section.section {
        case .audio: SettingsAudioSection(rows: section.rows, settings: settings, link: link)
        case .video: SettingsVideoSection(rows: section.rows, settings: settings, link: link)
        case .captions: SettingsCaptionsSection(rows: section.rows, settings: settings, onOpenTranscript: onOpenTranscript)
        case .chat: SettingsChatSection(rows: section.rows, settings: settings, link: link)
        case .host: SettingsHostSection(rows: section.rows, settings: settings, link: link)
        case .general: SettingsGeneralSection(rows: section.rows, settings: settings, link: link)
        case .account: SettingsAccountSection(rows: section.rows, settings: settings)
        case .about: SettingsAboutSection(rows: section.rows, settings: settings, link: link)
        }
    }
}

private struct SettingsAudioSection<Route: Hashable>: View {
    let rows: [SettingsRowID]
    let settings: SettingsPresenter
    let link: (SettingsRoute) -> Route?

    var body: some View {
        let audio = settings.audio
        Section {
            ForEach(rows, id: \.self) { row in
                switch row {
                case .output:
                    SettingsRouteOutputRow(owner: settings.routeOwner)
                case .microphone:
                    if let value = link(SettingsRoute.microphone) {
                        NavigationLink(value: value) { SettingsMicrophoneValueRow(owner: settings.routeOwner) }
                            .accessibilityIdentifier("settings.row.microphone")
                    }
                case .noiseSuppression:
                    Toggle(SettingsCopy.rowTitle(.noiseSuppression),
                           isOn: Binding(get: { audio.noiseSuppressionOn }, set: { settings.setNoiseSuppression($0) }))
                        .disabled(audio.noiseSuppression == SettingsCapability.unavailable)
                        .accessibilityIdentifier("settings.row.noiseSuppression")
                case .testSound:
                    SettingsTestSoundRow(settings: settings, phase: audio.speakerTest)
                default:
                    EmptyView()
                }
            }
        } header: {
            Text(SettingsCopy.sectionTitle(.audio)).id(SettingsAnchor.audio)
        } footer: {
            if rows.contains(SettingsRowID.noiseSuppression) {
                VStack(alignment: .leading, spacing: 4) {
                    Text(SettingsCopy.audioFooter())
                    if let reason = SettingsCopy.reason(audio.noiseSuppressionReason) {
                        Text(reason)
                    }
                }
            }
        }
    }
}

private struct SettingsVideoSection<Route: Hashable>: View {
    let rows: [SettingsRowID]
    let settings: SettingsPresenter
    let link: (SettingsRoute) -> Route?
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    var body: some View {
        let video = settings.video
        Section {
            ForEach(rows, id: \.self) { row in
                switch row {
                case .cameraFacing:
                    SettingsLivePreviewCard(settings: settings)
                        .listRowInsets(EdgeInsets())
                    LabeledContent(SettingsCopy.rowTitle(.cameraFacing)) {
                        facingPicker(video)
                    }
                    .disabled(!video.canFlipCamera || video.isFlipInFlight)
                    .accessibilityIdentifier("settings.row.cameraFacing")
                case .mirror:
                    Toggle(SettingsCopy.rowTitle(.mirror),
                           isOn: Binding(get: { video.mirrorsSelfView }, set: { settings.setMirrorsSelfView($0) }))
                        .disabled(video.isAudioOnly)
                        .accessibilityIdentifier("settings.row.mirror")
                case .cameraQuality:
                    if let value = link(SettingsRoute.cameraQuality) {
                        NavigationLink(value: value) {
                            LabeledContent(SettingsCopy.rowTitle(.cameraQuality),
                                           value: SettingsCopy.cameraPreset(video.effectiveCameraPreset))
                        }
                        .accessibilityIdentifier("settings.row.cameraQuality")
                    }
                case .screenShareQuality:
                    if let value = link(SettingsRoute.screenShareQuality) {
                        NavigationLink(value: value) {
                            LabeledContent(SettingsCopy.rowTitle(.screenShareQuality),
                                           value: SettingsCopy.screenSharePreset(video.screenSharePreset))
                        }
                        .accessibilityIdentifier("settings.row.screenShareQuality")
                    }
                case .dataSaver:
                    Toggle(SettingsCopy.rowTitle(.dataSaver),
                           isOn: Binding(get: { video.dataSaverOn }, set: { settings.setDataSaver($0) }))
                        .disabled(video.systemDataSaverOn)
                        .accessibilityIdentifier("settings.row.dataSaver")
                default:
                    EmptyView()
                }
            }
        } header: {
            Text(SettingsCopy.sectionTitle(.video))
        } footer: {
            VStack(alignment: .leading, spacing: 4) {
                if rows.contains(SettingsRowID.mirror) {
                    Text(SettingsCopy.videoFooter())
                }
                if rows.contains(SettingsRowID.cameraFacing), let reason = SettingsCopy.reason(video.flipReason) {
                    Text(reason)
                }
                if rows.contains(SettingsRowID.dataSaver), video.systemDataSaverOn,
                   let reason = SettingsCopy.reason(SettingsReason.systemDataSaver) {
                    Text(reason).accessibilityIdentifier("settings.video.systemDataSaver")
                }
                if rows.contains(SettingsRowID.cameraQuality), video.qualityCappedByHost,
                   let reason = SettingsCopy.reason(SettingsReason.hostQualityCap) {
                    Text(reason).accessibilityIdentifier("settings.video.hostQualityCap")
                }
                if video.flipFailed {
                    Text(ConclaveStrings.text("Couldn\u{2019}t switch cameras. Try again."))
                        .accessibilityIdentifier("settings.video.flipFailed")
                }
            }
        }
        .onChange(of: video.flipFailed) { _, failed in
            if failed { SettingsTaskLifetime.announce(ConclaveStrings.text("Couldn\u{2019}t switch cameras. Try again.")) }
        }
    }

    private func facingBinding(_ video: SettingsVideo) -> Binding<String> {
        Binding(get: { video.cameraFacing }, set: { settings.setCameraFacing(front: $0 == "front") })
    }

    @ViewBuilder
    private func facingPicker(_ video: SettingsVideo) -> some View {
        if dynamicTypeSize.isAccessibilitySize {
            Picker(SettingsCopy.rowTitle(.cameraFacing), selection: facingBinding(video)) {
                Text(SettingsCopy.cameraFacing("front")).tag("front")
                Text(SettingsCopy.cameraFacing("back")).tag("back")
            }
            .pickerStyle(.menu)
            .labelsHidden()
        } else {
            Picker(SettingsCopy.rowTitle(.cameraFacing), selection: facingBinding(video)) {
                Text(SettingsCopy.cameraFacing("front")).tag("front")
                Text(SettingsCopy.cameraFacing("back")).tag("back")
            }
            .pickerStyle(.segmented)
            .labelsHidden()
            .fixedSize()
        }
    }
}

private struct SettingsCaptionsSection: View {
    let rows: [SettingsRowID]
    let settings: SettingsPresenter
    let onOpenTranscript: (() -> Void)?

    var body: some View {
        let chat = settings.chat
        Section {
            ForEach(rows, id: \.self) { row in
                if row == SettingsRowID.captions {
                    Toggle(SettingsCopy.rowTitle(.captions), isOn: Binding(get: { chat.captionsOn }, set: { settings.setCaptions($0) }))
                        .accessibilityIdentifier("settings.row.captions")
                }
            }
        } header: {
            Text(SettingsCopy.sectionTitle(.captions))
        } footer: {
            VStack(alignment: .leading, spacing: 4) {
                Text(SettingsCopy.captionsFooter())
                if chat.liveNotes == LiveNotesState.off, let onOpenTranscript {
                    Button(ConclaveStrings.text("Live Notes"), action: onOpenTranscript)
                        .accessibilityIdentifier("settings.captions.liveNotes")
                }
            }
        }
    }
}

private struct SettingsChatSection<Route: Hashable>: View {
    let rows: [SettingsRowID]
    let settings: SettingsPresenter
    let link: (SettingsRoute) -> Route?

    var body: some View {
        let chat = settings.chat
        Section {
            ForEach(rows, id: \.self) { row in
                switch row {
                case .chatPreviews:
                    Toggle(SettingsCopy.rowTitle(.chatPreviews),
                           isOn: Binding(get: { chat.showsChatPreviews }, set: { settings.setShowsChatPreviews($0) }))
                        .accessibilityIdentifier("settings.row.chatPreviews")
                case .playVoiceMessages:
                    Toggle(SettingsCopy.rowTitle(.playVoiceMessages),
                           isOn: Binding(get: { chat.playsVoiceMessages }, set: { settings.setPlaysVoiceMessages($0) }))
                        .accessibilityIdentifier("settings.row.playVoiceMessages")
                case .voiceMessages:
                    if let value = link(SettingsRoute.voice) {
                        NavigationLink(value: value) {
                            LabeledContent(SettingsCopy.rowTitle(.voiceMessages), value: SettingsCopy.voiceKind(chat.effectiveVoiceKind))
                        }
                        .accessibilityIdentifier("settings.row.voiceMessages")
                    }
                default:
                    EmptyView()
                }
            }
        } header: {
            Text(SettingsCopy.sectionTitle(.chat))
        }
    }
}

private struct SettingsHostSection<Route: Hashable>: View {
    let rows: [SettingsRowID]
    let settings: SettingsPresenter
    let link: (SettingsRoute) -> Route?

    var body: some View {
        let general = settings.general
        Section {
            ForEach(rows, id: \.self) { row in
                switch row {
                case .hostControls:
                    if let value = link(SettingsRoute.hostControls) {
                        NavigationLink(value: value) {
                            LabeledContent {
                                if let reason = SettingsCopy.reason(general.hostReason) { Text(reason) }
                            } label: {
                                Text(SettingsCopy.rowTitle(.hostControls))
                            }
                        }
                        .disabled(general.isRecovering)
                        .accessibilityIdentifier("settings.row.hostControls")
                    }
                case .knockSound:
                    Toggle(SettingsCopy.rowTitle(.knockSound), isOn: Binding(get: { general.knockSoundOn }, set: { settings.setKnockSound($0) }))
                        .accessibilityIdentifier("settings.row.knockSound")
                case .handSound:
                    Toggle(SettingsCopy.rowTitle(.handSound), isOn: Binding(get: { general.handSoundOn }, set: { settings.setHandSound($0) }))
                        .accessibilityIdentifier("settings.row.handSound")
                default:
                    EmptyView()
                }
            }
        } header: {
            Text(SettingsCopy.sectionTitle(.host))
        } footer: {
            if rows.contains(SettingsRowID.knockSound) {
                Text(ConclaveStrings.text("Sounds play only on this device."))
            }
        }
    }
}

private struct SettingsGeneralSection<Route: Hashable>: View {
    let rows: [SettingsRowID]
    let settings: SettingsPresenter
    let link: (SettingsRoute) -> Route?

    var body: some View {
        let general = settings.general
        Section {
            ForEach(rows, id: \.self) { row in
                switch row {
                case .connection:
                    if let value = link(SettingsRoute.connection) {
                        NavigationLink(value: value) {
                            LabeledContent(SettingsCopy.rowTitle(.connection), value: SettingsCopy.connectionValue(general.connection))
                        }
                        .accessibilityIdentifier("settings.row.connection")
                    } else {
                        LabeledContent(SettingsCopy.rowTitle(.connection), value: SettingsCopy.connectionValue(general.connection))
                            .accessibilityIdentifier("settings.row.connection")
                    }
                case .messageNotifications:
                    MessageNotificationsRow(notifications: SystemNotifications.shared)
                case .alwaysShowControls:
                    Toggle(SettingsCopy.rowTitle(.alwaysShowControls),
                           isOn: Binding(get: { general.alwaysShowControls }, set: { settings.setAlwaysShowControls($0) }))
                        .accessibilityIdentifier("settings.row.alwaysShowControls")
                case .haptics:
                    Toggle(SettingsCopy.rowTitle(.haptics), isOn: Binding(get: { general.hapticsOn }, set: { settings.setHaptics($0) }))
                        .accessibilityIdentifier("settings.row.haptics")
                default:
                    EmptyView()
                }
            }
        } header: {
            Text(SettingsCopy.sectionTitle(.general))
        } footer: {
            VStack(alignment: .leading, spacing: 4) {
                if rows.contains(SettingsRowID.messageNotifications) {
                    MessageNotificationsFooter(notifications: SystemNotifications.shared)
                }
                if rows.contains(SettingsRowID.alwaysShowControls) {
                    Text(ConclaveStrings.text("Keeps call controls on screen instead of hiding them after a few seconds."))
                }
            }
        }
    }
}

private struct SettingsAccountSection: View {
    let rows: [SettingsRowID]
    let settings: SettingsPresenter
    @State private var confirmSignOut = false

    var body: some View {
        let account = settings.account
        Section {
            ForEach(rows, id: \.self) { row in
                switch row {
                case .name:
                    if let editor = settings.nameEditor {
                        SettingsNameRow(settings: settings, editor: editor, canEdit: account.canEditName)
                    } else {
                        LabeledContent(SettingsCopy.rowTitle(.name), value: account.savedDisplayName)
                    }
                case .identity:
                    SettingsIdentityRow(account: account)
                case .signOut:
                    Button(role: .destructive) {
                        confirmSignOut = true
                    } label: {
                        LabeledContent {
                            if account.signOutPending { Text(ConclaveStrings.text("In Progress")) }
                        } label: {
                            Text(SettingsCopy.rowTitle(.signOut)).foregroundStyle(Color(uiColor: .systemRed))
                        }
                    }
                    .disabled(account.signOutPending)
                    .accessibilityIdentifier("settings.row.signOut")
                default:
                    EmptyView()
                }
            }
        } header: {
            Text(SettingsCopy.sectionTitle(.account))
        } footer: {
            if let editor = settings.nameEditor {
                SettingsNameStatus(settings: settings, editor: editor, account: account)
            } else if let reason = SettingsCopy.nameReason(account.nameReason) {
                Text(reason)
            }
        }
        .confirmationDialog(ConclaveStrings.text("Sign Out?"), isPresented: $confirmSignOut, titleVisibility: .visible) {
            Button(ConclaveStrings.text("Sign Out"), role: .destructive) { settings.signOut() }
            Button(ConclaveStrings.text("Cancel"), role: .cancel) {}
        } message: {
            Text(SettingsCopy.signOutMessage(isHost: account.isHost))
        }
    }
}

private struct SettingsAboutSection<Route: Hashable>: View {
    let rows: [SettingsRowID]
    let settings: SettingsPresenter
    let link: (SettingsRoute) -> Route?

    var body: some View {
        Section {
            ForEach(rows, id: \.self) { row in
                switch row {
                case .privacy:
                    if let value = link(SettingsRoute.privacy) {
                        NavigationLink(value: value) { Text(SettingsCopy.rowTitle(.privacy)) }
                            .accessibilityIdentifier("settings.row.privacy")
                    }
                case .version:
                    LabeledContent(SettingsCopy.rowTitle(.version), value: MeetingDetailsCopy.versionText())
                        .textSelection(.enabled)
                        .accessibilityIdentifier("settings.row.version")
                case .exportDiagnostics:
                    DiagnosticsExportRow(presenter: DiagnosticsExportPresenter.shared)
                default:
                    EmptyView()
                }
            }
        } header: {
            Text(SettingsCopy.sectionTitle(.about))
        }
    }
}

struct SettingsPage: View {
    let route: SettingsRoute
    let settings: SettingsPresenter
    let people: PeoplePresenter?

    var body: some View {
        switch route {
        case .microphone:
            SettingsMicrophonePage(settings: settings)
        case .voice:
            SettingsVoicePage(settings: settings, link: { route in route })
        case .voiceRecord:
            SettingsVoiceRecordPage(settings: settings)
        case .privacy:
            PrivacyPolicyScreen()
        case .cameraQuality, .cameraAdvanced, .screenShareQuality, .screenShareAdvanced, .connection:
            SettingsVideoPage(route: route, settings: settings, link: { route in route })
        default:
            if let page = SettingsRoutePolicy.peopleRoute(route) {
                if let people {
                    HostPageView(people: people, page: page, link: { SettingsRoutePolicy.hostRoute($0) })
                } else {
                    PeopleHostPage(route: page)
                }
            } else {
                SettingsPendingPage(route: route)
            }
        }
    }
}

private struct SettingsPendingPage: View {
    let route: SettingsRoute

    var body: some View {
        Form {
            EmptyView()
        }
        .formStyle(.grouped)
        .navigationTitle(SettingsCopy.pageTitle(route))
        .navigationBarTitleDisplayMode(.inline)
        .accessibilityIdentifier("settings.page." + route.rawValue)
    }
}

struct SettingsAppScopeList<Route: Hashable>: View {
    let settings: SettingsPresenter
    let link: (SettingsRoute) -> Route?

    var body: some View {
        SettingsRootList(settings: settings, link: link)
            .navigationTitle(SettingsCopy.panelTitle())
            .navigationBarTitleDisplayMode(.inline)
            .task {
                settings.panelDidOpen()
                await SettingsTaskLifetime.waitForCancellation()
                settings.panelDidClose()
            }
            .accessibilityIdentifier("settings.appScope")
    }
}

struct SettingsAttendeeList<Route: Hashable>: View {
    let settings: SettingsPresenter
    let link: (SettingsRoute) -> Route?

    var body: some View {
        SettingsRootList(settings: settings, link: link)
            .navigationTitle(SettingsCopy.panelTitle())
            .navigationBarTitleDisplayMode(.inline)
            .task {
                settings.refreshPreferences()
            }
            .accessibilityIdentifier("settings.attendee")
    }
}
#endif
