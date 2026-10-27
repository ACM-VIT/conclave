#if os(iOS) && !SKIP
import SwiftUI

// S60 0.6 L6-13 (SET-4) on iOS: the `VoiceSampleRecorder` view on the "Record Voice" page. It drives C6-23 through the
// presenter and never owns a recorder: the core pauses the meeting microphone for the take and restores the mute
// intent afterwards (HD request B6-T2 R1, generation rules). Ticking parts (remaining time, level) read only the
// `VoiceRecorderModel` leaf, so a take never republishes `SettingsChat`. Reachable only while `canUsePersonalVoice`
// (W10-4 is out of this push). No motion beyond the static level bar; "Creating" uses a system spinner (2 h).

struct SettingsVoiceRecordPage: View {
    let settings: SettingsPresenter
    @Environment(\.dismiss) private var dismiss
    @State private var confirmDiscard = false

    var body: some View {
        let phase = settings.chat.personalVoice
        let midTake = phase == PersonalVoicePhase.recording || phase == PersonalVoicePhase.review
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                VStack(alignment: .leading, spacing: 8) {
                    Text(ConclaveStrings.text("Read This Naturally"))
                        .font(.headline)
                        .accessibilityAddTraits(.isHeader)
                    Text(ConclaveStrings.text("Voice Sample Script"))
                        .font(.body)
                }
                .padding(16)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(Color(uiColor: .secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: CGFloat(DesignTokens.radiusTile), style: .continuous))
                if phase == PersonalVoicePhase.recording {
                    Text(ConclaveStrings.text("Your microphone is paused in the meeting while you record."))
                        .font(.footnote)
                        .foregroundStyle(HostingTheme.secondaryText)
                }
                SettingsVoiceRecorderProgress(model: settings.recorder, isRecording: phase == PersonalVoicePhase.recording)
                SettingsVoiceRecorderControls(settings: settings, phase: phase)
            }
            .padding(16)
        }
        .background(Color(uiColor: .systemGroupedBackground))
        .navigationTitle(SettingsCopy.pageTitle(.voiceRecord))
        .navigationBarTitleDisplayMode(.inline)
        .navigationBarBackButtonHidden(midTake)
        .toolbar {
            if midTake {
                ToolbarItem(placement: .topBarLeading) {
                    Button(ConclaveStrings.text("Cancel")) { confirmDiscard = true }
                        .accessibilityIdentifier("settings.recorder.cancel")
                }
            }
        }
        .confirmationDialog(ConclaveStrings.text("Discard Recording?"), isPresented: $confirmDiscard, titleVisibility: .visible) {
            Button(ConclaveStrings.text("Discard"), role: .destructive) {
                settings.discardVoiceSample()
                dismiss()
            }
            Button(ConclaveStrings.text("Cancel"), role: .cancel) {}
        }
        .onChange(of: phase) { _, next in
            // Success pops to Voice Messages, which shows "Ready" (2 f).
            if next == PersonalVoicePhase.ready { dismiss() }
        }
        .accessibilityIdentifier("settings.page.voiceRecord")
    }
}

/// The ticking leaf: "Keep speaking, %lld s left" (a polite live region updated every 10 s, 2 i) and the flat level bar.
private struct SettingsVoiceRecorderProgress: View {
    let model: VoiceRecorderModel
    let isRecording: Bool

    var body: some View {
        let left = model.secondsLeft
        VStack(alignment: .leading, spacing: 8) {
            if isRecording && left > 0 {
                Text(ConclaveStrings.format("Keep speaking, %lld s left", left))
                    .monospacedDigit()
                    .accessibilityIdentifier("settings.recorder.left")
            }
            SettingsLevelMeter(segments: isRecording ? model.segments : 0)
        }
        .onChange(of: left) { _, value in
            if isRecording && VoiceRecorderPolicy.shouldAnnounce(secondsLeft: value) {
                SettingsTaskLifetime.announce(ConclaveStrings.format("Keep speaking, %lld s left", value))
            }
        }
    }
}

private struct SettingsVoiceRecorderControls: View {
    let settings: SettingsPresenter
    let phase: PersonalVoicePhase

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            switch phase {
            case .recording:
                ConclaveButton(ConclaveStrings.text("Stop"), identifier: "settings.recorder.stop") { settings.stopVoiceSample() }
                    .accessibilityValue(ConclaveStrings.text("Recording"))
            case .review, .failed, .creating:
                ConclaveButton(ConclaveStrings.text("Listen Back"), role: .tonal, isEnabled: phase != PersonalVoicePhase.creating,
                               identifier: "settings.recorder.listen") { settings.playVoiceSample() }
                SettingsVoiceConsentToggle(settings: settings, model: settings.recorder)
                SettingsVoiceCreateButton(settings: settings, model: settings.recorder, isCreating: phase == PersonalVoicePhase.creating)
                ConclaveButton(ConclaveStrings.text("Redo"), role: .text, isEnabled: phase != PersonalVoicePhase.creating,
                               identifier: "settings.recorder.redo") { settings.discardVoiceSample() }
                if phase == PersonalVoicePhase.failed, let failure = SettingsCopy.personalVoicePhase(.failed) {
                    Text(failure).foregroundStyle(Color(uiColor: .systemRed))
                }
            default:
                ConclaveButton(ConclaveStrings.text("Record"), identifier: "settings.recorder.record") { settings.startVoiceSample() }
            }
        }
    }
}

private struct SettingsVoiceConsentToggle: View {
    let settings: SettingsPresenter
    let model: VoiceRecorderModel

    var body: some View {
        Toggle(isOn: Binding(get: { model.consent }, set: { settings.setVoiceConsent($0) })) {
            Text(ConclaveStrings.text("This is my voice. I consent to creating a clone of it and understand meeting participants may hear it."))
        }
        .accessibilityIdentifier("settings.recorder.consent")
    }
}

/// "Create My Voice": disabled until 60 s and consent (2 f).
private struct SettingsVoiceCreateButton: View {
    let settings: SettingsPresenter
    let model: VoiceRecorderModel
    let isCreating: Bool

    var body: some View {
        ConclaveButton(isCreating ? ConclaveStrings.text("Creating") : ConclaveStrings.text("Create My Voice"),
                       isEnabled: model.canCreate && !isCreating, isPending: isCreating,
                       identifier: "settings.recorder.create") { settings.createPersonalVoice() }
    }
}
#endif
