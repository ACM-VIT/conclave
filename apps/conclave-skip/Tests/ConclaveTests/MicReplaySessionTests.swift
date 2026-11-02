#if !SKIP
import Foundation
import Testing
@testable import Conclave

struct MicReplaySessionTests {
    @Test func recordsCountsDownPlaysAndRestoresTheOriginalLiveMic() {
        var session = MicReplaySession()
        let generation = session.begin(isMuted: false, muteRevision: 4, callSession: 8)
        #expect(session.phase == .recording && session.isActive)
        session.progress(generation: generation, elapsed: 2.4)
        #expect(session.secondsLeft == 3)
        let played = session.play(generation: generation)
        #expect(played)
        #expect(session.phase == .playing && session.secondsLeft == 0)
        let playedTwice = session.play(generation: generation)
        #expect(!playedTwice)
        let restore = session.finish(generation: generation, failed: false, muteRevision: 4, callSession: 8, isMuted: false, canRestore: true)
        #expect(restore)
        #expect(session.phase == .idle && !session.isActive)
        let restoreTwice = session.finish(generation: generation, failed: false, muteRevision: 4, callSession: 8, isMuted: false, canRestore: true)
        #expect(!restoreTwice)
    }

    @Test func priorMuteNewMuteAndReplacedCallsNeverRestore() {
        for scenario in 0..<5 {
            var session = MicReplaySession()
            let generation = session.begin(isMuted: scenario == 0, muteRevision: 1, callSession: 2)
            let restore = session.finish(generation: generation, failed: false,
                                         muteRevision: scenario == 1 ? 2 : 1,
                                         callSession: scenario == 2 ? 3 : 2,
                                         isMuted: scenario == 3, canRestore: scenario != 4)
            #expect(!restore)
            #expect(session.phase == .idle)
        }
    }

    @Test func cancelAndRetryFenceLateProgressAndCompletions() {
        var session = MicReplaySession()
        let old = session.begin(isMuted: false, muteRevision: 1, callSession: 2)
        let restoredAfterFailure = session.finish(generation: old, failed: true, muteRevision: 1, callSession: 2, isMuted: false, canRestore: true)
        #expect(restoredAfterFailure)
        #expect(session.phase == .failed)
        let retry = session.begin(isMuted: true, muteRevision: 2, callSession: 2)
        session.progress(generation: old, elapsed: 5)
        #expect(session.secondsLeft == 5)
        let latePlay = session.play(generation: old)
        #expect(!latePlay)
        let lateFinish = session.finish(generation: old, failed: true, muteRevision: 2, callSession: 2, isMuted: false, canRestore: true)
        #expect(!lateFinish)
        #expect(session.generation == retry && session.phase == .recording)
    }
}

#if os(macOS)
@MainActor
@Suite(.serialized)
struct MicReplayIntegrationTests {
    @Test func pausePrecedesCaptureAndLeavingThePageRestoresOnlyALiveMic() async {
        for muted in [false, true] {
            let call = RejoinHarness()
            #expect(await call.join(muted: muted))
            call.media.testModelsLocalAudioState = true
            let audio = FakeMicTestAudio()
            call.viewModel.micTestAudio = audio
            let settings = call.viewModel.shell.settings
            settings.apply(call.viewModel.makeSettingsInputs())
            settings.startMicTest()
            settings.recordMicSample()
            #expect(!call.media.localAudioEnabled)
            #expect(await settle { audio.records == 1 })
            #expect(call.calls.count("suspendLocalAudioForRecovery") >= 1)
            #expect(call.viewModel.state.isMuted == muted)
            let enables = call.calls.count("setAudioEnabled(true)")
            settings.stopMicTest()
            #expect(audio.stops == 1)
            if !muted {
                #expect(await settle(timeout: .seconds(20)) { call.calls.count("setAudioEnabled(true)") == enables + 1 })
            } else {
                for _ in 0..<30 { await Task.yield() }
                #expect(call.calls.count("setAudioEnabled(true)") == enables)
            }
            #expect(call.viewModel.state.isMuted == muted)
            await call.finish()
        }
    }

    @Test func aMuteDuringRecordingWinsOverAutomaticPlaybackAndRestore() async {
        let call = RejoinHarness()
        #expect(await call.join(muted: false))
        call.media.testModelsLocalAudioState = true
        let audio = FakeMicTestAudio()
        call.viewModel.micTestAudio = audio
        let settings = call.viewModel.shell.settings
        settings.apply(call.viewModel.makeSettingsInputs())
        settings.startMicTest()
        settings.recordMicSample()
        #expect(await settle { audio.records == 1 })
        call.viewModel.toggleMute()
        #expect(call.viewModel.state.isMuted)
        audio.status = MicTestAudioStatus.recorded
        #expect(await settle { audio.plays == 1 && settings.audio.micPhase == .replaying })
        settings.setTestGain(1.7)
        #expect(audio.gain == 1.7)
        let enables = call.calls.count("setAudioEnabled(true)")
        audio.status = MicTestAudioStatus.idle
        #expect(await settle { audio.stops == 1 })
        #expect(call.viewModel.state.isMuted && !call.media.localAudioEnabled)
        #expect(call.calls.count("setAudioEnabled(true)") == enables)
        settings.stopMicTest()
        await call.finish()
    }

    @Test func backgroundingStopsCaptureAndADeniedPermissionNeverStartsIt() async {
        let call = RejoinHarness()
        #expect(await call.join())
        let audio = FakeMicTestAudio()
        audio.hasPermission = false
        call.viewModel.micTestAudio = audio
        let settings = call.viewModel.shell.settings
        settings.apply(call.viewModel.makeSettingsInputs())
        settings.startMicTest()
        settings.recordMicSample()
        #expect(settings.audio.micTestReason == .permissionDenied)
        #expect(settings.audio.micPhase == .unavailable && audio.records == 0)
        audio.hasPermission = true
        settings.recordMicSample()
        #expect(await settle { audio.records == 1 })
        call.viewModel.handleAppEnteredBackground()
        #expect(audio.stops == 1 && settings.audio.micPhase == .idle)
        settings.stopMicTest()
        await call.finish()
    }

    @Test func cancellingDuringThePauseAcknowledgementWaitsBeforeRestoring() async {
        let call = RejoinHarness()
        #expect(await call.join(muted: false))
        call.media.testModelsLocalAudioState = true
        let audio = FakeMicTestAudio()
        call.viewModel.micTestAudio = audio
        let settings = call.viewModel.shell.settings
        settings.apply(call.viewModel.makeSettingsInputs())
        settings.startMicTest()
        call.calls.hold("setAudioEnabled(false)")
        settings.recordMicSample()
        #expect(await settle { call.calls.isHolding("setAudioEnabled(false)") })
        #expect(audio.records == 0)
        let enables = call.calls.count("setAudioEnabled(true)")
        settings.stopMicTest()
        for _ in 0..<30 { await Task.yield() }
        #expect(call.calls.count("setAudioEnabled(true)") == enables)
        call.calls.release("setAudioEnabled(false)")
        #expect(await settle { call.calls.count("setAudioEnabled(true)") == enables + 1 })
        #expect(audio.records == 0 && audio.stops == 1)
        await call.finish()
    }

    @Test func backendFailureIsRetryableAndAnAdminMuteDuringRestoreWins() async {
        let call = RejoinHarness()
        #expect(await call.join(muted: false))
        call.media.testModelsLocalAudioState = true
        let audio = FakeMicTestAudio()
        call.viewModel.micTestAudio = audio
        let settings = call.viewModel.shell.settings
        settings.apply(call.viewModel.makeSettingsInputs())
        settings.startMicTest()
        settings.recordMicSample()
        #expect(await settle { audio.records == 1 })
        call.calls.hold("setAudioEnabled(true)")
        audio.status = MicTestAudioStatus.failed
        #expect(await settle { call.calls.isHolding("setAudioEnabled(true)") })
        #expect(settings.audio.micPhase == .unavailable && audio.stops == 1)
        call.deliverAdminMute()
        #expect(await settle { call.viewModel.state.isMuted })
        call.calls.release("setAudioEnabled(true)")
        #expect(await call.releasedCallsReturned())
        #expect(await call.reportsHandled())
        #expect(call.viewModel.state.isMuted && !call.media.localAudioEnabled)
        settings.apply(call.viewModel.makeSettingsInputs())
        settings.recordMicSample()
        #expect(await settle { audio.records == 2 })
        settings.stopMicTest()
        await call.finish()
    }

    @Test func permissionLostDuringCaptureFailsClosedWithoutAnEnable() async {
        let call = RejoinHarness()
        #expect(await call.join(muted: false))
        let audio = FakeMicTestAudio()
        call.viewModel.micTestAudio = audio
        let settings = call.viewModel.shell.settings
        settings.apply(call.viewModel.makeSettingsInputs())
        settings.startMicTest()
        settings.recordMicSample()
        #expect(await settle { audio.records == 1 })
        audio.hasPermission = false
        let enables = call.calls.count("setAudioEnabled(true)")
        settings.micSampleFinished()
        #expect(await settle { call.viewModel.state.isMuted && settings.audio.micTestReason == .permissionDenied })
        #expect(call.calls.count("setAudioEnabled(true)") == enables)
        settings.stopMicTest()
        await call.finish()
    }

    @Test func leavingDuringRestoreFencesItsLateAcknowledgement() async {
        let call = RejoinHarness()
        #expect(await call.join(muted: false))
        call.media.testModelsLocalAudioState = true
        let audio = FakeMicTestAudio()
        call.viewModel.micTestAudio = audio
        let settings = call.viewModel.shell.settings
        settings.apply(call.viewModel.makeSettingsInputs())
        settings.startMicTest()
        settings.recordMicSample()
        #expect(await settle { audio.records == 1 })
        call.calls.hold("setAudioEnabled(true)")
        settings.stopMicTest()
        #expect(await settle { call.calls.isHolding("setAudioEnabled(true)") })
        let live = call.calls.count("microphoneLive")
        call.viewModel.leaveRoom()
        call.calls.release("setAudioEnabled(true)")
        #expect(await call.releasedCallsReturned())
        #expect(!call.media.localAudioEnabled)
        #expect(call.calls.count("microphoneLive") == live)
        await call.finish()
    }

    @Test func leavingTheCallStopsPlaybackWithoutRestoring() async {
        let call = RejoinHarness()
        #expect(await call.join(muted: false))
        let audio = FakeMicTestAudio()
        call.viewModel.micTestAudio = audio
        let settings = call.viewModel.shell.settings
        settings.apply(call.viewModel.makeSettingsInputs())
        settings.startMicTest()
        settings.recordMicSample()
        #expect(await settle { audio.records == 1 })
        audio.status = MicTestAudioStatus.recorded
        #expect(await settle { audio.plays == 1 })
        let enables = call.calls.count("setAudioEnabled(true)")
        call.viewModel.leaveRoom()
        #expect(audio.stops == 1)
        for _ in 0..<30 { await Task.yield() }
        #expect(call.calls.count("setAudioEnabled(true)") == enables)
        settings.stopMicTest()
        await call.finish()
    }
}

@MainActor
private final class FakeMicTestAudio: MicTestAudioDriver {
    var hasPermission = true
    var status = MicTestAudioStatus.idle
    var level = 0.5
    var records = 0
    var plays = 0
    var stops = 0
    var gain = 1.0

    func record(noiseSuppression: Bool) { records += 1; status = MicTestAudioStatus.recording }
    func play() { plays += 1; status = MicTestAudioStatus.playing }
    func setGain(_ gain: Double) { self.gain = gain }
    func stop() { stops += 1; status = MicTestAudioStatus.idle }
}
#endif
#endif
