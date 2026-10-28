import Foundation
import Observation

enum AppearanceMode: String, CaseIterable {
    case system, light, dark

    func usesDarkAppearance(systemIsDark: Bool) -> Bool {
        switch self {
        case .system: return systemIsDark
        case .light: return false
        case .dark: return true
        }
    }
}

@MainActor
@Observable
final class AppearancePreference {
    static let storageKey = "conclave.pref.appearance"
    static let shared = AppearancePreference()

    private(set) var mode: AppearanceMode
    @ObservationIgnored private let defaults: UserDefaults

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        mode = AppearanceMode(rawValue: defaults.string(forKey: Self.storageKey) ?? "") ?? .system
    }

    func setMode(_ mode: AppearanceMode) {
        if self.mode != mode { self.mode = mode }
        if mode == .system {
            if defaults.object(forKey: Self.storageKey) != nil {
                defaults.removeObject(forKey: Self.storageKey)
            }
        } else if defaults.string(forKey: Self.storageKey) != mode.rawValue {
            defaults.set(mode.rawValue, forKey: Self.storageKey)
        }
    }
}
