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

    @Test func fixtureSnapshotAcceptsOnlyTheExistingFixtureSelectorsAndOptions() {
        let fixtures = [
            "CONCLAVE_HOSTING_PREVIEW": "1",
            "CONCLAVE_SYSTEM_FIXTURE": "presence-live-muted",
            "CONCLAVE_SYSTEM_FIXTURE_PROVIDER": "fake",
            "CONCLAVE_STAGE_FIXTURE": "grid-3",
            "CONCLAVE_STAGE_FIXTURE_PATTERN": "live",
            "CONCLAVE_STAGE_FORCE_SCREEN_READER": "1",
            "CONCLAVE_PEOPLE_FIXTURE": "people-host-hands-3",
            "CONCLAVE_CHAT_FIXTURE": "chat-draft-multiline",
            "CONCLAVE_TRANSCRIPT_FIXTURE": "transcript-ask"
        ]
        let arguments = ["Conclave"] + fixtures.map { "--conclave-config=\($0.key)=\($0.value)" } + [
            "--conclave-config=CONCLAVE_UNKNOWN_FIXTURE=unexpected",
            "--conclave-config=CONCLAVE_RESET_TIPS=1",
            "--conclave-config=CONCLAVE_DIAG_FORCE_REDACTION_FAILURE=1"
        ]
        #expect(NativeRuntimeConfig.debugLaunchEnvironment(environment: [:], arguments: arguments) == fixtures)
    }

    @Test func fixtureSnapshotPreservesExplicitEnvironmentValuesIncludingDisabledSelectors() {
        let environment = [
            "CONCLAVE_STAGE_FIXTURE": "grid-4",
            "CONCLAVE_CHAT_FIXTURE": "",
            "CONCLAVE_SYSTEM_FIXTURE_PROVIDER": "fake",
            "UNRELATED_ENVIRONMENT": "unchanged"
        ]
        let resolved = NativeRuntimeConfig.debugLaunchEnvironment(environment: environment, arguments: [
            "Conclave",
            "--conclave-config=CONCLAVE_STAGE_FIXTURE=grid-3",
            "--conclave-config=CONCLAVE_CHAT_FIXTURE=chat-busy",
            "--conclave-config=CONCLAVE_SYSTEM_FIXTURE_PROVIDER=real"
        ])
        #expect(resolved == environment)
        #expect(NativeRuntimeConfig.debugLaunchEnvironment(environment: [:], arguments: []) == [:])
    }

    @Test @MainActor func fixtureSnapshotFeedsExistingControlGameAndPanelParsers() {
        let control = NativeRuntimeConfig.debugLaunchEnvironment(environment: [:], arguments: [
            "Conclave", "--conclave-config=CONCLAVE_STAGE_FIXTURE=controls-host"
        ])
        #expect(ControlsFixtureScript.state(named: control["CONCLAVE_STAGE_FIXTURE"] ?? "") == .host)
        #expect(StageFixtureScript.state(named: control["CONCLAVE_STAGE_FIXTURE"] ?? "") == nil)

        let game = NativeRuntimeConfig.debugLaunchEnvironment(environment: [:], arguments: [
            "Conclave", "--conclave-config=CONCLAVE_STAGE_FIXTURE=game-wordle-guess",
            "--conclave-config=CONCLAVE_CHAT_FIXTURE=chat-empty",
            "--conclave-config=CONCLAVE_TRANSCRIPT_FIXTURE=transcript-live-controller"
        ])
        #expect(StageFixtureScript.state(named: game["CONCLAVE_STAGE_FIXTURE"] ?? "") == .gameWordleGuess)
        #expect(ChatFixtureDriver.state(named: game["CONCLAVE_CHAT_FIXTURE"]) == .empty)
        #expect(TranscriptFixtureDriver.fixtureState(named: game["CONCLAVE_TRANSCRIPT_FIXTURE"]) == .liveController)
    }

    #if os(iOS)
    @Test @MainActor func explicitlyInjectedFixtureReadersUseOnlyTheirDictionary() {
        let resolved = NativeRuntimeConfig.debugLaunchEnvironment(environment: [:], arguments: [
            "Conclave", "--conclave-config=CONCLAVE_STAGE_FIXTURE=grid-3",
            "--conclave-config=CONCLAVE_STAGE_FIXTURE_PATTERN=live",
            "--conclave-config=CONCLAVE_STAGE_FORCE_SCREEN_READER=1",
            "--conclave-config=CONCLAVE_CHAT_FIXTURE=chat-empty",
            "--conclave-config=CONCLAVE_PEOPLE_FIXTURE=people-host-hands-3",
            "--conclave-config=CONCLAVE_SYSTEM_FIXTURE=presence-live-muted",
            "--conclave-config=CONCLAVE_SYSTEM_FIXTURE_PROVIDER=real"
        ])
        #expect(StageFixtureLaunch.state(environment: resolved) == .grid3)
        #expect(StageFixtureLaunch.state(environment: [:]) == nil)
        #expect(StageFixtureLaunch.pattern(environment: resolved) == .livePattern)
        #expect(StageFixtureLaunch.pattern(environment: [:]) == .staticPattern)
        #expect(StageFixtureLaunch.forcesScreenReader(environment: resolved))
        #expect(!StageFixtureLaunch.forcesScreenReader(environment: [:]))
        #expect(ChatFixtureLaunch.state(environment: resolved) == .empty)
        #expect(ChatFixtureLaunch.state(environment: [:]) == nil)
        #expect(PeopleFixtureLaunch.state(environment: resolved) == .hostHands3)
        #expect(PeopleFixtureLaunch.state(environment: [:]) == nil)
        let qa = ["CONCLAVE_PEOPLE_FIXTURE": " qa-attendee-5 "]
        #expect(PeopleFixtureLaunch.state(environment: qa) == .guest4)
        #expect(PeopleFixtureLaunch.qaState(environment: qa) == .qaAttendee5)
        #expect(PeopleFixtureLaunch.qaState(environment: resolved) == nil)
        #expect(PeopleFixtureLaunch.qaState(environment: [:]) == nil)
        #expect(PeopleFixtureLaunch.state(environment: ["CONCLAVE_PEOPLE_FIXTURE": "qa-unknown"]) == nil)
        #expect(ControlsFixtureLaunch.state(environment: ["CONCLAVE_STAGE_FIXTURE": "controls-host"]) == .host)
        #expect(ControlsFixtureLaunch.state(environment: [:]) == nil)
        #expect(SystemFixtureLaunch.state(environment: resolved) == .presenceLiveMuted)
        #expect(SystemFixtureLaunch.state(environment: [:]) == nil)
        #expect(SystemFixtureLaunch.providerMode(environment: resolved) == .real)
        #expect(SystemFixtureLaunch.providerMode(environment: [:]) == .fake)
    }
    #endif
}
#endif
