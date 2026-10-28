import Foundation
import OSLog
import SwiftUI
#if canImport(UIKit)
import UIKit
#endif
#if os(iOS) && !SKIP
import TipKit
#endif
#if os(macOS)
import AppKit
#endif

let logger: Logger = Logger(subsystem: "com.acmvit.conclave", category: "Conclave")

public struct ConclaveRootView: View {
    @State private var appState = AppState.shared
    #if DEBUG && os(iOS) && !SKIP
    @State private var showsHostingPreview = ProcessInfo.processInfo.environment["CONCLAVE_HOSTING_PREVIEW"] == "1"
    /// S70 SX1: `CONCLAVE_SYSTEM_FIXTURE=<state>` (Debug only) mounts the system fixture instead of the app.
    @State private var systemFixture = SystemFixtureLaunch.state()
    /// S20 SL14: `CONCLAVE_STAGE_FIXTURE=<state>` (Debug only) mounts the stage fixture instead of the app.
    @State private var stageFixture = StageFixtureLaunch.state()
    /// S30 CL13 (CTL-1, HD request B4-T6 R3): `CONCLAVE_STAGE_FIXTURE=controls-<state>` mounts the controls fixture
    /// (`StageFixtureLaunch` returns nil for those values).
    @State private var controlsFixture = ControlsFixtureLaunch.state()
    /// S50 PL12 (PPL-1, HD request B4-T7 R5): `CONCLAVE_PEOPLE_FIXTURE=<state>` (Debug only) mounts the People fixture
    /// over the stage fixture.
    @State private var peopleFixture = PeopleFixtureLaunch.state()
    /// S10 L9: `CONCLAVE_PREMEETING_FIXTURE=<state>` (Debug only) mounts the premeeting fixture route with standalone
    /// presenters; it never creates the view model.
    @State private var premeetingFixture = PremeetingFixtureScript.state(named: NativeRouteFlags.shared.premeetingFixture)
    #endif

    public init() {
    }

    public var body: some View {
        #if DEBUG && os(iOS) && !SKIP
        if let systemFixture {
            SystemFixtureView(state: systemFixture, providerMode: SystemFixtureLaunch.providerMode())
        } else if let controlsFixture {
            ControlsFixtureView(state: controlsFixture)
        } else if let peopleFixture {
            PeopleFixtureView(state: peopleFixture)
        } else if let stageFixture {
            StageFixtureView(state: stageFixture)
        } else if let premeetingFixture {
            PremeetingFixtureRoot(state: premeetingFixture)
        } else if showsHostingPreview {
            NativeHostingPreview(onClose: { showsHostingPreview = false })
        } else {
            productionRoot
        }
        #else
        productionRoot
        #endif
    }

    /// PLAN-screens 2: the native premeeting root behind the Debug `premeeting` route flag (S10 0.4 phase table, the
    /// legacy call content inside its call branch until STG-1 and CALL-FLIP); the legacy root otherwise. Release
    /// builds never configure the flag, so they always take the legacy root.
    @ViewBuilder
    private var routeRoot: some View {
        #if os(iOS) && !SKIP
        if NativeRouteFlags.shared.isEnabled(.premeeting) {
            NativePremeetingProductionRoot(appState: appState)
        } else {
            legacyRoot
        }
        #else
        legacyRoot
        #endif
    }

    private var legacyRoot: some View {
        ContentView(appState: appState)
    }

    private var productionRoot: some View {
        routeRoot
            #if os(iOS) && !SKIP
            // WP2-S2b (S70 12 c): the single production feedback root, mounted once, outside the route switch.
            .conclaveRootFeedback(shell: MeetingViewModel.shared.shell)
            #endif
            #if !SKIP
            .onOpenURL { url in
                _ = ConclaveAppDelegate.shared.onOpenURL(url)
            }
            .onContinueUserActivity(NSUserActivityTypeBrowsingWeb) { activity in
                guard let url = activity.webpageURL else { return }
                _ = ConclaveAppDelegate.shared.onOpenURL(url)
            }
            #endif
    }
}

enum ConclaveAppLifecyclePhase: Equatable {
    case launching
    case active
    case inactive
    case background
}

enum ConclaveAppLifecyclePolicy {
    static func shouldDeliver(
        previous: ConclaveAppLifecyclePhase,
        next: ConclaveAppLifecyclePhase
    ) -> Bool {
        previous != next
    }
}

public final class ConclaveAppDelegate: Sendable {
    public static let shared = ConclaveAppDelegate()
    @MainActor private var lastOpenURLString: String?
    @MainActor private var lastOpenURLAt = Date.distantPast
    @MainActor private var lifecyclePhase = ConclaveAppLifecyclePhase.launching
    /// S10 0.8 C9: the native root's premeeting presenter (production or the L9 fixture); links that arrive before
    /// the root registers it wait in `pendingNativeLink` (a cold-start link, S10 1 d).
    @MainActor private var premeetingLinkTarget: PremeetingPresenter? = nil
    @MainActor private var pendingNativeLink = ""

    init() {
    }

    public func onInit() {
        #if !SKIP
        FontRegistration.registerFonts()
        #endif
        // PLAN-screens 2: the Debug route registry from the iOS launch environment (a no-op in Release and on
        // Android, where MainActivity configures it from its intent extras).
        NativeRouteFlags.shared.configureFromLaunchEnvironment()
        PerformanceDiagnostics.install()
        #if os(iOS) && !SKIP
        // SYS-3 (S70 2 c): the UNUserNotificationCenter delegate before launch finishes, so a notification tap that
        // launched the app still arrives (it waits in SystemNotifications until the core installs its handler).
        LocalNotificationDelegate.install()
        // F00 C25 c (FND-3): TipKit once at launch, so the TipKit datastore keeps each one-time tip dismissed across
        // relaunches. Debug launches with CONCLAVE_RESET_TIPS=1 start with every tip eligible again (TipKit requires
        // resetDatastore before configure, so the reset is a launch switch rather than a menu item).
        #if DEBUG
        if ProcessInfo.processInfo.environment["CONCLAVE_RESET_TIPS"] == "1" {
            try? Tips.resetDatastore()
        }
        #endif
        try? Tips.configure([.datastoreLocation(.applicationDefault)])
        #endif
    }

    public func onLaunch() {
    }

    public func onResume() {
        Task { @MainActor in
            guard self.transitionLifecycle(to: .active) else { return }
            MeetingViewModel.shared.handleAppBecameActive()
            // S10 0.8 C8: the native premeeting presenter learns app activity (relative times, presence later).
            if NativeRouteFlags.shared.isEnabled(.premeeting) {
                MeetingViewModel.shared.setPremeetingAppActive(true)
            }
        }
    }

    @discardableResult
    @MainActor
    public func onOpenURL(_ url: URL) -> Bool {
        guard shouldHandleOpenURL(url.absoluteString) else {
            return true
        }
        if NativeAuthService.handleOpenURL(url) {
            return true
        }
        if NativeRouteFlags.shared.routesPremeetingNatively {
            return routeNatively(url.absoluteString)
        }
        if isWebBookingURL(url) {
            openExternalWebURL(url)
            return true
        }
        guard isJoinLinkURLString(url.absoluteString) else {
            return false
        }
        AppState.shared.openJoinURL(url)
        return true
    }

    public func onOpenURL(_ urlString: String) {
        Task { @MainActor in
            guard shouldHandleOpenURL(urlString) else { return }
            if let url = URL(string: urlString), NativeAuthService.handleOpenURL(url) {
                return
            }
            if NativeRouteFlags.shared.routesPremeetingNatively {
                _ = self.routeNatively(urlString)
                return
            }
            if let url = URL(string: urlString), self.isWebBookingURL(url) {
                self.openExternalWebURL(url)
                return
            }
            guard isJoinLinkURLString(urlString) else {
                return
            }
            AppState.shared.openJoinURLString(urlString)
        }
    }

    public func onPause() {
        Task { @MainActor in
            guard self.transitionLifecycle(to: .inactive) else { return }
            // SYS-6 (S70 6 c, 6 d): the core decides light refresh versus full recovery on the next activation.
            MeetingViewModel.shared.handleAppResignedActive()
        }
    }

    public func onStop() {
        Task { @MainActor in
            guard self.transitionLifecycle(to: .background) else { return }
            MeetingViewModel.shared.handleAppEnteredBackground()
            if NativeRouteFlags.shared.isEnabled(.premeeting) {
                MeetingViewModel.shared.setPremeetingAppActive(false)
            }
        }
    }

    public func onDestroy() {
    }

    public func onLowMemory() {
    }

    @MainActor
    private func transitionLifecycle(to next: ConclaveAppLifecyclePhase) -> Bool {
        guard ConclaveAppLifecyclePolicy.shouldDeliver(
            previous: lifecyclePhase,
            next: next
        ) else {
            return false
        }
        lifecyclePhase = next
        return true
    }

    /// The native root registers its presenter (production wiring or the L9 fixture); a waiting link is delivered.
    @MainActor
    func registerPremeeting(_ presenter: PremeetingPresenter?) {
        premeetingLinkTarget = presenter
        guard let presenter, !pendingNativeLink.isEmpty else { return }
        let link = pendingNativeLink
        pendingNativeLink = ""
        presenter.handleIncomingURL(link)
    }

    /// S10 0.8 C9 on the native root: a Conclave link (parsable or not) goes to `PremeetingPresenter.handleIncomingURL`,
    /// which shows the lobby, the switch prompt or the invalid-link notice, and returns true; a Conclave web page that
    /// is not a meeting (`/book`, `/schedule`, the rest of the web-only list) opens in the browser; any other URL
    /// returns false. The legacy route keeps the AppState queue until WP11.
    @MainActor
    func routeNatively(_ rawValue: String) -> Bool {
        switch NativeJoinLinkParser.classify(rawValue) {
        case .notConclave:
            return false
        case .webOnly:
            if let url = URL(string: rawValue.trimmingCharacters(in: .whitespacesAndNewlines)) {
                openExternalWebURL(url)
            }
            return true
        case .meeting, .webinar, .invalidConclave:
            if let target = premeetingLinkTarget {
                target.handleIncomingURL(rawValue)
            } else {
                pendingNativeLink = rawValue
            }
            return true
        }
    }

    @MainActor
    private func shouldHandleOpenURL(_ rawValue: String) -> Bool {
        let value = rawValue.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !value.isEmpty else { return false }
        let now = Date()
        if lastOpenURLString == value, now.timeIntervalSince(lastOpenURLAt) < 1.0 {
            return false
        }
        lastOpenURLString = value
        lastOpenURLAt = now
        return true
    }

    private func isJoinLinkURLString(_ rawValue: String) -> Bool {
        !NativeJoinLinkParser.parse(rawValue, allowRoomCreationForURLs: true).roomId.isEmpty
    }

    private func isWebBookingURL(_ url: URL) -> Bool {
        guard ["http", "https"].contains(url.scheme?.lowercased() ?? "") else {
            return false
        }
        let host = url.host?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() ?? ""
        guard host == "conclave.acmvit.in" || host == "www.conclave.acmvit.in" else {
            return false
        }
        let firstSegment = url.path
            .split(separator: "/", omittingEmptySubsequences: true)
            .first?
            .lowercased()
        return firstSegment == "book"
    }

    private func openExternalWebURL(_ url: URL) {
        #if canImport(UIKit)
        UIApplication.shared.open(url)
        #elseif os(macOS)
        NSWorkspace.shared.open(url)
        #endif
    }
}
