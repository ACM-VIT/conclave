#if !SKIP
import Foundation
import Testing
@testable import Conclave

/// CTL-2 (OUT/PLAN-screens.md section 5): Leave and End call for everyone. The shared Leave policy, the presenter's End
/// path and notices, and the CL13 End fixtures run here against the real S1 shell and the real STG-5 notice center; the
/// iOS and Kotlin views are read. The Kotlin half is T/Skip/CTL2LeaveEndBridgeTests.kt. Covers S30 4 l (unit halves of
/// l1 to l4, l6, l7, l9), 4 f (states), 4 h (no Leave haptic, the prompt once per confirmation), CC7, CC16 (`end.dialog`,
/// `leave.menu`, `bar.hold`), CL15 and RECONCILE R8 (menu order), R6 (S30 4 g copy), R09 and S50 PH17 (the dialog belongs
/// to its invoker), S1C DUP (S1-DUP-02: a double confirm dispatches End once) and the delayed End acknowledgment fixture.
/// Not run in the heads-down push.
@MainActor
struct CTL2LeaveEndTests {
    // MARK: Harness

    static let identity = MeetingSessionIdentity(callSession: 1, attempt: 1, attemptToken: "ctl2-tests")

    static func joined(isAdmin: Bool = false, isWebinarAttendee: Bool = false, isNetworkOffline: Bool = false,
                       identity: MeetingSessionIdentity = CTL2LeaveEndTests.identity) -> MeetingShellInputs {
        MeetingShellInputs.make(identity: identity, connectionState: .joined, isNetworkOffline: isNetworkOffline,
                                roomId: "abc-defg-hij", displayName: "You", isAdmin: isAdmin, isWebinarAttendee: isWebinarAttendee,
                                isMuted: false, isCameraOff: false)
    }

    /// Recovery after admission (the phase is `recovering`).
    static func recovering(isAdmin: Bool) -> MeetingShellInputs {
        MeetingShellInputs.make(identity: identity, connectionState: .reconnecting, isRecoveringConnection: true,
                                roomId: "abc-defg-hij", displayName: "You", isAdmin: isAdmin, isMuted: false, isCameraOff: false)
    }

    static let titles = LeaveMenuTitles(leave: "Leave", endForEveryone: "End\u{2026}", reconnecting: "R", offline: "O", ending: "N")

    static func snapshot(id: Int = 0, invoker: String = "", showsEnd: Bool = true, canEnd: Bool = true,
                         reason: ControlBlockedReason = .none, leaving: Bool = false) -> LeaveSnapshot {
        LeaveSnapshot(revision: 1, canEndForEveryone: canEnd, leavePhase: leaving ? .leaving : .idle,
                      endPhase: id == 0 ? .idle : .confirming, confirmationId: id, confirmationInvoker: invoker, offersRecap: false,
                      endFailure: "none", showsEndForEveryone: showsEnd, endBlockedReason: reason)
    }

    /// A standalone shell, stage and controls presenter. `publishHook` mirrors HD/requests/B5-T3.md R1 (the view model
    /// refreshes the controls after an S1 publish an intent caused); without it only the presenter's own re-read runs.
    @MainActor
    final class Harness {
        let shell: MeetingShellPresenter
        let stage: StagePresenter
        let controls: CallControlsPresenter
        var commands: [MeetingShellCommand] = []
        var tickets: [MeetingActionTicket] = []

        init(_ inputs: MeetingShellInputs, admitFirst: MeetingShellInputs? = nil, publishHook: Bool = true) {
            let owner = MeetingShellPresenter()
            let stagePresenter = StagePresenter(shell: owner)
            shell = owner
            stage = stagePresenter
            controls = CallControlsPresenter(shell: owner, stage: stagePresenter)
            shell.onCommand = { [weak self] command, ticket in
                self?.commands.append(command)
                if let ticket { self?.tickets.append(ticket) }
            }
            if publishHook {
                shell.onPublish = { [weak self] _, _, _ in self?.refresh() }
            }
            if let admitFirst { shell.apply(admitFirst) }
            shell.apply(inputs)
            refresh()
        }

        func refresh() {
            controls.apply(CallControlsInputs.fromShell(shell))
        }

        func push(_ inputs: MeetingShellInputs) {
            shell.apply(inputs)
            refresh()
        }

        var leave: LeaveSnapshot { controls.leaveState }
        var endCommands: Int { commands.filter { $0 == .endForEveryone }.count }

        func lastTicket(_ kind: MeetingActionKind) -> MeetingActionTicket? {
            tickets.last { $0.kind == kind }
        }

        /// Asks for End from the Leave menu and confirms it; returns the confirmation id.
        @discardableResult
        func requestAndConfirmEnd() -> Int {
            _ = controls.selectLeaveMenuItem(LeaveControlPolicy.endItemId)
            let id = leave.confirmationId
            _ = controls.confirmEndForEveryone(id: id, postRecap: false)
            return id
        }
    }

    // MARK: S30 4 f: who gets which Leave

    @Test func leaveSnapshotCarriesTheHostMenuFacts() {
        // Guest: one tap, no menu, no End action, no shortcut on the bar (4 l1, l9).
        let guest = Harness(Self.joined())
        #expect(!guest.leave.showsEndForEveryone && !guest.leave.canEndForEveryone && guest.leave.endBlockedReason == .none)
        #expect(!LeaveControlPolicy.showsHostMenu(guest.leave, isAccessibilityText: false))
        #expect(!LeaveControlPolicy.offersEndAction(guest.leave))
        #expect(guest.controls.bar.control(.leave)?.hasShortcut == false)
        // Host: the long-press menu and the accessibility action; at accessibility sizes only the action (4 l6).
        let host = Harness(Self.joined(isAdmin: true))
        #expect(host.leave.showsEndForEveryone && host.leave.canEndForEveryone && host.leave.endBlockedReason == .none)
        #expect(LeaveControlPolicy.showsHostMenu(host.leave, isAccessibilityText: false))
        #expect(!LeaveControlPolicy.showsHostMenu(host.leave, isAccessibilityText: true))
        #expect(LeaveControlPolicy.offersEndAction(host.leave))
        #expect(host.controls.bar.control(.leave)?.hasShortcut == true)
        // Recovering host: the menu stays with End disabled and its reason; Leave stays enabled (4 l7).
        let recovering = Harness(Self.recovering(isAdmin: true), admitFirst: Self.joined(isAdmin: true))
        #expect(recovering.leave.showsEndForEveryone && !recovering.leave.canEndForEveryone)
        #expect(recovering.leave.endBlockedReason == .reconnecting)
        #expect(LeaveControlPolicy.showsHostMenu(recovering.leave, isAccessibilityText: false))
        #expect(!LeaveControlPolicy.offersEndAction(recovering.leave))
        #expect(recovering.controls.bar.control(.leave)?.isBlocked == false && recovering.controls.bar.control(.leave)?.hasShortcut == true)
        // Offline host: End blocked with the offline reason even though the socket still counts as joined.
        let offline = Harness(Self.joined(isAdmin: true, isNetworkOffline: true))
        #expect(offline.leave.endBlockedReason == .offline && !LeaveControlPolicy.offersEndAction(offline.leave))
        // Webinar attendee: Leave only (4 f, Owner OQ3).
        let attendee = Harness(Self.joined(isAdmin: true, isWebinarAttendee: true))
        #expect(!attendee.leave.showsEndForEveryone && !LeaveControlPolicy.showsHostMenu(attendee.leave, isAccessibilityText: false))
        // Nothing opens while leaving.
        #expect(!LeaveControlPolicy.showsHostMenu(Self.snapshot(leaving: true), isAccessibilityText: false))
        #expect(!LeaveControlPolicy.offersEndAction(Self.snapshot(leaving: true)))
    }

    // MARK: CL15, RECONCILE R8: the host menu rows

    @Test func menuRowsFollowEachPlatformsOrderWithoutIcons() throws {
        let host = Self.snapshot()
        let ios = LeaveControlPolicy.menuSections(host, titles: Self.titles, endOnTop: false)
        #expect(ios.map { section in section.items.map { $0.id } } == [["leave"], ["endForEveryone"]])
        // iOS: Leave Call nearest the control, End farthest after a separator (F00 C16 c).
        #expect(ConclaveMenuPolicy.destructiveItemsAreLast(ios))
        let android = LeaveControlPolicy.menuSections(host, titles: Self.titles, endOnTop: true)
        // Android: End on top (farthest from the thumb, the menu opens above the bar), a divider, then Leave call.
        #expect(android.map { section in section.items.map { $0.id } } == [["endForEveryone"], ["leave"]])
        for sections in [ios, android] {
            for section in sections {
                #expect(ConclaveMenuPolicy.isIconConsistent(section))
                for item in section.items {
                    #expect(item.concept.isEmpty, "\(item.id) has an icon")
                    #expect(item.role == (item.id == LeaveControlPolicy.endItemId ? MenuItemRole.destructive : MenuItemRole.normal))
                    #expect(item.isEnabled && item.disabledReason.isEmpty)
                }
            }
        }
        // Safe accessors and requires instead of `[0]` and `[1]`: a missing section or row fails the test instead of
        // trapping and aborting the whole test process.
        #expect(ios.dropFirst().first?.items.first?.title == "End\u{2026}" && ios.first?.items.first?.title == "Leave")
        // A blocked End stays, disabled, with its reason line (R10).
        func endItem(_ reason: ControlBlockedReason) throws -> MenuItemModel {
            let sections = LeaveControlPolicy.menuSections(Self.snapshot(canEnd: reason == .offline, reason: reason),
                                                           titles: Self.titles, endOnTop: true)
            return try #require(sections.first?.items.first)
        }
        let reconnecting = try endItem(.reconnecting)
        #expect(!reconnecting.isEnabled && reconnecting.disabledReason == "R")
        let offline = try endItem(.offline)
        #expect(!offline.isEnabled && offline.disabledReason == "O")
        let ending = try endItem(.ending)
        #expect(!ending.isEnabled && ending.disabledReason == "N")
        let leaving = try endItem(.leaving)
        #expect(leaving.disabledReason.isEmpty)
    }

    // MARK: 4 l1: one tap leaves, in the same frame

    @Test func guestLeaveIsOneTapAndPublishesLeavingInTheSameFrame() {
        let guest = Harness(Self.joined(), publishHook: false)
        #expect(guest.controls.leave() == .dispatched)
        #expect(guest.commands == [.leave] && guest.leave.confirmationId == 0)
        // S1 PUB: the presenter re-reads S1 right after the intent, with no core refresh.
        #expect(guest.leave.leavePhase == .leaving)
        // S1C DUP: a second tap while leaving dispatches nothing.
        #expect(guest.controls.leave() == .ignored && guest.commands == [.leave])
        #expect(guest.controls.selectLeaveMenuItem(LeaveControlPolicy.leaveItemId) == .ignored)
    }

    // MARK: 4 l3, S1-DUP-02: End confirm, progress toast, Leave stays live

    @Test func hostEndConfirmDispatchesOnceAndHoldsTheProgressToast() {
        let h = Harness(Self.joined(isAdmin: true))
        h.stage.setTransientChrome(id: ChromeAutoHidePolicy.barHold, open: true)
        #expect(h.controls.selectLeaveMenuItem(LeaveControlPolicy.endItemId) == .dispatched)
        #expect(h.leave.endPhase == .confirming && h.leave.confirmationInvoker == MeetingConfirmationInvoker.call)
        #expect(LeaveControlPolicy.presentsDialog(h.leave, includesMoreInvoker: false))
        #expect(h.controls.endRequestCount == 1)
        // CC16: the open dialog holds chrome; the presenter action cleared the bar hold.
        #expect(h.stage.transientChromeSummary == ChromeAutoHidePolicy.endDialog)
        let id = h.leave.confirmationId
        #expect(h.controls.confirmEndForEveryone(id: id, postRecap: false) == .dispatched)
        #expect(h.endCommands == 1 && h.controls.endDispatchCount == 1)
        #expect(h.leave.endPhase == .ending && h.leave.endBlockedReason == .ending && h.leave.confirmationId == 0)
        #expect(!h.stage.transientChromeSummary.contains(ChromeAutoHidePolicy.endDialog))
        // CC7: "Ending the call for everyone…" holds the toast lane; the host cannot time it out.
        #expect(h.stage.toast?.kind == NoticeKind.endingForEveryone && h.stage.toast?.severity == .progress)
        #expect(h.stage.toast?.id == h.controls.endingNoticeId && h.controls.endingNoticeId.hasPrefix(LeaveControlPolicy.endingNoticePrefix))
        h.stage.dismissNotice(id: h.controls.endingNoticeId)
        #expect(h.stage.toast?.kind == NoticeKind.endingForEveryone)
        // R09: Leave stays available while End is pending.
        #expect(h.controls.bar.control(.leave)?.isBlocked == false && h.leave.leavePhase == .idle)
        // S1-DUP-02: the second confirm of the same id is refused.
        #expect(h.controls.confirmEndForEveryone(id: id, postRecap: false) == .ignored)
        #expect(h.endCommands == 1 && h.controls.endingNoticeCount == 1)
        // The menu shows End disabled with "Ending…" (4 f Ending row).
        let menu = LeaveControlPolicy.menuSections(h.leave, titles: Self.titles, endOnTop: false)
        // The second section's first row through safe accessors: a missing row fails instead of trapping the process.
        let endRow = menu.dropFirst().first?.items.first
        #expect(endRow?.isEnabled == false && endRow?.disabledReason == "N")
        // The acknowledgment ends the call: the progress toast is cleared, nothing else is posted.
        let ticket = h.lastTicket(.endForEveryone)
        #expect(ticket != nil)
        if let ticket { #expect(h.shell.finish(ticket, .completed)) }
        #expect(h.leave.endPhase == .idle && h.stage.toast == nil && h.controls.endingNoticeId.isEmpty)
        #expect(h.controls.endFailedNoticeCount == 0)
    }

    // MARK: 4 l4: failure, Retry, Leave

    @Test func endFailureSwapsTheProgressForRetryAndRetryAsksAgain() throws {
        let h = Harness(Self.joined(isAdmin: true))
        let firstId = h.requestAndConfirmEnd()
        let sequence = h.shell.feedbackState.token.sequence
        let ticket = try #require(h.lastTicket(.endForEveryone))
        #expect(h.shell.finish(ticket, .failed(.rejectedByServer)))
        #expect(h.leave.endPhase == .failed && h.leave.endFailure == "rejectedByServer")
        // The failure replaced the progress toast in place; nothing of the progress is left in the queue.
        let toast = try #require(h.stage.toast)
        #expect(toast.kind == NoticeKind.endFailed && toast.severity == .error && toast.hasAction(NoticeAction.retry))
        #expect(h.stage.queuedToasts == 0 && h.controls.endingNoticeId.isEmpty && h.controls.endFailedNoticeCount == 1)
        // S1 delivered `actionRejected` once (the root consumer plays it, never the bar).
        #expect(h.shell.feedbackState.token.kind == .actionRejected && h.shell.feedbackState.token.sequence == sequence + 1)
        // End is available again and Leave never stopped being available (R09).
        #expect(LeaveControlPolicy.offersEndAction(h.leave) && h.leave.endBlockedReason == .none)
        #expect(h.controls.bar.control(.leave)?.isBlocked == false)
        // Retry re-presents the dialog with a new confirmation id; End never runs without a fresh confirm.
        h.stage.performNoticeAction(noticeId: toast.id, actionId: NoticeAction.retry)
        #expect(h.leave.endPhase == .confirming && h.leave.confirmationId != 0 && h.leave.confirmationId != firstId)
        #expect(h.leave.confirmationInvoker == MeetingConfirmationInvoker.call)
        #expect(h.endCommands == 1 && h.controls.endFailedNoticeCount == 1)
        #expect(LeaveControlPolicy.playsPrompt(previousId: firstId, leave: h.leave, includesMoreInvoker: false))
        // Cancel closes it; the failure state stays until the next dispatch.
        h.controls.cancelEnd(id: h.leave.confirmationId)
        #expect(h.leave.confirmationId == 0 && h.leave.endPhase == .failed)
        // Leave after a failed End.
        #expect(h.controls.leave() == .dispatched && h.commands.last == .leave)
    }

    @Test func aSynchronousFailurePostsOnlyTheFailure() {
        // `controls-end-failed`: the scripted core refuses End inside the confirm call.
        let session = ControlsFixtureSession(state: .endFailed)
        #expect(session.controls.leaveState.endPhase == .failed)
        #expect(session.controls.endFailedNoticeCount == 1 && session.controls.endingNoticeCount == 0)
        #expect(session.stage.toast?.kind == NoticeKind.endFailed)
        #expect(session.counters.endConfirmed == 1)
        #expect(session.countersReadout().contains("endRequested=1 endConfirmed=1"))
        #expect(session.noticesReadout().contains("toast=endFailed"))
        // Retry through the stage re-presents the dialog (the fixture mirrors the R1 publish hook).
        if let toast = session.stage.toast {
            session.stage.performNoticeAction(noticeId: toast.id, actionId: NoticeAction.retry)
        }
        #expect(session.controls.leaveState.endPhase == .confirming && session.controls.leaveState.confirmationId > 1)
        #expect(session.counters.endConfirmed == 1)
    }

    @Test func aRefusedConfirmPostsNothing() {
        let h = Harness(Self.joined(isAdmin: true))
        _ = h.controls.selectLeaveMenuItem(LeaveControlPolicy.endItemId)
        let id = h.leave.confirmationId
        // Offline while the dialog shows: S1 refuses the confirm and clears the confirmation.
        h.push(Self.joined(isAdmin: true, isNetworkOffline: true))
        #expect(h.controls.confirmEndForEveryone(id: id, postRecap: false) == .ignored)
        #expect(h.endCommands == 0 && h.leave.confirmationId == 0 && h.leave.endPhase == .idle)
        #expect(h.controls.endingNoticeCount == 0 && h.controls.endFailedNoticeCount == 0 && h.stage.toast == nil)
        // An earlier failure is never announced twice by a later refused confirm.
        let again = Harness(Self.joined(isAdmin: true))
        again.requestAndConfirmEnd()
        if let ticket = again.lastTicket(.endForEveryone) { _ = again.shell.finish(ticket, .failed(.ackTimedOut)) }
        #expect(again.controls.endFailedNoticeCount == 1)
        _ = again.controls.selectLeaveMenuItem(LeaveControlPolicy.endItemId)
        let secondId = again.leave.confirmationId
        again.push(Self.joined(isAdmin: true, isNetworkOffline: true))
        #expect(again.controls.confirmEndForEveryone(id: secondId, postRecap: false) == .ignored)
        #expect(again.leave.endPhase == .failed && again.controls.endFailedNoticeCount == 1)
    }

    // MARK: 4 f: role loss, recovery, a new call session

    @Test func losingHostWhileConfirmingClosesTheDialog() {
        let h = Harness(Self.joined(isAdmin: true))
        _ = h.controls.selectLeaveMenuItem(LeaveControlPolicy.endItemId)
        #expect(h.leave.confirmationId != 0 && h.stage.transientChromeSummary.contains(ChromeAutoHidePolicy.endDialog))
        h.push(Self.joined(isAdmin: false))
        // S1 ROLE cleared the confirmation: the dialog closes on both platforms and stops holding chrome.
        #expect(h.leave.confirmationId == 0 && !LeaveControlPolicy.presentsDialog(h.leave, includesMoreInvoker: true))
        #expect(!h.leave.showsEndForEveryone && !h.stage.transientChromeSummary.contains(ChromeAutoHidePolicy.endDialog))
    }

    @Test func recoveryKeepsLeaveAndRefusesEnd() {
        let h = Harness(Self.recovering(isAdmin: true), admitFirst: Self.joined(isAdmin: true))
        #expect(h.controls.selectLeaveMenuItem(LeaveControlPolicy.endItemId) == .ignored)
        #expect(h.leave.confirmationId == 0 && h.controls.endRequestCount == 0)
        #expect(h.controls.leave() == .dispatched && h.commands == [.leave])
    }

    @Test func aNewCallSessionDropsTheEndInFlight() {
        let h = Harness(Self.joined(isAdmin: true))
        h.requestAndConfirmEnd()
        #expect(!h.controls.endingNoticeId.isEmpty)
        let old = h.lastTicket(.endForEveryone)
        h.push(Self.joined(isAdmin: true, identity: MeetingSessionIdentity(callSession: 2, attempt: 1, attemptToken: "ctl2-tests-2")))
        #expect(h.controls.endingNoticeId.isEmpty && h.leave.endPhase == .idle)
        // The old ticket's late failure is stale: S1 drops it and the presenter posts nothing.
        if let old { #expect(!h.shell.finish(old, .failed(.rejectedByServer))) }
        #expect(h.controls.endFailedNoticeCount == 0)
    }

    // MARK: Ticket results arrive through the core (HD/requests/B5-T3.md R1)

    @Test func ticketResultsReachTheControlsThroughThePublishHook() {
        let h = Harness(Self.joined(isAdmin: true), publishHook: false)
        // The presenter's own intents need no hook: the confirmation and the dispatch show in the same frame.
        #expect(h.controls.selectLeaveMenuItem(LeaveControlPolicy.endItemId) == .dispatched && h.leave.confirmationId == 1)
        #expect(h.controls.confirmEndForEveryone(id: 1, postRecap: false) == .dispatched && h.leave.endPhase == .ending)
        // A result that arrives later changes no core field; without the view model's publish hook (R1) the Leave state
        // would wait for an unrelated refresh.
        if let ticket = h.lastTicket(.endForEveryone) { _ = h.shell.finish(ticket, .failed(.rejectedByServer)) }
        #expect(h.leave.endPhase == .ending)
        h.refresh()
        #expect(h.leave.endPhase == .failed && h.stage.toast?.kind == NoticeKind.endFailed)
    }

    // MARK: R09, S50 PH17, 4 h

    @Test func dialogsBelongToTheirInvokerAndThePromptPlaysOncePerConfirmation() {
        let call = Self.snapshot(id: 3, invoker: MeetingConfirmationInvoker.call)
        let more = Self.snapshot(id: 4, invoker: MeetingConfirmationInvoker.more)
        let hostControls = Self.snapshot(id: 5, invoker: MeetingConfirmationInvoker.hostControls)
        #expect(LeaveControlPolicy.presentsDialog(call, includesMoreInvoker: false))
        #expect(LeaveControlPolicy.presentsDialog(call, includesMoreInvoker: true))
        // iOS: More attaches its own dialog (CTL-5); Android: the Leave control composes it for More too.
        #expect(!LeaveControlPolicy.presentsDialog(more, includesMoreInvoker: false))
        #expect(LeaveControlPolicy.presentsDialog(more, includesMoreInvoker: true))
        // Host Controls owns its End dialog (PH17), never the bar.
        #expect(!LeaveControlPolicy.presentsDialog(hostControls, includesMoreInvoker: true))
        #expect(!LeaveControlPolicy.presentsDialog(Self.snapshot(), includesMoreInvoker: true))
        // 4 h: once per new id this control presents; a refused request creates no id and plays nothing.
        #expect(LeaveControlPolicy.playsPrompt(previousId: 0, leave: call, includesMoreInvoker: false))
        #expect(!LeaveControlPolicy.playsPrompt(previousId: 3, leave: call, includesMoreInvoker: false))
        #expect(!LeaveControlPolicy.playsPrompt(previousId: 3, leave: Self.snapshot(), includesMoreInvoker: false))
        #expect(!LeaveControlPolicy.playsPrompt(previousId: 0, leave: hostControls, includesMoreInvoker: true))
        // No Leave haptic (Q11): Leave has no gesture kind.
        let leaveModel = CallControlModel(id: "leave", kind: .leave, isOn: false, visual: .on, isBlocked: false, isPending: false,
                                          reason: .none, reasonName: "", appliesAfterReconnect: false, badgeCount: 0, showsDot: false,
                                          hasShortcut: true)
        #expect(ControlBarPolicy.gestureKind(leaveModel) == nil)
    }

    @Test func endNoticesAreTheStg5LocalKinds() {
        let ending = LeaveControlPolicy.endingNotice(id: "controls:ending:7")
        #expect(ending.id == "controls:ending:7" && ending.kind == NoticeKind.endingForEveryone)
        #expect(ending.lane == .toast && ending.severity == .progress && ending.expiresAtMillis == 0 && ending.actions.isEmpty)
        let failed = LeaveControlPolicy.endFailedNotice()
        #expect(failed.kind == NoticeKind.endFailed && failed.lane == .toast && failed.severity == .error && failed.isFailure)
        #expect(failed.actions.map { $0.id } == [NoticeAction.retry])
        #expect(NoticeKind.localToastKinds.contains(ending.kind) && NoticeKind.localToastKinds.contains(failed.kind))
    }

    // MARK: CL13 End fixtures

    @Test func endConfirmFixtureHoldsTheAcknowledgment() {
        let session = ControlsFixtureSession(state: .endConfirm)
        let id = session.controls.leaveState.confirmationId
        #expect(id != 0 && session.controls.leaveState.confirmationInvoker == MeetingConfirmationInvoker.call)
        #expect(session.controls.confirmEndForEveryone(id: id, postRecap: false) == .dispatched)
        #expect(session.counters.endConfirmed == 1 && session.stage.toast?.kind == NoticeKind.endingForEveryone)
        #expect(session.controls.bar.control(.leave)?.isBlocked == false)
        #expect(session.controls.confirmEndForEveryone(id: id, postRecap: false) == .ignored && session.counters.endConfirmed == 1)
        #expect(session.leaveReadout().contains("end=ending") && session.leaveReadout().contains("hostMenu=1"))
        #expect(session.noticesReadout().contains("toast=endingForEveryone"))
    }

    @Test func endSlowAckFixtureClearsTheProgressWhenTheAcknowledgmentLands() async {
        let session = ControlsFixtureSession(state: .endSlowAck)
        session.sleep = { _ in }
        let id = session.controls.leaveState.confirmationId
        #expect(session.controls.confirmEndForEveryone(id: id, postRecap: false) == .dispatched)
        #expect(session.stage.toast?.kind == NoticeKind.endingForEveryone)
        var turns = 0
        while session.controls.leaveState.endPhase != .idle && turns < 50 {
            await Task.yield()
            turns += 1
        }
        #expect(session.controls.leaveState.endPhase == .idle)
        #expect(session.stage.toast == nil && session.controls.endFailedNoticeCount == 0)
    }

    @Test func recoveringHostFixtureDisablesEndWithItsReason() {
        let session = ControlsFixtureSession(state: .hostRecovering)
        let leave = session.controls.leaveState
        #expect(leave.showsEndForEveryone && leave.endBlockedReason == .reconnecting)
        // The first section's first row through safe accessors: a missing row fails instead of trapping the process.
        let end = LeaveControlPolicy.menuSections(leave, titles: Self.titles, endOnTop: true).first?.items.first
        #expect(end?.id == LeaveControlPolicy.endItemId && end?.isEnabled == false && end?.disabledReason == "R")
        #expect(session.leaveReadout().contains("endReason=reconnecting"))
    }

    // MARK: Source scans (the iOS views are not compiled by the macOS host; Kotlin is read)

    @Test func iosLeaveControlIsTheHostMenuAndTheFnd1Dialog() throws {
        let leave = ctl2Normalized(try ctl2Source("Sources/Conclave/Features/Meeting/Controls/LeaveControl+iOS.swift"))
        let cell = ctl2Normalized(try ctl2Source("Sources/Conclave/Features/Meeting/Controls/CallControlCell+iOS.swift"))
        let bar = ctl2Normalized(try ctl2Source("Sources/Conclave/Features/Meeting/Controls/CallControlBar+iOS.swift"))
        let hold = ctl2Normalized(try ctl2Source("Sources/Conclave/Features/Meeting/Controls/BarTouchHold+iOS.swift"))
        for text in [leave, hold] { #expect(text.hasPrefix("#if os(iOS) && !SKIP")) }
        // CL5, CL15: Menu(primaryAction:) with the priority order, no icons, rows from the shared policy (FND-2).
        #expect(leave.contains("Menu { ConclaveMenuContent(sections: LeaveControlPolicy.menuSections(leave, titles: LeaveControlCopy.menuTitles(), endOnTop: false), symbol: { _ in nil },"))
        #expect(leave.contains("} primaryAction: { _ = controls.leave() } .menuOrder(.priority)"))
        #expect(leave.contains("LeaveControlPolicy.showsHostMenu(leave, isAccessibilityText: isAccessibilityText)"))
        // AX4: End as an accessibility action whenever S1 would accept it.
        #expect(leave.contains(".accessibilityActions { if LeaveControlPolicy.offersEndAction(leave) {"))
        // C18: the FND-1 dialog on this control, for its own confirmations only (R09).
        #expect(leave.contains(".conclaveDialog( LeaveControlCopy.endDialog(),"))
        #expect(leave.contains("LeaveControlPolicy.presentsDialog(leave, includesMoreInvoker: false)"))
        #expect(leave.contains("confirmRole: ConclaveDialogRole.destructive"))
        // 4 h and Q11: the only feedback is the prompt; Leave, the menu, Cancel and success play nothing.
        #expect(leave.contains(".conclaveGestureFeedback(.endForEveryonePrompted, trigger: promptCounter)"))
        #expect(leave.components(separatedBy: "conclaveGestureFeedback(").count - 1 == 1)
        #expect(leave.contains(".disabled(isLeaving)") && leave.contains("HostingTheme.inCallLeave"))
        for pattern in ["glassEffect", "GlassEffectContainer", "conclaveControlSurface", "HapticManager", "sensoryFeedback(",
                        "MeetingViewModel", "UIScreen.main"] {
            #expect(!leave.contains(pattern), "LeaveControl uses \(pattern)")
        }
        // The cell routes Leave here; the bar passes the uncapped text size and installs the hold (CC16).
        #expect(cell.contains("LeaveControl(controls: controls, diameter: diameter, isAccessibilityText: isAccessibilityText)"))
        #expect(!cell.contains("CallControlLeaveCell"))
        #expect(bar.contains("isAccessibilityText: dynamicTypeSize.isAccessibilitySize"))
        #expect(bar.contains(".callControlsBarTouchHold(controls.stage)"))
        // The hold never claims a touch and fails at once.
        for needle in ["cancelsTouchesInView = false", "delaysTouchesBegan = false", "state = .failed", "isUserInteractionEnabled = false",
                       "ChromeAutoHidePolicy.barHold", "shouldRecognizeSimultaneouslyWith"] {
            #expect(hold.contains(needle), "BarTouchHold lacks \(needle)")
        }
    }

    @Test func androidLeaveControlUsesTheMenuTheCustomActionAndTheDialog() throws {
        let leave = ctl2Normalized(try ctl2Source("Sources/Conclave/Skip/ui/call/controls/LeaveControl.kt"))
        let dialog = ctl2Normalized(try ctl2Source("Sources/Conclave/Skip/ui/call/controls/EndForEveryoneDialog.kt"))
        let bar = ctl2Normalized(try ctl2Source("Sources/Conclave/Skip/ui/call/controls/CallControlBar.kt"))
        // Tap leaves with no haptic; the long press opens the menu with `longPress` (4 h).
        #expect(leave.contains("hapticFeedbackEnabled = false, onClick = { controls.leave() },"))
        #expect(leave.contains("haptics.gesture(FeedbackKind.longPress) menuOpen = true"))
        #expect(leave.components(separatedBy: "haptics.gesture(").count - 1 == 1)
        #expect(leave.contains("onLongClickLabel = if (showsMenu) endLabel else null"))
        #expect(leave.contains("customActions = listOf(CustomAccessibilityAction(endLabel) {"))
        // CL15: the FND-2 dropdown, End on top, no icons; CC16 through a DisposableEffect.
        #expect(leave.contains("ConclaveDropdownMenu("))
        #expect(leave.contains("LeaveControlPolicy.menuSections(leave.snapshot, titles = titles, endOnTop = true).toList()"))
        #expect(leave.contains("icon = { null },"))
        #expect(leave.contains("stage.setTransientChrome(id = ChromeAutoHidePolicy.leaveMenu, open = true)"))
        // The dialog for both bar invokers; the guest tooltip only without the menu.
        #expect(leave.contains("LeaveControlPolicy.presentsDialog(leave.snapshot, includesMoreInvoker = true)"))
        #expect(leave.contains("if (showsMenu) body() else CallControlTooltip(leaveLabel) { body() }"))
        // C18 d through the FND-1 ConclaveDialog with the S30 4 g names (R6).
        #expect(dialog.contains("ConclaveDialog("))
        #expect(dialog.contains("confirmRole = ConclaveDialogRole.destructive"))
        for name in ["ctl_end_title", "ctl_end_message", "ctl_end_confirm"] { #expect(dialog.contains("\"" + name + "\"")) }
        #expect(dialog.contains("LaunchedEffect(id) { haptics.gesture(FeedbackKind.endForEveryonePrompted) }"))
        #expect(dialog.contains("onConfirm = { controls.confirmEndForEveryone(id = id, postRecap = false) },"))
        #expect(dialog.contains("onDismiss = { controls.cancelEnd(id = id) },"))
        #expect(bar.contains("leave = { if (leave != null) LeaveControl(controls) },") && !bar.contains("CallLeaveCell"))
        for text in [leave, dialog] {
            for pattern in ["@Stable", "@Immutable", "LocalHapticFeedback", "Vibrator", "MeetingViewModel", "Color(0x", "fontFamily =",
                            "AlertDialog(", "DropdownMenu(expanded"] {
                #expect(!text.contains(pattern), "uses \(pattern)")
            }
        }
    }

    @Test func endCopyFollowsS30FourGOnly() throws {
        let ios = try ctl2Source("Sources/Conclave/Features/Meeting/Controls/LeaveControl+iOS.swift")
        let kotlin = try ctl2Source("Sources/Conclave/Skip/ui/call/controls/LeaveControl.kt")
            + (try ctl2Source("Sources/Conclave/Skip/ui/call/controls/EndForEveryoneDialog.kt"))
        for key in ["\"End Call for Everyone\u{2026}\"", "\"End Call for Everyone\"", "\"End Call for Everyone?\"",
                    "\"Everyone, including people waiting to join, will be disconnected.\"", "\"Leave Call\"", "\"Leaving\"",
                    "\"Ending\u{2026}\""] {
            #expect(ios.contains(key), "iOS lacks \(key)")
        }
        for name in ["ctl_end_for_everyone_ellipsis", "ctl_end_for_everyone", "ctl_end_title", "ctl_end_message", "ctl_end_confirm",
                     "ds_leave_call", "ctl_state_leaving", "ctl_ending", "ctl_reason_reconnecting", "ctl_reason_offline"] {
            #expect(kotlin.contains("\"" + name + "\""), "Kotlin lacks \(name)")
        }
        // RECONCILE R6: "End Meeting…", the extra "Leave Meeting" button and the legacy "Hang Up" are gone.
        for retired in ["End Meeting", "Leave Meeting", "Hang Up", "ds_end_for_everyone"] {
            #expect(!ios.contains(retired) && !kotlin.contains(retired), "uses \(retired)")
        }
    }

    @Test func ctl2SourcesStayFlatDashFreeAndSkipLite() throws {
        let files = ["Sources/Conclave/Features/Meeting/Controls/LeaveControlPolicy.swift",
                     "Sources/Conclave/Features/Meeting/Controls/LeaveControl+iOS.swift",
                     "Sources/Conclave/Features/Meeting/Controls/BarTouchHold+iOS.swift",
                     "Sources/Conclave/Skip/ui/call/controls/LeaveControl.kt",
                     "Sources/Conclave/Skip/ui/call/controls/EndForEveryoneDialog.kt",
                     "Tests/ConclaveTests/CTL2LeaveEndTests.swift",
                     "Tests/ConclaveTests/Skip/CTL2LeaveEndBridgeTests.kt"]
        for file in files {
            let text = try ctl2Source(file)
            #expect(!text.contains("\u{2013}") && !text.contains("\u{2014}"), "\(file) has an en or em dash")
            #expect(!text.lowercased().contains("gradi" + "ent"), "\(file) mentions a forbidden fill")
        }
        let policy = try ctl2Source("Sources/Conclave/Features/Meeting/Controls/LeaveControlPolicy.swift")
        #expect(!policy.contains("#if") && !policy.contains("protocol ") && !policy.contains("inout "))
        #expect(policy.range(of: #"case\s+\w+\("#, options: .regularExpression) == nil)
    }
}

// MARK: Helpers (file-private, so no other suite collides)

private func ctl2PackageRoot() -> URL {
    URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
}

private func ctl2Source(_ packageRelativePath: String) throws -> String {
    try String(contentsOf: ctl2PackageRoot().appendingPathComponent(packageRelativePath).standardizedFileURL, encoding: .utf8)
}

private func ctl2Normalized(_ text: String) -> String {
    text.split(whereSeparator: { $0.isWhitespace }).joined(separator: " ")
}
#endif
