#if os(iOS) && !SKIP
import SwiftUI

// S60 2 c `.voice` (SET-4) on iOS: "Voice Messages". Your Messages (System Voice, or Your Voice once a personal voice is
// ready), Your Voice (the C6-23 rows only while WP10 publishes `canUsePersonalVoice`; W10-4 is out of this push, so the
// section shows its footer only, Q12), and Voices You Hear: the standard voice you hear for speakers without a
// personal voice (C6-22, ships now because receiver-side synthesis runs locally) with Preview on tap only, never on
// open. The voice list is loaded once per page from the platform speaker; the chosen voice reaches `TtsSpeaker` once
// through the queue's preference read. `link` maps the recorder push onto the container's path (the Settings panel or
// the Account sheet in the app scope, where Preview is absent: no call output).

struct SettingsVoicePage<Route: Hashable>: View {
    let settings: SettingsPresenter
    let link: (SettingsRoute) -> Route?
    @State private var confirmDelete = false

    var body: some View {
        let chat = settings.chat
        Form {
            Section {
                Picker(ConclaveStrings.text("Voice"), selection: Binding(get: { chat.effectiveVoiceKind }, set: { settings.setVoiceKind($0) })) {
                    Text(SettingsCopy.voiceKind(.system)).tag(VoiceKind.system)
                    Text(SettingsCopy.voiceKind(.personal)).tag(VoiceKind.personal)
                        .disabled(chat.personalVoice != PersonalVoicePhase.ready)
                }
                .pickerStyle(.inline)
                .labelsHidden()
                .accessibilityIdentifier("settings.voice.kind")
            } header: {
                Text(ConclaveStrings.text("Your Messages"))
            } footer: {
                Text(ConclaveStrings.text("Plays for everyone when you send a voice message."))
            }
            Section {
                if chat.canUsePersonalVoice {
                    SettingsPersonalVoiceRows(settings: settings, chat: chat, link: link, confirmDelete: $confirmDelete)
                }
            } header: {
                Text(ConclaveStrings.text("Your Voice"))
            } footer: {
                SettingsPersonalVoiceFooter(chat: chat)
            }
            Section {
                Picker(ConclaveStrings.text("Standard Voice"),
                       selection: Binding(get: { chat.standardVoiceId }, set: { settings.setStandardVoice($0) })) {
                    Text(ConclaveStrings.text("Automatic")).tag("")
                    ForEach(chat.standardVoices) { voice in
                        Text(SettingsCopy.voiceOption(voice)).tag(voice.id)
                    }
                }
                .pickerStyle(.navigationLink)
                .accessibilityIdentifier("settings.voice.standard")
                if chat.canPreviewStandardVoice {
                    Button(chat.standardPreview == SpeakerTestPhase.playing ? ConclaveStrings.text("Stop Preview")
                           : ConclaveStrings.text("Preview")) {
                        settings.toggleStandardVoicePreview(sentence: SettingsCopy.previewSentence())
                    }
                    .accessibilityIdentifier("settings.voice.preview")
                }
            } header: {
                Text(ConclaveStrings.text("Voices You Hear"))
            } footer: {
                Text(ConclaveStrings.text("You hear this for speakers without a personal voice."))
            }
        }
        .formStyle(.grouped)
        .tint(HostingTheme.coralText)
        .navigationTitle(SettingsCopy.pageTitle(.voice))
        .navigationBarTitleDisplayMode(.inline)
        .task {
            settings.setStandardVoices(TtsSpeaker.standardVoiceOptions())
        }
        .confirmationDialog(ConclaveStrings.text("Delete Your Voice?"), isPresented: $confirmDelete, titleVisibility: .visible) {
            Button(ConclaveStrings.text("Delete"), role: .destructive) { settings.deletePersonalVoice() }
            Button(ConclaveStrings.text("Cancel"), role: .cancel) {}
        } message: {
            Text(ConclaveStrings.text("Voice messages will use the system voice."))
        }
        .accessibilityIdentifier("settings.page.voice")
    }
}

/// C6-23 rows by phase (only while `canUsePersonalVoice`).
private struct SettingsPersonalVoiceRows<Route: Hashable>: View {
    let settings: SettingsPresenter
    let chat: SettingsChat
    let link: (SettingsRoute) -> Route?
    @Binding var confirmDelete: Bool

    var body: some View {
        switch chat.personalVoice {
        case .ready:
            LabeledContent(ConclaveStrings.text("Your Voice"), value: SettingsCopy.personalVoicePhase(.ready) ?? "")
            Button(ConclaveStrings.text("Hear My Voice")) { settings.hearPersonalVoice() }
                .accessibilityIdentifier("settings.voice.hear")
            Button(ConclaveStrings.text("Delete My Voice…"), role: .destructive) { confirmDelete = true }
                .accessibilityIdentifier("settings.voice.delete")
        case .creating, .deleting:
            HStack(spacing: 8) {
                ProgressView()
                Text(SettingsCopy.personalVoicePhase(chat.personalVoice) ?? "")
            }
        case .unavailable:
            EmptyView()
        case .none, .recording, .review, .failed:
            if let value = link(SettingsRoute.voiceRecord) {
                NavigationLink(value: value) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(ConclaveStrings.text("Create Your Voice"))
                        Text(ConclaveStrings.text("Record about a minute of speech to make a voice that sounds like you."))
                            .font(.footnote)
                            .foregroundStyle(HostingTheme.secondaryText)
                    }
                }
                .accessibilityIdentifier("settings.voice.create")
            }
        }
    }
}

/// The Your Voice footer: unavailable or guest (Q12), the create failure, or nothing.
private struct SettingsPersonalVoiceFooter: View {
    let chat: SettingsChat

    var body: some View {
        if !chat.canUsePersonalVoice, let reason = SettingsCopy.reason(chat.personalVoiceReason) {
            Text(reason).accessibilityIdentifier("settings.voice.unavailable")
        } else if chat.personalVoice == PersonalVoicePhase.failed, let failure = SettingsCopy.personalVoicePhase(.failed) {
            Text(failure).foregroundStyle(Color(uiColor: .systemRed))
        }
    }
}
#endif
