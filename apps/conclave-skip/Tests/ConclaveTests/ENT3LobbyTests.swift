#if !SKIP
import Foundation
import Testing
@testable import Conclave

@MainActor
struct ENT3LobbyTests {
    private static let link = "https://conclave.acmvit.in/rose-sora-luffy"

    private func presenter(hooks: ENT3HookRecorder? = nil, guestName: String = "Avery") -> PremeetingPresenter {
        let presenter = PremeetingPresenter()
        presenter.nowMillis = { 1793102400000.0 }
        presenter.presenceIntervalMillis = 5
        presenter.apply(PremeetingInputs.make(accountName: guestName))
        if let hooks {
            presenter.lobbyHooks = hooks.hooks
        }
        return presenter
    }

    private func openLinkLobby(_ presenter: PremeetingPresenter, link: String = ENT3LobbyTests.link) -> Int {
        presenter.handleIncomingURL(link)
        return presenter.path.last?.id ?? -1
    }

    @Test func aLinkLobbyPublishesAllSixSnapshotsForItsRoute() {
        let presenter = presenter()
        let routeId = openLinkLobby(presenter)
        #expect(presenter.lobbyStatus?.routeId == routeId)
        #expect(presenter.lobbyMedia?.routeId == routeId)
        #expect(presenter.lobbyPresence?.routeId == routeId)
        #expect(presenter.lobbyIdentity?.routeId == routeId)
        #expect(presenter.lobbyLink?.routeId == routeId)
        #expect(presenter.lobbyAudio?.routeId == routeId)
        #expect(presenter.lobbyLink?.roomLabel == "rose-sora-luffy")
        #expect(presenter.lobbyLink?.meetingLink == "https://conclave.acmvit.in/rose-sora-luffy")
        #expect(presenter.lobbyLink?.canShare == true)
        #expect(presenter.lobbyIdentity?.guestName == "Avery")
        #expect(presenter.lobbyIdentity?.nameLimit == 40)
        #expect(presenter.lobbyMedia?.micIntentOn == false && presenter.lobbyMedia?.cameraIntentOn == false)
        #expect(presenter.lobbyMedia?.preview == .off)
        #expect(presenter.lobbyMedia?.showsEffects == false, "R31: hidden until an engine publishes .panel")
        #expect(presenter.lobbyStatus?.isPrimaryEnabled == true)

        presenter.setPath([])
        #expect(presenter.lobbyStatus == nil && presenter.lobbyMedia == nil && presenter.lobbyPresence == nil)
        #expect(presenter.lobbyIdentity == nil && presenter.lobbyLink == nil && presenter.lobbyAudio == nil)
    }

    @Test func aRouteOrPermissionChangeRepublishesOnlyItsOwnSnapshot() {
        let presenter = presenter()
        _ = openLinkLobby(presenter)
        let media = presenter.lobbyMedia
        let status = presenter.lobbyStatus
        let identity = presenter.lobbyIdentity
        let link = presenter.lobbyLink
        presenter.applyAudioRoutes(outputs: [AudioRouteOption(id: "bt", kind: .bluetooth, name: "Buds", isConnecting: false)],
                                   currentOutputId: "bt", inputOptions: [], currentInputId: "")
        #expect(presenter.lobbyAudio?.routeKind == "bluetooth" && presenter.lobbyAudio?.routeName == "Buds")
        #expect(presenter.lobbyMedia == media && presenter.lobbyStatus == status)
        #expect(presenter.lobbyIdentity == identity && presenter.lobbyLink == link)
        let audio = presenter.lobbyAudio
        presenter.applyPermissions(microphone: .granted, camera: .denied, canAskAgainMicrophone: false, canAskAgainCamera: false)
        #expect(presenter.lobbyMedia?.preview == .blocked, "the card overlay for a denied camera (S10 7 f)")
        #expect(presenter.lobbyAudio == audio && presenter.lobbyStatus == status && presenter.lobbyLink == link)

        let count = presenter.snapshotPublishCount
        presenter.applyPermissions(microphone: .granted, camera: .denied, canAskAgainMicrophone: false, canAskAgainCamera: false)
        presenter.applyAudioRoutes(outputs: [AudioRouteOption(id: "bt", kind: .bluetooth, name: "Buds", isConnecting: false)],
                                   currentOutputId: "bt", inputOptions: [], currentInputId: "")
        #expect(presenter.snapshotPublishCount == count)
    }

    @Test func thePrimaryNeedsANameForGuestsAndAConnection() {
        let presenter = presenter(guestName: "")
        _ = openLinkLobby(presenter)
        #expect(presenter.lobbyStatus?.isPrimaryEnabled == false)
        #expect(presenter.lobbyStatus?.primaryReason == LobbyPrimaryReason.nameMissingJoin.rawValue)
        presenter.setGuestName("  ")
        #expect(presenter.lobbyStatus?.isPrimaryEnabled == false)
        presenter.setGuestName("Avery Lee")
        #expect(presenter.lobbyStatus?.isPrimaryEnabled == true)
        #expect(presenter.lobbyStatus?.primaryReason == "")
        #expect(presenter.lobbyMedia?.avatarName == "Avery Lee")
        presenter.setGuestName(String(repeating: "a", count: 55))
        #expect(presenter.lobbyIdentity?.guestName.count == DisplayNamePolicy.limit)
        presenter.apply(PremeetingInputs.make(accountName: "", isNetworkOffline: true))
        #expect(presenter.lobbyStatus?.primaryReason == LobbyPrimaryReason.offline.rawValue)
        #expect(presenter.lobbyStatus?.issue == .offline)

        let fresh = self.presenter(guestName: "")
        fresh.newMeeting()
        #expect(fresh.lobbyStatus?.primaryReason == LobbyPrimaryReason.nameMissingStart.rawValue)
        #expect(fresh.lobbyLink?.canShare == false, "S10 Q1: no Share before Start")
        #expect(fresh.lobbyLink?.meetingLink == "")
        #expect(fresh.lobbyPresence?.kind == .hidden, "presence hidden for newMeeting (R49)")

        let signedIn = self.presenter(guestName: "")
        signedIn.apply(PremeetingInputs.make(isSignedIn: true, accountName: "Avery Lee", accountSeed: "u1"))
        _ = openLinkLobby(signedIn)
        #expect(signedIn.lobbyIdentity?.isSignedIn == true)
        #expect(signedIn.lobbyStatus?.isPrimaryEnabled == true)
    }

    @Test func formErrorsAfterAJoinBecomeIssuesAndAStaleOneIsIgnored() {
        let presenter = presenter()

        presenter.apply(PremeetingInputs.make(callSession: 1, notice: .formError, noticeText: "No room found.", accountName: "Avery"))
        _ = openLinkLobby(presenter)
        #expect(presenter.lobbyStatus?.issue == LobbyIssue.none)
        presenter.apply(PremeetingInputs.make(callSession: 2, phase: .entering, roomLabel: "rose-sora-luffy",
                                              currentRoomId: "rose-sora-luffy", accountName: "Avery"))
        presenter.apply(PremeetingInputs.make(callSession: 2, notice: .formError, noticeText: "No room found for this code.",
                                              accountName: "Avery"))
        #expect(presenter.lobbyStatus?.mode == .editing)
        #expect(presenter.lobbyStatus?.issue == .roomNotFound)
        presenter.apply(PremeetingInputs.make(callSession: 3, phase: .entering, roomLabel: "rose-sora-luffy",
                                              currentRoomId: "rose-sora-luffy", accountName: "Avery"))
        presenter.apply(PremeetingInputs.make(callSession: 3, notice: .formError, noticeText: "Meeting invite code required",
                                              accountName: "Avery"))
        #expect(presenter.lobbyIdentity?.needsInviteCode == true)
        #expect(presenter.lobbyIdentity?.inviteCodeInvalid == false)
        presenter.setInviteCode("abc123")
        presenter.apply(PremeetingInputs.make(callSession: 4, phase: .entering, roomLabel: "rose-sora-luffy",
                                              currentRoomId: "rose-sora-luffy", accountName: "Avery"))
        presenter.apply(PremeetingInputs.make(callSession: 4, notice: .formError, noticeText: "Invalid meeting invite code",
                                              accountName: "Avery"))
        #expect(presenter.lobbyIdentity?.needsInviteCode == true)
        #expect(presenter.lobbyIdentity?.inviteCodeInvalid == true)
        presenter.setInviteCode("abc124")
        #expect(presenter.lobbyIdentity?.inviteCodeInvalid == false, "editing the code clears the error")
    }

    @Test func theIssueClassifierMapsTheServerSentences() {
        #expect(LobbyIssuePolicy.classify(formError: "", enteredInviteCode: "") == LobbyFormIssue.none)
        #expect(LobbyIssuePolicy.classify(formError: "No room found.", enteredInviteCode: "").issue == .roomNotFound)
        #expect(LobbyIssuePolicy.classify(formError: "Guests are not allowed in this meeting. Sign in to join.",
                                          enteredInviteCode: "").issue == .signInRequired)
        let required = LobbyIssuePolicy.classify(formError: "This meeting requires an invite code", enteredInviteCode: "")
        #expect(required.issue == .inviteCodeRequired && required.needsInviteCode && !required.inviteCodeInvalid)
        let wrong = LobbyIssuePolicy.classify(formError: "This meeting requires an invite code", enteredInviteCode: "x")
        #expect(wrong.issue == .inviteCodeInvalid && wrong.inviteCodeInvalid)
        #expect(LobbyIssuePolicy.classify(formError: "Your phone has paused Conclave. Turn off Sleep mode.",
                                          enteredInviteCode: "").issue == .appSuspended)
        #expect(LobbyIssuePolicy.classify(formError: "The host locked this meeting.", enteredInviteCode: "").issue == .failedServerText)
    }

    @Test func toggleIntentGoesToTheCoreHookAndAsksForAnUndeterminedPermission() {
        let hooks = ENT3HookRecorder()
        let presenter = presenter(hooks: hooks)
        _ = openLinkLobby(presenter)
        presenter.applyPermissions(microphone: .notDetermined, camera: .granted, canAskAgainMicrophone: true, canAskAgainCamera: true)
        presenter.setMicIntent(true)
        #expect(hooks.permissionRequests == ["microphone"])
        #expect(hooks.intents == ["true:false"], "the intended state shows while the prompt is up (S10 7 c)")

        presenter.apply(PremeetingInputs.make(accountName: "Avery", micIntentOn: true))
        #expect(presenter.lobbyMedia?.micIntentOn == true)
        presenter.permissionRequestFinished(kind: "microphone", granted: false)
        #expect(hooks.intents == ["true:false", "false:false"])

        presenter.applyPermissions(microphone: .denied, camera: .granted, canAskAgainMicrophone: false, canAskAgainCamera: true)
        presenter.apply(PremeetingInputs.make(accountName: "Avery", micIntentOn: false))
        presenter.setMicIntent(true)
        #expect(hooks.intents.count == 2)

        presenter.setCameraIntent(true)
        #expect(hooks.intents.last == "false:true")

        presenter.applyPermissions(microphone: .granted, camera: .unavailable, canAskAgainMicrophone: true, canAskAgainCamera: false)
        presenter.setCameraIntent(true)
        #expect(hooks.intents.count == 3)
    }

    @Test func audioChoicesAreStoredAsThePrejoinIntentOnly() {
        let hooks = ENT3HookRecorder()
        let presenter = presenter(hooks: hooks)
        _ = openLinkLobby(presenter)
        presenter.applyAudioRoutes(
            outputs: [AudioRouteOption(id: "spk", kind: .speaker, name: "Speaker", isConnecting: false),
                      AudioRouteOption(id: "bt", kind: .bluetooth, name: "Buds", isConnecting: false)],
            currentOutputId: "spk",
            inputOptions: [AudioRouteOption(id: "mic", kind: .receiver, name: "iPhone Mic", isConnecting: false),
                           AudioRouteOption(id: "bt-in", kind: .bluetooth, name: "Buds", isConnecting: false)],
            currentInputId: "mic")
        #expect(presenter.lobbyAudio?.showsInputRow == true, "more than one input listed (Q14)")
        presenter.selectAudioOutput(kind: "bluetooth")
        #expect(hooks.routeIntents == ["bluetooth|"])
        #expect(presenter.lobbyAudio?.routeKind == "bluetooth" && presenter.lobbyAudio?.routeName == "Buds")
        presenter.selectAudioInput(id: "bt-in")
        #expect(hooks.routeIntents == ["bluetooth|", "bluetooth|bt-in"])
        #expect(presenter.lobbyAudio?.inputName == "Buds")

        presenter.applyAudioRoutes(outputs: [], currentOutputId: "", inputOptions: [
            AudioRouteOption(id: "mic", kind: .receiver, name: "iPhone Mic", isConnecting: false)], currentInputId: "mic")
        #expect(presenter.lobbyAudio?.showsInputRow == false)
    }

    @Test func joinCarriesTheLinkTargetAndTheTypedValues() {
        let hooks = ENT3HookRecorder()
        let presenter = presenter(hooks: hooks)
        _ = openLinkLobby(presenter, link: "https://conclave.acmvit.in/rose-sora-luffy?meetingInviteCode=abc&clientId=acme")
        presenter.setGuestName("  Avery   Lee ")
        presenter.startOrJoin()
        #expect(hooks.joins.count == 1)
        let request = hooks.joins.first
        #expect(request?.roomId == "rose-sora-luffy")
        #expect(request?.displayName == "Avery Lee")
        #expect(request?.isGuest == true)
        #expect(request?.meetingInviteCode == "abc")
        #expect(request?.clientId == "acme")
        #expect(request?.joinMode == .meeting)
        #expect(request?.isHost == true, "custom tenant: the JoinAdminIntentPolicy admin request")
        #expect(presenter.joinRequestCount == 1)

        #expect(presenter.lobbyLink?.meetingLink == "https://conclave.acmvit.in/rose-sora-luffy?clientId=acme")
    }

    @Test func aDefaultTenantJoinIsNotAHostJoin() {
        let request = LobbyJoinCoordinator.makeRequest(
            target: PremeetingRouteTarget(routeId: 3, kind: .lobby, intent: .join, roomId: "rose-sora-luffy",
                                          title: "rose-sora-luffy", joinMode: .meeting, meetingInviteCode: nil,
                                          webinarInviteCode: nil, clientId: nil, allowRoomCreation: false),
            isSignedIn: false, accountName: "", guestName: "Avery", enteredInviteCode: "typed", needsInviteCode: true,
            resolvedClientId: "conclave", facing: .back)
        #expect(request?.isHost == false)
        #expect(request?.socketDisplayName == nil)
        #expect(request?.meetingInviteCode == "typed")
        #expect(request?.cameraFacing == .back)
        #expect(request?.allowRoomCreation == false)

        #expect(LobbyJoinCoordinator.makeRequest(
            target: PremeetingRouteTarget(routeId: 3, kind: .lobby, intent: .join, roomId: "x", title: "x",
                                          joinMode: .meeting, meetingInviteCode: nil, webinarInviteCode: nil,
                                          clientId: nil, allowRoomCreation: false),
            isSignedIn: false, accountName: "", guestName: " ", enteredInviteCode: "", needsInviteCode: false,
            resolvedClientId: "conclave", facing: .front) == nil)
        let start = LobbyJoinCoordinator.makeRequest(
            target: PremeetingRouteTarget(routeId: 4, kind: .lobby, intent: .newMeeting, roomId: "lily-zoro-iris",
                                          title: "lily-zoro-iris", joinMode: .meeting, meetingInviteCode: nil,
                                          webinarInviteCode: nil, clientId: nil, allowRoomCreation: true),
            isSignedIn: true, accountName: "Avery Lee", guestName: "", enteredInviteCode: "", needsInviteCode: false,
            resolvedClientId: "conclave", facing: .front)
        #expect(start?.isHost == true && start?.allowRoomCreation == true)
        #expect(start?.socketDisplayName == "Avery Lee")
        #expect(start?.isGuest == false)
    }

    @Test func guestRecordsAndUserPayloadsFollowJoinView() {
        let fresh = LobbyJoinCoordinator.guestUser(name: "Avery", existing: nil)
        #expect(fresh.id.hasPrefix("guest-") && fresh.email == fresh.id + "@guest.conclave" && fresh.provider == .guest)
        let kept = LobbyJoinCoordinator.guestUser(name: "Avery Lee",
                                                  existing: AppState.User(id: "guest-1", name: "A", email: "g@x", provider: .guest))
        #expect(kept.id == "guest-1" && kept.email == "g@x" && kept.name == "Avery Lee")
        #expect(LobbyJoinCoordinator.sfuUser(currentUser: nil, displayName: " Avery ") == SfuJoinUser(id: nil, email: nil, name: "Avery"))
        let account = AppState.User(id: "u1", name: "Avery Lee", email: "avery@example.com", provider: .google)
        #expect(LobbyJoinCoordinator.sfuUser(currentUser: account, displayName: "Avery Lee")
                == SfuJoinUser(id: "u1", email: "avery@example.com", name: "Avery Lee"))
        #expect(LobbyJoinCoordinator.accountDisplayName(account, fallback: "x") == "Avery Lee")
    }

    @Test func aBusyFreshCodeIsRegeneratedOnceThenStartUsesTheSecondCode() async {
        let hooks = ENT3HookRecorder()
        hooks.presenceAnswers = [2, 0]
        let presenter = presenter(hooks: hooks)
        var codes = ["rose-sora-luffy", "lily-zoro-iris", "maple-goku-tulip"]

        presenter.generateRoomCode = { codes.isEmpty ? "extra-code-requested" : codes.removeFirst() }
        presenter.newMeeting()
        let routeRoom = presenter.path.last?.roomId
        presenter.startOrJoin()
        #expect(presenter.isStartInFlight)
        #expect(presenter.lobbyStatus?.isPrimaryPending == true)
        #expect(await ent3Settle { hooks.joins.count == 1 })
        #expect(hooks.presenceRooms == ["rose-sora-luffy", "lily-zoro-iris"])
        #expect(hooks.joins.first?.roomId == "lily-zoro-iris")
        #expect(hooks.joins.first?.isHost == true)
        #expect(presenter.lobbyLink?.roomLabel == "lily-zoro-iris", "the title follows the new code")
        #expect(presenter.path.last?.roomId == routeRoom, "the route value never changes under the lobby")
        #expect(!presenter.isStartInFlight)
        #expect(presenter.liveTaskCount == 0)
    }

    @Test func threeBusyCodesStartWithTheThirdOnTheNormalPath() async {
        let hooks = ENT3HookRecorder()
        hooks.presenceAnswers = [3, 1, 4, 9]
        let presenter = presenter(hooks: hooks)
        var codes = ["aloe-aster-bloom", "canna-cedar-clove", "dahl-daisy-erica", "flora-hazel-iris"]
        presenter.generateRoomCode = { codes.isEmpty ? "extra-code-requested" : codes.removeFirst() }
        presenter.newMeeting()
        presenter.startOrJoin()
        #expect(await ent3Settle { hooks.joins.count == 1 })
        #expect(hooks.presenceRooms.count == LobbyCollisionPolicy.maxAttempts)
        #expect(hooks.joins.first?.roomId == "dahl-daisy-erica")
        #expect(LobbyCollisionPolicy.shouldRegenerate(count: nil, attempt: 1) == false, "a failed request counts as free")
        #expect(LobbyCollisionPolicy.shouldRegenerate(count: 2, attempt: 3) == false)
    }

    @Test func presenceReadsTheThreeCountsAndStopsWhenTheLobbyIsPopped() async {
        let hooks = ENT3HookRecorder()
        hooks.presenceAnswers = [0, 1, 3]
        hooks.repeatsLastAnswer = true
        let presenter = presenter(hooks: hooks)
        let routeId = openLinkLobby(presenter)
        #expect(presenter.lobbyPresence?.kind == .checking)
        #expect(presenter.liveTaskCount == 0, "no poll before the lobby is visible")
        presenter.lobbyDidAppear(routeId: routeId)
        #expect(presenter.liveTaskCount == 1)
        #expect(await ent3Settle { presenter.lobbyPresence?.kind == .empty })
        #expect(await ent3Settle { presenter.lobbyPresence?.kind == .count && presenter.lobbyPresence?.count == 1 })
        #expect(await ent3Settle { presenter.lobbyPresence?.count == 3 })
        presenter.setPath([])
        #expect(presenter.liveTaskCount == 0)
        let fetches = presenter.presenceFetchCount
        try? await Task.sleep(nanoseconds: 50_000_000)
        #expect(presenter.presenceFetchCount == fetches, "polling stops when the lobby is popped (6 l6)")

        #expect(LobbyPresencePolicy.kind(hasResult: true, count: nil, intent: .join, mode: .editing) == .hidden)
        #expect(LobbyPresencePolicy.kind(hasResult: true, count: 2, intent: .join, mode: .waiting) == .hidden)
    }

    @Test func presenceStopsOnDisappearAndWhileTheAppIsInactive() async {
        let hooks = ENT3HookRecorder()
        hooks.repeatsLastAnswer = true
        hooks.presenceAnswers = [2]
        let presenter = presenter(hooks: hooks)
        let routeId = openLinkLobby(presenter)
        presenter.lobbyDidAppear(routeId: routeId)
        #expect(presenter.liveTaskCount == 1)
        presenter.apply(PremeetingInputs.make(accountName: "Avery", isAppActive: false))
        #expect(presenter.liveTaskCount == 0)
        presenter.apply(PremeetingInputs.make(accountName: "Avery", isAppActive: true))
        #expect(presenter.liveTaskCount == 1)
        #expect(hooks.refreshCount >= 2, "devices are re-read on appearance and on foreground")
        presenter.lobbyDidDisappear(routeId: routeId)
        #expect(presenter.liveTaskCount == 0)

        presenter.lobbyDidAppear(routeId: routeId)
        presenter.lobbyDidDisappear(routeId: routeId + 99)
        #expect(presenter.liveTaskCount == 1)
        presenter.setPath([])
    }

    @Test func thePreviewRunsOnlyWhileWantedAndIsHandedOffToTheCall() {
        let hooks = ENT3HookRecorder()
        let presenter = presenter(hooks: hooks)
        let routeId = openLinkLobby(presenter)
        presenter.applyPermissions(microphone: .granted, camera: .granted, canAskAgainMicrophone: true, canAskAgainCamera: true)
        presenter.apply(PremeetingInputs.make(accountName: "Avery", cameraIntentOn: true))
        #expect(hooks.previewCalls.isEmpty, "not before the lobby is visible")
        presenter.lobbyDidAppear(routeId: routeId)
        #expect(hooks.previewCalls == ["start:front"])
        presenter.applyPreview(state: .live, sessionId: 1, isFrontCamera: true, interruption: .none)
        #expect(presenter.lobbyMedia?.preview == .live)

        presenter.apply(PremeetingInputs.make(callSession: 1, phase: .entering, roomLabel: "rose-sora-luffy",
                                              currentRoomId: "rose-sora-luffy", accountName: "Avery", cameraIntentOn: true))
        #expect(hooks.previewCalls == ["start:front"])
        presenter.apply(PremeetingInputs.make(callSession: 1, phase: .inCall, roomLabel: "rose-sora-luffy",
                                              hasBeenAdmittedThisSession: true, currentRoomId: "rose-sora-luffy",
                                              accountName: "Avery", cameraIntentOn: true))
        #expect(hooks.previewCalls == ["start:front", "handOff"])

        presenter.apply(PremeetingInputs.make(callSession: 1, phase: .home, hasBeenAdmittedThisSession: true, accountName: "Avery"))
        #expect(hooks.previewCalls == ["start:front", "handOff", "resetLatch"])

        let next = openLinkLobby(presenter)
        presenter.apply(PremeetingInputs.make(accountName: "Avery", cameraIntentOn: true))
        presenter.lobbyDidAppear(routeId: next)
        presenter.apply(PremeetingInputs.make(accountName: "Avery", cameraIntentOn: false))
        #expect(hooks.previewCalls.suffix(2) == ["start:front", "stop"])
    }

    @Test func thePublishLatchKeepsThePreviewOffUntilANewLobby() {
        var machine = LocalPreviewMachine.initial
        machine = LocalPreviewPolicy.next(machine, event: .start)
        #expect(machine.state == .starting && machine.sessionId == 1)
        #expect(LocalPreviewPolicy.mayCapture(machine))
        machine = LocalPreviewPolicy.next(machine, event: .bound)
        #expect(machine.state == .live)
        machine = LocalPreviewPolicy.next(machine, event: .interrupted, interruption: .inUseByAnotherClient)
        #expect(machine.state == .interrupted && machine.interruption == .inUseByAnotherClient)
        machine = LocalPreviewPolicy.next(machine, event: .interruptionEnded)
        #expect(machine.state == .live && machine.interruption == PreviewInterruption.none)
        machine = LocalPreviewPolicy.next(machine, event: .handOff)
        #expect(machine.state == .published && machine.isLatched)
        #expect(!LocalPreviewPolicy.mayCapture(machine), "no capture while the call owns the camera")

        for event in [LocalPreviewEvent.start, .bound, .stop, .failed, .interrupted, .permissionDenied] {
            #expect(LocalPreviewPolicy.next(machine, event: event) == machine, "\(event)")
        }
        machine = LocalPreviewPolicy.next(machine, event: .resetLatch)
        #expect(machine.state == .off && !machine.isLatched)
        machine = LocalPreviewPolicy.next(machine, event: .start)
        #expect(machine.state == .starting && machine.sessionId == 2)

        #expect(LocalPreviewPolicy.next(machine, event: .releasedByCall).isLatched)
        #expect(LocalPreviewPolicy.isWanted(cameraIntentOn: true, permission: .granted, isLobbyVisible: true, isCallOwningCamera: false))
        #expect(!LocalPreviewPolicy.isWanted(cameraIntentOn: true, permission: .granted, isLobbyVisible: true, isCallOwningCamera: true))
        #expect(!LocalPreviewPolicy.isWanted(cameraIntentOn: true, permission: .denied, isLobbyVisible: true, isCallOwningCamera: false))
    }

    @Test func theMacOSControllerReportsNoCameraAndKeepsTheLatch() {

        let controller = LocalPreviewController()
        var changes = 0
        controller.onChange = { changes += 1 }
        controller.start(facing: .front)
        #expect(controller.state == .unavailable)
        #expect(controller.startCount == 1 && changes >= 1)
        controller.handOffToCall()
        #expect(controller.isPublishLatched && controller.state == .published)
        controller.start(facing: .front)
        #expect(controller.state == .published && controller.startCount == 1)
        controller.resetLatch()
        #expect(!controller.isPublishLatched && controller.state == .off)
    }

    @Test func displayNamesFeedbackAndAudioFollowTheSpec() {
        #expect(DisplayNamePolicy.limit == 40 && DisplayNamePolicy.counterThreshold == 30)
        #expect(!DisplayNamePolicy.isCounterVisible(count: 29) && DisplayNamePolicy.isCounterVisible(count: 30))
        #expect(DisplayNamePolicy.capped(String(repeating: "b", count: 41)).count == 40)
        #expect(DisplayNamePolicy.normalized("  Avery    Lee ") == "Avery Lee")

        #expect(LobbyToggleFeedbackPolicy.kind(isOn: false, permission: .granted, onKind: .micOn, offKind: .micOff) == .micOn)
        #expect(LobbyToggleFeedbackPolicy.kind(isOn: true, permission: .denied, onKind: .micOn, offKind: .micOff) == .micOff)
        #expect(LobbyToggleFeedbackPolicy.kind(isOn: false, permission: .denied, onKind: .micOn, offKind: .micOff) == nil)
        #expect(LobbyToggleFeedbackPolicy.kind(isOn: false, permission: .denied, onKind: .micOn, offKind: .micOff,
                                               canAskAgain: true) == .micOn)
        #expect(LobbyToggleFeedbackPolicy.kind(isOn: false, permission: .unavailable, onKind: .cameraOn, offKind: .cameraOff) == nil)

        let device = LobbyDeviceInputs.initial.withRoutes(
            outputs: [AudioRouteOption(id: "spk", kind: .speaker, name: "", isConnecting: false)], currentOutputId: "spk",
            inputs: [], currentInputId: "")
        let audio = LobbyAudioPolicy.snapshot(routeId: 1, device: device, chosenOutputKind: "receiver", chosenInputId: "")
        #expect(audio.routeKind == "receiver" && audio.routeName == "")
        #expect(LobbyAudioPolicy.snapshot(routeId: 1, device: device, chosenOutputKind: "", chosenInputId: "").routeKind == "speaker")
        #expect(EntryMediaIntentPolicy.route(phase: .entering, hasBeenAdmittedThisSession: false) == "pending")
        #expect(EntryMediaIntentPolicy.route(phase: .waiting, hasBeenAdmittedThisSession: false) == "flags")
        #expect(EntryMediaIntentPolicy.route(phase: .recovering, hasBeenAdmittedThisSession: true) == "toggles")
        #expect(EntryMediaIntentPolicy.reconcilable(EntryMediaIntent(mic: true, camera: false, generation: 2), currentGeneration: 3) == nil)
    }

    @Test func presenceAnswersParseLikeTheWebRoute() throws {
        let base = try #require(URL(string: "https://conclave.acmvit.in"))
        #expect(RoomPresenceService.url(roomId: " rose sora ", baseURL: base)?.absoluteString
                == "https://conclave.acmvit.in/api/sfu/rooms/rose%20sora")
        #expect(RoomPresenceService.url(roomId: "  ", baseURL: base) == nil)
        #expect(RoomPresenceService.userCount(statusCode: 200, body: Data(#"{"room":{"id":"r","userCount":3}}"#.utf8)) == 3)
        #expect(RoomPresenceService.userCount(statusCode: 200, body: Data(#"{"room":null}"#.utf8)) == 0)
        #expect(RoomPresenceService.userCount(statusCode: 200, body: Data(#"{"room":{"id":"r","userCount":-2}}"#.utf8)) == 0)
        #expect(RoomPresenceService.userCount(statusCode: 404, body: Data()) == 0)
        #expect(RoomPresenceService.userCount(statusCode: 500, body: Data(#"{"error":"x"}"#.utf8)) == nil)
        #expect(RoomPresenceService.userCount(statusCode: 200, body: Data("nope".utf8)) == nil)
    }

    @Test func theLobbyFixturesShowTheirInjectedStatesWithoutAnyCall() {
        let lobby = PremeetingFixtureSession(state: .lobby)
        lobby.start()
        defer { lobby.stop() }
        #expect(lobby.premeeting.lobbyMedia?.preview == .blocked)
        #expect(lobby.premeeting.lobbyStatus?.isPrimaryEnabled == true)
        #expect(lobby.premeeting.lobbyIdentity?.guestName == PremeetingFixtureScript.lobbyGuestName)

        lobby.premeeting.setMicIntent(true)
        #expect(lobby.premeeting.lobbyMedia?.micIntentOn == true)
        lobby.premeeting.startOrJoin()
        #expect(lobby.premeeting.lobbyStatus?.mode == .connecting)
        lobby.premeeting.cancelJoin()
        #expect(lobby.premeeting.lobbyStatus?.mode == .editing)

        let missing = PremeetingFixtureSession(state: .lobbyNameMissing)
        missing.start()
        defer { missing.stop() }
        #expect(missing.premeeting.lobbyStatus?.isPrimaryEnabled == false)
        #expect(missing.premeeting.lobbyStatus?.primaryReason == LobbyPrimaryReason.nameMissingJoin.rawValue)

        let fresh = PremeetingFixtureSession(state: .lobbyNewMeeting)
        fresh.start()
        defer { fresh.stop() }
        #expect(fresh.premeeting.lobbyStatus?.intent == .newMeeting)
        #expect(fresh.premeeting.lobbyLink?.roomLabel == PremeetingFixtureScript.newMeetingCode)
        #expect(fresh.premeeting.lobbyLink?.canShare == false)
        #expect(fresh.premeeting.lobbyMedia?.preview == .unavailable)
        #expect(PremeetingFixtureScript.state(named: "lobby-name-missing") == .lobbyNameMissing)
    }

    static let lobbySwiftFiles = [
        "Sources/Conclave/Features/Lobby/LobbyContracts.swift",
        "Sources/Conclave/Features/Lobby/LobbyPolicies.swift",
        "Sources/Conclave/Features/Lobby/LobbyJoinCoordinator.swift",
        "Sources/Conclave/Features/Lobby/RoomPresenceService.swift",
        "Sources/Conclave/Features/Lobby/LobbyDeviceServices.swift",
        "Sources/Conclave/Core/WebRTC/LocalPreviewController.swift",
        "Sources/Conclave/Core/Networking/MeetingLinkBuilder.swift"
    ]
    static let lobbyIOSFiles = [
        "Sources/Conclave/Features/Lobby/LobbyView+iOS.swift",
        "Sources/Conclave/Features/Lobby/LobbyPreviewCard+iOS.swift",
        "Sources/Conclave/Features/Lobby/LobbyGroupedSection+iOS.swift",
        "Sources/Conclave/Features/Lobby/MeetingLinkRow+iOS.swift"
    ]
    static let lobbyKotlinFiles = [
        "Sources/Conclave/Skip/ui/lobby/LobbyScreen.kt",
        "Sources/Conclave/Skip/ui/lobby/LobbyPreviewCard.kt",
        "Sources/Conclave/Skip/ui/lobby/LobbyUiCache.kt",
        "Sources/Conclave/Skip/ui/lobby/RouteDialog.kt",
        "Sources/Conclave/Skip/ui/lobby/MeetingLinkRow.kt",
        "Sources/Conclave/Skip/ui/lobby/LobbyAudioDevices.kt",
        "Sources/Conclave/Skip/LocalPreviewController.kt"
    ]

    @Test func lobbyFilesStayFlatDashFreeLiteralFreeAndOffTheCore() throws {
        for file in Self.lobbySwiftFiles + Self.lobbyIOSFiles + Self.lobbyKotlinFiles {
            let text = try ent3Source(file)
            #expect(!text.contains("\u{2013}") && !text.contains("\u{2014}"), "\(file) has an en or em dash")
            if !S1FloatingBackdropTests.gradientAllowlist.contains(file) {
                #expect(!text.lowercased().contains("gradient"), "\(file) uses a gradient outside the D-1 allowlist")
            }
            #expect(ent3Matches(#"(UIColor|Color)\(\s*(red:|\.sRGB|0x|hue:|white:)"#, in: text).isEmpty, "\(file) builds a color from a literal")
            #expect(!text.contains("Color.white") && !text.contains("Color.black") && !text.contains(".tint(.white)"), "\(file)")
            #expect(!text.contains("@Stable") && !text.contains("@Immutable"), "\(file)")
            #expect(!text.contains("MeetingState"), "\(file) reads MeetingState")
            #expect(!text.contains("beginMeetingEntry"), "\(file): the native lobby never arms the entry overlay")
        }

        for file in Self.lobbyIOSFiles {
            let text = try ent3Source(file)
            #expect(text.hasPrefix("#if os(iOS) && !SKIP\n"), "\(file)")
            for pattern in ["glassEffect", "GlassEffectContainer", "glassProminent", "Material", "acmGlass", ".preferredColorScheme("] {
                #expect(!text.contains(pattern), "\(file) uses \(pattern)")
            }
            #expect(!text.contains("Image(systemName: \""), "\(file) names a raw symbol")
            #expect(ent3Matches(#"(?:Text|Button|Label|navigationTitle|Section|LabeledContent|Picker|TextField)\(\s*""#, in: text).isEmpty,
                    "\(file) has a literal label")
            #expect(!text.contains("MeetingShare."), "\(file): never the legacy share helpers (SC21)")
        }
        for file in Self.lobbyKotlinFiles {
            let text = try ent3Source(file)
            #expect(ent3Matches(#"Text\(\s*""#, in: text).isEmpty, "\(file) has a literal Text")
            #expect(!text.contains("performHapticFeedback") && !text.contains("LocalHapticFeedback") && !text.contains("Vibrator"), "\(file)")
            #expect(!text.contains("fontFamily"), "\(file)")
            #expect(!text.contains("enableEdgeToEdge") && !text.contains("ConclaveSystemBars("), "\(file): one system-bar writer")
        }

        for file in Self.lobbySwiftFiles {
            let text = try ent3Source(file)
            #expect(!text.contains("import SwiftUI"), "\(file)")
            #expect(ent3Matches(#"\.(?:map|compactMap|flatMap)\(\s*[A-Za-z_][A-Za-z0-9_.]*\s*\)"#, in: text).isEmpty, "\(file)")
            #expect(!text.contains(".isLetter"), "\(file)")
        }

        let devices = try ent3Source("Sources/Conclave/Features/Lobby/LobbyDeviceServices.swift")
        #expect(devices.contains("#if os(iOS) && !SKIP\nimport AVFoundation\nimport UIKit\n#endif"))
    }

    @Test func lobbyCopyStaysShortOnBothPlatforms() throws {
        let view = ent3Flat(try ent3Source("Sources/Conclave/Features/Lobby/LobbyView+iOS.swift"))
        #expect(view.contains("case .nameMissingJoin, .nameMissingStart: return ConclaveStrings.text(\"Add your name\")"))
        #expect(view.components(separatedBy: "ConclaveStrings.text(\"Add your name\")").count - 1 == 1, "one literal for both reasons")
        #expect(!view.contains("Add your name to join.") && !view.contains("Add your name to start."))
        let card = try ent3Source("Sources/Conclave/Features/Lobby/LobbyPreviewCard+iOS.swift")
        #expect(card.contains("ConclaveStrings.text(\"Camera unavailable\")"))
        #expect(!card.contains("Camera isn") && !card.contains("join with it off"))

        let catalog = try #require(try JSONSerialization.jsonObject(with: Data(ent3Source("Sources/Conclave/Resources/Localizable.xcstrings").utf8)) as? [String: Any])
        let strings = try #require(catalog["strings"] as? [String: Any])
        for key in ["Add your name", "Camera unavailable"] {
            #expect(strings[key] != nil, "missing iOS key \(key)")
        }
        for key in ["Add your name to join.", "Add your name to start.", "Camera isn\u{2019}t available. You can join with it off."] {
            #expect(strings[key] == nil, "stale iOS key \(key)")
        }
        let xml = try ent3Source("Android/app/src/main/res/values/strings.xml")
        for (name, value) in [("pm_camera_unavailable", "Camera unavailable"), ("pm_need_name_join", "Add your name"),
                              ("pm_need_name_start", "Add your name")] {
            #expect(xml.contains("<string name=\"\(name)\">\(value)</string>"), "\(name) is \(value)")
        }
        let kotlinCard = try ent3Source("Sources/Conclave/Skip/ui/lobby/LobbyPreviewCard.kt")
        #expect(kotlinCard.contains("if (unavailable) conclaveString(\"pm_camera_unavailable\") else conclaveString(\"pm_camera_off\")"))
    }

    @Test func theLobbyNeverAppliesARouteOrHandsThePreviewToAProducer() throws {

        for file in Self.lobbySwiftFiles + Self.lobbyIOSFiles + Self.lobbyKotlinFiles {
            let text = try ent3Source(file)
            #expect(!text.contains("setAudioOutput(") && !text.contains("setAudioInput("), "\(file)")
            #expect(!text.contains("setCommunicationDevice") && !text.contains("isSpeakerphoneOn"), "\(file)")
            #expect(!text.contains("requestRoute(") && !text.contains("BLUETOOTH_CONNECT"), "\(file): no route apply, no nearby-devices ask (R24)")
        }

        for file in ["Sources/Conclave/Core/WebRTC/LocalPreviewController.swift", "Sources/Conclave/Skip/LocalPreviewController.kt"] {
            let text = try ent3Source(file)
            for pattern in ["createProducer", "startProducing", "produce(", "RTCVideoSource", "RTCCameraVideoCapturer",
                            "VideoTrack", "CameraVideoCapturer", "Camera2Enumerator", "webRTCClient"] {
                #expect(!text.contains(pattern), "\(file) mentions \(pattern)")
            }
            #expect(text.contains("LocalPreviewPolicy.next("), "\(file) runs the shared state machine")
            #expect(text.contains("handOffToCall()") && text.contains("resetLatch()"), "\(file)")
        }

        let kotlin = try ent3Source("Sources/Conclave/Skip/LocalPreviewController.kt")
        for member in ["val shared", "var onChange", "fun start(facing: LocalCameraFacing)", "fun stop()", "fun flip()",
                       "val state: PreviewState", "val sessionId: Int", "var facing: LocalCameraFacing",
                       "val interruption: PreviewInterruption", "val isPublishLatched: Boolean", "var startCount"] {
            #expect(kotlin.contains(member), "Kotlin controller lacks \(member)")
        }

        let cameraPreview = try ent3Source("Sources/Conclave/Skip/CameraPreview.kt")
        #expect(cameraPreview.contains("onReleased?.invoke(preview)"))
        #expect(kotlin.contains("CameraPreviewController.onReleased = { released -> onMain { handleRelease(released) } }"))
        #expect(kotlin.contains("CameraPreviewController.markBound(provider, preview)"))
        #expect(kotlin.contains("PreviewView.ImplementationMode.COMPATIBLE"), "the last frame stays after the unbind (Q16 B)")
    }

    @Test func theRootsMountTheLobbyAndTheProductionWiringInstallsItsHooks() throws {
        let ios = ent3Flat(try ent3Source("Sources/Conclave/Features/Home/PremeetingRoot+iOS.swift"))
        #expect(ios.contains("case .lobby: LobbyView(route: route, premeeting: premeeting)"))
        #expect(!ios.contains("PremeetingLobbyStandIn"))
        let android = ent3Flat(try ent3Source("Sources/Conclave/Skip/ui/home/PremeetingHost.kt"))
        #expect(android.contains("is PremeetingKey.LobbyKey -> LobbyScreen(premeeting, key, onBack = { premeetingBack(premeeting) })"))
        #expect(!android.contains("LobbyStandInPage"))
        let wiring = ent3Flat(try ent3Source("Sources/Conclave/Features/Home/PremeetingAppWiring.swift"))
        let register = try #require(wiring.range(of: "ConclaveAppDelegate.shared.registerPremeeting(presenter)"))
        let hooks = try #require(wiring.range(of: "LobbyProductionHooks.install(presenter: presenter, viewModel: viewModel, appState: appState)"))
        #expect(register.lowerBound < hooks.lowerBound)
        let services = ent3Flat(try ent3Source("Sources/Conclave/Features/Lobby/LobbyDeviceServices.swift"))
        #expect(services.contains("viewModel.setEntryMediaIntent(mic: mic, camera: camera)"))
        #expect(services.contains("viewModel.setPrejoinAudioRouteIntent(outputKind: outputKind, inputId: inputId)"))
        #expect(services.contains("viewModel.setPreferredLocalCameraFacing(request.cameraFacing) viewModel.joinRoom("))

        let lobby = ent3Flat(try ent3Source("Sources/Conclave/Features/Lobby/LobbyView+iOS.swift"))
        #expect(lobby.contains(".task(id: route.id) { premeeting.lobbyDidAppear(routeId: route.id) }"))
        #expect(lobby.contains(".onDisappear { premeeting.lobbyDidDisappear(routeId: route.id) }"))
        #expect(lobby.contains("AnyLayout(HStackLayout(alignment: .top, spacing: 24))"), "rotation keeps the card's identity")
        let card = try ent3Source("Sources/Conclave/Features/Lobby/LobbyPreviewCard+iOS.swift")
        #expect(card.contains(".id(media.previewSessionId)"), "the surface is keyed by the preview session")
        #expect(card.contains("context: .lobbyCard"), "R9: the flip button never takes glass")
        let kotlinCard = try ent3Source("Sources/Conclave/Skip/ui/lobby/LobbyPreviewCard.kt")
        #expect(kotlinCard.contains("key(sessionId) {"))
    }
}

@MainActor
private final class ENT3HookRecorder {
    let hooks = LobbyCoreHooks()
    var intents: [String] = []
    var routeIntents: [String] = []
    var permissionRequests: [String] = []
    var joins: [LobbyJoinRequest] = []
    var previewCalls: [String] = []
    var presenceAnswers: [Int?] = []
    var repeatsLastAnswer = false
    var presenceRooms: [String] = []
    var refreshCount = 0

    init() {

        hooks.setEntryMediaIntent = { [weak self] mic, camera in
            self?.intents.append("\(mic):\(camera)")
        }
        hooks.setPrejoinAudioRouteIntent = { [weak self] kind, input in
            self?.routeIntents.append(kind + "|" + input)
        }
        hooks.requestPermission = { [weak self] kind in
            self?.permissionRequests.append(kind)
        }
        hooks.join = { [weak self] request in
            self?.joins.append(request)
        }
        hooks.startPreview = { [weak self] facing in
            self?.previewCalls.append("start:" + facing.rawValue)
        }
        hooks.stopPreview = { [weak self] in
            self?.previewCalls.append("stop")
        }
        hooks.handOffPreview = { [weak self] in
            self?.previewCalls.append("handOff")
        }
        hooks.resetPreviewLatch = { [weak self] in
            self?.previewCalls.append("resetLatch")
        }
        hooks.refreshDevices = { [weak self] in
            self?.refreshCount += 1
        }
        hooks.resolvedClientId = { "conclave" }
        hooks.fetchPresence = { [weak self] room, _ in
            guard let self else { return nil }
            self.presenceRooms.append(room)
            if self.presenceAnswers.count > 1 || (!self.repeatsLastAnswer && !self.presenceAnswers.isEmpty) {
                return self.presenceAnswers.removeFirst()
            }
            return self.presenceAnswers.first ?? 0
        }
    }
}

@MainActor
private func ent3Settle(_ condition: () -> Bool) async -> Bool {
    for _ in 0..<1000 {
        if condition() { return true }
        try? await Task.sleep(nanoseconds: 2_000_000)
    }
    return condition()
}

private func ent3Source(_ packageRelativePath: String) throws -> String {
    let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
    return try String(contentsOf: root.appendingPathComponent(packageRelativePath), encoding: .utf8)
}

private func ent3Flat(_ text: String) -> String {
    text.split(whereSeparator: { $0.isWhitespace }).joined(separator: " ")
}

private func ent3Matches(_ pattern: String, in text: String) -> [String] {
    guard let regex = try? NSRegularExpression(pattern: pattern) else { return [] }
    let range = NSRange(text.startIndex..<text.endIndex, in: text)
    return regex.matches(in: text, range: range).compactMap { match in
        Range(match.range, in: text).map { String(text[$0]) }
    }
}

#if os(macOS)

@MainActor
@Suite(.serialized)
struct ENT3EntryCoreDeltaTests {
    private func viewModel() -> MeetingViewModel {
        let viewModel = MeetingViewModel()
        viewModel.state = MeetingState(userId: "local@example.com#local-session", sessionId: "local-session")
        return viewModel
    }

    @Test func atHomeAndWhileWaitingTheIntentWritesTheFlagsTheJoinReads() {
        let viewModel = viewModel()
        viewModel.setEntryMediaIntent(mic: true, camera: true)
        #expect(!viewModel.state.isMuted && !viewModel.state.isCameraOff)
        #expect(viewModel.state.pendingEntryMediaIntent == nil)
        #expect(viewModel.makePremeetingInputs().micIntentOn && viewModel.makePremeetingInputs().cameraIntentOn)
        viewModel.state.roomId = "lily-zoro-iris"
        viewModel.state.connectionState = ConnectionState.waiting
        viewModel.setEntryMediaIntent(mic: false, camera: true)
        #expect(viewModel.state.isMuted && !viewModel.state.isCameraOff)
        #expect(viewModel.premeeting.currentInputs.micIntentOn == false)
    }

    @Test func whileEnteringTheIntentIsPendingShownAndLeavesTheFlags() {
        let viewModel = viewModel()
        viewModel.state.isMuted = true
        viewModel.state.isCameraOff = true
        viewModel.state.roomId = "lily-zoro-iris"
        viewModel.state.connectionState = ConnectionState.connecting
        viewModel.setEntryMediaIntent(mic: true, camera: false)
        #expect(viewModel.state.isMuted, "the transport decision may already be made; the flags wait for .joined")
        #expect(viewModel.state.pendingEntryMediaIntent?.mic == true)
        #expect(viewModel.makePremeetingInputs().micIntentOn == true)
        #expect(viewModel.premeeting.currentInputs.micIntentOn == true)
    }

    @Test func theRouteIntentIsStoredForTheRoutingOwnerAndNeverApplied() {
        let viewModel = viewModel()
        viewModel.setPrejoinAudioRouteIntent(outputKind: "speaker", inputId: "")
        #expect(viewModel.state.prejoinAudioOutputKind == "speaker")
        #expect(viewModel.state.prejoinAudioInputId == "")
    }
}
#endif
#endif
