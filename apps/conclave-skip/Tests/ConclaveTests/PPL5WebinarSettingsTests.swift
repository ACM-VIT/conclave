#if !SKIP
import Foundation
import Testing
@testable import Conclave

/// PPL-5 (OUT/PLAN-screens.md section 5): Webinar Settings and webinar People for hosts. PH10 `qaEnabled` decoding, the
/// webinar host sections (attendee hand queue by `raisedAt`, panelists, invited rows, the queue-known footer), Bring on
/// Stage and Cancel Invite through the one ledger (PH2, PH8), Move to Audience only for role participant, the PH9
/// interim invite rules (Q15), the Webinar Settings field rules (capacity, custom link), the Host Controls webinar seams
/// (Attendee Q&A switch, rotation serial, field saves), the S20 Q10 attendee hand capability in S1, and source pins for
/// the socket surface on every platform file and the platform pages. Nothing here runs a socket or a view.
@MainActor
struct PPL5WebinarSettingsTests {
    private let me = "u-ishaan"

    private final class CommandLog {
        var commands: [PeopleCommand] = []
        var tickets: [HostActionTicket] = []
    }

    private func webinarPeople(queue: [PeopleWebinarHandInput] = [], invites: [PeopleStageInviteInput] = [],
                               queueKnown: Bool = true, attendees: Int = 128,
                               phase: String = MeetingPhaseKind.inCall.rawValue) -> (PeoplePresenter, CommandLog) {
        let shell = MeetingShellPresenter()
        let people = PeoplePresenter(shell: shell, stage: StagePresenter(shell: shell))
        let log = CommandLog()
        people.onCommand = { command, ticket in
            log.commands.append(command)
            log.tickets.append(ticket)
        }
        people.platform = NoticePlatform.ios
        people.apply(inputs(queue: queue, invites: invites, queueKnown: queueKnown, attendees: attendees, phase: phase))
        return (people, log)
    }

    private func inputs(queue: [PeopleWebinarHandInput], invites: [PeopleStageInviteInput], queueKnown: Bool, attendees: Int,
                        phase: String = MeetingPhaseKind.inCall.rawValue, webinar: Bool = true) -> PeopleInputs {
        PeopleInputs.make(
            callSession: 1, attempt: 1, phase: phase, localUserId: me,
            participants: [
                PeopleParticipantInput.make(userId: me, displayName: "Ishaan", isLocal: true),
                PeopleParticipantInput.make(userId: "u-avery", displayName: "Avery Lee", joinSerial: 1),
                PeopleParticipantInput.make(userId: "u-lee", displayName: "Lee Park", isMuted: false, isScreenSharing: true,
                                            joinSerial: 2),
            ],
            isRosterLoaded: true, isAdmin: true, hostUserId: me, hostUserIds: [me, "u-avery"],
            isWebinarEnabled: webinar, isWebinarQaEnabled: true, webinarAttendeeCount: attendees, supportsMoveToAudience: true,
            webinarHandQueue: queue, webinarQueueKnown: queueKnown, stageInvites: invites)
    }

    private static let fourHands: [PeopleWebinarHandInput] = [
        PeopleWebinarHandInput.make(userId: "a-jo", displayName: "Jo B.", raisedAtMillis: 4000.0),
        PeopleWebinarHandInput.make(userId: "a-priya", displayName: "Priya N.", raisedAtMillis: 1000.0),
        PeopleWebinarHandInput.make(userId: "a-mina", displayName: "Mina T.", raisedAtMillis: 3000.0),
        PeopleWebinarHandInput.make(userId: "a-omar", displayName: "Omar K.", raisedAtMillis: 2000.0),
    ]

    // MARK: PH10

    @Test func qaEnabledDecodesFromTheConfigAndTheJoinAck() throws {
        let config = try JSONDecoder().decode(WebinarConfigSnapshot.self, from: Data(#"{"enabled":true,"qaEnabled":false}"#.utf8))
        #expect(config.qaEnabled == false)
        let absent = try JSONDecoder().decode(WebinarConfigSnapshot.self, from: Data(#"{"enabled":true}"#.utf8))
        #expect(absent.qaEnabled == nil)
        let encoded = try JSONEncoder().encode(WebinarConfigSnapshot(roomId: nil, enabled: true, publicAccess: nil, locked: nil,
                                                                     maxAttendees: nil, attendeeCount: nil, requiresInviteCode: nil,
                                                                     linkSlug: nil, feedMode: nil, qaEnabled: true))
        #expect(String(decoding: encoded, as: UTF8.self).contains("\"qaEnabled\":true"))
        let join = try JSONDecoder().decode(JoinRoomResponse.self,
                                            from: Data(#"{"status":"waiting","webinarQaEnabled":true}"#.utf8))
        #expect(join.webinarQaEnabled == true)
    }

    // MARK: S50 10: webinar People for hosts

    @Test func webinarHostsSeeTheQueueByRaisedAtThenPanelistsThenAttendees() {
        let (people, _) = webinarPeople(queue: Self.fourHands)
        let ids = people.snapshot.sections.map(\.id)
        #expect(ids == ["raisedHands", "panelists", "attendees"])
        let queue = people.snapshot.section(.raisedHands)
        #expect(queue?.rowIds == ["attendee:a-priya", "attendee:a-omar", "attendee:a-mina", "attendee:a-jo"])
        let priya = people.rows.entry(for: "attendee:a-priya").model
        #expect(priya.serverId == "a-priya")
        #expect(priya.role == .attendee && priya.detail == .attendee)
        #expect(priya.handOrder == 1 && priya.isHandRaised)
        #expect(priya.actions.map(\.action) == [.bringOnStage])
        // The meeting Raised Hands section is not shown in webinar mode; panelists are the roster rows.
        #expect(people.snapshot.section(.panelists)?.rowIds.contains("u-lee") == true)
        #expect(people.snapshot.section(.inMeeting) == nil)
    }

    @Test func attendeeCountChangesPublishNoPeopleRevision() {
        let (people, _) = webinarPeople(queue: Self.fourHands)
        let revision = people.snapshot.revision
        for count in 1...50 {
            people.apply(inputs(queue: Self.fourHands, invites: [], queueKnown: true, attendees: 100 + count))
        }
        #expect(people.snapshot.revision == revision)
        #expect(people.attendeeCount == 150)
    }

    @Test func bringOnStageIsOneTicketedCommandWithThePendingRow() {
        let (people, log) = webinarPeople(queue: Self.fourHands)
        #expect(people.perform(.bringOnStage, rowId: "attendee:a-priya", source: PeopleActionSource.rowMenu) == .dispatched)
        #expect(log.commands.count == 1)
        #expect(log.commands[0].kind == .bringOnStage && log.commands[0].targetId == "a-priya")
        #expect(people.rows.entry(for: "attendee:a-priya").model.pendingAction == PersonActionID.bringOnStage.rawValue)
        // A duplicate tap emits nothing.
        #expect(people.perform(.bringOnStage, rowId: "attendee:a-priya", source: PeopleActionSource.rowMenu) == .ignored)
        #expect(log.commands.count == 1)
        #expect(people.finish(log.tickets[0], HostActionResult.completed))
        #expect(people.feedbackState.token.kind == .hostInvitedToStage)
        #expect(people.stage.announcement?.kind == PeopleAnnouncementKind.invitedToStage)
    }

    @Test func aGoneAttendeeMapsToTheNoLongerWatchingSentence() {
        let (people, log) = webinarPeople(queue: Self.fourHands)
        people.perform(.bringOnStage, rowId: "attendee:a-omar", source: PeopleActionSource.rowMenu)
        people.finish(log.tickets[0], HostActionResult.failed(.notFound))
        let failure = people.lastFailure
        #expect(failure?.sourceKey == "attendee:a-omar")
        #expect(PeopleFailureCopy.kind(action: failure?.action ?? "", failure: failure?.failure ?? "",
                                       sourceKey: failure?.sourceKey ?? "") == PeopleFailureCopy.inviteGone)
        #expect(HostActionFailurePolicy.failure(message: "Attendee not found") == .notFound)
    }

    @Test func invitedRowsCancelThroughTheDemoteCommand() {
        let invite = PeopleStageInviteInput(userId: "a-mina", displayName: "Mina T.")
        let (people, log) = webinarPeople(queue: [], invites: [invite])
        #expect(people.snapshot.section(.attendees)?.rowIds == ["attendee:a-mina"])
        let row = people.rows.entry(for: "attendee:a-mina").model
        #expect(row.detail == .stageInvited && row.actions.map(\.action) == [.cancelStageInvite])
        people.perform(.cancelStageInvite, rowId: "attendee:a-mina", source: PeopleActionSource.rowMenu)
        #expect(log.commands.last?.kind == .cancelStageInvite && log.commands.last?.targetId == "a-mina")
    }

    @Test func moveToAudienceIsOfferedOnlyForParticipantPanelists() {
        let (people, _) = webinarPeople()
        let lee = people.rows.entry(for: "u-lee").model.actions.map(\.action)
        let avery = people.rows.entry(for: "u-avery").model.actions.map(\.action)
        #expect(lee.contains(.moveToAudience))
        // The SFU refuses any admin target, co-hosts included (webinarInteractionHandlers.ts:411-417).
        #expect(!avery.contains(.moveToAudience))
    }

    @Test func theFooterFollowsTheQueueAndTheWatchingCount() {
        #expect(WebinarPeoplePolicy.footer(attendeeCount: 0, queueCount: 0, invitedCount: 0, queueKnown: true) == .empty)
        #expect(WebinarPeoplePolicy.footer(attendeeCount: 128, queueCount: 0, invitedCount: 0, queueKnown: true) == .quiet)
        #expect(WebinarPeoplePolicy.footer(attendeeCount: 128, queueCount: 2, invitedCount: 0, queueKnown: false) == .queuePending)
        let (people, _) = webinarPeople(queueKnown: false)
        #expect(!people.snapshot.webinarQueueKnown)
    }

    @Test func recoveryDisablesBringOnStageWithTheReason() {
        let (people, log) = webinarPeople(queue: Self.fourHands, phase: MeetingPhaseKind.recovering.rawValue)
        let action = people.rows.entry(for: "attendee:a-priya").model.actions.first
        #expect(action?.isEnabled == false && action?.reason == MeetingBlockedReason.reconnecting.rawValue)
        #expect(people.perform(.bringOnStage, rowId: "attendee:a-priya", source: PeopleActionSource.rowMenu) == .ignored)
        #expect(log.commands.isEmpty)
    }

    @Test func meetingModeKeepsTheMeetingSections() {
        let shell = MeetingShellPresenter()
        let people = PeoplePresenter(shell: shell, stage: StagePresenter(shell: shell))
        people.apply(inputs(queue: Self.fourHands, invites: [], queueKnown: true, attendees: 0, webinar: false))
        #expect(people.snapshot.section(.inMeeting) != nil)
        #expect(people.snapshot.section(.panelists) == nil)
        #expect(!people.rows.contains("attendee:a-priya"))
    }

    // MARK: PH9 interim invites (Q15)

    @Test func interimInvitesFollowEachRemovalRule() {
        var invites = WebinarStageInvitePolicy.added([:], userId: "a-mina#s1", name: "Mina T.")
        #expect(invites["a-mina#s1"] == "Mina T.")
        // A new hand from the invited attendee removes the invite.
        #expect(WebinarStageInvitePolicy.afterQueue(invites, previousQueueIds: [], queueIds: ["a-mina#s1"]).isEmpty)
        #expect(WebinarStageInvitePolicy.afterQueue(invites, previousQueueIds: ["a-mina#s1"], queueIds: ["a-mina#s1"]).count == 1)
        // A panelist join with the same user key means they accepted.
        #expect(WebinarStageInvitePolicy.afterPanelistJoin(invites, joinedUserId: "a-mina#s2").isEmpty)
        #expect(WebinarStageInvitePolicy.afterPanelistJoin(invites, joinedUserId: "u-lee#s1").count == 1)
        // Webinar mode off clears them; Cancel Invite removes one.
        #expect(WebinarStageInvitePolicy.afterWebinarMode(invites, isWebinarEnabled: false).isEmpty)
        invites = WebinarStageInvitePolicy.added(invites, userId: "a-jo#s1", name: "Jo B.")
        #expect(WebinarStageInvitePolicy.removed(invites, userId: "a-jo#s1").count == 1)
        #expect(WebinarStageInvitePolicy.rows(invites).map(\.displayName) == ["Jo B.", "Mina T."])
    }

    // MARK: S50 9: Webinar Settings rules

    @Test func capacityRejectsZeroOverTheCapAndLetters() {
        #expect(WebinarSettingsPolicy.showsCapacityError("0"))
        #expect(WebinarSettingsPolicy.showsCapacityError("5001"))
        #expect(WebinarSettingsPolicy.showsCapacityError("abc"))
        #expect(!WebinarSettingsPolicy.showsCapacityError(""))
        #expect(!WebinarSettingsPolicy.showsCapacityError("500"))
        #expect(WebinarSettingsPolicy.capacityToCommit("500", current: 500) == nil)
        #expect(WebinarSettingsPolicy.capacityToCommit("750", current: 500) == 750)
    }

    @Test func theCustomLinkIsSanitizedLiveAndNeedsThreeCharacters() {
        #expect(WebinarSettingsPolicy.sanitizedSlug("Design Week_2026!") == "designweek2026")
        #expect(WebinarSettingsPolicy.sanitizedSlug(String(repeating: "a", count: 40)).count == 32)
        #expect(!WebinarSettingsPolicy.canSaveSlug("ab", isPending: false, isBlocked: false))
        #expect(WebinarSettingsPolicy.canSaveSlug("design-week", isPending: false, isBlocked: false))
        #expect(!WebinarSettingsPolicy.canSaveSlug("design-week", isPending: true, isBlocked: false))
    }

    @Test func hostControlsDispatchTheAttendeeQaSwitchAndReportFieldSaves() {
        let (people, log) = webinarPeople()
        let host = people.host
        host.apply(HostControlsInputs.make(callSession: 1, isWebinarEnabled: true, webinarMaxAttendees: 500,
                                           isWebinarQaEnabled: true))
        #expect(host.snapshot.policy(.webinarQa)?.shownOn == true)
        #expect(host.isWebinarSettingsReachable)
        #expect(host.setPolicy(.webinarQa, on: false) == .dispatched)
        #expect(log.commands.last?.kind == .setPolicy && log.commands.last?.text == HostPolicyID.webinarQa.rawValue)
        #expect(host.setMaxAttendees(750) == .dispatched)
        #expect(host.snapshot.isFieldPending(HostFieldID.capacity))
        let saved = host.snapshot.savedSerial
        people.finish(log.tickets[log.tickets.count - 1], HostActionResult.completed)
        #expect(host.snapshot.savedSerial == saved + 1 && host.snapshot.savedField == HostFieldID.capacity)
        #expect(host.drafts.capacity == "750")
        // A rotation acknowledgement bumps the serial the views copy and announce on.
        host.requestRotateLink()
        let confirmation = people.confirmation
        #expect(confirmation?.kind == .rotateWebinarLink)
        people.confirm(id: confirmation?.id ?? 0, block: false)
        let rotated = host.snapshot.rotatedLinkSerial
        people.finish(log.tickets[log.tickets.count - 1], HostActionResult.completed)
        #expect(host.snapshot.rotatedLinkSerial == rotated + 1)
        // Webinar mode off makes the webinar pages unreachable (they pop, S50 9 f).
        host.apply(HostControlsInputs.make(callSession: 1, isWebinarEnabled: false))
        #expect(!host.isWebinarSettingsReachable)
    }

    // MARK: S20 Q10: the attendee hand in S1

    @Test func theAttendeeHandRowFollowsTheCapability() {
        let shell = MeetingShellPresenter()
        let identity = MeetingSessionIdentity(callSession: 1, attempt: 1, attemptToken: "t-1-1")
        shell.apply(MeetingShellInputs.make(identity: identity, connectionState: .joined, isWebinarAttendee: true))
        var hand = shell.controls.rows.first(where: { $0.id == MeetingControlID.hand.rawValue })
        #expect(hand?.isVisible == false && hand?.blockedReason == .attendee)
        #expect(shell.toggleHand() == .unavailable)
        shell.apply(MeetingShellInputs.make(identity: identity, connectionState: .joined, isWebinarAttendee: true,
                                            attendeeCanRaiseHand: true))
        hand = shell.controls.rows.first(where: { $0.id == MeetingControlID.hand.rawValue })
        #expect(hand?.isVisible == true && hand?.isEnabled == true)
        // The microphone stays attendee-blocked: only the hand gains a path.
        let mic = shell.controls.rows.first(where: { $0.id == MeetingControlID.microphone.rawValue })
        #expect(mic?.blockedReason == .attendee)
    }

    // MARK: Source pins (socket surface, view model, platform pages)

    @Test func everySocketFileCarriesTheWebinarSurface() throws {
        let ios = try ppl5Source("Sources/Conclave/Core/Networking/SocketIOManager.swift")
        let symbol = try ppl5Source("Sources/Conclave/Core/Networking/SocketIOManager+Android.swift")
        let mac = try ppl5Source("Sources/Conclave/Core/Networking/SocketIOManager+macOS.swift")
        let kotlin = try ppl5Source("Sources/Conclave/Skip/SocketIOManager+Android.kt")
        for name in ["func updateWebinarQaEnabled(", "func promoteWebinarAttendee(userId: String)",
                     "func demoteWebinarParticipant(userId: String)", "func setWebinarHandRaised(", "func declineWebinarStage()",
                     "func submitWebinarQuestion(", "func upvoteWebinarQuestion(id: String)", "func moderateWebinarQuestion("] {
            #expect(ios.contains(name), "iOS \(name)")
            #expect(symbol.contains(name), "symbol file \(name)")
            #expect(mac.contains(name), "macOS stub \(name)")
        }
        for callback in ["var onWebinarQaChanged", "var onWebinarQaSnapshot", "var onWebinarHandQueueChanged",
                         "var onWebinarPromoted", "var onWebinarDemoted"] {
            #expect(symbol.contains(callback), "symbol file \(callback)")
            #expect(mac.contains(callback), "macOS stub \(callback)")
        }
        // `webinar:declineStage` is a `(callback)` handler: ack-only on both clients (AGENTS "Socket Ack Shapes").
        #expect(ios.contains("emitAckOnly(event: SocketEvent.webinarDeclineStage)"))
        #expect(kotlin.contains("emitAckOnly(SocketEvent.webinarDeclineStage)"))
        #expect(kotlin.contains("webinarQaEnabled = boolField(obj, \"webinarQaEnabled\")"))
        #expect(kotlin.contains("updateWebinarConfig(JSONObject().put(\"qaEnabled\", enabled))"))
    }

    @Test func theViewModelRoutesEveryWebinarCommand() throws {
        let vm = try ppl5Source("Sources/Conclave/Features/Meeting/MeetingViewModel.swift")
        #expect(!vm.contains("PH7 to PH9 (PPL-5, PPL-6) add these emitters"))
        #expect(vm.contains("supportsMoveToAudience: true"))
        #expect(vm.contains("setWebinarQaEnabled(on, onResult: finish)"))
        #expect(vm.contains("promoteWebinarAttendee(userId: target, name: name, onResult: finish)"))
        #expect(vm.contains("demoteWebinarParticipant(userId: target, isInviteCancel: true, onResult: finish)"))
        #expect(vm.contains("socketManager.onWebinarHandQueueChanged = {"))
        #expect(vm.contains("attendeeCanRaiseHand: attendeeCanRaiseHand"))
        #expect(vm.contains("state.isWebinarQaEnabled = response.webinarQaEnabled ?? false"))
        let state = try ppl5Source("Sources/Conclave/Core/State/MeetingState.swift")
        #expect(state.contains("if !webinarHandQueue.isEmpty { webinarHandQueue = [] }"), "PH11 clears the queue with the host role")
    }

    @Test func thePlatformPagesRouteTheWebinarRoutes() throws {
        let iosHost = try ppl5Source("Sources/Conclave/Features/Meeting/Host/HostControlsContent+iOS.swift")
        #expect(iosHost.contains("WebinarSettingsPage(people: people, link: link)"))
        #expect(!iosHost.contains("HostPendingPage"))
        let kotlinHost = try ppl5Source("Sources/Conclave/Skip/ui/host/HostControlsContent.kt")
        #expect(kotlinHost.contains("PeopleRoute.webinar.rawValue -> WebinarSettingsPage(people, reservation, snackbar, onPush, onPop)"))
        let iosPages = try ppl5Source("Sources/Conclave/Features/Meeting/Webinar/WebinarSettingsPages+iOS.swift")
        #expect(iosPages.contains(".keyboardType(.numberPad)") && iosPages.contains("ToolbarItemGroup(placement: .keyboard)"))
        #expect(iosPages.contains(".conclaveGestureFeedback(.linkCopied, trigger: copyFeedback)"))
        let kotlinPages = try ppl5Source("Sources/Conclave/Skip/ui/host/WebinarSettingsPages.kt")
        #expect(kotlinPages.contains("ConclaveTextEntryKind.number") && kotlinPages.contains("Build.VERSION.SDK_INT < 33"))
        let iosPeople = try ppl5Source("Sources/Conclave/Features/Meeting/Webinar/WebinarPeopleSection+iOS.swift")
        #expect(iosPeople.contains(".buttonStyle(.bordered)") && iosPeople.contains(".tint(.primary)"))
        #expect(iosPeople.contains(".swipeActions(edge: .leading, allowsFullSwipe: false)"))
        let kotlinPeople = try ppl5Source("Sources/Conclave/Skip/ui/people/WebinarPeopleSection.kt")
        #expect(kotlinPeople.contains("FilledTonalButton(onClick = perform"))
        for path in ["Sources/Conclave/Features/Meeting/Webinar/WebinarPeopleModels.swift",
                     "Sources/Conclave/Features/Meeting/Webinar/WebinarSettingsPages+iOS.swift",
                     "Sources/Conclave/Features/Meeting/Webinar/WebinarPeopleSection+iOS.swift",
                     "Sources/Conclave/Skip/ui/host/WebinarSettingsPages.kt",
                     "Sources/Conclave/Skip/ui/people/WebinarPeopleSection.kt"] {
            let source = try ppl5Source(path)
            #expect(!source.lowercased().contains("gradient"), "\(path) draws a gradient")
            #expect(!source.contains("\u{2014}") && !source.contains("\u{2013}"), "\(path) has a long dash")
            #expect(!source.contains("Color(red:") && !source.contains("Color(0x"), "\(path) has a color literal")
            #expect(!source.contains("Image(systemName: \""), "\(path) names a raw symbol")
        }
    }
}

private func ppl5Source(_ packageRelativePath: String) throws -> String {
    let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
    return try String(contentsOf: root.appendingPathComponent(packageRelativePath).standardizedFileURL, encoding: .utf8)
}
#endif
