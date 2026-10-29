#if os(iOS) && !SKIP
import SwiftUI

struct LobbyView: View {
    let route: PremeetingRoute
    let premeeting: PremeetingPresenter
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass
    @Environment(\.verticalSizeClass) private var verticalSizeClass
    @State private var viewportSize = CGSize(width: 390, height: 667)

    private var isWide: Bool {
        viewportSize.width >= 640 && (horizontalSizeClass == .regular || verticalSizeClass == .compact)
    }

    var body: some View {
        let layout = isWide
            ? AnyLayout(HStackLayout(alignment: .top, spacing: 24))
            : AnyLayout(VStackLayout(alignment: .leading, spacing: 16))
        ScrollView {
            layout {
                LobbyPreviewCard(premeeting: premeeting, isWide: isWide, visibleHeight: viewportSize.height)
                    .frame(maxWidth: isWide ? 560 : .infinity)
                    .padding(.horizontal, isWide ? 0 : 16)
                LobbyControlsColumn(premeeting: premeeting)
                    .frame(minWidth: isWide ? 360 : nil, maxWidth: isWide ? 420 : .infinity)
            }
            .padding(.horizontal, isWide ? 16 : 0)
            .padding(.vertical, 12)
        }
        .background(Color(uiColor: .systemGroupedBackground))
        .scrollDismissesKeyboard(.interactively)
        .onGeometryChange(for: CGSize.self) { $0.size } action: { viewportSize = $0 }
        .modifier(LobbyBottomBar(premeeting: premeeting, routeId: route.id))
        .modifier(LobbyTitle(premeeting: premeeting, route: route))
        .modifier(LobbyChrome(premeeting: premeeting, routeId: route.id))
        .task(id: route.id) {
            premeeting.lobbyDidAppear(routeId: route.id)
        }
        .onDisappear {
            premeeting.lobbyDidDisappear(routeId: route.id)
        }
        .accessibilityIdentifier("lobby")
    }
}

private struct LobbyControlsColumn: View {
    let premeeting: PremeetingPresenter

    var body: some View {
        let isPromotion = premeeting.lobbyStatus?.intent == LobbyIntent.promotion
        VStack(alignment: .leading, spacing: 16) {
            LobbyIssueSection(premeeting: premeeting)
            PermissionPrimingSection(premeeting: premeeting)
            LobbyAudioSection(premeeting: premeeting)
            if !isPromotion {
                LobbyIdentitySection(premeeting: premeeting)
                AdmissionNotifySection(premeeting: premeeting)
                LobbyInviteCodeSection(premeeting: premeeting)
                if let link = premeeting.lobbyLink, link.canShare, !link.meetingLink.isEmpty {
                    LobbyGroupedSection {
                        MeetingLinkRow(premeeting: premeeting)
                    }
                }
            }
        }
    }
}

private struct LobbyIssueSection: View {
    let premeeting: PremeetingPresenter

    var body: some View {
        if let status = premeeting.lobbyStatus, LobbyIssueCopy.showsRow(status), let text = LobbyIssueCopy.text(status) {
            LobbyGroupedSection {
                LobbyGroupedRow {
                    VStack(alignment: .leading, spacing: 8) {
                        Label {
                            Text(text)
                                .font(.subheadline)
                                .fixedSize(horizontal: false, vertical: true)
                        } icon: {
                            Image(systemName: ConclaveSymbols.exclamationmarkTriangleFill)
                                .foregroundStyle(HostingTheme.statusWarning)
                                .accessibilityHidden(true)
                        }
                        if status.issue == .signInRequired {
                            Button(ConclaveStrings.text("Sign In")) { premeeting.openAccount() }
                                .buttonStyle(.borderless)
                                .tint(HostingTheme.coralText)
                                .accessibilityIdentifier("lobby.issue.signIn")
                        }
                    }
                }
            }
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier("lobby.issue")
        }
    }
}

enum LobbyIssueCopy {
    static func showsRow(_ status: LobbyStatusSnapshot) -> Bool {
        status.mode == .editing || (status.mode == .connecting && status.issue == .offline)
    }

    static func text(_ status: LobbyStatusSnapshot) -> String? {
        switch status.issue {
        case .offline:
            if status.mode == .connecting {
                return ConclaveStrings.text("You\u{2019}re offline. Waiting for a connection.")
            }
            return ConclaveStrings.text("You\u{2019}re offline. Connect to the internet to join.")
        case .roomNotFound:
            return ConclaveStrings.text("No meeting found with this code. Check it and try again.")
        case .signInRequired:
            return ConclaveStrings.text("This meeting needs you to sign in.")
        case .appSuspended:
            return ConclaveStrings.text("Your phone has paused Conclave. Turn off Sleep mode or app restrictions for Conclave, then try again.")
        case .updateRequired:
            return ConclaveStrings.text("This version of Conclave can no longer join meetings. Update to continue.")
        case .failedServerText:
            return status.issueServerText.isEmpty ? nil : status.issueServerText
        case .none, .nameMissing, .inviteCodeRequired, .inviteCodeInvalid, .failedNetwork, .failedMedia,
             .failedServerBusy, .failedUnknown:
            return nil
        }
    }
}

private struct LobbyAudioSection: View {
    let premeeting: PremeetingPresenter

    var body: some View {
        let showsInput = premeeting.lobbyAudio?.showsInputRow ?? false
        LobbyGroupedSection {
            LobbyAudioRouteRow(premeeting: premeeting)
            if showsInput {
                LobbyGroupedDivider()
                LobbyMicrophoneInputRow(premeeting: premeeting)
            }
        }
    }
}

private struct LobbyIdentitySection: View {
    let premeeting: PremeetingPresenter

    var body: some View {
        if let identity = premeeting.lobbyIdentity {
            if identity.isSignedIn {
                LobbyGroupedSection {
                    LobbyGroupedRow {
                        LabeledContent {
                            Button(ConclaveStrings.text("Switch")) { premeeting.openAccount() }
                                .buttonStyle(.borderless)
                                .tint(HostingTheme.coralText)
                                .accessibilityIdentifier("lobby.identity.switch")
                        } label: {
                            Label {
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(ConclaveStrings.text("Joining as"))
                                        .font(.footnote)
                                        .foregroundStyle(HostingTheme.secondaryText)
                                    Text(identity.accountName)
                                        .lineLimit(2)
                                }
                            } icon: {
                                ConclaveAvatar(identity: ConclaveAvatarIdentity.make(name: identity.accountName,
                                                                                     id: identity.accountSeed),
                                               size: .chat, diameter: 28)
                            }
                        }
                    }
                }
                .accessibilityIdentifier("lobby.identity")
            } else {
                LobbyGuestNameSection(premeeting: premeeting, identity: identity)
            }
        }
    }
}

private struct LobbyGuestNameSection: View {
    let premeeting: PremeetingPresenter
    let identity: LobbyIdentitySnapshot
    @State private var name = ""

    var body: some View {
        LobbyGroupedSection {
            LobbyGroupedRow {
                HStack(spacing: 8) {
                    ConclaveTextField(ConclaveStrings.text("Your Name"), text: $name, kind: .name, identifier: "lobby.name")
                    ConclaveCharacterCounter(count: name.count, limit: identity.nameLimit,
                                             visibleFrom: DisplayNamePolicy.counterThreshold,
                                             identifier: "lobby.name.counter")
                }
            }
            LobbyGroupedDivider()
            LobbyGroupedRow {
                Button { premeeting.openAccount() } label: {
                    Text(ConclaveStrings.text("Sign In"))
                        .font(.headline)
                        .foregroundStyle(.primary)
                        .frame(maxWidth: .infinity, minHeight: 48)
                        .background(Color(uiColor: .tertiarySystemGroupedBackground), in: Capsule())
                        .overlay { Capsule().strokeBorder(Color(uiColor: .separator), lineWidth: 1) }
                }
                .buttonStyle(.plain)
                .accessibilityIdentifier("lobby.signIn")
            }
        }
        .task(id: identity.routeId) {
            if name != identity.guestName {
                name = identity.guestName
            }
        }
        .onChange(of: name) {
            let capped = DisplayNamePolicy.capped(name)
            if capped != name {
                name = capped
                return
            }
            premeeting.setGuestName(name)
        }
    }
}

private struct LobbyInviteCodeSection: View {
    let premeeting: PremeetingPresenter
    @State private var code = ""

    var body: some View {
        if let identity = premeeting.lobbyIdentity, identity.needsInviteCode {
            VStack(alignment: .leading, spacing: 6) {
                LobbyGroupedSection(footer: identity.inviteCodeInvalid ? "" : ConclaveStrings.text("Enter the invite code from the host."),
                                    footerIdentifier: "lobby.invite.footer") {
                    LobbyGroupedRow {
                        TextField(ConclaveStrings.text("Invite Code"), text: $code)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                            .submitLabel(.join)
                            .onSubmit { premeeting.startOrJoin() }
                            .accessibilityIdentifier("lobby.invite")
                    }
                }
                if identity.inviteCodeInvalid {
                    ConclaveFieldError(text: ConclaveStrings.text("That invite code didn\u{2019}t work. Check it and try again."),
                                       identifier: "lobby.invite.error")
                        .padding(.horizontal, 32)
                }
            }
            .onChange(of: code) {
                premeeting.setInviteCode(code)
            }
        }
    }
}

private struct LobbyBottomBar: ViewModifier {
    let premeeting: PremeetingPresenter
    let routeId: Int
    @State private var contentHeight: CGFloat = 0

    func body(content: Content) -> some View {
        let isEditing = premeeting.lobbyStatus?.routeId == routeId && premeeting.lobbyStatus?.mode == .editing
        content
            .safeAreaPadding(.bottom, contentHeight)
            .overlay(alignment: .bottom) {
                EntryStatusBlock(premeeting: premeeting, routeId: routeId)
                    .background {
                        if !isEditing { Color(uiColor: .systemGroupedBackground) }
                    }
                    .overlay(alignment: .top) {
                        if !isEditing { Divider() }
                    }
                    .onGeometryChange(for: CGFloat.self) { $0.size.height } action: {
                        if contentHeight != $0 { contentHeight = $0 }
                    }
            }
    }
}

enum LobbyPrimaryCopy {
    static func title(_ intent: LobbyIntent) -> String {
        switch intent {
        case .newMeeting:
            return ConclaveStrings.text("Start Meeting")
        case .promotion:
            return ConclaveStrings.text("Join as a Speaker")
        case .join, .rejoin, .resume:
            return ConclaveStrings.text("Join")
        }
    }

    static func reason(_ raw: String) -> String? {
        switch LobbyPrimaryReason(rawValue: raw) ?? LobbyPrimaryReason.none {
        case .nameMissingJoin:
            return ConclaveStrings.text("Add your name to join.")
        case .nameMissingStart:
            return ConclaveStrings.text("Add your name to start.")
        case .offline:
            return ConclaveStrings.text("You\u{2019}re offline. Connect to the internet to join.")
        case .updateRequired, .none:
            return nil
        }
    }
}

private struct LobbyTitle: ViewModifier {
    let premeeting: PremeetingPresenter
    let route: PremeetingRoute

    func body(content: Content) -> some View {
        let status = premeeting.lobbyStatus?.routeId == route.id ? premeeting.lobbyStatus : nil
        let roomLabel = premeeting.lobbyLink?.roomLabel ?? route.roomId
        let isNewMeeting = status?.intent == LobbyIntent.newMeeting
        let title = status?.intent == LobbyIntent.promotion ? ConclaveStrings.text("Join as a Speaker")
            : (isNewMeeting ? ConclaveStrings.text("New Meeting") : roomLabel)
        let subtitle = isNewMeeting && status?.mode == .editing ? ""
            : EntryStatusCopy.subtitle(status: status, presence: premeeting.lobbyPresence)
        if #available(iOS 26.0, *) {
            content
                .navigationTitle(title)
                .navigationBarTitleDisplayMode(.inline)
                .navigationSubtitle(subtitle)
        } else {
            content
                .navigationTitle(title)
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .principal) {
                        VStack(spacing: 0) {
                            Text(title)
                                .font(.headline)
                                .lineLimit(1)
                            if !subtitle.isEmpty {
                                Text(subtitle)
                                    .font(.caption)
                                    .foregroundStyle(HostingTheme.secondaryText)
                                    .lineLimit(1)
                            }
                        }
                        .accessibilityElement(children: .combine)
                        .accessibilityAddTraits(.isHeader)
                    }
                }
        }
    }
}

enum LobbyPresenceCopy {
    static func text(_ presence: LobbyPresenceSnapshot?) -> String {
        guard let presence else { return "" }
        switch presence.kind {
        case .hidden:
            return ""
        case .checking:
            return ConclaveStrings.text("Checking who\u{2019}s here")
        case .empty:
            return ConclaveStrings.text("No one here yet")
        case .count:
            return ConclaveStrings.format("%lld people here", presence.count)
        }
    }
}

private struct LobbyChrome: ViewModifier {
    let premeeting: PremeetingPresenter
    let routeId: Int

    func body(content: Content) -> some View {
        let status = premeeting.lobbyStatus
        let isBusy = status?.routeId == routeId && (status?.mode == .connecting || status?.mode == .waiting)
        let isPromotion = status?.routeId == routeId && status?.intent == LobbyIntent.promotion
        content
            .navigationBarBackButtonHidden(isBusy)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    MeetingShareLinkButton(premeeting: premeeting)
                }
                ToolbarItem(placement: .cancellationAction) {
                    if isPromotion {
                        Button(ConclaveStrings.text("Cancel"), role: .cancel) { premeeting.cancelPromotion() }
                            .accessibilityIdentifier("lobby.promotion.cancel")
                    } else if isBusy {
                        Button(ConclaveStrings.text("Cancel"), role: .cancel) { premeeting.cancelJoin() }
                            .accessibilityIdentifier("lobby.cancel")
                    }
                }
            }
    }
}
#endif
