import Foundation
#if canImport(UIKit) && !SKIP
import UIKit
#endif

@MainActor
enum MeetingShare {
    static func shareMeetingLink(_ link: String, roomId: String) {
        #if SKIP
        NativeMeetingShare.shareMeetingLink(link: link, roomId: roomId)
        #elseif canImport(UIKit)
        guard let presenter = topViewController(from: rootViewController()),
              let presenterView = presenter.view else {
            UIPasteboard.general.string = link
            HapticManager.shared.trigger(.success)
            return
        }

        let message = "Join me in this Conclave room.\n\(link)"
        let controller = UIActivityViewController(activityItems: [message], applicationActivities: nil)
        controller.title = "Conclave meeting"
        controller.popoverPresentationController?.sourceView = presenterView
        controller.popoverPresentationController?.sourceRect = CGRect(
            x: presenterView.bounds.midX,
            y: presenterView.bounds.midY,
            width: 1,
            height: 1
        )
        presenter.present(controller, animated: true)
        #else
        _ = link
        _ = roomId
        #endif
    }

    static func copyMeetingLink(_ link: String) {
        #if SKIP
        ClipboardHelper.copyToClipboard(text: link, label: "Meeting link")
        #elseif canImport(UIKit)
        UIPasteboard.general.string = link
        HapticManager.shared.trigger(.success)
        #else
        _ = link
        #endif
    }

    #if canImport(UIKit) && !SKIP
    private static func topViewController(from base: UIViewController?) -> UIViewController? {
        if let navigationController = base as? UINavigationController {
            return topViewController(from: navigationController.visibleViewController)
        }
        if let tabBarController = base as? UITabBarController {
            return topViewController(from: tabBarController.selectedViewController)
        }
        if let presented = base?.presentedViewController {
            return topViewController(from: presented)
        }
        return base
    }

    private static func rootViewController() -> UIViewController? {
        let windows = UIApplication.shared.connectedScenes
            .compactMap { $0 as? UIWindowScene }
            .flatMap(\.windows)

        return windows.first(where: { $0.isKeyWindow })?.rootViewController
            ?? windows.first?.rootViewController
    }
    #endif
}
