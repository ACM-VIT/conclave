import Foundation
import Testing
@testable import Conclave

// ENT-9 (S10 12, 0.5 task table, 0.6 L7; RECONCILE R41; S10 Q7): the webinar attendee landing's shared policy, the
// premeeting presenter's `webinarLanding` route, the lookup service's scalars, the L9 fixtures and the platform
// files' source rules. Mirrors T/Skip/ENT9WebinarLandingBridgeTests.kt.

@MainActor
struct ENT9WebinarLandingTests {
    private static let link = "https://conclave.acmvit.in/w/design-systems-week"
    private static let slug = "design-systems-week"
    private static let t0 = 1793102400000.0

    private func presenter(hooks: ENT9HookRecorder? = nil, clock: ENT9Clock = ENT9Clock(), guestName: String = "Avery",
                           isSignedIn: Bool = false) -> PremeetingPresenter {
        let presenter = PremeetingPresenter()
        presenter.nowMillis = { clock.now }
        presenter.webinarRefetchIntervalMillis = 5
        presenter.apply(PremeetingInputs.make(currentJoinMode: .webinarAttendee, isSignedIn: isSignedIn, accountName: guestName))
        if let hooks {
            presenter.webinarHooks = hooks.hooks
            presenter.onCommand = { [weak hooks] command in
                hooks?.commands.append(command.rawValue)
            }
        }
        return presenter
    }

    private func openLanding(_ presenter: PremeetingPresenter, link: String = ENT9WebinarLandingTests.link) -> Int {
        presenter.handleIncomingURL(link)
        return presenter.path.last?.id ?? -1
    }

    private static func live(requiresInviteCode: Bool = false) -> WebinarLookupAnswer {
        WebinarLookupAnswer(outcome: .found, title: "Design Systems Week", hostName: "ACM-VIT", status: "live",
                            startsAtMillis: t0 - 300000.0, endsAtMillis: t0 + 3300000.0, earlyEntryMinutes: 10,
                            requiresInviteCode: requiresInviteCode, link: "https://conclave.acmvit.in/w/design-systems-week")
    }

    private static func scheduled(startsIn: Double, earlyMinutes: Int) -> WebinarLookupAnswer {
        WebinarLookupAnswer(outcome: .found, title: "Design Systems Week", hostName: "ACM-VIT", status: "scheduled",
                            startsAtMillis: t0 + startsIn, endsAtMillis: t0 + startsIn + 3600000.0,
                            earlyEntryMinutes: earlyMinutes, requiresInviteCode: false, link: "")
    }

    private static func status(_ answer: WebinarLookupAnswer, _ status: String) -> WebinarLookupAnswer {
        WebinarLookupAnswer(outcome: answer.outcome, title: answer.title, hostName: answer.hostName, status: status,
                            startsAtMillis: answer.startsAtMillis, endsAtMillis: answer.endsAtMillis,
                            earlyEntryMinutes: answer.earlyEntryMinutes, requiresInviteCode: answer.requiresInviteCode,
                            link: answer.link)
    }

    /// The session inputs a scripted attendee attempt produces (the view model's `makePremeetingInputs()`).
    private static func inputs(callSession: Int = 1, phase: MeetingPhaseKind, notice: MeetingNoticeKind = .none,
                               noticeText: String = "", outcomeId: Int = 0, outcomeKind: MeetingTerminalOutcomeKind? = nil,
                               serverText: String = "", isWebinarAttendee: Bool = true, admitted: Bool = false,
                               currentRoomId: String = "", guestName: String = "Avery", category: String = "",
                               code: String = "", socketConnected: Bool = false) -> PremeetingInputs {
        PremeetingInputs.make(callSession: callSession, phase: phase, notice: notice, noticeText: noticeText,
                              outcomeId: outcomeId, outcomeKind: outcomeKind, outcomeServerText: serverText,
                              isWebinarAttendee: isWebinarAttendee, hasBeenAdmittedThisSession: admitted,
                              currentRoomId: currentRoomId, currentJoinMode: .webinarAttendee, accountName: guestName,
                              joinFailureCategory: category, joinFailureCode: code, entrySocketConnected: socketConnected)
    }

    /// A visible landing that answered `answer`.
    private func openAnswered(_ answer: WebinarLookupAnswer, hooks: ENT9HookRecorder, clock: ENT9Clock = ENT9Clock(),
                              guestName: String = "Avery") async -> PremeetingPresenter {
        hooks.answers = [answer]
        hooks.repeatsLastAnswer = true
        let presenter = presenter(hooks: hooks, clock: clock, guestName: guestName)
        let routeId = openLanding(presenter)
        presenter.webinarDidAppear(routeId: routeId)
        _ = await ent9Settle { presenter.webinar?.status != .loading }
        return presenter
    }

    // MARK: Policy (S10 12 c, f; web PRE-51 to PRE-53)

    @Test func lookupStatusFollowsTheWebOpenRule() {
        let now = Self.t0
        #expect(WebinarLandingPolicy.lookupStatus(nil, nowMillis: now) == .loading)
        #expect(WebinarLandingPolicy.lookupStatus(WebinarLookupAnswer.lookupFailed, nowMillis: now) == .failed)
        #expect(WebinarLandingPolicy.lookupStatus(WebinarLookupAnswer.unscheduled, nowMillis: now) == .open)
        #expect(WebinarLandingPolicy.lookupStatus(Self.live(), nowMillis: now) == .open)
        #expect(WebinarLandingPolicy.lookupStatus(Self.status(Self.live(), "ended"), nowMillis: now) == .ended)
        #expect(WebinarLandingPolicy.lookupStatus(Self.status(Self.live(), "CANCELLED"), nowMillis: now) == .cancelled)
        let early = Self.scheduled(startsIn: 761000.0, earlyMinutes: 10)
        #expect(WebinarLandingPolicy.lookupStatus(early, nowMillis: now) == .early)
        #expect(WebinarLandingPolicy.lookupStatus(early, nowMillis: now + 161000.0) == .open, "open at start minus 10 min")
        #expect(WebinarLandingPolicy.lookupStatus(early, nowMillis: now + 160999.0) == .early)
        let noStart = Self.scheduled(startsIn: -Self.t0, earlyMinutes: 0)
        #expect(WebinarLandingPolicy.opensAtMillis(noStart) == 0.0)
        #expect(WebinarLandingPolicy.lookupStatus(noStart, nowMillis: now) == .open, "no start time is open")
        #expect(WebinarLandingPolicy.openWakeDelayMillis(early, nowMillis: now) == 161000.0)
        #expect(WebinarLandingPolicy.openWakeDelayMillis(Self.live(), nowMillis: now) == nil)
        #expect(WebinarLandingPolicy.openWakeDelayMillis(nil, nowMillis: now) == nil)
    }

    @Test func theLegacyOpenRuleAndTheLandingAgree() {
        let vectors: [(String?, Double?, Int?)] = [("live", nil, nil), ("ended", Self.t0 - 1.0, 0), ("cancelled", nil, nil),
                                                   ("scheduled", Self.t0 + 600000.0, 10), ("scheduled", Self.t0 + 600001.0, 10),
                                                   (nil, Self.t0 + 1.0, nil), (nil, nil, nil)]
        for vector in vectors {
            let webinar = NativeScheduledWebinar(linkSlug: Self.slug, title: nil, hostName: nil, scheduledStartAt: vector.1,
                                                 scheduledEndAt: nil, status: vector.0, earlyEntryMinutes: vector.2,
                                                 requiresInviteCode: nil, webinarLink: nil, clientId: nil)
            let answer = NativeWebinarLookupService.answer(from: webinar)
            #expect(webinar.opensForAttendee(nowMillis: Self.t0) == WebinarLandingPolicy.isOpen(answer, nowMillis: Self.t0),
                    "\(vector)")
        }
    }

    @Test func tagsUseTheWordAndLiveNeedsTheStart() {
        let now = Self.t0
        #expect(WebinarLandingPolicy.tag(status: .open, answer: Self.live(), nowMillis: now) == .live)
        #expect(WebinarLandingPolicy.tag(status: .open, answer: WebinarLookupAnswer.unscheduled, nowMillis: now) == .live)
        let window = Self.scheduled(startsIn: 120000.0, earlyMinutes: 10)
        #expect(WebinarLandingPolicy.tag(status: .open, answer: window, nowMillis: now) == .startsSoon, "the early entry window")
        #expect(WebinarLandingPolicy.tag(status: .early, answer: window, nowMillis: now) == .startsSoon)
        #expect(WebinarLandingPolicy.tag(status: .waitingForHost, answer: Self.live(), nowMillis: now) == .startsSoon)
        #expect(WebinarLandingPolicy.tag(status: .ended, answer: nil, nowMillis: now) == .ended)
        #expect(WebinarLandingPolicy.tag(status: .cancelled, answer: nil, nowMillis: now) == .ended)
        for status in [WebinarLandingStatus.loading, .failed, .locked, .full, .unavailable] {
            #expect(WebinarLandingPolicy.tag(status: status, answer: Self.live(), nowMillis: now) == .none, "\(status)")
        }
    }

    @Test func attendeeJoinFailuresMapToTheirStates() {
        // SFU joinRoom.ts attendee sentences through the classifier (S10 12 f).
        #expect(WebinarLandingPolicy.joinFailureStatus(category: "unknown", diagnosticCode: "message.unrecognized",
                                                       serverText: "Webinar is not live.") == .waitingForHost)
        // The classifier's real answer for the SFU sentence: a clean sentence no row knows, kept as the server text.
        let notLive = MeetingErrorClassifier.classify(serverMessage: "Webinar is not live.", context: .join)
        #expect(notLive.category == .rejectedByServer && notLive.serverText == "Webinar is not live.")
        #expect(WebinarLandingPolicy.joinFailureStatus(category: notLive.category.rawValue, diagnosticCode: notLive.diagnosticCode,
                                                       serverText: notLive.serverText) == .waitingForHost)
        let locked = MeetingErrorClassifier.classify(serverMessage: "Webinar is locked.", context: .join)
        #expect(WebinarLandingPolicy.joinFailureStatus(category: locked.category.rawValue, diagnosticCode: locked.diagnosticCode,
                                                       serverText: locked.serverText) == .locked)
        #expect(WebinarLandingPolicy.joinFailureStatus(category: MeetingErrorCategory.lockedByHost.rawValue,
                                                       diagnosticCode: "message.locked", serverText: "") == .locked)
        #expect(WebinarLandingPolicy.joinFailureStatus(category: "unknown", diagnosticCode: "", serverText: "Webinar is full.") == .full)
        #expect(WebinarLandingPolicy.joinFailureStatus(category: "unknown", diagnosticCode: "",
                                                       serverText: "Webinar is not enabled.") == .unavailable)
        #expect(WebinarLandingPolicy.joinFailureStatus(category: MeetingErrorCategory.roomNotFound.rawValue, diagnosticCode: "",
                                                       serverText: "") == .unavailable)
        #expect(WebinarLandingPolicy.joinFailureStatus(category: MeetingErrorCategory.attendeeOnly.rawValue, diagnosticCode: "",
                                                       serverText: "") == .unavailable)
        #expect(WebinarLandingPolicy.joinFailureStatus(category: MeetingErrorCategory.roomEnded.rawValue, diagnosticCode: "",
                                                       serverText: "") == .ended)
        #expect(WebinarLandingPolicy.joinFailureStatus(category: MeetingErrorCategory.serverUnreachable.rawValue,
                                                       diagnosticCode: "url.unreachable", serverText: "") == .failed)
        #expect(WebinarLandingPolicy.isInviteCodeError("Enter the webinar invite code to join."))
        #expect(!WebinarLandingPolicy.isInviteCodeInvalid("Enter the webinar invite code to join."))
        #expect(WebinarLandingPolicy.isInviteCodeInvalid("Invalid webinar invite code. Check it and try again."))
        #expect(!WebinarLandingPolicy.isInviteCodeError("No room found. Double-check the code and try again."))
    }

    @Test func theNameIsNeededOnlyForAGuestWithoutOneAndCapsAt40() {
        // RECONCILE R41: the landing name becomes the guest identity; 40 at most.
        #expect(WebinarLandingPolicy.needsName(isSignedIn: false, accountName: ""))
        #expect(WebinarLandingPolicy.needsName(isSignedIn: false, accountName: "   "))
        #expect(!WebinarLandingPolicy.needsName(isSignedIn: false, accountName: "Avery"))
        #expect(!WebinarLandingPolicy.needsName(isSignedIn: true, accountName: "Avery Chen"))
        let long = String(repeating: "a", count: 45)
        #expect(WebinarLandingPolicy.displayName(isSignedIn: false, accountName: "", nameDraft: long).count <= DisplayNamePolicy.limit)
        #expect(WebinarLandingPolicy.displayName(isSignedIn: false, accountName: "Avery", nameDraft: "Typed") == "Avery")
        #expect(WebinarLandingPolicy.displayName(isSignedIn: false, accountName: "", nameDraft: "  Sam   Lee ") == "Sam Lee")
        #expect(!WebinarLandingPolicy.isPrimaryEnabled(status: .open, needsName: true, nameDraft: " ", needsInviteCode: false,
                                                       inviteDraft: "", linkHasInviteCode: false))
        #expect(WebinarLandingPolicy.isPrimaryEnabled(status: .open, needsName: true, nameDraft: "Sam", needsInviteCode: false,
                                                      inviteDraft: "", linkHasInviteCode: false))
        #expect(!WebinarLandingPolicy.isPrimaryEnabled(status: .open, needsName: false, nameDraft: "", needsInviteCode: true,
                                                       inviteDraft: "", linkHasInviteCode: false))
        #expect(WebinarLandingPolicy.isPrimaryEnabled(status: .open, needsName: false, nameDraft: "", needsInviteCode: true,
                                                      inviteDraft: "", linkHasInviteCode: true))
        for status in WebinarLandingStatus.allCases where status != .open {
            #expect(!WebinarLandingPolicy.isPrimaryEnabled(status: status, needsName: false, nameDraft: "", needsInviteCode: false,
                                                           inviteDraft: "", linkHasInviteCode: false), "\(status)")
        }
    }

    @Test func actionsRefetchAndAnnouncementsFollowTheStateTable() {
        for status in WebinarLandingStatus.allCases {
            let action = WebinarLandingPolicy.action(status)
            switch status {
            case .open:
                #expect(action == .startWatching)
            case .failed:
                #expect(action == .tryAgain)
            case .locked, .full, .unavailable, .ended, .cancelled:
                #expect(action == .backHome, "\(status)")
            case .loading, .early, .joining, .almostThere, .waitingForHost:
                #expect(action == WebinarLandingAction.none, "\(status)")
            }
            #expect(WebinarLandingPolicy.refetches(status) == [.loading, .early, .open, .waitingForHost].contains(status), "\(status)")
            #expect(WebinarLandingPolicy.isJoining(status) == (status == .joining || status == .almostThere))
            #expect(WebinarLandingPolicy.announces(status) == [.open, .waitingForHost, .ended, .cancelled].contains(status))
        }
    }

    @Test func theCountdownRangeIsClampedAndSplitIntoParts() {
        // S10 12 c, l6: a ClosedRange traps when its lower bound passes the upper one (the app woke after the start).
        #expect(WebinarLandingPolicy.countdownEndMillis(startsAtMillis: Self.t0, nowMillis: Self.t0 + 5000.0) == Self.t0 + 5000.0)
        #expect(WebinarLandingPolicy.countdownEndMillis(startsAtMillis: Self.t0 + 5000.0, nowMillis: Self.t0) == Self.t0 + 5000.0)
        #expect(WebinarLandingPolicy.countdown(remainingMillis: 761000.0) == WebinarCountdown(hours: 0, minutes: 12, seconds: 41))
        #expect(WebinarLandingPolicy.countdown(remainingMillis: 3725999.0) == WebinarCountdown(hours: 1, minutes: 2, seconds: 5))
        #expect(WebinarLandingPolicy.countdown(remainingMillis: 90000000.0) == WebinarCountdown(hours: 25, minutes: 0, seconds: 0))
        #expect(WebinarLandingPolicy.countdown(remainingMillis: -1.0) == WebinarCountdown(hours: 0, minutes: 0, seconds: 0))
        #expect(WebinarLandingPolicy.eventEndMillis(startsAtMillis: Self.t0, endsAtMillis: Self.t0 + 600000.0) == Self.t0 + 600000.0)
        #expect(WebinarLandingPolicy.eventEndMillis(startsAtMillis: Self.t0, endsAtMillis: 0.0) == Self.t0 + 3600000.0)
        #expect(WebinarLandingPolicy.shareLink(slug: Self.slug, serverLink: " https://example.org/w/x ") == "https://example.org/w/x")
        #expect(WebinarLandingPolicy.shareLink(slug: Self.slug, serverLink: "") == EntryPolicies.recentLink(roomId: Self.slug, isWebinar: true))
    }

    // MARK: Lookup service scalars (S10 12 j)

    @Test func theLookupProjectionBecomesScalars() throws {
        let json = """
        {"linkSlug":"design-systems-week","title":"  Design Systems Week ","hostName":" ACM-VIT ","scheduledStartAt":1793103161000,
         "scheduledEndAt":1793106761000,"status":"Scheduled","earlyEntryMinutes":-3,"requiresInviteCode":true,
         "webinarLink":"https://conclave.acmvit.in/w/design-systems-week","clientId":"conclave","publicAccess":true}
        """
        let webinar = try JSONDecoder().decode(NativeScheduledWebinar.self, from: Data(json.utf8))
        let answer = NativeWebinarLookupService.answer(from: webinar)
        #expect(answer.outcome == .found)
        #expect(answer.title == "Design Systems Week" && answer.hostName == "ACM-VIT")
        #expect(answer.status == "scheduled")
        #expect(answer.startsAtMillis == 1793103161000.0 && answer.endsAtMillis == 1793106761000.0)
        #expect(answer.earlyEntryMinutes == 0, "a negative window clamps to 0")
        #expect(answer.requiresInviteCode && answer.link == "https://conclave.acmvit.in/w/design-systems-week")
        let bare = try JSONDecoder().decode(NativeScheduledWebinar.self, from: Data("{}".utf8))
        let empty = NativeWebinarLookupService.answer(from: bare)
        #expect(empty.title.isEmpty && empty.startsAtMillis == 0.0 && empty.status.isEmpty && !empty.requiresInviteCode)
        #expect(WebinarLookupAnswer.unscheduled.outcome == .notScheduled && WebinarLookupAnswer.lookupFailed.outcome == .failed)
    }

    // MARK: Presenter (S10 12 j, l2)

    @Test func aWebinarLinkOpensTheLandingAndNeverJoinsOnArrival() async {
        // S10 12 l2, Q7: a stored identity still waits for Start Watching.
        let hooks = ENT9HookRecorder()
        hooks.answers = [Self.live()]
        hooks.repeatsLastAnswer = true
        let presenter = presenter(hooks: hooks)
        let routeId = openLanding(presenter)
        #expect(presenter.path.last?.kind == .webinarLanding)
        #expect(presenter.webinar?.routeId == routeId && presenter.webinar?.status == .loading)
        #expect(presenter.webinar?.slug == Self.slug)
        #expect(presenter.lobbyStatus == nil && presenter.lobbyMedia == nil, "no lobby, no preview")
        #expect(presenter.webinarLookupCount == 0 && presenter.liveTaskCount == 0, "nothing runs before the landing is visible")
        presenter.webinarDidAppear(routeId: routeId)
        #expect(await ent9Settle { presenter.webinar?.status == .open })
        #expect(presenter.webinar?.title == "Design Systems Week" && presenter.webinar?.hostName == "ACM-VIT")
        #expect(presenter.webinar?.tag == .live && presenter.webinar?.action == .startWatching)
        #expect(presenter.webinar?.needsName == false && presenter.webinar?.isPrimaryEnabled == true)
        #expect(presenter.webinar?.nameLimit == 40)
        try? await Task.sleep(nanoseconds: 30_000_000)
        #expect(hooks.joins.isEmpty && presenter.webinarJoinRequestCount == 0, "no join until Start Watching")
        #expect(hooks.commands.isEmpty)
        presenter.startWatching()
        #expect(hooks.joins.count == 1)
        let request = hooks.joins.first
        #expect(request?.slug == Self.slug && request?.displayName == "Avery" && request?.isGuest == true)
        #expect(request?.webinarInviteCode == nil && request?.title == "Design Systems Week")
        #expect(presenter.webinar?.status == .joining && presenter.webinar?.action == WebinarLandingAction.none)
        presenter.apply(Self.inputs(phase: .entering))
        #expect(presenter.path.last?.kind == .webinarLanding, "no lobby covers the landing while entering")
        #expect(presenter.webinar?.status == .joining)
        presenter.apply(Self.inputs(phase: .entering, socketConnected: true))
        #expect(presenter.webinar?.status == .almostThere)
        presenter.startWatching()
        #expect(hooks.joins.count == 1, "Start Watching does nothing while joining")
    }

    @Test func theNameFieldCapsAt40AndGatesStartWatching() async {
        // S10 12 l5, RECONCILE R41.
        let hooks = ENT9HookRecorder()
        let presenter = await openAnswered(Self.live(), hooks: hooks, guestName: "")
        #expect(presenter.webinar?.status == .open && presenter.webinar?.needsName == true)
        #expect(presenter.webinar?.isPrimaryEnabled == false)
        presenter.startWatching()
        #expect(hooks.joins.isEmpty)
        presenter.setWebinarName(String(repeating: "n", count: 41))
        #expect(presenter.webinarNameText.count == 40, "the 41st character is rejected")
        #expect(presenter.webinar?.isPrimaryEnabled == true)
        let published = presenter.snapshotPublishCount
        presenter.setWebinarName(String(repeating: "n", count: 40))
        #expect(presenter.snapshotPublishCount == published, "an unchanged name publishes nothing")
        presenter.startWatching()
        #expect(hooks.joins.first?.displayName.count == 40 && hooks.joins.first?.isGuest == true)
    }

    @Test func joinFailuresAfterStartWatchingShowOnTheLanding() async {
        let hooks = ENT9HookRecorder()
        let presenter = await openAnswered(Self.live(), hooks: hooks)
        presenter.startWatching()
        presenter.apply(Self.inputs(phase: .entering))
        presenter.apply(Self.inputs(phase: .outcome, outcomeId: 1, outcomeKind: .joinFailed, serverText: "Webinar is locked.",
                                    category: MeetingErrorCategory.lockedByHost.rawValue, code: "message.locked"))
        #expect(presenter.path.last?.kind == .webinarLanding && presenter.lobbyStatus == nil, "no failed lobby is pushed")
        #expect(presenter.webinar?.status == .locked && presenter.webinar?.action == .backHome)
        // A generic failure offers Try Again, which joins again with one tap.
        presenter.apply(Self.inputs(callSession: 2, phase: .entering))
        presenter.apply(Self.inputs(callSession: 2, phase: .outcome, outcomeId: 2, outcomeKind: .joinFailed,
                                    category: MeetingErrorCategory.serverUnreachable.rawValue, code: "url.unreachable"))
        #expect(presenter.webinar?.status == .failed && presenter.webinar?.failure == .join)
        #expect(presenter.webinar?.action == .tryAgain)
        presenter.retryWebinar()
        #expect(hooks.joins.count == 2)
        #expect(presenter.webinar?.status == .joining, "Try Again shows Getting You In before the session moves")
        // Back to Home ends the S1 failure with the landing (no later failed lobby).
        presenter.apply(Self.inputs(callSession: 3, phase: .entering))
        presenter.apply(Self.inputs(callSession: 3, phase: .outcome, outcomeId: 3, outcomeKind: .joinFailed,
                                    serverText: "Webinar is full."))
        #expect(presenter.webinar?.status == .full)
        presenter.webinarBackHome()
        #expect(presenter.path.isEmpty && presenter.webinar == nil)
        #expect(hooks.commands.last == PremeetingCommand.dismissOutcome.rawValue)
    }

    @Test func theWaitForTheHostRetriesOnItsOwnOnRefetch() async {
        let hooks = ENT9HookRecorder()
        let clock = ENT9Clock()
        let presenter = await openAnswered(Self.live(), hooks: hooks, clock: clock)
        presenter.startWatching()
        presenter.apply(Self.inputs(phase: .entering))
        presenter.apply(Self.inputs(phase: .outcome, outcomeId: 1, outcomeKind: .joinFailed, serverText: "Webinar is not live.",
                                    category: "unknown", code: "message.unrecognized"))
        #expect(presenter.webinar?.status == .waitingForHost && presenter.webinar?.tag == .startsSoon)
        #expect(presenter.webinarTaskCount >= 1, "the refetch keeps running while waiting for the host")
        clock.now += 10.0
        #expect(await ent9Settle { hooks.joins.count == 2 }, "the refetch that reads open retries the join")
        presenter.apply(Self.inputs(callSession: 2, phase: .entering))
        #expect(presenter.webinar?.status == .waitingForHost, "the automatic retry keeps saying it waits")
        // An ended answer ends the wait.
        presenter.apply(Self.inputs(callSession: 2, phase: .outcome, outcomeId: 2, outcomeKind: .joinFailed,
                                    serverText: "Webinar is not live."))
        hooks.answers = [Self.status(Self.live(), "ended")]
        clock.now += 10.0
        #expect(await ent9Settle { presenter.webinar?.status == .ended })
        #expect(presenter.webinarTaskCount == 0, "ended stops the refetch")
    }

    @Test func formErrorsRevealTheInviteFieldOrSayUnavailable() async {
        let hooks = ENT9HookRecorder()
        let presenter = await openAnswered(Self.live(), hooks: hooks)
        presenter.startWatching()
        presenter.apply(Self.inputs(phase: .entering))
        presenter.apply(Self.inputs(phase: .home, notice: .formError, noticeText: "Enter the webinar invite code to join."))
        #expect(presenter.webinar?.status == .open && presenter.webinar?.needsInviteCode == true)
        #expect(presenter.webinar?.inviteCodeInvalid == false && presenter.webinar?.isPrimaryEnabled == false)
        presenter.setWebinarInviteCode("SECRET")
        #expect(presenter.webinar?.isPrimaryEnabled == true)
        presenter.startWatching()
        #expect(hooks.joins.last?.webinarInviteCode == "SECRET")
        presenter.apply(Self.inputs(callSession: 2, phase: .entering))
        presenter.apply(Self.inputs(callSession: 2, phase: .home, notice: .formError,
                                    noticeText: "Invalid webinar invite code. Check it and try again."))
        #expect(presenter.webinar?.inviteCodeInvalid == true)
        presenter.setWebinarInviteCode("SECRET2")
        #expect(presenter.webinar?.inviteCodeInvalid == false)
        presenter.startWatching()
        presenter.apply(Self.inputs(callSession: 3, phase: .entering))
        presenter.apply(Self.inputs(callSession: 3, phase: .home, notice: .formError,
                                    noticeText: "No room found. Double-check the code and try again."))
        #expect(presenter.webinar?.status == .unavailable && presenter.webinar?.action == .backHome)
    }

    @Test func theLookupSaysWhenAnInviteCodeIsNeededUnlessTheLinkCarriesOne() async {
        let hooks = ENT9HookRecorder()
        let presenter = await openAnswered(Self.live(requiresInviteCode: true), hooks: hooks)
        #expect(presenter.webinar?.needsInviteCode == true)
        let withCode = ENT9HookRecorder()
        withCode.answers = [Self.live(requiresInviteCode: true)]
        withCode.repeatsLastAnswer = true
        let linked = self.presenter(hooks: withCode)
        let routeId = openLanding(linked, link: Self.link + "?inviteCode=ABC123")
        linked.webinarDidAppear(routeId: routeId)
        #expect(await ent9Settle { linked.webinar?.status == .open })
        #expect(linked.webinar?.needsInviteCode == false && linked.webinar?.isPrimaryEnabled == true)
    }

    @Test func cancelWhileJoiningReturnsToTheLandingAndBackLeaves() async {
        let hooks = ENT9HookRecorder()
        let presenter = await openAnswered(Self.live(), hooks: hooks)
        presenter.startWatching()
        presenter.apply(Self.inputs(phase: .entering))
        #expect(presenter.webinar?.status == .joining)
        presenter.cancelJoin()
        #expect(hooks.commands == [PremeetingCommand.leave.rawValue])
        #expect(presenter.webinar?.status == .open, "Cancel returns the landing to its lookup state")
        // Back while a join this landing started is under way never lets it continue unseen.
        presenter.startWatching()
        presenter.setPath([])
        #expect(hooks.commands.last == PremeetingCommand.leave.rawValue)
        #expect(presenter.webinar == nil && presenter.liveTaskCount == 0)
    }

    @Test func earlyFlipsToOpenOnTheWakeOrOnSceneActive() async {
        // S10 12 c, l6 and the 0.5 task table: one refetch while visible, one open wake-up while early.
        let hooks = ENT9HookRecorder()
        let clock = ENT9Clock()
        let presenter = await openAnswered(Self.scheduled(startsIn: 60000.0, earlyMinutes: 0), hooks: hooks, clock: clock)
        #expect(presenter.webinar?.status == .early && presenter.webinar?.tag == .startsSoon)
        #expect(presenter.webinar?.startsAtMillis == Self.t0 + 60000.0 && presenter.webinar?.action == WebinarLandingAction.none)
        #expect(presenter.webinarTaskCount == 2)
        let revision = presenter.webinar?.revision ?? 0
        presenter.webinarSceneDidChange(isActive: false)
        #expect(presenter.webinarTaskCount == 0, "nothing runs while the scene is inactive")
        #expect(presenter.webinar?.revision == revision, "the snapshot never changes for the clock alone")
        clock.now = Self.t0 + 61000.0
        presenter.webinarSceneDidChange(isActive: true)
        #expect(presenter.webinar?.status == .open, "the scene-active refresh flips the status at once")
        #expect(WebinarLandingPolicy.countdownEndMillis(startsAtMillis: Self.t0 + 60000.0, nowMillis: clock.now) == clock.now)
    }

    @Test func aFailedLookupOffersTryAgainAndAFailedRefetchKeepsTheAnswer() async {
        let hooks = ENT9HookRecorder()
        let presenter = await openAnswered(WebinarLookupAnswer.lookupFailed, hooks: hooks)
        #expect(presenter.webinar?.status == .failed && presenter.webinar?.failure == .lookup)
        #expect(presenter.webinar?.action == .tryAgain && presenter.webinarTaskCount == 0)
        hooks.answers = [Self.live()]
        presenter.retryWebinar()
        #expect(await ent9Settle { presenter.webinar?.status == .open })
        let clock = ENT9Clock()
        let other = ENT9HookRecorder()
        let kept = await openAnswered(Self.live(), hooks: other, clock: clock)
        other.answers = [WebinarLookupAnswer.lookupFailed]
        let lookups = kept.webinarLookupCount
        clock.now += 10.0
        #expect(await ent9Settle { kept.webinarLookupCount > lookups })
        #expect(kept.webinar?.status == .open, "a failed refetch keeps the last good answer")
    }

    @Test func endedAndCancelledStopTheRefetchAndGoHome() async {
        for status in ["ended", "cancelled"] {
            let hooks = ENT9HookRecorder()
            let presenter = await openAnswered(Self.status(Self.live(), status), hooks: hooks)
            #expect(presenter.webinar?.status.rawValue == status)
            #expect(presenter.webinar?.tag == .ended && presenter.webinar?.action == .backHome)
            #expect(presenter.webinarTaskCount == 0)
            presenter.webinarBackHome()
            #expect(presenter.path.isEmpty && presenter.webinar == nil)
        }
    }

    @Test func tasksStopWhenTheLandingLeaves() async {
        let hooks = ENT9HookRecorder()
        let presenter = await openAnswered(Self.live(), hooks: hooks)
        let routeId = presenter.path.last?.id ?? -1
        #expect(presenter.webinarTaskCount == 1)
        presenter.webinarDidDisappear(routeId: routeId)
        #expect(presenter.webinarTaskCount == 0)
        presenter.webinarDidAppear(routeId: routeId)
        #expect(presenter.webinarTaskCount == 1)
        presenter.setPath([])
        #expect(presenter.webinarTaskCount == 0 && presenter.webinar == nil)
        let lookups = presenter.webinarLookupCount
        try? await Task.sleep(nanoseconds: 30_000_000)
        #expect(presenter.webinarLookupCount == lookups, "no lookup after the landing left")
    }

    @Test func theAttendeeCallIsRecordedByTheLandingSlugAndTitle() async {
        let hooks = ENT9HookRecorder()
        let presenter = await openAnswered(Self.live(), hooks: hooks)
        presenter.startWatching()
        presenter.apply(Self.inputs(phase: .entering, currentRoomId: Self.slug))
        presenter.apply(Self.inputs(phase: .inCall, admitted: true, currentRoomId: "internal-room-42"))
        #expect(presenter.root.root == .call)
        let record = presenter.recentRecords.first
        #expect(record?.roomId == Self.slug && record?.title == "Design Systems Week")
        #expect(record?.isWebinar == true && record?.recentRole == .attendee)
        #expect(presenter.home.recents.isEmpty || presenter.home.recents.first?.routeKind == .webinarLanding)
    }

    // MARK: L9 fixtures (S10 12 l)

    @Test func everyWebinarFixtureOpensTheLandingThroughTheIntake() {
        let states = PremeetingFixtureState.allCases.filter { WebinarLandingFixtureScript.isWebinarFixture($0) }
        #expect(states.count == 18)
        for state in states {
            let session = PremeetingFixtureSession(state: state)
            session.start()
            defer { session.stop() }
            #expect(session.premeeting.path.last?.kind == .webinarLanding, "\(state)")
            #expect(session.premeeting.webinar?.slug == WebinarLandingFixtureScript.slug, "\(state)")
            #expect(session.premeeting.webinar?.status == .loading, "\(state): the lookup waits for the landing to appear")
            #expect(session.premeeting.webinarJoinRequestCount == 0, "\(state)")
            #expect(session.premeeting.webinarCalendarResolverDisabled == (state == .webinarNoCalendar), "\(state)")
        }
        #expect(!WebinarLandingFixtureScript.isWebinarFixture(.lobbyNewMeeting))
        #expect(PremeetingFixtureScript.state(named: "lobby-new-meeting") == .lobbyNewMeeting, "restored after batch 7")
    }

    @Test func theFixtureAnswersCoverEveryStatus() async {
        let expected: [PremeetingFixtureState: WebinarLandingStatus] = [
            .webinarEarly: .early, .webinarEarlyOneMinute: .early, .webinarEarlyShort: .early, .webinarNoCalendar: .early,
            .webinarOpen: .open, .webinarNameNeeded: .open, .webinarInviteCode: .open, .webinarEnded: .ended,
            .webinarCancelled: .cancelled, .webinarFailed: .failed, .webinarJoining: .joining,
            .webinarAlmostThere: .almostThere, .webinarWaitingHost: .waitingForHost, .webinarLocked: .locked,
            .webinarFull: .full, .webinarUnavailable: .unavailable
        ]
        for (state, status) in expected {
            let session = PremeetingFixtureSession(state: state)
            session.start()
            defer { session.stop() }
            let routeId = session.premeeting.path.last?.id ?? -1
            session.premeeting.webinarDidAppear(routeId: routeId)
            #expect(await ent9Settle(seconds: 4.0) { session.premeeting.webinar?.status == status }, "\(state)")
        }
        let early = WebinarLandingFixtureScript.answer(for: .webinarEarly, startedAtMillis: Self.t0)
        #expect(early.startsAtMillis - Self.t0 == 761000.0 && early.earlyEntryMinutes == 10)
        #expect(WebinarLandingFixtureScript.answer(for: .webinarEarlyOneMinute, startedAtMillis: Self.t0).earlyEntryMinutes == 1)
        #expect(WebinarLandingFixtureScript.guestName(for: .webinarNameNeeded).isEmpty)
    }

    @Test func theLoadingFixtureStaysLoadingAndTheToCallFixtureReachesTheCall() async {
        let loading = PremeetingFixtureSession(state: .webinarLoading)
        loading.start()
        defer { loading.stop() }
        loading.premeeting.webinarDidAppear(routeId: loading.premeeting.path.last?.id ?? -1)
        try? await Task.sleep(nanoseconds: 50_000_000)
        #expect(loading.premeeting.webinar?.status == .loading)
        let toCall = PremeetingFixtureSession(state: .webinarToCall)
        toCall.start()
        defer { toCall.stop() }
        toCall.premeeting.webinarDidAppear(routeId: toCall.premeeting.path.last?.id ?? -1)
        #expect(await ent9Settle(seconds: 6.0) { toCall.premeeting.root.root == .call })
        #expect(toCall.premeeting.recentRecords.first?.roomId == WebinarLandingFixtureScript.slug)
    }

    // MARK: Source rules (S10 12 c, d, k, l3, l7; RULES 3)

    @Test func theIOSLandingFollowsTheSpec() throws {
        let view = try ent9Source("Sources/Conclave/Features/Join/WebinarLandingView+iOS.swift")
        let countdown = try ent9Source("Sources/Conclave/Features/Join/CountdownText+iOS.swift")
        let editor = try ent9Source("Sources/Conclave/Features/Join/EventEditView+iOS.swift")
        for text in [view, countdown, editor] {
            #expect(text.hasPrefix("#if os(iOS) && !SKIP\n"))
            #expect(ent9Matches(#"(?:Text|Button|Label|navigationTitle|Section|LabeledContent)\(\s*""#, in: text).isEmpty)
            #expect(!text.contains("Image(systemName: \""))
        }
        #expect(countdown.contains("Text(timerInterval: now...end, countsDown: true)"))
        #expect(countdown.contains("WebinarLandingPolicy.countdownEndMillis("), "the range is clamped (12 l6)")
        #expect(view.contains(".listStyle(.insetGrouped)"))
        #expect(view.contains("content.safeAreaBar(edge: .bottom)") && view.contains("content.safeAreaInset(edge: .bottom, spacing: 0)"))
        #expect(view.contains(".navigationBarBackButtonHidden(isJoining)"))
        #expect(view.contains("premeeting.webinarSceneDidChange(isActive: phase == .active)"))
        #expect(view.contains("HostingTheme.statusLive"))
        #expect(view.contains("DisplayNamePolicy.capped(name)") && view.contains("ConclaveCharacterCounter("))
        #expect(view.contains("ShareLink("))
        #expect(editor.contains("EKEventEditViewController()") && editor.contains("controller.eventStore = store"))
        #expect(!view.contains("ConclaveHapticFeedback") && !view.contains("sensoryFeedback"), "no haptic on Start Watching")
    }

    @Test func theAndroidLandingFollowsTheSpec() throws {
        let screen = try ent9Source("Sources/Conclave/Skip/ui/join/WebinarLandingScreen.kt")
        let countdown = try ent9Source("Sources/Conclave/Skip/ui/join/CountdownText.kt")
        let host = ent9Flat(try ent9Source("Sources/Conclave/Skip/ui/home/PremeetingHost.kt"))
        for text in [screen, countdown] {
            #expect(ent9Matches(#"Text\(\s*""#, in: text).isEmpty)
            #expect(!text.contains("performHapticFeedback") && !text.contains("LocalHapticFeedback"))
        }
        #expect(countdown.contains("lifecycle.repeatOnLifecycle(Lifecycle.State.RESUMED)"))
        #expect(countdown.contains("clearAndSetSemantics { contentDescription = spoken }"), "spoken at most every 10 s (12 i)")
        #expect(screen.contains("catch (e: ActivityNotFoundException)") && screen.contains("\"pm_no_calendar_app\""))
        #expect(screen.contains("Intent(Intent.ACTION_INSERT, CalendarContract.Events.CONTENT_URI)"))
        #expect(screen.contains("conclavePlural(\"pm_lobby_opens\", snapshot.earlyEntryMinutes, snapshot.earlyEntryMinutes)"))
        #expect(screen.contains("BackHandler(enabled = joining) { onBack() }"))
        #expect(screen.contains("Lifecycle.Event.ON_RESUME") && screen.contains("Lifecycle.Event.ON_PAUSE"))
        #expect(screen.contains("LocalConclaveExtendedColors.current.live"))
        #expect(host.contains("is PremeetingKey.WebinarLandingKey -> WebinarLandingScreen(premeeting, key, onBack = { premeetingBack(premeeting) })"))
        #expect(host.contains("WebinarLandingPolicy.isJoining(webinar.status)) { premeeting.cancelJoin() return }"))
        #expect(!host.contains("WebinarStandInPage") && !host.contains("StandInScaffold"))
        let root = try ent9Source("Sources/Conclave/Features/Home/PremeetingRoot+iOS.swift")
        #expect(root.contains("WebinarLandingView(route: route, premeeting: premeeting)") && !root.contains("PremeetingWebinarStandIn"))
    }

    @Test func noPathRequestsMediaOrAPermissionOrHost() throws {
        // S10 12 l3, invariant 6: the landing files never ask for a permission or a preview, and the one join is an
        // attendee join with no host request and no room creation.
        let files = [
            "Sources/Conclave/Features/Join/WebinarLandingView+iOS.swift", "Sources/Conclave/Features/Join/CountdownText+iOS.swift",
            "Sources/Conclave/Features/Join/EventEditView+iOS.swift", "Sources/Conclave/Features/Join/WebinarLandingInputs.swift",
            "Sources/Conclave/Features/Join/WebinarLandingFixtures.swift", "Sources/Conclave/Features/Join/WebinarLandingProductionHooks.swift",
            "Sources/Conclave/Skip/ui/join/WebinarLandingScreen.kt", "Sources/Conclave/Skip/ui/join/CountdownText.kt"
        ]
        for file in files {
            let text = try ent9Source(file)
            for pattern in ["requestAccess(", "requestFullAccessToEvents", "requestWriteOnlyAccessToEvents", "requestRecordPermission",
                            "requestCameraPermission", "requestPermissions(", "requestAuthorization(", "startPreview",
                            "LocalPreviewController", "setEntryMediaIntent"] {
                #expect(!text.contains(pattern), "\(file) uses \(pattern)")
            }
            #expect(!text.contains("\u{2013}") && !text.contains("\u{2014}"), "\(file) has an en or em dash")
            #expect(!text.lowercased().contains("gradient"), "\(file)")
            #expect(ent9Matches(#"(UIColor|Color)\(\s*(red:|\.sRGB|0x|hue:)"#, in: text).isEmpty, "\(file)")
        }
        let hooks = ent9Flat(try ent9Source("Sources/Conclave/Features/Join/WebinarLandingProductionHooks.swift"))
        #expect(hooks.contains("socketDisplayName: nil"))
        #expect(hooks.contains("isHost: false, joinMode: JoinMode.webinarAttendee, meetingInviteCode: nil"))
        #expect(hooks.contains("allowRoomCreation: false"))
        #expect(hooks.contains("viewModel.state.webinarTitle = request.title viewModel.joinRoom("), "the title before the join (SC22)")
        let wiring = try ent9Source("Sources/Conclave/Features/Home/PremeetingAppWiring.swift")
        #expect(wiring.contains("WebinarLandingProductionHooks.install(presenter: presenter, viewModel: viewModel, appState: appState)"))
        // Shared files stay transpilable.
        for file in ["Sources/Conclave/Features/Join/WebinarLandingInputs.swift", "Sources/Conclave/Features/Join/WebinarLandingFixtures.swift",
                     "Sources/Conclave/Features/Join/WebinarLandingProductionHooks.swift",
                     "Sources/Conclave/Core/Networking/NativeWebinarLookupService.swift"] {
            let text = try ent9Source(file)
            #expect(!text.contains("import SwiftUI") && !text.contains("import UIKit"), "\(file)")
            #expect(ent9Matches(#"\.(?:map|compactMap|flatMap)\(\s*[A-Za-z_][A-Za-z0-9_.]*\s*\)"#, in: text).isEmpty, "\(file)")
            #expect(!text.contains(".isLetter"), "\(file)")
        }
    }
}

/// A clock the tests move (the presenter reads it through `nowMillis`).
final class ENT9Clock {
    var now = 1793102400000.0
}

/// Records the landing's hooks (no network, no call) and the presenter's commands.
@MainActor
private final class ENT9HookRecorder {
    let hooks = WebinarLandingHooks()
    var answers: [WebinarLookupAnswer] = []
    var repeatsLastAnswer = false
    var lookups: [String] = []
    var joins: [WebinarJoinRequest] = []
    var commands: [String] = []

    init() {
        // Weak captures: a presenter task that outlives a failed test never touches a freed recorder.
        hooks.lookup = { [weak self] slug, clientId in
            guard let self else { return WebinarLookupAnswer.lookupFailed }
            self.lookups.append(slug + "|" + clientId)
            if self.answers.count > 1 {
                return self.answers.removeFirst()
            }
            if let last = self.answers.first {
                if !self.repeatsLastAnswer {
                    self.answers.removeFirst()
                }
                return last
            }
            return WebinarLookupAnswer.lookupFailed
        }
        hooks.join = { [weak self] request in
            self?.joins.append(request)
        }
    }
}

private func ent9Settle(seconds: Double = 2.0, _ condition: () -> Bool) async -> Bool {
    let attempts = Int(seconds * 500.0)
    for _ in 0..<attempts {
        if condition() { return true }
        try? await Task.sleep(nanoseconds: 2_000_000)
    }
    return condition()
}

private func ent9Source(_ packageRelativePath: String) throws -> String {
    let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
    return try String(contentsOf: root.appendingPathComponent(packageRelativePath), encoding: .utf8)
}

/// Whitespace collapsed to single spaces, so a pin fails only when the code changes.
private func ent9Flat(_ text: String) -> String {
    text.split(whereSeparator: { $0.isWhitespace }).joined(separator: " ")
}

private func ent9Matches(_ pattern: String, in text: String) -> [String] {
    guard let regex = try? NSRegularExpression(pattern: pattern) else { return [] }
    let range = NSRange(text.startIndex..<text.endIndex, in: text)
    var found: [String] = []
    for match in regex.matches(in: text, range: range) {
        if let span = Range(match.range, in: text) {
            found.append(String(text[span]))
        }
    }
    return found
}
