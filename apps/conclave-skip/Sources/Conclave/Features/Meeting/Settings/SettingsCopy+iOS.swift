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

    // MARK: SET-3 video, screen share and connection (S60 1 g, 2 g)

    /// Camera Quality options and the root value (the data-saver preset reads "Data Saver" while a ceiling applies).
    static func cameraPreset(_ rawValue: String) -> String {
        switch NativeCameraQualityPreset(rawValue: rawValue) ?? NativeCameraQualityPreset.auto {
        case .auto: return ConclaveStrings.text("Auto")
        case .highDefinition: return ConclaveStrings.text("HD")
        case .studio: return ConclaveStrings.text("Studio")
        case .custom: return ConclaveStrings.text("Custom")
        case .dataSaver: return ConclaveStrings.text("Data Saver")
        }
    }

    static func cameraPresetDetail(_ rawValue: String) -> String {
        switch NativeCameraQualityPreset(rawValue: rawValue) ?? NativeCameraQualityPreset.auto {
        case .auto: return ConclaveStrings.text("720p at 30 fps")
        case .highDefinition: return ConclaveStrings.text("1080p at 30 fps")
        case .studio: return ConclaveStrings.text("1080p at up to 60 fps")
        case .custom: return ConclaveStrings.text("Your advanced limits")
        case .dataSaver: return ConclaveStrings.text("360p at 20 fps")
        }
    }

    static func screenSharePreset(_ rawValue: String) -> String {
        switch NativeScreenShareQualityPreset(rawValue: rawValue) ?? NativeScreenShareQualityPreset.auto {
        case .auto: return ConclaveStrings.text("Auto")
        case .presentation: return ConclaveStrings.text("Presentation")
        case .motion: return ConclaveStrings.text("Motion")
        case .custom: return ConclaveStrings.text("Custom")
        }
    }

    static func screenSharePresetDetail(_ rawValue: String) -> String {
        switch NativeScreenShareQualityPreset(rawValue: rawValue) ?? NativeScreenShareQualityPreset.auto {
        case .auto: return ConclaveStrings.text("Balanced")
        case .presentation: return ConclaveStrings.text("Crisp text")
        case .motion: return ConclaveStrings.text("Smooth video")
        case .custom: return ConclaveStrings.text("Your advanced limits")
        }
    }

    /// Advanced "Resolution" and Share "Maximum Size" values (MQS labels, localized here).
    static func resolution(_ rawValue: String) -> String {
        switch NativeMediaResolution(rawValue: rawValue) ?? NativeMediaResolution.p720 {
        case .p360: return ConclaveStrings.text("360p")
        case .p720: return ConclaveStrings.text("720p HD")
        case .p1080: return ConclaveStrings.text("1080p Full HD")
        case .p1440: return ConclaveStrings.text("1440p QHD")
        case .p2160: return ConclaveStrings.text("2160p 4K")
        }
    }

    static func frameRate(_ fps: Int) -> String {
        ConclaveStrings.format("%lld fps", fps)
    }

    static func bitrate(_ kbps: Int) -> String {
        ConclaveStrings.format("%lld kbps", kbps)
    }

    static func cameraOptimize(_ rawValue: String) -> String {
        switch NativeCameraContentHint(rawValue: rawValue) ?? NativeCameraContentHint.motion {
        case .motion: return ConclaveStrings.text("Natural Motion")
        case .detail: return ConclaveStrings.text("Fine Detail")
        }
    }

    static func screenShareOptimize(_ rawValue: String) -> String {
        switch NativeScreenShareContentHint(rawValue: rawValue) ?? NativeScreenShareContentHint.detail {
        case .text: return ConclaveStrings.text("Text and Slides")
        case .detail: return ConclaveStrings.text("Fine Detail")
        case .motion: return ConclaveStrings.text("Video and Motion")
        }
    }

    /// "Under Pressure": the camera keeps motion or the image; a share keeps its text or its motion.
    static func underPressure(_ rawValue: String, isScreenShare: Bool) -> String {
        switch NativeMediaDegradationPreference(rawValue: rawValue) ?? NativeMediaDegradationPreference.balanced {
        case .balanced: return ConclaveStrings.text("Balance Both")
        case .maintainFramerate: return ConclaveStrings.text("Keep Motion Smooth")
        case .maintainResolution:
            return isScreenShare ? ConclaveStrings.text("Keep Text Sharp") : ConclaveStrings.text("Keep Image Sharp")
        }
    }

    static func videoFooter() -> String {
        ConclaveStrings.text("Mirroring changes only your view. Data Saver lowers the video you send and receive.")
    }

    /// The Camera Quality page footer (2 f): Data Saver, the host's limit, or the ceiling explanation.
    static func cameraQualityFooter(_ video: SettingsVideo) -> String {
        if video.dataSaverOn { return ConclaveStrings.text("Data Saver is on, so video is sent at up to 360p.") }
        if video.qualityCappedByHost { return ConclaveStrings.text("The host limited video quality for this meeting.") }
        return ConclaveStrings.text("Conclave can go below this when your connection or device is under pressure.")
    }

    static func shareQualityFooter() -> String {
        ConclaveStrings.text("Changes apply to an active share right away.")
    }

    static func shareDeviceAudioFooter() -> String {
        ConclaveStrings.text("Shares sound from apps that allow it. Your call audio is never included.")
    }

    /// The preview card's status line (sentence case, 1 g).
    static func previewStatus(_ state: PreviewState) -> String? {
        switch state {
        case .published: return ConclaveStrings.text("Visible to everyone")
        case .starting, .live, .interrupted: return ConclaveStrings.text("Only visible to you")
        case .off, .unavailable, .blocked: return nil
        }
    }

    /// The preview card's accessibility value: why the camera paused (another app, multitasking, background), the
    /// permission, or Audio Only (1 f).
    static func previewReason(_ reason: SettingsReason) -> String? {
        switch reason {
        case .cameraInUse: return ConclaveStrings.text("Another app is using the camera.")
        case .cameraMultitasking: return ConclaveStrings.text("The camera isn\u{2019}t available while multitasking.")
        case .cameraInBackground: return ConclaveStrings.text("The camera isn\u{2019}t available in the background.")
        case .permissionDenied: return ConclaveStrings.text("Camera access is off")
        case .audioOnly: return ConclaveStrings.text("Turn off Audio Only in Layout to use the camera.")
        default: return nil
        }
    }

    /// The Connection page summary under the quality (2 g).
    static func connectionSummary(_ label: ConnectionQualityLabel) -> String {
        switch label {
        case .measuring: return ConclaveStrings.text("Measuring your connection")
        case .good: return ConclaveStrings.text("Your connection looks good.")
        case .fair: return ConclaveStrings.text("Your connection is a little unstable.")
        case .poor, .veryPoor: return ConclaveStrings.text("Your connection is struggling. Quality is reduced automatically.")
        case .unavailable: return ConclaveStrings.text("Connection details aren\u{2019}t available right now.")
        }
    }

    static func milliseconds(_ value: Int) -> String {
        ConclaveStrings.format("%lld ms", value)
    }

    /// Packet loss in percent, locale formatted (no catalog key: the system formats percent).
    static func packetLoss(_ percent: Double) -> String {
        (percent / 100.0).formatted(.percent.precision(.fractionLength(0...1)))
    }

    static func noData() -> String {
        ConclaveStrings.text("No data yet")
    }
}
#endif
