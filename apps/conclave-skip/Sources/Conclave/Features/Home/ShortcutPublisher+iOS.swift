#if os(iOS) && !SKIP
import UIKit

@MainActor
enum ShortcutPublisher {
    static let rejoinSymbol = "arrow.uturn.backward"

    static func publish(rejoin: RejoinCard?) {
        let rejoinType = ConclaveShortcut.rejoin.platformType
        let kept = (UIApplication.shared.shortcutItems ?? []).filter { $0.type != rejoinType }
        guard let rejoin else {
            UIApplication.shared.shortcutItems = kept
            return
        }
        let item = UIApplicationShortcutItem(
            type: rejoinType,
            localizedTitle: ConclaveStrings.format("Rejoin %@", EntryPolicies.roomLabel(rejoin.title)),
            localizedSubtitle: nil,
            icon: UIApplicationShortcutIcon(systemImageName: rejoinSymbol),
            userInfo: nil
        )
        UIApplication.shared.shortcutItems = kept + [item]
    }
}
#endif
