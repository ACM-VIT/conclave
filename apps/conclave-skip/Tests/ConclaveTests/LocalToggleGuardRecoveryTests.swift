#if os(macOS) && !SKIP
import Foundation
import Testing
@testable import Conclave

/// F7: a recovery rejoin that lands while a microphone, camera or hand toggle
/// is suspended in its await (an SFU acknowledgement can take up to 30 s) must
/// not strand the toggle's in-flight guard, and the orphaned toggle must make
/// no media call into the call that replaced it.
///
/// What these host tests drive and observe:
/// - The rejoin is the real `rejoinIfPossible()` -> `joinRoom` path (attempt
///   id, guard release). Its join task makes the real teardown call into the
///   macOS media stub, which bumps the stub's configuration generation (one
///   per media session) and drops its producers, and is then held there until
///   `finish()` has retired the attempt, so it never reaches the network join
///   fetch.
/// - `land()` stands in for the join response: it publishes media from the
///   current intent through the real `startProducing()`, then marks the call
///   joined itself.
/// - Every stub call is logged with the media session it landed in, so a test
///   can tell the recovered call's media calls from the orphan's.
/// - Each toggle that took its guard reports when its task has finished
///   (`MeetingViewModel.testLocalToggleEnded`, macOS only). A test waits for
///   that before it asserts what an orphaned toggle did not do.
/// The real iOS and Android clients do not run here. Their own fences against
/// late acknowledgements are pinned by
/// `ConclaveTests.testLateMediaAcknowledgementsAreFencedInBothClients`.
///
/// Every wait is bounded by wall-clock time and names the state it waits for;
/// no fixed number of yields is trusted.
@MainActor
@Suite(.serialized)
struct LocalToggleGuardRecoveryTests {
    @Test
    func rejoinFreesTheMicrophoneGuardWhileTheOrphanedUnmuteIsSuspended() async {
        let call = RejoinHarness()
        #expect(await call.join())
        call.calls.hold("startProducingAudio")
        call.viewModel.toggleMute()
        #expect(await settle { call.calls.isHolding("startProducingAudio") })
        #expect(!call.viewModel.state.isMuted)

        #expect(await call.rejoin())
        let recovered = call.generation
        await call.land()
        // The recovered call published the microphone from the unmuted intent.
        #expect(call.calls.count("startProducingAudio", inGeneration: recovered) == 1)
        #expect(call.media.hasLocalAudioProducer)

        // The orphaned start is still suspended, yet a mute and an unmute
        // reach the recovered call's media: the rejoin freed the guard.
        call.viewModel.toggleMute()
        #expect(call.viewModel.state.isMuted)
        #expect(await settle { call.calls.count("setAudioEnabled(false)", inGeneration: recovered) == 1 })
        #expect(await settle { call.endedToggleCount("toggleMute") == 1 })
        call.viewModel.toggleMute()
        #expect(!call.viewModel.state.isMuted)
        #expect(await settle {
            call.calls.count("reassertLocalAudioProducerUnmuted", inGeneration: recovered) == 1
        })
        #expect(await settle { call.endedToggleCount("toggleMute") == 2 })

        // The orphaned start returns late while the recovered call is
        // unmuted. Its toggle finishes without any media call, in particular
        // no second unmute confirmation (which would bypass the guard).
        let callsBefore = call.calls.totalCount
        call.calls.release("startProducingAudio")
        #expect(await settle { call.endedToggleCount("toggleMute") == 3 })
        #expect(call.calls.totalCount == callsBefore)
        #expect(!call.viewModel.state.isMuted)

        // The guard stays usable after the orphan finished.
        call.viewModel.toggleMute()
        #expect(call.viewModel.state.isMuted)
        #expect(await settle { call.calls.count("setAudioEnabled(false)", inGeneration: recovered) == 2 })
        #expect(await settle { call.endedToggleCount("toggleMute") == 4 })
        await call.finish()
    }

    @Test
    func rejoinFreesTheCameraGuardWhileTheOrphanedCameraStartIsSuspended() async {
        let call = RejoinHarness()
        #expect(await call.join())
        call.calls.hold("startProducingVideo")
        call.viewModel.toggleCamera()
        #expect(await settle { call.calls.isHolding("startProducingVideo") })
        #expect(!call.viewModel.state.isCameraOff)

        #expect(await call.rejoin())
        let recovered = call.generation
        await call.land()
        #expect(call.calls.count("startProducingVideo", inGeneration: recovered) == 1)

        // The orphaned start is still suspended, yet turning the camera off
        // and on reaches the recovered call's media: the rejoin freed the
        // guard.
        call.viewModel.toggleCamera()
        #expect(call.viewModel.state.isCameraOff)
        #expect(await settle { call.calls.count("closeLocalVideoProducer", inGeneration: recovered) == 1 })
        #expect(await settle { call.endedToggleCount("toggleCamera") == 1 })
        call.viewModel.toggleCamera()
        #expect(!call.viewModel.state.isCameraOff)
        #expect(await settle { call.calls.count("startProducingVideo", inGeneration: recovered) == 2 })
        #expect(await settle { call.endedToggleCount("toggleCamera") == 2 })

        // The orphaned start returns late; its toggle finishes without any
        // media call.
        let callsBefore = call.calls.totalCount
        call.calls.release("startProducingVideo")
        #expect(await settle { call.endedToggleCount("toggleCamera") == 3 })
        #expect(call.calls.totalCount == callsBefore)
        #expect(!call.viewModel.state.isCameraOff)
        #expect(call.media.hasLocalVideoProducer)

        // The guard stays usable after the orphan finished.
        call.viewModel.toggleCamera()
        #expect(call.viewModel.state.isCameraOff)
        #expect(await settle { call.calls.count("closeLocalVideoProducer", inGeneration: recovered) == 2 })
        #expect(await settle { call.endedToggleCount("toggleCamera") == 4 })
        await call.finish()
    }

    @Test
    func rejoinFreesTheHandGuardWhileTheOrphanedRaiseIsSuspendedAndDropsItsLateAck() async {
        let call = RejoinHarness()
        #expect(await call.join())
        call.calls.hold("setHandRaised(true)")
        call.viewModel.toggleHandRaise()
        #expect(await settle { call.calls.isHolding("setHandRaised(true)") })

        #expect(await call.rejoin())
        await call.land()
        // The orphaned raise is still suspended, yet a raise and a lower
        // reach the recovered call: the rejoin freed the guard.
        call.viewModel.toggleHandRaise()
        #expect(await settle { call.viewModel.state.isHandRaised })
        #expect(call.calls.count("setHandRaised(true)") == 2)
        #expect(await settle { call.endedToggleCount("setHandRaisedState") == 1 })
        call.viewModel.toggleHandRaise()
        #expect(await settle { !call.viewModel.state.isHandRaised })
        #expect(call.calls.count("setHandRaised(false)") == 1)
        #expect(await settle { call.endedToggleCount("setHandRaisedState") == 2 })

        // The orphaned raise's acknowledgement returns late: it belongs to
        // the previous attempt, so the hand stays lowered and nothing is sent.
        let callsBefore = call.calls.totalCount
        call.calls.release("setHandRaised(true)")
        #expect(await settle { call.endedToggleCount("setHandRaisedState") == 3 })
        #expect(!call.viewModel.state.isHandRaised)
        #expect(call.calls.totalCount == callsBefore)

        // The guard stays usable after the orphan finished.
        call.viewModel.toggleHandRaise()
        #expect(await settle { call.viewModel.state.isHandRaised })
        #expect(call.calls.count("setHandRaised(true)") == 3)
        #expect(await settle { call.endedToggleCount("setHandRaisedState") == 4 })
        await call.finish()
    }

    @Test
    func orphanedCompletionCannotFreeANewerTogglesGuard() async {
        let call = RejoinHarness()
        #expect(await call.join())
        call.calls.hold("startProducingAudio")
        call.viewModel.toggleMute()
        #expect(await settle { call.calls.isHolding("startProducingAudio") })
        #expect(await call.rejoin())
        await call.land()
        #expect(call.media.hasLocalAudioProducer)

        // A mute in the recovered call owns the guard while its ack is pending.
        call.calls.hold("setAudioEnabled(false)")
        call.viewModel.toggleMute()
        #expect(call.viewModel.state.isMuted)
        #expect(await settle { call.calls.isHolding("setAudioEnabled(false)") })

        // The orphaned unmute finishes; the newer mute still owns the guard,
        // so another tap is a duplicate and flips nothing.
        call.calls.release("startProducingAudio")
        #expect(await settle { call.endedToggleCount("toggleMute") == 1 })
        call.viewModel.toggleMute()
        #expect(call.viewModel.state.isMuted)

        // Only the owner's completion frees the guard.
        call.calls.release("setAudioEnabled(false)")
        #expect(await settle { call.endedToggleCount("toggleMute") == 2 })
        #expect(call.calls.count("setAudioEnabled(true)") == 0)
        call.viewModel.toggleMute()
        #expect(!call.viewModel.state.isMuted)
        #expect(await settle { call.calls.count("setAudioEnabled(true)") == 1 })
        #expect(await settle { call.endedToggleCount("toggleMute") == 3 })
        await call.finish()
    }

    @Test
    func orphanedMuteFailureMakesNoStateChangeOrMediaCallInTheRecoveredCall() async {
        let call = RejoinHarness()
        #expect(await call.join(muted: false))
        #expect(call.media.hasLocalAudioProducer)
        call.calls.hold("setAudioEnabled(false)")
        call.viewModel.toggleMute()
        #expect(call.viewModel.state.isMuted)
        #expect(await settle { call.calls.isHolding("setAudioEnabled(false)") })

        #expect(await call.rejoin())
        let recovered = call.generation
        await call.land()
        // The teardown dropped the producer and the muted intent published none.
        #expect(!call.media.hasLocalAudioProducer)
        #expect(call.calls.count("startProducingAudio", inGeneration: recovered) == 0)

        // The guard is free: unmute starts and confirms a microphone in the
        // recovered call, and mute pauses it again.
        call.viewModel.toggleMute()
        #expect(!call.viewModel.state.isMuted)
        #expect(await settle {
            call.calls.count("reassertLocalAudioProducerUnmuted", inGeneration: recovered) == 1
        })
        #expect(call.calls.count("startProducingAudio", inGeneration: recovered) == 1)
        #expect(await settle { call.endedToggleCount("toggleMute") == 1 })
        call.viewModel.toggleMute()
        #expect(call.viewModel.state.isMuted)
        #expect(await settle { call.calls.count("setAudioEnabled(false)", inGeneration: recovered) == 1 })
        #expect(await settle { call.endedToggleCount("toggleMute") == 2 })

        // The orphaned mute's acknowledgement finally times out: no rollback,
        // no error and no media call in the recovered call, and the mute stays.
        let callsBefore = call.calls.totalCount
        call.calls.fail("setAudioEnabled(false)", with: StubAckTimeout())
        #expect(await settle { call.endedToggleCount("toggleMute") == 3 })
        #expect(call.calls.totalCount == callsBefore)
        #expect(call.viewModel.state.isMuted)
        #expect(call.viewModel.state.errorMessage == nil)
        call.viewModel.toggleMute()
        #expect(!call.viewModel.state.isMuted)
        #expect(await settle { call.endedToggleCount("toggleMute") == 4 })
        await call.finish()
    }

    /// `CallSessionCoordinator.setMuted` is what CallKit's
    /// CXSetMutedCallAction handler calls, and its `toggleMute()` is what the
    /// Android notification and PiP actions call; this drives those two entry
    /// points, not the system surfaces themselves.
    @Test
    func coordinatorMuteEntryPointsReachTheRecoveredCallsMediaWhileTheOrphanIsSuspended() async {
        let call = RejoinHarness()
        #expect(await call.join())
        call.calls.hold("startProducingAudio")
        call.viewModel.toggleMute()
        #expect(await settle { call.calls.isHolding("startProducingAudio") })
        #expect(await call.rejoin())
        let recovered = call.generation
        await call.land()

        CallSessionCoordinator.shared.register(call.viewModel)
        // The CallKit entry point is absolute and routes to toggleMute.
        CallSessionCoordinator.shared.setMuted(true)
        #expect(call.viewModel.state.isMuted)
        #expect(await settle { call.calls.count("setAudioEnabled(false)", inGeneration: recovered) == 1 })
        #expect(await settle { call.endedToggleCount("toggleMute") == 1 })
        // The notification and PiP entry point is a plain toggle routed to
        // the same toggleMute.
        #expect(!CallSessionCoordinator.shared.toggleMute())
        #expect(!call.viewModel.state.isMuted)
        #expect(await settle { call.calls.count("setAudioEnabled(true)", inGeneration: recovered) == 1 })
        #expect(await settle { call.endedToggleCount("toggleMute") == 2 })

        // The orphaned start returns late; its toggle finishes without any
        // media call.
        let callsBefore = call.calls.totalCount
        call.calls.release("startProducingAudio")
        #expect(await settle { call.endedToggleCount("toggleMute") == 3 })
        #expect(call.calls.totalCount == callsBefore)
        #expect(!call.viewModel.state.isMuted)
        // cleanup() also unregisters the call presence.
        await call.finish()
    }

    @Test
    func orphanedChatCommandTogglesMakeNoMediaCallInTheRecoveredCall() async throws {
        // Parsed before the harness exists, so a parse failure leaves no held
        // join attempt behind.
        let cameraOn = try #require(ChatCommandParser.parse("/camera on"))
        let unmute = try #require(ChatCommandParser.parse("/unmute"))
        let call = RejoinHarness()
        #expect(await call.join())
        call.calls.hold("startProducingVideo")
        call.viewModel.executeChatCommand(cameraOn)
        #expect(await settle { call.calls.isHolding("startProducingVideo") })
        #expect(!call.viewModel.state.isCameraOff)
        call.calls.hold("startProducingAudio")
        call.viewModel.executeChatCommand(unmute)
        #expect(await settle { call.calls.isHolding("startProducingAudio") })
        #expect(!call.viewModel.state.isMuted)

        #expect(await call.rejoin())
        let recovered = call.generation
        await call.land()
        #expect(call.calls.count("startProducingAudio", inGeneration: recovered) == 1)
        #expect(call.calls.count("startProducingVideo", inGeneration: recovered) == 1)

        // The orphaned /unmute returns while the recovered call is unmuted:
        // it finishes without any media call (in particular no confirmation),
        // and its guard is free.
        var callsBefore = call.calls.totalCount
        call.calls.release("startProducingAudio")
        #expect(await settle { call.endedToggleCount("setMuted") == 1 })
        #expect(call.calls.totalCount == callsBefore)
        call.viewModel.toggleMute()
        #expect(call.viewModel.state.isMuted)
        #expect(await settle { call.calls.count("setAudioEnabled(false)", inGeneration: recovered) == 1 })
        #expect(await settle { call.endedToggleCount("toggleMute") == 1 })

        // The user turns the camera off; the orphaned /camera on must not
        // turn it back on when its start returns late.
        call.viewModel.toggleCamera()
        #expect(call.viewModel.state.isCameraOff)
        #expect(await settle { call.calls.count("closeLocalVideoProducer", inGeneration: recovered) == 1 })
        #expect(await settle { call.endedToggleCount("toggleCamera") == 1 })
        callsBefore = call.calls.totalCount
        call.calls.release("startProducingVideo")
        #expect(await settle { call.endedToggleCount("setCameraOff") == 1 })
        #expect(call.calls.totalCount == callsBefore)
        #expect(call.viewModel.state.isCameraOff)
        #expect(!call.media.hasLocalVideoProducer)
        #expect(call.viewModel.state.systemMessages.isEmpty)
        await call.finish()
    }

    /// Codex F7 #3, view model side: the camera enable's recreate fallback
    /// acts only for its own call.
    @Test
    func orphanedCameraEnableFailureMakesNoCloseOrStartCallInTheRecoveredCall() async {
        let call = RejoinHarness()
        #expect(await call.joinWithPausedCameraProducer())
        call.calls.hold("setVideoEnabled(true)")
        call.viewModel.toggleCamera()
        #expect(!call.viewModel.state.isCameraOff)
        #expect(await settle { call.calls.isHolding("setVideoEnabled(true)") })

        #expect(await call.rejoin())
        let recovered = call.generation
        await call.land()
        // The recovered call published the camera from the on intent.
        #expect(call.calls.count("startProducingVideo", inGeneration: recovered) == 1)
        #expect(call.media.hasLocalVideoProducer)

        // The orphaned enable fails late with a stale-producer error. Its
        // recreate fallback must not close or restart the recovered call's
        // camera producer, and its error must not reach the recovered call.
        let callsBefore = call.calls.totalCount
        call.calls.fail("setVideoEnabled(true)", with: StubMediaError("Producer closed"))
        #expect(await settle { call.endedToggleCount("toggleCamera") == 1 })
        #expect(call.calls.totalCount == callsBefore)
        #expect(call.calls.count("closeLocalVideoProducer") == 0)
        #expect(call.media.hasLocalVideoProducer)
        #expect(!call.viewModel.state.isCameraOff)
        #expect(call.viewModel.state.errorMessage == nil)
        await call.finish()
    }

    /// Baseline for the test above: in the same call, the fallback still
    /// replaces a stale camera producer.
    @Test
    func sameCallCameraEnableFailureStillClosesAndRestartsTheProducer() async {
        let call = RejoinHarness()
        #expect(await call.joinWithPausedCameraProducer())
        let session = call.generation
        call.calls.hold("setVideoEnabled(true)")
        call.viewModel.toggleCamera()
        #expect(await settle { call.calls.isHolding("setVideoEnabled(true)") })

        call.calls.fail("setVideoEnabled(true)", with: StubMediaError("Producer closed"))
        #expect(await settle { call.endedToggleCount("toggleCamera") == 1 })
        // One start when the call joined, one from the fallback.
        #expect(call.calls.count("startProducingVideo", inGeneration: session) == 2)
        #expect(call.calls.count("closeLocalVideoProducer", inGeneration: session) == 1)
        #expect(call.media.hasLocalVideoProducer)
        #expect(!call.viewModel.state.isCameraOff)
        await call.finish()
    }

    /// Codex F7 #4, view model side, with a late successful acknowledgement.
    @Test
    func orphanedUnmuteConfirmationThatSucceedsLateMakesNoMediaCallInTheRecoveredCall() async {
        await assertOrphanedUnmuteConfirmationMakesNoMediaCall(lateFailure: nil)
    }

    /// Codex F7 #4, view model side, with a late failed acknowledgement (the
    /// Android text for a replaced socket).
    @Test
    func orphanedUnmuteConfirmationThatFailsLateMakesNoMediaCallInTheRecoveredCall() async {
        await assertOrphanedUnmuteConfirmationMakesNoMediaCall(
            lateFailure: StubMediaError("Socket changed before toggleMute acknowledgement")
        )
    }

    @Test
    func duplicateTapsWhileAToggleIsInFlightAreIgnored() async {
        let call = RejoinHarness()
        #expect(await call.join(muted: false, cameraOff: false))
        let videoStartsBefore = call.calls.count("startProducingVideo")
        call.calls.hold("setAudioEnabled(false)")
        call.calls.hold("closeLocalVideoProducer")
        call.calls.hold("setHandRaised(true)")

        call.viewModel.toggleMute()
        call.viewModel.toggleMute()
        call.viewModel.toggleCamera()
        call.viewModel.toggleCamera()
        call.viewModel.toggleHandRaise()
        call.viewModel.toggleHandRaise()
        // The second mic and camera taps return before flipping anything.
        #expect(call.viewModel.state.isMuted)
        #expect(call.viewModel.state.isCameraOff)
        // Both hand tasks were queued, in order, before this wait on the
        // serial main actor, so the second one (which finds the guard held)
        // has run by the time the first one holds and the wait returns.
        #expect(await settle {
            call.calls.isHolding("setAudioEnabled(false)")
                && call.calls.isHolding("closeLocalVideoProducer")
                && call.calls.isHolding("setHandRaised(true)")
        })
        #expect(call.calls.count("setAudioEnabled(false)") == 1)
        #expect(call.calls.count("setAudioEnabled(true)") == 0)
        #expect(call.calls.count("closeLocalVideoProducer") == 1)
        #expect(call.calls.count("startProducingVideo") == videoStartsBefore)
        #expect(call.calls.count("setHandRaised(true)") == 1)

        // Each completion frees its own guard, so the next taps work.
        call.calls.release("setAudioEnabled(false)")
        call.calls.release("closeLocalVideoProducer")
        call.calls.release("setHandRaised(true)")
        #expect(await settle {
            call.endedToggleCount("toggleMute") == 1
                && call.endedToggleCount("toggleCamera") == 1
                && call.endedToggleCount("setHandRaisedState") == 1
        })
        #expect(call.viewModel.state.isHandRaised)
        call.viewModel.toggleMute()
        call.viewModel.toggleCamera()
        call.viewModel.toggleHandRaise()
        #expect(!call.viewModel.state.isMuted)
        #expect(!call.viewModel.state.isCameraOff)
        #expect(await settle { !call.viewModel.state.isHandRaised })
        #expect(call.calls.count("setHandRaised(false)") == 1)
        #expect(await settle {
            call.endedToggleCount("toggleMute") == 2
                && call.endedToggleCount("toggleCamera") == 2
                && call.endedToggleCount("setHandRaisedState") == 2
        })
        await call.finish()
    }

    @Test
    func failedMuteStaysMutedReportsTheErrorAndFreesTheGuard() async {
        let call = RejoinHarness()
        #expect(await call.join(muted: false))
        call.calls.hold("setAudioEnabled(false)")
        call.viewModel.toggleMute()
        #expect(await settle { call.calls.isHolding("setAudioEnabled(false)") })

        call.calls.fail("setAudioEnabled(false)", with: StubAckTimeout())
        #expect(await settle { call.endedToggleCount("toggleMute") == 1 })
        #expect(call.viewModel.state.isMuted)
        #expect(call.viewModel.state.errorMessage != nil)

        call.viewModel.toggleMute()
        #expect(!call.viewModel.state.isMuted)
        #expect(await settle { call.endedToggleCount("toggleMute") == 2 })
        await call.finish()
    }

    @Test
    func inFlightUnmuteStillSuppressesTheProducerClosedRestart() async {
        let call = RejoinHarness()
        #expect(await call.join())
        call.calls.hold("startProducingAudio")
        call.viewModel.toggleMute()
        #expect(await settle { call.calls.isHolding("startProducingAudio") })
        #expect(!call.viewModel.state.isMuted)

        // The toggle owns the microphone: the SFU closing the local producer
        // does not restart it, and the intent falls back to muted.
        call.media.testClosesLocalMedia = { kind in kind == "audio" }
        call.closeLocalMicrophone()
        #expect(await settle { call.viewModel.state.isMuted })
        #expect(call.calls.count("startProducingAudio") == 1)
        await call.finish()
    }

    @Test
    func orphanedUnmuteNoLongerSuppressesTheRecoveredCallsProducerClosedRestart() async {
        let call = RejoinHarness()
        #expect(await call.join())
        call.calls.hold("startProducingAudio")
        call.viewModel.toggleMute()
        #expect(await settle { call.calls.isHolding("startProducingAudio") })
        #expect(await call.rejoin())
        let recovered = call.generation
        await call.land()
        #expect(call.calls.count("startProducingAudio", inGeneration: recovered) == 1)

        // The orphaned toggle is still suspended but owns nothing in the
        // recovered call, so that call's producer-closed restart runs.
        call.media.testClosesLocalMedia = { kind in kind == "audio" }
        call.closeLocalMicrophone()
        #expect(await settle { call.calls.count("startProducingAudio", inGeneration: recovered) == 2 })
        await call.finish()
    }

    /// An unmute whose confirmation is still awaiting its acknowledgement when
    /// a rejoin lands, then a mute in the recovered call. When the old
    /// confirmation returns, its toggle finishes without any media call and
    /// the newer mute stays. Whether a client re-enables capture after such an
    /// acknowledgement is that client's own fence, pinned by
    /// `ConclaveTests.testLateMediaAcknowledgementsAreFencedInBothClients`.
    private func assertOrphanedUnmuteConfirmationMakesNoMediaCall(lateFailure: Error?) async {
        let call = RejoinHarness()
        #expect(await call.join(muted: false))
        let first = call.generation
        // Mute, then unmute: the unmute enables the paused producer and then
        // holds in its confirmation's acknowledgement.
        call.viewModel.toggleMute()
        #expect(await settle { call.calls.count("setAudioEnabled(false)", inGeneration: first) == 1 })
        #expect(await settle { call.endedToggleCount("toggleMute") == 1 })
        call.calls.hold("reassertLocalAudioProducerUnmuted")
        call.viewModel.toggleMute()
        #expect(!call.viewModel.state.isMuted)
        #expect(await settle { call.calls.isHolding("reassertLocalAudioProducerUnmuted") })
        #expect(call.calls.count("setAudioEnabled(true)", inGeneration: first) == 1)

        #expect(await call.rejoin())
        let recovered = call.generation
        await call.land()
        #expect(call.calls.count("startProducingAudio", inGeneration: recovered) == 1)
        // A newer mute in the recovered call.
        call.viewModel.toggleMute()
        #expect(call.viewModel.state.isMuted)
        #expect(await settle { call.calls.count("setAudioEnabled(false)", inGeneration: recovered) == 1 })
        #expect(await settle { call.endedToggleCount("toggleMute") == 2 })

        let callsBefore = call.calls.totalCount
        if let lateFailure {
            call.calls.fail("reassertLocalAudioProducerUnmuted", with: lateFailure)
        } else {
            call.calls.release("reassertLocalAudioProducerUnmuted")
        }
        #expect(await settle { call.endedToggleCount("toggleMute") == 3 })
        #expect(call.calls.totalCount == callsBefore)
        #expect(call.viewModel.state.isMuted)
        #expect(call.viewModel.state.errorMessage == nil)
        #expect(call.media.hasLocalAudioProducer)
        await call.finish()
    }
}

/// A call whose join attempts come from the real `joinRoom`.
@MainActor
private final class RejoinHarness {
    private static let resumeKey = "conclave.activeMeetingResume.v1"
    /// The media teardown a join task makes (`cleanup()` passes true).
    private static let joinTeardown = "cleanup(notifyLocalState: false)"

    let viewModel = MeetingViewModel()
    let calls = HeldStubCalls()
    private let savedResumeSnapshot: Any?
    private var endedToggles: [String] = []

    var media: WebRTCClient { viewModel.webRTCClient }
    /// The media session the call is in: each teardown starts a new one.
    var generation: Int { media.configurationGeneration }

    init() {
        savedResumeSnapshot = UserDefaults.standard.object(forKey: Self.resumeKey)
        viewModel.state = MeetingState(userId: "local@example.com#local-session", sessionId: "local-session")
        let calls = self.calls
        let media = viewModel.webRTCClient
        media.testCallGate = { [weak media] name in
            try await calls.pass(name, generation: media?.configurationGeneration ?? -1)
        }
        viewModel.socketManager.testCallGate = { [weak media] name in
            try await calls.pass(name, generation: media?.configurationGeneration ?? -1)
        }
        viewModel.testLocalToggleEnded = { [weak self] kind in
            self?.endedToggles.append(kind)
        }
        // Media from an earlier attempt reports configured, so every join
        // task (planned or not) first tears it down, and that teardown is held
        // until finish() has retired the attempt: no join task can reach the
        // network join fetch. The view model's own cleanup() is not held.
        media.isConfigured = true
        calls.holdEvery(Self.joinTeardown)
    }

    /// Toggles of this kind (the view model function that took the guard)
    /// whose task has finished.
    func endedToggleCount(_ kind: String) -> Int {
        endedToggles.filter { $0 == kind }.count
    }

    /// Starts the call's first join attempt with this media intent and lands it.
    func join(muted: Bool = true, cameraOff: Bool = true) async -> Bool {
        viewModel.state.isMuted = muted
        viewModel.state.isCameraOff = cameraOff
        let heldBefore = calls.heldCount(Self.joinTeardown)
        viewModel.joinRoom(roomId: "room-a", displayName: "Local User", clientId: "test-client")
        guard await settle({ self.calls.heldCount(Self.joinTeardown) == heldBefore + 1 }) else { return false }
        await land()
        return true
    }

    /// A joined call whose camera producer exists but is paused: the camera
    /// was on, was turned off while the connection was recovering (which
    /// pauses the producer without closing it), and the transports recovered
    /// without a rejoin.
    func joinWithPausedCameraProducer() async -> Bool {
        guard await join(cameraOff: false), media.hasLocalVideoProducer else { return false }
        viewModel.state.connectionState = .reconnecting
        viewModel.state.isRecoveringConnection = true
        viewModel.toggleCamera()
        guard viewModel.state.isCameraOff,
              await settle({ self.calls.count("suspendLocalVideoForRecovery") == 1 }) else { return false }
        viewModel.state.connectionState = .joined
        viewModel.state.isRecoveringConnection = false
        return media.hasLocalVideoProducer
    }

    /// The socket dropped and reconnected: the real recovery entry point
    /// starts a new join attempt, whose teardown starts a new media session.
    func rejoin() async -> Bool {
        viewModel.state.connectionState = .reconnecting
        viewModel.state.isRecoveringConnection = true
        viewModel.shouldRejoinAfterReconnect = true
        let heldBefore = calls.heldCount(Self.joinTeardown)
        await viewModel.rejoinIfPossible()
        return await settle { self.calls.heldCount(Self.joinTeardown) == heldBefore + 1 }
    }

    /// The join response landed: like `handleJoinedRoomResponse`, publish
    /// media from the current intent through the real `startProducing()`,
    /// then mark the call joined.
    func land() async {
        _ = await viewModel.startProducing()
        viewModel.state.connectionState = .joined
        viewModel.state.isRecoveringConnection = false
        viewModel.isRejoinInFlight = false
    }

    func closeLocalMicrophone() {
        viewModel.socketManager.onProducerClosed?(ProducerClosedNotification(
            producerId: "local-microphone",
            producerUserId: nil,
            roomId: "room-a",
            adminEnforced: nil
        ))
    }

    /// Retires every held join attempt and toggle without reaching the
    /// network: cleanup() clears the attempt id while every join teardown is
    /// still held, then each held call returns and its caller stops at its
    /// attempt or call guard. Waits until every held call has returned to its
    /// caller.
    func finish() async {
        calls.clearPendingHolds()
        await viewModel.cleanup()
        calls.stopHoldingEvery(Self.joinTeardown)
        calls.releaseAll()
        let returned = await settle { self.calls.outstandingCount == 0 }
        #expect(returned, "a held stub call never returned to its caller")
        viewModel.testLocalToggleEnded = nil
        if let savedResumeSnapshot {
            UserDefaults.standard.set(savedResumeSnapshot, forKey: Self.resumeKey)
        } else {
            UserDefaults.standard.removeObject(forKey: Self.resumeKey)
        }
    }
}

/// Holds chosen stub calls mid-await and records every call through the gate
/// with the media session it landed in.
@MainActor
private final class HeldStubCalls {
    private struct LoggedCall {
        let name: String
        let generation: Int
    }

    private struct HeldCall {
        let name: String
        let continuation: CheckedContinuation<Void, Error>
    }

    private var log: [LoggedCall] = []
    private var returnedCount = 0
    private var enteredHolds = 0
    private var pendingHolds: [String] = []
    private var alwaysHeld: Set<String> = []
    private var held: [HeldCall] = []

    /// Holds the next call with this name.
    func hold(_ name: String) {
        pendingHolds.append(name)
    }

    /// Holds every call with this name until `stopHoldingEvery`.
    func holdEvery(_ name: String) {
        alwaysHeld.insert(name)
    }

    func stopHoldingEvery(_ name: String) {
        alwaysHeld.remove(name)
    }

    func pass(_ name: String, generation: Int) async throws {
        log.append(LoggedCall(name: name, generation: generation))
        if let index = pendingHolds.firstIndex(of: name) {
            pendingHolds.remove(at: index)
        } else if !alwaysHeld.contains(name) {
            return
        }
        enteredHolds += 1
        defer { returnedCount += 1 }
        try await withCheckedThrowingContinuation { continuation in
            held.append(HeldCall(name: name, continuation: continuation))
        }
    }

    func isHolding(_ name: String) -> Bool {
        held.contains { $0.name == name }
    }

    func heldCount(_ name: String) -> Int {
        held.filter { $0.name == name }.count
    }

    func count(_ name: String) -> Int {
        log.filter { $0.name == name }.count
    }

    func count(_ name: String, inGeneration generation: Int) -> Int {
        log.filter { $0.name == name && $0.generation == generation }.count
    }

    /// Every call that reached a stub, held or not.
    var totalCount: Int {
        log.count
    }

    /// Calls that entered a hold and have not yet returned to their caller.
    var outstandingCount: Int {
        enteredHolds - returnedCount
    }

    func release(_ name: String) {
        resume(name, throwing: nil)
    }

    func fail(_ name: String, with error: Error) {
        resume(name, throwing: error)
    }

    func clearPendingHolds() {
        pendingHolds.removeAll()
    }

    func releaseAll() {
        pendingHolds.removeAll()
        alwaysHeld.removeAll()
        let calls = held
        held.removeAll()
        for call in calls {
            call.continuation.resume()
        }
    }

    private func resume(_ name: String, throwing error: Error?) {
        guard let index = held.firstIndex(where: { $0.name == name }) else {
            Issue.record("no held call named \(name)")
            return
        }
        let call = held.remove(at: index)
        if let error {
            call.continuation.resume(throwing: error)
        } else {
            call.continuation.resume()
        }
    }
}

private struct StubAckTimeout: LocalizedError {
    var errorDescription: String? { "Timed out waiting for the SFU" }
}

private struct StubMediaError: LocalizedError {
    let message: String

    init(_ message: String) {
        self.message = message
    }

    var errorDescription: String? { message }
}

/// Lets main-actor work run until `condition` holds. Bounded by wall-clock
/// time, so a regression fails the expectation instead of hanging the suite.
@MainActor
private func settle(timeout: Duration = .seconds(5), _ condition: () -> Bool) async -> Bool {
    let deadline = ContinuousClock.now.advanced(by: timeout)
    while !condition() {
        guard ContinuousClock.now < deadline else { return false }
        await Task.yield()
    }
    return true
}
#endif
