#if os(iOS) && !SKIP
import AVFoundation
import SwiftUI

// S60 2 c `.microphone` (SET-2) on iOS: the microphone choice, the level meter and, where WP3 publishes
// `canRecordMicTest` (false on iOS until the C6-6 spike, Q8), Record and Replay and Test Gain; Mic Mode opens the
// system module when the route owner reports it (D22). The page body reads `settings.audio` (phase changes only) and
// the route snapshot; the 10 Hz level is read only by `SettingsMicLevelRow`. The test runs for the page's lifetime
// (`.task`), never from appearance callbacks, and stops when the page leaves (Back, panel close). The Android page has
// no input picker and no Mic Mode (the communication device carries the microphone, 1 d).

struct SettingsMicrophonePage: View {
    let settings: SettingsPresenter

    var body: some View {
        let audio = settings.audio
        let route = settings.routeOwner.route
        Form {
            if route.inputs.count > 1 {
                // iOS 26's AVInputPickerInteraction is not adopted yet; the labelled inline picker is the spec's
                // fallback for every version (2 c), shown only with more than one input.
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

/// Record and Replay (C6-6, only while `canRecordMicTest`): "Recording" while the 5 s capture runs, "Stop Playback"
/// while it replays through the call output.
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
