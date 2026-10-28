#if os(iOS) && !SKIP
import SwiftUI
import UIKit

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
