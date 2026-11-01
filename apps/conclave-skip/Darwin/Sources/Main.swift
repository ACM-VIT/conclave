import SwiftUI
import Conclave

private typealias AppRootView = ConclaveRootView
private typealias AppDelegate = ConclaveAppDelegate

@main struct AppMain: App {
    @AppDelegateAdaptor(AppMainDelegate.self) var appDelegate
    @Environment(\.scenePhase) private var scenePhase

    var body: some Scene {
        WindowGroup {

            AppRootView()
                .frame(minWidth: CGFloat(ConclaveWindowMetrics.minimumWidth), maxWidth: .infinity, maxHeight: .infinity)
        }
        .windowResizability(.contentMinSize)
        #if os(iOS)

        .commands { ConclaveCallCommands() }
        #endif
        .onChange(of: scenePhase) { oldPhase, newPhase in
            switch newPhase {
            case .active:
                AppDelegate.shared.onResume()
            case .inactive:
                AppDelegate.shared.onPause()
            case .background:
                AppDelegate.shared.onStop()
            @unknown default:
                break
            }
        }
    }
}

#if canImport(UIKit)
typealias AppDelegateAdaptor = UIApplicationDelegateAdaptor
typealias AppMainDelegateBase = UIApplicationDelegate
typealias AppType = UIApplication
#elseif canImport(AppKit)
typealias AppDelegateAdaptor = NSApplicationDelegateAdaptor
typealias AppMainDelegateBase = NSApplicationDelegate
typealias AppType = NSApplication
#endif

@MainActor final class AppMainDelegate: NSObject, AppMainDelegateBase {
    let application = AppType.shared

    #if canImport(UIKit)
    func application(_ application: UIApplication, willFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey : Any]? = nil) -> Bool {
        AppDelegate.shared.onInit()
        return true
    }

    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey : Any]? = nil) -> Bool {
        AppDelegate.shared.onLaunch()
        return true
    }

    func application(_ application: UIApplication, open url: URL, options: [UIApplication.OpenURLOptionsKey : Any] = [:]) -> Bool {
        AppDelegate.shared.onOpenURL(url)
    }

    func application(_ application: UIApplication, continue userActivity: NSUserActivity, restorationHandler: @escaping ([UIUserActivityRestoring]?) -> Void) -> Bool {
        guard userActivity.activityType == NSUserActivityTypeBrowsingWeb,
              let url = userActivity.webpageURL else {
            return false
        }
        return AppDelegate.shared.onOpenURL(url)
    }

    func applicationWillTerminate(_ application: UIApplication) {
        AppDelegate.shared.onDestroy()
    }

    func applicationDidReceiveMemoryWarning(_ application: UIApplication) {
        AppDelegate.shared.onLowMemory()
    }

    func application(_ application: UIApplication, configurationForConnecting connectingSceneSession: UISceneSession, options: UIScene.ConnectionOptions) -> UISceneConfiguration {
        if let item = options.shortcutItem {
            AppDelegate.shared.onShortcut(type: item.type, payload: "")
        }
        let configuration = UISceneConfiguration(name: nil, sessionRole: connectingSceneSession.role)
        configuration.delegateClass = AppMainSceneDelegate.self
        return configuration
    }

    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        NotificationCenter.default.post(name: NSNotification.Name("didRegisterForRemoteNotificationsWithDeviceToken"), object: application, userInfo: ["deviceToken": deviceToken])
    }

    func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: any Error) {
        NotificationCenter.default.post(name: NSNotification.Name("didFailToRegisterForRemoteNotificationsWithError"), object: application, userInfo: ["error": error])
    }
    #elseif canImport(AppKit)
    func applicationWillFinishLaunching(_ notification: Notification) {
        AppDelegate.shared.onInit()
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        AppDelegate.shared.onLaunch()
    }

    func applicationWillTerminate(_ application: Notification) {
        AppDelegate.shared.onDestroy()
    }
    #endif

}

#if canImport(UIKit)
@MainActor final class AppMainSceneDelegate: NSObject, UIWindowSceneDelegate {
    func windowScene(_ windowScene: UIWindowScene, performActionFor shortcutItem: UIApplicationShortcutItem, completionHandler: @escaping (Bool) -> Void) {
        completionHandler(AppDelegate.shared.onShortcut(type: shortcutItem.type, payload: ""))
    }
}
#endif

#if os(iOS)
import AppIntents

struct NewMeetingIntent: AppIntent {
    static let title: LocalizedStringResource = "New Meeting"
    static let description = IntentDescription("Opens the lobby for a new Conclave meeting.")
    static let openAppWhenRun = true

    @MainActor
    func perform() async throws -> some IntentResult {
        AppDelegate.shared.onShortcut(type: "new_meeting", payload: "")
        return .result()
    }
}

struct JoinMeetingIntent: AppIntent {
    static let title: LocalizedStringResource = "Join Meeting"
    static let description = IntentDescription("Joins a Conclave meeting with its code, or opens the Join sheet.")
    static let openAppWhenRun = true

    @Parameter(title: "Meeting Code")
    var code: String?

    @MainActor
    func perform() async throws -> some IntentResult {
        AppDelegate.shared.onShortcut(type: "join_code", payload: code ?? "")
        return .result()
    }
}

struct ConclaveAppShortcuts: AppShortcutsProvider {
    static var appShortcuts: [AppShortcut] {
        AppShortcut(
            intent: NewMeetingIntent(),
            phrases: ["Start a meeting in \(.applicationName)", "New \(.applicationName) meeting"],
            shortTitle: "New Meeting",
            systemImageName: "video.badge.plus"
        )
        AppShortcut(
            intent: JoinMeetingIntent(),
            phrases: ["Join a meeting in \(.applicationName)"],
            shortTitle: "Join Meeting",
            systemImageName: "keyboard"
        )
    }
}
#endif
