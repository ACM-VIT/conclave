#if os(iOS) && !SKIP
import Foundation

// S60 0.6 L6-14 (SET-1, SET-2, SET-4) on iOS: the one exhaustive copy mapping for Settings. Every typed reason, phase
// and raw-value field the presenter publishes resolves here to a String Catalog key (Apple title case for controls,
// titles and section headers; sentence case for footers, values and status lines, S60 0.1). A contract test
// enumerates every case (T/SettingsTranscriptPoliciesTests.swift). The Android twin is K/ui/copy/SettingsCopy.kt.

enum SettingsCopy {
    static func panelTitle() -> String { ConclaveStrings.text("Settings") }

    static func sectionTitle(_ section: SettingsSection) -> String {
        switch section {
        case .audio: return ConclaveStrings.text("Audio")
        case .video: return ConclaveStrings.text("Video")
        case .captions: return ConclaveStrings.text("Captions")
        case .chat: return ConclaveStrings.text("Chat")
        case .host: return ConclaveStrings.text("Host")
        case .general: return ConclaveStrings.text("General")
        case .account: return ConclaveStrings.text("Account")
        case .about: return ConclaveStrings.text("About")
        }
    }

    /// Row titles (the root keeps the longer labels; pushed pages use `pageTitle`).
    static func rowTitle(_ row: SettingsRowID) -> String {
        switch row {
        case .output: return ConclaveStrings.text("Output")
        case .microphone: return ConclaveStrings.text("Microphone")
        case .noiseSuppression: return ConclaveStrings.text("Noise Suppression")
        case .testSound: return ConclaveStrings.text("Play Test Sound")
        case .cameraFacing: return ConclaveStrings.text("Camera")
        case .mirror: return ConclaveStrings.text("Mirror My Video")
        case .cameraQuality: return ConclaveStrings.text("Camera Quality")
        case .screenShareQuality: return ConclaveStrings.text("Screen Share Quality")
        case .dataSaver: return ConclaveStrings.text("Data Saver")
        case .effects: return ConclaveStrings.text("Effects")
        case .captions: return ConclaveStrings.text("Captions")
        case .captionStyle: return ConclaveStrings.text("Caption Style")
        case .chatPreviews: return ConclaveStrings.text("Show Chat Previews")
        case .playVoiceMessages: return ConclaveStrings.text("Play Voice Messages")
        case .voiceMessages: return ConclaveStrings.text("Voice Messages")
        case .hostControls: return ConclaveStrings.text("Host Controls")
        case .knockSound: return ConclaveStrings.text("Sound for Join Requests")
        case .handSound: return ConclaveStrings.text("Sound for Raised Hands")
        case .connection: return ConclaveStrings.text("Connection")
        case .messageNotifications: return ConclaveStrings.text("Message Notifications")
        case .callNotification: return ConclaveStrings.text("Call Notification")
        case .openLinks: return ConclaveStrings.text("Open Conclave Links")
        case .alwaysShowControls: return ConclaveStrings.text("Always Show Controls")
        case .haptics: return ConclaveStrings.text("Haptics")
        case .name: return ConclaveStrings.text("Name")
        case .identity: return ConclaveStrings.text("Account")
        case .signOut: return ConclaveStrings.text("Sign Out…")
        case .privacy: return ConclaveStrings.text("Privacy Policy")
        case .exportDiagnostics: return ConclaveStrings.text("Export Diagnostics")
        case .version: return ConclaveStrings.text("Version")
        }
    }

    /// Pushed page titles, all under 15 characters (S60 2 a).
    static func pageTitle(_ route: SettingsRoute) -> String {
        switch route {
        case .root: return ConclaveStrings.text("Settings")
        case .output: return ConclaveStrings.text("Output")
        case .microphone: return ConclaveStrings.text("Microphone")
        case .cameraQuality: return ConclaveStrings.text("Camera Quality")
        case .cameraAdvanced: return ConclaveStrings.text("Advanced")
        case .screenShareQuality: return ConclaveStrings.text("Share Quality")
        case .screenShareAdvanced: return ConclaveStrings.text("Advanced")
        case .connection: return ConclaveStrings.text("Connection")
        case .voice: return ConclaveStrings.text("Voice Messages")
        case .voiceRecord: return ConclaveStrings.text("Record Voice")
        case .privacy: return ConclaveStrings.text("Privacy Policy")
        case .hostControls, .hostInviteCode, .hostAccessList, .hostNotice, .hostAttendeeCode, .hostCustomLink:
            return ConclaveStrings.text("Host Controls")
        case .hostWebinar: return ConclaveStrings.text("Webinar Settings")
        }
    }

    /// The visible reason under a disabled row, or nil (D10).
    static func reason(_ reason: SettingsReason) -> String? {
        switch reason {
        case .none: return nil
        case .reconnecting: return ConclaveStrings.text("Available when you\u{2019}re reconnected.")
        case .audioOnly: return ConclaveStrings.text("Turn off Audio Only in Layout to use the camera.")
        case .systemDataSaver: return ConclaveStrings.text("On because Low Data Mode is on.")
        case .hostQualityCap: return ConclaveStrings.text("The host limited video quality for this meeting.")
        case .unsupportedDevice: return ConclaveStrings.text("Not available on this device.")
        case .appliesNextJoin: return ConclaveStrings.text("Applies the next time you join.")
        case .permissionDenied: return ConclaveStrings.text("Microphone access is off.")
        case .cameraInUse, .cameraMultitasking, .cameraInBackground: return ConclaveStrings.text("Camera paused")
        case .unmuteToTest: return ConclaveStrings.text("Unmute to test your microphone.")
        case .guest:
            return ConclaveStrings.text("Sign in to create a personal voice for voice messages. Until then, messages use the system voice.")
        case .notInAppYet:
            return ConclaveStrings.text("Personal voices aren\u{2019}t available in the app yet. Messages use the system voice.")
        }
    }

    /// The Account name field's reason (1 f): the reconnecting copy is the name-specific sentence.
    static func nameReason(_ reason: SettingsReason) -> String? {
        reason == SettingsReason.reconnecting ? ConclaveStrings.text("Reconnect before updating your name.") : nil
    }

    static func connectionValue(_ label: ConnectionQualityLabel) -> String {
        ConclaveStrings.text(ConnectionQualityLabelPolicy.catalogKey(label))
    }

    static func cameraFacing(_ facing: String) -> String {
        facing == "back" ? ConclaveStrings.text("Back") : ConclaveStrings.text("Front")
    }

    static func voiceKind(_ kind: VoiceKind) -> String {
        switch kind {
        case .system: return ConclaveStrings.text("System Voice")
        case .personal: return ConclaveStrings.text("Your Voice")
        }
    }

    static func micPhase(_ phase: MicTestPhase) -> String? {
        switch phase {
        case .idle, .metering: return nil
        case .starting: return ConclaveStrings.text("Starting microphone")
        case .recording: return ConclaveStrings.text("Recording")
        case .replaying: return ConclaveStrings.text("Stop Playback")
        case .unavailable: return ConclaveStrings.text("Microphone unavailable")
        }
    }

    static func nameStatus(_ phase: NameSavePhase, refusal: String) -> String? {
        switch phase {
        case .idle: return nil
        case .saving: return ConclaveStrings.text("Saving")
        case .saved: return ConclaveStrings.text("Saved")
        case .failed: return PeopleActionText.renameRefusal(refusal)
        }
    }

    static func personalVoicePhase(_ phase: PersonalVoicePhase) -> String? {
        switch phase {
        case .unavailable, .none, .recording, .review: return nil
        case .creating: return ConclaveStrings.text("Creating")
        case .ready: return ConclaveStrings.text("Ready")
        case .failed: return ConclaveStrings.text("Couldn\u{2019}t create your voice. Try again.")
        case .deleting: return ConclaveStrings.text("In Progress")
        }
    }

    /// Identity line from raw values (1 g): "Guest", or the provider line under the account name.
    static func accountKind(_ kind: AccountKind) -> String? {
        switch kind {
        case .none: return nil
        case .guest: return ConclaveStrings.text("Guest")
        case .signedIn: return nil
        }
    }

    static func providerLine(_ provider: String) -> String? {
        switch provider {
        case "apple": return ConclaveStrings.text("Signed in with Apple")
        case "google": return ConclaveStrings.text("Signed in with Google")
        default: return nil
        }
    }

    static func notificationPermission(_ permission: NotificationPermission) -> String {
        switch permission {
        case .notDetermined, .granted:
            return ConclaveStrings.text("Get notified about private messages and mentions while you\u{2019}re in another app.")
        case .denied: return ConclaveStrings.text("Notifications are off for Conclave.")
        }
    }

    static func linkVerification(_ state: LinkVerification) -> String {
        state == LinkVerification.verified ? ConclaveStrings.text("In the App") : ConclaveStrings.text("In Your Browser")
    }

    static func signOutMessage(isHost: Bool) -> String {
        isHost ? ConclaveStrings.text("You\u{2019}ll stay in this call as a guest and lose host controls.")
            : ConclaveStrings.text("You\u{2019}ll stay in this call as a guest.")
    }

    static func levelValue(_ segments: Int) -> String {
        ConclaveStrings.format("Level %lld of %lld", segments, MicLevelPolicy.segmentCount)
    }

    static func voiceOption(_ voice: VoiceOptionModel) -> String {
        let language = Locale.current.localizedString(forIdentifier: voice.languageTag) ?? voice.languageTag
        return ConclaveStrings.format("Voice Name and Language %@ %@", voice.name, language)
    }

    /// The one fixed Preview sentence (C6-22).
    static func previewSentence() -> String {
        ConclaveStrings.text("This is how voice messages sound with this voice.")
    }

    /// The Audio footer; the row reason (`reason(audio.noiseSuppressionReason)`) is its own footer line, never
    /// concatenated (S60 0.1).
    static func audioFooter() -> String {
        ConclaveStrings.text("Noise suppression applies to your microphone in the meeting. The test follows it.")
    }

    static func captionsFooter() -> String {
        ConclaveStrings.text("Captions show on the stage while live notes are on. To change how captions look, open Settings, then Accessibility, then Subtitles & Captioning.")
    }
}
#endif
