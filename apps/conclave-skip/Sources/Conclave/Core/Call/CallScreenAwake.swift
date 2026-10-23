//  Keeps the display from sleeping for the length of a call. Toggled only from
//  MeetingViewModel.activateCallPresence() / deactivateCallPresence(), so it
//  follows the same joined-call gate as CallKit and the Android call service.
import Foundation
import SwiftUI
#if canImport(UIKit) && !SKIP
import UIKit
#endif

@MainActor
enum CallScreenAwake {
    static func setActive(_ active: Bool) {
        #if SKIP
        // SkipUI maps this to FLAG_KEEP_SCREEN_ON on the activity window and
        // re-applies it when a recreated MainActivity is attached.
        UIApplication.shared.isIdleTimerDisabled = active
        #elseif os(iOS)
        UIApplication.shared.isIdleTimerDisabled = active
        #endif
    }
}
