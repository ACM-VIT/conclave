#if !SKIP
import Foundation
import Testing
@testable import Conclave

@MainActor
struct EntryCoreDeltaTests {

    @Test func nativeIntakeSendsConclaveLinksToTheRegisteredPresenter() {
        let delegate = ConclaveAppDelegate.shared
        let presenter = PremeetingPresenter()
        delegate.registerPremeeting(presenter)
        defer { delegate.registerPremeeting(nil) }

        #expect(delegate.routeNatively("conclave://"))
        #expect(presenter.home.noticeKind == .invalidLink)

        #expect(!delegate.routeNatively("https://example.com/x"))

        #expect(delegate.routeNatively("conclave://rose-sora-luffy"))
        #expect(presenter.path.last?.roomId == "rose-sora-luffy")
        #expect(presenter.lobbyStatus?.mode == .editing)
    }

    @Test func aLinkBeforeTheRootRegistersWaitsForIt() {
        let delegate = ConclaveAppDelegate.shared
        delegate.registerPremeeting(nil)
        #expect(delegate.routeNatively("https://conclave.acmvit.in/lily-zoro-iris"))
        let presenter = PremeetingPresenter()
        delegate.registerPremeeting(presenter)
        defer { delegate.registerPremeeting(nil) }

        #expect(presenter.path.map { $0.roomId } == ["lily-zoro-iris"])
    }

    @Test func theNativeRootsStayBehindTheDebugFlagsAndTheLegacyRootStaysTheDefault() throws {
        let app = try entrySource("Sources/Conclave/ConclaveApp.swift")

        #expect(app.components(separatedBy: ".conclaveRootFeedback(shell: MeetingViewModel.shared.shell)").count - 1 == 1)
        #expect(entryFlat(app).contains("if NativeRouteFlags.shared.isEnabled(.premeeting) { NativePremeetingProductionRoot(appState: appState) } else { legacyRoot }"))
        #expect(entryFlat(app).contains("} else if let premeetingFixture { PremeetingFixtureRoot(state: premeetingFixture) }"))
        #expect(app.contains("@State private var premeetingFixture = PremeetingFixtureScript.state(named: NativeRouteFlags.shared.premeetingFixture)"))
        #expect(app.contains("NativeRouteFlags.shared.configureFromLaunchEnvironment()"))

        #expect(entryFlat(app).contains("if NativeRouteFlags.shared.routesPremeetingNatively { return routeNatively(url.absoluteString) }"))
        #expect(entryFlat(app).contains("if NativeRouteFlags.shared.routesPremeetingNatively { _ = self.routeNatively(urlString) return }"))
        #expect(app.contains("AppState.shared.openJoinURL(url)"))
        #expect(app.contains("AppState.shared.openJoinURLString(urlString)"))

        #expect(app.contains("MeetingViewModel.shared.setPremeetingAppActive(true)"))
        #expect(app.contains("MeetingViewModel.shared.setPremeetingAppActive(false)"))

        let flags = try entrySource("Sources/Conclave/App/NativeRouteFlags.swift")
        #expect(entryFlat(flags).contains("func configure(routes: String?, premeetingFixture: String?, debugEligible: Bool) { guard debugEligible else { return }"))
        #expect(entryFlat(flags).contains("func configureFromLaunchEnvironment() { #if DEBUG && !SKIP"))

        let main = try entrySource("Android/app/src/main/kotlin/Main.kt")
        #expect(main.contains("debugEligible = BuildConfig.DEBUG && routesDebuggable,"))
        #expect(main.contains("(applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE) != 0"))
        #expect(main.contains("NativePremeetingHost(callContent = legacyRoot)"))
        #expect(main.contains("PremeetingFixtureHost(premeetingFixture)"))
        #expect(main.contains("NativeRouteLaunch.installProductionWiring()"))
        #expect(main.components(separatedBy: "ConclaveRootFeedback()").count - 1 == 1)
        let rootCall = try #require(main.range(of: "ConclaveRootFeedback()"))
        let pipBranch = try #require(main.range(of: "if (PipController.showsLegacyPipContent) {"))
        #expect(rootCall.lowerBound < pipBranch.lowerBound)
        #expect(main.components(separatedBy: "SideEffect { saveableStateHolder.removeState(FULL_ROOT_SAVEABLE_KEY) }").count - 1 == 1)

        #expect(entryFlat(main).contains("} else { legacyRoot() }"))

        let host = try entrySource("Sources/Conclave/Skip/ui/home/PremeetingHost.kt")
        #expect(host.contains("const val ROUTES_EXTRA = \"conclave.nativeRoutes\""))
        #expect(host.contains("const val PREMEETING_FIXTURE_EXTRA = \"conclave.premeetingFixture\""))
        #expect(host.contains("\ninternal fun PremeetingHost("))
        #expect(host.contains("\nfun NativePremeetingHost(callContent: @Composable () -> Unit) {"))
        #expect(host.contains("\nfun PremeetingFixtureHost(stateName: String) {"))
        #expect(entryFlat(host).contains("callContent: @Composable () -> Unit,"))
        #expect(entryFlat(host).contains("if (usesNativeCallRoot && stage != null) { CallRoot(shell = shell, stage = stage, people = people, renderers = StageRenderers.live, activitySession = activitySession, onMinimize = { stageMinimizeToBackground() }) } else { callContent() }"))
        #expect(host.components(separatedBy: "ConclaveSystemBars(").count - 1 == 1)
        #expect(host.contains("entryProvider = { key -> NavEntry(key) { _ -> PremeetingPage(premeeting, key) } }"))

        let ios = try entrySource("Sources/Conclave/Features/Home/PremeetingRoot+iOS.swift")
        #expect(ios.hasPrefix("#if os(iOS) && !SKIP\n"))
        #expect(ios.contains("let interimCall: () -> InterimCall"))
        #expect(entryFlat(ios).contains("interimIsStage: interimIsStage, onCovered: callDidCoverPremeeting, interimCall: interimCall)"))
        #expect(ios.contains("PremeetingAppWiring.install(appState: appState, viewModel: MeetingViewModel.shared)"))
        #expect(ios.contains(".conclavePremeetingFeedback(premeeting: viewModel.premeeting)"))
        #expect(!ios.contains(".preferredColorScheme("), "the premeeting stack follows the system appearance")
        #expect(entryFlat(ios).contains("if premeeting.root.root == .call { interimCall()"))
    }

    @Test func theLegacyGlassPromptNeverShowsBehindTheFlag() throws {
        let content = try entrySource("Sources/Conclave/App/ContentView.swift")
        #expect(entryFlat(content).contains("private var nativeRoutes: Bool { NativeRouteFlags.shared.routesPremeetingNatively }"))
        #expect(entryFlat(content).contains("if !nativeRoutes, pendingJoinPromptRequestID != nil,"))
        #expect(entryFlat(content).contains("private func handlePendingJoinURLIfNeeded() { guard !nativeRoutes else { pendingJoinPromptRequestID = nil return }"))
        #expect(entryFlat(content).contains("case .disconnected, .connecting, .connected: if nativeRoutes { nativeInterimBackdrop } else { JoinView(viewModel: meetingViewModel, appState: appState)"))

        for file in Self.newSwiftFiles + Self.newKotlinFiles {
            let text = try entrySource(file)
            #expect(!text.contains("glassEffect") && !text.contains("GlassEffectContainer") && !text.contains("acmGlass"), "\(file)")
        }
    }

    @Test func identityChangesReachThePresenterThroughTheAppStateHook() throws {
        let appState = try entrySource("Sources/Conclave/App/AppState.swift")
        #expect(appState.components(separatedBy: "persistAuthState()\n            onIdentityChanged?()").count - 1 == 3)
        #expect(appState.contains("@ObservationIgnored var onIdentityChanged: (() -> Void)? = nil"))
        let wiring = try entrySource("Sources/Conclave/Features/Home/PremeetingAppWiring.swift")
        let flat = entryFlat(wiring)

        let identity = try #require(flat.range(of: "let presenter = viewModel.premeeting pushIdentity(appState: appState, viewModel: viewModel)"))
        #expect(flat.contains("appState.onIdentityChanged = { PremeetingAppWiring.pushIdentity(appState: appState, viewModel: viewModel) }"))
        let bootstrap = try #require(flat.range(of: "presenter.bootstrap(user: appState.currentUser, recents: store.load())"))
        let register = try #require(flat.range(of: "ConclaveAppDelegate.shared.registerPremeeting(presenter)"))
        #expect(identity.lowerBound < bootstrap.lowerBound && bootstrap.lowerBound < register.lowerBound)
    }

    @Test func theViewModelFeedsThePremeetingPresenterFromTheShellRefresh() throws {
        let viewModel = try entrySource("Sources/Conclave/Features/Meeting/MeetingViewModel.swift")

        #expect(entryFlat(viewModel).contains("isApplyingShellInputs = true shell.apply(makeShellInputs()) isApplyingShellInputs = false callPresence.apply(makeCallPresenceInputs()) premeeting.apply(makePremeetingInputs()) if shell.session.phase != lastStageShellPhase {"))
        #expect(viewModel.contains("let premeeting = PremeetingPresenter()"))
        #expect(entryFlat(viewModel).contains("premeeting.onCommand = { [weak self] command in self?.performPremeetingCommand(command) }"))
        #expect(entryFlat(viewModel).contains("case .leave: shell.leave() case .dismissOutcome: shell.dismissOutcome()"))
    }

    @Test func newEntryFilesStayFlatDashFreeAndLiteralFree() throws {
        for file in Self.newSwiftFiles + Self.newKotlinFiles {
            let text = try entrySource(file)
            #expect(!text.contains("\u{2013}") && !text.contains("\u{2014}"), "\(file) has an en or em dash")
            #expect(!text.lowercased().contains("gradient"), "\(file)")
            #expect(entryMatches(#"(UIColor|Color)\(\s*(red:|\.sRGB|0x|hue:)"#, in: text).isEmpty, "\(file) builds a color from a literal")
            #expect(entryMatches(#"Color\(0x"#, in: text).isEmpty, "\(file)")
            #expect(!text.contains("@Stable") && !text.contains("@Immutable"), "\(file)")
            #expect(!text.contains("MeetingState"), "\(file) reads MeetingState")
        }
        for file in Self.newSwiftFiles where file.hasSuffix("+iOS.swift") {
            let text = try entrySource(file)
            #expect(text.hasPrefix("#if os(iOS) && !SKIP\n"), "\(file)")
            #expect(!text.contains("Image(systemName: \""), "\(file) names a raw symbol")
            #expect(entryMatches(#"(?:Text|Button|Label|navigationTitle|Section|LabeledContent)\(\s*""#, in: text).isEmpty, "\(file) has a literal label")
        }
        for file in Self.newKotlinFiles {
            let text = try entrySource(file)
            #expect(entryMatches(#"Text\(\s*""#, in: text).isEmpty, "\(file) has a literal Text")
            #expect(!text.contains("performHapticFeedback") && !text.contains("LocalHapticFeedback"), "\(file)")
        }

        for file in Self.sharedSwiftFiles {
            let text = try entrySource(file)
            #expect(!text.contains("import SwiftUI") && !text.contains("import UIKit"), "\(file)")
            #expect(entryMatches(#"\.(?:map|compactMap|flatMap)\(\s*[A-Za-z_][A-Za-z0-9_.]*\s*\)"#, in: text).isEmpty, "\(file)")
            #expect(!text.contains(".isLetter"), "\(file)")
        }
    }

    static let sharedSwiftFiles = [
        "Sources/Conclave/App/NativeRouteFlags.swift",
        "Sources/Conclave/Features/Home/PremeetingContracts.swift",
        "Sources/Conclave/Features/Home/PremeetingPresenter.swift",
        "Sources/Conclave/Features/Home/PremeetingFixtures.swift",
        "Sources/Conclave/Features/Home/PremeetingAppWiring.swift",
        "Sources/Conclave/Features/Home/RecentMeetingsStore.swift",
        "Sources/Conclave/Features/Join/EntryPolicies.swift"
    ]
    static let newSwiftFiles = sharedSwiftFiles + [
        "Sources/Conclave/Features/Home/HomeView+iOS.swift",
        "Sources/Conclave/Features/Home/PremeetingRoot+iOS.swift",
        "Sources/Conclave/Features/Join/JoinCodeSheet+iOS.swift"
    ]
    static let newKotlinFiles = [
        "Sources/Conclave/Skip/ui/home/HomeScreen.kt",
        "Sources/Conclave/Skip/ui/home/HomeRowsCache.kt",
        "Sources/Conclave/Skip/ui/home/PremeetingBackStack.kt",
        "Sources/Conclave/Skip/ui/home/PremeetingHost.kt",
        "Sources/Conclave/Skip/ui/join/JoinCodeSheet.kt"
    ]
}

#if os(macOS)

@MainActor
@Suite(.serialized)
struct EntryCoreDeltaViewModelTests {
    @Test func theShellRefreshAlsoFeedsThePremeetingPresenter() {
        let viewModel = MeetingViewModel()
        viewModel.state = MeetingState(userId: "local@example.com#local-session", sessionId: "local-session")
        viewModel.state.roomId = "lily-zoro-iris"
        viewModel.state.connectionState = ConnectionState.connecting
        #expect(viewModel.premeeting.currentInputs.phase == .entering)
        #expect(viewModel.premeeting.currentInputs.currentRoomId == "lily-zoro-iris")
        #expect(viewModel.premeeting.path.last?.kind == .lobby)
        #expect(viewModel.premeeting.lobbyStatus?.mode == .connecting)
        viewModel.state.connectionState = ConnectionState.joined
        #expect(viewModel.premeeting.root.root == .call)
        #expect(viewModel.makePremeetingInputs() == viewModel.premeeting.currentInputs)
    }

    @Test func identityAndAppActivityArePushedOnceEach() {
        let viewModel = MeetingViewModel()
        viewModel.setPremeetingIdentity(isSignedIn: true, accountName: "Avery", accountSeed: "u1")
        #expect(viewModel.premeeting.home.isSignedIn)
        #expect(viewModel.premeeting.home.accountName == "Avery")
        let count = viewModel.premeeting.snapshotPublishCount
        viewModel.setPremeetingIdentity(isSignedIn: true, accountName: "Avery", accountSeed: "u1")
        #expect(viewModel.premeeting.snapshotPublishCount == count)
        viewModel.setPremeetingAppActive(false)
        #expect(!viewModel.premeeting.currentInputs.isAppActive)
        viewModel.setPremeetingAppActive(true)
        #expect(viewModel.premeeting.currentInputs.isAppActive)
        #expect(viewModel.premeeting.onCommand != nil)
    }
}
#endif

private func entrySource(_ packageRelativePath: String) throws -> String {
    let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
    return try String(contentsOf: root.appendingPathComponent(packageRelativePath), encoding: .utf8)
}

private func entryFlat(_ text: String) -> String {
    text.split(whereSeparator: { $0.isWhitespace }).joined(separator: " ")
}

private func entryMatches(_ pattern: String, in text: String) -> [String] {
    guard let regex = try? NSRegularExpression(pattern: pattern) else { return [] }
    let range = NSRange(text.startIndex..<text.endIndex, in: text)
    return regex.matches(in: text, range: range).compactMap { match in
        Range(match.range, in: text).map { String(text[$0]) }
    }
}
#endif
