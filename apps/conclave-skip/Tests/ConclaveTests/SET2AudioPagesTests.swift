#if !SKIP
import Foundation
import Testing
@testable import Conclave

@MainActor
struct SET2AudioPagesTests {

    @Test func playTestSoundCountsOncePerTapAndReturnsToIdle() async {
        let (presenter, core) = Self.make(.guest)
        #expect(presenter.speakerTestCount == 0)
        #expect(presenter.playTestSound() == .dispatched)
        #expect(presenter.audio.speakerTest == .playing)
        #expect(presenter.playTestSound() == .ignored)
        #expect(presenter.speakerTestCount == 1 && core.count("testTone") == 1)
        for _ in 0..<20 { await Task.yield() }
        #expect(presenter.audio.speakerTest == .idle)
        #expect(presenter.playTestSound() == .dispatched)
        #expect(presenter.speakerTestCount == 2 && core.count("testTone") == 2)
    }

    @Test func nothingPlaysOnOpenAndTheAppScopeHasNoTone() {
        let (presenter, core) = Self.make(.guest)
        presenter.panelDidOpen()
        #expect(core.count("testTone") == 0 && presenter.speakerTestCount == 0)
        let app = SettingsPresenter(scope: .app, platform: .ios, defaults: Self.freshDefaults())
        #expect(app.playTestSound() == .ignored)
        #expect(app.audio.micTest == .hidden)
    }

    @Test func toneSamplesStayInRangeAndFadeAtBothEnds() {
        #expect(TestTonePolicy.sampleCount == 8000)
        #expect(TestTonePolicy.sample(0) == 0)
        #expect(abs(TestTonePolicy.sample(TestTonePolicy.sampleCount - 1)) < 0.0001)
        #expect(TestTonePolicy.sample(-1) == 0 && TestTonePolicy.sample(TestTonePolicy.sampleCount) == 0)
        var peak = 0.0
        for index in 0..<TestTonePolicy.sampleCount { peak = max(peak, abs(TestTonePolicy.sample(index))) }
        #expect(peak <= TestTonePolicy.amplitude + 0.0001 && peak > TestTonePolicy.amplitude * 0.9)
        #expect(TestTonePolicy.playingMillis > TestTonePolicy.durationMillis)
    }

    @Test func noiseSuppressionReplacesOnceInACallAndNeverInTheAppScope() {
        let defaults = Self.freshDefaults()
        let (presenter, core) = Self.make(.mic, defaults: defaults)
        presenter.setNoiseSuppression(false)
        presenter.setNoiseSuppression(false)
        #expect(core.count("noiseSuppressionReplace") == 1)
        #expect(!SettingsPreferences.noiseSuppression(defaults: defaults))
        #expect(!presenter.audio.noiseSuppressionOn)
        #expect(core.count("producerClose") == 0)
        let app = SettingsPresenter(scope: .app, platform: .ios, defaults: defaults)
        let appCore = SettingsRecordingCore()
        appCore.install(on: app)
        app.setNoiseSuppression(true)
        #expect(appCore.count("noiseSuppressionReplace") == 0)
        #expect(SettingsPreferences.noiseSuppression(defaults: defaults))
    }

    @Test func noiseSuppressionExplainsWhenTheLiveChangeIsNotSupported() {
        #expect(SettingsAudioPolicy.noiseSuppressionReason(scope: .call, liveChangeSupported: false) == .appliesNextJoin)
        #expect(SettingsAudioPolicy.noiseSuppressionReason(scope: .call, liveChangeSupported: true) == .none)
        #expect(SettingsAudioPolicy.noiseSuppressionReason(scope: .app, liveChangeSupported: false) == .none)
        let presenter = SettingsPresenter(scope: .call, platform: .ios, defaults: Self.freshDefaults())
        presenter.apply(SettingsInputs.make(callSession: 1, isJoined: true, noiseSuppressionLive: false, hasCore: true))
        #expect(presenter.audio.noiseSuppressionReason == .appliesNextJoin)
    }

    @Test func micTestSubscribesOncePerPageAndStopsOnLeave() async {
        let (presenter, core) = Self.make(.mic)
        presenter.sleep = { _ in await Task.yield() }
        core.scriptedLevel = 0.25
        let rootRevision = presenter.chat.revision
        for _ in 0..<10 { presenter.startMicTest() }
        #expect(core.count("micTestSubscribe") == 1 && presenter.micTestSubscribeCount == 1)
        for _ in 0..<10 { await Task.yield() }
        #expect(presenter.audio.micPhase == .metering)
        #expect(presenter.micLevel.segments == MicLevelPolicy.filledSegments(level: 0.25))
        let audioRevision = presenter.audio.revision
        core.scriptedLevel = 0.81
        for _ in 0..<10 { await Task.yield() }

        #expect(presenter.micLevel.segments == MicLevelPolicy.filledSegments(level: 0.81))
        #expect(presenter.audio.revision == audioRevision && presenter.chat.revision == rootRevision)
        presenter.stopMicTest()
        presenter.stopMicTest()
        #expect(core.count("micTestStop") == 1 && presenter.micTestStopCount == 1)
        #expect(presenter.audio.micPhase == .idle && presenter.micLevel.segments == 0)
    }

    @Test func mutedCallsShowTheUnmuteReasonInsteadOfAMeter() async {
        let (presenter, core) = Self.make(.muted)
        presenter.sleep = { _ in await Task.yield() }
        core.scriptedLevel = 0.5
        presenter.startMicTest()
        for _ in 0..<10 { await Task.yield() }
        #expect(presenter.audio.isMuted && presenter.audio.micTestReason == .unmuteToTest)
        #expect(presenter.micLevel.segments == 0 && presenter.audio.micPhase == .idle)
        presenter.stopMicTest()
    }

    @Test func recordAndReplayStayHiddenWithoutTheCapability() {
        let (presenter, core) = Self.make(.mic)
        #expect(!presenter.audio.canRecordMicTest)
        presenter.recordMicSample()
        presenter.setTestGain(1.5)
        #expect(core.calls.isEmpty)
        let capable = SettingsPresenter(scope: .call, platform: .android, defaults: Self.freshDefaults())
        let capableCore = SettingsRecordingCore()
        capableCore.install(on: capable)
        capable.apply(SettingsInputs.make(callSession: 1, isJoined: true, isMuted: false, canRecordMicTest: true, hasCore: true))
        capable.recordMicSample()
        #expect(capable.audio.micPhase == .recording)
        capable.micSampleFinished()
        capable.setTestGain(3.0)
        #expect(capable.audio.testGain == 2.0)
        #expect(capableCore.calls == ["recordMicSample", "setTestGain"])
    }

    @Test func levelSegmentsFollowTheSquareRootCurve() {
        #expect(MicLevelPolicy.segmentCount == 12 && MicLevelPolicy.intervalMillis == 100)
        #expect(MicLevelPolicy.filledSegments(level: 0) == 0)
        #expect(MicLevelPolicy.filledSegments(level: -1) == 0)
        #expect(MicLevelPolicy.filledSegments(level: 1) == 12)
        #expect(MicLevelPolicy.filledSegments(level: 4) == 12)
        #expect(MicLevelPolicy.filledSegments(level: 0.25) == 6)
        #expect(MicLevelPolicy.filledSegments(level: 0.01) == 1)
    }

    @Test func routeRequestsGoToTheOwnerOnlyForAChange() {
        let owner = AudioRouteOwner()
        let presenter = SettingsPresenter(scope: .call, platform: .android, defaults: Self.freshDefaults())
        presenter.routeOwner = owner
        presenter.apply(SettingsFixtureState.guest.inputs())
        #expect(presenter.requestRoute(id: owner.route.currentId) == .ignored)
        #expect(presenter.requestRoute(id: "speaker") == .dispatched)
        #expect(owner.routeEventLog.contains("request:speaker"))
        let app = SettingsPresenter(scope: .app, platform: .android, defaults: Self.freshDefaults())
        app.routeOwner = owner
        #expect(app.requestRoute(id: "receiver") == .ignored)
    }

    static func make(_ state: SettingsFixtureState, defaults: UserDefaults = SET2AudioPagesTests.freshDefaults())
        -> (SettingsPresenter, SettingsRecordingCore) {
        let presenter = SettingsPresenter(scope: .call, platform: .ios, defaults: defaults)
        presenter.sleep = { _ in }
        let core = SettingsRecordingCore()
        core.install(on: presenter)
        presenter.apply(state.inputs())
        return (presenter, core)
    }

    nonisolated static func freshDefaults() -> UserDefaults {
        let suite = "set2-audio-" + UUID().uuidString
        let defaults = UserDefaults(suiteName: suite) ?? UserDefaults.standard
        defaults.removePersistentDomain(forName: suite)
        return defaults
    }

    static func source(_ path: String) throws -> String {
        let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        return try String(contentsOf: root.appendingPathComponent(path), encoding: .utf8)
    }
}
#endif
