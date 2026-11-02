#if !SKIP
import Foundation
import Testing
@testable import Conclave

struct VersionVector: Sendable, CustomTestStringConvertible {
    let current: String
    let minimum: String
    let gated: Bool

    var testDescription: String { "\(current) vs \(minimum)" }
}

@MainActor
struct SYS16VersionGateTests {
    private func defaults() -> UserDefaults {
        let suite = "sys16.versiongate." + UUID().uuidString
        let defaults = UserDefaults(suiteName: suite)!
        defaults.removePersistentDomain(forName: suite)
        return defaults
    }

    private func viewModel(defaults: UserDefaults, version: String) -> MeetingViewModel {
        let viewModel = MeetingViewModel()
        viewModel.versionGateDefaults = defaults
        viewModel.currentAppVersion = { version }
        return viewModel
    }

    @Test(arguments: [
        VersionVector(current: "1.2.0", minimum: "1.10.0", gated: true),
        VersionVector(current: "1.0.11", minimum: "2.0.0", gated: true),
        VersionVector(current: "2.0.0", minimum: "2.0.0", gated: false),
        VersionVector(current: "2.0", minimum: "2.0.0", gated: false),
        VersionVector(current: "2.0.1", minimum: "2.0.0", gated: false),
        VersionVector(current: "2.0.0", minimum: "2.0.0.1", gated: true),
    ])
    func dottedVersionsCompareNumerically(_ vector: VersionVector) {
        #expect(VersionGatePolicy.requiresUpdate(currentVersion: vector.current, minimum: vector.minimum) == vector.gated)
    }

    @Test(arguments: ["", "  ", "v2", "2.0.0-beta", "1..2", "1.2.3.4.5", "99999", "2.x", "+2"])
    func malformedVersionsNeverGate(_ value: String) {
        #expect(VersionGatePolicy.components(value) == nil)
        #expect(!VersionGatePolicy.requiresUpdate(currentVersion: "1.0.0", minimum: value))
        #expect(!VersionGatePolicy.requiresUpdate(currentVersion: value, minimum: "9.0.0"))
    }

    @Test func surroundingWhitespaceIsTrimmed() {
        #expect(VersionGatePolicy.components(" 2.10.3 ") == [2, 10, 3])
    }

    @Test func aServerAnswerPicksThePlatformKeyAndIsCached() {
        let payload = MinNativeVersionPayload(ios: "2.1.0", android: "2.0.0")
        let ios = VersionGatePolicy.resolve(fetch: .payload(payload), platform: "ios", currentVersion: "2.0.0", cachedMinimum: nil)
        #expect(ios == VersionGateResolution(state: VersionGateState(minimum: "2.1.0", updateRequired: true),
                                             cache: .store("2.1.0"), invalidField: false))
        let android = VersionGatePolicy.resolve(fetch: .payload(payload), platform: "android", currentVersion: "2.0.0", cachedMinimum: "9.0.0")
        #expect(android == VersionGateResolution(state: VersionGateState(minimum: "2.0.0", updateRequired: false),
                                                 cache: .store("2.0.0"), invalidField: false))
    }

    @Test(arguments: [
        nil,
        MinNativeVersionPayload(ios: nil, android: "2.0.0"),
        MinNativeVersionPayload(ios: "", android: nil),
        MinNativeVersionPayload(ios: "latest", android: nil),
    ] as [MinNativeVersionPayload?])
    func aMissingEmptyOrMalformedFieldOpensTheGateClearsTheCacheAndIsReported(_ payload: MinNativeVersionPayload?) {
        let resolution = VersionGatePolicy.resolve(fetch: .payload(payload), platform: "ios", currentVersion: "1.0.0", cachedMinimum: "9.0.0")
        #expect(resolution == VersionGateResolution(state: .open, cache: .clear, invalidField: true))
    }

    @Test func offlineUsesTheLastGoodValue() {
        let cached = VersionGatePolicy.resolve(fetch: .unavailable, platform: "ios", currentVersion: "1.9.9", cachedMinimum: "2.0.0")
        #expect(cached == VersionGateResolution(state: VersionGateState(minimum: "2.0.0", updateRequired: true), cache: .keep, invalidField: false))
        let none = VersionGatePolicy.resolve(fetch: .unavailable, platform: "ios", currentVersion: "1.9.9", cachedMinimum: nil)
        #expect(none == VersionGateResolution(state: .open, cache: .keep, invalidField: false))
        let corrupt = VersionGatePolicy.resolve(fetch: .unavailable, platform: "ios", currentVersion: "1.9.9", cachedMinimum: "two")
        #expect(corrupt.state == .open)
    }

    @Test func theEndpointDecodesLenientlyAndTreatsNonJsonAsUnavailable() {
        #expect(VersionGateService.decode(statusCode: 200, json: #"{"serviceVersion":{"id":"x"},"minNativeVersion":{"ios":"2.0.0","android":"2.0.1"}}"#)
            == .payload(MinNativeVersionPayload(ios: "2.0.0", android: "2.0.1")))
        #expect(VersionGateService.decode(statusCode: 200, json: #"{"minNativeVersion":{"ios":2,"android":"2.0.1"}}"#)
            == .payload(MinNativeVersionPayload(ios: nil, android: "2.0.1")))
        #expect(VersionGateService.decode(statusCode: 200, json: #"{"minNativeVersion":"2.0.0"}"#) == .payload(nil))
        #expect(VersionGateService.decode(statusCode: 200, json: #"{"serviceVersion":{"id":"x"}}"#) == .payload(nil))
        #expect(VersionGateService.decode(statusCode: 200, json: "<html>captive portal</html>") == .unavailable)
        #expect(VersionGateService.decode(statusCode: 503, json: #"{"minNativeVersion":{"ios":"9.0.0"}}"#) == .unavailable)
    }

    @Test(arguments: ["true", #"{"major":9}"#, "[9]", "9"])
    func aNonStringVersionFieldNeverGates(_ field: String) {
        let fetch = VersionGateService.decode(statusCode: 200, json: #"{"minNativeVersion":{"ios":"# + field + "}}")
        let resolution = VersionGatePolicy.resolve(fetch: fetch, platform: "ios", currentVersion: "1.0.0", cachedMinimum: nil)
        #expect(!resolution.state.updateRequired)
        #expect(resolution.invalidField)
    }

    @Test(arguments: ["[1]", #""2.0.0""#, #"{"ios":["9"],"android":9}"#])
    func aMalformedJoinFieldNeverBreaksTheJoinResponse(_ field: String) throws {
        let malformed = try SfuJoinInfo.decode(Data((#"{"token":"t","sfuUrl":"wss://s","minNativeVersion":"# + field + "}").utf8))
        #expect(malformed.token == "t")
        #expect(malformed.minNativeVersion?.ios == nil)
        #expect(malformed.minNativeVersion?.android == nil)
    }

    @Test func aWellFormedOrAbsentJoinFieldDecodes() throws {
        let good = try SfuJoinInfo.decode(Data(#"{"token":"t","sfuUrl":"wss://s","minNativeVersion":{"ios":"2.0.0","android":"2.0.0"}}"#.utf8))
        #expect(good.minNativeVersion == MinNativeVersionPayload(ios: "2.0.0", android: "2.0.0"))
        #expect(good.token == "t")
        let legacy = try SfuJoinInfo.decode(Data(#"{"token":"t","sfuUrl":"wss://s"}"#.utf8))
        #expect(legacy.minNativeVersion == nil)
    }

    @Test func theVersionEndpointSharesTheJoinHost() throws {
        let production = try #require(URL(string: "https://conclave.acmvit.in/api/sfu/join"))
        #expect(VersionGateService.versionURL(joinURL: production)?.absoluteString == "https://conclave.acmvit.in/api/version")
        let local = try #require(URL(string: "http://127.0.0.1:3000/api/sfu/join"))
        #expect(VersionGateService.versionURL(joinURL: local)?.absoluteString == "http://127.0.0.1:3000/api/version")
    }

    @Test func aGatedViewModelSendsNoJoinRequestAndFeedsTheHomeBanner() async {
        let viewModel = viewModel(defaults: defaults(), version: "1.0.11")
        var fetches = 0
        viewModel.testJoinFetch = { fetches += 1 }
        #expect(viewModel.applyVersionGate(.payload(MinNativeVersionPayload(ios: "2.0.0", android: "2.0.0")), source: "test"))
        #expect(viewModel.premeeting.home.updateRequired)
        #expect(viewModel.premeeting.home.storeURL == StoreListing.appStoreURL)

        viewModel.joinRoom(roomId: "rose-sora-luffy", displayName: "Guest")
        for _ in 0..<20 { await Task.yield() }
        #expect(fetches == 0)
        #expect(viewModel.state.roomId != "rose-sora-luffy")
    }

    @Test func anUngatedViewModelStillReachesTheJoinRequest() async {
        let viewModel = viewModel(defaults: defaults(), version: "2.0.0")
        var fetches = 0
        viewModel.testJoinFetch = { fetches += 1 }
        #expect(!viewModel.applyVersionGate(.payload(MinNativeVersionPayload(ios: "2.0.0", android: "2.0.0")), source: "test"))
        viewModel.joinRoom(roomId: "rose-sora-luffy", displayName: "Guest")
        for _ in 0..<200 where fetches == 0 { await Task.yield() }
        #expect(fetches == 1)
    }

    @Test func aJoinResponseGateAbortsFreshJoinsButNotRecoveries() {
        let gatedInfo = SfuJoinInfo(token: "t", sfuUrl: "wss://s", iceServers: nil,
                                    minNativeVersion: MinNativeVersionPayload(ios: "3.0.0", android: "3.0.0"))
        let fresh = viewModel(defaults: defaults(), version: "2.0.0")
        #expect(fresh.joinResponseBlocksForUpdate(gatedInfo, isRecoveryJoin: false))
        #expect(fresh.versionGate == VersionGateState(minimum: "3.0.0", updateRequired: true))

        let recovering = viewModel(defaults: defaults(), version: "2.0.0")
        #expect(!recovering.joinResponseBlocksForUpdate(gatedInfo, isRecoveryJoin: true))
        #expect(recovering.versionGate.updateRequired, "the gate still applies to the next fresh join")

        let open = viewModel(defaults: defaults(), version: "2.0.0")
        #expect(!open.joinResponseBlocksForUpdate(SfuJoinInfo(token: "t", sfuUrl: "wss://s", iceServers: nil), isRecoveryJoin: false))
        #expect(open.versionGate == .open)
    }

    @Test func launchAppliesTheCachedFloorOfflineAndTheServerAnswerReplacesIt() async {
        let store = defaults()
        store.set("2.5.0", forKey: VersionGatePolicy.cacheKey(platform: "ios"))
        let offline = viewModel(defaults: store, version: "2.0.0")
        offline.versionGateFetch = { .unavailable }
        offline.refreshVersionGate()
        #expect(offline.versionGate == VersionGateState(minimum: "2.5.0", updateRequired: true))

        let online = viewModel(defaults: store, version: "2.0.0")
        online.versionGateFetch = { .payload(MinNativeVersionPayload(ios: "2.0.0", android: "2.0.0")) }
        online.refreshVersionGate()
        for _ in 0..<200 where online.versionGate.updateRequired { await Task.yield() }
        #expect(online.versionGate == VersionGateState(minimum: "2.0.0", updateRequired: false))
        #expect(store.string(forKey: VersionGatePolicy.cacheKey(platform: "ios")) == "2.0.0")
        #expect(!online.premeeting.home.updateRequired)
    }
}
#endif
