#if !SKIP
import Foundation
import Testing
@testable import Conclave

/// ENT-1 (S10 0.4, 0.5, 1, 2; L9): the app-scoped premeeting presenter, the 0.4 root table, recents and the Rejoin
/// card, notices, the R51 gate, task teardown (S1C 3.3 TEAR) and the L9 fixture sessions. The transpiled presenter
/// also runs in `T/Skip/EntryPoliciesBridgeTests.kt`; the iOS views compile only for iOS and are pinned by source
/// scans in `T/EntryCoreDeltaTests.swift` and `T/ENT2JoinCodeTests.swift`.
@MainActor
struct PremeetingPresenterTests {
    private static let now: Double = 1793102400000.0
    private static let minute: Double = 60.0 * 1000.0

    private final class Recorder {
        var commands: [PremeetingCommand] = []
    }

    private func presenter(now: Double = PremeetingPresenterTests.now, recorder: Recorder? = nil) -> PremeetingPresenter {
        let presenter = PremeetingPresenter()
        presenter.nowMillis = { now }
        if let recorder {
            presenter.onCommand = { command in recorder.commands.append(command) }
        }
        return presenter
    }

    private func entering(_ room: String, callSession: Int = 1) -> PremeetingInputs {
        PremeetingInputs.make(callSession: callSession, phase: .entering, roomLabel: room, currentRoomId: room)
    }

    private func inCall(_ room: String, callSession: Int = 1, host: Bool = false) -> PremeetingInputs {
        PremeetingInputs.make(callSession: callSession, phase: .inCall, roomLabel: room, isLocalHost: host,
                              hasBeenAdmittedThisSession: true, currentRoomId: room)
    }

    // MARK: Home (S10 2)

    @Test func homePublishesTheRejoinCardAndTheOtherRecentsNewestFirst() {
        let presenter = presenter()
        presenter.bootstrap(user: nil, recents: PremeetingFixtureScript.recents(for: .home, nowMillis: Self.now))
        let home = presenter.home
        #expect(home.rejoin?.title == "rose-sora-luffy")
        #expect(home.rejoin?.end == .left)
        #expect(home.rejoin?.endedAtText.isEmpty == false)
        // The card's record is not repeated in Recent; row route ids are the record index from the base.
        #expect(home.recents.map { $0.title } == ["lily-zoro-iris", "maple-goku-tulip"])
        #expect(home.recents.map { $0.routeId } == [PremeetingRoute.recentRouteIdBase + 1, PremeetingRoute.recentRouteIdBase + 2])
        #expect(home.recents.first?.role == .host)
        #expect(home.recents.allSatisfy { !$0.relativeTime.isEmpty && $0.routeKind == .lobby })
        #expect(home.revision > 0)
        // The one-shot Rejoin wake-up exists exactly while a card is published (S10 0.5 task table).
        #expect(presenter.liveTaskCount == 1)
    }

    @Test func theRejoinCardExpiresFifteenMinutesAfterTheEnd() {
        // The fixture's card ended 3 minutes before `now`; 13 minutes later it is 16 minutes old (Q3).
        let presenter = presenter(now: Self.now + 13.0 * Self.minute)
        presenter.bootstrap(user: nil, recents: PremeetingFixtureScript.recents(for: .home, nowMillis: Self.now))
        #expect(presenter.home.rejoin == nil)
        #expect(presenter.home.recents.count == 3)
        #expect(presenter.liveTaskCount == 0)
        #expect(RecentMeetingsPolicy.rejoinWindowMillis == 15.0 * Self.minute)
    }

    @Test func recentsAreCappedAtTwentyAndAnUpsertMovesTheRoomToTheFront() {
        var records: [RecentMeetingRecord] = []
        for index in 0..<25 {
            records = RecentMeetingsPolicy.upsert(records, RecentMeetingRecord(
                id: "meeting:room-\(index)", roomId: "room-\(index)", title: "room-\(index)", joinMode: "meeting",
                role: "participant", lastJoinedAtMillis: Double(index), endedAtMillis: 0, end: ""))
        }
        #expect(records.count == RecentMeetingsPolicy.cap)
        #expect(records.first?.roomId == "room-24")
        records = RecentMeetingsPolicy.upsert(records, RecentMeetingRecord(
            id: "meeting:room-10", roomId: "room-10", title: "room-10", joinMode: "meeting", role: "host",
            lastJoinedAtMillis: 99, endedAtMillis: 0, end: ""))
        #expect(records.count == 20)
        #expect(records.first?.role == "host")
        #expect(records.filter { $0.id == "meeting:room-10" }.count == 1)
        #expect(RecentMeetingsPolicy.recordId(roomId: " Lily-Zoro-Iris ", joinMode: .webinarAttendee) == "webinar_attendee:lily-zoro-iris")
    }

    @Test func aMeetingThatReachedTheCallIsRecordedAndItsEndOffersRejoin() {
        let recorder = Recorder()
        let presenter = presenter(recorder: recorder)
        presenter.apply(entering("lily-zoro-iris"))
        presenter.apply(inCall("lily-zoro-iris", host: true))
        #expect(presenter.recentRecords.first?.roomId == "lily-zoro-iris")
        #expect(presenter.recentRecords.first?.recentRole == .host)
        #expect(presenter.recentRecords.first?.end == "")
        #expect(presenter.root.root == .call)
        // The view model clears the room on cleanup; the session's record still gets its end.
        presenter.apply(PremeetingInputs.make(callSession: 1, phase: .home, outcomeId: 7, outcomeKind: .left,
                                              hasBeenAdmittedThisSession: true))
        #expect(presenter.recentRecords.first?.end == RecentEnd.left.rawValue)
        #expect(presenter.home.rejoin?.title == "lily-zoro-iris")
        #expect(presenter.root == PremeetingRootDecision.home)
        #expect(presenter.path.isEmpty)
        #expect(recorder.commands.isEmpty)
    }

    @Test func aDenialRecordsTheRoomAsDeclinedWithoutARejoinCard() {
        let presenter = presenter()
        presenter.apply(entering("maple-goku-tulip", callSession: 2))
        presenter.apply(PremeetingInputs.make(callSession: 2, phase: .waiting, roomLabel: "maple-goku-tulip",
                                              currentRoomId: "maple-goku-tulip"))
        presenter.apply(PremeetingInputs.make(callSession: 2, phase: .outcome, outcomeId: 3, outcomeKind: .denied,
                                              roomLabel: "maple-goku-tulip", currentRoomId: "maple-goku-tulip"))
        #expect(presenter.recentRecords.first?.recentEnd == .denied)
        #expect(presenter.home.rejoin == nil)
        #expect(presenter.outcome?.variant == .denied)
        #expect(presenter.root.showsOutcome)
        #expect(presenter.path.isEmpty)
    }

    @Test func signingOutClearsRecents() {
        let presenter = presenter()
        presenter.store = RecentMeetingsStore(defaults: nil)
        let user = AppState.User(id: "u1", name: "Avery", email: nil, provider: .google)
        presenter.bootstrap(user: user, recents: PremeetingFixtureScript.recents(for: .home, nowMillis: Self.now))
        #expect(presenter.home.isSignedIn)
        #expect(presenter.home.accountName == "Avery")
        #expect(presenter.home.accountSeed == "u1")
        presenter.apply(PremeetingInputs.make(isSignedIn: false))
        #expect(presenter.recentRecords.isEmpty)
        #expect(presenter.home.recents.isEmpty && presenter.home.rejoin == nil)
        #expect(!presenter.home.isSignedIn)
        #expect(presenter.liveTaskCount == 0)
        // A guest is not signed in.
        #expect(!PremeetingPresenter.isSignedIn(AppState.User(id: "g", name: "Guest", email: nil, provider: .guest)))
    }

    // MARK: The S10 0.4 table

    @Test func rootPolicyMatchesTheS10PhaseTable() {
        func decide(_ phase: MeetingPhaseKind, admitted: Bool = false, outcome: MeetingTerminalOutcomeKind? = nil,
                    origin: MeetingEntryOrigin = .initial, waited: Bool = false) -> PremeetingRootDecision {
            PremeetingRootPolicy.decide(phase: phase, hasBeenAdmittedThisSession: admitted, outcomeKind: outcome,
                                        entryOrigin: origin, lastPreCallWasWaiting: waited)
        }
        #expect(decide(.home) == PremeetingRootDecision.home)
        #expect(decide(.entering).lobbyMode == .connecting && decide(.entering).pushesLobby)
        #expect(decide(.waiting).lobbyMode == .waiting && decide(.waiting).root == .premeeting)
        #expect(decide(.recovering).lobbyMode == .connecting && decide(.recovering).showsReconnecting)
        #expect(decide(.recovering, waited: true).lobbyMode == .waiting)
        #expect(decide(.recovering, admitted: true) == PremeetingRootDecision.call)
        #expect(decide(.inCall, admitted: true).root == .call)
        #expect(decide(.leaving, admitted: true).root == .call)
        #expect(decide(.leaving).root == .premeeting)
        #expect(decide(.outcome, outcome: .joinFailed).lobbyMode == .failed)
        #expect(!decide(.outcome, outcome: .joinFailed).showsOutcome)
        #expect(decide(.outcome, outcome: .joinFailed, origin: .recovery).showsOutcome)
        for kind in [MeetingTerminalOutcomeKind.removed, .denied, .connectionLost, .serverDisconnected] {
            #expect(decide(.outcome, admitted: true, outcome: kind).showsOutcome, "\(kind)")
        }
        for kind in [MeetingTerminalOutcomeKind.left, .endedByYou, .endedByHost, .roomClosed] {
            #expect(decide(.outcome, outcome: kind) == PremeetingRootDecision.home, "\(kind)")
        }
        #expect(PremeetingRootPolicy.outcomeVariant(.joinFailed, entryOrigin: .initial) == nil)
        #expect(PremeetingRootPolicy.outcomeVariant(.joinFailed, entryOrigin: .recovery) == .rejoinFailed)
        #expect(PremeetingRootPolicy.homeNotice(.endedByHost) == .endedByHost)
        #expect(PremeetingRootPolicy.homeNotice(.roomClosed) == .roomClosed)
        #expect(PremeetingRootPolicy.homeNotice(.reconnecting) == .none)
        #expect(PremeetingRootPolicy.recentEnd(.serverDisconnected) == .connectionLost)
        #expect(PremeetingRootPolicy.recentEnd(.roomClosed) == .endedByHost)
    }

    @Test func enteringAndWaitingPushTheLobbyAndACancelledJoinKeepsIt() {
        let presenter = presenter()
        presenter.apply(entering("rose-sora-luffy"))
        #expect(presenter.path.count == 1)
        #expect(presenter.path.first?.kind == .lobby)
        #expect(presenter.path.first?.roomId == "rose-sora-luffy")
        #expect(presenter.lobbyStatus?.mode == .connecting)
        #expect(presenter.lobbyStatus?.intent == .join)
        #expect(presenter.lobbyStatus?.isPrimaryEnabled == false)
        presenter.apply(PremeetingInputs.make(callSession: 1, phase: .waiting, roomLabel: "rose-sora-luffy",
                                              currentRoomId: "rose-sora-luffy"))
        #expect(presenter.lobbyStatus?.mode == .waiting)
        #expect(presenter.lobbyStatus?.waitingKind == .standard)
        // A drop before the first admission stays in the lobby with "Reconnecting" (S10 R6 a).
        presenter.apply(PremeetingInputs.make(callSession: 1, phase: .recovering, roomLabel: "rose-sora-luffy",
                                              currentRoomId: "rose-sora-luffy"))
        #expect(presenter.root.root == .premeeting)
        #expect(presenter.lobbyStatus?.mode == .waiting)
        #expect(presenter.lobbyStatus?.waitingKind == .reconnecting)
        // Cancel: the path is kept and the lobby is editable again (S10 0.4 home row).
        presenter.apply(PremeetingInputs.make(callSession: 1, phase: .home, roomLabel: "rose-sora-luffy",
                                              currentRoomId: "rose-sora-luffy"))
        #expect(presenter.path.count == 1)
        #expect(presenter.lobbyStatus?.mode == .editing)
        #expect(presenter.liveTaskCount == 0)
    }

    @Test func anInitialJoinFailureShowsTheInlineFailedLobby() {
        let presenter = presenter()
        presenter.apply(entering("rose-sora-luffy"))
        presenter.apply(PremeetingInputs.make(callSession: 1, phase: .outcome, outcomeId: 4, outcomeKind: .joinFailed,
                                              outcomeServerText: "This meeting is locked.", roomLabel: "rose-sora-luffy",
                                              currentRoomId: "rose-sora-luffy"))
        #expect(presenter.outcome == nil)
        #expect(presenter.lobbyStatus?.mode == .failed)
        #expect(presenter.lobbyStatus?.issue == .failedServerText)
        #expect(presenter.lobbyStatus?.issueServerText == "This meeting is locked.")
    }

    @Test func aRemovalShowsTheOutcomeScreenAndBackToHomeDismissesIt() {
        let recorder = Recorder()
        let presenter = presenter(recorder: recorder)
        presenter.apply(entering("lily-zoro-iris"))
        presenter.apply(inCall("lily-zoro-iris"))
        presenter.apply(PremeetingInputs.make(callSession: 1, phase: .outcome, outcomeId: 9, outcomeKind: .removed,
                                              hasBeenAdmittedThisSession: true))
        #expect(presenter.root.showsOutcome)
        #expect(presenter.outcome == OutcomeModel(id: 9, variant: .removed, primary: .backHome, secondary: .none, serverDetail: ""))
        #expect(presenter.path.isEmpty)
        presenter.performOutcomeAction(.backHome)
        #expect(recorder.commands == [.dismissOutcome])
        #expect(presenter.outcome == nil)
        #expect(presenter.root == PremeetingRootDecision.home)
        // The same outcome republished before the core clears it stays dismissed.
        presenter.apply(PremeetingInputs.make(callSession: 1, phase: .outcome, outcomeId: 9, outcomeKind: .removed,
                                              hasBeenAdmittedThisSession: true, isAppActive: false))
        #expect(presenter.outcome == nil)
        #expect(!presenter.root.showsOutcome)
    }

    @Test func leavingACallResetsThePathToHome() {
        let presenter = presenter()
        presenter.apply(entering("lily-zoro-iris"))
        #expect(presenter.path.count == 1)
        presenter.apply(inCall("lily-zoro-iris"))
        presenter.apply(PremeetingInputs.make(callSession: 1, phase: .leaving, hasBeenAdmittedThisSession: true))
        #expect(presenter.root.root == .call)
        presenter.apply(PremeetingInputs.make(callSession: 1, phase: .home, hasBeenAdmittedThisSession: true))
        #expect(presenter.path.isEmpty)
        #expect(presenter.lobbyStatus == nil)
    }

    @Test func aResumePushesTheResumeLobbyInConnecting() {
        let presenter = presenter()
        presenter.apply(PremeetingInputs.make(callSession: 4, phase: .entering, roomLabel: "lily-zoro-iris",
                                              currentRoomId: "lily-zoro-iris", resumeInFlight: true,
                                              resumeRoomId: "lily-zoro-iris"))
        #expect(presenter.lobbyStatus?.intent == .resume)
        #expect(presenter.lobbyStatus?.mode == .connecting)
        #expect(presenter.path.first?.roomId == "lily-zoro-iris")
    }

    // MARK: Home actions

    @Test func newMeetingOpensAStandInLobbyWithAGeneratedCodeAndNoCommand() {
        let recorder = Recorder()
        let presenter = presenter(recorder: recorder)
        presenter.newMeeting()
        #expect(presenter.path.count == 1)
        let route = presenter.path[0]
        #expect(route.kind == .lobby)
        let words = route.roomId.split(separator: "-").map { String($0) }
        #expect(words.count == EntryPolicies.roomWordsPerCode)
        #expect(words.allSatisfy { EntryPolicies.roomWords.contains($0) })
        let target = presenter.target(forRoute: route.id)
        #expect(target?.intent == .newMeeting)
        #expect(target?.allowRoomCreation == true)
        #expect(presenter.lobbyStatus?.intent == .newMeeting)
        #expect(presenter.lobbyStatus?.mode == .editing)
        // The stand-in lobby has no Start: nothing reaches the core.
        #expect(recorder.commands.isEmpty)
        presenter.setPath([])
        #expect(presenter.path.isEmpty)
        #expect(presenter.lobbyStatus == nil)
        #expect(presenter.liveTaskCount == 0)
    }

    @Test func openingARecentAndARecentRouteFromNavigationPrepareTheSameTarget() {
        let presenter = presenter()
        presenter.bootstrap(user: nil, recents: PremeetingFixtureScript.recents(for: .home, nowMillis: Self.now))
        let row = presenter.home.recents[0]
        presenter.setPath([PremeetingRoute(id: row.routeId, kind: row.routeKind, roomId: row.roomId)])
        #expect(presenter.path.count == 1)
        let target = presenter.target(forRoute: row.routeId)
        #expect(target?.roomId == "lily-zoro-iris")
        #expect(target?.intent == .join)
        #expect(target?.meetingInviteCode == nil)
        // An unknown route (no target, not a recent row) is dropped.
        presenter.setPath([PremeetingRoute(id: 77, kind: .lobby, roomId: "nope")])
        #expect(presenter.path.isEmpty)
        presenter.openRecent(id: row.id)
        #expect(presenter.path.first?.roomId == "lily-zoro-iris")
        presenter.removeRecent(id: row.id)
        #expect(!presenter.home.recents.contains { $0.id == row.id })
    }

    @Test func rejoinOpensTheRejoinLobbyForTheCard() {
        let presenter = presenter()
        presenter.bootstrap(user: nil, recents: PremeetingFixtureScript.recents(for: .home, nowMillis: Self.now))
        presenter.rejoin()
        #expect(presenter.path.first?.roomId == "rose-sora-luffy")
        #expect(presenter.lobbyStatus?.intent == .rejoin)
    }

    @Test func theUpdateGateOpensTheExplanationInsteadOfTheLobby() {
        let presenter = presenter()
        presenter.apply(PremeetingInputs.make(updateRequired: true, storeURL: "https://apps.apple.com/app/id0"))
        #expect(presenter.home.updateRequired)
        #expect(presenter.home.storeURL == "https://apps.apple.com/app/id0")
        presenter.newMeeting()
        #expect(presenter.isUpdatePromptPresented)
        #expect(presenter.path.isEmpty)
        presenter.dismissUpdatePrompt()
        presenter.openJoinSheet()
        #expect(!presenter.isJoinSheetPresented)
        #expect(presenter.isUpdatePromptPresented)
        presenter.openStoreListing()
        #expect(!presenter.isUpdatePromptPresented)
        presenter.handleIncomingURL("conclave://rose-sora-luffy")
        #expect(presenter.isUpdatePromptPresented)
        #expect(presenter.path.isEmpty)
    }

    @Test func noticesComeFromTheSessionAndFromLocalEvents() {
        let recorder = Recorder()
        let presenter = presenter(recorder: recorder)
        presenter.apply(PremeetingInputs.make(phase: .home, notice: .endedByHost, noticeText: "The host ended the meeting."))
        #expect(presenter.home.noticeKind == .endedByHost)
        #expect(presenter.home.noticeText == "The host ended the meeting.")
        presenter.dismissHomeNotice()
        #expect(recorder.commands == [.dismissOutcome])
        #expect(presenter.home.noticeKind == .none)
        presenter.reportInvalidLink()
        #expect(presenter.home.noticeKind == .invalidLink)
        presenter.dismissHomeNotice()
        #expect(presenter.home.noticeKind == .none)
        #expect(recorder.commands.count == 1)
        presenter.showHomeNotice(.movedToAudience)
        #expect(presenter.home.noticeKind == .movedToAudience)
        // A stage notice is not a Home notice.
        presenter.dismissHomeNotice()
        presenter.apply(PremeetingInputs.make(phase: .home, notice: .formError, noticeText: "Name needed"))
        #expect(presenter.home.noticeKind == .none)
        #expect(presenter.home.noticeText == "")
    }

    @Test func applyIsEqualityGuardedAndPublishesNothingForTheSameInputs() {
        let presenter = presenter()
        let inputs = entering("rose-sora-luffy")
        presenter.apply(inputs)
        let count = presenter.snapshotPublishCount
        presenter.apply(inputs)
        #expect(presenter.snapshotPublishCount == count)
        #expect(presenter.currentInputs == inputs)
    }

    @Test func noPresenterTaskOutlivesTheLobbyTheCallOrAnOutcome() {
        let presenter = presenter()
        presenter.apply(entering("lily-zoro-iris"))
        #expect(presenter.liveTaskCount == 0)
        presenter.setPath([])
        #expect(presenter.liveTaskCount == 0)
        presenter.apply(inCall("lily-zoro-iris"))
        #expect(presenter.liveTaskCount == 0)
        presenter.apply(PremeetingInputs.make(callSession: 1, phase: .outcome, outcomeId: 2, outcomeKind: .removed,
                                              hasBeenAdmittedThisSession: true))
        #expect(presenter.liveTaskCount == 0)
    }

    // MARK: L9 fixture

    @Test func everyFixtureStateReachesItsRowOfTheTable() {
        for state in PremeetingFixtureState.allCases {
            let session = PremeetingFixtureSession(state: state)
            session.start()
            defer { session.stop() }
            let premeeting = session.premeeting
            #expect(session.selfCheckReadout == "pending", "\(state)")
            #expect(PremeetingFixtureScript.state(named: " \(state.rawValue) ") == state)
            switch state {
            case .home:
                #expect(premeeting.home.rejoin != nil && premeeting.home.recents.count == 2)
                #expect(premeeting.path.isEmpty && premeeting.root == PremeetingRootDecision.home)
            case .empty:
                #expect(premeeting.home.recents.isEmpty && premeeting.home.rejoin == nil)
            case .noticeEndedByHost:
                #expect(premeeting.home.noticeKind == .endedByHost)
            case .noticeInvalidLink:
                #expect(premeeting.home.noticeKind == .invalidLink)
            case .noticeMovedToAudience:
                #expect(premeeting.home.noticeKind == .movedToAudience)
            case .updateRequired:
                #expect(premeeting.home.updateRequired)
            case .connecting, .connectingToCall:
                #expect(premeeting.lobbyStatus?.mode == .connecting, "\(state)")
            case .waiting:
                #expect(premeeting.lobbyStatus?.mode == .waiting)
            case .resume:
                #expect(premeeting.lobbyStatus?.intent == .resume)
                #expect(premeeting.lobbyStatus?.mode == .connecting)
                // RECONCILE R4: the resume restores muted with the camera off.
                #expect(!session.shell.entry.micIntentOn && !session.shell.entry.cameraIntentOn)
            case .inCall:
                #expect(premeeting.root.root == .call)
            case .outcomeRemoved:
                #expect(premeeting.outcome?.variant == .removed)
            case .outcomeConnectionLost:
                #expect(premeeting.outcome?.variant == .connectionLost)
            case .joinFailed:
                #expect(premeeting.lobbyStatus?.mode == .failed)
            // Batch 4 integrator (HD request B4-T2 R5): the ENT-3 lobby fixtures.
            case .lobby:
                #expect(premeeting.lobbyMedia?.preview == .blocked)
                #expect(premeeting.lobbyIdentity?.guestName == PremeetingFixtureScript.lobbyGuestName)
                #expect(premeeting.lobbyStatus?.isPrimaryEnabled == true)
            case .lobbyNameMissing:
                #expect(premeeting.lobbyStatus?.isPrimaryEnabled == false)
                #expect(premeeting.lobbyStatus?.primaryReason == LobbyPrimaryReason.nameMissingJoin.rawValue)
            case .lobbyNewMeeting:
                #expect(premeeting.lobbyStatus?.intent == .newMeeting)
                #expect(premeeting.lobbyLink?.roomLabel == PremeetingFixtureScript.newMeetingCode)
                #expect(premeeting.lobbyLink?.canShare == false)
            // Batch 7 integrator (HD request B7-T8 R3): the ENT-4 permission priming fixtures (T/ENT4PermissionPrimingTests.swift
            // checks each one's permissions).
            case .lobbyPermissionsUndetermined, .lobbyMicRationale, .lobbyCameraRationale, .lobbyPermissionsDenied,
                 .lobbyPermissionsRestricted:
                #expect(premeeting.lobbyStatus?.mode == .editing, "\(state)")
                #expect(PermissionPrimingFixture.permissions(forState: state.rawValue) != nil, "\(state)")
            // Batch 4 integrator (HD request B4-T3 R10): the ENT-7 account fixtures.
            case .accountSignedOut, .accountSignedIn, .accountSignInCancel, .accountSignInFailure, .accountExpired,
                 .accountDeleteFailure, .accountGoogleOnly, .accountAppleOnly, .accountProvidersFailed:
                // ENT-7: Home stays the root; T/ENT7AccountTests.swift checks the account side.
                #expect(premeeting.root == PremeetingRootDecision.home, "\(state)")
                #expect(AccountFixtureScript.state(named: state.rawValue) != nil, "\(state)")
            // Batch 5 integrator (HD request B5-T5 R5): the ENT-5 and ENT-6 fixtures (T/ENT5EntryTransitionTests.swift
            // and T/ENT6OutcomeTests.swift check each one in detail).
            case .failedNetwork:
                #expect(premeeting.lobbyStatus?.mode == .failed && premeeting.lobbyStatus?.issue == .failedNetwork)
            case .failedServerBusy, .retryAfter:
                #expect(premeeting.lobbyStatus?.mode == .connecting, "\(state)")
            case .recoveringBeforeAdmission:
                #expect(premeeting.root.root == .premeeting && premeeting.lobbyStatus?.waitingKind == .reconnecting)
            case .waitingLocked, .waitingNoHost, .waitingHostAvailable, .waitingReconnecting, .waitingOffline,
                 .waitingServerRestarting, .waitingToAdmitted, .waitingDenied:
                #expect(premeeting.lobbyStatus?.mode == .waiting, "\(state)")
            case .outcomeDenied:
                #expect(premeeting.outcome?.variant == .denied)
            case .outcomeServerDisconnected:
                #expect(premeeting.outcome?.variant == .serverDisconnected && premeeting.outcome?.primary == .rejoin)
            case .outcomeRejoinFailed:
                #expect(premeeting.outcome?.variant == .rejoinFailed && premeeting.outcome?.primary == .tryAgain)
            case .noticeRoomClosed:
                #expect(premeeting.home.noticeKind == .roomClosed && premeeting.outcome == nil)
            case .homeRejoin:
                #expect(premeeting.home.rejoin != nil && premeeting.currentInputs.rejoinRoomId == PremeetingFixtureScript.roomLabel)
            }
        }
    }

    @Test func fixtureNewMeetingReachesTheStandInLobbyWithoutTouchingTheSession() {
        let session = PremeetingFixtureSession(state: .home)
        session.start()
        defer { session.stop() }
        let before = session.shell.snapshotPublishCount
        let inputs = session.premeeting.currentInputs
        session.premeeting.newMeeting()
        #expect(session.premeeting.path.first?.kind == .lobby)
        #expect(session.shell.snapshotPublishCount == before)
        #expect(session.premeeting.currentInputs == inputs)
    }

    @Test func fixtureLeaveAndJoinGoesHomeAndOpensTheTargetLobby() {
        let session = PremeetingFixtureSession(state: .inCall)
        session.start()
        defer { session.stop() }
        session.handleIncomingURL("https://conclave.acmvit.in/lily-zoro-iris")
        let prompt = session.premeeting.switchPrompt
        #expect(prompt?.currentLabel == PremeetingFixtureScript.roomLabel)
        #expect(prompt?.targetLabel == "lily-zoro-iris")
        session.premeeting.confirmSwitch(id: prompt?.id ?? -1)
        #expect(session.premeeting.switchPrompt == nil)
        #expect(session.premeeting.root.root == .premeeting)
        #expect(session.premeeting.path.last?.roomId == "lily-zoro-iris")
        #expect(session.premeeting.lobbyStatus?.mode == .editing)
    }
}
#endif
