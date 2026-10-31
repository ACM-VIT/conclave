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
    @State private var showsHostingPreview = NativeRuntimeConfig.debugLaunchValue(forKey: "CONCLAVE_HOSTING_PREVIEW") == "1"

    @State private var systemFixture = SystemFixtureLaunch.state(environment: NativeRuntimeConfig.debugLaunchEnvironment())

    @State private var stageFixture = StageFixtureLaunch.state()

    @State private var controlsFixture = ControlsFixtureLaunch.state()

    @State private var peopleFixture = PeopleFixtureLaunch.state()
    @State private var peopleQaFixture = PeopleFixtureLaunch.qaState()

    @State private var premeetingFixture = PremeetingFixtureScript.state(named: NativeRouteFlags.shared.premeetingFixture)
    #endif

    public init() {
    }

    public var body: some View {
        #if DEBUG && os(iOS) && !SKIP
        if let systemFixture {
            SystemFixtureView(state: systemFixture, providerMode: SystemFixtureLaunch.providerMode(environment: NativeRuntimeConfig.debugLaunchEnvironment()))
        } else if let controlsFixture {
            ControlsFixtureView(state: controlsFixture)
        } else if let peopleFixture {
            PeopleFixtureView(state: peopleFixture, qaState: peopleQaFixture)
        } else if let stageFixture {
            StageFixtureView(state: stageFixture)
        } else if let premeetingFixture {
            PremeetingFixtureRoot(state: premeetingFixture)
        } else if showsHostingPreview {
            NativeHostingPreview(onClose: {
                showsHostingPreview = false
                NativeRouteFlags.shared.dismissHostingPreview()
                ConclaveAppDelegate.shared.onFixturePresentationEnded()
            })
        } else {
            productionRoot
        }
        #else
        productionRoot
        #endif
    }

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

struct ConclaveAppLifecycleGate {
    private(set) var observedPhase = ConclaveAppLifecyclePhase.launching
    private var deliveredPhase: ConclaveAppLifecyclePhase? = .launching

    mutating func record(_ next: ConclaveAppLifecyclePhase, fixturePresented: Bool) -> Bool {
        observedPhase = next
        guard !fixturePresented else {
            deliveredPhase = nil
            return false
        }
        guard deliveredPhase != next else { return false }
        deliveredPhase = next
        return true
    }

    mutating func resumeAfterFixture(fixturePresented: Bool) -> Bool {
        guard observedPhase == .active else { return false }
        return record(.active, fixturePresented: fixturePresented)
    }
}

public final class ConclaveAppDelegate: Sendable {
    public static let shared = ConclaveAppDelegate()
    @MainActor private var lastOpenURLString: String?
    @MainActor private var lastOpenURLAt = Date.distantPast
    @MainActor private var lifecycleGate = ConclaveAppLifecycleGate()

    @MainActor private var premeetingLinkTarget: PremeetingPresenter? = nil
    @MainActor private var pendingNativeLink = ""

    init() {
    }

    public func onInit() {
        NativeRouteFlags.shared.configureFromLaunchEnvironment()
        PerformanceDiagnostics.install()
        #if os(iOS) && !SKIP

        LocalNotificationDelegate.install()

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
            #if SKIP
            CallNotificationBridge.setAppActive(active: true)
            #endif
            guard self.transitionLifecycle(to: .active) else { return }
            self.deliverActiveLifecycle()
        }
    }

    @MainActor
    public func onFixturePresentationEnded() {
        guard lifecycleGate.resumeAfterFixture(fixturePresented: NativeRouteFlags.shared.suppressesProductionLifecycle) else { return }
        deliverActiveLifecycle()
    }

    @MainActor
    private func deliverActiveLifecycle() {
        MeetingViewModel.shared.handleAppBecameActive()

        if NativeRouteFlags.shared.isEnabled(.premeeting) {
            MeetingViewModel.shared.setPremeetingAppActive(true)
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

            MeetingViewModel.shared.handleAppResignedActive()
        }
    }

    public func onStop() {
        Task { @MainActor in
            #if SKIP
            CallNotificationBridge.setAppActive(active: false)
            #endif
            guard self.transitionLifecycle(to: .background) else { return }
            MeetingViewModel.shared.handleAppEnteredBackground()
            if NativeRouteFlags.shared.isEnabled(.premeeting) {
                MeetingViewModel.shared.setPremeetingAppActive(false)
            }
        }
    }

    public func onDestroy() {
        #if !SKIP
        MeetingResumeMarker.write()
        guard Thread.isMainThread else { return }
        MainActor.assumeIsolated {
            MeetingViewModel.shared.handleAppWillTerminate()
        }
        #endif
    }

    public func onLowMemory() {
    }

    @MainActor
    private func transitionLifecycle(to next: ConclaveAppLifecyclePhase) -> Bool {
        lifecycleGate.record(next, fixturePresented: NativeRouteFlags.shared.suppressesProductionLifecycle)
    }

    @MainActor
    func registerPremeeting(_ presenter: PremeetingPresenter?) {
        premeetingLinkTarget = presenter
        guard let presenter, !pendingNativeLink.isEmpty else { return }
        let link = pendingNativeLink
        pendingNativeLink = ""
        presenter.handleIncomingURL(link)
    }

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
