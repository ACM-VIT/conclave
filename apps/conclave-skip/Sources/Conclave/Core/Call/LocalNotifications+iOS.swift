#if os(iOS) && !SKIP
import Foundation
import UIKit
import UserNotifications

// SYS-3 (S70 2 c, SY19): the iOS side of the local notifications. A thin translator from the shared
// `SystemNotifications` presenter to `UNUserNotificationCenter`; every rule (when to ask, when to post, what to remove)
// lives in the shared policies and is host-tested (`T/SYS3NotificationsTests.swift`), this file is covered by a source
// scan. Authorization is requested only from the waiting-room row (R70-3) or the Message Notifications switch (R70-4),
// with [.alert, .sound] and no badge; nothing is presented while Conclave is active; no time-sensitive entitlement
// (interruption level `.active`); the system default sound. No haptics (S70 D7).

/// Builds the platform `LocalNotificationCenter` for the presenter (installed once by `SystemNotifications.shared`).
enum UserNotificationCenterBridge {
    @MainActor
    static func center(presenter: SystemNotifications) -> LocalNotificationCenter {
        LocalNotificationCenter(
            name: "userNotifications",
            requestAuthorization: { [weak presenter] _ in
                // One requestAuthorization call per request (S70 2 l3); the answer re-reads the settings.
                Task { @MainActor in
                    let granted = (try? await UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound])) ?? false
                    presenter?.permissionAnswered(granted: granted, answered: true)
                }
            },
            refreshStatus: { [weak presenter] in
                Task { @MainActor in
                    let settings = await UNUserNotificationCenter.current().notificationSettings()
                    let name = UserNotificationCenterBridge.authorizationName(settings.authorizationStatus)
                    presenter?.statusRead(NotificationStatusReading.make(authorization: name))
                }
            },
            post: { request in
                UserNotificationCenterBridge.post(request)
            },
            removeDelivered: { _, identifiers in
                guard !identifiers.isEmpty else { return }
                UNUserNotificationCenter.current().removeDeliveredNotifications(withIdentifiers: identifiers)
                UNUserNotificationCenter.current().removePendingNotificationRequests(withIdentifiers: identifiers)
            },
            openSystemSettings: { _ in
                // iOS 16+: the app's notification settings page (the deployment target is 17.0).
                if let url = URL(string: UIApplication.openNotificationSettingsURLString) {
                    UIApplication.shared.open(url)
                }
            }
        )
    }

    /// `UNAuthorizationStatus` by the name `NotificationPermissionStatePolicy.iosState(authorization:)` reads.
    static func authorizationName(_ status: UNAuthorizationStatus) -> String {
        switch status {
        case .notDetermined: return "notDetermined"
        case .denied: return "denied"
        case .authorized: return "authorized"
        case .provisional: return "provisional"
        case .ephemeral: return "ephemeral"
        @unknown default: return "notDetermined"
        }
    }

    /// One request, delivered at once (no trigger). Never re-checks the policy: the presenter already decided.
    static func post(_ request: LocalNotificationRequest) {
        // The last guard: nothing is presented while Conclave is active (S70 2 f "App active").
        guard UIApplication.shared.applicationState != .active else { return }
        let content = makeContent(request)
        let notification = UNNotificationRequest(identifier: request.identifier, content: content, trigger: nil)
        UNUserNotificationCenter.current().add(notification) { _ in }
    }

    /// S70 2 c: admission title = the room, body "You’re in. Tap to return to the call."; messages title = the sender,
    /// subtitle "Private message" or "Mentioned you" (sentence case), body = the text. One thread per room; no
    /// summary argument (deprecated and ignored since iOS 15).
    static func makeContent(_ request: LocalNotificationRequest) -> UNMutableNotificationContent {
        let content = UNMutableNotificationContent()
        switch request.kind {
        case .admission:
            content.title = request.roomLabel
            content.body = ConclaveStrings.text("You’re in. Tap to return to the call.")
        case .privateMessage:
            content.title = request.senderName
            content.subtitle = ConclaveStrings.text("Private message")
            content.body = messageBody(request)
        case .mention:
            content.title = request.senderName
            content.subtitle = ConclaveStrings.text("Mentioned you")
            content.body = messageBody(request)
        }
        content.threadIdentifier = request.threadIdentifier
        content.sound = UNNotificationSound.default
        content.interruptionLevel = .active
        content.userInfo = [
            LocalNotificationTap.kindKey: request.kind.rawValue,
            LocalNotificationTap.roomKey: request.roomId,
            LocalNotificationTap.messageKey: request.messageId,
            LocalNotificationTap.callSessionKey: request.callSession,
            LocalNotificationTap.presenceSessionKey: request.presenceSession
        ]
        return content
    }

    /// The message text, or the kind of attachment when there is none (a photo never shows its file name, S40 8 f).
    static func messageBody(_ request: LocalNotificationRequest) -> String {
        if !request.text.isEmpty { return request.text }
        switch request.bodyKind {
        case "photo": return ConclaveStrings.text("Photo")
        case "gif": return ConclaveStrings.text("GIF")
        case "sticker": return ConclaveStrings.text("Sticker")
        case "clip": return ConclaveStrings.text("Clip")
        case "voice": return ConclaveStrings.text("Voice message")
        default: return ConclaveStrings.text("Private message")
        }
    }
}

/// S70 2 c (revision 2): the process-lifetime `UNUserNotificationCenterDelegate`, installed from
/// `ConclaveAppDelegate.onInit` (reached from `application(_:willFinishLaunchingWithOptions:)`), because a response that
/// launched the app only arrives when the delegate is set before launch finishes. It forwards to
/// `SystemNotifications.shared`, which holds the tap until the core installs its handler.
final class LocalNotificationDelegate: NSObject, UNUserNotificationCenterDelegate {
    static let shared = LocalNotificationDelegate()

    /// Idempotent; safe from `onInit` on any thread (the center is thread-safe).
    static func install() {
        UNUserNotificationCenter.current().delegate = shared
    }

    /// Never present while Conclave is active (S70 2 c `willPresent` returns []).
    func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification) async
        -> UNNotificationPresentationOptions {
        []
    }

    /// Return to the call (`presence.handle(.returnToCall, source: .system, presenceSession:)` in the core) and, for a
    /// chat notification, Chat at the message.
    func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse) async {
        let info = response.notification.request.content.userInfo
        let kind = info[LocalNotificationTap.kindKey] as? String ?? ""
        let roomId = info[LocalNotificationTap.roomKey] as? String ?? ""
        let messageId = info[LocalNotificationTap.messageKey] as? String ?? ""
        let callSession = info[LocalNotificationTap.callSessionKey] as? Int ?? 0
        let presenceSession = info[LocalNotificationTap.presenceSessionKey] as? Int ?? 0
        guard let tap = LocalNotificationTap.from(kind: kind, roomId: roomId, messageId: messageId,
                                                  callSession: callSession, presenceSession: presenceSession) else { return }
        await MainActor.run {
            SystemNotifications.shared.notificationTapped(tap)
        }
    }
}
#endif
