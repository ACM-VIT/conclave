import Foundation

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

    static var nativeUIAvailable: Bool {
        #if os(iOS) || SKIP
        return true
        #else
        return false
        #endif
    }

    private let productionKeys: [NativeRouteKey]
    private(set) var enabledKeys: [NativeRouteKey]

    private(set) var premeetingFixture: String = ""
    private var fixtureSelectorPresented = false
    private var hostingPreviewPresented = false

    var suppressesProductionLifecycle: Bool {
        fixtureSelectorPresented || hostingPreviewPresented
    }

    func configureFixturePresentation(selectorPresented: Bool, hostingPreviewPresented: Bool, debugEligible: Bool) {
        fixtureSelectorPresented = debugEligible && selectorPresented
        self.hostingPreviewPresented = debugEligible && hostingPreviewPresented
    }

    func dismissHostingPreview() {
        hostingPreviewPresented = false
    }

    init(nativeUIAvailable: Bool = NativeRouteFlags.nativeUIAvailable) {
        productionKeys = nativeUIAvailable ? [.premeeting, .call] : []
        enabledKeys = productionKeys
    }

    func configure(routes: String?, premeetingFixture: String?, debugEligible: Bool) {
        guard debugEligible else {
            reset()
            return
        }
        self.premeetingFixture = (premeetingFixture ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        enabledKeys = routes == nil && self.premeetingFixture.isEmpty
            ? productionKeys
            : NativeRouteFlags.parse(routes)
    }

    func reset() {
        enabledKeys = productionKeys
        premeetingFixture = ""
        fixtureSelectorPresented = false
        hostingPreviewPresented = false
    }

    func isEnabled(_ key: NativeRouteKey) -> Bool {
        enabledKeys.contains(key)
    }

    var routesPremeetingNatively: Bool {
        isEnabled(.premeeting) || PremeetingFixtureScript.state(named: premeetingFixture) != nil
    }

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

    func configureFromLaunchEnvironment() {
        #if DEBUG && !SKIP
        let fixture = NativeRuntimeConfig.debugLaunchValue(forKey: NativeRouteFlags.premeetingFixtureEnvironmentKey)
        configure(
            routes: NativeRuntimeConfig.debugViewerRoutes(
                explicitValue: NativeRuntimeConfig.debugLaunchValue(forKey: NativeRouteFlags.routesEnvironmentKey),
                premeetingFixture: fixture,
                profileEnabled: NativeRuntimeConfig.usesDebugViewerProfile
            ),
            premeetingFixture: fixture,
            debugEligible: true
        )
        #if os(iOS)
        let environment = NativeRuntimeConfig.debugLaunchEnvironment()
        configureFixturePresentation(
            selectorPresented: NativeFixtureLaunch.iOSSelector(
                system: environment["CONCLAVE_SYSTEM_FIXTURE"],
                stage: environment["CONCLAVE_STAGE_FIXTURE"],
                people: environment["CONCLAVE_PEOPLE_FIXTURE"],
                premeeting: premeetingFixture
            ),
            hostingPreviewPresented: environment["CONCLAVE_HOSTING_PREVIEW"] == "1",
            debugEligible: true
        )
        #endif
        #endif
    }
}

public enum NativeFixtureLaunch {

    public static var suppressesProductionLifecycle: Bool {
        NativeRouteFlags.shared.suppressesProductionLifecycle
    }

    public static func configurePresentation(selectorPresented: Bool, hostingPreviewPresented: Bool, debugEligible: Bool) {
        NativeRouteFlags.shared.configureFixturePresentation(
            selectorPresented: selectorPresented,
            hostingPreviewPresented: hostingPreviewPresented,
            debugEligible: debugEligible
        )
    }

    static func iOSSelector(system: String?, stage: String?, people: String?, premeeting: String?) -> Bool {
        SystemFixtureScript.state(named: system ?? "") != nil
            || ControlsFixtureScript.state(named: stage ?? "") != nil
            || StageFixtureScript.state(named: stage ?? "") != nil
            || iOSPeopleState(people) != nil
            || PremeetingFixtureScript.state(named: premeeting ?? "") != nil
    }

    static func iOSPeopleState(_ raw: String?) -> PeopleFixtureState? {
        guard let raw else { return nil }
        if let state = PeopleFixtureScript.state(named: raw) { return state }
        guard let qa = iOSPeopleQaState(raw) else { return nil }
        return PeopleWebinarFixtureScript.baseState(qa)
    }

    static func iOSPeopleQaState(_ raw: String?) -> PeopleWebinarFixtureState? {
        guard let raw else { return nil }
        return PeopleWebinarFixtureScript.state(named: raw)
    }

    public static func androidSelector(system: String?, stage: String?, people: String?, premeeting: String?) -> Bool {

        system != nil || stage != nil || people != nil
            || PremeetingFixtureScript.state(named: premeeting ?? "") != nil
    }

    public static func androidRootPresented(
        selectorRequested: Bool,
        hostingPreviewRequested: Bool,
        isInCall: Bool,
        debugEligible: Bool
    ) -> Bool {
        debugEligible && !isInCall && (selectorRequested || hostingPreviewRequested)
    }
}
