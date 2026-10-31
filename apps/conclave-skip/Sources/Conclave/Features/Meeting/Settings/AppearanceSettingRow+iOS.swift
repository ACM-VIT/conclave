#if os(iOS) && !SKIP
import SwiftUI

struct AppearanceSettingRow: View {
    private let preference = AppearancePreference.shared

    var body: some View {
        Picker(ConclaveStrings.text("Appearance"), selection: Binding(
            get: { preference.mode }, set: { preference.setMode($0) }
        )) {
            Text(ConclaveStrings.text("System")).tag(AppearanceMode.system)
            Text(ConclaveStrings.text("Light")).tag(AppearanceMode.light)
            Text(ConclaveStrings.text("Dark")).tag(AppearanceMode.dark)
        }
        .pickerStyle(.menu)
        .accessibilityIdentifier("settings.appearance")
    }
}
#endif
