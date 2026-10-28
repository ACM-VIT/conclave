import Foundation
import Observation

// S60 0.5, 1, 2 (SET-1, SET-2, SET-4): the one Settings content source for both scopes (RECONCILE R26). `call` is
// `MeetingPanel.settings` (and its attendee-filtered variant, R44, pushed from Webinar Details); `app` is Account >
// Settings outside a call (S10 5), with the same rows, components and preference stores, so a preference reads the
// same in and out of a call. Transpiled for both platforms (Skip Lite: String raw-value enums, scalar structs, arrays
// of structs, closures, no self-observation). The core pushes `SettingsInputs` through `apply(_:)`; the presenter
// publishes five equality-guarded snapshots (one stored property per section family, so a route change redraws only
// the Audio section) plus the row list, and forwards media and core intents through one `onCommand` closure. Hot
// values live in their own leaves (`MicLevelMeter` at 10 Hz while the Microphone page is visible, `VoiceRecorderModel`
// while a take runs), so a ticking value never republishes a snapshot (S60 2 k). Reasons and phases are typed enums;
// every platform resolves them through its one copy file (L6-14: `SettingsCopy+iOS.swift`, `K/ui/copy/SettingsCopy.kt`).
//
// SET-3 (S60 2 video, screen share and connection rows, 0.6 L6-3, 0.8 C6-3, C6-4, C6-5, C6-8, C6-9, C6-29; RECONCILE
// R22, R40, R43; S70 SY22): the Video section grows the preview card, Mirror My Video, Camera Quality (presets as encoder
// ceilings over `NativeMediaQualityPreferences`), Screen Share Quality with Share Device Audio, and Data Saver (the
// switch OR the system signal); General > Connection pushes the Connection page whose details are the
// `ConnectionStatsModel` leaf. Preference writes reach the core through `preferenceChanged` (the core re-runs its publish
// resolver and receive policy); the preview goes through the one WP3 `LocalPreviewController` (`previewHooks`), never a
// screen.

// MARK: - Vocabulary (S60 0.5)

/// R26: `app` = Account > Settings outside a call (S10 5); `call` = `MeetingPanel.settings`.
enum SettingsScope: String, CaseIterable, Equatable {
    case app, call
}

/// Why a row is shown: available, shown disabled with a reason, or absent (D11: a missing capability hides the row).
enum SettingsCapability: String, CaseIterable, Equatable {
    case available, unavailable, hidden
}

enum SettingsReason: String, CaseIterable, Equatable {
    case none, reconnecting, audioOnly, systemDataSaver, hostQualityCap, unsupportedDevice, appliesNextJoin
    case permissionDenied, cameraInUse, cameraMultitasking, cameraInBackground, unmuteToTest, guest, notInAppYet
}

enum SpeakerTestPhase: String, CaseIterable, Equatable {
    case idle, playing
}

enum MicTestPhase: String, CaseIterable, Equatable {
    case idle, starting, metering, recording, replaying, unavailable
}

enum NameSavePhase: String, CaseIterable, Equatable {
    case idle, saving, saved, failed
}

/// S70 2 c.
enum NotificationPermission: String, CaseIterable, Equatable {
    case notDetermined, granted, denied
}

/// Android 12+ App Links state (S70 9).
enum LinkVerification: String, CaseIterable, Equatable {
    case verified, notVerified, unknown
}

enum AccountKind: String, CaseIterable, Equatable {
    case none, guest, signedIn
}

/// C6-23. `unavailable` until WP10 publishes `canUsePersonalVoice` (W10-4 is out of this push).
enum PersonalVoicePhase: String, CaseIterable, Equatable {
    case unavailable, none, recording, review, creating, ready, failed, deleting
}

/// The row policy's platform input: Haptics is iOS only (F00 8), Caption Style and the Android status rows are
/// Android only, and iOS has Output plus Microphone where Android has Audio output plus Test microphone (1 d).
enum SettingsPlatform: String, CaseIterable, Equatable {
    case ios, android

    static var current: SettingsPlatform {
        #if SKIP
        return SettingsPlatform.android
        #else
        return SettingsPlatform.ios
        #endif
    }
}

/// S60 1 b section order.
enum SettingsSection: String, CaseIterable, Equatable {
    case audio, video, captions, chat, host, general, account, about
}

/// Every row the root can draw. Rows whose page or capability belongs to a later slice (camera quality, screen
/// share quality, mirror, Data Saver, effects: SET-3, SET-6; Export Diagnostics: SYS-15; message notifications and
/// the Android status rows: SYS-3 and S70 9) stay out of the list until their capability input turns true.
enum SettingsRowID: String, CaseIterable, Equatable {
    case output, microphone, noiseSuppression, testSound
    case cameraFacing, mirror, cameraQuality, screenShareQuality, dataSaver, effects
    case captions, captionStyle
    case chatPreviews, playVoiceMessages, voiceMessages
    case hostControls, knockSound, handSound
    case connection, messageNotifications, callNotification, openLinks, alwaysShowControls, haptics
    case name, identity, signOut
    case privacy, exportDiagnostics, version
}

struct SettingsRowSection: Equatable, Identifiable {
    let id: String
    let section: SettingsSection
    let rows: [SettingsRowID]
}

/// A preference the presenter wrote; the core refreshes whatever reads it (`preferenceChanged`). SET-3: `mirror` (the
/// stage self view), `cameraQuality`, `screenShareQuality` and `dataSaver` (the publish resolver, and the receive policy
/// for Data Saver), `shareDeviceAudio` (read by the next screen-share start).
enum SettingsPreferenceID: String, CaseIterable, Equatable {
    case noiseSuppression, captions, chatPreviews, playVoiceMessages, voiceKind, standardVoice, alwaysShowControls
    case haptics, knockSound, handSound
    case mirror, cameraQuality, screenShareQuality, dataSaver, shareDeviceAudio
}

// MARK: - Preference stores (C6-1, C6-14, C6-24; F00 8)

/// The Settings-owned preference keys. Nonisolated (UserDefaults is thread-safe), so the WebRTC clients read the noise
/// suppression value when they build a microphone source and the core reads the rest when it builds stage inputs.
/// Captions (C6-13) and the voice keys (C6-22) keep their own stores (`CaptionsPreference`, `VoicePreferences`).
enum SettingsPreferences {
    /// C6-1, default on.
    static let noiseSuppressionKey = "conclave.pref.noiseSuppression"
    /// C6-14, default off; read by the S20 `AutoHideBlocker` through `StageInputs.alwaysShowControls`.
    static let alwaysShowControlsKey = "conclave.pref.alwaysShowControls"
    /// F00 8, default on; the same key `ConclaveFeedback.preferenceKey` reads on iOS.
    static let hapticsKey = "conclave.pref.haptics"
    /// C6-24, host only, default off; read through `StageNoticeInputs.knockSoundOn` and `handSoundOn`.
    static let knockSoundKey = "conclave.pref.knockSound"
    static let handSoundKey = "conclave.pref.handSound"

    static func noiseSuppression(defaults: UserDefaults = UserDefaults.standard) -> Bool {
        boolValue(noiseSuppressionKey, fallback: true, defaults: defaults)
    }

    static func setNoiseSuppression(_ on: Bool, defaults: UserDefaults = UserDefaults.standard) {
        defaults.set(on, forKey: noiseSuppressionKey)
    }

    static func alwaysShowControls(defaults: UserDefaults = UserDefaults.standard) -> Bool {
        boolValue(alwaysShowControlsKey, fallback: false, defaults: defaults)
    }

    static func setAlwaysShowControls(_ on: Bool, defaults: UserDefaults = UserDefaults.standard) {
        defaults.set(on, forKey: alwaysShowControlsKey)
    }

    static func haptics(defaults: UserDefaults = UserDefaults.standard) -> Bool {
        boolValue(hapticsKey, fallback: true, defaults: defaults)
    }

    static func setHaptics(_ on: Bool, defaults: UserDefaults = UserDefaults.standard) {
        defaults.set(on, forKey: hapticsKey)
    }

    static func knockSound(defaults: UserDefaults = UserDefaults.standard) -> Bool {
        boolValue(knockSoundKey, fallback: false, defaults: defaults)
    }

    static func setKnockSound(_ on: Bool, defaults: UserDefaults = UserDefaults.standard) {
        defaults.set(on, forKey: knockSoundKey)
    }

    static func handSound(defaults: UserDefaults = UserDefaults.standard) -> Bool {
        boolValue(handSoundKey, fallback: false, defaults: defaults)
    }

    static func setHandSound(_ on: Bool, defaults: UserDefaults = UserDefaults.standard) {
        defaults.set(on, forKey: handSoundKey)
    }

    private static func boolValue(_ key: String, fallback: Bool, defaults: UserDefaults) -> Bool {
        if defaults.object(forKey: key) == nil { return fallback }
        return defaults.bool(forKey: key)
    }
}

/// Every stored preference the root shows, read in one pass (on open, after a write).
struct SettingsPreferenceValues: Equatable {
    let noiseSuppressionOn: Bool
    let captionsOn: Bool
    let showsChatPreviews: Bool
    let playsVoiceMessages: Bool
    let voiceKind: VoiceKind
    let standardVoiceId: String
    let alwaysShowControls: Bool
    let hapticsOn: Bool
    let knockSoundOn: Bool
    let handSoundOn: Bool
    /// SET-3 (C6-3, C6-5 switch only, C6-29, C6-4).
    let mirrorsSelfView: Bool
    let dataSaverOn: Bool
    let shareDeviceAudioOn: Bool
    let quality: NativeMediaQualitySettings

    @MainActor
    static func read(defaults: UserDefaults) -> SettingsPreferenceValues {
        let voice = VoicePreferences.snapshot(defaults: defaults)
        return SettingsPreferenceValues(
            noiseSuppressionOn: SettingsPreferences.noiseSuppression(defaults: defaults),
            captionsOn: CaptionsPreference.isOn(defaults: defaults),
            showsChatPreviews: voice.showsChatPreviews,
            playsVoiceMessages: voice.playsVoiceMessages,
            voiceKind: voice.voiceKind,
            standardVoiceId: voice.standardVoiceId,
            alwaysShowControls: SettingsPreferences.alwaysShowControls(defaults: defaults),
            hapticsOn: SettingsPreferences.haptics(defaults: defaults),
            knockSoundOn: SettingsPreferences.knockSound(defaults: defaults),
            handSoundOn: SettingsPreferences.handSound(defaults: defaults),
            mirrorsSelfView: NativeVideoPreferences.mirrorsSelfView(defaults: defaults),
            dataSaverOn: NativeVideoPreferences.dataSaver(defaults: defaults),
            shareDeviceAudioOn: NativeVideoPreferences.shareDeviceAudio(defaults: defaults),
            quality: NativeMediaQualityPreferences.load(defaults: defaults)
        )
    }
}

// MARK: - Snapshots (S60 0.5; one stored property each)

/// Route name, inputs, the current input and Mic Mode come from the S30 `AudioRouteSnapshot` (CC4), which the pages
/// read directly from `AudioRouteOwner` (no copy here).
struct SettingsAudio: Equatable {
    let revision: Int
    let noiseSuppressionOn: Bool
    let noiseSuppression: SettingsCapability
    let noiseSuppressionReason: SettingsReason
    let speakerTest: SpeakerTestPhase
    let micTest: SettingsCapability
    let micTestReason: SettingsReason
    let canRecordMicTest: Bool
    let micPhase: MicTestPhase
    let isMuted: Bool
    /// 0 to 2, the test only (Q8); meaningful while `canRecordMicTest`.
    let testGain: Double

    static let empty = SettingsAudio(revision: 0, noiseSuppressionOn: true, noiseSuppression: SettingsCapability.available,
                                     noiseSuppressionReason: SettingsReason.none, speakerTest: SpeakerTestPhase.idle,
                                     micTest: SettingsCapability.available, micTestReason: SettingsReason.none,
                                     canRecordMicTest: false, micPhase: MicTestPhase.idle, isMuted: true, testGain: 1.0)
}

/// The Advanced page values (S60 0.5 `CameraLimitsModel`), for the camera and, with the same shape, the screen share:
/// raw values of `NativeMediaResolution`, `NativeCameraContentHint` / `NativeScreenShareContentHint` and
/// `NativeMediaDegradationPreference`, plus the options the device supports (D11) and the bitrate slider's range.
struct CameraLimitsModel: Equatable {
    let resolution: String
    let frameRate: Int
    let optimizeFor: String
    let underPressure: String
    let bitrateKbps: Int
    let resolutions: [String]
    let frameRates: [Int]
    let optimizeOptions: [String]
    let pressureOptions: [String]
    let minBitrateKbps: Int
    let maxBitrateKbps: Int
    let bitrateStepKbps: Int

    static let empty = CameraLimitsModel(resolution: "720p", frameRate: 30, optimizeFor: "motion", underPressure: "maintain-framerate",
                                         bitrateKbps: 1_650, resolutions: [], frameRates: [], optimizeOptions: [],
                                         pressureOptions: [], minBitrateKbps: 150, maxBitrateKbps: 6_000, bitrateStepKbps: 50)
}

/// The Video rows (SET-1 camera facing; SET-3 preview, mirror, quality, Data Saver, share quality). SET-6 adds the
/// effects availability.
struct SettingsVideo: Equatable {
    let revision: Int
    /// "front" or "back".
    let cameraFacing: String
    let canFlipCamera: Bool
    let flipReason: SettingsReason
    let isFlipInFlight: Bool
    /// Inline Video footer (iOS) or page snackbar (Android) until the next flip (D23).
    let flipFailed: Bool
    let isCameraOn: Bool
    let isAudioOnly: Bool
    /// C6-3 Mirror My Video (the preference; it applies to the front camera only).
    let mirrorsSelfView: Bool
    /// The picker's selection, a `NativeCameraQualityPreset` raw value (Auto, HD, Studio, Custom; D21).
    let cameraPreset: String
    /// What is sent: "data-saver" while Data Saver or the host's limit applies the ceiling, else `cameraPreset`
    /// (1 f: "Camera Quality value shows the effective preset").
    let effectiveCameraPreset: String
    let presets: [String]
    let qualityCappedByHost: Bool
    let custom: CameraLimitsModel
    /// C6-5: the switch value, the person's preference OR the system signal.
    let dataSaverOn: Bool
    /// The system signal holds Data Saver on: the switch is disabled with the reason.
    let systemDataSaverOn: Bool
    let screenSharePreset: String
    let screenSharePresets: [String]
    let screenShareCustom: CameraLimitsModel
    let showsScreenShareQuality: Bool
    /// "Changes apply to an active share right away."
    let isScreenSharing: Bool
    /// C6-29 (RECONCILE R43): the switch shows only while the S70 10 capability holds.
    let canShareDeviceAudio: Bool
    let shareDeviceAudioOn: Bool
    /// L6-3 / C6-8: the one `PreviewState` (RECONCILE R22); `published` while the meeting camera is on (the card shows
    /// the sent track).
    let preview: PreviewState
    let previewReason: SettingsReason
    /// Keys the card's renderer (a new local preview session or the published track).
    let previewSessionId: Int
    /// Start Preview is offered (off or unavailable, camera off, not Audio Only).
    let canStartPreview: Bool

    static let empty = SettingsVideo(revision: 0, cameraFacing: "front", canFlipCamera: false, flipReason: SettingsReason.none,
                                     isFlipInFlight: false, flipFailed: false, isCameraOn: false, isAudioOnly: false,
                                     mirrorsSelfView: true, cameraPreset: "auto", effectiveCameraPreset: "auto", presets: [],
                                     qualityCappedByHost: false, custom: CameraLimitsModel.empty, dataSaverOn: false,
                                     systemDataSaverOn: false, screenSharePreset: "auto", screenSharePresets: [],
                                     screenShareCustom: CameraLimitsModel.empty, showsScreenShareQuality: false,
                                     isScreenSharing: false, canShareDeviceAudio: false, shareDeviceAudioOn: false,
                                     preview: PreviewState.off, previewReason: SettingsReason.none, previewSessionId: 0,
                                     canStartPreview: false)
}

struct SettingsChat: Equatable {
    let revision: Int
    let captionsOn: Bool
    let liveNotes: LiveNotesState
    let showsChatPreviews: Bool
    let playsVoiceMessages: Bool
    /// The stored choice; the effective voice is personal only while it is ready (S40 Q12).
    let voiceKind: VoiceKind
    let effectiveVoiceKind: VoiceKind
    let canUsePersonalVoice: Bool
    let personalVoice: PersonalVoicePhase
    let personalVoiceReason: SettingsReason
    /// "" = Automatic (2 c, C6-22).
    let standardVoiceId: String
    /// The system voices for the current language, loaded by the Voice page from the platform speaker.
    let standardVoices: [VoiceOptionModel]
    let standardPreview: SpeakerTestPhase
    /// Preview plays through the call output (the core's speaker), so it exists only in a call with a core attached.
    let canPreviewStandardVoice: Bool

    static let empty = SettingsChat(revision: 0, captionsOn: false, liveNotes: LiveNotesState.off, showsChatPreviews: true,
                                    playsVoiceMessages: true, voiceKind: VoiceKind.system, effectiveVoiceKind: VoiceKind.system,
                                    canUsePersonalVoice: false, personalVoice: PersonalVoicePhase.unavailable,
                                    personalVoiceReason: SettingsReason.notInAppYet, standardVoiceId: "", standardVoices: [],
                                    standardPreview: SpeakerTestPhase.idle, canPreviewStandardVoice: false)
}

struct SettingsGeneral: Equatable {
    let revision: Int
    let scope: SettingsScope
    let isAttendee: Bool
    let showsHostSection: Bool
    let hostReason: SettingsReason
    let hostAlertSoundsAvailable: Bool
    let knockSoundOn: Bool
    let handSoundOn: Bool
    let alwaysShowControls: Bool
    /// iOS only (F00 8).
    let hapticsOn: Bool
    let connection: ConnectionQualityLabel
    let lowBandwidth: Bool
    let isRecovering: Bool
    /// S70 2 c: the iOS row value is the preference AND the granted permission.
    let messageNotificationsOn: Bool
    let notificationPermission: NotificationPermission
    /// Android: the ongoing-call channel is enabled (S70 1, 2).
    let callNotificationEnabled: Bool
    let linkVerification: LinkVerification
    /// About > Export Diagnostics (S70 15).
    let canExportDiagnostics: Bool

    static let empty = SettingsGeneral(revision: 0, scope: SettingsScope.call, isAttendee: false, showsHostSection: false,
                                       hostReason: SettingsReason.none, hostAlertSoundsAvailable: false, knockSoundOn: false,
                                       handSoundOn: false, alwaysShowControls: false, hapticsOn: true,
                                       connection: ConnectionQualityLabel.measuring, lowBandwidth: false, isRecovering: false,
                                       messageNotificationsOn: false, notificationPermission: NotificationPermission.notDetermined,
                                       callNotificationEnabled: true, linkVerification: LinkVerification.unknown,
                                       canExportDiagnostics: false)
}

struct SettingsAccount: Equatable {
    let revision: Int
    let savedDisplayName: String
    /// False for the session after an S50 Q14 `renameDisabled` refusal from either surface (RECONCILE R38), while
    /// reconnecting or offline, and for attendees.
    let canEditName: Bool
    let nameReason: SettingsReason
    let account: AccountKind
    let accountName: String
    let accountEmail: String
    /// apple, google, email
    let accountProvider: String
    /// Single flight, generation and room guard (C6-10).
    let signOutPending: Bool
    /// Picks the sign-out message (host controls are lost).
    let isHost: Bool

    static let empty = SettingsAccount(revision: 0, savedDisplayName: "", canEditName: false, nameReason: SettingsReason.none,
                                       account: AccountKind.none, accountName: "", accountEmail: "", accountProvider: "",
                                       signOutPending: false, isHost: false)
}

// MARK: - Inputs (pushed by the core; HD request B6-T2 R1)

/// What the core knows. Every capability that belongs to a later slice defaults to false, so its row stays hidden
/// until that slice turns it on (D11, R70-4).
struct SettingsInputs: Equatable {
    let callSession: Int
    let roomId: String
    let isJoined: Bool
    let isAttendee: Bool
    let isHost: Bool
    let isRecovering: Bool
    let isOffline: Bool
    let isMuted: Bool
    let isCameraOff: Bool
    let isAudioOnly: Bool
    let isFrontCamera: Bool
    let canFlipCamera: Bool
    let isFlipInFlight: Bool
    let flipFailed: Bool
    let liveNotes: LiveNotesState
    let connection: ConnectionQualityLabel
    let lowBandwidth: Bool
    let savedDisplayName: String
    let isRenameDisabled: Bool
    let account: AccountKind
    let accountName: String
    let accountEmail: String
    let accountProvider: String
    /// C6-6: false on both platforms until a WP3 capture path exists (Q8).
    let canRecordMicTest: Bool
    /// C6-1: the WebRTC client can replace the live microphone track (`WebRTCClient.supportsLiveNoiseSuppressionChange`).
    let noiseSuppressionLive: Bool
    /// C6-24: the core feeds the knock and hand switches into the S20 notice sound player.
    let hostAlertSoundsAvailable: Bool
    /// R44: Always Show Controls appears for attendees only when the attendee viewer auto-hides its chrome.
    let attendeeChromeAutoHides: Bool
    /// The core installed its command handler (speaker test, preview, sign-out all need it).
    let hasCore: Bool
    let canUsePersonalVoice: Bool
    let hasPersonalVoice: Bool
    let isStandardPreviewPlaying: Bool
    let messageNotificationsAvailable: Bool
    let messageNotificationsOn: Bool
    let notificationPermission: NotificationPermission
    let callNotificationStatusAvailable: Bool
    let callNotificationEnabled: Bool
    let linkVerificationAvailable: Bool
    let linkVerification: LinkVerification
    let canExportDiagnostics: Bool
    /// SET-3: Screen Share Quality shows where screen sharing exists (`MeetingState.isScreenShareSupported`).
    let isScreenShareSupported: Bool
    let isScreenSharing: Bool
    /// C6-4: the server's `setVideoQuality` low (the host limited video quality for this meeting).
    let qualityCappedByHost: Bool
    /// C6-5: iOS Low Data Mode or Android Data Saver (the core's monitor signal).
    let systemDataSaverOn: Bool
    /// C6-29 / S70 10 (RECONCILE R43): false until the screen-share owner publishes the capability.
    let canShareDeviceAudio: Bool
    /// D11: the device camera's largest capture height and frame rate (0 = unknown, every option listed).
    let cameraMaxHeight: Int
    let cameraMaxFrameRate: Int

    static func make(callSession: Int = 0, roomId: String = "", isJoined: Bool = false, isAttendee: Bool = false,
                     isHost: Bool = false, isRecovering: Bool = false, isOffline: Bool = false, isMuted: Bool = true,
                     isCameraOff: Bool = true, isAudioOnly: Bool = false, isFrontCamera: Bool = true,
                     canFlipCamera: Bool = false, isFlipInFlight: Bool = false, flipFailed: Bool = false,
                     liveNotes: LiveNotesState = LiveNotesState.off,
                     connection: ConnectionQualityLabel = ConnectionQualityLabel.measuring, lowBandwidth: Bool = false,
                     savedDisplayName: String = "", isRenameDisabled: Bool = false, account: AccountKind = AccountKind.none,
                     accountName: String = "", accountEmail: String = "", accountProvider: String = "",
                     canRecordMicTest: Bool = false, noiseSuppressionLive: Bool = false, hostAlertSoundsAvailable: Bool = false,
                     attendeeChromeAutoHides: Bool = false, hasCore: Bool = false, canUsePersonalVoice: Bool = false,
                     hasPersonalVoice: Bool = false, isStandardPreviewPlaying: Bool = false,
                     messageNotificationsAvailable: Bool = false, messageNotificationsOn: Bool = false,
                     notificationPermission: NotificationPermission = NotificationPermission.notDetermined,
                     callNotificationStatusAvailable: Bool = false, callNotificationEnabled: Bool = true,
                     linkVerificationAvailable: Bool = false, linkVerification: LinkVerification = LinkVerification.unknown,
                     isScreenShareSupported: Bool = false, isScreenSharing: Bool = false, qualityCappedByHost: Bool = false,
                     systemDataSaverOn: Bool = false, canShareDeviceAudio: Bool = false, cameraMaxHeight: Int = 0,
                     cameraMaxFrameRate: Int = 0, canExportDiagnostics: Bool = false) -> SettingsInputs {
        SettingsInputs(callSession: callSession, roomId: roomId, isJoined: isJoined, isAttendee: isAttendee, isHost: isHost,
                       isRecovering: isRecovering, isOffline: isOffline, isMuted: isMuted, isCameraOff: isCameraOff,
                       isAudioOnly: isAudioOnly, isFrontCamera: isFrontCamera, canFlipCamera: canFlipCamera,
                       isFlipInFlight: isFlipInFlight, flipFailed: flipFailed, liveNotes: liveNotes, connection: connection,
                       lowBandwidth: lowBandwidth, savedDisplayName: savedDisplayName, isRenameDisabled: isRenameDisabled,
                       account: account, accountName: accountName, accountEmail: accountEmail,
                       accountProvider: accountProvider, canRecordMicTest: canRecordMicTest,
                       noiseSuppressionLive: noiseSuppressionLive, hostAlertSoundsAvailable: hostAlertSoundsAvailable,
                       attendeeChromeAutoHides: attendeeChromeAutoHides, hasCore: hasCore,
                       canUsePersonalVoice: canUsePersonalVoice, hasPersonalVoice: hasPersonalVoice,
                       isStandardPreviewPlaying: isStandardPreviewPlaying,
                       messageNotificationsAvailable: messageNotificationsAvailable,
                       messageNotificationsOn: messageNotificationsOn, notificationPermission: notificationPermission,
                       callNotificationStatusAvailable: callNotificationStatusAvailable,
                       callNotificationEnabled: callNotificationEnabled, linkVerificationAvailable: linkVerificationAvailable,
                       linkVerification: linkVerification, canExportDiagnostics: canExportDiagnostics,
                       isScreenShareSupported: isScreenShareSupported, isScreenSharing: isScreenSharing,
                       qualityCappedByHost: qualityCappedByHost, systemDataSaverOn: systemDataSaverOn,
                       canShareDeviceAudio: canShareDeviceAudio, cameraMaxHeight: cameraMaxHeight,
                       cameraMaxFrameRate: cameraMaxFrameRate)
    }
}

// MARK: - Commands (S60 0.5 actions that reach the core)

enum SettingsCommandKind: String, CaseIterable, Equatable {
    /// `text` = `SettingsPreferenceID` raw value; the store is already written.
    case preferenceChanged
    /// C6-1: `flag` = on; one track replacement per change, the newest mute intent wins.
    case setNoiseSuppression
    /// C6-7: one test tone through the voice route.
    case playTestSound
    /// C6-6: the platform meter source starts and stops with the Microphone page.
    case startMicTest, stopMicTest
    /// C6-6 Record and Replay and Test Gain (`number`); only while `canRecordMicTest`.
    case recordMicSample, replayMicSample, setTestGain
    /// iOS Mic Mode (S30 CC11).
    case showSystemMicModes
    /// C6-2: `flag` = front.
    case setCameraFacing
    /// C6-22: `text` = the localized sample sentence, `flag` = start (false stops).
    case toggleVoicePreview
    /// C6-23 (gated by `canUsePersonalVoice`): the meeting microphone pauses for a take and its mute intent returns.
    case startVoiceSample, stopVoiceSample, playVoiceSample, createPersonalVoice, hearPersonalVoice, deletePersonalVoice
    /// C6-10: `generation` = the sign-out generation; the core calls `signOutFinished(generation:)` when done.
    case signOut
}

struct SettingsCommand: Equatable {
    let kind: SettingsCommandKind
    let text: String
    let flag: Bool
    let number: Double
    let generation: Int

    static func make(_ kind: SettingsCommandKind, text: String = "", flag: Bool = false, number: Double = 0.0,
                     generation: Int = 0) -> SettingsCommand {
        SettingsCommand(kind: kind, text: text, flag: flag, number: number, generation: generation)
    }
}

// MARK: - Row policy (S60 1 a, 1 c scope comment, 1 l7b; RECONCILE R26, R44)

/// The capabilities the row list depends on beyond scope, role and platform.
struct SettingsRowCapabilities: Equatable {
    let noiseSuppression: Bool
    let mirror: Bool
    let cameraQuality: Bool
    let screenShareQuality: Bool
    let dataSaver: Bool
    let effects: Bool
    let hostAlertSounds: Bool
    let messageNotifications: Bool
    let callNotificationStatus: Bool
    let linkVerification: Bool
    let exportDiagnostics: Bool
    let attendeeChromeAutoHides: Bool
    let hasAccountIdentity: Bool
    let isSignedIn: Bool

    static func make(noiseSuppression: Bool = true, mirror: Bool = false, cameraQuality: Bool = false,
                     screenShareQuality: Bool = false, dataSaver: Bool = false, effects: Bool = false,
                     hostAlertSounds: Bool = false, messageNotifications: Bool = false, callNotificationStatus: Bool = false,
                     linkVerification: Bool = false, exportDiagnostics: Bool = false, attendeeChromeAutoHides: Bool = false,
                     hasAccountIdentity: Bool = false, isSignedIn: Bool = false) -> SettingsRowCapabilities {
        SettingsRowCapabilities(noiseSuppression: noiseSuppression, mirror: mirror, cameraQuality: cameraQuality,
                                screenShareQuality: screenShareQuality, dataSaver: dataSaver, effects: effects,
                                hostAlertSounds: hostAlertSounds, messageNotifications: messageNotifications,
                                callNotificationStatus: callNotificationStatus, linkVerification: linkVerification,
                                exportDiagnostics: exportDiagnostics, attendeeChromeAutoHides: attendeeChromeAutoHides,
                                hasAccountIdentity: hasAccountIdentity, isSignedIn: isSignedIn)
    }
}

/// The one shared row list for every scope (unit tested on both platforms). Empty sections are dropped. In-call rows
/// (route, test sound, camera facing, share quality, effects, connection, the Account name and host rows) never
/// render in the app scope; the attendee filter keeps only Data Saver, the General rows that apply to a viewer and
/// About (R44).
enum SettingsRowPolicy {
    static func sections(scope: SettingsScope, isAttendee: Bool, isHost: Bool, platform: SettingsPlatform,
                         capabilities: SettingsRowCapabilities) -> [SettingsRowSection] {
        let inCall = scope == SettingsScope.call
        let attendee = inCall && isAttendee
        let participant = inCall && !isAttendee
        let android = platform == SettingsPlatform.android
        var result: [SettingsRowSection] = []

        var audio: [SettingsRowID] = []
        if participant {
            audio.append(SettingsRowID.output)
            audio.append(SettingsRowID.microphone)
        }
        if !attendee && capabilities.noiseSuppression { audio.append(SettingsRowID.noiseSuppression) }
        if participant { audio.append(SettingsRowID.testSound) }
        result = appended(result, SettingsSection.audio, audio)

        var video: [SettingsRowID] = []
        if participant { video.append(SettingsRowID.cameraFacing) }
        if !attendee && capabilities.mirror { video.append(SettingsRowID.mirror) }
        if !attendee && capabilities.cameraQuality { video.append(SettingsRowID.cameraQuality) }
        if participant && capabilities.screenShareQuality { video.append(SettingsRowID.screenShareQuality) }
        if capabilities.dataSaver { video.append(SettingsRowID.dataSaver) }
        if participant && capabilities.effects { video.append(SettingsRowID.effects) }
        result = appended(result, SettingsSection.video, video)

        var captions: [SettingsRowID] = []
        if !attendee {
            captions.append(SettingsRowID.captions)
            if android { captions.append(SettingsRowID.captionStyle) }
        }
        result = appended(result, SettingsSection.captions, captions)

        var chat: [SettingsRowID] = []
        if !attendee {
            chat.append(SettingsRowID.chatPreviews)
            chat.append(SettingsRowID.playVoiceMessages)
            chat.append(SettingsRowID.voiceMessages)
        }
        result = appended(result, SettingsSection.chat, chat)

        var host: [SettingsRowID] = []
        if participant && isHost {
            host.append(SettingsRowID.hostControls)
            if capabilities.hostAlertSounds {
                host.append(SettingsRowID.knockSound)
                host.append(SettingsRowID.handSound)
            }
        }
        result = appended(result, SettingsSection.host, host)

        var general: [SettingsRowID] = []
        if participant { general.append(SettingsRowID.connection) }
        if !attendee && capabilities.messageNotifications { general.append(SettingsRowID.messageNotifications) }
        if !attendee && android && capabilities.callNotificationStatus { general.append(SettingsRowID.callNotification) }
        if !attendee && android && capabilities.linkVerification { general.append(SettingsRowID.openLinks) }
        if !attendee || capabilities.attendeeChromeAutoHides { general.append(SettingsRowID.alwaysShowControls) }
        if !android { general.append(SettingsRowID.haptics) }
        result = appended(result, SettingsSection.general, general)

        var account: [SettingsRowID] = []
        if participant {
            account.append(SettingsRowID.name)
            if capabilities.hasAccountIdentity { account.append(SettingsRowID.identity) }
            if capabilities.isSignedIn { account.append(SettingsRowID.signOut) }
        }
        result = appended(result, SettingsSection.account, account)

        var about: [SettingsRowID] = [SettingsRowID.privacy]
        if capabilities.exportDiagnostics { about.append(SettingsRowID.exportDiagnostics) }
        about.append(SettingsRowID.version)
        result = appended(result, SettingsSection.about, about)
        return result
    }

    static func rows(_ sections: [SettingsRowSection]) -> [SettingsRowID] {
        var result: [SettingsRowID] = []
        for section in sections {
            for row in section.rows { result.append(row) }
        }
        return result
    }

    /// The list with the section added, or unchanged for an empty section (a returned copy, Skip Lite).
    private static func appended(_ result: [SettingsRowSection], _ section: SettingsSection,
                                 _ rows: [SettingsRowID]) -> [SettingsRowSection] {
        if rows.isEmpty { return result }
        var next = result
        next.append(SettingsRowSection(id: section.rawValue, section: section, rows: rows))
        return next
    }
}

// MARK: - Audio policies (SET-2: C6-1, C6-6, C6-7)

enum SettingsAudioPolicy {
    /// C6-1: "Applies the next time you join." only in a call whose client cannot replace the live track.
    static func noiseSuppressionReason(scope: SettingsScope, liveChangeSupported: Bool) -> SettingsReason {
        if scope == SettingsScope.call && !liveChangeSupported { return SettingsReason.appliesNextJoin }
        return SettingsReason.none
    }

    /// C6-6: a muted call shows "Unmute to test your microphone." instead of a meter (iOS tracks stay disabled and
    /// Android mutes the audio device module while muted).
    static func micTestReason(isMuted: Bool) -> SettingsReason {
        isMuted ? SettingsReason.unmuteToTest : SettingsReason.none
    }

    /// The flip row's reason: Audio Only blocks the camera (1 f).
    static func flipReason(isAudioOnly: Bool, isRecovering: Bool) -> SettingsReason {
        if isAudioOnly { return SettingsReason.audioOnly }
        if isRecovering { return SettingsReason.reconnecting }
        return SettingsReason.none
    }
}

/// L6-2 `LevelMeter`: 12 flat segments at 10 Hz while the Microphone page is visible (C6-6).
enum MicLevelPolicy {
    static let segmentCount = 12
    static let intervalMillis = 100.0
    /// The stats `audioLevel` is RMS derived (speech sits around 0.02 to 0.3), so the meter fills on a square-root
    /// curve and a normal voice reaches the middle segments.
    static func filledSegments(level: Double) -> Int {
        if level <= 0 { return 0 }
        let clamped = level >= 1 ? 1.0 : level
        let filled = Int(sqrt(clamped) * Double(segmentCount) + 0.5)
        if filled > segmentCount { return segmentCount }
        if filled < 0 { return 0 }
        return filled
    }
}

/// C6-7: the one test tone both clients synthesize and play through the voice route (iOS `AVAudioPlayer` on the call
/// session, Android `AudioTrack` with `USAGE_VOICE_COMMUNICATION`), tap only, never automatic.
enum TestTonePolicy {
    static let frequencyHz = 880.0
    static let durationMillis = 500.0
    static let sampleRate = 16000
    static let amplitude = 0.25
    static let fadeMillis = 15.0
    /// How long the row reads "Playing": the tone plus a short tail.
    static let playingMillis = 700.0

    static var sampleCount: Int {
        Int(Double(sampleRate) * durationMillis / 1000.0)
    }

    /// One sample in -1 to 1 with a short fade in and out, so the tone never clicks.
    static func sample(_ index: Int) -> Double {
        let count = sampleCount
        if index < 0 || index >= count { return 0 }
        let fadeSamples = Double(sampleRate) * fadeMillis / 1000.0
        var envelope = 1.0
        let position = Double(index)
        let remaining = Double(count - 1 - index)
        if position < fadeSamples { envelope = position / fadeSamples }
        if remaining < fadeSamples { envelope = remaining / fadeSamples }
        let phase = 2.0 * Double.pi * frequencyHz * position / Double(sampleRate)
        return amplitude * envelope * sin(phase)
    }
}

// MARK: - Video policies (SET-3: C6-3, C6-4, C6-5, C6-8, D11, D21)

enum SettingsVideoPolicy {
    /// The camera limits the encoder gets for these settings (the core's publish resolver without the transient
    /// system ceiling): the Debug readout and the fake owner's `setPublishCeiling` value (2 l4).
    static func publishCeiling(camera: NativeCameraQualitySettings, dataSaverOn: Bool,
                               qualityCappedByHost: Bool) -> NativeResolvedCameraPublishSettings {
        let capped = DataSaverPolicy.appliesPublishCeiling(dataSaverOn: dataSaverOn, qualityCappedByHost: qualityCappedByHost)
        return NativeMediaQualityPolicy.resolvedPublishCamera(camera, dataSaverOn: capped,
                                                              systemSendCeiling: NativeSystemSendCeiling.unconstrained)
    }

    /// The Camera Quality value: the data-saver tier while a ceiling applies, else the picker's selection.
    static func effectivePreset(selection: NativeCameraQualityPreset, dataSaverOn: Bool, qualityCappedByHost: Bool) -> String {
        if DataSaverPolicy.appliesPublishCeiling(dataSaverOn: dataSaverOn, qualityCappedByHost: qualityCappedByHost) {
            return NativeCameraQualityPreset.dataSaver.rawValue
        }
        return selection.rawValue
    }

    static func cameraLimits(_ camera: NativeCameraQualitySettings, capability: CameraCaptureCapability) -> CameraLimitsModel {
        var resolutions: [String] = []
        for option in NativeQualityOptions.cameraResolutions(capability: capability) { resolutions.append(option.rawValue) }
        var optimize: [String] = []
        for option in NativeQualityOptions.cameraOptimizeOptions { optimize.append(option.rawValue) }
        var pressure: [String] = []
        for option in NativeQualityOptions.cameraPressureOptions { pressure.append(option.rawValue) }
        let normalized = NativeMediaQualityPolicy.normalizedCamera(camera)
        return CameraLimitsModel(resolution: normalized.resolution.rawValue, frameRate: normalized.frameRate,
                                 optimizeFor: normalized.contentHint.rawValue,
                                 underPressure: normalized.degradationPreference.rawValue,
                                 bitrateKbps: normalized.maxBitrateKbps, resolutions: resolutions,
                                 frameRates: NativeQualityOptions.cameraFrameRates(capability: capability),
                                 optimizeOptions: optimize, pressureOptions: pressure,
                                 minBitrateKbps: NativeQualityOptions.cameraBitrateMinKbps,
                                 maxBitrateKbps: NativeQualityOptions.cameraBitrateMaxKbps,
                                 bitrateStepKbps: NativeQualityOptions.cameraBitrateStepKbps)
    }

    static func screenShareLimits(_ share: NativeScreenShareQualitySettings) -> CameraLimitsModel {
        var resolutions: [String] = []
        for option in NativeQualityOptions.screenShareResolutions { resolutions.append(option.rawValue) }
        var optimize: [String] = []
        for option in NativeQualityOptions.screenShareOptimizeOptions { optimize.append(option.rawValue) }
        var pressure: [String] = []
        for option in NativeQualityOptions.screenSharePressureOptions { pressure.append(option.rawValue) }
        let normalized = NativeMediaQualityPolicy.normalizedScreenShare(share)
        return CameraLimitsModel(resolution: normalized.resolution.rawValue, frameRate: normalized.frameRate,
                                 optimizeFor: normalized.contentHint.rawValue,
                                 underPressure: normalized.degradationPreference.rawValue,
                                 bitrateKbps: normalized.maxBitrateKbps, resolutions: resolutions,
                                 frameRates: NativeMediaQualityPolicy.screenShareFrameRateOptions,
                                 optimizeOptions: optimize, pressureOptions: pressure,
                                 minBitrateKbps: NativeQualityOptions.screenBitrateMinKbps,
                                 maxBitrateKbps: NativeQualityOptions.screenBitrateMaxKbps,
                                 bitrateStepKbps: NativeQualityOptions.screenBitrateStepKbps)
    }
}

/// What the WP3 preview owner reports to Settings (S60 C6-8): its one `PreviewState`, the session that keys the card's
/// renderer, the interruption reason, and whether the running capture is the Settings preview.
struct SettingsPreviewReading: Equatable {
    let state: PreviewState
    let sessionId: Int
    let interruption: PreviewInterruption
    let isScoped: Bool

    static let off = SettingsPreviewReading(state: PreviewState.off, sessionId: 0, interruption: PreviewInterruption.none,
                                            isScoped: false)
}

/// L6-3 / C6-8 card rules (pure, unit tested on both platforms).
enum SettingsPreviewPolicy {
    /// The capture stops after the card stays off screen this long (C6-8).
    static let offScreenStopMillis = 30_000.0

    /// The card's state: off outside a participant call and in Audio Only; `published` while the meeting camera is on
    /// (the card shows the sent track); the Settings preview's own state while it runs; `blocked` after a denied
    /// camera permission; else off.
    static func state(isParticipantInCall: Bool, isAudioOnly: Bool, isCameraOn: Bool, reading: SettingsPreviewReading,
                      permissionBlocked: Bool) -> PreviewState {
        if !isParticipantInCall || isAudioOnly { return PreviewState.off }
        if isCameraOn { return PreviewState.published }
        if reading.isScoped {
            if reading.state == PreviewState.published { return PreviewState.off }
            return reading.state
        }
        if permissionBlocked { return PreviewState.blocked }
        return PreviewState.off
    }

    /// The card's reason: Audio Only, the camera permission, or why the system paused the camera (read as the card's
    /// accessibility value, 1 f).
    static func reason(state: PreviewState, interruption: PreviewInterruption, isAudioOnly: Bool) -> SettingsReason {
        if isAudioOnly { return SettingsReason.audioOnly }
        if state == PreviewState.blocked { return SettingsReason.permissionDenied }
        if state != PreviewState.interrupted { return SettingsReason.none }
        switch interruption {
        case .multipleForegroundApps: return SettingsReason.cameraMultitasking
        case .background: return SettingsReason.cameraInBackground
        case .none, .inUseByAnotherClient, .cameraError: return SettingsReason.cameraInUse
        }
    }

    /// Start Preview is offered while the card is off or the camera was unavailable; never while interrupted (1 l11),
    /// starting, live, published or blocked (blocked offers Open Settings instead).
    static func canStart(state: PreviewState, isParticipantInCall: Bool, isAudioOnly: Bool) -> Bool {
        isParticipantInCall && !isAudioOnly && (state == PreviewState.off || state == PreviewState.unavailable)
    }

    /// Stop Preview is offered while the Settings preview runs (starting, live or interrupted).
    static func canStop(state: PreviewState) -> Bool {
        state == PreviewState.starting || state == PreviewState.live || state == PreviewState.interrupted
    }
}

/// The presenter's door to the one WP3 preview owner (RECONCILE R22). `live()` drives `LocalPreviewController.shared`
/// and the camera permission provider; the fake WP3 owner (`SettingsRecordingCore`) replaces every closure, so tests
/// and fixtures never touch a camera.
@MainActor
final class SettingsPreviewHooks {
    var start: (LocalCameraFacing) -> Void = { _ in }
    var stop: () -> Void = {}
    var read: () -> SettingsPreviewReading = { SettingsPreviewReading.off }
    /// Installs (or, with nil, removes) the owner's change callback for the presenter.
    var observe: ((() -> Void)?) -> Void = { _ in }
    var setMirror: (Bool) -> Void = { _ in }
    var cameraPermission: () -> MediaPermissionState = { MediaPermissionState.granted }
    /// Android may ask again after a denial while the system allows it (S10 7 d); iOS asks once.
    var canAskCameraAgain: () -> Bool = { false }
    var requestCameraPermission: (@escaping (Bool) -> Void) -> Void = { completion in completion(true) }
    var openSystemSettings: () -> Void = {}

    init() {}

    static func live() -> SettingsPreviewHooks {
        let hooks = SettingsPreviewHooks()
        hooks.start = { facing in
            LocalPreviewController.shared.startScopedPreview(facing: facing)
        }
        hooks.stop = {
            LocalPreviewController.shared.stopScopedPreview()
        }
        hooks.read = {
            let controller = LocalPreviewController.shared
            return SettingsPreviewReading(state: controller.state, sessionId: controller.sessionId,
                                          interruption: controller.interruption, isScoped: controller.isScopedPreviewActive)
        }
        hooks.observe = { callback in
            LocalPreviewController.shared.onScopedPreviewChange = callback
        }
        hooks.setMirror = { on in
            LocalPreviewController.shared.setMirrorPreference(on)
        }
        hooks.cameraPermission = {
            MediaPermissionStatusProvider.status(LobbyMediaKind.camera)
        }
        hooks.canAskCameraAgain = {
            MediaPermissionStatusProvider.canAskAgain(LobbyMediaKind.camera)
        }
        hooks.requestCameraPermission = { completion in
            MediaPermissionStatusProvider.request(LobbyMediaKind.camera, completion: completion)
        }
        hooks.openSystemSettings = {
            MediaPermissionStatusProvider.openSystemSettings()
        }
        return hooks
    }
}

// MARK: - Account policies (C6-10, RECONCILE R38)

enum SettingsNamePolicy {
    /// The status under the Name field: Saving, the mapped refusal, Saved (after an edit that reached the server), or
    /// nothing.
    static func status(isSaving: Bool, refusal: String, draft: String, saved: String, hasEdited: Bool) -> NameSavePhase {
        if isSaving { return NameSavePhase.saving }
        if !refusal.isEmpty { return NameSavePhase.failed }
        let normalizedSaved = NativeDisplayNameNormalizer.normalize(saved)
        if hasEdited && !normalizedSaved.isEmpty && NativeDisplayNameNormalizer.normalize(draft) == normalizedSaved {
            return NameSavePhase.saved
        }
        return NameSavePhase.idle
    }

    /// "Reconnect before updating your name." while recovering or offline (1 f).
    static func reason(isRecovering: Bool, isOffline: Bool) -> SettingsReason {
        (isRecovering || isOffline) ? SettingsReason.reconnecting : SettingsReason.none
    }

    static func canEdit(isJoined: Bool, isAttendee: Bool, isRecovering: Bool, isOffline: Bool, isRenameDisabled: Bool) -> Bool {
        isJoined && !isAttendee && !isRecovering && !isOffline && !isRenameDisabled
    }
}

/// C6-10: the sign-out single flight's completion guard, moved here from the legacy Settings sheet (SSV:76-86; HD
/// request B6-T2 R7 deletes the old copy). A completion applies only for the current generation and room.
enum SettingsSignOutCompletionPolicy {
    static func shouldApply(
        generation: Int,
        currentGeneration: Int,
        actionRoomId: String,
        currentRoomId: String
    ) -> Bool {
        generation == currentGeneration &&
            NativeRoomIdNormalizer.matches(actionRoomId, currentRoomId)
    }
}

// MARK: - Voice recorder policy (C6-23, L6-13)

enum VoiceRecorderPolicy {
    static let minimumSeconds = 60
    static let maximumSeconds = 120
    /// The remaining-time line is a polite live region updated every 10 s, not every second (2 i).
    static let announcementIntervalSeconds = 10

    static func secondsLeftToMinimum(elapsedSeconds: Int) -> Int {
        let left = minimumSeconds - elapsedSeconds
        return left > 0 ? left : 0
    }

    static func canCreate(elapsedSeconds: Int, consent: Bool) -> Bool {
        elapsedSeconds >= minimumSeconds && consent
    }

    static func reachedCap(elapsedSeconds: Int) -> Bool {
        elapsedSeconds >= maximumSeconds
    }

    static func shouldAnnounce(secondsLeft: Int) -> Bool {
        secondsLeft > 0 && secondsLeft % announcementIntervalSeconds == 0
    }
}

// MARK: - Hot leaves

/// L6-2: the mic level, read only by the meter leaf. Publishes only when the filled segment count changes, so 10 Hz
/// samples never invalidate more than one leaf (S60 2 k).
@MainActor
@Observable
final class MicLevelMeter {
    private(set) var segments: Int = 0
    @ObservationIgnored private(set) var sampleCount = 0

    init() {}

    func update(_ level: Double) {
        sampleCount += 1
        let next = MicLevelPolicy.filledSegments(level: level)
        if next != segments { segments = next }
    }

    func reset() {
        if segments != 0 { segments = 0 }
    }
}

/// L6-13 / C6-23: the recorder's ticking parts, read only by the recorder leaf views.
@MainActor
@Observable
final class VoiceRecorderModel {
    private(set) var elapsedSeconds: Int = 0
    private(set) var segments: Int = 0
    private(set) var consent: Bool = false

    init() {}

    var secondsLeft: Int { VoiceRecorderPolicy.secondsLeftToMinimum(elapsedSeconds: elapsedSeconds) }
    var canCreate: Bool { VoiceRecorderPolicy.canCreate(elapsedSeconds: elapsedSeconds, consent: consent) }

    func progress(elapsedSeconds: Int, level: Double) {
        if self.elapsedSeconds != elapsedSeconds { self.elapsedSeconds = elapsedSeconds }
        let next = MicLevelPolicy.filledSegments(level: level)
        if next != segments { segments = next }
    }

    func setConsent(_ on: Bool) {
        if consent != on { consent = on }
    }

    func reset() {
        if elapsedSeconds != 0 { elapsedSeconds = 0 }
        if segments != 0 { segments = 0 }
        if consent { consent = false }
    }
}

// MARK: - Presenter

@MainActor
@Observable
final class SettingsPresenter {
    private(set) var audio: SettingsAudio = SettingsAudio.empty
    private(set) var video: SettingsVideo = SettingsVideo.empty
    private(set) var chat: SettingsChat = SettingsChat.empty
    private(set) var general: SettingsGeneral = SettingsGeneral.empty
    private(set) var account: SettingsAccount = SettingsAccount.empty
    /// The sections and rows to draw (`SettingsRowPolicy`); only the root list reads it.
    private(set) var sections: [SettingsRowSection] = []

    let micLevel = MicLevelMeter()
    let recorder = VoiceRecorderModel()
    /// C6-9: the Connection page's details (1 Hz while the page is visible); the core installs `stats.source`.
    let stats = ConnectionStatsModel()
    let scope: SettingsScope
    let platform: SettingsPlatform

    /// Core only: each intent reaches the existing implementation (HD request B6-T2 R1). Never called from `apply`.
    @ObservationIgnored var onCommand: ((SettingsCommand) -> Void)? = nil
    /// C6-10: the core's one rename intent (`MeetingViewModel.displayNameEditor`). `weak`: Kotlin has no unowned.
    @ObservationIgnored weak var nameEditor: DisplayNameEditor? = nil
    /// C6-6: the sender's media-source audio level, 0 to 1 (`WebRTCClient.sampleLocalMicrophoneLevel()`); polled at
    /// 10 Hz only while the Microphone page is visible and the mic is unmuted.
    @ObservationIgnored var micLevelSource: (() -> Double)? = nil
    /// The single routing authority (S30 CC4); tests substitute their own.
    @ObservationIgnored var routeOwner: AudioRouteOwner = AudioRouteOwner.shared
    /// C6-8 (RECONCILE R22): the one WP3 preview owner; the fake WP3 owner replaces it.
    @ObservationIgnored var previewHooks: SettingsPreviewHooks = SettingsPreviewHooks.live()
    /// The preview card may bind the live media client's sent track (production). The fake WP3 owner turns it off, so
    /// a fixture or a test never reaches the media client (the card draws its dark surface instead).
    @ObservationIgnored var usesLiveRenderers = true
    @ObservationIgnored var defaults: UserDefaults
    /// Test seam (milliseconds).
    @ObservationIgnored var sleep: (Double) async -> Void = { millis in
        try? await Task.sleep(nanoseconds: UInt64(millis * 1_000_000.0))
    }

    @ObservationIgnored private(set) var inputs: SettingsInputs = SettingsInputs.make()
    @ObservationIgnored private var prefs: SettingsPreferenceValues
    @ObservationIgnored private var standardVoices: [VoiceOptionModel] = []
    @ObservationIgnored private var speakerTest: SpeakerTestPhase = SpeakerTestPhase.idle
    @ObservationIgnored private var speakerTestToken = 0
    @ObservationIgnored private var micPhase: MicTestPhase = MicTestPhase.idle
    @ObservationIgnored private var micRunToken = 0
    @ObservationIgnored private var micRunning = false
    @ObservationIgnored private var testGain = 1.0
    @ObservationIgnored private var signOutPending = false
    @ObservationIgnored private var signOutGeneration = 0
    @ObservationIgnored private var signOutRoomId = ""
    @ObservationIgnored private var personalVoice: PersonalVoicePhase = PersonalVoicePhase.unavailable
    @ObservationIgnored private var previewReading: SettingsPreviewReading = SettingsPreviewReading.off
    @ObservationIgnored private var previewPermissionBlocked = false
    @ObservationIgnored private var isPreviewCardOnScreen = false
    @ObservationIgnored private var previewOffScreenToken = 0

    // Debug readouts and tests (L6-12: speakerTest.count, micTest.phase, voicePreview.count, wp3.calls).
    @ObservationIgnored private(set) var speakerTestCount = 0
    @ObservationIgnored private(set) var micTestSubscribeCount = 0
    @ObservationIgnored private(set) var micTestStopCount = 0
    @ObservationIgnored private(set) var voicePreviewCount = 0
    @ObservationIgnored private(set) var noiseSuppressionChangeCount = 0
    @ObservationIgnored private(set) var voiceSampleCount = 0
    @ObservationIgnored private(set) var dispatchedKinds: [String] = []
    @ObservationIgnored private(set) var applyCount = 0
    /// SET-3 readouts (L6-12 `wp3.calls` `previewStart`, `previewStop`; 2 l4 `setPublishCeiling`).
    @ObservationIgnored private(set) var previewStartCount = 0
    @ObservationIgnored private(set) var previewStopCount = 0
    @ObservationIgnored private(set) var publishCeilingChangeCount = 0
    /// The Name field changed during this presentation, so "Saved" may show once the save lands (read by the status
    /// leaf when the editor's saving state changes).
    @ObservationIgnored private(set) var hasEditedName = false

    init(scope: SettingsScope = SettingsScope.call, platform: SettingsPlatform = SettingsPlatform.current,
         defaults: UserDefaults = UserDefaults.standard) {
        self.scope = scope
        self.platform = platform
        self.defaults = defaults
        self.prefs = SettingsPreferenceValues.read(defaults: defaults)
        rebuild()
    }

    // MARK: Inputs

    /// Core only. A new call session cancels the speaker test, the mic test and a pending sign-out.
    func apply(_ next: SettingsInputs) {
        applyCount += 1
        guard next != inputs else { return }
        let previous = inputs
        inputs = next
        if previous.callSession != next.callSession {
            resetSession()
        }
        // C6-8: the meeting camera took over (the clients already released the preview), Audio Only blocks the camera,
        // or the person became an attendee: a running Settings preview stops.
        if previewReading.isScoped && (!next.isCameraOff || next.isAudioOnly || next.isAttendee) {
            stopPreview()
        }
        stats.setFrozen(next.isRecovering || next.isOffline)
        if !next.canUsePersonalVoice {
            personalVoice = PersonalVoicePhase.unavailable
        } else if personalVoice == PersonalVoicePhase.unavailable {
            personalVoice = next.hasPersonalVoice ? PersonalVoicePhase.ready : PersonalVoicePhase.none
        }
        if next.isMuted && micRunning && micPhase != MicTestPhase.idle {
            micLevel.reset()
            micPhase = MicTestPhase.idle
        }
        rebuild()
    }

    /// Re-reads every store (the panel opened, or another surface such as More's captions toggle wrote one).
    func refreshPreferences() {
        let next = SettingsPreferenceValues.read(defaults: defaults)
        guard next != prefs else { return }
        prefs = next
        rebuild()
    }

    /// The panel or the app-scope page appeared (once per presentation, task scoped on iOS, a DisposableEffect on
    /// Android).
    func panelDidOpen() {
        hasEditedName = false
        refreshPreferences()
        nameEditor?.syncFromServerIfIdle()
        if scope == SettingsScope.call {
            previewHooks.observe({ [weak self] in self?.previewChanged() })
            previewHooks.setMirror(prefs.mirrorsSelfView)
            previewChanged()
        }
    }

    /// The panel closed: the pending name saves now (C6-10), a mic test still running stops and so does the Settings
    /// preview (C6-8: one `previewStop` on close, 1 l12).
    func panelDidClose() {
        nameEditor?.flush()
        stopMicTest()
        if scope == SettingsScope.call {
            stopPreview()
            isPreviewCardOnScreen = false
            previewOffScreenToken += 1
            previewHooks.observe(nil)
        }
    }

    // MARK: Audio (SET-2)

    /// C6-1: the store is written in both scopes; in a call the core replaces the live microphone track once.
    func setNoiseSuppression(_ on: Bool) {
        guard audio.noiseSuppression == SettingsCapability.available, prefs.noiseSuppressionOn != on else { return }
        SettingsPreferences.setNoiseSuppression(on, defaults: defaults)
        noiseSuppressionChangeCount += 1
        reloadPreferences()
        if scope == SettingsScope.call {
            dispatch(SettingsCommand.make(SettingsCommandKind.setNoiseSuppression, flag: on))
        }
    }

    /// C6-7: one tone per tap; "Playing" for the tone's length; never while one plays.
    @discardableResult
    func playTestSound() -> ControlTapResult {
        guard scope == SettingsScope.call, inputs.hasCore, speakerTest == SpeakerTestPhase.idle else {
            return ControlTapResult.ignored
        }
        speakerTestCount += 1
        speakerTest = SpeakerTestPhase.playing
        speakerTestToken += 1
        let token = speakerTestToken
        rebuildAudio()
        dispatch(SettingsCommand.make(SettingsCommandKind.playTestSound))
        let pause = sleep
        Task { @MainActor [weak self] in
            await pause(TestTonePolicy.playingMillis)
            guard let strong = self, strong.speakerTestToken == token else { return }
            strong.speakerTest = SpeakerTestPhase.idle
            strong.rebuildAudio()
        }
        return ControlTapResult.dispatched
    }

    /// S30 CC4: the Android Audio output page (and the R70-2 Bluetooth access row) through the route owner.
    @discardableResult
    func requestRoute(id: String) -> ControlTapResult {
        guard scope == SettingsScope.call else { return ControlTapResult.ignored }
        let route = routeOwner.route
        if id == route.currentId || (route.phase == RouteSwitchPhase.switching && id == route.pendingId) {
            return ControlTapResult.ignored
        }
        routeOwner.requestRoute(id: id)
        return ControlTapResult.dispatched
    }

    /// S30 CC4: the iOS microphone choice.
    func requestInput(id: String) {
        guard scope == SettingsScope.call, id != routeOwner.route.currentInputId else { return }
        routeOwner.requestInput(id: id)
    }

    func showSystemMicModes() {
        guard scope == SettingsScope.call else { return }
        dispatch(SettingsCommand.make(SettingsCommandKind.showSystemMicModes))
    }

    /// C6-6: starts the 10 Hz meter for the Microphone page. Idempotent (one subscription per page lifetime).
    func startMicTest() {
        guard scope == SettingsScope.call, !micRunning else { return }
        micRunning = true
        micRunToken += 1
        let token = micRunToken
        micTestSubscribeCount += 1
        micPhase = inputs.isMuted ? MicTestPhase.idle : MicTestPhase.starting
        rebuildAudio()
        dispatch(SettingsCommand.make(SettingsCommandKind.startMicTest))
        let pause = sleep
        Task { @MainActor [weak self] in
            while true {
                guard let strong = self, strong.micRunning, strong.micRunToken == token else { return }
                strong.micTick()
                await pause(MicLevelPolicy.intervalMillis)
            }
        }
    }

    /// Leaving the page (Back, panel close) stops the meter; the level returns to zero.
    func stopMicTest() {
        guard micRunning else { return }
        micRunning = false
        micRunToken += 1
        micLevel.reset()
        micPhase = MicTestPhase.idle
        micTestStopCount += 1
        rebuildAudio()
        dispatch(SettingsCommand.make(SettingsCommandKind.stopMicTest))
    }

    /// iOS `.task { await settings.runMicTest() }`: runs for the page's lifetime and stops on cancellation, never from
    /// appearance callbacks (AGENTS.md "Appearance-Callback Render Loop"). Android uses `startMicTest()` and
    /// `stopMicTest()` from a DisposableEffect instead.
    func runMicTest() async {
        startMicTest()
        let token = micRunToken
        while !Task.isCancelled && micRunning && micRunToken == token {
            await sleep(250.0)
        }
        if micRunToken == token { stopMicTest() }
    }

    func recordMicSample() {
        guard audio.canRecordMicTest, !inputs.isMuted else { return }
        micPhase = MicTestPhase.recording
        rebuildAudio()
        dispatch(SettingsCommand.make(SettingsCommandKind.recordMicSample))
    }

    func replayMicSample() {
        guard audio.canRecordMicTest else { return }
        micPhase = MicTestPhase.replaying
        rebuildAudio()
        dispatch(SettingsCommand.make(SettingsCommandKind.replayMicSample))
    }

    /// The core reports the end of a 5 s capture or of the replay.
    func micSampleFinished() {
        guard micPhase == MicTestPhase.recording || micPhase == MicTestPhase.replaying else { return }
        micPhase = micRunning && !inputs.isMuted ? MicTestPhase.metering : MicTestPhase.idle
        rebuildAudio()
    }

    func setTestGain(_ value: Double) {
        guard audio.canRecordMicTest else { return }
        let clamped = value < 0 ? 0.0 : (value > 2 ? 2.0 : value)
        guard clamped != testGain else { return }
        testGain = clamped
        rebuildAudio()
        dispatch(SettingsCommand.make(SettingsCommandKind.setTestGain, number: clamped))
    }

    // MARK: Video (SET-1 camera row)

    /// C6-2 / R13: dispatched only for a change the gate allows; Android plays `selectionChanged` on `.dispatched`.
    @discardableResult
    func setCameraFacing(front: Bool) -> ControlTapResult {
        guard scope == SettingsScope.call, video.canFlipCamera, !video.isFlipInFlight else { return ControlTapResult.ignored }
        let isFront = video.cameraFacing == "front"
        guard isFront != front else { return ControlTapResult.ignored }
        dispatch(SettingsCommand.make(SettingsCommandKind.setCameraFacing, flag: front))
        return ControlTapResult.dispatched
    }

    // MARK: Video (SET-3: C6-3, C6-4, C6-5, C6-8, C6-29)

    /// C6-3: the store, the renderers' observed value and the preview owner; the core refreshes the stage self view.
    func setMirrorsSelfView(_ on: Bool) {
        guard prefs.mirrorsSelfView != on else { return }
        NativeVideoPreferences.setMirrorsSelfView(on, defaults: defaults)
        LocalVideoMirrorPreference.shared.update(on)
        previewHooks.setMirror(on)
        preferenceWritten(SettingsPreferenceID.mirror)
    }

    /// C6-5: disabled (and on) while the system signal holds it; the core re-runs the publish resolver and the
    /// receive policy.
    func setDataSaver(_ on: Bool) {
        guard !inputs.systemDataSaverOn, prefs.dataSaverOn != on else { return }
        NativeVideoPreferences.setDataSaver(on, defaults: defaults)
        publishCeilingChangeCount += 1
        preferenceWritten(SettingsPreferenceID.dataSaver)
    }

    /// C6-4: a preset is an encoder ceiling (`NativeMediaQualityPolicy.cameraPreset`); disabled while Data Saver is on.
    /// Returns `.dispatched` for a change (Android plays `selectionChanged` then, 2 h).
    @discardableResult
    func setCameraPreset(_ rawValue: String) -> ControlTapResult {
        guard !video.dataSaverOn, video.presets.contains(rawValue),
              let preset = NativeCameraQualityPreset(rawValue: rawValue) else { return ControlTapResult.ignored }
        let current = prefs.quality.camera
        if preset == NativeQualityOptions.cameraSelection(current.preset) && preset != NativeCameraQualityPreset.custom {
            return ControlTapResult.ignored
        }
        if preset == NativeCameraQualityPreset.custom && current.preset == NativeCameraQualityPreset.custom {
            return ControlTapResult.ignored
        }
        saveCamera(NativeMediaQualityPolicy.cameraPreset(preset, current: current))
        return ControlTapResult.dispatched
    }

    /// Advanced (2 c): any change makes the preset Custom; options are limited to what the device supports (D11).
    func setCameraResolution(_ rawValue: String) {
        guard video.custom.resolutions.contains(rawValue), let resolution = NativeMediaResolution(rawValue: rawValue) else { return }
        var camera = prefs.quality.camera
        guard camera.resolution != resolution else { return }
        camera.resolution = resolution
        camera.preset = NativeCameraQualityPreset.custom
        saveCamera(camera)
    }

    func setCameraFrameRate(_ frameRate: Int) {
        guard video.custom.frameRates.contains(frameRate) else { return }
        var camera = prefs.quality.camera
        guard camera.frameRate != frameRate else { return }
        camera.frameRate = frameRate
        camera.preset = NativeCameraQualityPreset.custom
        saveCamera(camera)
    }

    func setCameraOptimizeFor(_ rawValue: String) {
        guard let hint = NativeCameraContentHint(rawValue: rawValue) else { return }
        var camera = prefs.quality.camera
        guard camera.contentHint != hint else { return }
        camera.contentHint = hint
        camera.preset = NativeCameraQualityPreset.custom
        saveCamera(camera)
    }

    func setCameraUnderPressure(_ rawValue: String) {
        guard let preference = NativeMediaDegradationPreference(rawValue: rawValue) else { return }
        var camera = prefs.quality.camera
        guard camera.degradationPreference != preference else { return }
        camera.degradationPreference = preference
        camera.preset = NativeCameraQualityPreset.custom
        saveCamera(camera)
    }

    func setCameraBitrate(_ kbps: Int) {
        let snapped = NativeQualityOptions.snappedBitrate(kbps, minimum: NativeQualityOptions.cameraBitrateMinKbps,
                                                          maximum: NativeQualityOptions.cameraBitrateMaxKbps,
                                                          step: NativeQualityOptions.cameraBitrateStepKbps)
        var camera = prefs.quality.camera
        guard camera.maxBitrateKbps != snapped else { return }
        camera.maxBitrateKbps = snapped
        camera.preset = NativeCameraQualityPreset.custom
        saveCamera(camera)
    }

    /// "Restore Recommended Settings": Auto.
    func restoreRecommendedQuality() {
        let auto = NativeMediaQualityPolicy.defaultSettings.camera
        guard prefs.quality.camera != auto else { return }
        saveCamera(auto)
    }

    @discardableResult
    func setScreenSharePreset(_ rawValue: String) -> ControlTapResult {
        guard video.showsScreenShareQuality, let preset = NativeScreenShareQualityPreset(rawValue: rawValue) else {
            return ControlTapResult.ignored
        }
        let current = prefs.quality.screenShare
        guard current.preset != preset else { return ControlTapResult.ignored }
        saveScreenShare(NativeMediaQualityPolicy.screenSharePreset(preset, current: current))
        return ControlTapResult.dispatched
    }

    func setScreenShareResolution(_ rawValue: String) {
        guard let resolution = NativeMediaResolution(rawValue: rawValue) else { return }
        var share = prefs.quality.screenShare
        guard share.resolution != resolution else { return }
        share.resolution = resolution
        share.preset = NativeScreenShareQualityPreset.custom
        saveScreenShare(share)
    }

    func setScreenShareFrameRate(_ frameRate: Int) {
        guard NativeMediaQualityPolicy.screenShareFrameRateOptions.contains(frameRate) else { return }
        var share = prefs.quality.screenShare
        guard share.frameRate != frameRate else { return }
        share.frameRate = frameRate
        share.preset = NativeScreenShareQualityPreset.custom
        saveScreenShare(share)
    }

    func setScreenShareOptimizeFor(_ rawValue: String) {
        guard let hint = NativeScreenShareContentHint(rawValue: rawValue) else { return }
        var share = prefs.quality.screenShare
        guard share.contentHint != hint else { return }
        share.contentHint = hint
        share.preset = NativeScreenShareQualityPreset.custom
        saveScreenShare(share)
    }

    func setScreenShareUnderPressure(_ rawValue: String) {
        guard let preference = NativeMediaDegradationPreference(rawValue: rawValue) else { return }
        var share = prefs.quality.screenShare
        guard share.degradationPreference != preference else { return }
        share.degradationPreference = preference
        share.preset = NativeScreenShareQualityPreset.custom
        saveScreenShare(share)
    }

    func setScreenShareBitrate(_ kbps: Int) {
        let snapped = NativeQualityOptions.snappedBitrate(kbps, minimum: NativeQualityOptions.screenBitrateMinKbps,
                                                          maximum: NativeQualityOptions.screenBitrateMaxKbps,
                                                          step: NativeQualityOptions.screenBitrateStepKbps)
        var share = prefs.quality.screenShare
        guard share.maxBitrateKbps != snapped else { return }
        share.maxBitrateKbps = snapped
        share.preset = NativeScreenShareQualityPreset.custom
        saveScreenShare(share)
    }

    func restoreRecommendedScreenShare() {
        let auto = NativeMediaQualityPolicy.defaultSettings.screenShare
        guard prefs.quality.screenShare != auto else { return }
        saveScreenShare(auto)
    }

    /// C6-29: only while the capability holds (the switch is hidden otherwise).
    func setShareDeviceAudio(_ on: Bool) {
        guard video.canShareDeviceAudio, prefs.shareDeviceAudioOn != on else { return }
        NativeVideoPreferences.setShareDeviceAudio(on, defaults: defaults)
        preferenceWritten(SettingsPreferenceID.shareDeviceAudio)
    }

    /// The camera limits the encoder gets now (Debug readout; the fake owner's `setPublishCeiling` value).
    func publishCeiling() -> NativeResolvedCameraPublishSettings {
        SettingsVideoPolicy.publishCeiling(camera: prefs.quality.camera, dataSaverOn: video.dataSaverOn,
                                           qualityCappedByHost: inputs.qualityCappedByHost)
    }

    // MARK: Preview (C6-8, L6-3)

    /// Start Preview: local only, never handed to a producer. Asks for the camera once when the system has not yet;
    /// a denied permission shows "Camera access is off" with Open Settings.
    func startPreview() {
        guard scope == SettingsScope.call, video.canStartPreview else { return }
        let permission = previewHooks.cameraPermission()
        let asksAgain = permission == MediaPermissionState.denied && previewHooks.canAskCameraAgain()
        if (permission == MediaPermissionState.denied && !asksAgain) || permission == MediaPermissionState.restricted {
            previewPermissionBlocked = true
            rebuildVideo()
            return
        }
        if permission == MediaPermissionState.notDetermined || asksAgain {
            previewHooks.requestCameraPermission({ [weak self] granted in
                guard let strong = self else { return }
                if granted {
                    strong.beginPreview()
                } else {
                    strong.previewPermissionBlocked = true
                    strong.rebuildVideo()
                }
            })
            return
        }
        beginPreview()
    }

    /// Stop Preview (and every other stop: panel close, background, 30 s off screen, the meeting camera taking over).
    func stopPreview() {
        guard previewReading.isScoped else { return }
        previewStopCount += 1
        previewOffScreenToken += 1
        previewHooks.stop()
        previewChanged()
    }

    /// Open Settings from the blocked card (F00 C18 intrinsic).
    func openCameraSettings() {
        previewHooks.openSystemSettings()
    }

    /// The card entered (true) or left (false) the screen (task scoped on iOS, composition on Android). Off screen for
    /// 30 s stops the preview (C6-8); the renderer itself is kept per presentation by the card.
    func previewCardVisible(_ visible: Bool) {
        isPreviewCardOnScreen = visible
        previewOffScreenToken += 1
        guard !visible, previewReading.isScoped else { return }
        let token = previewOffScreenToken
        let pause = sleep
        Task { @MainActor [weak self] in
            await pause(SettingsPreviewPolicy.offScreenStopMillis)
            guard let strong = self, strong.previewOffScreenToken == token, !strong.isPreviewCardOnScreen else { return }
            strong.stopPreview()
        }
    }

    /// The scene went to the background: the preview stops (C6-8).
    func previewSceneBackgrounded() {
        stopPreview()
    }

    /// The preview owner published (state, session, interruption or ownership).
    func previewChanged() {
        let next = previewHooks.read()
        guard next != previewReading else { return }
        previewReading = next
        if next.state == PreviewState.live || next.state == PreviewState.starting {
            previewPermissionBlocked = false
        }
        rebuildVideo()
    }

    // MARK: Captions, chat and voice (C6-13, C6-22)

    func setCaptions(_ on: Bool) {
        guard prefs.captionsOn != on else { return }
        CaptionsPreference.set(on, defaults: defaults)
        preferenceWritten(SettingsPreferenceID.captions)
    }

    func setShowsChatPreviews(_ on: Bool) {
        guard prefs.showsChatPreviews != on else { return }
        VoicePreferences.setShowsChatPreviews(on, defaults: defaults)
        preferenceWritten(SettingsPreferenceID.chatPreviews)
    }

    func setPlaysVoiceMessages(_ on: Bool) {
        guard prefs.playsVoiceMessages != on else { return }
        VoicePreferences.setPlaysVoiceMessages(on, defaults: defaults)
        preferenceWritten(SettingsPreferenceID.playVoiceMessages)
    }

    /// "Your Voice" is selectable only while the personal voice is ready (2 c).
    func setVoiceKind(_ kind: VoiceKind) {
        guard prefs.voiceKind != kind else { return }
        if kind == VoiceKind.personal && personalVoice != PersonalVoicePhase.ready { return }
        VoicePreferences.setVoiceKind(kind, defaults: defaults)
        preferenceWritten(SettingsPreferenceID.voiceKind)
    }

    /// "" = Automatic. Reaches `TtsSpeaker` once through the queue's preference read (C6-22).
    func setStandardVoice(_ voiceId: String) {
        let trimmed = voiceId.trimmingCharacters(in: .whitespacesAndNewlines)
        guard prefs.standardVoiceId != trimmed else { return }
        VoicePreferences.setStandardVoiceId(trimmed, defaults: defaults)
        preferenceWritten(SettingsPreferenceID.standardVoice)
    }

    /// The Voice page loaded the platform's voices for the current language (iOS `AVSpeechSynthesisVoice`, Android
    /// `TextToSpeech.getVoices()`); a chosen voice no longer installed reads as Automatic (2 f).
    func setStandardVoices(_ voices: [VoiceOptionModel]) {
        guard voices != standardVoices else { return }
        standardVoices = voices
        rebuildChat()
    }

    /// C6-22 Preview: one fixed sentence (`sentence`, localized by the page) through the call output, on tap only.
    @discardableResult
    func toggleStandardVoicePreview(sentence: String) -> ControlTapResult {
        guard chat.canPreviewStandardVoice else { return ControlTapResult.ignored }
        let starting = !inputs.isStandardPreviewPlaying
        if starting { voicePreviewCount += 1 }
        dispatch(SettingsCommand.make(SettingsCommandKind.toggleVoicePreview, text: sentence, flag: starting))
        return ControlTapResult.dispatched
    }

    // MARK: Personal voice (C6-23; hidden until `canUsePersonalVoice`)

    func startVoiceSample() {
        guard inputs.canUsePersonalVoice, personalVoice != PersonalVoicePhase.recording else { return }
        recorder.reset()
        voiceSampleCount += 1
        personalVoice = PersonalVoicePhase.recording
        rebuildChat()
        dispatch(SettingsCommand.make(SettingsCommandKind.startVoiceSample))
    }

    func stopVoiceSample() {
        guard personalVoice == PersonalVoicePhase.recording else { return }
        personalVoice = PersonalVoicePhase.review
        rebuildChat()
        dispatch(SettingsCommand.make(SettingsCommandKind.stopVoiceSample))
    }

    /// The core's capture progress (one call per second; the level at 10 Hz). The 120 s cap stops the take.
    func voiceSampleProgress(elapsedSeconds: Int, level: Double) {
        guard personalVoice == PersonalVoicePhase.recording else { return }
        recorder.progress(elapsedSeconds: elapsedSeconds, level: level)
        if VoiceRecorderPolicy.reachedCap(elapsedSeconds: elapsedSeconds) { stopVoiceSample() }
    }

    func playVoiceSample() {
        guard personalVoice == PersonalVoicePhase.review else { return }
        dispatch(SettingsCommand.make(SettingsCommandKind.playVoiceSample))
    }

    func setVoiceConsent(_ on: Bool) {
        recorder.setConsent(on)
    }

    func createPersonalVoice() {
        guard personalVoice == PersonalVoicePhase.review || personalVoice == PersonalVoicePhase.failed, recorder.canCreate else { return }
        personalVoice = PersonalVoicePhase.creating
        rebuildChat()
        dispatch(SettingsCommand.make(SettingsCommandKind.createPersonalVoice, flag: recorder.consent))
    }

    func personalVoiceCreated(_ succeeded: Bool) {
        guard personalVoice == PersonalVoicePhase.creating else { return }
        personalVoice = succeeded ? PersonalVoicePhase.ready : PersonalVoicePhase.failed
        if succeeded { recorder.reset() }
        rebuildChat()
    }

    /// Redo, or leaving the recorder after "Discard Recording?".
    func discardVoiceSample() {
        guard personalVoice == PersonalVoicePhase.recording || personalVoice == PersonalVoicePhase.review
                || personalVoice == PersonalVoicePhase.failed else { return }
        if personalVoice == PersonalVoicePhase.recording {
            dispatch(SettingsCommand.make(SettingsCommandKind.stopVoiceSample))
        }
        recorder.reset()
        personalVoice = PersonalVoicePhase.none
        rebuildChat()
    }

    func hearPersonalVoice() {
        guard personalVoice == PersonalVoicePhase.ready else { return }
        dispatch(SettingsCommand.make(SettingsCommandKind.hearPersonalVoice))
    }

    func deletePersonalVoice() {
        guard personalVoice == PersonalVoicePhase.ready else { return }
        personalVoice = PersonalVoicePhase.deleting
        rebuildChat()
        dispatch(SettingsCommand.make(SettingsCommandKind.deletePersonalVoice))
    }

    func personalVoiceDeleted(_ succeeded: Bool) {
        guard personalVoice == PersonalVoicePhase.deleting else { return }
        personalVoice = succeeded ? PersonalVoicePhase.none : PersonalVoicePhase.ready
        if succeeded && prefs.voiceKind == VoiceKind.personal {
            VoicePreferences.setVoiceKind(VoiceKind.system, defaults: defaults)
            preferenceWritten(SettingsPreferenceID.voiceKind)
            return
        }
        rebuildChat()
    }

    // MARK: Host and general (C6-14, C6-24, F00 8)

    func setKnockSound(_ on: Bool) {
        guard general.hostAlertSoundsAvailable, prefs.knockSoundOn != on else { return }
        SettingsPreferences.setKnockSound(on, defaults: defaults)
        preferenceWritten(SettingsPreferenceID.knockSound)
    }

    func setHandSound(_ on: Bool) {
        guard general.hostAlertSoundsAvailable, prefs.handSoundOn != on else { return }
        SettingsPreferences.setHandSound(on, defaults: defaults)
        preferenceWritten(SettingsPreferenceID.handSound)
    }

    func setAlwaysShowControls(_ on: Bool) {
        guard prefs.alwaysShowControls != on else { return }
        SettingsPreferences.setAlwaysShowControls(on, defaults: defaults)
        preferenceWritten(SettingsPreferenceID.alwaysShowControls)
    }

    func setHaptics(_ on: Bool) {
        guard prefs.hapticsOn != on else { return }
        SettingsPreferences.setHaptics(on, defaults: defaults)
        preferenceWritten(SettingsPreferenceID.haptics)
    }

    // MARK: Account (C6-10)

    func editDisplayName(_ value: String) {
        guard account.canEditName else { return }
        hasEditedName = true
        nameEditor?.setDraft(value)
    }

    func flushDisplayName() {
        nameEditor?.flush()
    }

    /// Q5: behind a confirmation (the views own it). Single flight with the generation and room guard; there is no
    /// failure state, because local sign-out always completes and remote revocation is best effort (1 j).
    func signOut() {
        guard scope == SettingsScope.call, inputs.hasCore, account.account == AccountKind.signedIn, !signOutPending else { return }
        signOutGeneration += 1
        signOutPending = true
        signOutRoomId = inputs.roomId
        rebuildAccount()
        dispatch(SettingsCommand.make(SettingsCommandKind.signOut, generation: signOutGeneration))
    }

    func signOutFinished(generation: Int) {
        guard SettingsSignOutCompletionPolicy.shouldApply(generation: generation, currentGeneration: signOutGeneration,
                                                          actionRoomId: signOutRoomId, currentRoomId: inputs.roomId) else { return }
        signOutPending = false
        rebuildAccount()
    }

    // MARK: Internals

    private func resetSession() {
        speakerTestToken += 1
        speakerTest = SpeakerTestPhase.idle
        if micRunning {
            micRunning = false
            micRunToken += 1
            micLevel.reset()
        }
        micPhase = MicTestPhase.idle
        signOutGeneration += 1
        signOutPending = false
        testGain = 1.0
        recorder.reset()
        personalVoice = PersonalVoicePhase.unavailable
        stopPreview()
        previewPermissionBlocked = false
        stats.reset()
    }

    private func beginPreview() {
        guard video.canStartPreview else { return }
        previewStartCount += 1
        previewPermissionBlocked = false
        previewHooks.start(LocalCameraFacing.from(isFront: inputs.isFrontCamera))
        previewChanged()
    }

    private func saveCamera(_ camera: NativeCameraQualitySettings) {
        let next = NativeMediaQualitySettings(camera: camera, screenShare: prefs.quality.screenShare)
        NativeMediaQualityPreferences.save(next, defaults: defaults)
        publishCeilingChangeCount += 1
        preferenceWritten(SettingsPreferenceID.cameraQuality)
    }

    private func saveScreenShare(_ share: NativeScreenShareQualitySettings) {
        let next = NativeMediaQualitySettings(camera: prefs.quality.camera, screenShare: share)
        NativeMediaQualityPreferences.save(next, defaults: defaults)
        preferenceWritten(SettingsPreferenceID.screenShareQuality)
    }

    private func micTick() {
        if micPhase == MicTestPhase.recording || micPhase == MicTestPhase.replaying { return }
        if inputs.isMuted {
            micLevel.reset()
            if micPhase != MicTestPhase.idle {
                micPhase = MicTestPhase.idle
                rebuildAudio()
            }
            return
        }
        micLevel.update(micLevelSource?() ?? 0.0)
        if micPhase != MicTestPhase.metering {
            micPhase = MicTestPhase.metering
            rebuildAudio()
        }
    }

    private func preferenceWritten(_ id: SettingsPreferenceID) {
        reloadPreferences()
        dispatch(SettingsCommand.make(SettingsCommandKind.preferenceChanged, text: id.rawValue))
    }

    private func reloadPreferences() {
        prefs = SettingsPreferenceValues.read(defaults: defaults)
        rebuild()
    }

    private func dispatch(_ command: SettingsCommand) {
        dispatchedKinds.append(command.kind.rawValue)
        if dispatchedKinds.count > 32 { dispatchedKinds.remove(at: 0) }
        onCommand?(command)
    }

    private var isParticipantInCall: Bool {
        scope == SettingsScope.call && !inputs.isAttendee
    }

    private func rebuild() {
        rebuildAudio()
        rebuildVideo()
        rebuildChat()
        rebuildGeneral()
        rebuildAccount()
        rebuildSections()
    }

    private func rebuildSections() {
        // SET-3: Mirror, Camera Quality and Data Saver exist on every device (D11 limits the options, not the rows);
        // Screen Share Quality only where screen sharing exists.
        let capabilities = SettingsRowCapabilities.make(
            noiseSuppression: audio.noiseSuppression != SettingsCapability.hidden,
            mirror: true,
            cameraQuality: true,
            screenShareQuality: inputs.isScreenShareSupported,
            dataSaver: true,
            // SET-6 (OQ6 default A, HD request B7-T2 R9): the Effects row follows the one gate (false in production).
            effects: EffectsAvailabilityPolicy.showsPanelEntry(EffectsAvailabilityPolicy.production(canShowSystemVideoEffects: false)),
            hostAlertSounds: inputs.hostAlertSoundsAvailable,
            messageNotifications: inputs.messageNotificationsAvailable,
            callNotificationStatus: inputs.callNotificationStatusAvailable,
            linkVerification: inputs.linkVerificationAvailable,
            exportDiagnostics: inputs.canExportDiagnostics,
            attendeeChromeAutoHides: inputs.attendeeChromeAutoHides,
            hasAccountIdentity: inputs.account != AccountKind.none,
            isSignedIn: inputs.account == AccountKind.signedIn
        )
        let next = SettingsRowPolicy.sections(scope: scope, isAttendee: inputs.isAttendee, isHost: inputs.isHost,
                                              platform: platform, capabilities: capabilities)
        if next != sections { sections = next }
    }

    private func makeAudio(revision: Int) -> SettingsAudio {
        let inCall = scope == SettingsScope.call
        return SettingsAudio(
            revision: revision,
            noiseSuppressionOn: prefs.noiseSuppressionOn,
            noiseSuppression: SettingsCapability.available,
            noiseSuppressionReason: SettingsAudioPolicy.noiseSuppressionReason(scope: scope, liveChangeSupported: inputs.noiseSuppressionLive),
            speakerTest: speakerTest,
            micTest: inCall ? SettingsCapability.available : SettingsCapability.hidden,
            micTestReason: SettingsAudioPolicy.micTestReason(isMuted: inputs.isMuted),
            canRecordMicTest: inCall && inputs.canRecordMicTest,
            micPhase: micPhase,
            isMuted: inputs.isMuted,
            testGain: testGain
        )
    }

    private func rebuildAudio() {
        if makeAudio(revision: audio.revision) != audio { audio = makeAudio(revision: audio.revision + 1) }
    }

    private func makeVideo(revision: Int) -> SettingsVideo {
        let inCall = isParticipantInCall
        let reason = SettingsAudioPolicy.flipReason(isAudioOnly: inputs.isAudioOnly, isRecovering: false)
        let capability = CameraCaptureCapability(maxHeight: inputs.cameraMaxHeight, maxFrameRate: inputs.cameraMaxFrameRate)
        var presets: [String] = []
        for preset in NativeQualityOptions.cameraPresets(capability: capability) { presets.append(preset.rawValue) }
        var sharePresets: [String] = []
        for preset in NativeQualityOptions.screenSharePresets { sharePresets.append(preset.rawValue) }
        let selection = NativeQualityOptions.cameraSelection(prefs.quality.camera.preset)
        let dataSaverOn = DataSaverPolicy.isOn(preference: prefs.dataSaverOn, systemDataSaver: inputs.systemDataSaverOn)
        let cameraOn = !inputs.isCameraOff
        let preview = SettingsPreviewPolicy.state(isParticipantInCall: inCall, isAudioOnly: inputs.isAudioOnly, isCameraOn: cameraOn,
                                                  reading: previewReading, permissionBlocked: previewPermissionBlocked)
        return SettingsVideo(
            revision: revision,
            cameraFacing: inputs.isFrontCamera ? "front" : "back",
            canFlipCamera: inCall && inputs.canFlipCamera && !inputs.isAudioOnly,
            flipReason: reason,
            isFlipInFlight: inputs.isFlipInFlight,
            flipFailed: inputs.flipFailed,
            isCameraOn: cameraOn,
            isAudioOnly: inputs.isAudioOnly,
            mirrorsSelfView: prefs.mirrorsSelfView,
            cameraPreset: selection.rawValue,
            effectiveCameraPreset: SettingsVideoPolicy.effectivePreset(selection: selection, dataSaverOn: dataSaverOn,
                                                                       qualityCappedByHost: inputs.qualityCappedByHost),
            presets: presets,
            qualityCappedByHost: inputs.qualityCappedByHost,
            custom: SettingsVideoPolicy.cameraLimits(prefs.quality.camera, capability: capability),
            dataSaverOn: dataSaverOn,
            systemDataSaverOn: inputs.systemDataSaverOn,
            screenSharePreset: prefs.quality.screenShare.preset.rawValue,
            screenSharePresets: sharePresets,
            screenShareCustom: SettingsVideoPolicy.screenShareLimits(prefs.quality.screenShare),
            showsScreenShareQuality: inCall && inputs.isScreenShareSupported,
            isScreenSharing: inputs.isScreenSharing,
            canShareDeviceAudio: inCall && inputs.canShareDeviceAudio,
            shareDeviceAudioOn: prefs.shareDeviceAudioOn,
            preview: preview,
            previewReason: SettingsPreviewPolicy.reason(state: preview, interruption: previewReading.interruption,
                                                        isAudioOnly: inputs.isAudioOnly),
            previewSessionId: previewReading.sessionId,
            canStartPreview: SettingsPreviewPolicy.canStart(state: preview, isParticipantInCall: inCall,
                                                            isAudioOnly: inputs.isAudioOnly) && !cameraOn
        )
    }

    private func rebuildVideo() {
        if makeVideo(revision: video.revision) != video { video = makeVideo(revision: video.revision + 1) }
    }

    private func makeChat(revision: Int) -> SettingsChat {
        let effective = VoicePreferences.effectiveVoiceKind(preferred: prefs.voiceKind,
                                                            canUsePersonalVoice: personalVoice == PersonalVoicePhase.ready)
        var reason = SettingsReason.none
        if !inputs.canUsePersonalVoice {
            reason = inputs.account == AccountKind.signedIn || scope == SettingsScope.app
                ? SettingsReason.notInAppYet : SettingsReason.guest
        }
        var voiceId = prefs.standardVoiceId
        if !voiceId.isEmpty && !standardVoices.isEmpty {
            var installed = false
            for voice in standardVoices {
                if voice.id == voiceId { installed = true }
            }
            if !installed { voiceId = "" }
        }
        return SettingsChat(
            revision: revision,
            captionsOn: prefs.captionsOn,
            liveNotes: inputs.liveNotes,
            showsChatPreviews: prefs.showsChatPreviews,
            playsVoiceMessages: prefs.playsVoiceMessages,
            voiceKind: prefs.voiceKind,
            effectiveVoiceKind: effective,
            canUsePersonalVoice: inputs.canUsePersonalVoice,
            personalVoice: personalVoice,
            personalVoiceReason: reason,
            standardVoiceId: voiceId,
            standardVoices: standardVoices,
            standardPreview: inputs.isStandardPreviewPlaying ? SpeakerTestPhase.playing : SpeakerTestPhase.idle,
            canPreviewStandardVoice: scope == SettingsScope.call && inputs.hasCore
        )
    }

    private func rebuildChat() {
        if makeChat(revision: chat.revision) != chat { chat = makeChat(revision: chat.revision + 1) }
    }

    private func makeGeneral(revision: Int) -> SettingsGeneral {
        let isHostInCall = isParticipantInCall && inputs.isHost
        return SettingsGeneral(
            revision: revision,
            scope: scope,
            isAttendee: scope == SettingsScope.call && inputs.isAttendee,
            showsHostSection: isHostInCall,
            hostReason: (inputs.isRecovering || inputs.isOffline) ? SettingsReason.reconnecting : SettingsReason.none,
            hostAlertSoundsAvailable: isHostInCall && inputs.hostAlertSoundsAvailable,
            knockSoundOn: prefs.knockSoundOn,
            handSoundOn: prefs.handSoundOn,
            alwaysShowControls: prefs.alwaysShowControls,
            hapticsOn: prefs.hapticsOn,
            connection: inputs.connection,
            lowBandwidth: inputs.lowBandwidth,
            isRecovering: inputs.isRecovering || inputs.isOffline,
            messageNotificationsOn: inputs.messageNotificationsOn
                && inputs.notificationPermission == NotificationPermission.granted,
            notificationPermission: inputs.notificationPermission,
            callNotificationEnabled: inputs.callNotificationEnabled,
            linkVerification: inputs.linkVerification,
            canExportDiagnostics: inputs.canExportDiagnostics
        )
    }

    private func rebuildGeneral() {
        if makeGeneral(revision: general.revision) != general { general = makeGeneral(revision: general.revision + 1) }
    }

    private func makeAccount(revision: Int) -> SettingsAccount {
        SettingsAccount(
            revision: revision,
            savedDisplayName: inputs.savedDisplayName,
            canEditName: isParticipantInCall && SettingsNamePolicy.canEdit(isJoined: inputs.isJoined, isAttendee: inputs.isAttendee,
                                                                          isRecovering: inputs.isRecovering,
                                                                          isOffline: inputs.isOffline,
                                                                          isRenameDisabled: inputs.isRenameDisabled),
            nameReason: SettingsNamePolicy.reason(isRecovering: inputs.isRecovering, isOffline: inputs.isOffline),
            account: inputs.account,
            accountName: inputs.accountName,
            accountEmail: inputs.accountEmail,
            accountProvider: inputs.accountProvider,
            signOutPending: signOutPending,
            isHost: inputs.isHost
        )
    }

    private func rebuildAccount() {
        if makeAccount(revision: account.revision) != account { account = makeAccount(revision: account.revision + 1) }
    }
}

// MARK: - Panel fixtures (L6-12 `settings-*`, `voice-*`; silent, no media)

/// Named fixture states for the S20 SL14 panel harness and the host tests. Each builds inputs only; media effects are
/// recorded by `SettingsRecordingCore` (the fake WP3 owner of L6-12), never performed.
enum SettingsFixtureState: String, CaseIterable, Equatable {
    case guest, host, attendee, mic, muted, audioOnly, recovering, voiceUnavailable, voiceReady
    /// SET-3 (L6-12 `settings-video`, `settings-camera-on`, `settings-system-data-saver`, `settings-host-cap`): camera
    /// off with screen sharing (the preview card offers Start Preview), camera on (the card is published), the system
    /// data saver signal, and the host's quality limit.
    case video, cameraOn, systemDataSaver, hostQualityCap

    func inputs(callSession: Int = 1) -> SettingsInputs {
        switch self {
        case .guest:
            return SettingsInputs.make(callSession: callSession, roomId: "fixture-room", isJoined: true, isMuted: false,
                                       canFlipCamera: true, connection: ConnectionQualityLabel.good, savedDisplayName: "Avery Lee",
                                       account: AccountKind.guest, noiseSuppressionLive: true, hasCore: true)
        case .host:
            return SettingsInputs.make(callSession: callSession, roomId: "fixture-room", isJoined: true, isHost: true,
                                       isMuted: false, isCameraOff: false, canFlipCamera: true,
                                       connection: ConnectionQualityLabel.good, savedDisplayName: "Avery Lee",
                                       account: AccountKind.signedIn, accountName: "Avery Lee",
                                       accountEmail: "avery@example.com", accountProvider: "google",
                                       noiseSuppressionLive: true, hostAlertSoundsAvailable: true, hasCore: true)
        case .attendee:
            return SettingsInputs.make(callSession: callSession, roomId: "fixture-room", isJoined: true, isAttendee: true,
                                       savedDisplayName: "Avery Lee", account: AccountKind.guest, hasCore: true)
        case .mic:
            return SettingsInputs.make(callSession: callSession, roomId: "fixture-room", isJoined: true, isMuted: false,
                                       canFlipCamera: true, savedDisplayName: "Avery Lee", account: AccountKind.guest,
                                       noiseSuppressionLive: true, hasCore: true)
        case .muted:
            return SettingsInputs.make(callSession: callSession, roomId: "fixture-room", isJoined: true, isMuted: true,
                                       canFlipCamera: true, savedDisplayName: "Avery Lee", account: AccountKind.guest,
                                       noiseSuppressionLive: true, hasCore: true)
        case .audioOnly:
            return SettingsInputs.make(callSession: callSession, roomId: "fixture-room", isJoined: true, isMuted: false,
                                       isAudioOnly: true, canFlipCamera: true, savedDisplayName: "Avery Lee",
                                       account: AccountKind.guest, noiseSuppressionLive: true, hasCore: true)
        case .recovering:
            return SettingsInputs.make(callSession: callSession, roomId: "fixture-room", isJoined: true, isHost: true,
                                       isRecovering: true, isMuted: false, canFlipCamera: true, savedDisplayName: "Avery Lee",
                                       account: AccountKind.signedIn, accountName: "Avery Lee", accountEmail: "avery@example.com",
                                       accountProvider: "apple", noiseSuppressionLive: true, hasCore: true)
        case .voiceUnavailable:
            return SettingsInputs.make(callSession: callSession, roomId: "fixture-room", isJoined: true, isMuted: false,
                                       savedDisplayName: "Avery Lee", account: AccountKind.signedIn, accountName: "Avery Lee",
                                       accountEmail: "avery@example.com", accountProvider: "google", hasCore: true,
                                       canUsePersonalVoice: false)
        case .voiceReady:
            return SettingsInputs.make(callSession: callSession, roomId: "fixture-room", isJoined: true, isMuted: false,
                                       savedDisplayName: "Avery Lee", account: AccountKind.signedIn, accountName: "Avery Lee",
                                       accountEmail: "avery@example.com", accountProvider: "google", hasCore: true,
                                       canUsePersonalVoice: true, hasPersonalVoice: true)
        case .video:
            return SettingsInputs.make(callSession: callSession, roomId: "fixture-room", isJoined: true, isMuted: false,
                                       canFlipCamera: true, connection: ConnectionQualityLabel.good, savedDisplayName: "Avery Lee",
                                       account: AccountKind.guest, noiseSuppressionLive: true, hasCore: true,
                                       isScreenShareSupported: true)
        case .cameraOn:
            return SettingsInputs.make(callSession: callSession, roomId: "fixture-room", isJoined: true, isMuted: false,
                                       isCameraOff: false, canFlipCamera: true, connection: ConnectionQualityLabel.good,
                                       savedDisplayName: "Avery Lee", account: AccountKind.guest, noiseSuppressionLive: true,
                                       hasCore: true, isScreenShareSupported: true)
        case .systemDataSaver:
            return SettingsInputs.make(callSession: callSession, roomId: "fixture-room", isJoined: true, isMuted: false,
                                       canFlipCamera: true, connection: ConnectionQualityLabel.fair, savedDisplayName: "Avery Lee",
                                       account: AccountKind.guest, noiseSuppressionLive: true, hasCore: true,
                                       isScreenShareSupported: true, systemDataSaverOn: true)
        case .hostQualityCap:
            return SettingsInputs.make(callSession: callSession, roomId: "fixture-room", isJoined: true, isMuted: false,
                                       isCameraOff: false, canFlipCamera: true, connection: ConnectionQualityLabel.good,
                                       savedDisplayName: "Avery Lee", account: AccountKind.guest, noiseSuppressionLive: true,
                                       hasCore: true, isScreenShareSupported: true, qualityCappedByHost: true)
        }
    }
}

/// The fake WP3 owner (L6-12 `wp3.calls`): records every command instead of touching media, the network or the
/// server, scripts the mic level and answers the speaker preview, the sign-out and the personal voice calls. SET-3: it
/// replaces the preview owner (`previewStart`, `previewStop`, scripted states and interruptions), records
/// `setPublishCeiling` with the resolved ceiling for every quality or Data Saver change (2 l4), scripts the connection
/// stats reading and keeps the card off the live media client.
@MainActor
final class SettingsRecordingCore {
    private(set) var calls: [String] = []
    var scriptedLevel: Double = 0.0
    /// C6-9: the reading the stats leaf gets (nil = no data).
    var scriptedStats: ConnectionStatsCounters? = nil
    /// The camera permission the fake preview owner reports.
    var scriptedCameraPermission: MediaPermissionState = MediaPermissionState.granted
    /// 2 l4 readout: the last ceiling the fake owner received.
    private(set) var lastPublishCeiling: NativeResolvedCameraPublishSettings? = nil
    private(set) var previewReading: SettingsPreviewReading = SettingsPreviewReading.off
    private weak var presenter: SettingsPresenter?
    private var previewObserver: (() -> Void)? = nil
    private var previewSession = 0

    init() {}

    func install(on presenter: SettingsPresenter) {
        self.presenter = presenter
        presenter.micLevelSource = { [weak self] in self?.scriptedLevel ?? 0.0 }
        presenter.onCommand = { [weak self] command in self?.handle(command) }
        presenter.usesLiveRenderers = false
        presenter.stats.source = { [weak self] in self?.scriptedStats }
        let hooks = SettingsPreviewHooks()
        hooks.start = { [weak self] facing in self?.previewStart(facing) }
        hooks.stop = { [weak self] in self?.previewStop() }
        hooks.read = { [weak self] in self?.previewReading ?? SettingsPreviewReading.off }
        hooks.observe = { [weak self] callback in self?.previewObserver = callback }
        hooks.setMirror = { [weak self] on in self?.calls.append(on ? "mirrorOn" : "mirrorOff") }
        hooks.cameraPermission = { [weak self] in self?.scriptedCameraPermission ?? MediaPermissionState.granted }
        hooks.requestCameraPermission = { [weak self] completion in
            self?.calls.append("cameraPermissionRequest")
            completion(self?.scriptedCameraPermission == MediaPermissionState.granted)
        }
        hooks.openSystemSettings = { [weak self] in self?.calls.append("openSystemSettings") }
        presenter.previewHooks = hooks
    }

    func count(_ name: String) -> Int {
        var total = 0
        for call in calls {
            if call == name { total += 1 }
        }
        return total
    }

    /// Scripts what the preview owner reports (an interruption, its end, a failure).
    func scriptPreview(state: PreviewState, interruption: PreviewInterruption = PreviewInterruption.none) {
        previewReading = SettingsPreviewReading(state: state, sessionId: previewSession, interruption: interruption,
                                                isScoped: previewReading.isScoped)
        previewObserver?()
    }

    /// The meeting camera took the camera (the clients' hand-off): the preview stops being the Settings preview.
    func scriptCallCameraTookOver() {
        previewReading = SettingsPreviewReading(state: PreviewState.published, sessionId: previewSession,
                                                interruption: PreviewInterruption.none, isScoped: false)
        previewObserver?()
    }

    private func previewStart(_ facing: LocalCameraFacing) {
        calls.append("previewStart")
        previewSession += 1
        previewReading = SettingsPreviewReading(state: PreviewState.live, sessionId: previewSession,
                                                interruption: PreviewInterruption.none, isScoped: true)
        previewObserver?()
    }

    private func previewStop() {
        calls.append("previewStop")
        previewReading = SettingsPreviewReading(state: PreviewState.off, sessionId: previewSession,
                                                interruption: PreviewInterruption.none, isScoped: false)
        previewObserver?()
    }

    private func handle(_ command: SettingsCommand) {
        switch command.kind {
        case .setNoiseSuppression: calls.append("noiseSuppressionReplace")
        case .playTestSound: calls.append("testTone")
        case .startMicTest: calls.append("micTestSubscribe")
        case .stopMicTest: calls.append("micTestStop")
        case .startVoiceSample: calls.append("micPause")
        case .stopVoiceSample: calls.append("micRestore")
        case .toggleVoicePreview: calls.append(command.flag ? "voicePreviewStart" : "voicePreviewStop")
        case .signOut:
            calls.append("signOut")
            presenter?.signOutFinished(generation: command.generation)
        case .preferenceChanged:
            calls.append(command.kind.rawValue)
            let id = SettingsPreferenceID(rawValue: command.text) ?? SettingsPreferenceID.haptics
            if id == SettingsPreferenceID.cameraQuality || id == SettingsPreferenceID.dataSaver {
                calls.append("setPublishCeiling")
                lastPublishCeiling = presenter?.publishCeiling()
            }
        default: calls.append(command.kind.rawValue)
        }
    }
}
