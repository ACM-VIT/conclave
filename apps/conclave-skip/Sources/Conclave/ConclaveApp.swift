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
            #endif
    }
}

public final class ConclaveAppDelegate: Sendable {
    public static let shared = ConclaveAppDelegate()

    init() {
    }

    public func onInit() {
    }

    public func onLaunch() {
        #if !SKIP
        FontRegistration.registerFonts()
        #endif
    }

    public func onResume() {
        Task { @MainActor in
            await MeetingViewModel.shared.recoverActiveMeetingFromForeground()
        }
    }

    @discardableResult
    @MainActor
    public func onOpenURL(_ url: URL) -> Bool {
        if NativeAuthService.handleOpenURL(url) {
            return true
        }
        AppState.shared.openJoinURL(url)
        return true
    }

    public func onOpenURL(_ urlString: String) {
        Task { @MainActor in
            if let url = URL(string: urlString), NativeAuthService.handleOpenURL(url) {
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
}
