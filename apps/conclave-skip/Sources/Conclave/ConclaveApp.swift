import Foundation
import OSLog
import SwiftUI
#if canImport(UIKit)
import UIKit
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
    #endif

    public init() {
    }

    public var body: some View {
        #if DEBUG && os(iOS) && !SKIP
        if let systemFixture {
            SystemFixtureView(state: systemFixture, providerMode: SystemFixtureLaunch.providerMode())
        } else if showsHostingPreview {
            NativeHostingPreview(onClose: { showsHostingPreview = false })
        } else {
            legacyRoot
        }
        #else
        legacyRoot
        #endif
    }

    private var legacyRoot: some View {
        ContentView(appState: appState)
            #if os(iOS) && !SKIP
            // WP2-S2b (S70 12 c): the single production feedback root, mounted once.
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

    init() {
    }

    public func onInit() {
        #if !SKIP
        FontRegistration.registerFonts()
        #endif
        PerformanceDiagnostics.install()
    }

    public func onLaunch() {
    }

    public func onResume() {
        Task { @MainActor in
            guard self.transitionLifecycle(to: .active) else { return }
            MeetingViewModel.shared.handleAppBecameActive()
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
            _ = self.transitionLifecycle(to: .inactive)
        }
    }

    public func onStop() {
        Task { @MainActor in
            guard self.transitionLifecycle(to: .background) else { return }
            MeetingViewModel.shared.handleAppEnteredBackground()
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
