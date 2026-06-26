import Foundation
import OSLog
import SwiftUI

let logger: Logger = Logger(subsystem: "com.acmvit.conclave", category: "Conclave")

public struct ConclaveRootView: View {
    @State private var appState = AppState.shared

    public init() {
    }

    public var body: some View {
        ContentView(appState: appState)
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

public final class ConclaveAppDelegate: Sendable {
    public static let shared = ConclaveAppDelegate()
    @MainActor private var lastOpenURLString: String?
    @MainActor private var lastOpenURLAt = Date.distantPast

    init() {
    }

    public func onInit() {
        #if SKIP
        NativeAuthSessionBridge.install()
        #endif
    }

    public func onLaunch() {
        #if !SKIP
        FontRegistration.registerFonts()
        #endif
    }

    public func onResume() {
        Task { @MainActor in
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
            guard isJoinLinkURLString(urlString) else {
                return
            }
            AppState.shared.openJoinURLString(urlString)
        }
    }

    public func onPause() {
    }

    public func onStop() {
    }

    public func onDestroy() {
    }

    public func onLowMemory() {
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
}
