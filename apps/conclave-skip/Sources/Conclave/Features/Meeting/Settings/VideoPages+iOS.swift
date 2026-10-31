#if os(iOS) && !SKIP
import SwiftUI
import UIKit

struct SettingsVideoPage<Route: Hashable>: View {
    let route: SettingsRoute
    let settings: SettingsPresenter
    let link: (SettingsRoute) -> Route?

    var body: some View {
        switch route {
        case .cameraQuality:
            SettingsCameraQualityPage(settings: settings, link: link)
        case .cameraAdvanced:
            SettingsAdvancedPage(settings: settings, isScreenShare: false)
        case .screenShareQuality:
            SettingsShareQualityPage(settings: settings, link: link)
        case .screenShareAdvanced:
            SettingsAdvancedPage(settings: settings, isScreenShare: true)
        default:
            SettingsConnectionPage(settings: settings)
        }
    }
}

private struct SettingsCameraQualityPage<Route: Hashable>: View {
    let settings: SettingsPresenter
    let link: (SettingsRoute) -> Route?

    var body: some View {
        let video = settings.video
        Form {
            Section {
                Picker(SettingsCopy.rowTitle(.cameraQuality),
                       selection: Binding(get: { video.cameraPreset }, set: { settings.setCameraPreset($0) })) {
                    ForEach(video.presets, id: \.self) { preset in
                        SettingsOptionLabel(title: SettingsCopy.cameraPreset(preset), detail: SettingsCopy.cameraPresetDetail(preset))
                            .tag(preset)
                    }
                }
                .pickerStyle(.inline)
                .labelsHidden()
                .disabled(video.dataSaverOn)
                .accessibilityIdentifier("settings.quality.presets")
            } footer: {
                Text(SettingsCopy.cameraQualityFooter(video))
                    .accessibilityIdentifier("settings.quality.footer")
            }
            if let value = link(SettingsRoute.cameraAdvanced) {
                Section {
                    NavigationLink(value: value) {
                        LabeledContent(ConclaveStrings.text("Advanced"), value: SettingsCopy.resolution(video.custom.resolution))
                    }
                    .disabled(video.dataSaverOn)
                    .accessibilityIdentifier("settings.quality.advanced")
                }
            }
            Section {
                Button(ConclaveStrings.text("Restore Recommended Settings")) {
                    settings.restoreRecommendedQuality()
                }
                .accessibilityIdentifier("settings.quality.restore")
            }
        }
        .formStyle(.grouped)
        .navigationTitle(SettingsCopy.pageTitle(.cameraQuality))
        .navigationBarTitleDisplayMode(.inline)
        .tint(HostingTheme.coralText)
        .accessibilityIdentifier("settings.page.cameraQuality")
    }
}

private struct SettingsShareQualityPage<Route: Hashable>: View {
    let settings: SettingsPresenter
    let link: (SettingsRoute) -> Route?

    var body: some View {
        let video = settings.video
        Form {
            Section {
                Picker(SettingsCopy.rowTitle(.screenShareQuality),
                       selection: Binding(get: { video.screenSharePreset }, set: { settings.setScreenSharePreset($0) })) {
                    ForEach(video.screenSharePresets, id: \.self) { preset in
                        SettingsOptionLabel(title: SettingsCopy.screenSharePreset(preset),
                                            detail: SettingsCopy.screenSharePresetDetail(preset))
                            .tag(preset)
                    }
                }
                .pickerStyle(.inline)
                .labelsHidden()
                .accessibilityIdentifier("settings.share.presets")
            } footer: {
                Text(SettingsCopy.shareQualityFooter())
            }
            if let value = link(SettingsRoute.screenShareAdvanced) {
                Section {
                    NavigationLink(value: value) {
                        LabeledContent(ConclaveStrings.text("Advanced"), value: SettingsCopy.resolution(video.screenShareCustom.resolution))
                    }
                    .accessibilityIdentifier("settings.share.advanced")
                }
            }
            Section {
                Button(ConclaveStrings.text("Restore Recommended Settings")) {
                    settings.restoreRecommendedScreenShare()
                }
                .accessibilityIdentifier("settings.share.restore")
            }
            if video.canShareDeviceAudio {

                Section {
                    Toggle(ConclaveStrings.text("Share Device Audio"),
                           isOn: Binding(get: { video.shareDeviceAudioOn }, set: { settings.setShareDeviceAudio($0) }))
                        .accessibilityIdentifier("settings.share.deviceAudio")
                } footer: {
                    Text(SettingsCopy.shareDeviceAudioFooter())
                }
            }
        }
        .formStyle(.grouped)
        .navigationTitle(SettingsCopy.pageTitle(.screenShareQuality))
        .navigationBarTitleDisplayMode(.inline)
        .tint(HostingTheme.coralText)
        .accessibilityIdentifier("settings.page.screenShareQuality")
    }
}

private struct SettingsOptionLabel: View {
    let title: String
    let detail: String

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(title)
            Text(detail)
                .font(.footnote)
                .foregroundStyle(HostingTheme.secondaryText)
        }
    }
}

private struct SettingsAdvancedPage: View {
    let settings: SettingsPresenter
    let isScreenShare: Bool

    var body: some View {
        let video = settings.video
        let limits = isScreenShare ? video.screenShareCustom : video.custom
        Form {
            Section {
                Picker(isScreenShare ? ConclaveStrings.text("Maximum Size") : ConclaveStrings.text("Resolution"),
                       selection: Binding(get: { limits.resolution }, set: { value in
                           if isScreenShare { settings.setScreenShareResolution(value) } else { settings.setCameraResolution(value) }
                       })) {
                    ForEach(limits.resolutions, id: \.self) { option in
                        Text(SettingsCopy.resolution(option)).tag(option)
                    }
                }
                .pickerStyle(.menu)
                .accessibilityIdentifier("settings.advanced.resolution")
                Picker(ConclaveStrings.text("Frame Rate"),
                       selection: Binding(get: { limits.frameRate }, set: { value in
                           if isScreenShare { settings.setScreenShareFrameRate(value) } else { settings.setCameraFrameRate(value) }
                       })) {
                    ForEach(limits.frameRates, id: \.self) { option in
                        Text(SettingsCopy.frameRate(option)).tag(option)
                    }
                }
                .pickerStyle(.menu)
                .accessibilityIdentifier("settings.advanced.frameRate")
                Picker(ConclaveStrings.text("Optimize For"),
                       selection: Binding(get: { limits.optimizeFor }, set: { value in
                           if isScreenShare { settings.setScreenShareOptimizeFor(value) } else { settings.setCameraOptimizeFor(value) }
                       })) {
                    ForEach(limits.optimizeOptions, id: \.self) { option in
                        Text(isScreenShare ? SettingsCopy.screenShareOptimize(option) : SettingsCopy.cameraOptimize(option)).tag(option)
                    }
                }
                .pickerStyle(.menu)
                .accessibilityIdentifier("settings.advanced.optimize")
                Picker(ConclaveStrings.text("Under Pressure"),
                       selection: Binding(get: { limits.underPressure }, set: { value in
                           if isScreenShare { settings.setScreenShareUnderPressure(value) } else { settings.setCameraUnderPressure(value) }
                       })) {
                    ForEach(limits.pressureOptions, id: \.self) { option in
                        Text(SettingsCopy.underPressure(option, isScreenShare: isScreenShare)).tag(option)
                    }
                }
                .pickerStyle(.menu)
                .accessibilityIdentifier("settings.advanced.pressure")
            }
            Section {
                SettingsBitrateRow(settings: settings, limits: limits, isScreenShare: isScreenShare)
            } footer: {
                if isScreenShare {
                    Text(SettingsCopy.shareQualityFooter())
                }
            }
        }
        .formStyle(.grouped)
        .navigationTitle(SettingsCopy.pageTitle(isScreenShare ? .screenShareAdvanced : .cameraAdvanced))
        .navigationBarTitleDisplayMode(.inline)
        .tint(HostingTheme.coralText)
        .accessibilityIdentifier(isScreenShare ? "settings.page.screenShareAdvanced" : "settings.page.cameraAdvanced")
    }
}

private struct SettingsBitrateRow: View {
    let settings: SettingsPresenter
    let limits: CameraLimitsModel
    let isScreenShare: Bool
    @State private var draft: Double = 0
    @State private var hasDraft = false

    var body: some View {
        let shown = hasDraft ? Int(draft) : limits.bitrateKbps
        VStack(alignment: .leading, spacing: 8) {
            LabeledContent(ConclaveStrings.text("Full-Quality Bitrate"), value: SettingsCopy.bitrate(shown))
                .monospacedDigit()
            Slider(value: Binding(get: { hasDraft ? draft : Double(limits.bitrateKbps) },
                                  set: { value in
                                      draft = value
                                      hasDraft = true
                                  }),
                   in: Double(limits.minBitrateKbps)...Double(limits.maxBitrateKbps),
                   step: Double(limits.bitrateStepKbps))
                .accessibilityLabel(ConclaveStrings.text("Full-Quality Bitrate"))
                .accessibilityValue(SettingsCopy.bitrate(shown))
        }
        .accessibilityIdentifier("settings.advanced.bitrate")
        .task(id: hasDraft ? Int(draft) : -1) {
            guard hasDraft else { return }
            try? await Task.sleep(for: .milliseconds(500))
            guard !Task.isCancelled else { return }
            let value = Int(draft)
            if isScreenShare { settings.setScreenShareBitrate(value) } else { settings.setCameraBitrate(value) }
            hasDraft = false
        }
    }
}

private struct SettingsConnectionPage: View {
    let settings: SettingsPresenter

    var body: some View {
        let general = settings.general
        Form {
            Section {
                LabeledContent {
                    Text(SettingsCopy.connectionValue(general.connection))
                } label: {
                    Label {
                        Text(ConclaveStrings.text("Connection Quality"))
                    } icon: {
                        Image(systemName: SettingsConnectionGlyph.symbol(general.connection))
                            .foregroundStyle(SettingsConnectionGlyph.tint(general.connection))
                    }
                }
                .accessibilityElement(children: .combine)
                .accessibilityIdentifier("settings.connection.quality")
                Text(SettingsCopy.connectionSummary(general.connection))
                    .foregroundStyle(HostingTheme.secondaryText)
                    .accessibilityIdentifier("settings.connection.summary")
            }
            if general.lowBandwidth {
                Section {
                    Label(ConclaveStrings.text("Low bandwidth. Audio is being prioritized."),
                          systemImage: ConclaveSymbols.wifiExclamationmark)
                        .accessibilityIdentifier("settings.connection.lowBandwidth")
                }
            }
            Section {
                SettingsConnectionDetails(stats: settings.stats)
            } header: {
                Text(ConclaveStrings.text("Details"))
            } footer: {
                VStack(alignment: .leading, spacing: 4) {
                    Text(ConclaveStrings.text("These details describe your connection only."))
                    if general.isRecovering {
                        Text(ConclaveStrings.text("Reconnecting"))
                            .accessibilityIdentifier("settings.connection.reconnecting")
                    }
                }
            }
        }
        .formStyle(.grouped)
        .navigationTitle(SettingsCopy.pageTitle(.connection))
        .navigationBarTitleDisplayMode(.inline)
        .task {

            await settings.stats.observe()
        }
        .accessibilityIdentifier("settings.page.connection")
    }
}

private struct SettingsConnectionDetails: View {
    let stats: ConnectionStatsModel

    var body: some View {
        let values = stats.values
        Group {
            SettingsStatRow(title: ConclaveStrings.text("Latency"),
                            value: values.latencyMillis.map { SettingsCopy.milliseconds($0) }, identifier: "latency")
            SettingsStatRow(title: ConclaveStrings.text("Packet Loss"),
                            value: values.packetLossPercent.map { SettingsCopy.packetLoss($0) }, identifier: "packetLoss")
            SettingsStatRow(title: ConclaveStrings.text("Jitter"),
                            value: values.jitterMillis.map { SettingsCopy.milliseconds($0) }, identifier: "jitter")
            SettingsStatRow(title: ConclaveStrings.text("Video Bitrate"),
                            value: values.videoBitrateKbps.map { SettingsCopy.bitrate($0) }, identifier: "videoBitrate")
            SettingsStatRow(title: ConclaveStrings.text("Video Codec"),
                            value: values.videoCodec.isEmpty ? nil : values.videoCodec, identifier: "videoCodec")
            SettingsStatRow(title: ConclaveStrings.text("Audio Bitrate"),
                            value: values.audioBitrateKbps.map { SettingsCopy.bitrate($0) }, identifier: "audioBitrate")
            SettingsStatRow(title: ConclaveStrings.text("Upload"),
                            value: values.uploadKbps.map { SettingsCopy.bitrate($0) }, identifier: "upload")
            SettingsStatRow(title: ConclaveStrings.text("Download"),
                            value: values.downloadKbps.map { SettingsCopy.bitrate($0) }, identifier: "download")
        }
    }
}

private struct SettingsStatRow: View {
    let title: String
    let value: String?
    let identifier: String

    var body: some View {
        LabeledContent(title, value: value ?? SettingsCopy.noData())
            .monospacedDigit()
            .accessibilityIdentifier("settings.connection." + identifier)
    }
}

enum SettingsConnectionGlyph {
    static func symbol(_ label: ConnectionQualityLabel) -> String {
        switch label {
        case .good: return ConclaveSymbols.checkmark
        case .fair: return ConclaveSymbols.exclamationmarkTriangleFill
        case .poor, .veryPoor: return ConclaveSymbols.wifiExclamationmark
        case .measuring: return ConclaveSymbols.waveform
        case .unavailable: return ConclaveSymbols.infoCircle
        }
    }

    static func tint(_ label: ConnectionQualityLabel) -> Color {
        switch label {
        case .good: return HostingTheme.statusSuccess
        case .fair: return HostingTheme.statusWarning
        case .poor, .veryPoor: return Color(uiColor: .systemRed)
        case .measuring, .unavailable: return HostingTheme.secondaryText
        }
    }
}
#endif
