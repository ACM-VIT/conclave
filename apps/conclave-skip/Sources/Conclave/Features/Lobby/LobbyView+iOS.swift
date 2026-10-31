#if os(iOS) && !SKIP
import SwiftUI

struct LobbyView: View {
    let route: PremeetingRoute
    let premeeting: PremeetingPresenter
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass
    @Environment(\.verticalSizeClass) private var verticalSizeClass
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @State private var viewportSize = CGSize(width: 390, height: 667)
    @State private var visibleHeight: CGFloat = 0
    @State private var nameRevealed = false
    @FocusState private var isNameFocused: Bool

    private var isWide: Bool {
        viewportSize.width >= 640 && (horizontalSizeClass == .regular || verticalSizeClass == .compact)
    }

    private var revealsStatusReason: Bool {
        guard let status = premeeting.lobbyStatus, status.routeId == route.id else { return false }
        let reasonRows = LobbyStatusPolicy.rows(status: status, media: nil, supportsRationale: false, offersAppInfo: false)
        if reasonRows.contains(where: { $0.kind == .issue }) { return true }
        let refused = status.mode == .editing && [LobbyIssue.roomNotFound, .signInRequired, .failedServerText].contains(status.issue)
        guard status.mode == .failed || refused else { return false }
        let isSignedIn = premeeting.lobbyIdentity?.routeId == route.id && premeeting.lobbyIdentity?.isSignedIn == true
        return LobbyStatusCopy.line(status: status, isSignedIn: isSignedIn) != nil
    }

    var body: some View {
        let layout = isWide
            ? AnyLayout(HStackLayout(alignment: .top, spacing: 24))
            : AnyLayout(VStackLayout(alignment: .leading, spacing: 16))
        ScrollViewReader { proxy in
            ScrollView {
                layout {
                    LobbyPreviewCard(premeeting: premeeting, isWide: isWide, visibleHeight: viewportSize.height)
                        .frame(maxWidth: isWide ? 560 : .infinity)
                        .padding(.horizontal, isWide ? 0 : 16)
                    LobbyControlsColumn(premeeting: premeeting, nameFocus: $isNameFocused)
                        .frame(minWidth: isWide ? 360 : nil, maxWidth: isWide ? 420 : .infinity)
                }
                .padding(.horizontal, isWide ? 16 : 0)
                .padding(.vertical, 12)
            }
            .background(Color(uiColor: .systemGroupedBackground))
            .scrollDismissesKeyboard(.interactively)
            .accessibilityIdentifier("lobby")
            .onGeometryChange(for: CGSize.self) { $0.size } action: {
                if viewportSize != $0 { viewportSize = $0 }
            }
            .onGeometryChange(for: CGFloat.self) {
                $0.size.height - $0.safeAreaInsets.top - $0.safeAreaInsets.bottom
            } action: { height in
                let shrank = height < visibleHeight
                visibleHeight = height
                if shrank && isNameFocused && !nameRevealed {
                    nameRevealed = true
                    withAnimation(ConclaveMotion.travel(ConclaveMotion.snap, reduceMotion: reduceMotion)) {
                        proxy.scrollTo(LobbyScrollAnchor.name, anchor: LobbyScrollAnchor.nameReveal)
                    }
                }
            }
            .onChange(of: revealsStatusReason) { _, reveals in
                guard reveals, dynamicTypeSize.isAccessibilitySize else { return }
                withAnimation(ConclaveMotion.travel(ConclaveMotion.snap, reduceMotion: reduceMotion)) {
                    proxy.scrollTo(LobbyScrollAnchor.status, anchor: .top)
                }
            }
        }
        .onChange(of: isNameFocused) {
            if !isNameFocused { nameRevealed = false }
        }
        .modifier(LobbyBottomBar(premeeting: premeeting, routeId: route.id, nameFocused: isNameFocused))
        .modifier(LobbyTitle(premeeting: premeeting, route: route))
        .modifier(LobbyChrome(premeeting: premeeting, routeId: route.id))
        .task(id: route.id) {
            premeeting.lobbyDidAppear(routeId: route.id)
        }
        .onDisappear {
            premeeting.lobbyDidDisappear(routeId: route.id)
        }
    }
}

private enum LobbyScrollAnchor {
    case name
    case status

    static let nameReveal = UnitPoint(x: 0.5, y: 0.3)
}

private struct LobbyControlsColumn: View {
    let premeeting: PremeetingPresenter
    let nameFocus: FocusState<Bool>.Binding

    var body: some View {
        let isPromotion = premeeting.lobbyStatus?.intent == LobbyIntent.promotion
        VStack(alignment: .leading, spacing: 16) {
            VStack(alignment: .leading, spacing: 0) {
                LobbyStatusSection(premeeting: premeeting, nameFocused: nameFocus.wrappedValue)
                LobbyAudioSection(premeeting: premeeting)
            }
            .id(LobbyScrollAnchor.status)
            if !isPromotion {
                LobbyIdentitySection(premeeting: premeeting, nameFocus: nameFocus)
                AdmissionNotifySection(premeeting: premeeting)
                LobbyInviteCodeSection(premeeting: premeeting)
                if let link = premeeting.lobbyLink, link.canShare, !link.meetingLink.isEmpty {
                    LobbyGroupedSection {
                        MeetingLinkRow(premeeting: premeeting)
                    }
                }
            }
        }
        .modifier(LobbyInviteAnnouncement(premeeting: premeeting, isPromotion: isPromotion))
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
    let nameFocus: FocusState<Bool>.Binding

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
                LobbyGuestNameSection(premeeting: premeeting, identity: identity, nameFocus: nameFocus)
            }
        }
    }
}

private struct LobbyGuestNameSection: View {
    let premeeting: PremeetingPresenter
    let identity: LobbyIdentitySnapshot
    let nameFocus: FocusState<Bool>.Binding
    @State private var name = ""

    var body: some View {
        VStack(spacing: 20) {
            LobbyGroupedSection {
                LobbyGroupedRow {
                    HStack(spacing: 8) {
                        ConclaveTextField(ConclaveStrings.text("Your Name"), text: $name, kind: .name, identifier: "lobby.name")
                            .focused(nameFocus)
                        ConclaveCharacterCounter(count: name.count, limit: identity.nameLimit,
                                                 visibleFrom: DisplayNamePolicy.counterThreshold,
                                                 identifier: "lobby.name.counter")
                    }
                }
            }
            .id(LobbyScrollAnchor.name)
            Button { premeeting.openAccount() } label: {
                Text(ConclaveStrings.text("Sign In"))
                    .font(.headline)
                    .foregroundStyle(.primary)
                    .frame(maxWidth: .infinity, minHeight: 48)
                    .background(Color(uiColor: .secondarySystemGroupedBackground), in: Capsule())
                    .overlay { Capsule().strokeBorder(Color(uiColor: .separator), lineWidth: 1) }
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier("lobby.signIn")
            .padding(.horizontal, 16)
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
            LobbyGroupedSection(footer: identity.inviteCodeInvalid ? LobbyInviteCopy.invalid : ConclaveStrings.text("Enter the invite code from the host."),
                                footerIdentifier: identity.inviteCodeInvalid ? "lobby.invite.error" : "lobby.invite.footer") {
                LobbyGroupedRow {
                    TextField(ConclaveStrings.text("Invite Code"), text: $code)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .submitLabel(.join)
                        .onSubmit { premeeting.startOrJoin() }
                        .accessibilityIdentifier("lobby.invite")
                }
            }
            .onChange(of: code) {
                premeeting.setInviteCode(code)
            }
        }
    }
}

private struct LobbyInviteAnnouncement: ViewModifier {
    let premeeting: PremeetingPresenter
    let isPromotion: Bool

    func body(content: Content) -> some View {
        let identity = premeeting.lobbyIdentity
        let wrongCode = !isPromotion && identity?.needsInviteCode == true && identity?.inviteCodeInvalid == true
        content
            .onChange(of: wrongCode) { _, isWrong in
                if isWrong { EntryStatusAnnouncer.announce(LobbyInviteCopy.invalid) }
            }
    }
}

enum LobbyInviteCopy {
    static var invalid: String { ConclaveStrings.text("That code didn\u{2019}t work") }
}

private struct LobbyBottomBar: ViewModifier {
    let premeeting: PremeetingPresenter
    let routeId: Int
    let nameFocused: Bool

    func body(content: Content) -> some View {
        content
            .conclaveFloatingActionBar(shaded: true, over: Color(uiColor: .systemGroupedBackground)) {
                EntryStatusBlock(premeeting: premeeting, routeId: routeId, reservesNameReason: nameFocused)
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
        case .nameMissingJoin, .nameMissingStart:
            return ConclaveStrings.text("Add your name")
        case .offline:
            return ConclaveStrings.text("You\u{2019}re offline")
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
                .scrollEdgeEffectStyle(.soft, for: .top)
                .navigationTitle(title)
                .navigationBarTitleDisplayMode(.inline)
                .navigationSubtitle(subtitle)
                .toolbarBackground(.hidden, for: .navigationBar)
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
