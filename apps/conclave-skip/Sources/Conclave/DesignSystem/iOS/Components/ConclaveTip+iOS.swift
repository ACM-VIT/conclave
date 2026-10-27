#if os(iOS) && !SKIP
import SwiftUI
import TipKit

// The one-time tip (F00 C25; RECONCILE R39): a TipKit tip shown inline with `TipView` inside the content of the panel
// where the feature lives, never as a popover, coachmark or tooltip over the stage or the control bar. One tip type
// per `OneTimeTipID`; the TipKit id is `OneTimeTipPolicy.storeKey`, so the system close control invalidates it
// (`.tipClosed`) and the TipKit datastore keeps it dismissed across relaunches. The app configures TipKit once at
// launch (`Tips.configure`, ConclaveApp). The TipView keeps the system materials and close control (never
// restyled), is read in content order and never takes focus. The hosting screen owns the copy and decides
// eligibility with `OneTimeTipPolicy.isEligible` (at most one tip per panel presentation, hidden while the panel
// is loading, empty for another reason or in an error state).

/// One tip. Title, message and symbol come from the hosting screen (S40 7 g for the GIF picker tip).
struct ConclaveOneTimeTip: Tip {
    let tipID: OneTimeTipID
    let titleText: String
    let messageText: String
    /// A `ConclaveSymbols` literal.
    let symbol: String

    var id: String { OneTimeTipPolicy.storeKey(tipID.rawValue) }
    var title: Text { Text(titleText) }
    var message: Text? { Text(messageText) }
    var image: Image? { Image(systemName: symbol) }
}

/// The inline tip for panel content. Place it above the content it explains; it composes nothing once dismissed.
struct ConclaveTipView: View {
    let tip: ConclaveOneTimeTip
    let identifier: String

    var body: some View {
        // The explicit specialization picks the iOS 17 initializer; the newer AnyTip initializers are iOS 18 and 26.
        TipView<ConclaveOneTimeTip>(tip)
            .accessibilityIdentifier(identifier)
    }
}
#endif
