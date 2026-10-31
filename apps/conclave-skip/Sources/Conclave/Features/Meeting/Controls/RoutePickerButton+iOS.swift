#if os(iOS) && !SKIP
import SwiftUI

struct CallRoutePickerButton: View {
    let controls: CallControlsPresenter

    var body: some View {
        ConclaveRoutePickerButton(identifier: "stage.route", onPresentingChange: { open in
            controls.setRoutePickerOpen(open)
        })
    }
}
#endif
