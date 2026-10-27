#if !SKIP
import Foundation
import Testing
@testable import Conclave

/// ENT-1 and ENT-2 core and root deltas (S10 0.8 C8, C9, C16; PLAN-screens 2 route switches). The view model feeds
/// the premeeting presenter from the same refresh as the shell; the app delegate routes Conclave links to the native
/// root's presenter; the native roots stay behind the Debug flags and the legacy root stays the default. iOS views
/// and Android Kotlin compile only on their platforms, so their wiring is pinned by source scans.
@MainActor
struct EntryCoreDeltaTests {
    // MARK: C9: the delegate's native intake

    @Test func nativeIntakeSendsConclaveLinksToTheRegisteredPresenter() {
        let delegate = ConclaveAppDelegate.shared
        let presenter = PremeetingPresenter()
        delegate.registerPremeeting(presenter)
        defer { delegate.registerPremeeting(nil) }
        // S10 4 l5: `conclave://` with an empty room shows the Home notice and is handled.
        #expect(delegate.routeNatively("conclave://"))
        #expect(presenter.home.noticeKind == .invalidLink)
        // A non-Conclave URL is not handled.
        #expect(!delegate.routeNatively("https://example.com/x"))
        // A meeting link opens the lobby in editing (no auto-join, S10 4 l2).
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
        // S10 1 l6: a cold-start link ends as [Home, Lobby].
        #expect(presenter.path.map { $0.roomId } == ["lily-zoro-iris"])
    }

    // MARK: Root wiring (source scans)

    @Test func theNativeRootsStayBehindTheDebugFlagsAndTheLegacyRootStaysTheDefault() throws {
        let app = try entrySource("Sources/Conclave/ConclaveApp.swift")
        // WP2-S2b pin kept: one production feedback root, outside the route switch.
        #expect(app.components(separatedBy: ".conclaveRootFeedback(shell: MeetingViewModel.shared.shell)").count - 1 == 1)
        #expect(entryFlat(app).contains("if NativeRouteFlags.shared.isEnabled(.premeeting) { NativePremeetingProductionRoot(appState: appState) } else { legacyRoot }"))
        #expect(entryFlat(app).contains("} else if let premeetingFixture { PremeetingFixtureRoot(state: premeetingFixture) }"))
        #expect(app.contains("@State private var premeetingFixture = PremeetingFixtureScript.state(named: NativeRouteFlags.shared.premeetingFixture)"))
        #expect(app.contains("NativeRouteFlags.shared.configureFromLaunchEnvironment()"))
        // C9 on the native root only; the legacy queue stays for the legacy route.
        #expect(entryFlat(app).contains("if NativeRouteFlags.shared.routesPremeetingNatively { return routeNatively(url.absoluteString) }"))
        #expect(entryFlat(app).contains("if NativeRouteFlags.shared.routesPremeetingNatively { _ = self.routeNatively(urlString) return }"))
        #expect(app.contains("AppState.shared.openJoinURL(url)"))
        #expect(app.contains("AppState.shared.openJoinURLString(urlString)"))
        // C8: app activity reaches the presenter behind the flag.
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
        let pipBranch = try #require(main.range(of: "if (PipController.inPipMode && PipController.isInCall) {"))
        #expect(rootCall.lowerBound < pipBranch.lowerBound)
        #expect(main.components(separatedBy: "SideEffect { saveableStateHolder.removeState(FULL_ROOT_SAVEABLE_KEY) }").count - 1 == 1)
        // The legacy root is still the last branch.
        #expect(entryFlat(main).contains("} else { legacyRoot() }"))

        let host = try entrySource("Sources/Conclave/Skip/ui/home/PremeetingHost.kt")
        #expect(host.contains("const val ROUTES_EXTRA = \"conclave.nativeRoutes\""))
        #expect(host.contains("const val PREMEETING_FIXTURE_EXTRA = \"conclave.premeetingFixture\""))
        #expect(host.contains("\ninternal fun PremeetingHost("))
        #expect(host.contains("\nfun NativePremeetingHost(callContent: @Composable () -> Unit) {"))
        #expect(host.contains("\nfun PremeetingFixtureHost(stateName: String) {"))
        #expect(host.contains("CALL-ROOT SLOT"))
        #expect(host.components(separatedBy: "ConclaveSystemBars(").count - 1 == 1)
        #expect(host.contains("entryProvider = { key -> NavEntry(key) { _ -> PremeetingPage(premeeting, key) } }"))

        let ios = try entrySource("Sources/Conclave/Features/Home/PremeetingRoot+iOS.swift")
        #expect(ios.hasPrefix("#if os(iOS) && !SKIP\n"))
        #expect(ios.contains("CALL-ROOT SLOT"))
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
        // No new glass anywhere in the premeeting files (the only sanctioned glass entries are the call control and
        // the composer files).
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
        // Identity first, then the bootstrap, then the link target (S10 1 c; recents are cleared only on a sign-out).
        let identity = try #require(flat.range(of: "let presenter = viewModel.premeeting pushIdentity(appState: appState, viewModel: viewModel)"))
        #expect(flat.contains("appState.onIdentityChanged = { PremeetingAppWiring.pushIdentity(appState: appState, viewModel: viewModel) }"))
        let bootstrap = try #require(flat.range(of: "presenter.bootstrap(user: appState.currentUser, recents: store.load())"))
        let register = try #require(flat.range(of: "ConclaveAppDelegate.shared.registerPremeeting(presenter)"))
        #expect(identity.lowerBound < bootstrap.lowerBound && bootstrap.lowerBound < register.lowerBound)
    }

    @Test func theViewModelFeedsThePremeetingPresenterFromTheShellRefresh() throws {
        let viewModel = try entrySource("Sources/Conclave/Features/Meeting/MeetingViewModel.swift")
        // Batch 3 integrator: STG-1 (HD request B3-T2 R2b) appends the stage's phase refresh after the premeeting apply,
        // so the shell, presence, premeeting order is pinned up to the premeeting apply and the stage block after it.
        #expect(entryFlat(viewModel).contains("shell.apply(makeShellInputs()) callPresence.apply(makeCallPresenceInputs()) // S10 0.8 C8: the premeeting presenter reads the snapshot the shell just published (equality-guarded). premeeting.apply(makePremeetingInputs()) // The stage's `isInCall` follows the shell phase"))
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
        // Shared presenters stay transpilable: no iOS frameworks, no function-reference maps.
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
/// S10 0.8 C8 on the view model (macOS stubs; no network).
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

/// Whitespace collapsed to single spaces, so a pin fails only when the code changes.
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
