#if !SKIP
import Foundation
import Testing
@testable import Conclave

@MainActor
struct AppearancePreferenceTests {
    @Test func systemAppearanceFollowsBothSystemValues() {
        #expect(!AppearanceMode.system.usesDarkAppearance(systemIsDark: false))
        #expect(AppearanceMode.system.usesDarkAppearance(systemIsDark: true))
        #expect(!AppearanceMode.light.usesDarkAppearance(systemIsDark: false))
        #expect(!AppearanceMode.light.usesDarkAppearance(systemIsDark: true))
        #expect(AppearanceMode.dark.usesDarkAppearance(systemIsDark: false))
        #expect(AppearanceMode.dark.usesDarkAppearance(systemIsDark: true))
    }

    @Test func selectedAppearancePersistsAcrossOwnersAndSystemClearsOverride() throws {
        let suite = "AppearancePreferenceTests." + UUID().uuidString
        let defaults = try #require(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let preference = AppearancePreference(defaults: defaults)
        #expect(preference.mode == .system)
        preference.setMode(.dark)
        #expect(AppearancePreference(defaults: defaults).mode == .dark)
        preference.setMode(.light)
        #expect(AppearancePreference(defaults: defaults).mode == .light)
        preference.setMode(.system)
        #expect(defaults.object(forKey: AppearancePreference.storageKey) == nil)
        #expect(AppearancePreference(defaults: defaults).mode == .system)
    }

    @Test func unknownStoredValuesFallBackWithoutChangingOtherPreferences() throws {
        let suite = "AppearancePreferenceTests." + UUID().uuidString
        let defaults = try #require(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        defaults.set("future", forKey: AppearancePreference.storageKey)
        defaults.set("kept", forKey: "unrelated.preference")
        let preference = AppearancePreference(defaults: defaults)
        #expect(preference.mode == .system)
        preference.setMode(.system)
        #expect(defaults.object(forKey: AppearancePreference.storageKey) == nil)
        preference.setMode(.dark)
        #expect(defaults.string(forKey: "unrelated.preference") == "kept")
        #expect(defaults.string(forKey: AppearancePreference.storageKey) == "dark")
    }
}
#endif
