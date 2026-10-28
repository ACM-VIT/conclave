#if os(macOS) && !SKIP
import Foundation
import Testing
@testable import Conclave

@MainActor
@Suite(.serialized)
struct LocalToggleGuardRecoveryTests {
    @Test func holdPreservesCameraIntentAndResumeWaitsForSuspension() async {
        let call = RejoinHarness()
        #expect(await call.join(cameraOff: false))
        call.media.testReportsLocalVideoState = true
        call.calls.hold("suspendLocalVideoForRecovery")
        call.viewModel.setCameraSuspendedForHold(true)
        #expect(await settle { call.calls.isHolding("suspendLocalVideoForRecovery") })
        #expect(await call.reportsHandled())
        #expect(!call.viewModel.state.isCameraOff)
        let enables = call.calls.count("setVideoEnabled(true)")
        let starts = call.calls.count("startProducingVideo")
        _ = await call.viewModel.startProducing()
        #expect(call.calls.count("startProducingVideo") == starts)
        call.viewModel.setCameraSuspendedForHold(false)
        _ = await call.viewModel.startProducing()
        await Task.yield()
        #expect(call.calls.count("startProducingVideo") == starts)
        #expect(call.calls.count("setVideoEnabled(true)") == enables)
        call.calls.release("suspendLocalVideoForRecovery")
        #expect(await settle { call.calls.count("setVideoEnabled(true)") == enables + 1 })
        #expect(!call.viewModel.state.isCameraOff)
        await call.finish()
    }

    @Test func cameraOffDuringHoldWinsOverResume() async {
        let call = RejoinHarness()
        #expect(await call.join(cameraOff: false))
        call.media.testReportsLocalVideoState = true
        call.calls.hold("suspendLocalVideoForRecovery")
        call.viewModel.setCameraSuspendedForHold(true)
        #expect(await settle { call.calls.isHolding("suspendLocalVideoForRecovery") })
        #expect(await call.reportsHandled())
        call.viewModel.toggleCamera()
        #expect(call.viewModel.state.isCameraOff)
        #expect(await settle { call.calls.count("closeLocalVideoProducer") > 0 })
        let enables = call.calls.count("setVideoEnabled(true)")
        let starts = call.calls.count("startProducingVideo")
        call.viewModel.setCameraSuspendedForHold(false)
        call.calls.release("suspendLocalVideoForRecovery")
        #expect(await call.releasedCallsReturned())
        #expect(await call.reportsHandled())
        #expect(call.viewModel.state.isCameraOff)
        #expect(call.calls.count("setVideoEnabled(true)") == enables)
        #expect(call.calls.count("startProducingVideo") == starts)
        await call.finish()
    }

    @Test func speakerPromotionRetainsTheAttendeeCredentialInTheNextJoin() async throws {
        let call = RejoinHarness()
        #expect(await call.join())
        call.viewModel.state.webinarRole = "attendee"
        let context = try #require(call.viewModel.lastJoinContext)
        call.viewModel.lastJoinContext = MeetingViewModel.JoinContext(
            roomId: context.roomId, displayName: context.displayName, socketDisplayName: context.socketDisplayName,
            isHost: false, joinMode: .webinarAttendee, meetingInviteCode: "meeting-code",
            webinarInviteCode: "retained-attendee-code", clientId: context.clientId, allowRoomCreation: false,
            user: context.user)
        call.viewModel.people.onAcceptStageInvitation?(StageInvitationModel(id: 1, promotedByName: "Host",
            rejoinRoomId: "room-a", session: 1))
        #expect(call.viewModel.isPromotionLobbyOpen)
        call.viewModel.premeeting.onCommand?(.joinAsSpeaker)
        #expect(await settle { call.calls.heldCount("cleanup(notifyLocalState: false)") >= 2 })
        #expect(await settle { call.viewModel.lastJoinContext?.joinMode == .meeting })
        #expect(call.viewModel.lastJoinContext?.webinarInviteCode == "retained-attendee-code")
        #expect(call.viewModel.lastJoinContext?.meetingInviteCode == "meeting-code")
        await call.finish()
    }

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

        #expect(call.calls.count("startProducingAudio", inGeneration: recovered) == 1)
        #expect(call.media.hasLocalAudioProducer)

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

        let callsBefore = call.calls.totalCount
        call.calls.release("startProducingAudio")
        #expect(await settle { call.endedToggleCount("toggleMute") == 3 })
        #expect(call.calls.totalCount == callsBefore)
        #expect(!call.viewModel.state.isMuted)

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

        call.viewModel.toggleCamera()
        #expect(call.viewModel.state.isCameraOff)
        #expect(await settle { call.calls.count("closeLocalVideoProducer", inGeneration: recovered) == 1 })
        #expect(await settle { call.endedToggleCount("toggleCamera") == 1 })
        call.viewModel.toggleCamera()
        #expect(!call.viewModel.state.isCameraOff)
        #expect(await settle { call.calls.count("startProducingVideo", inGeneration: recovered) == 2 })
        #expect(await settle { call.endedToggleCount("toggleCamera") == 2 })

        let callsBefore = call.calls.totalCount
        call.calls.release("startProducingVideo")
        #expect(await settle { call.endedToggleCount("toggleCamera") == 3 })
        #expect(call.calls.totalCount == callsBefore)
        #expect(!call.viewModel.state.isCameraOff)
        #expect(call.media.hasLocalVideoProducer)

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

        call.viewModel.toggleHandRaise()
        #expect(await settle { call.viewModel.state.isHandRaised })
        #expect(call.calls.count("setHandRaised(true)") == 2)
        #expect(await settle { call.endedToggleCount("setHandRaisedState") == 1 })
        call.viewModel.toggleHandRaise()
        #expect(await settle { !call.viewModel.state.isHandRaised })
        #expect(call.calls.count("setHandRaised(false)") == 1)
        #expect(await settle { call.endedToggleCount("setHandRaisedState") == 2 })

        let callsBefore = call.calls.totalCount
        call.calls.release("setHandRaised(true)")
        #expect(await settle { call.endedToggleCount("setHandRaisedState") == 3 })
        #expect(!call.viewModel.state.isHandRaised)
        #expect(call.calls.totalCount == callsBefore)

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

        call.calls.hold("setAudioEnabled(false)")
        call.viewModel.toggleMute()
        #expect(call.viewModel.state.isMuted)
        #expect(await settle { call.calls.isHolding("setAudioEnabled(false)") })

        call.calls.release("startProducingAudio")
        #expect(await settle { call.endedToggleCount("toggleMute") == 1 })
        call.viewModel.toggleMute()
        #expect(call.viewModel.state.isMuted)

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

        #expect(!call.media.hasLocalAudioProducer)
        #expect(call.calls.count("startProducingAudio", inGeneration: recovered) == 0)

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

        CallSessionCoordinator.shared.setMuted(true)
        #expect(call.viewModel.state.isMuted)
        #expect(await settle { call.calls.count("setAudioEnabled(false)", inGeneration: recovered) == 1 })
        #expect(await settle { call.endedToggleCount("toggleMute") == 1 })

        #expect(!CallSessionCoordinator.shared.toggleMute())
        #expect(!call.viewModel.state.isMuted)
        #expect(await settle { call.calls.count("setAudioEnabled(true)", inGeneration: recovered) == 1 })
        #expect(await settle { call.endedToggleCount("toggleMute") == 2 })

        let callsBefore = call.calls.totalCount
        call.calls.release("startProducingAudio")
        #expect(await settle { call.endedToggleCount("toggleMute") == 3 })
        #expect(call.calls.totalCount == callsBefore)
        #expect(!call.viewModel.state.isMuted)

        await call.finish()
    }

    @Test
    func orphanedChatCommandTogglesMakeNoMediaCallInTheRecoveredCall() async throws {

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

        var callsBefore = call.calls.totalCount
        call.calls.release("startProducingAudio")
        #expect(await settle { call.endedToggleCount("setMuted") == 1 })
        #expect(call.calls.totalCount == callsBefore)
        call.viewModel.toggleMute()
        #expect(call.viewModel.state.isMuted)
        #expect(await settle { call.calls.count("setAudioEnabled(false)", inGeneration: recovered) == 1 })
        #expect(await settle { call.endedToggleCount("toggleMute") == 1 })

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

        #expect(call.calls.count("startProducingVideo", inGeneration: recovered) == 1)
        #expect(call.media.hasLocalVideoProducer)

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

        #expect(call.calls.count("startProducingVideo", inGeneration: session) == 2)
        #expect(call.calls.count("closeLocalVideoProducer", inGeneration: session) == 1)
        #expect(call.media.hasLocalVideoProducer)
        #expect(!call.viewModel.state.isCameraOff)
        await call.finish()
    }

    @Test
    func orphanedUnmuteConfirmationThatSucceedsLateMakesNoMediaCallInTheRecoveredCall() async {
        await assertOrphanedUnmuteConfirmationMakesNoMediaCall(lateFailure: nil)
    }

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

        #expect(call.viewModel.state.isMuted)
        #expect(call.viewModel.state.isCameraOff)

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

        call.media.testClosesLocalMedia = { kind in kind == "audio" }
        call.closeLocalMicrophone()
        #expect(await settle { call.calls.count("startProducingAudio", inGeneration: recovered) == 2 })
        await call.finish()
    }

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

        call.markJoined()
        #expect(await settle { call.calls.count("closeLocalVideoProducer", inGeneration: recovered) == 1 })
        #expect(!call.media.hasLocalVideoProducer)
        #expect(call.viewModel.state.isCameraOff)
        await call.finish()
    }

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

    @Test
    func aServerCameraOffHopNeverClosesTheCameraOfACameraOnTappedBeforeItRan() async {
        let call = RejoinHarness()
        #expect(await call.join(cameraOff: false))
        let session = call.generation
        call.media.testClosesLocalMedia = { kind in kind == "video" }
        call.calls.hold("setVideoEnabled(true)")

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

    @Test
    func cameraOffDuringAPublishingReassertWins() async {
        let call = RejoinHarness()
        #expect(await call.join(cameraOff: false))
        let session = call.generation
        call.media.testReportsLocalVideoState = true

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

        let startsBefore = call.calls.count("startProducingVideo")
        let messagesBefore = call.viewModel.state.systemMessages.count
        call.viewModel.executeChatCommand(cameraOn)
        #expect(await settle { call.viewModel.state.systemMessages.count == messagesBefore + 1 })
        #expect(call.calls.count("startProducingVideo") == startsBefore)
        #expect(call.viewModel.state.isCameraOff)
        await call.finish()
    }

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

        #expect(await settle { call.endedToggleCount("applyLocalMuteNow") == 1 })
        call.viewModel.toggleMute()
        #expect(!call.viewModel.state.isMuted)
        #expect(await settle { call.endedToggleCount("toggleMute") == 3 })
        #expect(call.media.isLocalAudioPublishingHealthy)
        await call.finish()
    }

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

    @Test
    func rejoinFreesTheScreenShareGuardWhileTheOrphanedToggleIsSuspended() async {
        let call = RejoinHarness()
        #expect(await call.join())
        call.calls.hold("screenShare")
        call.viewModel.toggleScreenShare()
        #expect(await settle { call.calls.isHolding("screenShare") })

        call.viewModel.toggleScreenShare()
        await mainActorBarrier()
        #expect(call.calls.count("screenShare") == 1)

        #expect(await call.rejoin())
        let recovered = call.generation
        await call.land()
        call.viewModel.toggleScreenShare()
        #expect(await settle { call.calls.count("screenShare", inGeneration: recovered) == 1 })
        #expect(await settle { call.endedToggleCount("toggleScreenShare") == 1 })

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

    private func assertOrphanedUnmuteConfirmationMakesNoMediaCall(lateFailure: Error?) async {
        let call = RejoinHarness()
        #expect(await call.join(muted: false))
        let first = call.generation

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

    @Test
    func systemMuteCommandWhileAnUnmuteIsPendingEndsMutedAndASystemUnmuteFailsClosed() async {
        let call = RejoinHarness()
        call.media.testModelsLocalAudioState = true
        #expect(await call.joinWithPausedMicrophone())
        let session = call.generation
        let presence = call.viewModel.callPresence
        #expect(presence.snapshot.phase == .live)
        let presenceSession = presence.snapshot.presenceSession
        call.calls.hold("setAudioEnabled(true)")
        call.viewModel.toggleMute()
        #expect(!call.viewModel.state.isMuted)
        #expect(await settle { call.calls.isHolding("setAudioEnabled(true)") })
        call.calls.hold("setAudioEnabled(false)")

        #expect(presence.handle(.mute, source: .callKit, presenceSession: presenceSession) == .dispatched)
        #expect(call.viewModel.state.isMuted)
        #expect(presence.snapshot.isMuted)

        #expect(call.calls.count("suspendLocalAudioForRecovery", inGeneration: session) == 1)
        #expect(await settle { call.calls.isHolding("setAudioEnabled(false)") })
        #expect(presence.handle(.unmute, source: .callKit, presenceSession: presenceSession) == .duplicate)
        #expect(call.viewModel.state.isMuted)
        #expect(presence.handle(.mute, source: .callKit, presenceSession: presenceSession) == .alreadyInEffect)
        #expect(presence.handle(.mute, source: .notification, presenceSession: presenceSession + 1) == .stale)

        call.calls.release("setAudioEnabled(true)")
        #expect(await settle { call.endedToggleCount("toggleMute") == 2 })
        call.calls.release("setAudioEnabled(false)")
        #expect(await settle { call.endedToggleCount("applyLocalMuteNow") == 1 })
        #expect(await call.reportsHandled())
        #expect(call.calls.count("reassertLocalAudioProducerUnmuted") == 0)
        #expect(call.viewModel.state.isMuted)
        #expect(call.viewModel.state.errorMessage == nil)
        #expect(presence.commandLog == [
            "mute:callKit:dispatched", "unmute:callKit:duplicate", "mute:callKit:alreadyInEffect", "mute:notification:stale"
        ])
        await call.finish()
    }

    @Test
    func handTicketIsInterruptedByARejoinAndItsLateAcknowledgementIsDropped() async {
        let call = RejoinHarness()
        #expect(await call.join())
        let shell = call.viewModel.shell
        call.calls.hold("setHandRaised(true)")
        #expect(shell.toggleHand() == .dispatched)
        #expect(await settle { call.calls.isHolding("setHandRaised(true)") })
        guard let ticket = shell.ledger.pendingTicket(.hand) else {
            Issue.record("the hand intent took no ticket")
            await call.finish()
            return
        }
        #expect(shell.controls.rows.first { $0.id == "hand" }?.isPending == true)
        #expect(shell.toggleHand() == .duplicate)

        #expect(await call.rejoin())
        #expect(shell.ledger.result(of: ticket.id)?.kind == .interrupted)
        await call.land()
        #expect(shell.controls.rows.first { $0.id == "hand" }?.isPending == false)

        call.calls.release("setHandRaised(true)")
        #expect(await settle { call.endedToggleCount("setHandRaisedState") == 1 })
        #expect(shell.ledger.result(of: ticket.id)?.kind == .interrupted)
        #expect(!call.viewModel.state.isHandRaised)

        #expect(shell.toggleHand() == .dispatched)
        #expect(await settle { call.viewModel.state.isHandRaised })
        #expect(await settle { shell.ledger.pending.isEmpty })
        await call.finish()
    }

    @Test
    func roomSwitchPublishesOneCoherentIdentity() async {
        let call = RejoinHarness()
        #expect(await call.join())
        let shell = call.viewModel.shell
        call.viewModel.state.isAdmin = true
        call.calls.hold("setHandRaised(true)")
        #expect(shell.toggleHand() == .dispatched)
        #expect(await settle { call.calls.isHolding("setHandRaised(true)") })
        shell.requestEndForEveryone(from: MeetingConfirmationInvoker.more)
        #expect(shell.session.confirmation != nil)
        let before = shell.session.identity
        guard let ticket = shell.ledger.pendingTicket(.hand) else {
            Issue.record("the hand intent took no ticket")
            await call.finish()
            return
        }

        var sessions: [MeetingSessionSnapshot] = []
        var rows: [MeetingControlRowsState] = []
        shell.onPublish = { session, controls, _ in
            sessions.append(session)
            rows.append(controls)
        }
        let heldBefore = call.calls.heldCount("cleanup(notifyLocalState: false)")
        call.viewModel.joinRoom(roomId: "room-b", displayName: "Local User", clientId: "test-client")
        shell.onPublish = nil

        var changes = 0
        var last = before
        for session in sessions where session.identity != last {
            changes += 1
            last = session.identity
        }
        #expect(changes == 1)
        let first = sessions.first { $0.identity != before }
        #expect(first?.identity.callSession == before.callSession + 1)
        #expect(first?.identity.attempt == before.attempt + 1)
        #expect(first?.identity.attemptToken.isEmpty == false && first?.identity.attemptToken != before.attemptToken)
        for (index, session) in sessions.enumerated() where session.identity.callSession != before.callSession {
            #expect(session.confirmation == nil)
            #expect(session.outcome == nil)
            #expect(!rows[index].rows.contains { $0.isPending })
        }
        #expect(shell.ledger.result(of: ticket.id)?.kind == .cancelled)
        #expect(shell.feedbackState == MeetingShellFeedbackState(session: before.callSession + 1, token: FeedbackToken.baseline))
        #expect(await settle { call.calls.heldCount("cleanup(notifyLocalState: false)") == heldBefore + 1 })
        await call.finish()
    }

    @Test
    func nativeChatMuteDuringAPendingUnmuteMutesAtOnce() async {
        let call = RejoinHarness()
        #expect(await call.join())
        call.calls.hold("startProducingAudio")
        call.viewModel.toggleMute()
        #expect(await settle { call.calls.isHolding("startProducingAudio") })
        #expect(!call.viewModel.state.isMuted)

        call.viewModel.performChatCommand(ChatCommandRequest.make(.send, text: "/mute", emoji: ChatRouteKind.command.rawValue))
        #expect(await settle { call.viewModel.state.isMuted })

        call.calls.release("startProducingAudio")
        #expect(await settle { call.endedToggleCount("toggleMute") == 1 })
        #expect(call.viewModel.state.isMuted)

        #expect(call.viewModel.state.chatMessages.isEmpty)
        await call.finish()
    }

    @Test
    func inactiveReturnRunsTheLightRefreshAndABackgroundReturnRunsFullRecoveryWithKeyframes() async {
        let call = RejoinHarness()
        call.clearResumeSnapshot()

        call.viewModel.handleAppBecameActive()
        #expect(call.viewModel.lifecycleRefreshCounters.fullRecovery == 1)
        #expect(await call.join())
        call.viewModel.testSeedRemoteVideoProducer(userId: "remote@example.com#remote-session", producerId: "remote-camera")
        let attempts = call.joinAttemptCount

        call.viewModel.handleAppResignedActive()
        call.viewModel.handleAppBecameActive()
        #expect(call.viewModel.lifecycleRefreshCounters.lightRefresh == 1)
        #expect(call.viewModel.lifecycleRefreshCounters.fullRecovery == 1)
        #expect(call.viewModel.lifecycleRefreshCounters.keyframeRequests == 0)
        await mainActorBarrier()
        try? await Task.sleep(for: .milliseconds(100))
        #expect(call.joinAttemptCount == attempts)
        #expect(call.viewModel.state.connectionState == .joined)

        call.viewModel.handleAppResignedActive()
        call.viewModel.handleAppEnteredBackground()
        call.viewModel.handleAppResignedActive()
        call.viewModel.handleAppBecameActive()
        #expect(call.viewModel.lifecycleRefreshCounters.lightRefresh == 1)
        #expect(call.viewModel.lifecycleRefreshCounters.fullRecovery == 2)
        #expect(call.viewModel.lifecycleRefreshCounters.keyframeRequests == 1)

        #expect(await settle { call.joinAttemptCount == attempts + 1 })
        await call.finish()
    }

    @Test
    func scriptedRejoinFailuresPublishAttemptTwoAndRetryNowStartsExactlyOneRejoin() async {
        let call = RejoinHarness()
        #expect(await call.join())
        call.scriptJoinFailures(StubAckTimeout())

        #expect(await call.rejoin())
        call.releaseJoinAttempts()
        #expect(await settle { call.viewModel.makeStageNoticeInputs().reconnectAttempt == 1 })

        #expect(await settle { call.calls.isHolding("cleanup(notifyLocalState: false)") })
        call.releaseJoinAttempts()
        #expect(await settle {
            let inputs = call.viewModel.makeStageNoticeInputs()
            return inputs.reconnectAttempt == 2 && !inputs.isRecoveryAttemptInFlight
        })
        let banner = call.reconnectingBanner()
        #expect(banner?.count == 2)
        #expect(banner?.total == 5)
        #expect(banner?.actions == [NoticeAction.make(NoticeAction.retryRecovery, isEnabled: true)])

        let beforeRetry = call.joinAttemptCount
        call.viewModel.retryRecoveryNow()
        call.viewModel.retryRecoveryNow()
        #expect(call.reconnectingBanner()?.actions == [NoticeAction.make(NoticeAction.retryRecovery, isEnabled: false)])
        #expect(await settle { call.joinAttemptCount == beforeRetry + 1 })
        await mainActorBarrier()
        try? await Task.sleep(for: .milliseconds(100))
        #expect(call.joinAttemptCount == beforeRetry + 1)
        #expect(call.viewModel.makeStageNoticeInputs().reconnectAttempt == 2)

        call.viewModel.retryRecoveryNow()
        await mainActorBarrier()
        try? await Task.sleep(for: .milliseconds(100))
        #expect(call.joinAttemptCount == beforeRetry + 1)
        #expect(call.reconnectingBanner()?.actions == [NoticeAction.make(NoticeAction.retryRecovery, isEnabled: false)])

        call.viewModel.testRunRecoveryWatchdogTick(recoveryAgeSeconds: 30, joinActivityAgeSeconds: 26)
        #expect(await settle { call.joinAttemptCount == beforeRetry + 2 })
        #expect(call.viewModel.makeStageNoticeInputs().reconnectAttempt == 2)

        call.calls.stopHoldingEvery("cleanup(notifyLocalState: false)")
        call.viewModel.testRunRecoveryWatchdogTick(recoveryAgeSeconds: 121, joinActivityAgeSeconds: 1)
        #expect(await settle { call.viewModel.state.terminalOutcome?.kind == .connectionLost })
        #expect(call.viewModel.state.connectionState == .error)
        await call.finish()
    }

    @Test
    func aRejoinThatFindsTheRoomEndedEndsWithTheHostEndedHomeNotice() async {
        let call = RejoinHarness()
        #expect(await call.join())
        call.scriptJoinFailures(StubMediaError("This meeting has ended"))
        #expect(await call.rejoin())
        call.releaseJoinAttempts()
        #expect(await settle { call.viewModel.state.terminalOutcome?.kind == .endedByHost })
        #expect(call.viewModel.state.meetingEndedNoticeMessage != nil)
        #expect(call.viewModel.makeStageNoticeInputs().reconnectAttempt == 0)
        await call.finish()
    }

    @Test
    func thermalEscalationsPostOneToastLowerTheCeilingAndNeverTouchTheSavedQuality() async {
        let call = RejoinHarness()
        #expect(await call.join())
        let savedQuality = call.viewModel.state.videoQuality
        let savedSettings = UserDefaults.standard.string(forKey: NativeMediaQualityPreferences.storageKey)
        func qualityToasts() -> Int {
            call.viewModel.stage.recentEvents.filter { $0.kind == StageEventKind.qualityLowered }.count
        }

        call.viewModel.handleSystemThermalLevel(.serious)
        call.viewModel.handleSystemThermalLevel(.critical)
        #expect(call.viewModel.systemPressure.qualityLoweredToastsPosted == 1)
        #expect(qualityToasts() == 1)
        #expect(call.viewModel.systemPressure.ceiling.thermalSteps == 2)
        #expect(call.viewModel.appliedCameraPublishSettings?.height == 360)
        #expect(call.viewModel.state.videoQuality == savedQuality)
        #expect(UserDefaults.standard.string(forKey: NativeMediaQualityPreferences.storageKey) == savedSettings)

        call.viewModel.handleSystemThermalLevel(.nominal)
        #expect(!call.viewModel.systemDataSaverOn && !call.viewModel.hostQualityCapped)
        #expect(call.viewModel.systemPressure.ceiling == .unconstrained)
        #expect(call.viewModel.appliedCameraPublishSettings
            == NativeMediaQualityPolicy.resolvedCamera(NativeMediaQualityPreferences.load().camera))

        call.viewModel.handleLowPowerModeChanged(true)
        #expect(qualityToasts() == 1)
        #expect(call.viewModel.appliedCameraPublishSettings?.height == 360)
        #expect(call.viewModel.state.videoQuality == savedQuality)
        #expect(UserDefaults.standard.string(forKey: NativeMediaQualityPreferences.storageKey) == savedSettings)
        await call.finish()
    }
}

@MainActor
private final class RejoinHarness {
    private static let resumeKey = "conclave.activeMeetingResume.v1"

    private static let joinTeardown = "cleanup(notifyLocalState: false)"

    let viewModel = MeetingViewModel()
    let calls = HeldStubCalls()
    private let savedResumeSnapshot: Any?
    private var endedToggles: [String] = []
    private var handledReports = 0

    var media: WebRTCClient { viewModel.webRTCClient }

    var generation: Int { media.configurationGeneration }

    init() {
        savedResumeSnapshot = UserDefaults.standard.object(forKey: Self.resumeKey)

        viewModel.testDetachHostNetworkMonitor()
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

        media.isConfigured = true
        calls.holdEvery(Self.joinTeardown)
    }

    func reportsHandled() async -> Bool {
        await settle { self.handledReports == self.media.testLocalMediaReportCount }
    }

    func endedToggleCount(_ kind: String) -> Int {
        endedToggles.filter { $0 == kind }.count
    }

    func releasedCallsReturned() async -> Bool {
        await settle { self.calls.outstandingCount == self.calls.heldTotal }
    }

    func join(muted: Bool = true, cameraOff: Bool = true) async -> Bool {
        viewModel.state.isMuted = muted
        viewModel.state.isCameraOff = cameraOff
        let heldBefore = calls.heldCount(Self.joinTeardown)
        viewModel.joinRoom(roomId: "room-a", displayName: "Local User", clientId: "test-client")
        guard await settle({ self.calls.heldCount(Self.joinTeardown) == heldBefore + 1 }) else { return false }
        await land()
        return true
    }

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

    func joinWithPausedMicrophone() async -> Bool {
        guard await join(muted: false), media.hasLocalAudioProducer else { return false }
        viewModel.toggleMute()
        guard viewModel.state.isMuted,
              await settle({ self.endedToggleCount("toggleMute") == 1 }),
              await reportsHandled(),
              viewModel.state.isMuted else { return false }
        return media.hasLocalAudioProducer
    }

    func rejoin() async -> Bool {
        viewModel.state.connectionState = .reconnecting
        viewModel.state.isRecoveringConnection = true
        viewModel.shouldRejoinAfterReconnect = true
        let heldBefore = calls.heldCount(Self.joinTeardown)
        await viewModel.rejoinIfPossible()
        return await settle { self.calls.heldCount(Self.joinTeardown) == heldBefore + 1 }
    }

    func land() async {
        _ = await viewModel.startProducing()
        markJoined()

        #expect(await reportsHandled(), "a local state report was never handled")
    }

    func markJoined() {
        viewModel.state.connectionState = .joined
        viewModel.state.isRecoveringConnection = false
        viewModel.isRejoinInFlight = false
    }

    var joinAttemptCount: Int { calls.count(Self.joinTeardown) }

    func clearResumeSnapshot() {
        UserDefaults.standard.removeObject(forKey: Self.resumeKey)
    }

    func scriptJoinFailures(_ error: Error) {
        viewModel.testJoinFetch = { throw error }
    }

    func releaseJoinAttempts() {
        while calls.isHolding(Self.joinTeardown) {
            calls.release(Self.joinTeardown)
        }
    }

    func reconnectingBanner() -> MeetingNotice? {
        let banners = MeetingNoticePolicy.bannerCandidates(viewModel.makeStageNoticeInputs(), hostNotice: nil,
                                                           liveNotesEpisode: 0, currentPanel: "",
                                                           platform: NoticePlatform.ios)
        return banners.first { $0.kind == NoticeKind.reconnecting }
    }

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

    func closeLocalProducer(_ producerId: String, adminEnforced: Bool? = nil) {
        viewModel.socketManager.onProducerClosed?(ProducerClosedNotification(
            producerId: producerId,
            producerUserId: nil,
            roomId: "room-a",
            adminEnforced: adminEnforced
        ))
    }

    func closesLocalProducerOnce(_ kind: String) -> (@MainActor (String) -> Bool) {
        var installed = true
        return { name in
            guard installed, name == kind else { return false }
            installed = false
            return true
        }
    }

    func deliverAdminCloseEvents(producerId: String, kind: String, type: String) async -> Bool {

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

    func finish() async {
        calls.clearPendingHolds()
        await viewModel.cleanup()
        calls.stopHoldingEvery(Self.joinTeardown)
        calls.releaseAll()
        let returned = await settle { self.calls.outstandingCount == 0 }
        #expect(returned, "a held stub call never returned to its caller")
        viewModel.testLocalToggleEnded = nil
        viewModel.testLocalMediaReportHandled = nil
        viewModel.testJoinFetch = nil
        if let savedResumeSnapshot {
            UserDefaults.standard.set(savedResumeSnapshot, forKey: Self.resumeKey)
        } else {
            UserDefaults.standard.removeObject(forKey: Self.resumeKey)
        }
    }
}

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

    func hold(_ name: String) {
        pendingHolds.append(name)
    }

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

    var totalCount: Int {
        log.count
    }

    var outstandingCount: Int {
        enteredHolds - returnedCount
    }

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

@MainActor
private func mainActorBarrier() async {
    await Task { @MainActor in }.value
}

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
