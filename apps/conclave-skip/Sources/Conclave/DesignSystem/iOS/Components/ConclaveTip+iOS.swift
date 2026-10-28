#if os(iOS) && !SKIP
import SwiftUI
import TipKit

struct ConclaveOneTimeTip: Tip {
    let tipID: OneTimeTipID
    let titleText: String
    let messageText: String

    let symbol: String

    var id: String { OneTimeTipPolicy.storeKey(tipID.rawValue) }
    var title: Text { Text(titleText) }
    var message: Text? { Text(messageText) }
    var image: Image? { Image(systemName: symbol) }
}

struct ConclaveTipView: View {
    let tip: ConclaveOneTimeTip
    let identifier: String

    var body: some View {

        TipView<ConclaveOneTimeTip>(tip)
            .accessibilityIdentifier(identifier)
    }
}
#endif
