#if os(iOS) && !SKIP
import SwiftUI

// ENT-5 (S10 8 c, e, f, g, i; 9 c, e, f, g, i; 0.6 L6): the lobby's bottom block in its four modes, in place in the
// lobby so the preview card and its renderer never move (S10 9 k). Editing: the one coral primary and its disabled
// reason. Connecting: the pending primary ("Joining…" or "Starting…", value "In Progress") and, after 8 s, the slow
// footnote. Waiting: the system spinner with "Asking to Join", the body for its `WaitingKind` and the tonal Cancel
// (no coral action in this state). Failed: the error glyph, "Couldn't Join" (or Start), the body by class and Try
// Again, focused. It reads `lobbyStatus` only. No tap haptic: the outcome tokens come from the shell and the presenter.

struct EntryStatusBlock: View {
    let premeeting: PremeetingPresenter
    let routeId: Int

    var body: some View {
        if let status = premeeting.lobbyStatus, status.routeId == routeId {
            EntryStatusContent(status: status, premeeting: premeeting)
                .padding(.horizontal, 16)
                .padding(.vertical, 12)
                .onChange(of: status.mode) { previous, current in
                    EntryStatusAnnouncer.modeChanged(from: previous, to: current, premeeting: premeeting)
                }
        }
    }
}

private struct EntryStatusContent: View {
    let status: LobbyStatusSnapshot
    let premeeting: PremeetingPresenter

    var body: some View {
        switch status.mode {
        case .editing:
            EntryEditingBlock(status: status, premeeting: premeeting)
        case .connecting:
            EntryConnectingBlock(status: status)
        case .waiting:
            EntryWaitingBlock(status: status, premeeting: premeeting)
        case .failed:
            EntryFailedBlock(status: status, premeeting: premeeting)
        }
    }
}

/// S10 6 c: the primary and, while it is disabled, the reason under it.
private struct EntryEditingBlock: View {
    let status: LobbyStatusSnapshot
    let premeeting: PremeetingPresenter

    var body: some View {
        VStack(spacing: 8) {
            ConclaveButton(LobbyPrimaryCopy.title(status.intent), role: .primary, isEnabled: status.isPrimaryEnabled,
                           isPending: status.isPrimaryPending, identifier: "lobby.primary") {
                premeeting.startOrJoin()
            }
            .frame(maxWidth: .infinity)
            if let reason = LobbyPrimaryCopy.reason(status.primaryReason) {
                Text(reason)
                    .font(.footnote)
                    .foregroundStyle(HostingTheme.secondaryText)
                    .multilineTextAlignment(.center)
                    .accessibilityIdentifier("lobby.primary.reason")
            }
        }
    }
}

/// S10 8 c: the pending primary within one frame of the tap (the presenter publishes Connecting synchronously), then
/// the slow footnote after 8 s. Cancel is the toolbar's (first in focus order).
private struct EntryConnectingBlock: View {
    let status: LobbyStatusSnapshot

    var body: some View {
        VStack(spacing: 8) {
            ConclaveButton(EntryStatusCopy.pendingTitle(status.intent), role: .primary, isEnabled: false, isPending: true,
                           identifier: "lobby.primary") {}
                .frame(maxWidth: .infinity)
            if status.showsSlowNotice {
                Text(ConclaveStrings.text("Still connecting. Check your connection."))
                    .font(.footnote)
                    .foregroundStyle(HostingTheme.secondaryText)
                    .multilineTextAlignment(.center)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityIdentifier("lobby.slowNotice")
            }
        }
    }
}

/// S10 9 c: one container; the body is announced when it changes; both Cancel buttons cancel at once.
private struct EntryWaitingBlock: View {
    let status: LobbyStatusSnapshot
    let premeeting: PremeetingPresenter

    var body: some View {
        let waitingBody = EntryStatusCopy.waitingBody(status)
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 8) {
                ProgressView()
                    .accessibilityHidden(true)
                Text(ConclaveStrings.text("Asking to Join"))
                    .font(.headline)
                    .accessibilityAddTraits(.isHeader)
            }
            Text(waitingBody)
                .font(.subheadline)
                .foregroundStyle(HostingTheme.secondaryText)
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityIdentifier("lobby.waiting.body")
            ConclaveButton(ConclaveStrings.text("Cancel"), role: .tonal, identifier: "lobby.waiting.cancel") {
                premeeting.cancelJoin()
            }
            .frame(maxWidth: .infinity)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("lobby.status")
        .onChange(of: status.waitingKind) {
            AccessibilityNotification.Announcement(waitingBody).post()
        }
    }
}

/// S10 8 c: the failed block, announced once (the mode change) with Try Again focused.
private struct EntryFailedBlock: View {
    let status: LobbyStatusSnapshot
    let premeeting: PremeetingPresenter
    @AccessibilityFocusState private var isRetryFocused: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            VStack(alignment: .leading, spacing: 4) {
                Label {
                    Text(EntryStatusCopy.failureTitle(status.intent))
                        .font(.headline)
                } icon: {
                    Image(systemName: ConclaveSymbols.exclamationmarkOctagonFill)
                        .foregroundStyle(Color(uiColor: .systemRed))
                        .accessibilityHidden(true)
                }
                Text(EntryStatusCopy.failureBody(status))
                    .font(.subheadline)
                    .foregroundStyle(HostingTheme.secondaryText)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .accessibilityElement(children: .combine)
            .accessibilityIdentifier("lobby.status")
            ConclaveButton(ConclaveStrings.text("Try Again"), role: .primary, identifier: "lobby.retry") {
                premeeting.retryJoin()
            }
            .frame(maxWidth: .infinity)
            .accessibilityFocused($isRetryFocused)
        }
        // Once per failed block (a body re-run never repeats it).
        .task {
            isRetryFocused = true
        }
    }
}

/// S10 8 i, 9 i: the polite announcements of the entry states (never for a body re-run: mode changes only).
enum EntryStatusAnnouncer {
    @MainActor
    static func modeChanged(from previous: LobbyMode, to current: LobbyMode, premeeting: PremeetingPresenter) {
        switch current {
        case .connecting:
            if previous == .waiting {
                AccessibilityNotification.Announcement(ConclaveStrings.text("You\u{2019}re in. Joining now.")).post()
            } else {
                // Read here, not in a body: the link snapshot is not a dependency of the block.
                let label = premeeting.lobbyLink?.roomLabel ?? ""
                AccessibilityNotification.Announcement(ConclaveStrings.format("Joining %@", label)).post()
            }
        case .failed:
            AccessibilityNotification.Announcement(ConclaveStrings.text("Couldn\u{2019}t join")).post()
        case .editing, .waiting:
            break
        }
    }
}

/// The entry copy (S10 8 g, 9 g); catalog keys in Apple title case for titles and buttons, sentence case for bodies.
enum EntryStatusCopy {
    static func pendingTitle(_ intent: LobbyIntent) -> String {
        intent == .newMeeting ? ConclaveStrings.text("Starting\u{2026}") : ConclaveStrings.text("Joining\u{2026}")
    }

    static func failureTitle(_ intent: LobbyIntent) -> String {
        intent == .newMeeting ? ConclaveStrings.text("Couldn\u{2019}t Start") : ConclaveStrings.text("Couldn\u{2019}t Join")
    }

    /// The failed block body: a clean server sentence as is, else the class's sentence.
    static func failureBody(_ status: LobbyStatusSnapshot) -> String {
        if status.issue == .failedServerText && !status.issueServerText.isEmpty {
            return status.issueServerText
        }
        return failureBody(status.issue)
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

    static func waitingBody(_ status: LobbyStatusSnapshot) -> String {
        switch status.waitingKind {
        case .standard:
            return ConclaveStrings.text("You\u{2019}ll join as soon as someone lets you in.")
        case .locked:
            return ConclaveStrings.text("This meeting is locked. The host will review your request.")
        case .noHost:
            return ConclaveStrings.text("No one is here to let you in yet. You can keep waiting.")
        case .hostAvailable:
            return ConclaveStrings.text("A host is here and can let you in.")
        case .reconnecting:
            return ConclaveStrings.text("Reconnecting. You\u{2019}ll keep your place.")
        case .offline:
            return ConclaveStrings.text("You\u{2019}re offline. You\u{2019}ll keep your place when you\u{2019}re back.")
        case .serverRestarting:
            if !status.waitingText.isEmpty {
                return status.waitingText
            }
            return ConclaveStrings.text("The meeting server is restarting. You\u{2019}ll be reconnected automatically.")
        }
    }

    /// The lobby subtitle (S10 8 c, 9 c): "Joining" or "Reconnecting" while connecting, nothing while waiting or
    /// failed (the status block is the only "Asking to Join"), presence while editing.
    static func subtitle(status: LobbyStatusSnapshot?, presence: LobbyPresenceSnapshot?) -> String {
        guard let status else { return LobbyPresenceCopy.text(presence) }
        switch status.mode {
        case .connecting:
            return status.waitingKind == .reconnecting ? ConclaveStrings.text("Reconnecting") : ConclaveStrings.text("Joining")
        case .waiting, .failed:
            return ""
        case .editing:
            return LobbyPresenceCopy.text(presence)
        }
    }
}
#endif
