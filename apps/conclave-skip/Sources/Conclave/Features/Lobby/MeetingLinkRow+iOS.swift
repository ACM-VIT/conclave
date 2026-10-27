#if os(iOS) && !SKIP
import SwiftUI
import UIKit

// ENT-8 (S10 6 c L8, 11 c; S20 SC21; RECONCILE R14, R50): the lobby's Meeting Link row and the toolbar Share on iOS.
// The link comes from the shared MeetingLinkBuilder through `premeeting.lobbyLink` (it carries `?clientId=` only for
// a non-default tenant). Copy is view code: `UIPasteboard.general.url` plus the `linkCopied` gesture through a
// view-local counter (F00 8), and an inline confirmation ("Copied" with a checkmark for 1.8 s, F00 C13: no toast on a
// system-appearance screen). Never the legacy MeetingShare helpers (they play a success haptic, SC21). For a new
// meeting before Start the row only explains that invites come after Start (S10 Q1).

struct MeetingLinkRow: View {
    let premeeting: PremeetingPresenter
    @State private var copyCount = 0
    @State private var copied = false
    @State private var revertTask: Task<Void, Never>? = nil

    static let confirmationSeconds = 1.8

    var body: some View {
        let link = premeeting.lobbyLink
        LobbyGroupedRow {
            if let link, link.canShare, !link.meetingLink.isEmpty {
                HStack(spacing: 12) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(ConclaveStrings.text("Meeting Link"))
                            .font(.footnote)
                            .foregroundStyle(HostingTheme.secondaryText)
                        Text(MeetingLinkBuilder.displayText(link.meetingLink))
                            .lineLimit(1)
                            .truncationMode(.middle)
                    }
                    .accessibilityElement(children: .combine)
                    Spacer(minLength: 8)
                    Button {
                        copy(link.meetingLink)
                    } label: {
                        Image(systemName: copied ? ConclaveSymbols.checkmark : ConclaveSymbols.docOnDoc)
                            .frame(minWidth: 44, minHeight: 44)
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.borderless)
                    .tint(HostingTheme.coralText)
                    .accessibilityLabel(copied ? ConclaveStrings.text("Copied") : ConclaveStrings.text("Copy Link"))
                    .accessibilityIdentifier("lobby.link.copy")
                    .conclaveGestureFeedback(.linkCopied, trigger: copyCount)
                }
            } else {
                Text(ConclaveStrings.text("You can invite people after you start."))
                    .font(.footnote)
                    .foregroundStyle(HostingTheme.secondaryText)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .accessibilityIdentifier("lobby.link")
        .onDisappear {
            revertTask?.cancel()
        }
    }

    private func copy(_ link: String) {
        if let url = URL(string: link) {
            UIPasteboard.general.url = url
        } else {
            UIPasteboard.general.string = link
        }
        copyCount += 1
        copied = true
        AccessibilityNotification.Announcement(ConclaveStrings.text("Link copied")).post()
        revertTask?.cancel()
        revertTask = Task { @MainActor in
            try? await Task.sleep(nanoseconds: UInt64(MeetingLinkRow.confirmationSeconds * 1_000_000_000))
            guard !Task.isCancelled else { return }
            copied = false
        }
    }
}

/// The toolbar Share (S10 11 c): `ShareLink` with the F00 payload (subject and message keys, RECONCILE R14) and the
/// room label as the preview title. Shown only while the lobby can share (never for a new meeting before Start).
struct MeetingShareLinkButton: View {
    let premeeting: PremeetingPresenter

    var body: some View {
        if let link = premeeting.lobbyLink, link.canShare, let url = URL(string: link.meetingLink) {
            ShareLink(item: url,
                      subject: Text(ConclaveStrings.text("Join My Conclave Meeting")),
                      message: Text(ConclaveStrings.text("Join me in this Conclave meeting.")),
                      preview: SharePreview(link.roomLabel)) {
                Image(systemName: ConclaveSymbols.squareAndArrowUp)
            }
            .accessibilityLabel(ConclaveStrings.text("Share Invite"))
            .accessibilityIdentifier("lobby.share")
        }
    }
}
#endif
