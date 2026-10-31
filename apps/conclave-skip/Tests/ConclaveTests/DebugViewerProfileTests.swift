#if !SKIP
import Testing
@testable import Conclave

@MainActor
struct DebugViewerProfileTests {
    private let productionJoin = "https://conclave.acmvit.in/api/sfu/join"
    private let productionAuth = "https://conclave.acmvit.in"
    private let localJoin = "http://127.0.0.1:3000/api/sfu/join"

    @Test(arguments: ["YES", " yes ", "true", "TRUE", "1"])
    func enabledBuildMetadataRequiresDebugEligibility(value: String) {
        #expect(NativeRuntimeConfig.isDebugViewerProfileEnabled(configuredValue: value, debugEligible: true))
        #expect(!NativeRuntimeConfig.isDebugViewerProfileEnabled(configuredValue: value, debugEligible: false))
    }

    @Test(arguments: ["", "NO", "false", "FALSE", "0", "viewer", "$(CONCLAVE_DEBUG_VIEWER_PROFILE)"])
    func absentOrDisabledMetadataDoesNotEnableTheProfile(value: String) {
        #expect(!NativeRuntimeConfig.isDebugViewerProfileEnabled(configuredValue: value, debugEligible: true))
    }

    @Test func missingMetadataRetainsOrdinaryDebugRoutesAndLocalSimulatorDefault() {
        let profile = NativeRuntimeConfig.isDebugViewerProfileEnabled(configuredValue: nil, debugEligible: true)
        let flags = makeFlags(profile: profile)
        #expect(flags.enabledKeys == [.premeeting, .call])
        #expect(flags.premeetingFixture.isEmpty)
        #expect(!flags.suppressesProductionLifecycle)
        #expect(SfuJoinService.resolveDebugJoinURL(
            launchValue: nil, bundledValue: productionJoin, isSimulator: true, viewerProfileEnabled: profile
        ).absoluteString == localJoin)
        #expect(NativeAuthService.configuredDebugBundledBaseURL(from: productionAuth, allowProductionHost: profile) == nil)
    }

    @Test func newRouteRegistriesResolveBuildDefaultsWithoutFixtures() {
        for _ in 0..<2 {
            let profile = NativeRuntimeConfig.isDebugViewerProfileEnabled(configuredValue: "YES", debugEligible: true)
            let flags = makeFlags(profile: profile)
            #expect(flags.enabledKeys == [.premeeting, .call])
            #expect(flags.premeetingFixture.isEmpty)
            #expect(!flags.suppressesProductionLifecycle)
            #expect(SfuJoinService.resolveDebugJoinURL(
                launchValue: nil, bundledValue: productionJoin, isSimulator: true, viewerProfileEnabled: profile
            ).absoluteString == productionJoin)
            #expect(NativeAuthService.configuredDebugBundledBaseURL(
                from: productionAuth, allowProductionHost: profile
            )?.absoluteString == productionAuth)
        }
    }

    @Test func releaseEligibilityIgnoresViewerMetadataAndKeepsProductionRoutes() {
        let profile = NativeRuntimeConfig.isDebugViewerProfileEnabled(configuredValue: "true", debugEligible: false)
        let flags = makeFlags(profile: profile, debugEligible: false)
        #expect(!profile)
        #expect(flags.enabledKeys == [.premeeting, .call])
        #expect(flags.premeetingFixture.isEmpty)
        #expect(SfuJoinService.configuredProductionJoinURL(from: localJoin) == nil)
        #expect(SfuJoinService.configuredProductionJoinURL(from: productionJoin)?.absoluteString == productionJoin)
        #if !DEBUG
        #expect(!NativeRuntimeConfig.usesDebugViewerProfile)
        #endif
    }

    @Test(arguments: ["", "call", "premeeting", "none"])
    func explicitRoutesOverrideProfileDefaults(value: String) {
        let flags = makeFlags(profile: true, routes: value)
        #expect(flags.enabledKeys == NativeRouteFlags.parse(value))
        #expect(flags.premeetingFixture.isEmpty)
    }

    @Test func explicitFixtureRetainsItsOwnSelectionWithoutProfileRoutes() {
        let flags = makeFlags(profile: true, fixture: " home ")
        #expect(flags.premeetingFixture == "home")
        #expect(flags.enabledKeys.isEmpty)
        #expect(flags.routesPremeetingNatively)
        #expect(NativeFixtureLaunch.iOSSelector(system: nil, stage: nil, people: nil, premeeting: flags.premeetingFixture))
        flags.configureFixturePresentation(selectorPresented: true, hostingPreviewPresented: false, debugEligible: true)
        #expect(flags.suppressesProductionLifecycle)
        let explicit = makeFlags(profile: true, routes: "call", fixture: "home")
        #expect(explicit.enabledKeys == [.call])
        #expect(explicit.premeetingFixture == "home")
    }

    @Test(arguments: ["http://127.0.0.1:3000/api/sfu/join", "http://localhost:3000/api/sfu/join", "https://custom.example/api/sfu/join"])
    func explicitLaunchAndBundledJoinEndpointsKeepPrecedence(value: String) {
        #expect(SfuJoinService.resolveDebugJoinURL(
            launchValue: value, bundledValue: productionJoin, isSimulator: true, viewerProfileEnabled: true
        ).absoluteString == value)
        #expect(SfuJoinService.resolveDebugJoinURL(
            launchValue: nil, bundledValue: value, isSimulator: true, viewerProfileEnabled: true
        ).absoluteString == value)
    }

    @Test(arguments: ["http://127.0.0.1:3000", "http://localhost:3000", "https://custom.example"])
    func customBundledAuthEndpointsRemainUsable(value: String) {
        #expect(NativeAuthService.configuredDebugBundledBaseURL(from: value, allowProductionHost: true)?.absoluteString == value)
        #expect(NativeAuthService.configuredDebugBundledBaseURL(from: value, allowProductionHost: false)?.absoluteString == value)
    }

    @Test func explicitProductionLaunchStillWorksWithoutTheProfile() {
        #expect(SfuJoinService.resolveDebugJoinURL(
            launchValue: productionJoin, bundledValue: localJoin, isSimulator: true, viewerProfileEnabled: false
        ).absoluteString == productionJoin)
    }

    @Test func profileFallbackIsProductionAndRejectsInvalidConfiguredURLs() {
        #expect(SfuJoinService.resolveDebugJoinURL(
            launchValue: "not a URL", bundledValue: nil, isSimulator: true, viewerProfileEnabled: true
        ).absoluteString == productionJoin)
        #expect(SfuJoinService.resolveDebugJoinURL(
            launchValue: nil, bundledValue: productionJoin + "?unexpected=1", isSimulator: true, viewerProfileEnabled: true
        ).absoluteString == productionJoin)
        #expect(SfuJoinService.resolveDebugJoinURL(
            launchValue: nil, bundledValue: nil, isSimulator: false, viewerProfileEnabled: false
        ).absoluteString == productionJoin)
        #expect(NativeAuthService.configuredDebugBundledBaseURL(from: "not a URL", allowProductionHost: true) == nil)
    }

    #if DEBUG
    @Test func launchArgumentsCannotEnableTheBuildProfile() {
        let arguments = ["Conclave", "--conclave-config=CONCLAVE_DEBUG_VIEWER_PROFILE=YES"]
        #expect(NativeRuntimeConfig.debugLaunchValue(forKey: NativeRuntimeConfig.debugViewerProfileKey, environment: [:], arguments: arguments) == nil)
        #expect(NativeRuntimeConfig.debugLaunchEnvironment(environment: [:], arguments: arguments).isEmpty)
    }

    @Test func launchRouteAndAuthArgumentsRetainTheirExistingPrecedence() {
        let arguments = [
            "Conclave",
            "--conclave-config=CONCLAVE_NATIVE_ROUTES=premeeting",
            "--conclave-config=CONCLAVE_AUTH_BASE_URL=http://localhost:3000"
        ]
        let routes = NativeRuntimeConfig.debugLaunchValue(forKey: "CONCLAVE_NATIVE_ROUTES", environment: ["CONCLAVE_NATIVE_ROUTES": "call"], arguments: arguments)
        #expect(makeFlags(profile: true, routes: routes).enabledKeys == [.call])
        #expect(NativeRuntimeConfig.debugLaunchValue(forKey: "CONCLAVE_AUTH_BASE_URL", environment: [:], arguments: arguments) == "http://localhost:3000")
    }
    #endif

    private func makeFlags(profile: Bool, routes: String? = nil, fixture: String? = nil, debugEligible: Bool = true) -> NativeRouteFlags {
        let flags = NativeRouteFlags(nativeUIAvailable: true)
        flags.configure(
            routes: NativeRuntimeConfig.debugViewerRoutes(explicitValue: routes, premeetingFixture: fixture, profileEnabled: profile),
            premeetingFixture: fixture,
            debugEligible: debugEligible
        )
        return flags
    }
}
#endif
