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

/// A preference the presenter wrote; the core refreshes whatever reads it (`preferenceChanged`).
enum SettingsPreferenceID: String, CaseIterable, Equatable {
    case noiseSuppression, captions, chatPreviews, playVoiceMessages, voiceKind, standardVoice, alwaysShowControls
    case haptics, knockSound, handSound
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
            handSoundOn: SettingsPreferences.handSound(defaults: defaults)
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

/// The SET-1 video rows (camera facing). SET-3 adds preview, mirror, quality, Data Saver and share fields; SET-6 the
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

    static let empty = SettingsVideo(revision: 0, cameraFacing: "front", canFlipCamera: false, flipReason: SettingsReason.none,
                                     isFlipInFlight: false, flipFailed: false, isCameraOn: false, isAudioOnly: false)
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
                     canExportDiagnostics: Bool = false) -> SettingsInputs {
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
                       linkVerification: linkVerification, canExportDiagnostics: canExportDiagnostics)
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

    // Debug readouts and tests (L6-12: speakerTest.count, micTest.phase, voicePreview.count, wp3.calls).
    @ObservationIgnored private(set) var speakerTestCount = 0
    @ObservationIgnored private(set) var micTestSubscribeCount = 0
    @ObservationIgnored private(set) var micTestStopCount = 0
    @ObservationIgnored private(set) var voicePreviewCount = 0
    @ObservationIgnored private(set) var noiseSuppressionChangeCount = 0
    @ObservationIgnored private(set) var voiceSampleCount = 0
    @ObservationIgnored private(set) var dispatchedKinds: [String] = []
    @ObservationIgnored private(set) var applyCount = 0
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
    }

    /// The panel closed: the pending name saves now (C6-10) and a mic test still running stops.
    func panelDidClose() {
        nameEditor?.flush()
        stopMicTest()
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
        let capabilities = SettingsRowCapabilities.make(
            noiseSuppression: audio.noiseSuppression != SettingsCapability.hidden,
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
        return SettingsVideo(
            revision: revision,
            cameraFacing: inputs.isFrontCamera ? "front" : "back",
            canFlipCamera: inCall && inputs.canFlipCamera && !inputs.isAudioOnly,
            flipReason: reason,
            isFlipInFlight: inputs.isFlipInFlight,
            flipFailed: inputs.flipFailed,
            isCameraOn: !inputs.isCameraOff,
            isAudioOnly: inputs.isAudioOnly
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
        }
    }
}

/// The fake WP3 owner (L6-12 `wp3.calls`): records every command instead of touching media, the network or the
/// server, scripts the mic level and answers the speaker preview, the sign-out and the personal voice calls.
@MainActor
final class SettingsRecordingCore {
    private(set) var calls: [String] = []
    var scriptedLevel: Double = 0.0
    private weak var presenter: SettingsPresenter?

    init() {}

    func install(on presenter: SettingsPresenter) {
        self.presenter = presenter
        presenter.micLevelSource = { [weak self] in self?.scriptedLevel ?? 0.0 }
        presenter.onCommand = { [weak self] command in self?.handle(command) }
    }

    func count(_ name: String) -> Int {
        var total = 0
        for call in calls {
            if call == name { total += 1 }
        }
        return total
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
        default: calls.append(command.kind.rawValue)
        }
    }
}
