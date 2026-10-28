#if os(iOS) && !SKIP
import SwiftUI

// SYS-3 (S70 2 c, f, g, i; S10 9 c, f, g, RECONCILE R5; S60 1, RECONCILE R26, S70 R70-4): the iOS notification rows.
// Both read only the process-lifetime `SystemNotifications.shared.snapshot` and send intent through it; the presenter
// owns every rule (one `requestAuthorization` per tap, the displayed value = preference AND granted, the denied footer
// with Open Settings). System appearance, a system green `Toggle` (R06), Open Settings in coralText like the lobby's
// other borderless links; no haptics (S70 D7). The lobby mounts the waiting-room section; Settings mounts the
// Message Notifications row and footer in its General section (HD request B8-T5 R3), in a call and outside one.

/// S10 9 c: "Notify Me When I'm Let In" under the Audio and Name rows while waiting, offered only once the S70 O3
/// physical-device cell passes (`AdmissionNotifyCapability`), never in the promotion lobby, never on Android.
struct AdmissionNotifySection: View {
    let premeeting: PremeetingPresenter

    var body: some View {
        if AdmissionNotifyRowGate.isOffered(status: premeeting.lobbyStatus) {
            AdmissionNotifyRow(notifications: SystemNotifications.shared)
        }
    }
}

enum AdmissionNotifyRowGate {
    /// The O3 cell result; Debug launches with `CONCLAVE_ADMISSION_NOTIFY_ROW=1` show the row for fixtures and the cell.
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

/// S10 9 f row states: off (default), requesting (the system prompt), on ("We'll notify you when you're let in."),
/// denied ("Notifications are off for Conclave." with Open Settings). The footer is also the toggle's hint (S70 2 i).
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
        // Re-read on appearance (no polling, S70 2 k); the presenter also re-reads on every foreground return.
        .task { notifications.refreshStatus() }
    }

    private var isOn: Binding<Bool> {
        Binding(get: { notifications.snapshot.admissionNotifyOn },
                set: { notifications.setAdmissionNotify($0) })
    }
}

/// S70 2 c (R70-4): "Message Notifications". Not determined: Off with the footer, turning it on asks once and reads On
/// only if the person allows; granted: the preference; denied: Off, the denied footer and Open Settings.
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

/// The General section footer line for the Message Notifications row (S70 2 g).
struct MessageNotificationsFooter: View {
    let notifications: SystemNotifications

    var body: some View {
        Text(NotificationRowsCopy.messagesFooter(notifications.snapshot))
            .accessibilityIdentifier("settings.row.messageNotifications.footer")
    }
}

enum NotificationRowsCopy {
    /// S10 9 g: on: "We'll notify you when you're let in."; denied: the S70 2 g denied sentence; otherwise none.
    static func admissionFooter(_ snapshot: NotificationsSnapshot) -> String {
        if snapshot.offersOpenSettings {
            return ConclaveStrings.text("Notifications are off for Conclave.")
        }
        if snapshot.admissionNotifyOn {
            return ConclaveStrings.text("We’ll notify you when you’re let in.")
        }
        return ""
    }

    /// S70 2 g: the description, or the denied sentence once only Settings can help.
    static func messagesFooter(_ snapshot: NotificationsSnapshot) -> String {
        if snapshot.offersOpenSettings {
            return ConclaveStrings.text("Notifications are off for Conclave.")
        }
        return ConclaveStrings.text("Get notified about private messages and mentions while you’re in another app.")
    }
}
#endif
