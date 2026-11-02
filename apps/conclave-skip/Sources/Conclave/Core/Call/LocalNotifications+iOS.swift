#if os(iOS) && !SKIP
import Foundation
import UIKit
import UserNotifications

enum UserNotificationCenterBridge {
    @MainActor
    static func center(presenter: SystemNotifications) -> LocalNotificationCenter {
        LocalNotificationCenter(
            name: "userNotifications",
            requestAuthorization: { [weak presenter] _ in

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

                if let url = URL(string: UIApplication.openNotificationSettingsURLString) {
                    UIApplication.shared.open(url)
                }
            }
        )
    }

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

    static func post(_ request: LocalNotificationRequest) {

        guard UIApplication.shared.applicationState != .active else { return }
        let content = makeContent(request)
        let notification = UNNotificationRequest(identifier: request.identifier, content: content, trigger: nil)
        UNUserNotificationCenter.current().add(notification) { _ in }
    }

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

final class LocalNotificationDelegate: NSObject, UNUserNotificationCenterDelegate {
    static let shared = LocalNotificationDelegate()

    static func install() {
        UNUserNotificationCenter.current().delegate = shared
    }

    func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification) async
        -> UNNotificationPresentationOptions {
        []
    }

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
