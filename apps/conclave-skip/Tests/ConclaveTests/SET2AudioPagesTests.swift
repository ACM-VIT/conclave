#if !SKIP
import Foundation
import Testing
@testable import Conclave

/// SET-2 (OUT/PLAN-screens.md section 5; S60 2 audio rows, 0.6 L6-1, L6-2, 0.8 C6-1, C6-6, C6-7; S60 Q8): the audio
/// rows and pages on the fake WP3 owner (`SettingsRecordingCore`): one test tone per tap (`speakerTest.count`), noise
/// suppression by one track replacement in a call and none in the app scope, the 10 Hz mic meter subscribed once per
/// page lifetime and stopped on leave, the muted state, Record and Replay hidden without `canRecordMicTest`, the shared
/// level and tone policies, and source pins on both WebRTC clients (replaceTrack on the send queue, the newest mute
/// intent wins, one synthesized tone through the voice route). No test plays a sound.
@MainActor
struct SET2AudioPagesTests {
    // MARK: Test tone (C6-7, 2 l4)

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

    // MARK: Noise suppression (C6-1, 1 l5)

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

    // MARK: Mic test (C6-6, 2 l1, 2 l9, 2 l10)

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
        // The level moves only the leaf; the snapshots stay put (settings.mic.body unchanged).
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

    // MARK: Routes (L6-1, S30 CC4)

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

    // MARK: Sources (C6-1, C6-6, C6-7)

    @Test func iosClientReplacesTheMicTrackOnTheSendQueueAndPlaysOneTone() throws {
        let client = try Self.source("Sources/Conclave/Core/WebRTC/WebRTCClient.swift")
        #expect(client.contains("func applyNoiseSuppression(_ enabled: Bool) async -> Bool"))
        #expect(client.contains("try handle.producer.replaceTrack(handle.track)"))
        #expect(client.contains("let queue = sendProducerOperationQueues[ObjectIdentifier(producer)]"))
        #expect(client.contains("microphone.track.isEnabled = localAudioIntentEnabled && localAudioEnabled"))
        #expect(client.contains("\"googNoiseSuppression\": noiseSuppression ? \"true\" : \"false\""))
        #expect(client.contains("createMicrophoneAudioTrack(noiseSuppression: SettingsPreferences.noiseSuppression())"))
        #expect(client.contains("private func createMicrophoneAudioTrack() -> (source: RTCAudioSource, track: RTCAudioTrack)"))
        #expect(client.contains("func sampleLocalMicrophoneLevel() -> Double"))
        #expect(client.contains("AVAudioPlayer(data: Self.testToneWAVData())"))
        #expect(!client.contains("AudioServicesPlaySystemSound(SystemSoundID(1057))"))
        // The microphone track is still created disabled (AGENTS.md media invariants).
        #expect(client.contains("track.isEnabled = false\n        return (source, track)"))
    }

    @Test func androidClientReplacesTheMicTrackAndPlaysOneVoiceRouteTone() throws {
        let client = try Self.source("Sources/Conclave/Skip/WebRTCClient+Android.kt")
        #expect(client.contains("internal suspend fun applyNoiseSuppression(enabled: Boolean): Boolean"))
        #expect(client.contains("producer.replaceTrack(track)"))
        #expect(client.contains("track.setEnabled(localAudioTargetEnabled && localAudioEnabled)"))
        #expect(client.contains("noiseSuppression: Boolean = SettingsPreferences.noiseSuppression()"))
        #expect(client.contains(".setUsage(AudioAttributes.USAGE_VOICE_COMMUNICATION)"))
        #expect(client.contains("internal fun playTestTone()"))
        #expect(client.contains("internal fun sampleLocalMicrophoneLevel(): Double"))
        #expect(!client.contains("ToneGenerator(AudioManager.STREAM_VOICE_CALL"))
        let symbols = try Self.source("Sources/Conclave/Core/WebRTC/WebRTCClient+Android.swift")
        let host = try Self.source("Sources/Conclave/Core/WebRTC/WebRTCClient+macOS.swift")
        for text in [symbols, host] {
            #expect(text.contains("func applyNoiseSuppression(_ enabled: Bool) async -> Bool"))
            #expect(text.contains("func sampleLocalMicrophoneLevel() -> Double"))
            #expect(text.contains("func playTestTone()"))
            #expect(text.contains("var supportsLiveNoiseSuppressionChange: Bool"))
        }
    }

    @Test func audioPagesRunTheTestForThePageLifetimeOnly() throws {
        let ios = try Self.source("Sources/Conclave/Features/Meeting/Settings/AudioPages+iOS.swift")
        #expect(ios.contains("await settings.runMicTest()"))
        #expect(ios.contains("SettingsMicLevelRow(meter: settings.micLevel)"))
        #expect(ios.contains("if audio.canRecordMicTest"))
        let android = try Self.source("Sources/Conclave/Skip/ui/settings/AudioPages.kt")
        #expect(android.contains("settings.startMicTest()") && android.contains("onDispose { settings.stopMicTest() }"))
        #expect(android.contains("if (audio.canRecordMicTest)"))
        #expect(android.contains("AudioRouteList(rows = rows"))
        #expect(android.contains("haptics.gesture(FeedbackKind.selectionChanged)"))
        // Only the leaf reads the 10 Hz value.
        #expect(android.components(separatedBy: "meter.segments").count - 1 == 1)
        let rows = try Self.source("Sources/Conclave/Features/Meeting/Settings/SettingsRows+iOS.swift")
        #expect(rows.components(separatedBy: "meter.segments").count - 1 == 1)
    }

    // MARK: Helpers

    static func make(_ state: SettingsFixtureState, defaults: UserDefaults = SET2AudioPagesTests.freshDefaults())
        -> (SettingsPresenter, SettingsRecordingCore) {
        let presenter = SettingsPresenter(scope: .call, platform: .ios, defaults: defaults)
        presenter.sleep = { _ in }
        let core = SettingsRecordingCore()
        core.install(on: presenter)
        presenter.apply(state.inputs())
        return (presenter, core)
    }

    static func freshDefaults() -> UserDefaults {
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
