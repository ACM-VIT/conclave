import Foundation
#if os(iOS) && !SKIP
import UIKit
#endif

enum StoreListing {
    static let appStoreURL = "https://apps.apple.com/app/id6758411334"
    static let playStoreURL = "https://play.google.com/store/apps/details?id=com.acmvit.conclave"

    static var platformURL: String {
        #if SKIP
        return playStoreURL
        #else
        return appStoreURL
        #endif
    }

    @MainActor
    static func open(_ url: String) {
        #if SKIP
        NativeAppInfo.openStoreListing(url)
        #elseif os(iOS)
        guard let target = URL(string: url) else { return }
        UIApplication.shared.open(target)
        #endif
    }
}
