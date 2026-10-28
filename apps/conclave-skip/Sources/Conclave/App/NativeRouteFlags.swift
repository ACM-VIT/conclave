import Foundation

// PLAN-screens 2 "Route switches": the one Debug-only registry of native routes. iOS reads the launch environment
// `CONCLAVE_NATIVE_ROUTES=<comma list>` (and `CONCLAVE_PREMEETING_FIXTURE=<state>`, S10 L9) in Debug builds only;
// Android's MainActivity passes the intent extras `conclave.nativeRoutes` and `conclave.premeetingFixture` after
// checking BuildConfig.DEBUG and FLAG_DEBUGGABLE, as it does for `conclave.hostingPreview`. Release builds never
// configure the registry, so every key reads false and the legacy roots stay the default until a flip slice
// (ENT-FLIP, CALL-FLIP) changes the default. Transpiled; read on the main thread only.

/// The native route keys (PLAN-screens 2). `premeeting`: Home, the join sheet and the premeeting stack (ENT slices).
/// `call`: the native call root (STG-1) inside the premeeting root's call branch.
enum NativeRouteKey: String, CaseIterable, Equatable {
    case premeeting
    case call
}

final class NativeRouteFlags {
    static let shared = NativeRouteFlags()

    static let routesEnvironmentKey = "CONCLAVE_NATIVE_ROUTES"
    static let routesExtraKey = "conclave.nativeRoutes"
    static let premeetingFixtureEnvironmentKey = "CONCLAVE_PREMEETING_FIXTURE"
    static let premeetingFixtureExtraKey = "conclave.premeetingFixture"

    /// The enabled keys in declaration order (empty until a Debug configuration).
    private(set) var enabledKeys: [NativeRouteKey] = []
    /// The S10 L9 fixture state name ("" for an ordinary launch).
    private(set) var premeetingFixture: String = ""

    init() {
    }

    /// Debug launch configuration. `debugEligible` is false in every Release build (the caller checks the build type
    /// and, on Android, FLAG_DEBUGGABLE), and then nothing changes. A later call replaces the earlier one.
    func configure(routes: String?, premeetingFixture: String?, debugEligible: Bool) {
        guard debugEligible else { return }
        enabledKeys = NativeRouteFlags.parse(routes)
        self.premeetingFixture = (premeetingFixture ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// Clears the registry (tests).
    func reset() {
        enabledKeys = []
        premeetingFixture = ""
    }

    func isEnabled(_ key: NativeRouteKey) -> Bool {
        enabledKeys.contains(key)
    }

    /// The native premeeting root shows (the flag or the L9 fixture); deep links then go to its presenter.
    var routesPremeetingNatively: Bool {
        isEnabled(.premeeting) || PremeetingFixtureScript.state(named: premeetingFixture) != nil
    }

    /// The keys a comma list names, in declaration order: names are trimmed and case-insensitive; unknown names,
    /// blanks and duplicates are dropped.
    static func parse(_ raw: String?) -> [NativeRouteKey] {
        guard let raw else { return [] }
        var named: [String] = []
        for part in raw.split(separator: ",", omittingEmptySubsequences: true) {
            let name = String(part).trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
            if !name.isEmpty {
                named.append(name)
            }
        }
        var keys: [NativeRouteKey] = []
        for key in NativeRouteKey.allCases where named.contains(key.rawValue.lowercased()) {
            keys.append(key)
        }
        return keys
    }

    /// iOS: Debug environment or `--conclave-config=KEY=VALUE` arguments. A no-op in Release and on Android.
    func configureFromLaunchEnvironment() {
        #if DEBUG && !SKIP
        configure(
            routes: NativeRuntimeConfig.debugLaunchValue(forKey: NativeRouteFlags.routesEnvironmentKey),
            premeetingFixture: NativeRuntimeConfig.debugLaunchValue(forKey: NativeRouteFlags.premeetingFixtureEnvironmentKey),
            debugEligible: true
        )
        #endif
    }
}
