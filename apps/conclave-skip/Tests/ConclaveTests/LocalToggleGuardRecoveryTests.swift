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

    // MARK: - WP2-S1c: the newest local media intent wins

    /// P2: a camera-off on the reconnecting screen while the recovered
    /// call's camera start awaits wins. The view model closes whatever that
    /// start committed, and the camera stays off through every state report.
    /// (The real clients also drop such a start themselves once the camera-off
    /// reached them, pinned by
    /// `ConclaveTests.testLateMediaAcknowledgementsAreFencedInBothClients`;
    /// this stub does not, so the view model's own fence is what passes here.)
    @Test
    func cameraOffOnTheReconnectingScreenWinsOverTheRecoveredCallsCameraStart() async {
        let call = RejoinHarness()
        #expect(await call.join(cameraOff: false))
        call.media.testReportsLocalVideoState = true
        #expect(await call.rejoin())
        let recovered = call.generation
        call.calls.hold("startProducingVideo")
        let landing = Task { await call.land() }
        #expect(await settle { call.calls.isHolding("startProducingVideo") })

        call.viewModel.toggleCamera()
        #expect(call.viewModel.state.isCameraOff)
        #expect(await settle { call.calls.count("suspendLocalVideoForRecovery", inGeneration: recovered) == 1 })

        call.calls.release("startProducingVideo")
        await landing.value
        #expect(call.calls.count("closeLocalVideoProducer", inGeneration: recovered) == 1)
        #expect(!call.media.hasLocalVideoProducer)
        #expect(await call.reportsHandled())
        #expect(call.viewModel.state.isCameraOff)
        await call.finish()
    }

    /// The recovered call's camera start already committed and its attempt
    /// joins before the camera-off's hop to the media layer runs. The
    /// camera-off still applies: it closes the published camera.
    @Test
    func cameraOffOnTheReconnectingScreenStillAppliesWhenTheRecoveredCallJoinsFirst() async {
        let call = RejoinHarness()
        #expect(await call.join(cameraOff: false))
        #expect(await call.rejoin())
        let recovered = call.generation
        _ = await call.viewModel.startProducing()
        #expect(call.media.hasLocalVideoProducer)

        call.viewModel.toggleCamera()
        #expect(call.viewModel.state.isCameraOff)
        // The join continuation was queued before that hop.
        call.markJoined()
        #expect(await settle { call.calls.count("closeLocalVideoProducer", inGeneration: recovered) == 1 })
        #expect(!call.media.hasLocalVideoProducer)
        #expect(call.viewModel.state.isCameraOff)
        await call.finish()
    }

    /// The microphone twin: a mute on the reconnecting screen reaches the
    /// media layer at once, so a recovered attempt that joins first cannot
    /// leave its freshly started microphone live under a muted UI.
    @Test
    func muteOnTheReconnectingScreenStillAppliesWhenTheRecoveredCallJoinsFirst() async {
        let call = RejoinHarness()
        call.media.testModelsLocalAudioState = true
        #expect(await call.join(muted: false))
        #expect(await call.rejoin())
        let recovered = call.generation
        _ = await call.viewModel.startProducing()
        #expect(call.media.isLocalAudioPublishingHealthy)

        call.viewModel.toggleMute()
        #expect(call.viewModel.state.isMuted)
        #expect(call.calls.count("suspendLocalAudioForRecovery", inGeneration: recovered) == 1)
        #expect(!call.media.isLocalAudioPublishingHealthy)
        call.markJoined()
        #expect(await call.reportsHandled())
        #expect(call.viewModel.state.isMuted)
        #expect(!call.media.isLocalAudioPublishingHealthy)
        await call.finish()
    }

    /// Codex round 1 (C2): the recovered attempt's start committed and its
    /// camera-on report is still queued when the camera-off is tapped on the
    /// reconnecting screen. That stale report flips the UI back on first; the
    /// camera-off is still the newest intent, so it must still apply to the
    /// media and end with the UI off.
    @Test
    func cameraOffOnTheReconnectingScreenWinsOverAStaleCameraOnReport() async {
        let call = RejoinHarness()
        #expect(await call.join(cameraOff: false))
        #expect(await call.rejoin())
        let recovered = call.generation
        call.media.testReportsLocalVideoState = true
        _ = await call.viewModel.startProducing()
        #expect(call.media.hasLocalVideoProducer)

        call.viewModel.toggleCamera()
        #expect(call.viewModel.state.isCameraOff)
        #expect(await settle { call.calls.count("suspendLocalVideoForRecovery", inGeneration: recovered) == 1 })
        #expect(await call.reportsHandled())
        #expect(call.viewModel.state.isCameraOff)
        await call.finish()
    }

    /// Codex round 1 (C3): an admin-enforced camera close whose producer id
    /// matches nothing yet (the start's create has not installed it) still
    /// cancels that start, and the pending camera-on commits nothing.
    @Test
    func adminEnforcedCameraCloseWhileACameraStartAwaitsWins() async {
        let call = RejoinHarness()
        #expect(await call.join())
        let session = call.generation
        call.calls.hold("startProducingVideo")
        call.viewModel.toggleCamera()
        #expect(await settle { call.calls.isHolding("startProducingVideo") })

        #expect(await call.viewModel.closeAdminEnforcedProducer(
            AdminMediaProducer(producerId: "not-installed-yet", kind: "video", type: "webcam")
        ))
        #expect(call.viewModel.state.isCameraOff)
        #expect(call.calls.count("closeLocalVideoProducer", inGeneration: session) == 1)
        call.calls.release("startProducingVideo")
        #expect(await settle { call.endedToggleCount("toggleCamera") == 1 })
        #expect(!call.media.hasLocalVideoProducer)
        #expect(call.viewModel.state.isCameraOff)
        #expect(call.viewModel.state.errorMessage == nil)
        await call.finish()
    }

    /// Codex round 1 (C1): chat `/camera off` is never dropped behind a
    /// pending `/camera on`.
    @Test
    func chatCameraOffWhileAChatCameraOnStartsWins() async throws {
        let cameraOn = try #require(ChatCommandParser.parse("/camera on"))
        let cameraOff = try #require(ChatCommandParser.parse("/camera off"))
        let call = RejoinHarness()
        #expect(await call.join())
        let session = call.generation
        call.calls.hold("startProducingVideo")
        call.viewModel.executeChatCommand(cameraOn)
        #expect(await settle { call.calls.isHolding("startProducingVideo") })
        #expect(!call.viewModel.state.isCameraOff)

        call.viewModel.executeChatCommand(cameraOff)
        #expect(await settle { call.viewModel.state.isCameraOff })
        #expect(await settle { call.calls.count("closeLocalVideoProducer", inGeneration: session) == 1 })
        call.calls.release("startProducingVideo")
        #expect(await settle { call.endedToggleCount("setCameraOff") == 1 })
        #expect(!call.media.hasLocalVideoProducer)
        #expect(call.viewModel.state.isCameraOff)
        #expect(call.viewModel.state.errorMessage == nil)
        await call.finish()
    }

    /// Codex round 1 (C6): the SFU closed the camera producer while a
    /// camera-on awaited its acknowledgement (the toggle suppressed the
    /// producer-closed restart). The camera-on is still the newest intent, so
    /// it recreates the camera instead of showing it on with none.
    @Test
    func cameraOnWhoseProducerTheSFUClosedDuringItsAcknowledgementRecreatesIt() async {
        let call = RejoinHarness()
        #expect(await call.joinWithPausedCameraProducer())
        let session = call.generation
        call.media.testClosesLocalMedia = { kind in kind == "video" }
        call.calls.hold("setVideoEnabled(true)")
        call.viewModel.toggleCamera()
        #expect(await settle { call.calls.isHolding("setVideoEnabled(true)") })
        let startsBefore = call.calls.count("startProducingVideo", inGeneration: session)

        call.closeLocalCamera()
        #expect(await settle { !call.media.hasLocalVideoProducer })
        call.calls.release("setVideoEnabled(true)")
        #expect(await settle { call.endedToggleCount("toggleCamera") == 1 })
        #expect(call.calls.count("startProducingVideo", inGeneration: session) == startsBefore + 1)
        #expect(call.media.hasLocalVideoProducer)
        #expect(!call.viewModel.state.isCameraOff)
        await call.finish()
    }

    /// Codex round 2 (R2-1): the recovered start closes its camera for a
    /// camera-off from the reconnecting screen, and the user turns the camera
    /// back on while that close awaits. The start converges on the newest
    /// intent and starts the camera again.
    @Test
    func cameraOnTappedWhileTheRecoveredStartClosesForACameraOffStartsTheCameraAgain() async {
        let call = RejoinHarness()
        #expect(await call.join(cameraOff: false))
        #expect(await call.rejoin())
        let recovered = call.generation
        call.calls.hold("startProducingVideo")
        let landing = Task { await call.land() }
        #expect(await settle { call.calls.isHolding("startProducingVideo") })
        call.viewModel.toggleCamera()
        #expect(await settle { call.calls.count("suspendLocalVideoForRecovery", inGeneration: recovered) == 1 })
        call.calls.hold("closeLocalVideoProducer")
        call.calls.release("startProducingVideo")
        #expect(await settle { call.calls.isHolding("closeLocalVideoProducer") })

        call.viewModel.toggleCamera()
        #expect(!call.viewModel.state.isCameraOff)
        call.calls.release("closeLocalVideoProducer")
        await landing.value
        #expect(call.calls.count("startProducingVideo", inGeneration: recovered) == 2)
        #expect(call.media.hasLocalVideoProducer)
        #expect(!call.viewModel.state.isCameraOff)
        await call.finish()
    }

    /// Codex round 2 (R2-2), in the SFU's real order: the host turns the
    /// camera off while a camera-on awaits its acknowledgement. The owner's
    /// plain producerClosed closes the camera first (held in its awaited
    /// close), then admin:producerClosed, participantCameraOff and
    /// admin:mediaEnforced record the camera-off. The camera-on's
    /// acknowledgement then lands with its producer gone: it neither commits
    /// nor recreates the camera, and the close restarts nothing.
    @Test
    func aHostCameraOffDuringACameraOnNeverRecreatesTheCamera() async {
        let call = RejoinHarness()
        #expect(await call.joinWithPausedCameraProducer())
        let session = call.generation
        call.media.testClosesLocalMedia = call.closesLocalProducerOnce("video")
        call.calls.hold("setVideoEnabled(true)")
        call.viewModel.toggleCamera()
        #expect(await settle { call.calls.isHolding("setVideoEnabled(true)") })
        let startsBefore = call.calls.count("startProducingVideo", inGeneration: session)

        call.calls.hold("closeLocalMedia(video)")
        call.closeLocalCamera()
        #expect(await settle { call.calls.isHolding("closeLocalMedia(video)") })
        #expect(await call.deliverAdminCloseEvents(producerId: "local-camera", kind: "video", type: "webcam"))
        call.calls.release("setVideoEnabled(true)")
        #expect(await settle { call.endedToggleCount("toggleCamera") == 1 })
        call.calls.release("closeLocalMedia(video)")
        #expect(await call.releasedCallsReturned())
        #expect(await call.reportsHandled())
        #expect(call.calls.count("startProducingVideo", inGeneration: session) == startsBefore)
        #expect(!call.media.hasLocalVideoProducer)
        #expect(call.viewModel.state.isCameraOff)
        await call.finish()
    }

    /// Review round 4 (issue 1): the host turns a live camera off. The
    /// owner's plain producerClosed closes the camera first and awaits the
    /// capture stop, as the iOS close does; admin:producerClosed,
    /// participantCameraOff and admin:mediaEnforced land during that await.
    /// The close's restart then starts nothing: camera-on is no longer the
    /// newest intent, so the camera is never captured or published again.
    @Test
    func aHostCameraOffNeverRestartsTheCameraItClosed() async {
        let call = RejoinHarness()
        #expect(await call.join(cameraOff: false))
        let session = call.generation
        call.media.testClosesLocalMedia = call.closesLocalProducerOnce("video")
        let startsBefore = call.calls.count("startProducingVideo", inGeneration: session)
        call.calls.hold("closeLocalMedia(video)")
        call.closeLocalCamera()
        #expect(await settle { call.calls.isHolding("closeLocalMedia(video)") })
        #expect(await call.deliverAdminCloseEvents(producerId: "local-camera", kind: "video", type: "webcam"))

        call.calls.release("closeLocalMedia(video)")
        #expect(await call.releasedCallsReturned())
        #expect(call.calls.count("startProducingVideo", inGeneration: session) == startsBefore)
        #expect(!call.media.hasLocalVideoProducer)
        #expect(call.viewModel.state.isCameraOff)
        await call.finish()
    }

    /// Review round 4 (issue 2): the host mutes the user while a camera-on
    /// awaits its start. admin:producerClosed arrives after the plain close
    /// removed the microphone, so it cannot tell a microphone from a camera:
    /// it records no camera-off, and the camera-on still commits.
    @Test
    func aHostMuteNeverCancelsAPendingCameraOn() async {
        let call = RejoinHarness()
        #expect(await call.join(muted: false))
        let session = call.generation
        call.calls.hold("startProducingVideo")
        call.viewModel.toggleCamera()
        #expect(await settle { call.calls.isHolding("startProducingVideo") })

        call.media.testClosesLocalMedia = call.closesLocalProducerOnce("audio")
        let microphoneCloses = call.calls.count("closeLocalMedia(audio)", inGeneration: session)
        call.closeLocalMicrophone()
        #expect(await settle { call.calls.count("closeLocalMedia(audio)", inGeneration: session) == microphoneCloses + 1 })
        #expect(await call.deliverAdminCloseEvents(producerId: "local-microphone", kind: "audio", type: "webcam"))
        #expect(call.viewModel.state.isMuted)

        call.calls.release("startProducingVideo")
        #expect(await settle { call.endedToggleCount("toggleCamera") == 1 })
        #expect(call.calls.count("closeLocalVideoProducer", inGeneration: session) == 0)
        #expect(call.media.hasLocalVideoProducer)
        #expect(!call.viewModel.state.isCameraOff)
        #expect(call.viewModel.state.isMuted)
        await call.finish()
    }

    /// Review round 4 (issue 4): an admin room snapshot reports producer
    /// state, not intent. One taken before the user's unmute reached the SFU
    /// says muted; it lands while that unmute awaits its acknowledgement and
    /// must not discard it.
    @Test
    func anAdminRoomSnapshotNeverOverridesAnUnmuteInFlight() async throws {
        let call = RejoinHarness()
        call.media.testModelsLocalAudioState = true
        #expect(await call.joinWithPausedMicrophone())
        call.calls.hold("setAudioEnabled(true)")
        call.viewModel.toggleMute()
        #expect(!call.viewModel.state.isMuted)
        #expect(await settle { call.calls.isHolding("setAudioEnabled(true)") })

        try call.deliverAdminRoomSnapshot(localMuted: true)
        #expect(await settle { call.viewModel.state.hasInitialPresenceSnapshot })
        #expect(!call.viewModel.state.isMuted)
        call.calls.release("setAudioEnabled(true)")
        #expect(await settle { call.endedToggleCount("toggleMute") == 2 })
        #expect(await call.reportsHandled())
        #expect(!call.viewModel.state.isMuted)
        #expect(call.media.isLocalAudioPublishingHealthy)
        await call.finish()
    }

    /// Codex round 2 (R2-2): a camera-on the user taps while an admin camera
    /// close awaits is newer than that close, which then reports nothing
    /// over the live camera.
    @Test
    func aCameraOnTappedDuringAnAdminCameraCloseStaysOn() async {
        let call = RejoinHarness()
        #expect(await call.join())
        call.calls.hold("closeLocalVideoProducer")
        let enforcing = Task {
            await call.viewModel.closeAdminEnforcedProducer(
                AdminMediaProducer(producerId: "enforced-earlier", kind: "video", type: "webcam")
            )
        }
        #expect(await settle { call.calls.isHolding("closeLocalVideoProducer") })
        #expect(call.viewModel.state.isCameraOff)

        call.viewModel.toggleCamera()
        #expect(await settle { call.endedToggleCount("toggleCamera") == 1 })
        #expect(call.media.hasLocalVideoProducer)
        call.calls.release("closeLocalVideoProducer")
        _ = await enforcing.value
        #expect(!call.viewModel.state.isCameraOff)
        #expect(call.media.hasLocalVideoProducer)
        await call.finish()
    }

    /// Codex round 3 (R2-2): an admin-flagged producer close that finds the
    /// camera installed (an intentional-close marker, as an iOS topology
    /// replacement sets, consumed the owner's plain close of it) awaits
    /// closing camera A. The enforcement's
    /// camera-off event turns the camera off, then the user turns it back on
    /// and publishes camera B. When the close resumes it reports nothing over
    /// B: the user's camera-on is newer.
    @Test
    func anAdminProducerCloseResumingAfterTheUserPublishedANewerCameraReportsNothing() async {
        let call = RejoinHarness()
        #expect(await call.join(cameraOff: false))
        let session = call.generation
        call.media.testClosesLocalMedia = { kind in kind == "video" }
        call.calls.hold("closeLocalMedia(video)")
        call.closeLocalCamera(adminEnforced: true)
        #expect(await settle { call.calls.isHolding("closeLocalMedia(video)") })
        call.deliverAdminCameraOff()
        #expect(await settle { call.endedToggleCount("applyLocalCameraOffStateFromServer") == 1 })
        #expect(call.viewModel.state.isCameraOff)
        #expect(call.calls.count("closeLocalMedia(video)", inGeneration: session) == 2)

        call.viewModel.toggleCamera()
        #expect(await settle { call.endedToggleCount("toggleCamera") == 1 })
        #expect(call.media.hasLocalVideoProducer)
        #expect(!call.viewModel.state.isCameraOff)
        call.calls.release("closeLocalMedia(video)")
        #expect(await call.releasedCallsReturned())
        #expect(call.media.hasLocalVideoProducer)
        #expect(!call.viewModel.state.isCameraOff)
        await call.finish()
    }

    /// Codex round 3 (R2-2): the same, but the user's camera-on is still
    /// starting when the close resumes, so no camera is live yet. The close
    /// still reports nothing over the newer camera-on.
    @Test
    func anAdminProducerCloseResumingDuringANewerCameraOnReportsNothing() async {
        let call = RejoinHarness()
        #expect(await call.join(cameraOff: false))
        call.media.testClosesLocalMedia = { kind in kind == "video" }
        call.calls.hold("closeLocalMedia(video)")
        call.closeLocalCamera(adminEnforced: true)
        #expect(await settle { call.calls.isHolding("closeLocalMedia(video)") })
        call.deliverAdminCameraOff()
        #expect(await settle { call.endedToggleCount("applyLocalCameraOffStateFromServer") == 1 })
        call.calls.hold("startProducingVideo")
        call.viewModel.toggleCamera()
        #expect(await settle { call.calls.isHolding("startProducingVideo") })

        call.calls.release("closeLocalMedia(video)")
        #expect(await call.releasedCallsReturned())
        #expect(!call.viewModel.state.isCameraOff)
        call.calls.release("startProducingVideo")
        #expect(await settle { call.endedToggleCount("toggleCamera") == 1 })
        #expect(call.media.hasLocalVideoProducer)
        #expect(!call.viewModel.state.isCameraOff)
        await call.finish()
    }

    /// Codex round 3 (R2-2, producer ownership): while an admin-flagged
    /// producer close awaits (its restart is suppressed), a publishing
    /// reassert (the camera-off has not reached the UI yet) publishes camera
    /// B, and no newer camera intent lands. The close never reports off over
    /// live B; the enforcement's camera-off event that follows closes B.
    @Test
    func anAdminProducerCloseNeverReportsOffOverACameraAReassertPublishedDuringIt() async {
        let call = RejoinHarness()
        #expect(await call.join(cameraOff: false))
        let session = call.generation
        call.media.testClosesLocalMedia = { kind in kind == "video" }
        call.calls.hold("closeLocalMedia(video)")
        call.closeLocalCamera(adminEnforced: true)
        #expect(await settle { call.calls.isHolding("closeLocalMedia(video)") })
        let startsBefore = call.calls.count("startProducingVideo", inGeneration: session)
        call.media.onLocalVideoProducerLost?()
        #expect(await settle { call.calls.count("startProducingVideo", inGeneration: session) == startsBefore + 1 })
        #expect(call.media.hasLocalVideoProducer)
        #expect(!call.viewModel.state.isCameraOff)

        call.calls.release("closeLocalMedia(video)")
        #expect(await call.releasedCallsReturned())
        #expect(call.media.hasLocalVideoProducer)
        #expect(!call.viewModel.state.isCameraOff)

        call.deliverAdminCameraOff()
        #expect(await settle { call.endedToggleCount("applyLocalCameraOffStateFromServer") == 1 })
        #expect(call.calls.count("closeLocalMedia(video)", inGeneration: session) == 2)
        #expect(!call.media.hasLocalVideoProducer)
        #expect(call.viewModel.state.isCameraOff)
        await call.finish()
    }

    /// A server camera-off closes the camera on a later hop. A camera-on the
    /// user tapped before that hop ran is newer: the hop closes nothing, so it
    /// can neither close the camera nor cancel that camera-on.
    @Test
    func aServerCameraOffHopNeverClosesTheCameraOfACameraOnTappedBeforeItRan() async {
        let call = RejoinHarness()
        #expect(await call.join(cameraOff: false))
        let session = call.generation
        call.media.testClosesLocalMedia = { kind in kind == "video" }
        call.calls.hold("setVideoEnabled(true)")
        // The camera-off reaches the UI, and the user taps camera-on before
        // its close hop has run.
        call.viewModel.testApplyServerCameraOff()
        #expect(call.viewModel.state.isCameraOff)
        call.viewModel.toggleCamera()
        #expect(!call.viewModel.state.isCameraOff)
        #expect(call.endedToggleCount("applyLocalCameraOffStateFromServer") == 0)

        #expect(await settle { call.endedToggleCount("applyLocalCameraOffStateFromServer") == 1 })
        #expect(await settle { call.calls.isHolding("setVideoEnabled(true)") })
        call.calls.release("setVideoEnabled(true)")
        #expect(await settle { call.endedToggleCount("toggleCamera") == 1 })
        #expect(call.calls.count("closeLocalMedia(video)", inGeneration: session) == 0)
        #expect(call.media.hasLocalVideoProducer)
        #expect(!call.viewModel.state.isCameraOff)
        await call.finish()
    }

    /// Review round 5 (W1): the camera half of issue 4. A snapshot that says
    /// camera off, taken before the user's camera-on reached the SFU, lands
    /// while that camera-on awaits its start and must not cancel it.
    @Test
    func anAdminRoomSnapshotNeverOverridesACameraOnInFlight() async throws {
        let call = RejoinHarness()
        #expect(await call.join())
        let session = call.generation
        call.calls.hold("startProducingVideo")
        call.viewModel.toggleCamera()
        #expect(!call.viewModel.state.isCameraOff)
        #expect(await settle { call.calls.isHolding("startProducingVideo") })

        try call.deliverAdminRoomSnapshot(localCameraOff: true)
        #expect(await settle { call.viewModel.state.hasInitialPresenceSnapshot })
        #expect(!call.viewModel.state.isCameraOff)
        call.calls.release("startProducingVideo")
        #expect(await settle { call.endedToggleCount("toggleCamera") == 1 })
        #expect(call.calls.count("closeLocalVideoProducer", inGeneration: session) == 0)
        #expect(call.media.hasLocalVideoProducer)
        #expect(!call.viewModel.state.isCameraOff)
        await call.finish()
    }

    /// Codex round 3 (b) and review round 4 (issue 2), in the SFU's real
    /// order: the host stops the user's screen share while a camera-on awaits
    /// its start. The plain close removes the screen producer first, so
    /// admin:producerClosed finds nothing to classify; it records no
    /// camera-off, and the camera-on still commits.
    @Test
    func anAdminScreenShareCloseNeverCancelsAPendingCameraOn() async {
        let call = RejoinHarness()
        #expect(await call.join())
        let session = call.generation
        call.viewModel.state.isScreenSharing = true
        call.calls.hold("startProducingVideo")
        call.viewModel.toggleCamera()
        #expect(await settle { call.calls.isHolding("startProducingVideo") })

        call.media.testClosesLocalMedia = call.closesLocalProducerOnce("screen")
        call.closeLocalProducer("local-screen")
        #expect(await settle { !call.viewModel.state.isScreenSharing })
        #expect(await call.deliverAdminCloseEvents(producerId: "local-screen", kind: "video", type: "screen"))
        call.calls.release("startProducingVideo")
        #expect(await settle { call.endedToggleCount("toggleCamera") == 1 })
        #expect(call.calls.count("closeLocalVideoProducer", inGeneration: session) == 0)
        #expect(call.media.hasLocalVideoProducer)
        #expect(!call.viewModel.state.isCameraOff)
        await call.finish()
    }

    /// Codex round 3 (R2-3): an admin camera enforcement whose producer id
    /// matches no installed camera (the acknowledgement of a newer camera
    /// overtook the enforcement event) closes the installed camera and tells
    /// the SFU, rather than leaving a paused producer registered.
    @Test
    func anAdminCameraEnforcementClosesAnUnlistedInstalledCameraAndTellsTheSFU() async {
        let call = RejoinHarness()
        #expect(await call.join(cameraOff: false))
        let session = call.generation
        #expect(call.media.hasLocalVideoProducer)

        #expect(await call.viewModel.closeAdminEnforcedProducer(
            AdminMediaProducer(producerId: "enforced-earlier", kind: "video", type: "webcam")
        ))
        #expect(call.calls.count("closeLocalVideoProducer", inGeneration: session) == 1)
        #expect(call.calls.count("suspendLocalVideoForRecovery", inGeneration: session) == 0)
        #expect(!call.media.hasLocalVideoProducer)
        #expect(call.viewModel.state.isCameraOff)
        await call.finish()
    }

    /// Residual 4: a camera-off that lands while the periodic publishing
    /// reassert is starting the camera wins over that reassert.
    @Test
    func cameraOffDuringAPublishingReassertWins() async {
        let call = RejoinHarness()
        #expect(await call.join(cameraOff: false))
        let session = call.generation
        call.media.testReportsLocalVideoState = true
        // The camera producer was lost; the reassert restarts it.
        call.media.hasLocalVideoProducer = false
        call.calls.hold("startProducingVideo")
        call.media.onLocalVideoProducerLost?()
        #expect(await settle { call.calls.isHolding("startProducingVideo") })

        call.viewModel.toggleCamera()
        #expect(call.viewModel.state.isCameraOff)
        #expect(await settle { call.endedToggleCount("toggleCamera") == 1 })
        call.calls.release("startProducingVideo")
        #expect(await settle { call.calls.count("closeLocalVideoProducer", inGeneration: session) == 2 })
        #expect(!call.media.hasLocalVideoProducer)
        #expect(await call.reportsHandled())
        #expect(call.viewModel.state.isCameraOff)
        await call.finish()
    }

    /// Residual 4: chat `/camera on` honors audio-only mode, including a
    /// switch to it that lands while the command's camera start awaits.
    @Test
    func chatCameraOnYieldsToAudioOnlyModeThatLandsDuringItsStart() async throws {
        let cameraOn = try #require(ChatCommandParser.parse("/camera on"))
        let call = RejoinHarness()
        #expect(await call.join())
        call.calls.hold("startProducingVideo")
        call.viewModel.executeChatCommand(cameraOn)
        #expect(await settle { call.calls.isHolding("startProducingVideo") })
        #expect(!call.viewModel.state.isCameraOff)

        call.viewModel.setAudioOnlyMode(true)
        #expect(call.viewModel.state.isCameraOff)
        call.calls.release("startProducingVideo")
        #expect(await settle { call.endedToggleCount("setCameraOff") == 1 })
        #expect(!call.media.hasLocalVideoProducer)
        #expect(call.viewModel.state.isCameraOff)

        // In audio-only mode the command starts no camera at all.
        let startsBefore = call.calls.count("startProducingVideo")
        let messagesBefore = call.viewModel.state.systemMessages.count
        call.viewModel.executeChatCommand(cameraOn)
        #expect(await settle { call.viewModel.state.systemMessages.count == messagesBefore + 1 })
        #expect(call.calls.count("startProducingVideo") == startsBefore)
        #expect(call.viewModel.state.isCameraOff)
        await call.finish()
    }

    /// Residual 4: the SFU closed the camera producer and the view model
    /// restarts it. A switch to audio-only mode that lands during that
    /// restart wins over it. (While a restart runs, the close already reported
    /// the camera off, so audio-only mode has no producer to close itself.)
    @Test
    func audioOnlyModeDuringTheProducerClosedRestartWins() async {
        let call = RejoinHarness()
        #expect(await call.join(cameraOff: false))
        let session = call.generation
        call.media.testReportsLocalVideoState = true
        call.media.testClosesLocalMedia = { kind in kind == "video" }
        call.calls.hold("startProducingVideo")
        call.closeLocalCamera()
        #expect(await settle { call.calls.isHolding("startProducingVideo") })
        #expect(await settle { call.viewModel.state.isCameraOff })

        call.viewModel.setAudioOnlyMode(true)
        call.calls.release("startProducingVideo")
        #expect(await settle { call.calls.count("closeLocalVideoProducer", inGeneration: session) == 1 })
        #expect(!call.media.hasLocalVideoProducer)
        #expect(await call.reportsHandled())
        #expect(call.viewModel.state.isCameraOff)
        await call.finish()
    }

    /// The user's camera-off is never dropped behind a camera-on that awaits
    /// its acknowledgement: it applies at once, and the camera-on closes what
    /// it started instead of turning the camera back on.
    @Test
    func cameraOffWhileACameraOnAwaitsItsAcknowledgementWins() async {
        let call = RejoinHarness()
        #expect(await call.join())
        let session = call.generation
        call.calls.hold("startProducingVideo")
        call.viewModel.toggleCamera()
        #expect(!call.viewModel.state.isCameraOff)
        #expect(await settle { call.calls.isHolding("startProducingVideo") })

        call.viewModel.toggleCamera()
        #expect(call.viewModel.state.isCameraOff)
        #expect(await settle { call.calls.count("closeLocalVideoProducer", inGeneration: session) == 1 })
        call.calls.release("startProducingVideo")
        #expect(await settle { call.endedToggleCount("toggleCamera") == 1 })
        #expect(call.calls.count("closeLocalVideoProducer", inGeneration: session) == 2)
        #expect(!call.media.hasLocalVideoProducer)
        #expect(call.viewModel.state.isCameraOff)
        #expect(call.viewModel.state.errorMessage == nil)
        await call.finish()
    }

    /// P1: a CallKit mute that lands while an in-app unmute awaits its
    /// acknowledgement is applied at once. The unmute's acknowledgement is
    /// then discarded: no confirmation, the microphone ends muted, and the
    /// state the system surfaces read stays muted.
    @Test
    func callKitMuteWhileAnUnmuteAwaitsItsAcknowledgementWins() async {
        let call = RejoinHarness()
        call.media.testModelsLocalAudioState = true
        #expect(await call.joinWithPausedMicrophone())
        let session = call.generation
        call.calls.hold("setAudioEnabled(true)")
        call.viewModel.toggleMute()
        #expect(!call.viewModel.state.isMuted)
        #expect(await settle { call.calls.isHolding("setAudioEnabled(true)") })

        CallSessionCoordinator.shared.register(call.viewModel)
        CallSessionCoordinator.shared.setMuted(true)
        #expect(call.viewModel.state.isMuted)
        #expect(CallSessionCoordinator.shared.isMuted)
        // The local mute reached the media session before the acknowledgement.
        #expect(call.calls.count("suspendLocalAudioForRecovery", inGeneration: session) == 1)
        #expect(await settle { call.calls.count("setAudioEnabled(false)", inGeneration: session) == 2 })

        call.calls.release("setAudioEnabled(true)")
        #expect(await settle { call.endedToggleCount("toggleMute") == 2 })
        #expect(await call.reportsHandled())
        #expect(call.calls.count("reassertLocalAudioProducerUnmuted") == 0)
        #expect(call.viewModel.state.isMuted)
        #expect(CallSessionCoordinator.shared.isMuted)
        #expect(!call.media.isLocalAudioPublishingHealthy)
        #expect(call.viewModel.state.errorMessage == nil)

        // The guard is free again once the applied mute's signal finished.
        #expect(await settle { call.endedToggleCount("applyLocalMuteNow") == 1 })
        call.viewModel.toggleMute()
        #expect(!call.viewModel.state.isMuted)
        #expect(await settle { call.endedToggleCount("toggleMute") == 3 })
        #expect(call.media.isLocalAudioPublishingHealthy)
        await call.finish()
    }

    /// P1 at its tightest: the unmute's acknowledgement has already arrived
    /// (its continuation is queued) when the CallKit mute lands. The local
    /// mute is synchronous, so that continuation finds the newer mute and the
    /// microphone never goes live, not even briefly.
    @Test
    func callKitMuteRightAfterTheUnmuteAcknowledgementArrivedNeverGoesLive() async {
        let call = RejoinHarness()
        call.media.testModelsLocalAudioState = true
        #expect(await call.joinWithPausedMicrophone())
        call.calls.hold("setAudioEnabled(true)")
        call.viewModel.toggleMute()
        #expect(await settle { call.calls.isHolding("setAudioEnabled(true)") })
        CallSessionCoordinator.shared.register(call.viewModel)
        let liveCommitsBefore = call.calls.count("microphoneLive")

        call.calls.release("setAudioEnabled(true)")
        CallSessionCoordinator.shared.setMuted(true)
        #expect(await settle { call.endedToggleCount("toggleMute") == 2 })
        #expect(await call.reportsHandled())
        #expect(call.calls.count("microphoneLive") == liveCommitsBefore)
        #expect(call.viewModel.state.isMuted)
        #expect(!call.media.isLocalAudioPublishingHealthy)
        #expect(call.calls.count("reassertLocalAudioProducerUnmuted") == 0)
        await call.finish()
    }

    /// Codex round 1 (C5): a mute applied over a pending unmute owns the
    /// microphone guard until its own signal completes, so a newer unmute can
    /// never overlap it (both clients would let the older mute's late
    /// completion silence that unmute).
    @Test
    func anUnmuteWhileAnAppliedMuteAwaitsItsSignalIsIgnored() async {
        let call = RejoinHarness()
        call.media.testModelsLocalAudioState = true
        #expect(await call.joinWithPausedMicrophone())
        call.calls.hold("setAudioEnabled(true)")
        call.viewModel.toggleMute()
        #expect(await settle { call.calls.isHolding("setAudioEnabled(true)") })
        call.calls.hold("setAudioEnabled(false)")
        CallSessionCoordinator.shared.register(call.viewModel)
        CallSessionCoordinator.shared.setMuted(true)
        #expect(await settle { call.calls.isHolding("setAudioEnabled(false)") })

        call.calls.release("setAudioEnabled(true)")
        #expect(await settle { call.endedToggleCount("toggleMute") == 2 })
        // The applied mute still awaits its acknowledgement: unmute is ignored.
        call.viewModel.toggleMute()
        #expect(call.viewModel.state.isMuted)
        #expect(call.calls.count("setAudioEnabled(true)") == 1)

        call.calls.release("setAudioEnabled(false)")
        #expect(await settle { call.endedToggleCount("applyLocalMuteNow") == 1 })
        call.viewModel.toggleMute()
        #expect(!call.viewModel.state.isMuted)
        #expect(await settle { call.endedToggleCount("toggleMute") == 3 })
        #expect(call.calls.count("setAudioEnabled(true)") == 2)
        #expect(call.media.isLocalAudioPublishingHealthy)
        await call.finish()
    }

    /// A discarded unmute whose microphone start then fails reports no error:
    /// the newer mute stands.
    @Test
    func aDiscardedUnmuteWhoseMicrophoneStartFailsReportsNoError() async {
        let call = RejoinHarness()
        call.media.testModelsLocalAudioState = true
        #expect(await call.join())
        call.calls.hold("startProducingAudio")
        call.viewModel.toggleMute()
        #expect(await settle { call.calls.isHolding("startProducingAudio") })
        CallSessionCoordinator.shared.register(call.viewModel)
        CallSessionCoordinator.shared.setMuted(true)
        #expect(call.viewModel.state.isMuted)

        call.calls.fail("startProducingAudio", with: StubMediaError("Microphone capture failed"))
        #expect(await settle { call.endedToggleCount("toggleMute") == 1 })
        #expect(call.viewModel.state.isMuted)
        #expect(call.viewModel.state.errorMessage == nil)
        await call.finish()
    }

    /// A superseded camera-on whose start then fails reports no error: the
    /// newer camera-off stands.
    @Test
    func aSupersededCameraOnWhoseStartFailsReportsNoError() async {
        let call = RejoinHarness()
        #expect(await call.join())
        call.calls.hold("startProducingVideo")
        call.viewModel.toggleCamera()
        #expect(await settle { call.calls.isHolding("startProducingVideo") })
        call.viewModel.toggleCamera()
        #expect(call.viewModel.state.isCameraOff)

        call.calls.fail("startProducingVideo", with: StubMediaError("Camera capture failed"))
        #expect(await settle { call.endedToggleCount("toggleCamera") == 1 })
        #expect(call.viewModel.state.isCameraOff)
        #expect(call.viewModel.state.errorMessage == nil)
        await call.finish()
    }

    /// P1, the Android notification and PiP entry point (a plain toggle),
    /// while the unmute is still starting the microphone.
    @Test
    func notificationMuteWhileAnUnmuteStartsTheMicrophoneWins() async {
        let call = RejoinHarness()
        call.media.testModelsLocalAudioState = true
        #expect(await call.join())
        call.calls.hold("startProducingAudio")
        call.viewModel.toggleMute()
        #expect(!call.viewModel.state.isMuted)
        #expect(await settle { call.calls.isHolding("startProducingAudio") })

        CallSessionCoordinator.shared.register(call.viewModel)
        #expect(CallSessionCoordinator.shared.toggleMute())
        #expect(call.viewModel.state.isMuted)
        #expect(call.calls.count("suspendLocalAudioForRecovery") >= 1)

        call.calls.release("startProducingAudio")
        #expect(await settle { call.endedToggleCount("toggleMute") == 1 })
        #expect(await call.reportsHandled())
        #expect(call.calls.count("reassertLocalAudioProducerUnmuted") == 0)
        #expect(call.viewModel.state.isMuted)
        #expect(!call.media.isLocalAudioPublishingHealthy)
        #expect(call.viewModel.state.errorMessage == nil)
        await call.finish()
    }

    /// P3: an admin mute that lands while an unmute awaits its acknowledgement
    /// is applied to the microphone, not only the UI, and the unmute's
    /// acknowledgement does not undo it.
    @Test
    func adminMuteWhileAnUnmuteAwaitsItsAcknowledgementIsAppliedToTheMicrophone() async {
        let call = RejoinHarness()
        call.media.testModelsLocalAudioState = true
        #expect(await call.joinWithPausedMicrophone())
        let session = call.generation
        call.calls.hold("setAudioEnabled(true)")
        call.viewModel.toggleMute()
        #expect(await settle { call.calls.isHolding("setAudioEnabled(true)") })

        call.deliverAdminMute()
        #expect(await settle { call.viewModel.state.isMuted })
        #expect(await settle { call.calls.count("suspendLocalAudioForRecovery", inGeneration: session) == 1 })
        #expect(await settle { call.calls.count("setAudioEnabled(false)", inGeneration: session) == 2 })

        call.calls.release("setAudioEnabled(true)")
        #expect(await settle { call.endedToggleCount("toggleMute") == 2 })
        #expect(await call.reportsHandled())
        #expect(call.calls.count("reassertLocalAudioProducerUnmuted") == 0)
        #expect(call.viewModel.state.isMuted)
        #expect(!call.media.isLocalAudioPublishingHealthy)
        #expect(call.viewModel.state.errorMessage == nil)
        await call.finish()
    }

    /// The camera twin of P3: an admin camera-off that lands while a
    /// camera-on awaits its acknowledgement closes the camera, and the
    /// camera-on does not turn it back on.
    @Test
    func adminCameraOffWhileACameraOnAwaitsItsAcknowledgementIsAppliedToTheCamera() async {
        let call = RejoinHarness()
        #expect(await call.joinWithPausedCameraProducer())
        let session = call.generation
        call.media.testClosesLocalMedia = { kind in kind == "video" }
        call.calls.hold("setVideoEnabled(true)")
        call.viewModel.toggleCamera()
        #expect(!call.viewModel.state.isCameraOff)
        #expect(await settle { call.calls.isHolding("setVideoEnabled(true)") })

        call.deliverAdminCameraOff()
        #expect(await settle { call.viewModel.state.isCameraOff })
        #expect(await settle { call.calls.count("closeLocalMedia(video)", inGeneration: session) == 1 })
        #expect(!call.media.hasLocalVideoProducer)

        call.calls.release("setVideoEnabled(true)")
        #expect(await settle { call.endedToggleCount("toggleCamera") == 1 })
        #expect(!call.media.hasLocalVideoProducer)
        #expect(call.viewModel.state.isCameraOff)
        #expect(call.viewModel.state.errorMessage == nil)
        await call.finish()
    }

    /// Item 5 (F7 class): a rejoin that lands while a camera switch awaits
    /// must not strand the switch guard.
    @Test
    func rejoinFreesTheCameraSwitchGuardWhileTheOrphanedSwitchIsSuspended() async {
        let call = RejoinHarness()
        call.media.testCanSwitchCamera = true
        #expect(await call.join(cameraOff: false))
        call.calls.hold("switchCamera")
        call.viewModel.switchLocalCamera()
        #expect(await settle { call.calls.isHolding("switchCamera") })
        #expect(!call.viewModel.canSwitchLocalCamera())

        #expect(await call.rejoin())
        let recovered = call.generation
        await call.land()
        #expect(call.viewModel.canSwitchLocalCamera())
        call.viewModel.switchLocalCamera()
        #expect(await settle { call.calls.count("switchCamera", inGeneration: recovered) == 1 })

        #expect(await settle { call.endedToggleCount("switchLocalCamera") == 1 })
        #expect(call.viewModel.canSwitchLocalCamera())

        // The orphaned switch returns late without any media call, and its
        // completion frees no newer switch's guard.
        call.calls.hold("switchCamera")
        call.viewModel.switchLocalCamera()
        #expect(await settle { call.calls.heldCount("switchCamera") == 2 })
        let callsBefore = call.calls.totalCount
        call.calls.release("switchCamera")
        #expect(await settle { call.endedToggleCount("switchLocalCamera") == 2 })
        #expect(call.calls.totalCount == callsBefore)
        #expect(!call.viewModel.canSwitchLocalCamera())
        call.calls.release("switchCamera")
        #expect(await settle { call.endedToggleCount("switchLocalCamera") == 3 })
        #expect(call.viewModel.canSwitchLocalCamera())
        await call.finish()
    }

    /// Item 5 (F7 class): a rejoin that lands while a screen-share toggle
    /// awaits must not strand the screen-share guard. Host builds have no
    /// screen capture, so their toggle holds its guard across one stub call;
    /// the iOS and Android branches are pinned by
    /// `ConclaveTests.testNativeCallCorrectnessBlockersStayFixed`.
    @Test
    func rejoinFreesTheScreenShareGuardWhileTheOrphanedToggleIsSuspended() async {
        let call = RejoinHarness()
        #expect(await call.join())
        call.calls.hold("screenShare")
        call.viewModel.toggleScreenShare()
        #expect(await settle { call.calls.isHolding("screenShare") })
        // A second tap while it is in flight is ignored: it returns before
        // creating a task (the barrier would let such a task run first).
        call.viewModel.toggleScreenShare()
        await mainActorBarrier()
        #expect(call.calls.count("screenShare") == 1)

        #expect(await call.rejoin())
        let recovered = call.generation
        await call.land()
        call.viewModel.toggleScreenShare()
        #expect(await settle { call.calls.count("screenShare", inGeneration: recovered) == 1 })
        #expect(await settle { call.endedToggleCount("toggleScreenShare") == 1 })

        // The orphan's completion frees no newer toggle's guard.
        call.calls.hold("screenShare")
        call.viewModel.toggleScreenShare()
        #expect(await settle { call.calls.heldCount("screenShare") == 2 })
        call.calls.release("screenShare")
        #expect(await settle { call.endedToggleCount("toggleScreenShare") == 2 })
        call.viewModel.toggleScreenShare()
        await mainActorBarrier()
        #expect(call.calls.count("screenShare", inGeneration: recovered) == 2)
        call.calls.release("screenShare")
        #expect(await settle { call.endedToggleCount("toggleScreenShare") == 3 })
        call.viewModel.toggleScreenShare()
        #expect(await settle { call.calls.count("screenShare", inGeneration: recovered) == 3 })
        #expect(await settle { call.endedToggleCount("toggleScreenShare") == 4 })
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
    private var handledReports = 0

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
        media.testCallLog = { [weak media] name in
            calls.record(name, generation: media?.configurationGeneration ?? -1)
        }
        viewModel.testLocalToggleEnded = { [weak self] kind in
            self?.endedToggles.append(kind)
        }
        viewModel.testLocalMediaReportHandled = { [weak self] in
            self?.handledReports += 1
        }
        // Media from an earlier attempt reports configured, so every join
        // task (planned or not) first tears it down, and that teardown is held
        // until finish() has retired the attempt: no join task can reach the
        // network join fetch. The view model's own cleanup() is not held.
        media.isConfigured = true
        calls.holdEvery(Self.joinTeardown)
    }

    /// Waits until the view model has handled every local microphone and
    /// camera state report the stub made (each is handled on a later hop).
    func reportsHandled() async -> Bool {
        await settle { self.handledReports == self.media.testLocalMediaReportCount }
    }

    /// Toggles of this kind (the view model function that took the guard, or
    /// that deferred a server camera-off to a later hop) whose task has
    /// finished.
    func endedToggleCount(_ kind: String) -> Int {
        endedToggles.filter { $0 == kind }.count
    }

    /// Waits until every held call a test released has returned to its
    /// caller (each caller then runs on to its next await or its end).
    func releasedCallsReturned() async -> Bool {
        await settle { self.calls.outstandingCount == self.calls.heldTotal }
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
    /// was on, and a camera-off on the reconnecting screen paused (did not
    /// close) the producer the recovered attempt had already published before
    /// that attempt reached `.joined`. The harness flips the connection state
    /// by hand to reach that state.
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

    /// A joined call whose microphone producer exists but is paused: it
    /// joined unmuted, then muted.
    func joinWithPausedMicrophone() async -> Bool {
        guard await join(muted: false), media.hasLocalAudioProducer else { return false }
        viewModel.toggleMute()
        guard viewModel.state.isMuted,
              await settle({ self.endedToggleCount("toggleMute") == 1 }),
              await reportsHandled(),
              viewModel.state.isMuted else { return false }
        return media.hasLocalAudioProducer
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
        markJoined()
        // A start's state report is handled on a later hop: let it land
        // before the test taps anything.
        #expect(await reportsHandled(), "a local state report was never handled")
    }

    /// What `handleJoinedRoomResponse` does after its remote consumes: the
    /// attempt is joined and recovery ends.
    func markJoined() {
        viewModel.state.connectionState = .joined
        viewModel.state.isRecoveringConnection = false
        viewModel.isRejoinInFlight = false
    }

    /// The admin control plane's mute of the local participant (it reaches
    /// the target too; a user's own toggles are never echoed to them).
    func deliverAdminMute() {
        viewModel.socketManager.onParticipantMuted?(ParticipantMutedNotification(
            userId: viewModel.state.userId,
            muted: true,
            roomId: "room-a"
        ))
    }

    func deliverAdminCameraOff() {
        viewModel.socketManager.onParticipantCameraOff?(ParticipantCameraOffNotification(
            userId: viewModel.state.userId,
            cameraOff: true,
            roomId: "room-a"
        ))
    }

    func closeLocalCamera(adminEnforced: Bool? = nil) {
        viewModel.socketManager.onProducerClosed?(ProducerClosedNotification(
            producerId: "local-camera",
            producerUserId: nil,
            roomId: "room-a",
            adminEnforced: adminEnforced
        ))
    }

    func closeLocalMicrophone() {
        closeLocalProducer("local-microphone")
    }

    /// A producerClosed for one of the local producers: plain (the SFU closed
    /// it, which for an admin close reaches the owner first), or admin-flagged
    /// (admin:producerClosed).
    func closeLocalProducer(_ producerId: String, adminEnforced: Bool? = nil) {
        viewModel.socketManager.onProducerClosed?(ProducerClosedNotification(
            producerId: producerId,
            producerUserId: nil,
            roomId: "room-a",
            adminEnforced: adminEnforced
        ))
    }

    /// A stub close seam that finds a local producer of this kind ("audio",
    /// "video" or "screen") once, as both clients do: the first close removes
    /// it, so a later close of the same id finds nothing.
    func closesLocalProducerOnce(_ kind: String) -> (@MainActor (String) -> Bool) {
        var installed = true
        return { name in
            guard installed, name == kind else { return false }
            installed = false
            return true
        }
    }

    /// What the owner receives after the producer's own close (the plain
    /// producerClosed) when an admin closes it (closeClientProducers in
    /// packages/sfu/server/admin/controlPlane.ts): admin:producerClosed for
    /// the same id, participantMuted or participantCameraOff for a microphone
    /// or camera, then admin:mediaEnforced. Each is delivered once the one
    /// before it was handled; returns whether all were.
    func deliverAdminCloseEvents(producerId: String, kind: String, type: String) async -> Bool {
        // Its last check, after the microphone and the camera, is the screen.
        let screenChecks = calls.count("closeLocalMedia(screen)")
        closeLocalProducer(producerId, adminEnforced: true)
        guard await settle({ self.calls.count("closeLocalMedia(screen)") == screenChecks + 1 }) else { return false }
        if type == ProducerType.webcam.rawValue {
            let hop = kind == "audio" ? "applyLocalMuteNow" : "applyLocalCameraOffStateFromServer"
            let ended = endedToggleCount(hop)
            if kind == "audio" {
                deliverAdminMute()
            } else {
                deliverAdminCameraOff()
            }
            guard await settle({ self.endedToggleCount(hop) == ended + 1 }) else { return false }
        }
        viewModel.state.errorMessage = nil
        viewModel.socketManager.onAdminMediaEnforced?(AdminMediaEnforcedNotification(
            roomId: "room-a",
            userId: viewModel.state.userId,
            producerId: nil,
            kind: nil,
            type: nil,
            action: "closed",
            reason: nil,
            producers: [AdminMediaProducer(producerId: producerId, kind: kind, type: type)]
        ))
        return await settle { self.viewModel.state.errorMessage != nil }
    }

    /// A host's admin room snapshot that reports the local participant's
    /// microphone or camera state (the SFU derives both from producer state).
    func deliverAdminRoomSnapshot(localMuted: Bool? = nil, localCameraOff: Bool? = nil) throws {
        viewModel.state.hasInitialPresenceSnapshot = false
        var fields = ["\"userId\":\"\(viewModel.state.userId)\""]
        if let localMuted {
            fields.append("\"muted\":\(localMuted)")
        }
        if let localCameraOff {
            fields.append("\"cameraOff\":\(localCameraOff)")
        }
        let participant = "{" + fields.joined(separator: ",") + "}"
        let json = "{\"roomId\":\"room-a\",\"snapshot\":{\"id\":\"room-a\",\"participants\":[\(participant)]}}"
        let notification = try JSONDecoder().decode(AdminRoomStateChangedNotification.self, from: Data(json.utf8))
        viewModel.socketManager.onAdminRoomStateChanged?(notification)
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
        viewModel.testLocalMediaReportHandled = nil
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

    /// Records a synchronous stub call, which cannot be held.
    func record(_ name: String, generation: Int) {
        log.append(LoggedCall(name: name, generation: generation))
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

    /// Calls held now (entered a hold and not yet released).
    var heldTotal: Int {
        held.count
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

/// Returns after every main-actor job queued before this call has run: on
/// Apple platforms the main actor runs on the main dispatch queue, a serial
/// queue that runs its jobs in the order they were queued. Used only to show
/// that a tap queued no task; state assertions wait for named conditions.
@MainActor
private func mainActorBarrier() async {
    await Task { @MainActor in }.value
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
