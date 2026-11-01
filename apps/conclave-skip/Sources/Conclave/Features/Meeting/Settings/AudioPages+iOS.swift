#if os(iOS) && !SKIP
import AVFoundation
import SwiftUI

struct SettingsMicrophonePage: View {
    let settings: SettingsPresenter

    var body: some View {
        let audio = settings.audio
        let route = settings.routeOwner.route
        Form {
            if route.inputs.count > 1 {

                Section {
                    Picker(ConclaveStrings.text("Microphone"),
                           selection: Binding(get: { route.currentInputId }, set: { settings.requestInput(id: $0) })) {
                        ForEach(route.inputs) { input in
                            Text(input.name).tag(input.id)
                        }
                    }
                    .pickerStyle(.inline)
                    .accessibilityIdentifier("settings.mic.inputs")
                } footer: {
                    Text(ConclaveStrings.text("A headset or car audio can also change the microphone."))
                }
            }
            Section {
                if audio.isMuted {
                    Text(ConclaveStrings.text("Unmute to test your microphone."))
                        .accessibilityIdentifier("settings.mic.unmuteToTest")
                } else if audio.micPhase == MicTestPhase.starting {
                    HStack(spacing: 8) {
                        ProgressView()
                        Text(SettingsCopy.micPhase(MicTestPhase.starting) ?? "")
                    }
                    .accessibilityIdentifier("settings.mic.starting")
                } else {
                    SettingsMicLevelRow(meter: settings.micLevel)
                }
                if audio.canRecordMicTest {
                    SettingsRecordReplayRow(settings: settings, phase: audio.micPhase, isMuted: audio.isMuted)
                    LabeledContent(ConclaveStrings.text("Test Gain")) {
                        Slider(value: Binding(get: { audio.testGain }, set: { settings.setTestGain($0) }), in: 0...2, step: 0.1)
                            .frame(maxWidth: 160)
                    }
                    .accessibilityValue(ConclaveStrings.format("%@ times", String(format: "%.1f", audio.testGain)))
                    .accessibilityIdentifier("settings.mic.gain")
                }
            } header: {
                Text(ConclaveStrings.text("Test"))
            } footer: {
                if audio.canRecordMicTest {
                    Text(ConclaveStrings.text("Affects this test only."))
                }
            }
            if route.canShowMicModes {
                Section {
                    Button(ConclaveStrings.text("Mic Mode…")) {
                        AVCaptureDevice.showSystemUserInterface(.microphoneModes)
                    }
                    .accessibilityIdentifier("settings.mic.modes")
                } footer: {
                    Text(ConclaveStrings.text("Voice Isolation and Wide Spectrum are set by the system."))
                }
            }
        }
        .formStyle(.grouped)
        .navigationTitle(SettingsCopy.pageTitle(.microphone))
        .navigationBarTitleDisplayMode(.inline)
        .task {
            await settings.runMicTest()
        }
        .accessibilityIdentifier("settings.page.microphone")
    }
}

private struct SettingsRecordReplayRow: View {
    let settings: SettingsPresenter
    let phase: MicTestPhase
    let isMuted: Bool

    var body: some View {
        Button {
            if phase == MicTestPhase.replaying || phase == MicTestPhase.recording {
                settings.micSampleFinished()
            } else {
                settings.recordMicSample()
            }
        } label: {
            LabeledContent {
                if phase == MicTestPhase.recording || phase == MicTestPhase.replaying {
                    Text(SettingsCopy.micPhase(phase) ?? "")
                }
            } label: {
                Text(ConclaveStrings.text("Record and Replay"))
            }
        }
        .disabled(isMuted)
        .accessibilityIdentifier("settings.mic.recordReplay")
    }
}
#endif
