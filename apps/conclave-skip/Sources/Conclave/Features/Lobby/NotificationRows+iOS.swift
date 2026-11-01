#if os(iOS) && !SKIP
import SwiftUI

struct AdmissionNotifySection: View {
    let premeeting: PremeetingPresenter

    var body: some View {
        if AdmissionNotifyRowGate.isOffered(status: premeeting.lobbyStatus) {
            AdmissionNotifyRow(notifications: SystemNotifications.shared)
        }
    }
}

enum AdmissionNotifyRowGate {

    static var cellPassed: Bool {
        #if DEBUG
        if ProcessInfo.processInfo.environment["CONCLAVE_ADMISSION_NOTIFY_ROW"] == "1" {
            return true
        }
        #endif
        return AdmissionNotifyCapability.waitingRoomCellPassed
    }

    static func isOffered(status: LobbyStatusSnapshot?) -> Bool {
        guard let status else { return false }
        return AdmissionNotifyCapability.offersRow(isAndroid: false, cellPassed: cellPassed,
                                                   isWaiting: status.mode == LobbyMode.waiting,
                                                   isPromotion: status.intent == LobbyIntent.promotion)
    }
}

struct AdmissionNotifyRow: View {
    let notifications: SystemNotifications

    var body: some View {
        let snapshot = notifications.snapshot
        let footer = NotificationRowsCopy.admissionFooter(snapshot)
        LobbyGroupedSection(footer: footer, footerIdentifier: "lobby.notify.footer") {
            LobbyGroupedRow {
                Toggle(ConclaveStrings.text("Notify Me When I’m Let In"), isOn: isOn)
                    .disabled(snapshot.isRequesting || snapshot.offersOpenSettings)
                    .accessibilityHint(footer)
                    .accessibilityIdentifier("lobby.notify.toggle")
            }
            if snapshot.offersOpenSettings {
                LobbyGroupedDivider()
                LobbyGroupedRow {
                    Button(ConclaveStrings.text("Open Settings")) { notifications.openSystemSettings(channel: "") }
                        .buttonStyle(.borderless)
                        .tint(HostingTheme.coralText)
                        .accessibilityIdentifier("lobby.notify.openSettings")
                }
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("lobby.notify")

        .task { notifications.refreshStatus() }
    }

    private var isOn: Binding<Bool> {
        Binding(get: { notifications.snapshot.admissionNotifyOn },
                set: { notifications.setAdmissionNotify($0) })
    }
}

struct MessageNotificationsRow: View {
    let notifications: SystemNotifications

    var body: some View {
        let snapshot = notifications.snapshot
        Toggle(ConclaveStrings.text("Message Notifications"), isOn: isOn)
            .disabled(snapshot.isRequesting || snapshot.offersOpenSettings)
            .accessibilityHint(NotificationRowsCopy.messagesFooter(snapshot))
            .accessibilityIdentifier("settings.row.messageNotifications")
            .task { notifications.refreshStatus() }
        if snapshot.offersOpenSettings {
            Button(ConclaveStrings.text("Open Settings")) { notifications.openSystemSettings(channel: "") }
                .tint(HostingTheme.coralText)
                .accessibilityIdentifier("settings.row.messageNotifications.openSettings")
        }
    }

    private var isOn: Binding<Bool> {
        Binding(get: { notifications.snapshot.messageNotificationsOn },
                set: { notifications.setMessageNotifications($0) })
    }
}

struct MessageNotificationsFooter: View {
    let notifications: SystemNotifications

    var body: some View {
        Text(NotificationRowsCopy.messagesFooter(notifications.snapshot))
            .accessibilityIdentifier("settings.row.messageNotifications.footer")
    }
}

enum NotificationRowsCopy {

    static func admissionFooter(_ snapshot: NotificationsSnapshot) -> String {
        if snapshot.offersOpenSettings {
            return ConclaveStrings.text("Notifications are off for Conclave.")
        }
        if snapshot.admissionNotifyOn {
            return ConclaveStrings.text("We’ll notify you when you’re let in.")
        }
        return ""
    }

    static func messagesFooter(_ snapshot: NotificationsSnapshot) -> String {
        if snapshot.offersOpenSettings {
            return ConclaveStrings.text("Notifications are off for Conclave.")
        }
        return ConclaveStrings.text("Get notified about private messages and mentions while you’re in another app.")
    }
}
#endif
