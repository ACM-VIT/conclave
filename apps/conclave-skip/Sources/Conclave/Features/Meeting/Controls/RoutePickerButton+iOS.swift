#if os(iOS) && !SKIP
import SwiftUI

// S30 3 c (CTL-3): the iOS in-call route button, top trailing in the stage's glass cluster (S20 7 owns the position,
// StageChrome+iOS.swift mounts it). It is the FND component `ConclaveRoutePickerButton` (F00 C03 c: the system
// `AVRoutePickerView` inside a 44 pt On circle; the system owns the glyph, the output list, its glass and its
// accessibility label, H-32) reporting through the controls presenter: while the system list shows, chrome stays
// visible (CC16 `route.picker`); when it closes, the route owner learns that a change in the next 2 s is the person's
// choice and adopts it instead of fighting it (S70 5 c). There is no app-drawn output list on iOS (S30 Q12); the Mic
// shortcut adds only the Speaker toggle, the microphone choice and Mic Mode (MediaShortcutMenu+iOS.swift). Automatic
// changes reach the S20 toast lane and its announcement through the core ("Audio switched to %@"); a person's choice in
// the list posts nothing and plays nothing (S30 3 h). Created once per stage: chrome fades never recreate it (F00 C03 k).

struct CallRoutePickerButton: View {
    let controls: CallControlsPresenter

    var body: some View {
        ConclaveRoutePickerButton(identifier: "stage.route", onPresentingChange: { open in
            controls.setRoutePickerOpen(open)
        })
    }
}
#endif
