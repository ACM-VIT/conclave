import Foundation
import Observation

enum NotificationPermissionState: String, CaseIterable, Equatable {
    case notDetermined, granted, denied, permanentlyDenied
}

enum NotificationPermissionStatePolicy {
    static let askedPreferenceKey = NotificationPreferences.permissionAskedKey

    static let postNotificationsMinimumApi = 33

    static func state(granted: Bool, asked: Bool, rationale: Bool) -> NotificationPermissionState {
        if granted { return NotificationPermissionState.granted }
        if !asked { return NotificationPermissionState.notDetermined }
        return rationale ? NotificationPermissionState.denied : NotificationPermissionState.permanentlyDenied
    }

    static func androidState(apiLevel: Int, permissionGranted: Bool, appNotificationsEnabled: Bool, asked: Bool,
                             rationale: Bool) -> NotificationPermissionState {
        if apiLevel < postNotificationsMinimumApi {
            return appNotificationsEnabled ? NotificationPermissionState.granted : NotificationPermissionState.permanentlyDenied
        }
        if permissionGranted && !appNotificationsEnabled { return NotificationPermissionState.permanentlyDenied }
        return state(granted: permissionGranted, asked: asked, rationale: rationale)
    }

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

    static func offersOpenSettings(_ state: NotificationPermissionState, isAndroid: Bool) -> Bool {
        state != NotificationPermissionState.granted && !canRequest(state, isAndroid: isAndroid)
    }

    static func recordsAsked(answered: Bool) -> Bool {
        answered
    }

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

struct NotificationPrimingInputs: Equatable {
    let isAndroid: Bool
    let apiLevel: Int
    let hasReadStatus: Bool
    let permission: NotificationPermissionState

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

    static func showsBanner(_ inputs: NotificationPrimingInputs) -> Bool {
        guard inputs.isAndroid, inputs.apiLevel >= NotificationPermissionStatePolicy.postNotificationsMinimumApi,
              inputs.hasReadStatus, inputs.usesNativeStage else { return false }
        guard inputs.permission == NotificationPermissionState.notDetermined
            || inputs.permission == NotificationPermissionState.denied else { return false }
        guard inputs.isLive, inputs.stageEntryFinished, !inputs.isEntering, !inputs.isInPictureInPicture else { return false }
        return !inputs.isRequesting && !inputs.dismissedThisSession && !inputs.offeredInAnotherSession
    }

    static func usesLegacyPrompt(isAndroid: Bool, usesNativeStage: Bool) -> Bool {
        isAndroid && !usesNativeStage
    }
}

enum LocalNotificationChannel: String, CaseIterable, Equatable {
    case admission = "conclave_admission"
    case messages = "conclave_messages"

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

    static let importanceHigh = 4
}

enum LocalNotificationKind: String, CaseIterable, Equatable {
    case admission, privateMessage, mention
}

enum NotificationRequestReason: String, CaseIterable, Equatable {
    case call, admission, messages
}

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

    let text: String

    let bodyKind: String
    let timeMillis: Double

    let alertsOnce: Bool
}

struct LocalNotificationTap: Equatable {
    let kind: LocalNotificationKind
    let roomId: String
    let messageId: String
    let callSession: Int
    let presenceSession: Int

    static let kindKey = "conclave.notification.kind"
    static let roomKey = "conclave.notification.roomId"
    static let messageKey = "conclave.notification.messageId"
    static let callSessionKey = "conclave.notification.callSession"
    static let presenceSessionKey = "conclave.presenceSession"

    static func from(kind: String, roomId: String, messageId: String, callSession: Int, presenceSession: Int) -> LocalNotificationTap? {
        guard let parsed = LocalNotificationKind(rawValue: kind) else { return nil }
        return LocalNotificationTap(kind: parsed, roomId: roomId, messageId: messageId, callSession: callSession,
                                    presenceSession: presenceSession)
    }
}

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

    static func from(message: ChatMessage, localName: String, isFromSelf: Bool) -> LocalChatMessageInput {
        let body = ChatPreviewPolicy.body(message: message)
        return make(messageId: message.id, senderId: message.userId, senderName: message.displayName, text: body.text,
                    bodyKind: body.kind.rawValue, timeMillis: message.timestamp.timeIntervalSince1970 * 1000.0,
                    isPrivate: message.isDirect,
                    isMention: LocalNotificationPostPolicy.mentionsYou(text: message.content, localName: localName),
                    isFromSelf: isFromSelf, isAssistant: message.userId == ConclaveAssistantChatIdentity.userId)
    }
}

enum LocalNotificationPostPolicy {

    static let authorizationOptions: [String] = ["alert", "sound"]
    static let admissionPrefix = "admitted."
    static let chatPrefix = "chat."
    static let threadPrefix = "meeting."

    static let admissionNotificationId = 2001
    static let messagesNotificationId = 2002

    static let maxMessagesPerRoom = 8

    static func admissionIdentifier(callSession: Int) -> String {
        admissionPrefix + String(callSession)
    }

    static func chatIdentifier(messageId: String) -> String {
        chatPrefix + messageId
    }

    static func threadIdentifier(roomId: String) -> String {
        threadPrefix + roomId
    }

    static func postsForRoutes(nativeRoutesActive: Bool) -> Bool {
        nativeRoutesActive
    }

    static func postsAdmission(isAndroid: Bool, isAppActive: Bool, permission: NotificationPermissionState,
                               admissionNotifyOn: Bool, channelEnabled: Bool) -> Bool {
        if isAppActive || permission != NotificationPermissionState.granted || !channelEnabled { return false }
        return isAndroid || admissionNotifyOn
    }

    static func messageKind(isPrivate: Bool, isMention: Bool) -> LocalNotificationKind? {
        if isPrivate { return LocalNotificationKind.privateMessage }
        if isMention { return LocalNotificationKind.mention }
        return nil
    }

    static func postsMessage(kind: LocalNotificationKind?, isAppActive: Bool, isChatVisible: Bool, isAttendee: Bool,
                             isFromSelf: Bool, isAssistant: Bool, messageNotificationsOn: Bool,
                             permission: NotificationPermissionState, channelEnabled: Bool) -> Bool {
        guard kind != nil else { return false }
        if isAppActive || isChatVisible || isAttendee || isFromSelf || isAssistant { return false }
        return messageNotificationsOn && permission == NotificationPermissionState.granted && channelEnabled
    }

    static func alertsOnce(previousSenderId: String, senderId: String) -> Bool {
        !previousSenderId.isEmpty && previousSenderId == senderId
    }

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

enum AdmissionNotifyCapability {
    static let waitingRoomCellPassed = false

    static func offersRow(isAndroid: Bool, cellPassed: Bool, isWaiting: Bool, isPromotion: Bool) -> Bool {
        !isAndroid && cellPassed && isWaiting && !isPromotion
    }
}

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

@MainActor
final class LocalNotificationCenter {
    let name: String

    let requestAuthorization: (String) -> Void
    let refreshStatus: () -> Void
    let post: (LocalNotificationRequest) -> Void

    let removeDelivered: (String, [String]) -> Void

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

    static func none() -> LocalNotificationCenter {
        LocalNotificationCenter(name: "none", requestAuthorization: { _ in }, refreshStatus: {}, post: { _ in },
                                removeDelivered: { _, _ in }, openSystemSettings: { _ in })
    }
}

struct SystemNotificationInputs: Equatable {
    let callSession: Int
    let presenceSession: Int
    let roomId: String
    let roomLabel: String
    let isWaiting: Bool
    let isConnecting: Bool
    let isLive: Bool
    let isRecovering: Bool

    let isEntering: Bool
    let isInPictureInPicture: Bool

    let isAppActive: Bool
    let isChatVisible: Bool
    let isAttendee: Bool

    let usesNativeStage: Bool

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

struct NotificationsSnapshot: Equatable {
    let revision: Int
    let permission: NotificationPermissionState
    let hasReadStatus: Bool
    let callChannelEnabled: Bool
    let admissionChannelEnabled: Bool
    let messagesChannelEnabled: Bool

    let messageNotificationsPreference: Bool

    let messageNotificationsOn: Bool

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

@MainActor
@Observable
final class SystemNotifications {
    static let shared: SystemNotifications = SystemNotifications.makeShared()

    private(set) var snapshot: NotificationsSnapshot = NotificationsSnapshot.initial

    @ObservationIgnored private(set) var center: LocalNotificationCenter = LocalNotificationCenter.none()

    @ObservationIgnored var onChange: (() -> Void)? = nil

    @ObservationIgnored var onTap: ((LocalNotificationTap) -> Void)? = nil

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

    @ObservationIgnored private(set) var postedLog: [LocalNotificationRequest] = []
    @ObservationIgnored private(set) var removedLog: [String] = []
    @ObservationIgnored private(set) var authorizationRequestCount = 0
    @ObservationIgnored private(set) var postedCount = 0

    init(isAndroid: Bool? = nil, defaults: UserDefaults = UserDefaults.standard) {
        self.isAndroid = isAndroid ?? SystemNotifications.platformIsAndroid
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

    func install(center: LocalNotificationCenter) {
        self.center = center
        center.refreshStatus()
    }

    var readout: String {
        snapshot.permission.rawValue + "/" + (snapshot.showsPrimingBanner ? "1" : "0") + "/" + String(postedCount)
    }

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

    func stageEntryFinished() {
        guard inputs.callSession != 0, stageEntryFinishedSession != inputs.callSession else { return }
        stageEntryFinishedSession = inputs.callSession
        publishAndNotify()
    }

    func refreshStatus() {
        center.refreshStatus()
    }

    func statusRead(_ next: NotificationStatusReading) {
        let changed = !hasReadStatus || next != reading
        hasReadStatus = true
        reading = next
        if changed { publishAndNotify() }
    }

    func permissionAnswered(granted: Bool, answered: Bool) {
        isRequesting = false
        if isAndroid && NotificationPermissionStatePolicy.recordsAsked(answered: answered) {
            NotificationPreferences.setPermissionAsked(defaults: defaults)
        }
        publishAndNotify()
        center.refreshStatus()
    }

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

    func dismissPriming() {
        guard primingDismissedSession != inputs.callSession else { return }
        primingDismissedSession = inputs.callSession
        publishAndNotify()
    }

    func setMessageNotifications(_ on: Bool) {
        NotificationPreferences.setMessageNotifications(on, defaults: defaults)
        if on && currentPermission != NotificationPermissionState.granted
            && NotificationPermissionStatePolicy.canRequest(currentPermission, isAndroid: isAndroid) {
            requestPermission(reason: NotificationRequestReason.messages)
        } else {
            publishAndNotify()
        }
    }

    func setAdmissionNotify(_ on: Bool) {
        NotificationPreferences.setAdmissionNotify(on, defaults: defaults)
        if on && currentPermission != NotificationPermissionState.granted
            && NotificationPermissionStatePolicy.canRequest(currentPermission, isAndroid: isAndroid) {
            requestPermission(reason: NotificationRequestReason.admission)
        } else {
            publishAndNotify()
        }
    }

    func openSystemSettings(channel: String) {
        center.openSystemSettings(channel)
    }

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

    func clear(roomId: String) {
        guard !roomId.isEmpty else { return }
        let identifiers = deliveredByRoom[roomId] ?? []
        deliveredByRoom.removeValue(forKey: roomId)
        lastSenderByRoom.removeValue(forKey: roomId)
        recordRemoval(roomId: roomId, identifiers: identifiers)
        center.removeDelivered(roomId, identifiers)
    }

    func notificationTapped(_ tap: LocalNotificationTap) {
        if let handler = onTap {
            handler(tap)
        } else {
            pendingTap = tap
        }
    }

    func takePendingTap() -> LocalNotificationTap? {
        let tap = pendingTap
        pendingTap = nil
        return tap
    }

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
