import Foundation
import Observation

// SYS-3 (S70 2, 0.6 SX11, 0.7 SY19; S10 9 R5; S60 1 R26; S70 O3, O5): notification permission priming and the two
// local notifications a backgrounded participant needs ("you're in" after a waiting-room admission, and private
// messages and mentions of you). Shared and transpiled: String raw-value enums, scalar structs, no platform import.
// The platform pieces are thin translators behind `LocalNotificationCenter` (a class of closures, like
// `CallPresenceAdapters`: the transpiled shared code has no protocols, S1C 3.6): iOS
// `S/Core/Call/LocalNotifications+iOS.swift` (UNUserNotificationCenter and the process-lifetime delegate) and Android
// `K/LocalNotifications.kt` (channels `conclave_admission` and `conclave_messages`, PermissionHelper's serialized
// POST_NOTIFICATIONS queue). The call notification itself stays SYS-1's (`NotificationPostPolicy`,
// `NotificationChannelMigrationPolicy`).

// MARK: - Permission state (S70 2 d, SX11)

/// S70 2 j `NotificationPermission`. The S60 Settings vocabulary has three states (`NotificationPermission`); this one
/// keeps Android's permanent denial apart, because only then does the banner stop and Settings offer Open settings.
enum NotificationPermissionState: String, CaseIterable, Equatable {
    case notDetermined, granted, denied, permanentlyDenied
}

/// S70 2 d (revision 2): before the first request POST_NOTIFICATIONS reads as denied and the rationale flag is false,
/// the same signal as a permanent denial, so the persisted asked flag (written only when a request was answered) tells
/// the two apart.
enum NotificationPermissionStatePolicy {
    static let askedPreferenceKey = NotificationPreferences.permissionAskedKey
    /// POST_NOTIFICATIONS exists from API 33; below it notifications are an implicit grant.
    static let postNotificationsMinimumApi = 33

    /// S70 2 d: granted; never asked; asked and the rationale flag set (the system may ask again); asked without it.
    static func state(granted: Bool, asked: Bool, rationale: Bool) -> NotificationPermissionState {
        if granted { return NotificationPermissionState.granted }
        if !asked { return NotificationPermissionState.notDetermined }
        return rationale ? NotificationPermissionState.denied : NotificationPermissionState.permanentlyDenied
    }

    /// Android: below API 33 the app-level switch decides (the implicit grant, or off, which only Settings fixes); from
    /// API 33 a granted permission with the app's notifications switched off also reads as permanently denied.
    static func androidState(apiLevel: Int, permissionGranted: Bool, appNotificationsEnabled: Bool, asked: Bool,
                             rationale: Bool) -> NotificationPermissionState {
        if apiLevel < postNotificationsMinimumApi {
            return appNotificationsEnabled ? NotificationPermissionState.granted : NotificationPermissionState.permanentlyDenied
        }
        if permissionGranted && !appNotificationsEnabled { return NotificationPermissionState.permanentlyDenied }
        return state(granted: permissionGranted, asked: asked, rationale: rationale)
    }

    /// iOS `UNAuthorizationStatus` by name ("notDetermined", "denied", "authorized", "provisional", "ephemeral").
    static func iosState(authorization: String) -> NotificationPermissionState {
        switch authorization {
        case "authorized", "provisional", "ephemeral":
            return NotificationPermissionState.granted
        case "denied":
            return NotificationPermissionState.denied
        default:
            return NotificationPermissionState.notDetermined
        }
    }

    /// Whether a request can still show the system prompt: iOS asks exactly once; Android asks again while the
    /// rationale flag is set (S70 2 f "Denied once").
    static func canRequest(_ state: NotificationPermissionState, isAndroid: Bool) -> Bool {
        switch state {
        case .notDetermined:
            return true
        case .denied:
            return isAndroid
        case .granted, .permanentlyDenied:
            return false
        }
    }

    /// S70 2 c, f, g: the denied footer and Open Settings show once a request can no longer help.
    static func offersOpenSettings(_ state: NotificationPermissionState, isAndroid: Bool) -> Bool {
        state != NotificationPermissionState.granted && !canRequest(state, isAndroid: isAndroid)
    }

    /// The persisted asked flag is written only when the person answered (a request dropped before it was shown, or
    /// cancelled by Android because another dialog was up, leaves it false; S70 2 l2).
    static func recordsAsked(answered: Bool) -> Bool {
        answered
    }

    /// The S60 three-state vocabulary (`SettingsGeneral.notificationPermission`).
    static func settingsPermission(_ state: NotificationPermissionState) -> NotificationPermission {
        switch state {
        case .notDetermined:
            return NotificationPermission.notDetermined
        case .granted:
            return NotificationPermission.granted
        case .denied, .permanentlyDenied:
            return NotificationPermission.denied
        }
    }
}

// MARK: - Priming (S70 2 a, d, f; R70-1 `notificationsOff`)

/// What decides the Android priming banner.
struct NotificationPrimingInputs: Equatable {
    let isAndroid: Bool
    let apiLevel: Int
    let hasReadStatus: Bool
    let permission: NotificationPermissionState
    /// The native call root draws the S20 banner lane; the legacy root keeps today's prompt (`usesLegacyPrompt`).
    let usesNativeStage: Bool
    let isLive: Bool
    let stageEntryFinished: Bool
    let isEntering: Bool
    let isInPictureInPicture: Bool
    let isRequesting: Bool
    let dismissedThisSession: Bool
    let offeredInAnotherSession: Bool

    static func make(isAndroid: Bool = false, apiLevel: Int = 0, hasReadStatus: Bool = false,
                     permission: NotificationPermissionState = NotificationPermissionState.notDetermined,
                     usesNativeStage: Bool = false, isLive: Bool = false, stageEntryFinished: Bool = false,
                     isEntering: Bool = false, isInPictureInPicture: Bool = false, isRequesting: Bool = false,
                     dismissedThisSession: Bool = false, offeredInAnotherSession: Bool = false) -> NotificationPrimingInputs {
        NotificationPrimingInputs(isAndroid: isAndroid, apiLevel: apiLevel, hasReadStatus: hasReadStatus,
                                  permission: permission, usesNativeStage: usesNativeStage, isLive: isLive,
                                  stageEntryFinished: stageEntryFinished, isEntering: isEntering,
                                  isInPictureInPicture: isInPictureInPicture, isRequesting: isRequesting,
                                  dismissedThisSession: dismissedThisSession,
                                  offeredInAnotherSession: offeredInAnotherSession)
    }
}

enum NotificationPrimingPolicy {
    /// S70 2 d: Android 13+ only, after the status was read, never while asked or denied for good, only in a live call
    /// after `stageEntryFinished` (S10 7 d), never during the entry, never in PiP, once per process ("Not now" or Allow
    /// end it for the session; a later call in the same process does not show it again).
    static func showsBanner(_ inputs: NotificationPrimingInputs) -> Bool {
        guard inputs.isAndroid, inputs.apiLevel >= NotificationPermissionStatePolicy.postNotificationsMinimumApi,
              inputs.hasReadStatus, inputs.usesNativeStage else { return false }
        guard inputs.permission == NotificationPermissionState.notDetermined
            || inputs.permission == NotificationPermissionState.denied else { return false }
        guard inputs.isLive, inputs.stageEntryFinished, !inputs.isEntering, !inputs.isInPictureInPicture else { return false }
        return !inputs.isRequesting && !inputs.dismissedThisSession && !inputs.offeredInAnotherSession
    }

    /// The legacy call root draws no S20 banner lane, so it keeps today's prompt 500 ms after the entry overlay
    /// (legacy production behavior is unchanged until CALL-FLIP); the native call root primes instead.
    static func usesLegacyPrompt(isAndroid: Bool, usesNativeStage: Bool) -> Bool {
        isAndroid && !usesNativeStage
    }
}

// MARK: - Channels, kinds and requests (S70 2 c, d, g)

/// Android channels, created lazily; the call channel stays separate (S70 1 d).
enum LocalNotificationChannel: String, CaseIterable, Equatable {
    case admission = "conclave_admission"
    case messages = "conclave_messages"

    /// `sys_` resource names (S70 2 g).
    var nameResource: String {
        switch self {
        case .admission: return "sys_channel_admission"
        case .messages: return "sys_channel_messages"
        }
    }

    var descriptionResource: String {
        switch self {
        case .admission: return "sys_channel_admission_desc"
        case .messages: return "sys_channel_messages_desc"
        }
    }

    /// Android `NotificationManager.IMPORTANCE_HIGH` (default sound, heads-up).
    static let importanceHigh = 4
}

enum LocalNotificationKind: String, CaseIterable, Equatable {
    case admission, privateMessage, mention
}

/// Why a request runs (S70 2 j `requestPermission(reason:)`).
enum NotificationRequestReason: String, CaseIterable, Equatable {
    case call, admission, messages
}

/// One notification to post. Copy is resolved by the platform (catalog keys on iOS, `sys_` resources on Android);
/// the request carries only data.
struct LocalNotificationRequest: Equatable {
    let identifier: String
    let kind: LocalNotificationKind
    let channelId: String
    let roomId: String
    let roomLabel: String
    let threadIdentifier: String
    let callSession: Int
    let presenceSession: Int
    let messageId: String
    let senderId: String
    let senderName: String
    /// The message line ("" for admission); a photo or GIF without text leaves it empty and names `bodyKind`.
    let text: String
    /// `ChatPreviewBodyKind` raw value for messages ("text", "photo", "gif", "sticker", "clip", "voice"); "" otherwise.
    let bodyKind: String
    let timeMillis: Double
    /// Android `setOnlyAlertOnce`: true for a burst from the sender of the previous line (S70 2 d).
    let alertsOnce: Bool
}

/// A tap on a delivered notification (iOS delegate `didReceive`, Android `RETURN_TO_CALL` intent extras).
struct LocalNotificationTap: Equatable {
    let kind: LocalNotificationKind
    let roomId: String
    let messageId: String
    let callSession: Int
    let presenceSession: Int

    /// The userInfo and intent-extra keys both platforms write and read.
    static let kindKey = "conclave.notification.kind"
    static let roomKey = "conclave.notification.roomId"
    static let messageKey = "conclave.notification.messageId"
    static let callSessionKey = "conclave.notification.callSession"
    static let presenceSessionKey = "conclave.presenceSession"

    /// Rebuilds a tap from what the platform stored; nil when the kind is missing (not one of ours).
    static func from(kind: String, roomId: String, messageId: String, callSession: Int, presenceSession: Int) -> LocalNotificationTap? {
        guard let parsed = LocalNotificationKind(rawValue: kind) else { return nil }
        return LocalNotificationTap(kind: parsed, roomId: roomId, messageId: messageId, callSession: callSession,
                                    presenceSession: presenceSession)
    }
}

/// A received chat message as the notification rules need it (built by the core from its chat handler).
struct LocalChatMessageInput: Equatable {
    let messageId: String
    let senderId: String
    let senderName: String
    let text: String
    let bodyKind: String
    let timeMillis: Double
    let isPrivate: Bool
    let isMention: Bool
    let isFromSelf: Bool
    let isAssistant: Bool

    static func make(messageId: String = "", senderId: String = "", senderName: String = "", text: String = "",
                     bodyKind: String = "text", timeMillis: Double = 0.0, isPrivate: Bool = false,
                     isMention: Bool = false, isFromSelf: Bool = false, isAssistant: Bool = false) -> LocalChatMessageInput {
        LocalChatMessageInput(messageId: messageId, senderId: senderId, senderName: senderName, text: text,
                              bodyKind: bodyKind, timeMillis: timeMillis, isPrivate: isPrivate, isMention: isMention,
                              isFromSelf: isFromSelf, isAssistant: isAssistant)
    }

    /// From the core's appended message: the S40 8 f preview body (never a file name), a private message by
    /// `isDirect`, a mention by the same `@token` rule the native chat highlights (`ChatMentionPolicy`).
    static func from(message: ChatMessage, localName: String, isFromSelf: Bool) -> LocalChatMessageInput {
        let body = ChatPreviewPolicy.body(message: message)
        return make(messageId: message.id, senderId: message.userId, senderName: message.displayName, text: body.text,
                    bodyKind: body.kind.rawValue, timeMillis: message.timestamp.timeIntervalSince1970 * 1000.0,
                    isPrivate: message.isDirect,
                    isMention: LocalNotificationPostPolicy.mentionsYou(text: message.content, localName: localName),
                    isFromSelf: isFromSelf, isAssistant: message.userId == ConclaveAssistantChatIdentity.userId)
    }
}

/// S70 2 c, d, f (SX11 `NotificationPostPolicy` for the local notifications; the call notification keeps SYS-1's
/// `NotificationPostPolicy`, so this one carries its own name).
enum LocalNotificationPostPolicy {
    /// `requestAuthorization(options: [.alert, .sound])`: no badge (S70 2 c).
    static let authorizationOptions: [String] = ["alert", "sound"]
    static let admissionPrefix = "admitted."
    static let chatPrefix = "chat."
    static let threadPrefix = "meeting."
    /// Android notification ids under the room tag; the call notification is id 1 (`NotificationPostPolicy`).
    static let admissionNotificationId = 2001
    static let messagesNotificationId = 2002
    /// The Android MessagingStyle keeps at most this many lines per room.
    static let maxMessagesPerRoom = 8

    static func admissionIdentifier(callSession: Int) -> String {
        admissionPrefix + String(callSession)
    }

    static func chatIdentifier(messageId: String) -> String {
        chatPrefix + messageId
    }

    /// iOS `threadIdentifier` and the Android tag and group key: one thread per room.
    static func threadIdentifier(roomId: String) -> String {
        threadPrefix + roomId
    }

    /// Heads-down scope (RULES 3: legacy production roots unchanged): the core events post only while a native route is
    /// on; the flip slices (ENT-FLIP, CALL-FLIP) make that the default. The Debug system fixture posts directly.
    static func postsForRoutes(nativeRoutesActive: Bool) -> Bool {
        nativeRoutesActive
    }

    /// S70 2 c, d: only while Conclave is not active; on iOS only with the waiting-room row on (S10 9 f), on Android
    /// whenever the permission and the channel allow (POST_NOTIFICATIONS covers both channels, no row).
    static func postsAdmission(isAndroid: Bool, isAppActive: Bool, permission: NotificationPermissionState,
                               admissionNotifyOn: Bool, channelEnabled: Bool) -> Bool {
        if isAppActive || permission != NotificationPermissionState.granted || !channelEnabled { return false }
        return isAndroid || admissionNotifyOn
    }

    /// O5: private messages and mentions of you only; a room message posts nothing. A private mention reads as a
    /// private message.
    static func messageKind(isPrivate: Bool, isMention: Bool) -> LocalNotificationKind? {
        if isPrivate { return LocalNotificationKind.privateMessage }
        if isMention { return LocalNotificationKind.mention }
        return nil
    }

    /// O5, S70 2 f: never while active or while Chat is visible (Chat in PiP counts as not visible, so the core passes
    /// false there); never for an attendee (no private messages, S40), your own message, the assistant, or with the
    /// preference off, the permission missing or the channel blocked.
    static func postsMessage(kind: LocalNotificationKind?, isAppActive: Bool, isChatVisible: Bool, isAttendee: Bool,
                             isFromSelf: Bool, isAssistant: Bool, messageNotificationsOn: Bool,
                             permission: NotificationPermissionState, channelEnabled: Bool) -> Bool {
        guard kind != nil else { return false }
        if isAppActive || isChatVisible || isAttendee || isFromSelf || isAssistant { return false }
        return messageNotificationsOn && permission == NotificationPermissionState.granted && channelEnabled
    }

    /// S70 2 d: `setOnlyAlertOnce(false)` for a new sender, `true` for a burst from the same one.
    static func alertsOnce(previousSenderId: String, senderId: String) -> Bool {
        !previousSenderId.isEmpty && previousSenderId == senderId
    }

    /// `@yourname` under the native chat's own rule (CH17): the token from your display name, matched as a whole token.
    static func mentionsYou(text: String, localName: String) -> Bool {
        let token = ChatMentionPolicy.normalizedToken(localName)
        if token.isEmpty || !text.contains("@") { return false }
        let spans = ChatMentionPolicy.applyMentions(ChatLinkifyPolicy.spans(text), knownTokens: [], youToken: token)
        for span in spans {
            if span.kind == ChatSpanKind.mentionYou { return true }
        }
        return false
    }

    static func admissionRequest(roomId: String, roomLabel: String, callSession: Int, presenceSession: Int,
                                 timeMillis: Double) -> LocalNotificationRequest {
        LocalNotificationRequest(identifier: admissionIdentifier(callSession: callSession),
                                 kind: LocalNotificationKind.admission,
                                 channelId: LocalNotificationChannel.admission.rawValue, roomId: roomId,
                                 roomLabel: roomLabel, threadIdentifier: threadIdentifier(roomId: roomId),
                                 callSession: callSession, presenceSession: presenceSession, messageId: "",
                                 senderId: "", senderName: "", text: "", bodyKind: "", timeMillis: timeMillis,
                                 alertsOnce: false)
    }

    static func messageRequest(kind: LocalNotificationKind, message: LocalChatMessageInput, roomId: String,
                               roomLabel: String, callSession: Int, presenceSession: Int,
                               previousSenderId: String) -> LocalNotificationRequest {
        LocalNotificationRequest(identifier: chatIdentifier(messageId: message.messageId), kind: kind,
                                 channelId: LocalNotificationChannel.messages.rawValue, roomId: roomId,
                                 roomLabel: roomLabel, threadIdentifier: threadIdentifier(roomId: roomId),
                                 callSession: callSession, presenceSession: presenceSession,
                                 messageId: message.messageId, senderId: message.senderId,
                                 senderName: message.senderName, text: message.text, bodyKind: message.bodyKind,
                                 timeMillis: message.timeMillis,
                                 alertsOnce: alertsOnce(previousSenderId: previousSenderId, senderId: message.senderId))
    }
}

// MARK: - Preferences (S70 2 j)

/// `conclave.pref.messageNotifications` (default on, O5; the displayed value is the preference AND the granted
/// permission, S70 2 c), `conclave.pref.admissionNotify` (the iOS waiting-room row, default off, S10 9 f) and, Android
/// only, `conclave.pref.notificationsPermissionAsked` (revision 2, S70 2 d). Nonisolated: UserDefaults is thread-safe.
enum NotificationPreferences {
    static let messageNotificationsKey = "conclave.pref.messageNotifications"
    static let admissionNotifyKey = "conclave.pref.admissionNotify"
    static let permissionAskedKey = "conclave.pref.notificationsPermissionAsked"

    static func messageNotifications(defaults: UserDefaults = UserDefaults.standard) -> Bool {
        boolValue(messageNotificationsKey, fallback: true, defaults: defaults)
    }

    static func setMessageNotifications(_ on: Bool, defaults: UserDefaults = UserDefaults.standard) {
        defaults.set(on, forKey: messageNotificationsKey)
    }

    static func admissionNotify(defaults: UserDefaults = UserDefaults.standard) -> Bool {
        boolValue(admissionNotifyKey, fallback: false, defaults: defaults)
    }

    static func setAdmissionNotify(_ on: Bool, defaults: UserDefaults = UserDefaults.standard) {
        defaults.set(on, forKey: admissionNotifyKey)
    }

    static func permissionAsked(defaults: UserDefaults = UserDefaults.standard) -> Bool {
        boolValue(permissionAskedKey, fallback: false, defaults: defaults)
    }

    static func setPermissionAsked(defaults: UserDefaults = UserDefaults.standard) {
        defaults.set(true, forKey: permissionAskedKey)
    }

    private static func boolValue(_ key: String, fallback: Bool, defaults: UserDefaults) -> Bool {
        if defaults.object(forKey: key) == nil { return fallback }
        return defaults.bool(forKey: key)
    }
}

/// S70 O3 / R70-3 / RECONCILE R5: the iOS "Notify Me When I'm Let In" row is offered only once the physical-device
/// cell 2 l6 shows that a backgrounded waiting app still receives the admission event. The cell has not run, so the
/// row is built but not offered in production; a Debug launch switch shows it for fixtures (the iOS row file).
enum AdmissionNotifyCapability {
    static let waitingRoomCellPassed = false

    static func offersRow(isAndroid: Bool, cellPassed: Bool, isWaiting: Bool, isPromotion: Bool) -> Bool {
        !isAndroid && cellPassed && isWaiting && !isPromotion
    }
}

// MARK: - Platform center (closures; S70 2 c, d)

/// What the platform read: iOS fills `authorization`; Android fills the permission facts and the channel states.
struct NotificationStatusReading: Equatable {
    let authorization: String
    let apiLevel: Int
    let permissionGranted: Bool
    let appNotificationsEnabled: Bool
    let showsRationale: Bool
    let callChannelEnabled: Bool
    let admissionChannelEnabled: Bool
    let messagesChannelEnabled: Bool

    static func make(authorization: String = "", apiLevel: Int = 0, permissionGranted: Bool = false,
                     appNotificationsEnabled: Bool = true, showsRationale: Bool = false, callChannelEnabled: Bool = true,
                     admissionChannelEnabled: Bool = true, messagesChannelEnabled: Bool = true) -> NotificationStatusReading {
        NotificationStatusReading(authorization: authorization, apiLevel: apiLevel, permissionGranted: permissionGranted,
                                  appNotificationsEnabled: appNotificationsEnabled, showsRationale: showsRationale,
                                  callChannelEnabled: callChannelEnabled, admissionChannelEnabled: admissionChannelEnabled,
                                  messagesChannelEnabled: messagesChannelEnabled)
    }
}

/// The platform notification center as closures (the "fake center" of S70 2 l3 is one of these built by the test).
/// Answers come back through `SystemNotifications.statusRead(_:)` and `permissionAnswered(granted:answered:)`.
@MainActor
final class LocalNotificationCenter {
    let name: String
    /// `NotificationRequestReason` raw value; exactly one system request per call.
    let requestAuthorization: (String) -> Void
    let refreshStatus: () -> Void
    let post: (LocalNotificationRequest) -> Void
    /// Room id and the delivered identifiers to remove (iOS removes by identifier, Android cancels the room's tag).
    let removeDelivered: (String, [String]) -> Void
    /// A channel id, or "" for the app's notification settings.
    let openSystemSettings: (String) -> Void

    init(name: String, requestAuthorization: @escaping (String) -> Void, refreshStatus: @escaping () -> Void,
         post: @escaping (LocalNotificationRequest) -> Void, removeDelivered: @escaping (String, [String]) -> Void,
         openSystemSettings: @escaping (String) -> Void) {
        self.name = name
        self.requestAuthorization = requestAuthorization
        self.refreshStatus = refreshStatus
        self.post = post
        self.removeDelivered = removeDelivered
        self.openSystemSettings = openSystemSettings
    }

    /// No platform (the macOS host and any presenter built before a center is installed).
    static func none() -> LocalNotificationCenter {
        LocalNotificationCenter(name: "none", requestAuthorization: { _ in }, refreshStatus: {}, post: { _ in },
                                removeDelivered: { _, _ in }, openSystemSettings: { _ in })
    }
}

// MARK: - Presenter (S70 2 j)

/// What the core pushes (equality-guarded; never calls back from `apply`). The phase flags mirror the S1 phase:
/// `isWaiting` (the admission wait), `isConnecting` (the initial connect, also between an admission and the call),
/// `isLive` (in the call) and `isRecovering`; any of them keeps the room's delivered notifications, so only the end of
/// the call or a new room removes them (an admission posted while waiting survives the connect that follows it).
struct SystemNotificationInputs: Equatable {
    let callSession: Int
    let presenceSession: Int
    let roomId: String
    let roomLabel: String
    let isWaiting: Bool
    let isConnecting: Bool
    let isLive: Bool
    let isRecovering: Bool
    /// The entry overlay or transition is up (`MeetingState.isEnteringMeeting`).
    let isEntering: Bool
    let isInPictureInPicture: Bool
    /// Conclave is in front: foreground and not in PiP (a PiP window shows the call, so Chat is not visible there).
    let isAppActive: Bool
    let isChatVisible: Bool
    let isAttendee: Bool
    /// The native call root draws the S20 banner lane (the priming banner's only home).
    let usesNativeStage: Bool
    /// A native route (call or premeeting) is on. The local notifications ship with the native roots, so the legacy
    /// production roots stay unchanged until the flip slices (`LocalNotificationPostPolicy.postsForRoutes`).
    let nativeRoutesActive: Bool

    static func make(callSession: Int = 0, presenceSession: Int = 0, roomId: String = "", roomLabel: String = "",
                     isWaiting: Bool = false, isConnecting: Bool = false, isLive: Bool = false,
                     isRecovering: Bool = false, isEntering: Bool = false, isInPictureInPicture: Bool = false,
                     isAppActive: Bool = true, isChatVisible: Bool = false, isAttendee: Bool = false,
                     usesNativeStage: Bool = false, nativeRoutesActive: Bool = false) -> SystemNotificationInputs {
        SystemNotificationInputs(callSession: callSession, presenceSession: presenceSession, roomId: roomId,
                                 roomLabel: roomLabel, isWaiting: isWaiting, isConnecting: isConnecting, isLive: isLive,
                                 isRecovering: isRecovering, isEntering: isEntering,
                                 isInPictureInPicture: isInPictureInPicture, isAppActive: isAppActive,
                                 isChatVisible: isChatVisible, isAttendee: isAttendee, usesNativeStage: usesNativeStage,
                                 nativeRoutesActive: nativeRoutesActive)
    }

    static let none = SystemNotificationInputs.make()

    var isInCall: Bool { isWaiting || isConnecting || isLive || isRecovering }
}

/// S70 2 j `NotificationsSnapshot`, plus the derived values the rows draw.
struct NotificationsSnapshot: Equatable {
    let revision: Int
    let permission: NotificationPermissionState
    let hasReadStatus: Bool
    let callChannelEnabled: Bool
    let admissionChannelEnabled: Bool
    let messagesChannelEnabled: Bool
    /// The stored preference (default on).
    let messageNotificationsPreference: Bool
    /// The value the Message Notifications switch shows: the preference AND the granted permission (S70 2 c).
    let messageNotificationsOn: Bool
    /// The value the iOS waiting-room row shows: its preference AND the granted permission (S10 9 c).
    let admissionNotifyOn: Bool
    let isRequesting: Bool
    let canRequest: Bool
    let offersOpenSettings: Bool
    let showsPrimingBanner: Bool

    static let initial = NotificationsSnapshot(revision: 0, permission: NotificationPermissionState.notDetermined,
                                               hasReadStatus: false, callChannelEnabled: true,
                                               admissionChannelEnabled: true, messagesChannelEnabled: true,
                                               messageNotificationsPreference: true, messageNotificationsOn: false,
                                               admissionNotifyOn: false, isRequesting: false, canRequest: true,
                                               offersOpenSettings: false, showsPrimingBanner: false)

    /// The Android call notification status row (S60 1, S70 2 g): On only with the permission and its channel.
    var callNotificationOn: Bool {
        permission == NotificationPermissionState.granted && callChannelEnabled
    }

    var settingsPermission: NotificationPermission {
        NotificationPermissionStatePolicy.settingsPermission(permission)
    }

    func withRevision(_ revision: Int) -> NotificationsSnapshot {
        NotificationsSnapshot(revision: revision, permission: permission, hasReadStatus: hasReadStatus,
                              callChannelEnabled: callChannelEnabled, admissionChannelEnabled: admissionChannelEnabled,
                              messagesChannelEnabled: messagesChannelEnabled,
                              messageNotificationsPreference: messageNotificationsPreference,
                              messageNotificationsOn: messageNotificationsOn, admissionNotifyOn: admissionNotifyOn,
                              isRequesting: isRequesting, canRequest: canRequest, offersOpenSettings: offersOpenSettings,
                              showsPrimingBanner: showsPrimingBanner)
    }
}

/// S70 2 j `SystemNotifications`. One process-lifetime instance (`shared`), because the waiting-room row (lobby), the
/// Message Notifications row (Settings in a call and the app-scope page outside one, RECONCILE R26) and the delegate
/// that a notification tap can launch the app with all live outside any one call session; the per-session state
/// (priming offered or dismissed, stage entry, delivered identifiers) is keyed by the call session and room the core
/// pushes. No view observes anything but `snapshot`; `apply(_:)` never calls `onChange`.
@MainActor
@Observable
final class SystemNotifications {
    static let shared: SystemNotifications = SystemNotifications.makeShared()

    private(set) var snapshot: NotificationsSnapshot = NotificationsSnapshot.initial

    /// The platform center (installed once by `makeShared()`; tests install a recording one).
    @ObservationIgnored private(set) var center: LocalNotificationCenter = LocalNotificationCenter.none()
    /// Core only: a platform answer or event changed the snapshot (status read, permission answered, stage entry,
    /// priming dismissed); the core refreshes the stage notices and Settings. Never called from `apply`.
    @ObservationIgnored var onChange: (() -> Void)? = nil
    /// Core only: a tap on a delivered notification (return to the call; Chat at the message for chat notifications).
    @ObservationIgnored var onTap: ((LocalNotificationTap) -> Void)? = nil
    /// A tap that arrived before the core installed `onTap` (a notification that launched the app).
    @ObservationIgnored private(set) var pendingTap: LocalNotificationTap? = nil
    @ObservationIgnored private(set) var inputs: SystemNotificationInputs = SystemNotificationInputs.none
    let isAndroid: Bool
    private let defaults: UserDefaults
    @ObservationIgnored private var reading: NotificationStatusReading = NotificationStatusReading.make()
    @ObservationIgnored private var hasReadStatus = false
    @ObservationIgnored private var isRequesting = false
    @ObservationIgnored private var isApplying = false
    @ObservationIgnored private var stageEntryFinishedSession = 0
    @ObservationIgnored private var primingOfferedSession = 0
    @ObservationIgnored private var primingDismissedSession = 0
    @ObservationIgnored private var deliveredByRoom: [String: [String]] = [:]
    @ObservationIgnored private var lastSenderByRoom: [String: String] = [:]
    /// Debug readout and tests: requests posted, removals and system requests (bounded).
    @ObservationIgnored private(set) var postedLog: [LocalNotificationRequest] = []
    @ObservationIgnored private(set) var removedLog: [String] = []
    @ObservationIgnored private(set) var authorizationRequestCount = 0
    @ObservationIgnored private(set) var postedCount = 0

    init(isAndroid: Bool = SystemNotifications.platformIsAndroid, defaults: UserDefaults = UserDefaults.standard) {
        self.isAndroid = isAndroid
        self.defaults = defaults
        publish()
    }

    static var platformIsAndroid: Bool {
        #if SKIP
        return true
        #else
        return false
        #endif
    }

    private static func makeShared() -> SystemNotifications {
        let presenter = SystemNotifications()
        #if SKIP
        presenter.install(center: LocalNotifications.center(presenter: presenter))
        #elseif os(iOS)
        presenter.install(center: UserNotificationCenterBridge.center(presenter: presenter))
        #endif
        return presenter
    }

    /// Installs the platform center and reads the status once.
    func install(center: LocalNotificationCenter) {
        self.center = center
        center.refreshStatus()
    }

    /// `permission/banner/posted` for the Debug readout (`sys.notifications`).
    var readout: String {
        snapshot.permission.rawValue + "/" + (snapshot.showsPrimingBanner ? "1" : "0") + "/" + String(postedCount)
    }

    // MARK: Core inputs

    /// Core only. Clears what a state change makes stale: a return to the foreground removes the admission notice and
    /// re-reads the status (S70 2 c, k), opening Chat removes the room's chat notices, the end of a call or a new room
    /// removes everything for the old room (S70 2 f "Call ended").
    func apply(_ next: SystemNotificationInputs) {
        guard next != inputs else { return }
        let previous = inputs
        inputs = next
        isApplying = true
        if !previous.roomId.isEmpty && (previous.roomId != next.roomId || (previous.isInCall && !next.isInCall)) {
            clear(roomId: previous.roomId)
            stageEntryFinishedSession = 0
        }
        if next.isAppActive && !previous.isAppActive {
            removeDelivered(roomId: next.roomId, prefix: LocalNotificationPostPolicy.admissionPrefix)
            center.refreshStatus()
        }
        if next.isChatVisible && !previous.isChatVisible && !next.roomId.isEmpty {
            removeDelivered(roomId: next.roomId, prefix: LocalNotificationPostPolicy.chatPrefix)
            lastSenderByRoom.removeValue(forKey: next.roomId)
        }
        publish()
        isApplying = false
    }

    /// S10 7 d: the native call root posts this once its entry transition settled (Android `StageEntryFinishedEffect`).
    func stageEntryFinished() {
        guard inputs.callSession != 0, stageEntryFinishedSession != inputs.callSession else { return }
        stageEntryFinishedSession = inputs.callSession
        publishAndNotify()
    }

    // MARK: Platform answers

    func refreshStatus() {
        center.refreshStatus()
    }

    func statusRead(_ next: NotificationStatusReading) {
        let changed = !hasReadStatus || next != reading
        hasReadStatus = true
        reading = next
        if changed { publishAndNotify() }
    }

    /// The system request finished. `answered` is false when it never reached the person (dropped, no activity, or
    /// cancelled by Android behind another dialog): the asked flag stays unwritten so the banner can return.
    func permissionAnswered(granted: Bool, answered: Bool) {
        isRequesting = false
        if isAndroid && NotificationPermissionStatePolicy.recordsAsked(answered: answered) {
            NotificationPreferences.setPermissionAsked(defaults: defaults)
        }
        publishAndNotify()
        center.refreshStatus()
    }

    // MARK: Actions (S70 2 j)

    /// One system request (S70 2 l3): the priming banner's Allow ("call"), the iOS waiting-room row ("admission") or
    /// turning on Message Notifications ("messages"). The banner leaves at once either way.
    func requestPermission(reason: NotificationRequestReason) {
        if reason == NotificationRequestReason.call {
            primingDismissedSession = inputs.callSession
        }
        guard !isRequesting,
              NotificationPermissionStatePolicy.canRequest(currentPermission, isAndroid: isAndroid) else {
            publishAndNotify()
            return
        }
        isRequesting = true
        authorizationRequestCount += 1
        publishAndNotify()
        center.requestAuthorization(reason.rawValue)
    }

    /// "Not now" on the banner: dismissed for the session (S70 2 d).
    func dismissPriming() {
        guard primingDismissedSession != inputs.callSession else { return }
        primingDismissedSession = inputs.callSession
        publishAndNotify()
    }

    /// S70 2 c (R70-4): stores the preference; turning it on while a request can still help asks once, and the switch
    /// reads On only if the person allows.
    func setMessageNotifications(_ on: Bool) {
        NotificationPreferences.setMessageNotifications(on, defaults: defaults)
        if on && currentPermission != NotificationPermissionState.granted
            && NotificationPermissionStatePolicy.canRequest(currentPermission, isAndroid: isAndroid) {
            requestPermission(reason: NotificationRequestReason.messages)
        } else {
            publishAndNotify()
        }
    }

    /// S10 9 c (iOS row, R5): the same shape for the waiting-room row.
    func setAdmissionNotify(_ on: Bool) {
        NotificationPreferences.setAdmissionNotify(on, defaults: defaults)
        if on && currentPermission != NotificationPermissionState.granted
            && NotificationPermissionStatePolicy.canRequest(currentPermission, isAndroid: isAndroid) {
            requestPermission(reason: NotificationRequestReason.admission)
        } else {
            publishAndNotify()
        }
    }

    /// Open Settings: the app's notification settings, or one Android channel's.
    func openSystemSettings(channel: String) {
        center.openSystemSettings(channel)
    }

    // MARK: Core events (S70 2 j)

    /// The waiting-to-admitted transition (`socketManager.onJoinApproved`); posts only while Conclave is not active.
    func admittedWhileBackgrounded(roomLabel: String) {
        guard !inputs.roomId.isEmpty,
              LocalNotificationPostPolicy.postsForRoutes(nativeRoutesActive: inputs.nativeRoutesActive),
              LocalNotificationPostPolicy.postsAdmission(isAndroid: isAndroid, isAppActive: inputs.isAppActive,
                                                         permission: currentPermission,
                                                         admissionNotifyOn: NotificationPreferences.admissionNotify(defaults: defaults),
                                                         channelEnabled: reading.admissionChannelEnabled) else { return }
        let label = roomLabel.isEmpty ? inputs.roomLabel : roomLabel
        post(LocalNotificationPostPolicy.admissionRequest(roomId: inputs.roomId, roomLabel: label,
                                                          callSession: inputs.callSession,
                                                          presenceSession: inputs.presenceSession,
                                                          timeMillis: Date().timeIntervalSince1970 * 1000.0))
    }

    /// A received chat message (the core's chat handler); posts only private messages and mentions of you (O5).
    func chatMessageForYou(_ message: LocalChatMessageInput) {
        guard let kind = LocalNotificationPostPolicy.messageKind(isPrivate: message.isPrivate, isMention: message.isMention),
              !inputs.roomId.isEmpty,
              LocalNotificationPostPolicy.postsForRoutes(nativeRoutesActive: inputs.nativeRoutesActive),
              LocalNotificationPostPolicy.postsMessage(kind: kind, isAppActive: inputs.isAppActive,
                                                       isChatVisible: inputs.isChatVisible && !inputs.isInPictureInPicture,
                                                       isAttendee: inputs.isAttendee, isFromSelf: message.isFromSelf,
                                                       isAssistant: message.isAssistant,
                                                       messageNotificationsOn: NotificationPreferences.messageNotifications(defaults: defaults),
                                                       permission: currentPermission,
                                                       channelEnabled: reading.messagesChannelEnabled) else { return }
        let previous = lastSenderByRoom[inputs.roomId] ?? ""
        lastSenderByRoom[inputs.roomId] = message.senderId
        post(LocalNotificationPostPolicy.messageRequest(kind: kind, message: message, roomId: inputs.roomId,
                                                        roomLabel: inputs.roomLabel, callSession: inputs.callSession,
                                                        presenceSession: inputs.presenceSession,
                                                        previousSenderId: previous))
    }

    /// Removes every delivered notification for the room (Chat opened, the call ended).
    func clear(roomId: String) {
        guard !roomId.isEmpty else { return }
        let identifiers = deliveredByRoom[roomId] ?? []
        deliveredByRoom.removeValue(forKey: roomId)
        lastSenderByRoom.removeValue(forKey: roomId)
        recordRemoval(roomId: roomId, identifiers: identifiers)
        center.removeDelivered(roomId, identifiers)
    }

    /// A tap from either platform; held until the core installs `onTap`.
    func notificationTapped(_ tap: LocalNotificationTap) {
        if let handler = onTap {
            handler(tap)
        } else {
            pendingTap = tap
        }
    }

    /// The core takes a tap that launched the app once it installed `onTap`.
    func takePendingTap() -> LocalNotificationTap? {
        let tap = pendingTap
        pendingTap = nil
        return tap
    }

    // MARK: Internals

    private var currentPermission: NotificationPermissionState {
        guard hasReadStatus else { return NotificationPermissionState.notDetermined }
        if isAndroid {
            return NotificationPermissionStatePolicy.androidState(apiLevel: reading.apiLevel,
                                                                  permissionGranted: reading.permissionGranted,
                                                                  appNotificationsEnabled: reading.appNotificationsEnabled,
                                                                  asked: NotificationPreferences.permissionAsked(defaults: defaults),
                                                                  rationale: reading.showsRationale)
        }
        return NotificationPermissionStatePolicy.iosState(authorization: reading.authorization)
    }

    private func post(_ request: LocalNotificationRequest) {
        var identifiers = deliveredByRoom[request.roomId] ?? []
        if !identifiers.contains(request.identifier) {
            identifiers.append(request.identifier)
        }
        deliveredByRoom[request.roomId] = identifiers
        postedCount += 1
        postedLog.append(request)
        if postedLog.count > 16 { postedLog.remove(at: 0) }
        center.post(request)
    }

    private func removeDelivered(roomId: String, prefix: String) {
        guard !roomId.isEmpty else { return }
        let identifiers = deliveredByRoom[roomId] ?? []
        var removed: [String] = []
        var kept: [String] = []
        for identifier in identifiers {
            if identifier.hasPrefix(prefix) {
                removed.append(identifier)
            } else {
                kept.append(identifier)
            }
        }
        guard !removed.isEmpty else { return }
        deliveredByRoom[roomId] = kept
        recordRemoval(roomId: roomId, identifiers: removed)
        center.removeDelivered(roomId, removed)
    }

    private func recordRemoval(roomId: String, identifiers: [String]) {
        removedLog.append(roomId + ":" + identifiers.joined(separator: ","))
        if removedLog.count > 16 { removedLog.remove(at: 0) }
    }

    private func publishAndNotify() {
        publish()
        if !isApplying {
            onChange?()
        }
    }

    private func publish() {
        let permission = currentPermission
        let granted = permission == NotificationPermissionState.granted
        let session = inputs.callSession
        let priming = NotificationPrimingInputs.make(
            isAndroid: isAndroid, apiLevel: reading.apiLevel, hasReadStatus: hasReadStatus, permission: permission,
            usesNativeStage: inputs.usesNativeStage, isLive: inputs.isLive,
            stageEntryFinished: session != 0 && stageEntryFinishedSession == session, isEntering: inputs.isEntering,
            isInPictureInPicture: inputs.isInPictureInPicture, isRequesting: isRequesting,
            dismissedThisSession: session != 0 && primingDismissedSession == session,
            offeredInAnotherSession: primingOfferedSession != 0 && primingOfferedSession != session)
        let showsBanner = NotificationPrimingPolicy.showsBanner(priming)
        if showsBanner && primingOfferedSession == 0 {
            // Once per process: the first session that shows it owns it.
            primingOfferedSession = session
        }
        let preference = NotificationPreferences.messageNotifications(defaults: defaults)
        let next = NotificationsSnapshot(
            revision: snapshot.revision,
            permission: permission,
            hasReadStatus: hasReadStatus,
            callChannelEnabled: reading.callChannelEnabled,
            admissionChannelEnabled: reading.admissionChannelEnabled,
            messagesChannelEnabled: reading.messagesChannelEnabled,
            messageNotificationsPreference: preference,
            messageNotificationsOn: preference && granted,
            admissionNotifyOn: NotificationPreferences.admissionNotify(defaults: defaults) && granted,
            isRequesting: isRequesting,
            canRequest: NotificationPermissionStatePolicy.canRequest(permission, isAndroid: isAndroid),
            offersOpenSettings: hasReadStatus && NotificationPermissionStatePolicy.offersOpenSettings(permission, isAndroid: isAndroid),
            showsPrimingBanner: showsBanner
        )
        if next != snapshot {
            snapshot = next.withRevision(snapshot.revision + 1)
        }
    }
}
