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
///
/// ENT-5 (S10 8 c, 0.6 L10): the root owns the entry transition's anchor store (the lobby card writes its frame
/// there, the call branch reads it once) and drops the premeeting stack from the view tree once the call content
/// covers it (its state stays in the presenter); the stack comes back, under the fading call content, the moment the
/// 0.4 table leaves the call.
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
    /// ENT-5: the interim call content is a stage surface (the L9 fixture's dark stand-in), so it takes the card
    /// expansion like the native CallRoot; the production interim (the legacy call root) always cross-fades.
    let interimIsStage: Bool
    /// A caller-owned anchor store (the L9 fixture reads it for its readout); nil uses the root's own.
    let externalAnchors: EntryTransitionAnchorStore?
    let interimCall: () -> InterimCall
    @State private var ownAnchors = EntryTransitionAnchorStore()
    @State private var callCoversPremeeting = false

    init(shell: MeetingShellPresenter, premeeting: PremeetingPresenter, usesNativeCallRoot: Bool,
         stage: StagePresenter? = nil, people: PeoplePresenter? = nil, activitySession: ActivitySession? = nil,
         interimIsStage: Bool = false, anchors: EntryTransitionAnchorStore? = nil,
         @ViewBuilder interimCall: @escaping () -> InterimCall) {
        self.shell = shell
        self.premeeting = premeeting
        self.usesNativeCallRoot = usesNativeCallRoot
        self.stage = stage
        self.people = people
        self.activitySession = activitySession
        self.interimIsStage = interimIsStage
        self.externalAnchors = anchors
        self.interimCall = interimCall
    }

    private var anchors: EntryTransitionAnchorStore {
        externalAnchors ?? ownAnchors
    }

    /// The premeeting stack stays composed until the call content covers it, and returns as soon as the call ends.
    private var showsPremeeting: Bool {
        premeeting.root.root != .call || !callCoversPremeeting
    }

    var body: some View {
        ZStack {
            if showsPremeeting {
                PremeetingRoot(shell: shell, premeeting: premeeting)
                    .environment(\.entryTransitionAnchors, anchors)
            }
            NativeCallBranch(shell: shell, premeeting: premeeting, usesNativeCallRoot: usesNativeCallRoot,
                             stage: stage, people: people, activitySession: activitySession, anchors: anchors,
                             interimIsStage: interimIsStage, onCovered: callDidCoverPremeeting,
                             interimCall: interimCall)
        }
        .onChange(of: premeeting.root.root) { _, kind in
            if kind != .call && callCoversPremeeting {
                callCoversPremeeting = false
            }
        }
    }

    private func callDidCoverPremeeting() {
        anchors.clear()
        guard premeeting.root.root == .call, !callCoversPremeeting else { return }
        callCoversPremeeting = true
        // S10 8 i: the screen changed; VoiceOver moves to the call root.
        AccessibilityNotification.ScreenChanged().post()
    }
}

/// The call branch of the 0.4 table: shown only while `premeeting.root.root == .call` (in call, leaving after an
/// admission, recovering after an admission). CALL-ROOT SLOT: B3-T2 (STG-1) mounts its CallRoot here when
/// `usesNativeCallRoot` (the Debug `call` key) is on, by HD request; until then, and always when the key is off,
/// the interim call content shows. The switch prompt attaches here while the stage shows, so it inherits the dark
/// call appearance (S10 4 c).
///
/// ENT-5 (S10 8 c, m): the way in is the card expansion into the native CallRoot (and the fixture's stage stand-in)
/// when the lobby card recorded its frame and motion is allowed, else `ConclaveMotion.crossFade`; the interim legacy
/// call root always cross-fades in and out; leaving a call cross-fades to the outcome or Home (no reverse expansion).
struct NativeCallBranch<InterimCall: View>: View {
    let shell: MeetingShellPresenter
    let premeeting: PremeetingPresenter
    let usesNativeCallRoot: Bool
    let stage: StagePresenter?
    let people: PeoplePresenter?
    let activitySession: ActivitySession?
    let anchors: EntryTransitionAnchorStore?
    let interimIsStage: Bool
    let onCovered: () -> Void
    let interimCall: () -> InterimCall
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.self) private var environment

    /// Reduce Motion, or the iOS 26.4 cross-fade preference (S10 8 c).
    private var prefersCrossFade: Bool {
        if reduceMotion {
            return true
        }
        if #available(iOS 26.4, *) {
            return environment.accessibilityPrefersCrossFadeTransitions
        }
        return false
    }

    /// The card frame the expansion starts from, read only while the call shows (so the lobby snapshot is a
    /// dependency only then); nil cross-fades.
    private func expansionStart(expandsIntoCall: Bool) -> CGRect? {
        guard premeeting.root.root == .call else { return nil }
        let routeId = premeeting.lobbyStatus?.routeId ?? 0
        let frame = anchors?.frame(forRoute: routeId)
        let style = EntryTransitionPolicy.style(entersCall: true, expandsIntoCall: expandsIntoCall,
                                                hasCardFrame: frame != nil, prefersCrossFade: prefersCrossFade)
        return style == .expand ? frame : nil
    }

    var body: some View {
        let nativeStart = expansionStart(expandsIntoCall: true)
        let interimStart = expansionStart(expandsIntoCall: interimIsStage)
        ZStack {
            if premeeting.root.root == .call, usesNativeCallRoot, let stage {
                // STG-1 (HD request B3-T2 R5): the native call root. The control bar reads the controls presenter from
                // the environment (CTL-1, HD request B4-T6 R9); People (PPL-1) and the activity session (ACT-1) are
                // threaded.
                CallRoot(shell: shell, stage: stage, people: people, renderers: .live, activitySession: activitySession)
                    .entryExpansion(start: nativeStart, onCovered: onCovered)
                    .modifier(PremeetingSwitchAlert(premeeting: premeeting, isActive: true))
                    // S50 PH20 (PPL-7, RECONCILE R30): the promotion lobby as a large sheet over the playing viewer.
                    .modifier(PromotionLobbySheet(premeeting: premeeting))
                    .transition(.asymmetric(insertion: nativeStart == nil ? .opacity : .identity, removal: .opacity))
            } else if premeeting.root.root == .call {
                interimCall()
                    .entryExpansion(start: interimStart, onCovered: onCovered)
                    .modifier(PremeetingSwitchAlert(premeeting: premeeting, isActive: true))
                    .transition(.asymmetric(insertion: interimStart == nil ? .opacity : .identity, removal: .opacity))
            }
        }
        // Scoped to the root flip: the call content's insertion and removal, never the call's own updates.
        .animation(ConclaveMotion.crossFade, value: premeeting.root.root)
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

/// Home, or the outcome screen as the root content (S10 0.4 outcome rows; the presenter sets `path = []`): ENT-6's
/// `OutcomeView` (S/Features/Outcome), with Rejoin and Try Again while a rejoin context exists.
private struct PremeetingRootContent: View {
    let premeeting: PremeetingPresenter

    var body: some View {
        if let outcome = premeeting.outcome {
            OutcomeView(outcome: outcome, premeeting: premeeting)
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
        case .settings:
            // Android only (`SettingsKey`); iOS opens app-scope Settings inside the Account sheet.
            EmptyView()
        }
    }
}

// MARK: - Stand-ins until their slices land (the outcome screen is ENT-6's OutcomeView)

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
    @State private var anchors = EntryTransitionAnchorStore()

    init(state: PremeetingFixtureState) {
        _session = State(initialValue: PremeetingFixtureSession(state: state))
    }

    var body: some View {
        // ENT-5: the dark stand-in is a stage surface, so `connecting-to-call` shows the card expansion (S10 8 l2).
        NativeAppRoot(shell: session.shell, premeeting: session.premeeting, usesNativeCallRoot: false,
                      interimIsStage: true, anchors: anchors) {
            PremeetingFixtureCallStandIn()
        }
        .overlay(alignment: .bottomLeading) {
            PremeetingFixtureReadout(session: session, anchors: anchors)
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
    let anchors: EntryTransitionAnchorStore

    var body: some View {
        HStack(spacing: 0) {
            Color.clear
                .frame(width: 1, height: 1)
                .accessibilityElement()
                .accessibilityLabel(Text(verbatim: session.state.rawValue + " " + session.selfCheckReadout))
                .accessibilityIdentifier(PremeetingFixtureScript.selfCheckKey)
            // ENT-5 (S10 8 l8): the card frame the expansion started from, re-read with each self-check update.
            Color.clear
                .frame(width: 1, height: 1)
                .accessibilityElement()
                .accessibilityLabel(Text(verbatim: anchors.readout + " " + session.selfCheckReadout))
                .accessibilityIdentifier(PremeetingFixtureScript.entryAnchorKey)
        }
    }
}
#endif
#endif
