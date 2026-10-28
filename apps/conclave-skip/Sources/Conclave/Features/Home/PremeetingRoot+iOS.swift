#if os(iOS) && !SKIP
import SwiftUI

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

            ContentView(appState: appState)
        }

        .environment(viewModel.controls)
        .conclavePremeetingFeedback(premeeting: viewModel.premeeting)
    }
}

struct NativeAppRoot<InterimCall: View>: View {
    let shell: MeetingShellPresenter
    let premeeting: PremeetingPresenter
    let usesNativeCallRoot: Bool

    let stage: StagePresenter?

    let people: PeoplePresenter?

    let activitySession: ActivitySession?

    let interimIsStage: Bool

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
        .modifier(ConclaveAppAppearance(isCall: premeeting.root.root == .call))
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

        AccessibilityNotification.ScreenChanged().post()
    }
}

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

    private var prefersCrossFade: Bool {
        if reduceMotion {
            return true
        }
        if #available(iOS 26.4, *) {
            return environment.accessibilityPrefersCrossFadeTransitions
        }
        return false
    }

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

                CallRoot(shell: shell, stage: stage, people: people, renderers: .live, activitySession: activitySession)
                    .entryExpansion(start: nativeStart, onCovered: onCovered)
                    .modifier(PremeetingSwitchAlert(premeeting: premeeting, isActive: true))

                    .modifier(PromotionLobbySheet(premeeting: premeeting))
                    .transition(.asymmetric(insertion: nativeStart == nil ? .opacity : .identity, removal: .opacity))
            } else if premeeting.root.root == .call {
                interimCall()
                    .entryExpansion(start: interimStart, onCovered: onCovered)
                    .modifier(PremeetingSwitchAlert(premeeting: premeeting, isActive: true))
                    .transition(.asymmetric(insertion: interimStart == nil ? .opacity : .identity, removal: .opacity))
            }
        }

        .animation(ConclaveMotion.crossFade, value: premeeting.root.root)
    }
}

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

        .modifier(PremeetingSwitchAlert(premeeting: premeeting, isActive: premeeting.root.root != .call))
    }
}

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

private struct PremeetingDestination: View {
    let route: PremeetingRoute
    let premeeting: PremeetingPresenter

    var body: some View {
        switch route.kind {
        case .lobby:
            LobbyView(route: route, premeeting: premeeting)
        case .webinarLanding:
            WebinarLandingView(route: route, premeeting: premeeting)
        case .account:

            AccountList(account: premeeting.account, usesRouteLinks: false)
        case .privacyPolicy:
            PrivacyPolicyScreen()
        case .settings:

            EmptyView()
        }
    }
}

struct PremeetingSwitchAlert: ViewModifier {
    let premeeting: PremeetingPresenter

    let isActive: Bool

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

#if DEBUG

struct PremeetingFixtureRoot: View {
    @State private var session: PremeetingFixtureSession
    @State private var anchors = EntryTransitionAnchorStore()

    init(state: PremeetingFixtureState) {
        _session = State(initialValue: PremeetingFixtureSession(state: state))
    }

    var body: some View {

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

private struct PremeetingFixtureCallStandIn: View {
    var body: some View {
        HostingTheme.token(DesignTokens.iosInCallStage)
            .ignoresSafeArea()
            .accessibilityIdentifier("premeeting.fixture.call")
    }
}

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
