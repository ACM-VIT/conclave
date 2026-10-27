#if os(iOS) && !SKIP
import SwiftUI

// ENT-1 (S10 0.4, 1 c): the iOS native roots. `NativeAppRoot` is the 0.4 phase table on screen: the premeeting stack
// always, and the call branch above it while `premeeting.root` says call. Both take their presenters as parameters,
// so the L9 fixture hands them standalone instances; no view here reads `MeetingViewModel.shared` except the
// production wrapper, behind the Debug `premeeting` route flag (PLAN-screens 2).

/// The production native root (behind the flag): the view model's presenters, the one-time wiring before the first
/// frame (S10 1 c), the premeeting feedback delivery and, as the interim call content, the legacy call root.
struct NativePremeetingProductionRoot: View {
    let appState: AppState
    @State private var viewModel = MeetingViewModel.shared

    init(appState: AppState) {
        self.appState = appState
        PremeetingAppWiring.install(appState: appState, viewModel: MeetingViewModel.shared)
    }

    var body: some View {
        NativeAppRoot(shell: viewModel.shell, premeeting: viewModel.premeeting,
                      usesNativeCallRoot: NativeRouteFlags.shared.isEnabled(.call), stage: viewModel.stage,
                      people: viewModel.people, activitySession: viewModel.activitySession) {
            // Interim call content (S10 8 m): the legacy call root, which draws only call states on this route.
            ContentView(appState: appState)
        }
        // CTL-1 (HD request B4-T6 R9): the native call root's control bar reads the controls presenter from here.
        .environment(viewModel.controls)
        .conclavePremeetingFeedback(premeeting: viewModel.premeeting)
    }
}

/// The S10 0.4 root: `ZStack { PremeetingRoot; if call { call branch } }`. No `.preferredColorScheme` here: the
/// premeeting stack follows the system appearance and the call content owns its dark scope (F00 A7).
struct NativeAppRoot<InterimCall: View>: View {
    let shell: MeetingShellPresenter
    let premeeting: PremeetingPresenter
    let usesNativeCallRoot: Bool
    /// STG-1 (HD request B3-T2 R5): the session's stage presenter for the native call root; nil (the L9 fixture)
    /// always shows the interim call content.
    let stage: StagePresenter?
    /// PPL-1 (HD request B4-T7 R6): the session's People presenter for the native Participants panel; nil (the L9
    /// fixture) keeps the empty native shell.
    let people: PeoplePresenter?
    /// ACT-1, ACT-2, STG-9 (HD request B4-T8 R5c): the session's activity presenters; nil in the L9 fixture.
    let activitySession: ActivitySession?
    let interimCall: () -> InterimCall

    init(shell: MeetingShellPresenter, premeeting: PremeetingPresenter, usesNativeCallRoot: Bool,
         stage: StagePresenter? = nil, people: PeoplePresenter? = nil, activitySession: ActivitySession? = nil,
         @ViewBuilder interimCall: @escaping () -> InterimCall) {
        self.shell = shell
        self.premeeting = premeeting
        self.usesNativeCallRoot = usesNativeCallRoot
        self.stage = stage
        self.people = people
        self.activitySession = activitySession
        self.interimCall = interimCall
    }

    var body: some View {
        ZStack {
            PremeetingRoot(shell: shell, premeeting: premeeting)
            NativeCallBranch(shell: shell, premeeting: premeeting, usesNativeCallRoot: usesNativeCallRoot,
                             stage: stage, people: people, activitySession: activitySession, interimCall: interimCall)
        }
    }
}

/// The call branch of the 0.4 table: shown only while `premeeting.root.root == .call` (in call, leaving after an
/// admission, recovering after an admission). CALL-ROOT SLOT: B3-T2 (STG-1) mounts its CallRoot here when
/// `usesNativeCallRoot` (the Debug `call` key) is on, by HD request; until then, and always when the key is off,
/// the interim call content shows. The switch prompt attaches here while the stage shows, so it inherits the dark
/// call appearance (S10 4 c).
struct NativeCallBranch<InterimCall: View>: View {
    let shell: MeetingShellPresenter
    let premeeting: PremeetingPresenter
    let usesNativeCallRoot: Bool
    let stage: StagePresenter?
    let people: PeoplePresenter?
    let activitySession: ActivitySession?
    let interimCall: () -> InterimCall

    var body: some View {
        if premeeting.root.root == .call, usesNativeCallRoot, let stage {
            // STG-1 (HD request B3-T2 R5): the native call root. The control bar reads the controls presenter from the
            // environment (CTL-1, HD request B4-T6 R9); People (PPL-1) and the activity session (ACT-1) are threaded.
            CallRoot(shell: shell, stage: stage, people: people, renderers: .live, activitySession: activitySession)
                .modifier(PremeetingSwitchAlert(premeeting: premeeting, isActive: true))
                .transition(.opacity)
        } else if premeeting.root.root == .call {
            interimCall()
                .modifier(PremeetingSwitchAlert(premeeting: premeeting, isActive: true))
                .transition(.opacity)
        }
    }
}

/// The premeeting stack (S10 2 c): `NavigationStack(path:)` over Home or the outcome screen, the join and account
/// sheets, the update explanation and, while no call shows, the switch prompt.
struct PremeetingRoot: View {
    let shell: MeetingShellPresenter
    let premeeting: PremeetingPresenter

    private var pathBinding: Binding<[PremeetingRoute]> {
        Binding(get: { premeeting.path }, set: { premeeting.setPath($0) })
    }

    private var joinSheetBinding: Binding<Bool> {
        Binding(get: { premeeting.isJoinSheetPresented }, set: { if !$0 { premeeting.dismissJoinSheet() } })
    }

    private var accountSheetBinding: Binding<Bool> {
        Binding(get: { premeeting.isAccountSheetPresented }, set: { if !$0 { premeeting.dismissAccountSheet() } })
    }

    var body: some View {
        NavigationStack(path: pathBinding) {
            PremeetingRootContent(premeeting: premeeting)
                .navigationDestination(for: PremeetingRoute.self) { route in
                    PremeetingDestination(route: route, premeeting: premeeting)
                }
        }
        .sheet(isPresented: joinSheetBinding, onDismiss: { premeeting.joinSheetDidDismiss() }) {
            JoinCodeSheet(premeeting: premeeting)
        }
        .sheet(isPresented: accountSheetBinding, onDismiss: { premeeting.accountSheetDidDismiss() }) {
            AccountView(premeeting: premeeting, account: premeeting.account)
        }
        .modifier(PremeetingUpdatePrompt(premeeting: premeeting))
        // While the call branch shows, its own copy of the alert presents instead (dark, S10 4 c).
        .modifier(PremeetingSwitchAlert(premeeting: premeeting, isActive: premeeting.root.root != .call))
    }
}

/// Home, or the outcome screen as the root content (S10 0.4 outcome rows; the presenter sets `path = []`).
private struct PremeetingRootContent: View {
    let premeeting: PremeetingPresenter

    var body: some View {
        if let outcome = premeeting.outcome {
            PremeetingOutcomeStandIn(outcome: outcome, onBackHome: { premeeting.performOutcomeAction(.backHome) })
        } else {
            HomeView(premeeting: premeeting)
        }
    }
}

/// One destination per route kind. New kinds (ENT-7 account and privacy, ENT-9 webinar landing) replace their
/// stand-in here; the lobby is ENT-3's `LobbyView` (S/Features/Lobby).
private struct PremeetingDestination: View {
    let route: PremeetingRoute
    let premeeting: PremeetingPresenter

    var body: some View {
        switch route.kind {
        case .lobby:
            LobbyView(route: route, premeeting: premeeting)
        case .webinarLanding:
            PremeetingWebinarStandIn(route: route)
        case .account:
            // iOS presents Account as a sheet; a pushed account route (never pushed on iOS) shows the same list.
            AccountList(account: premeeting.account, usesRouteLinks: false)
        case .privacyPolicy:
            PrivacyPolicyScreen()
        }
    }
}

// MARK: - Stand-ins until their slices land

/// The webinar landing stand-in (ENT-9 builds the landing).
private struct PremeetingWebinarStandIn: View {
    let route: PremeetingRoute

    var body: some View {
        List {
            Section {
                LabeledContent(ConclaveStrings.text("Webinar"), value: route.roomId)
                    .accessibilityIdentifier("webinar.room")
            }
        }
        .listStyle(.insetGrouped)
        .navigationTitle(route.roomId)
        .navigationBarTitleDisplayMode(.inline)
    }
}

/// The outcome stand-in (ENT-6 adds Rejoin and Try Again with the rejoin context): C14 with the variant's copy and
/// Back to Home.
private struct PremeetingOutcomeStandIn: View {
    let outcome: OutcomeModel
    let onBackHome: () -> Void

    var body: some View {
        ContentUnavailableView {
            Label(PremeetingOutcomeCopy.title(outcome.variant), systemImage: PremeetingSymbols.error)
                .accessibilityAddTraits(.isHeader)
        } description: {
            VStack(spacing: 8) {
                if !PremeetingOutcomeCopy.body(outcome.variant).isEmpty {
                    Text(PremeetingOutcomeCopy.body(outcome.variant))
                }
                if !outcome.serverDetail.isEmpty {
                    Text(outcome.serverDetail)
                }
            }
        } actions: {
            Button(ConclaveStrings.text("Back to Home"), action: onBackHome)
                .buttonStyle(.bordered)
                .tint(Color.primary)
                .accessibilityIdentifier("outcome.backHome")
        }
        .accessibilityIdentifier("outcome." + outcome.variant.rawValue)
    }
}

enum PremeetingOutcomeCopy {
    static func title(_ variant: OutcomeVariant) -> String {
        switch variant {
        case .removed:
            return ConclaveStrings.text("Removed From Meeting")
        case .denied:
            return ConclaveStrings.text("Request Declined")
        case .connectionLost:
            return ConclaveStrings.text("Connection Lost")
        case .serverDisconnected:
            return ConclaveStrings.text("You Were Disconnected")
        case .rejoinFailed:
            return ConclaveStrings.text("Couldn\u{2019}t Rejoin")
        }
    }

    static func body(_ variant: OutcomeVariant) -> String {
        switch variant {
        case .removed:
            return ConclaveStrings.text("The host removed you from this meeting.")
        case .denied:
            return ConclaveStrings.text("Someone in the meeting declined your request to join.")
        case .connectionLost:
            return ConclaveStrings.text("Check your connection, then rejoin.")
        case .serverDisconnected:
            return ConclaveStrings.text("The meeting server ended your connection. You can rejoin.")
        case .rejoinFailed:
            return ""
        }
    }
}

// MARK: - Alerts

/// S10 4 c: "Join Another Meeting?" with Stay (cancel role) and Leave and Join (default, not destructive).
struct PremeetingSwitchAlert: ViewModifier {
    let premeeting: PremeetingPresenter
    /// One attachment presents at a time: the call branch's while the stage shows, the premeeting root's otherwise.
    let isActive: Bool

    /// The buttons decide (Stay is the cancel role); the setter never consumes the prompt, so the order in which the
    /// system clears the binding and runs a button action cannot turn Leave and Join into Stay.
    private var isPresented: Binding<Bool> {
        Binding(get: { isActive && premeeting.switchPrompt != nil }, set: { _ in })
    }

    func body(content: Content) -> some View {
        content.alert(ConclaveStrings.text("Join Another Meeting?"), isPresented: isPresented,
                      presenting: premeeting.switchPrompt) { prompt in
            Button(ConclaveStrings.text("Stay"), role: .cancel) { premeeting.stay(id: prompt.id) }
            Button(ConclaveStrings.text("Leave and Join")) { premeeting.confirmSwitch(id: prompt.id) }
        } message: { prompt in
            Text(ConclaveStrings.format("You\u{2019}re in %@. Leave it and join %@?",
                                        prompt.currentLabel.isEmpty ? ConclaveStrings.text("your current meeting") : prompt.currentLabel,
                                        prompt.targetLabel.isEmpty ? ConclaveStrings.text("another meeting") : prompt.targetLabel))
        }
    }
}

/// R51: the "Update Conclave" explanation New Meeting, Join, Rejoin and links open instead of the lobby.
private struct PremeetingUpdatePrompt: ViewModifier {
    let premeeting: PremeetingPresenter
    @Environment(\.openURL) private var openURL

    private var isPresented: Binding<Bool> {
        Binding(get: { premeeting.isUpdatePromptPresented }, set: { if !$0 { premeeting.dismissUpdatePrompt() } })
    }

    func body(content: Content) -> some View {
        content.alert(ConclaveStrings.text("Update Conclave"), isPresented: isPresented) {
            Button(ConclaveStrings.text("Cancel"), role: .cancel) { premeeting.dismissUpdatePrompt() }
            Button(ConclaveStrings.text("Update")) {
                let storeURL = premeeting.home.storeURL
                premeeting.openStoreListing()
                if let url = URL(string: storeURL), !storeURL.isEmpty {
                    openURL(url)
                }
            }
        } message: {
            Text(ConclaveStrings.text("This version of Conclave can no longer join meetings. Update to continue."))
        }
    }
}

// MARK: - L9 fixture (Debug)

#if DEBUG
/// S10 L9: the production roots over a standalone fixture session. The call branch shows a dark stand-in (the
/// fixture never mounts the legacy call root or a real stage), deep links reach the fixture presenter through the
/// app delegate, and the self-check readout is exposed to accessibility under `premeeting.fixture.selfCheck`.
struct PremeetingFixtureRoot: View {
    @State private var session: PremeetingFixtureSession

    init(state: PremeetingFixtureState) {
        _session = State(initialValue: PremeetingFixtureSession(state: state))
    }

    var body: some View {
        NativeAppRoot(shell: session.shell, premeeting: session.premeeting, usesNativeCallRoot: false) {
            PremeetingFixtureCallStandIn()
        }
        .overlay(alignment: .bottomLeading) {
            PremeetingFixtureReadout(session: session)
        }
        .onAppear {
            session.start()
            ConclaveAppDelegate.shared.registerPremeeting(session.premeeting)
        }
        .onDisappear {
            session.stop()
            ConclaveAppDelegate.shared.registerPremeeting(nil)
        }
        .onOpenURL { url in
            _ = ConclaveAppDelegate.shared.onOpenURL(url)
        }
    }
}

/// The call branch of the fixture: the always-dark stage surface, no renderer, no media.
private struct PremeetingFixtureCallStandIn: View {
    var body: some View {
        HostingTheme.token(DesignTokens.iosInCallStage)
            .ignoresSafeArea()
            .accessibilityIdentifier("premeeting.fixture.call")
    }
}

/// A one-point accessibility element carrying the ASCII self-check value; it draws nothing.
private struct PremeetingFixtureReadout: View {
    let session: PremeetingFixtureSession

    var body: some View {
        Color.clear
            .frame(width: 1, height: 1)
            .accessibilityElement()
            .accessibilityLabel(Text(verbatim: session.state.rawValue + " " + session.selfCheckReadout))
            .accessibilityIdentifier(PremeetingFixtureScript.selfCheckKey)
    }
}
#endif
#endif
