#if os(iOS) && !SKIP
import SwiftUI

// ENT-3 (S10 6 c, f, g, i, k) and ENT-5 (S10 8, 9: the in-place connecting, waiting and failed states of
// `EntryStatusBlock`): the iOS pre-join lobby, the `.lobby` destination
// of the premeeting NavigationStack. System appearance with the dark preview card; a plain `ScrollView { VStack }` so
// the card is never a lazy cell (F00 P5). Each leaf reads one of the six lobby snapshots: the card `lobbyMedia`, the
// bottom block `lobbyStatus`, the subtitle `lobbyPresence`, the identity rows `lobbyIdentity`, the link row
// `lobbyLink`, the audio rows `lobbyAudio` (S10 0.5, 6 k). No glass besides what the system draws for the navigation
// bar and the bottom bar container (S10 6 c "Glass", R9). Intent goes to the core through the presenter (D14).

struct LobbyView: View {
    let route: PremeetingRoute
    let premeeting: PremeetingPresenter
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass
    @Environment(\.verticalSizeClass) private var verticalSizeClass
    @State private var visibleHeight: CGFloat = 667

    /// Size classes only (IOS 3.2): the card beside the controls on regular width or compact height.
    private var isWide: Bool {
        horizontalSizeClass == .regular || verticalSizeClass == .compact
    }

    var body: some View {
        // AnyLayout keeps the card's identity across a rotation, so the preview surface is not recreated.
        let layout = isWide
            ? AnyLayout(HStackLayout(alignment: .top, spacing: 24))
            : AnyLayout(VStackLayout(alignment: .leading, spacing: 16))
        ScrollView {
            layout {
                LobbyPreviewCard(premeeting: premeeting, isWide: isWide, visibleHeight: visibleHeight)
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
        .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { visibleHeight = $0 }
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

/// The rows under the card, in focus order: issue, microphone permission, audio, name, invite code, link.
private struct LobbyControlsColumn: View {
    let premeeting: PremeetingPresenter

    var body: some View {
        // S50 PH20 (RECONCILE R30): the promotion lobby keeps your identity and has no link or Share.
        let isPromotion = premeeting.lobbyStatus?.intent == LobbyIntent.promotion
        VStack(alignment: .leading, spacing: 16) {
            LobbyIssueSection(premeeting: premeeting)
            LobbyMicrophonePermissionSection(premeeting: premeeting)
            LobbyAudioSection(premeeting: premeeting)
            if !isPromotion {
                LobbyIdentitySection(premeeting: premeeting)
                LobbyInviteCodeSection(premeeting: premeeting)
                LobbyGroupedSection {
                    MeetingLinkRow(premeeting: premeeting)
                }
            }
        }
    }
}

// MARK: - Issue rows (S10 6 f; C12 app style)

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
    /// Issue rows show while editing; while connecting only the offline row (S10 8 f: the pending primary stays).
    static func showsRow(_ status: LobbyStatusSnapshot) -> Bool {
        status.mode == .editing || (status.mode == .connecting && status.issue == .offline)
    }

    /// The issue row text, or nil when the issue has no row (invite code issues live in the invite field's footer).
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

/// S10 7 c: the microphone permission row under the card (denied with Open Settings, restricted without).
private struct LobbyMicrophonePermissionSection: View {
    let premeeting: PremeetingPresenter

    var body: some View {
        if let media = premeeting.lobbyMedia, media.micPermission == .denied || media.micPermission == .restricted {
            LobbyGroupedSection {
                LobbyGroupedRow {
                    VStack(alignment: .leading, spacing: 6) {
                        Label {
                            Text(ConclaveStrings.text("Microphone Access Is Off"))
                                .font(.subheadline.weight(.semibold))
                        } icon: {
                            Image(systemName: ConclaveSymbols.micSlash)
                                .foregroundStyle(HostingTheme.statusWarning)
                                .accessibilityHidden(true)
                        }
                        Text(media.micPermission == .restricted
                             ? ConclaveStrings.text("Microphone access is restricted on this device.")
                             : ConclaveStrings.text("Allow microphone access in Settings so people can hear you."))
                            .font(.footnote)
                            .foregroundStyle(HostingTheme.secondaryText)
                            .fixedSize(horizontal: false, vertical: true)
                        if media.micPermission == .denied {
                            Button(ConclaveStrings.text("Open Settings")) { premeeting.openSystemSettings() }
                                .buttonStyle(.borderless)
                                .tint(HostingTheme.coralText)
                                .accessibilityIdentifier("lobby.microphone.openSettings")
                        }
                    }
                }
            }
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier("lobby.microphone.denied")
        }
    }
}

// MARK: - Audio (S10 6 c L3)

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

// MARK: - Identity (S10 6 c identity row; R38)

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

/// The guest name field (40 at most, counter from 30) and Sign In. The field keeps its own text; the presenter gets
/// every change (it only re-derives the primary's reason and the avatar).
private struct LobbyGuestNameSection: View {
    let premeeting: PremeetingPresenter
    let identity: LobbyIdentitySnapshot
    @State private var name = ""

    var body: some View {
        LobbyGroupedSection(footer: ConclaveStrings.text("Shown to others in the meeting."),
                            footerIdentifier: "lobby.name.footer") {
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
                Button(ConclaveStrings.text("Sign In")) { premeeting.openAccount() }
                    .buttonStyle(.borderless)
                    .tint(HostingTheme.coralText)
                    .accessibilityIdentifier("lobby.signIn")
            }
        }
        .task(id: identity.routeId) {
            // Seeds once per lobby from the stored guest record; never on a body re-run.
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

/// The invite code field, shown after the server asked for one (S10 6 f form errors).
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

// MARK: - Bottom block (S10 6 c, 8 c, 9 c: ENT-5's EntryStatusBlock in all four modes)

private struct LobbyBottomBar: ViewModifier {
    let premeeting: PremeetingPresenter
    let routeId: Int

    func body(content: Content) -> some View {
        if #available(iOS 26.0, *) {
            content.safeAreaBar(edge: .bottom) {
                EntryStatusBlock(premeeting: premeeting, routeId: routeId)
            }
        } else {
            content.safeAreaInset(edge: .bottom, spacing: 0) {
                EntryStatusBlock(premeeting: premeeting, routeId: routeId)
                    .background(Color(uiColor: .systemGroupedBackground))
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

// MARK: - Title, presence and chrome

/// The inline title (room label) and the subtitle: presence while editing, "Joining" or "Reconnecting" while
/// connecting, nothing while waiting (S10 8 c, 9 c); iOS 26 `navigationSubtitle`; iOS 17 to 25 a principal item with
/// title and caption. Presence changes are not announced (S10 6 i).
private struct LobbyTitle: ViewModifier {
    let premeeting: PremeetingPresenter
    let route: PremeetingRoute

    func body(content: Content) -> some View {
        let status = premeeting.lobbyStatus?.routeId == route.id ? premeeting.lobbyStatus : nil
        // S10 6 g (RECONCILE R30): the promotion lobby's title is "Join as a Speaker".
        let title = status?.intent == LobbyIntent.promotion ? ConclaveStrings.text("Join as a Speaker")
            : (premeeting.lobbyLink?.roomLabel ?? route.roomId)
        let subtitle = EntryStatusCopy.subtitle(status: status, presence: premeeting.lobbyPresence)
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

/// Share in the toolbar; while connecting or waiting the back button gives way to Cancel (S10 8, 9).
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
                        // S50 PH20: Cancel declines while still an attendee (`webinar:declineStage`).
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
