#if os(iOS) && !SKIP
import SwiftUI
import UIKit

enum PremeetingSymbols {
    static let account = ConclaveSymbols.personCropCircle
    static let recent = ConclaveSymbols.clockArrowCirclepath
    static let info = ConclaveSymbols.infoCircle
    static let close = ConclaveSymbols.xmark
    static let copyLink = ConclaveSymbols.docOnDoc
    static let invite = ConclaveSymbols.squareAndArrowUp
    static let delete = ConclaveSymbols.trash
    static let error = ConclaveSymbols.exclamationmarkOctagonFill
}

struct HomeView: View {
    let premeeting: PremeetingPresenter

    var body: some View {
        let home = premeeting.home
        List {
            if home.updateRequired {
                Section {
                    HomeUpdateBanner(storeURL: home.storeURL, onOpen: { premeeting.openStoreListing() })
                }
            }
            if home.noticeKind != .none {
                Section {
                    HomeNoticeRow(kind: home.noticeKind, onDismiss: { premeeting.dismissHomeNotice() },
                                  onSignIn: { premeeting.openAccount() })
                }
            }
            if !home.isSignedIn {
                Section {
                    Button { premeeting.openAccount() } label: {
                        Text(ConclaveStrings.text("Sign In"))
                            .font(.headline)
                            .foregroundStyle(.primary)
                            .frame(maxWidth: .infinity, minHeight: 50)
                            .background(Color(uiColor: .secondarySystemGroupedBackground), in: Capsule())
                            .overlay { Capsule().strokeBorder(Color(uiColor: .separator), lineWidth: 1) }
                    }
                    .buttonStyle(.plain)
                    .accessibilityIdentifier("home.signIn")
                    .listRowInsets(EdgeInsets())
                    .listRowBackground(Color.clear)
                }
            }
            if let card = home.rejoin {
                Section {
                    RejoinCardRow(card: card, onRejoin: { premeeting.rejoin() })
                        .listRowBackground(Color.clear)
                        .listRowSeparator(.hidden)
                        .listRowInsets(EdgeInsets(top: 8, leading: 0, bottom: 8, trailing: 0))
                }
            }
            if !home.recents.isEmpty {
                Section {
                    ForEach(home.recents) { row in
                        RecentMeetingRowView(
                            row: row,
                            onJoin: { premeeting.openRecent(id: row.id) },
                            onRemove: { premeeting.removeRecent(id: row.id) }
                        )
                    }
                } header: {
                    ConclaveSectionHeader(ConclaveStrings.text("Recent"), identifier: "home.recent.header")
                }
            }
            if home.recents.isEmpty && home.rejoin == nil {
                Section {
                    VStack(alignment: .leading, spacing: 8) {
                        Text(ConclaveStrings.text("No Recent Meetings"))
                            .font(.title2.weight(.semibold))
                        Text(ConclaveStrings.text("Start a meeting, or join one with a code or link."))
                            .font(.subheadline)
                            .foregroundStyle(HostingTheme.secondaryText)
                    }
                    .padding(.vertical, 20)
                    .accessibilityElement(children: .combine)
                    .accessibilityIdentifier("home.empty")
                    .listRowBackground(Color.clear)
                }
            }
        }
        .listStyle(.insetGrouped)
        .navigationTitle(ConclaveStrings.text("Conclave"))
        .toolbarTitleDisplayMode(.inlineLarge)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                if home.isSignedIn {
                    HomeAccountButton(isSignedIn: true, name: home.accountName, seed: home.accountSeed,
                                      action: { premeeting.openAccount() })
                }
            }
            ToolbarItemGroup(placement: .bottomBar) {
                Button(ConclaveStrings.text("Join")) { premeeting.openJoinSheet() }
                    .buttonStyle(.plain)
                    .controlSize(.large)
                    .tint(Color.primary)
                    .keyboardShortcut("j", modifiers: .command)
                    .accessibilityIdentifier("home.join")
                Spacer()
                Button {
                    premeeting.newMeeting()
                } label: {
                    Text(ConclaveStrings.text("New Meeting"))
                        .font(.headline)
                        .foregroundStyle(HostingTheme.coralText)
                }
                .buttonStyle(.plain)
                .controlSize(.large)
                .keyboardShortcut("n", modifiers: .command)
                .accessibilityIdentifier("home.newMeeting")
            }
        }
    }
}

private struct HomeAccountButton: View {
    let isSignedIn: Bool
    let name: String
    let seed: String
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            if isSignedIn {
                ConclaveAvatar(identity: ConclaveAvatarIdentity.make(name: name, id: seed), size: .chat, diameter: 28)
            } else {
                Image(systemName: PremeetingSymbols.account)
            }
        }
        .frame(minWidth: 44, minHeight: 44)
        .contentShape(Rectangle())
        .accessibilityLabel(isSignedIn && !name.isEmpty ? ConclaveStrings.format("Account, %@", name) : ConclaveStrings.text("Account"))
        .accessibilityIdentifier("home.account")
    }
}

private struct HomeUpdateBanner: View {
    let storeURL: String
    let onOpen: () -> Void
    @Environment(\.openURL) private var openURL

    var body: some View {
        ConclaveBanner(
            kind: .info,
            text: ConclaveStrings.text("This version of Conclave can no longer join meetings. Update to continue."),
            surface: .app,
            actions: [ConclaveBannerAction(title: ConclaveStrings.text("Update"), identifier: "home.update.action", action: open)],
            identifier: "home.update"
        )
        .listRowInsets(EdgeInsets())
        .listRowBackground(Color.clear)
    }

    private func open() {
        onOpen()
        if let url = URL(string: storeURL), !storeURL.isEmpty {
            openURL(url)
        }
    }
}

private struct HomeNoticeRow: View {
    let kind: HomeNoticeKind
    let onDismiss: () -> Void
    let onSignIn: () -> Void
    @State private var announced = HomeNoticeAnnouncementLatch()

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: PremeetingSymbols.info)
                .foregroundStyle(HostingTheme.secondaryText)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 8) {
                Text(HomeNoticeCopy.text(kind))
                    .font(.subheadline)
                    .fixedSize(horizontal: false, vertical: true)
                if kind == .sessionExpired {
                    Button(ConclaveStrings.text("Sign In"), action: onSignIn)
                        .buttonStyle(.borderless)
                        .tint(HostingTheme.coralText)
                        .accessibilityIdentifier("home.notice.signIn")
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            Button(action: onDismiss) {
                Image(systemName: PremeetingSymbols.close)
                    .frame(width: 44, height: 44)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .foregroundStyle(HostingTheme.secondaryText)
            .accessibilityLabel(ConclaveStrings.text("Dismiss"))
            .accessibilityIdentifier("home.notice.dismiss")
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("home.notice")
        .onAppear { announce() }
        .onChange(of: kind) { announce() }
    }

    private func announce() {
        guard announced.kind != kind else { return }
        announced.kind = kind
        HomeNoticeCopy.announce(kind)
    }
}

private final class HomeNoticeAnnouncementLatch {
    var kind: HomeNoticeKind = .none
}

enum HomeNoticeCopy {
    static func text(_ kind: HomeNoticeKind) -> String {
        switch kind {
        case .endedByHost:
            return ConclaveStrings.text("The host ended the meeting.")
        case .roomClosed:
            return ConclaveStrings.text("This meeting has ended.")
        case .invalidLink:
            return ConclaveStrings.text("This link can\u{2019}t be opened in Conclave.")
        case .sessionExpired:
            return ConclaveStrings.text("Your sign-in expired. Sign in again, or keep going as a guest.")
        case .movedToAudience:
            return ConclaveStrings.text("A host moved you to the audience.")
        case .none:
            return ""
        }
    }

    static func announce(_ kind: HomeNoticeKind) {
        let value = text(kind)
        guard !value.isEmpty else { return }
        AccessibilityNotification.Announcement(value).post()
    }
}

private struct RejoinCardRow: View {
    let card: RejoinCard
    let onRejoin: () -> Void
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    private var subtitle: String {
        card.end == .connectionLost
            ? ConclaveStrings.format("Connection lost at %@", card.endedAtText)
            : ConclaveStrings.format("Left at %@", card.endedAtText)
    }

    var body: some View {
        let layout = dynamicTypeSize.isAccessibilitySize
            ? AnyLayout(VStackLayout(alignment: .leading, spacing: 12))
            : AnyLayout(HStackLayout(spacing: 12))
        layout {
            VStack(alignment: .leading, spacing: 2) {
                Text(card.title)
                    .font(.headline)
                    .lineLimit(2)
                Text(subtitle)
                    .font(.subheadline)
                    .foregroundStyle(HostingTheme.secondaryText)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .accessibilityElement(children: .combine)
            Button(ConclaveStrings.text("Rejoin"), action: onRejoin)
                .fixedSize(horizontal: true, vertical: false)
                .buttonStyle(.bordered)
                .tint(Color.primary)
                .accessibilityLabel(ConclaveStrings.format("Rejoin %@", card.title))
                .accessibilityIdentifier("home.rejoin")
        }
        .accessibilityIdentifier("home.rejoin.card")
    }
}

private struct RecentMeetingRowView: View {
    let row: RecentMeetingRow
    let onJoin: () -> Void
    let onRemove: () -> Void
    @State private var copyCount = 0

    private var link: String {
        row.routeKind == .webinarLanding
            ? EntryPolicies.recentLink(roomId: row.roomId, isWebinar: true)
            : MeetingLinkBuilder.url(roomCode: row.roomId, clientId: nil)
    }

    private var subtitle: String {
        switch row.role {
        case .host:
            return row.relativeTime + " \u{00B7} " + ConclaveStrings.text("Host")
        case .attendee:
            return row.relativeTime + " \u{00B7} " + ConclaveStrings.text("Webinar")
        case .participant:
            return row.relativeTime
        }
    }

    var body: some View {
        NavigationLink(value: PremeetingRoute(id: row.routeId, kind: row.routeKind, roomId: row.roomId)) {
            VStack(alignment: .leading, spacing: 2) {
                Text(row.title)
                    .font(.body)
                    .lineLimit(2)
                Text(subtitle)
                    .font(.subheadline)
                    .foregroundStyle(HostingTheme.secondaryText)
            }
            .accessibilityElement(children: .combine)
        }
        .contextMenu {
            Button(ConclaveStrings.text("Join"), action: onJoin)
            Button(action: copyLink) {
                Label(ConclaveStrings.text("Copy Link"), systemImage: PremeetingSymbols.copyLink)
            }
            if let url = URL(string: link) {
                ShareLink(item: url,
                          subject: Text(ConclaveStrings.text("Join My Conclave Meeting")),
                          message: Text(ConclaveStrings.text("Join me in this Conclave meeting.")),
                          preview: SharePreview(row.title)) {
                    Label(ConclaveStrings.text("Share Invite"), systemImage: PremeetingSymbols.invite)
                }
            }
            Divider()
            Button(role: .destructive, action: onRemove) {
                Label(ConclaveStrings.text("Remove From Recents"), systemImage: PremeetingSymbols.delete)
            }
        }
        .swipeActions(edge: .trailing, allowsFullSwipe: true) {
            Button(role: .destructive, action: onRemove) {
                Label(ConclaveStrings.text("Remove"), systemImage: PremeetingSymbols.delete)
            }
        }
        .accessibilityAction(named: Text(ConclaveStrings.text("Join")), onJoin)
        .accessibilityAction(named: Text(ConclaveStrings.text("Copy Link")), copyLink)
        .accessibilityAction(named: Text(ConclaveStrings.text("Remove From Recents")), onRemove)
        .conclaveGestureFeedback(.linkCopied, trigger: copyCount)
        .accessibilityIdentifier("home.recent." + row.id)
    }

    private func copyLink() {
        UIPasteboard.general.string = link
        copyCount += 1
    }
}
#endif
