#if !SKIP
import Foundation
import Testing
@testable import Conclave

@MainActor
struct EntryFirstScreenTests {

    @Test func theIOSProductionRootIsTheNativePremeetingRoot() throws {
        let app = try entryFirstScreenSource("Sources/Conclave/ConclaveApp.swift")
        let routeRoot = try entryFirstScreenBody(app, from: "private var routeRoot: some View {", to: "private var legacyRoot: some View {")
        #expect(routeRoot.contains(
            "#if os(iOS) && !SKIP\n        if NativeRouteFlags.shared.isEnabled(.premeeting) {\n            NativePremeetingProductionRoot(appState: appState)"
        ))
        let productionRoot = try entryFirstScreenBody(app, from: "private var productionRoot: some View {", to: "enum ConclaveAppLifecyclePhase")
        #expect(productionRoot.contains("routeRoot"))
        let body = try entryFirstScreenBody(app, from: "public var body: some View {", to: "private var routeRoot: some View {")
        #expect(body.contains("#else\n        productionRoot\n        #endif"))

        let root = try entryFirstScreenSource("Sources/Conclave/Features/Home/PremeetingRoot+iOS.swift")
        let production = try entryFirstScreenBody(root, from: "struct NativePremeetingProductionRoot: View {",
                                                  to: "struct NativeAppRoot<InterimCall: View>: View {")
        #expect(production.contains("PremeetingAppWiring.install(appState: appState, viewModel: MeetingViewModel.shared)"))
        #expect(production.contains("NativeAppRoot(shell: viewModel.shell, premeeting: viewModel.premeeting,"))
        #expect(production.contains("usesNativeCallRoot: NativeRouteFlags.shared.isEnabled(.call)"))
        let appRoot = try entryFirstScreenBody(root, from: "struct NativeAppRoot<InterimCall: View>: View {", to: "struct PremeetingRoot: View {")
        #expect(appRoot.contains("PremeetingRoot(shell: shell, premeeting: premeeting)"))
    }

    @Test func homeIsThePathRootOfThePremeetingStack() throws {
        let root = try entryFirstScreenSource("Sources/Conclave/Features/Home/PremeetingRoot+iOS.swift")
        let stack = try entryFirstScreenBody(root, from: "struct PremeetingRoot: View {", to: "private struct PremeetingRootContent: View {")
        #expect(stack.contains("Binding(get: { premeeting.path }, set: { premeeting.setPath($0) })"))
        #expect(stack.contains("NavigationStack(path: pathBinding) {\n            PremeetingRootContent(premeeting: premeeting)"))
        let content = try entryFirstScreenBody(root, from: "private struct PremeetingRootContent: View {",
                                               to: "private struct PremeetingDestination: View {")
        #expect(content.contains("if let outcome = premeeting.outcome {"))
        #expect(content.contains("HomeView(premeeting: premeeting)"))
        #expect(!content.contains("LobbyView(") && !content.contains("JoinView("))
    }

    @Test func aBootstrappedPresenterStartsAtHome() {
        let guest = PremeetingPresenter()
        guest.nowMillis = { 1793102400000.0 }
        guest.bootstrap(user: nil, recents: [])
        #expect(guest.path.isEmpty)
        #expect(guest.root == PremeetingRootDecision.home)
        #expect(guest.outcome == nil)
        #expect(!guest.isJoinSheetPresented && !guest.isAccountSheetPresented)
        #expect(!guest.home.isSignedIn)

        let signedIn = PremeetingPresenter()
        signedIn.nowMillis = { 1793102400000.0 }
        let record = RecentMeetingRecord(id: RecentMeetingsPolicy.recordId(roomId: "lily-zoro-iris", joinMode: .meeting),
                                         roomId: "lily-zoro-iris", title: "Standup", joinMode: JoinMode.meeting.rawValue,
                                         role: RecentRole.host.rawValue, lastJoinedAtMillis: 1792839600000.0,
                                         endedAtMillis: 1792843200000.0, end: RecentEnd.left.rawValue)
        signedIn.bootstrap(user: AppState.User(id: "u1", name: "Avery Lee", email: "avery@example.com", provider: .google),
                           recents: [record])
        #expect(signedIn.path.isEmpty, "recents and a signed-in account never push a route at launch")
        #expect(signedIn.root == PremeetingRootDecision.home)
        #expect(signedIn.outcome == nil)
        #expect(signedIn.home.isSignedIn)
        #expect(signedIn.recentRecords.count == 1)
    }

    @Test func theMobileDefaultGetterYieldsBothNativeRoots() throws {
        let flags = try entryFirstScreenSource("Sources/Conclave/App/NativeRouteFlags.swift")
        let getter = try entryFirstScreenBody(flags, from: "static var nativeUIAvailable: Bool {", to: "private let productionKeys")
        #expect(getter.contains("#if os(iOS) || SKIP\n        return true\n        #else\n        return false\n        #endif"))
        #expect(flags.contains("static let shared = NativeRouteFlags()"))
        #expect(flags.contains(
            "init(nativeUIAvailable: Bool = NativeRouteFlags.nativeUIAvailable) {\n        productionKeys = nativeUIAvailable ? [.premeeting, .call] : []\n        enabledKeys = productionKeys"
        ))
        #expect(flags.contains("guard debugEligible else {\n            reset()\n            return\n        }"))
        #expect(flags.contains("func configureFromLaunchEnvironment() {\n        #if DEBUG && !SKIP"))

        let mobile = NativeRouteFlags(nativeUIAvailable: true)
        #expect(mobile.enabledKeys == [.premeeting, .call])
        #expect(mobile.isEnabled(.premeeting) && mobile.isEnabled(.call))
        #expect(mobile.routesPremeetingNatively)
        #expect(mobile.premeetingFixture.isEmpty)
        mobile.configure(routes: "none", premeetingFixture: "inCall", debugEligible: false)
        #expect(mobile.enabledKeys == [.premeeting, .call])
        #expect(mobile.premeetingFixture.isEmpty)
    }

    @Test func theDefaultGetterMatchesTheHostPlatform() {
        let flags = NativeRouteFlags()
        #if os(iOS)
        #expect(NativeRouteFlags.nativeUIAvailable)
        #expect(flags.enabledKeys == [.premeeting, .call])
        #else
        #expect(!NativeRouteFlags.nativeUIAvailable, "the macOS host keeps the legacy default")
        #expect(flags.enabledKeys.isEmpty)
        #expect(!flags.isEnabled(.premeeting) && !flags.isEnabled(.call))
        #expect(!flags.routesPremeetingNatively)
        flags.configure(routes: "premeeting,call", premeetingFixture: nil, debugEligible: false)
        #expect(flags.enabledKeys.isEmpty)
        #endif
    }
}

private func entryFirstScreenSource(_ packageRelativePath: String) throws -> String {
    let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
    return try String(contentsOf: root.appendingPathComponent(packageRelativePath), encoding: .utf8)
}

private struct EntryFirstScreenRangeMissing: Error {
    let marker: String
}

private func entryFirstScreenBody(_ source: String, from start: String, to end: String) throws -> String {
    guard let startRange = source.range(of: start) else { throw EntryFirstScreenRangeMissing(marker: start) }
    guard let endRange = source.range(of: end, range: startRange.upperBound..<source.endIndex) else {
        throw EntryFirstScreenRangeMissing(marker: end)
    }
    return String(source[startRange.upperBound..<endRange.lowerBound])
}
#endif
