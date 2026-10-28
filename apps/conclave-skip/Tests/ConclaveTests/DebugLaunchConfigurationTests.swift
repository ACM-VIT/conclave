#if DEBUG && !SKIP
import Testing
@testable import Conclave

struct DebugLaunchConfigurationTests {
    @Test func argumentsEnableNativeRoutesThroughTheExistingRegistry() {
        let flags = NativeRouteFlags()
        let arguments = ["Conclave", "--conclave-config=CONCLAVE_NATIVE_ROUTES=premeeting,call"]
        flags.configure(
            routes: NativeRuntimeConfig.debugLaunchValue(forKey: "CONCLAVE_NATIVE_ROUTES", environment: [:], arguments: arguments),
            premeetingFixture: nil,
            debugEligible: true
        )
        #expect(flags.enabledKeys == [.premeeting, .call])
    }

    @Test func environmentIncludingAnEmptyValueTakesPrecedence() {
        let arguments = ["Conclave", "--conclave-config=CONCLAVE_NATIVE_ROUTES=premeeting,call"]
        for value in ["", "call", " premeeting "] {
            #expect(NativeRuntimeConfig.debugLaunchValue(
                forKey: "CONCLAVE_NATIVE_ROUTES",
                environment: ["CONCLAVE_NATIVE_ROUTES": value],
                arguments: arguments
            ) == value)
        }
    }

    @Test func joinURLKeepsItsQueryAndExistingURLValidation() {
        let value = NativeRuntimeConfig.debugLaunchValue(
            forKey: "SFU_JOIN_URL", environment: [:],
            arguments: ["Conclave", "--conclave-config=SFU_JOIN_URL=https://conclave.acmvit.in/api/sfu/join?probe=a=b"]
        )
        #expect(value == "https://conclave.acmvit.in/api/sfu/join?probe=a=b")
        #expect(SfuJoinService.configuredJoinURL(from: value ?? "", allowProductionHost: true) == nil)
        #expect(SfuJoinService.configuredJoinURL(from: "https://conclave.acmvit.in/api/sfu/join", allowProductionHost: true)?.host == "conclave.acmvit.in")
        #expect(SfuJoinService.configuredJoinURL(from: "not a URL", allowProductionHost: true) == nil)
    }

    @Test func canonicalAuthArgumentIsAvailableWithoutChangingEnvironmentAliases() {
        let arguments = ["Conclave", "--conclave-config=CONCLAVE_AUTH_BASE_URL=https://conclave.acmvit.in"]
        #expect(NativeRuntimeConfig.debugLaunchValue(forKey: "CONCLAVE_AUTH_BASE_URL", environment: [:], arguments: arguments) == "https://conclave.acmvit.in")
        #expect(NativeRuntimeConfig.debugLaunchValue(forKey: "CONCLAVE_AUTH_BASE_URL", environment: ["CONCLAVE_AUTH_BASE_URL": "http://localhost:3000"], arguments: arguments) == "http://localhost:3000")
        #expect(NativeRuntimeConfig.debugLaunchValue(forKey: "AUTH_BASE_URL", environment: ["AUTH_BASE_URL": "existing"], arguments: arguments) == "existing")
    }

    @Test func emptyAndMalformedArgumentsDoNotMaskAValidFollowingArgument() {
        #expect(NativeRuntimeConfig.debugLaunchValue(
            forKey: "CONCLAVE_PREMEETING_FIXTURE", environment: [:], arguments: [
                "--conclave-config=CONCLAVE_PREMEETING_FIXTURE=executable-name",
                "--conclave-config=CONCLAVE_PREMEETING_FIXTURE_OTHER=wrong",
                "--conclave-config=CONCLAVE_PREMEETING_FIXTURE",
                "--conclave-config=CONCLAVE_PREMEETING_FIXTURE=  ",
                "--conclave-config=CONCLAVE_PREMEETING_FIXTURE= home ",
                "--conclave-config=CONCLAVE_PREMEETING_FIXTURE=ignored"
            ]
        ) == "home")
    }

    @Test func unsupportedArgumentsAreIgnoredAndExistingEnvironmentRemainsReadable() {
        let arguments = ["Conclave", "--conclave-config=AUTH_BASE_URL=https://example.com"]
        #expect(NativeRuntimeConfig.debugLaunchValue(forKey: "AUTH_BASE_URL", environment: [:], arguments: arguments) == nil)
        #expect(NativeRuntimeConfig.debugLaunchValue(forKey: "AUTH_BASE_URL", environment: ["AUTH_BASE_URL": "existing"], arguments: arguments) == "existing")
        #expect(NativeRuntimeConfig.debugLaunchValue(forKey: "CONCLAVE_NATIVE_ROUTES", environment: [:], arguments: []) == nil)
    }
}
#endif
