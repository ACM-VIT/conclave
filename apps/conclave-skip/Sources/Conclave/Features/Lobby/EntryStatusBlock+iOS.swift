#if os(iOS) && !SKIP
import SwiftUI

struct EntryStatusBlock: View {
    let premeeting: PremeetingPresenter
    let routeId: Int
    let reservesNameReason: Bool

    var body: some View {
        if let status = premeeting.lobbyStatus, status.routeId == routeId {
            EntryStatusContent(status: status, isSignedIn: isSignedIn, premeeting: premeeting,
                               reservesNameReason: reservesNameReason)
                .padding(.horizontal, 16)
                .padding(.vertical, 12)
                .onChange(of: status.mode) { previous, current in
                    EntryStatusAnnouncer.modeChanged(from: previous, to: current, premeeting: premeeting)
                }
        }
    }

    private var isSignedIn: Bool {
        guard let identity = premeeting.lobbyIdentity, identity.routeId == routeId else { return false }
        return identity.isSignedIn
    }
}

private struct EntryStatusContent: View {
    let status: LobbyStatusSnapshot
    let isSignedIn: Bool
    let premeeting: PremeetingPresenter
    let reservesNameReason: Bool
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @AccessibilityFocusState private var isRetryFocused: Bool

    var body: some View {
        let isFailed = status.mode == .failed
        let isPending = LobbyStatusPolicy.pendingKind(status: status) != LobbyPendingKind.none || status.isPrimaryPending
        let current = LobbyStatusCopy.line(status: status, isSignedIn: isSignedIn)
        let nameReason = status.intent == .newMeeting ? LobbyPrimaryReason.nameMissingStart : LobbyPrimaryReason.nameMissingJoin
        let reserved = reservesNameReason ? LobbyPrimaryCopy.reason(nameReason.rawValue) : nil
        VStack(spacing: 8) {
            ConclaveFloatingActionButton(title: EntryStatusCopy.primaryTitle(status),
                                         isEnabled: isPending || LobbyStatusPolicy.primaryEnabled(status: status, isSignedIn: isSignedIn),
                                         isPending: isPending, identifier: isFailed ? "lobby.retry" : "lobby.primary") {
                if isFailed {
                    premeeting.retryJoin()
                } else {
                    premeeting.startOrJoin()
                }
            }
            .frame(maxWidth: .infinity)
            .accessibilityFocused($isRetryFocused)
            if !dynamicTypeSize.isAccessibilitySize, let line = current ?? LobbyStatusCopy.reservedLine(reserved) {
                LobbyStatusLineLabel(line: line)
                    .font(.footnote)
                    .foregroundStyle(HostingTheme.floatingBarSecondaryText)
                    .multilineTextAlignment(.center)
                    .lineLimit(LobbyStatusPolicy.lineMaxLines)
                    .fixedSize(horizontal: false, vertical: true)
                    .opacity(current == nil ? 0 : 1)
                    .accessibilityHidden(current == nil)
                    .accessibilityIdentifier(line.identifier)
            }
        }
        .task(id: status.mode) {
            guard status.mode == .failed else { return }
            isRetryFocused = true
            EntryStatusAnnouncer.announce(LobbyStatusCopy.line(status: status, isSignedIn: isSignedIn)?.text ?? "")
        }
        .onChange(of: EntryStatusLineKey(mode: status.mode, kind: current?.kind ?? LobbyStatusLineKind.none, text: current?.text ?? "")) { previous, next in
            EntryStatusAnnouncer.lineChanged(from: previous, to: next)
        }
    }
}

struct EntryStatusLineKey: Equatable {
    let mode: LobbyMode
    let kind: LobbyStatusLineKind
    let text: String
}

enum EntryStatusAnnouncer {
    @MainActor
    static func modeChanged(from previous: LobbyMode, to current: LobbyMode, premeeting: PremeetingPresenter) {
        switch current {
        case .connecting:
            if previous == .waiting {
                AccessibilityNotification.Announcement(ConclaveStrings.text("You\u{2019}re in. Joining now.")).post()
            } else {

                let label = premeeting.lobbyLink?.roomLabel ?? ""
                AccessibilityNotification.Announcement(ConclaveStrings.format("Joining %@", label)).post()
            }
        case .editing, .waiting, .failed:
            break
        }
    }

    @MainActor
    static func lineChanged(from previous: EntryStatusLineKey, to current: EntryStatusLineKey) {
        if current.mode == .failed && previous.mode != .failed { return }
        guard current.kind != previous.kind || current.text != previous.text else { return }
        guard LobbyStatusCopy.announcesLine(current.kind, mode: current.mode) else { return }
        announce(current.text)
    }

    @MainActor
    static func announce(_ text: String) {
        guard !text.isEmpty else { return }
        var announcement = AttributedString(text)
        announcement.accessibilitySpeechAnnouncementPriority = .low
        AccessibilityNotification.Announcement(announcement).post()
    }
}

enum EntryStatusCopy {
    static func pendingTitle(_ intent: LobbyIntent) -> String {
        intent == .newMeeting ? ConclaveStrings.text("Starting\u{2026}") : ConclaveStrings.text("Joining\u{2026}")
    }

    static func primaryTitle(_ status: LobbyStatusSnapshot) -> String {
        switch status.mode {
        case .editing:
            return LobbyPrimaryCopy.title(status.intent)
        case .failed:
            return ConclaveStrings.text("Try Again")
        case .connecting, .waiting:
            switch LobbyStatusPolicy.pendingKind(status: status) {
            case .reconnecting:
                return ConclaveStrings.text("Reconnecting\u{2026}")
            case .asking:
                return ConclaveStrings.text("Asking to Join")
            case .joining, .starting, .none:
                return pendingTitle(status.intent)
            }
        }
    }

    static func failureBody(_ issue: LobbyIssue) -> String {
        switch issue {
        case .failedNetwork:
            return ConclaveStrings.text("We couldn\u{2019}t reach Conclave. Check your connection and try again.")
        case .failedMedia:
            return ConclaveStrings.text("The media connection didn\u{2019}t go through. Try again.")
        case .failedServerBusy:
            return ConclaveStrings.text("The meeting server is restarting. Try again in a moment.")
        case .none, .offline, .nameMissing, .roomNotFound, .inviteCodeRequired, .inviteCodeInvalid, .signInRequired,
             .appSuspended, .failedServerText, .failedUnknown, .updateRequired:
            return ConclaveStrings.text("Something went wrong while joining. Try again.")
        }
    }

    static func subtitle(status: LobbyStatusSnapshot?, presence: LobbyPresenceSnapshot?) -> String {
        guard let status else { return LobbyPresenceCopy.text(presence) }
        switch status.mode {
        case .connecting, .waiting, .failed:
            return ""
        case .editing:
            return LobbyPresenceCopy.text(presence)
        }
    }
}
#endif
