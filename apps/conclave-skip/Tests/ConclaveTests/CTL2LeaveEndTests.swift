#if !SKIP
import Foundation
import Testing
@testable import Conclave

@MainActor
struct CTL2LeaveEndTests {

    static let identity = MeetingSessionIdentity(callSession: 1, attempt: 1, attemptToken: "ctl2-tests")

    static func joined(isAdmin: Bool = false, isWebinarAttendee: Bool = false, isNetworkOffline: Bool = false,
                       identity: MeetingSessionIdentity = CTL2LeaveEndTests.identity) -> MeetingShellInputs {
        MeetingShellInputs.make(identity: identity, connectionState: .joined, isNetworkOffline: isNetworkOffline,
                                roomId: "abc-defg-hij", displayName: "You", isAdmin: isAdmin, isWebinarAttendee: isWebinarAttendee,
                                isMuted: false, isCameraOff: false)
    }

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

        @discardableResult
        func requestAndConfirmEnd() -> Int {
            _ = controls.selectLeaveMenuItem(LeaveControlPolicy.endItemId)
            let id = leave.confirmationId
            _ = controls.confirmEndForEveryone(id: id, postRecap: false)
            return id
        }
    }

    @Test func leaveSnapshotCarriesTheHostMenuFacts() {

        let guest = Harness(Self.joined())
        #expect(!guest.leave.showsEndForEveryone && !guest.leave.canEndForEveryone && guest.leave.endBlockedReason == .none)
        #expect(!LeaveControlPolicy.showsHostMenu(guest.leave, isAccessibilityText: false))
        #expect(!LeaveControlPolicy.offersEndAction(guest.leave))
        #expect(guest.controls.bar.control(.leave)?.hasShortcut == false)

        let host = Harness(Self.joined(isAdmin: true))
        #expect(host.leave.showsEndForEveryone && host.leave.canEndForEveryone && host.leave.endBlockedReason == .none)
        #expect(LeaveControlPolicy.showsHostMenu(host.leave, isAccessibilityText: false))
        #expect(!LeaveControlPolicy.showsHostMenu(host.leave, isAccessibilityText: true))
        #expect(LeaveControlPolicy.offersEndAction(host.leave))
        #expect(host.controls.bar.control(.leave)?.hasShortcut == true)

        let recovering = Harness(Self.recovering(isAdmin: true), admitFirst: Self.joined(isAdmin: true))
        #expect(recovering.leave.showsEndForEveryone && !recovering.leave.canEndForEveryone)
        #expect(recovering.leave.endBlockedReason == .reconnecting)
        #expect(LeaveControlPolicy.showsHostMenu(recovering.leave, isAccessibilityText: false))
        #expect(!LeaveControlPolicy.offersEndAction(recovering.leave))
        #expect(recovering.controls.bar.control(.leave)?.isBlocked == false && recovering.controls.bar.control(.leave)?.hasShortcut == true)

        let offline = Harness(Self.joined(isAdmin: true, isNetworkOffline: true))
        #expect(offline.leave.endBlockedReason == .offline && !LeaveControlPolicy.offersEndAction(offline.leave))

        let attendee = Harness(Self.joined(isAdmin: true, isWebinarAttendee: true))
        #expect(!attendee.leave.showsEndForEveryone && !LeaveControlPolicy.showsHostMenu(attendee.leave, isAccessibilityText: false))

        #expect(!LeaveControlPolicy.showsHostMenu(Self.snapshot(leaving: true), isAccessibilityText: false))
        #expect(!LeaveControlPolicy.offersEndAction(Self.snapshot(leaving: true)))
    }

    @Test func menuRowsFollowEachPlatformsOrderWithoutIcons() throws {
        let host = Self.snapshot()
        let ios = LeaveControlPolicy.menuSections(host, titles: Self.titles, endOnTop: false)
        #expect(ios.map { section in section.items.map { $0.id } } == [["leave"], ["endForEveryone"]])

        #expect(ConclaveMenuPolicy.destructiveItemsAreLast(ios))
        let android = LeaveControlPolicy.menuSections(host, titles: Self.titles, endOnTop: true)

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

        #expect(ios.dropFirst().first?.items.first?.title == "End\u{2026}" && ios.first?.items.first?.title == "Leave")

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

    @Test func guestLeaveIsOneTapAndPublishesLeavingInTheSameFrame() {
        let guest = Harness(Self.joined(), publishHook: false)
        #expect(guest.controls.leave() == .dispatched)
        #expect(guest.commands == [.leave] && guest.leave.confirmationId == 0)

        #expect(guest.leave.leavePhase == .leaving)

        #expect(guest.controls.leave() == .ignored && guest.commands == [.leave])
        #expect(guest.controls.selectLeaveMenuItem(LeaveControlPolicy.leaveItemId) == .ignored)
    }

    @Test func hostEndConfirmDispatchesOnceAndHoldsTheProgressToast() {
        let h = Harness(Self.joined(isAdmin: true))
        h.stage.setTransientChrome(id: ChromeAutoHidePolicy.barHold, open: true)
        #expect(h.controls.selectLeaveMenuItem(LeaveControlPolicy.endItemId) == .dispatched)
        #expect(h.leave.endPhase == .confirming && h.leave.confirmationInvoker == MeetingConfirmationInvoker.call)
        #expect(LeaveControlPolicy.presentsDialog(h.leave, includesMoreInvoker: false))
        #expect(h.controls.endRequestCount == 1)

        #expect(h.stage.transientChromeSummary == ChromeAutoHidePolicy.endDialog)
        let id = h.leave.confirmationId
        #expect(h.controls.confirmEndForEveryone(id: id, postRecap: false) == .dispatched)
        #expect(h.endCommands == 1 && h.controls.endDispatchCount == 1)
        #expect(h.leave.endPhase == .ending && h.leave.endBlockedReason == .ending && h.leave.confirmationId == 0)
        #expect(!h.stage.transientChromeSummary.contains(ChromeAutoHidePolicy.endDialog))

        #expect(h.stage.toast?.kind == NoticeKind.endingForEveryone && h.stage.toast?.severity == .progress)
        #expect(h.stage.toast?.id == h.controls.endingNoticeId && h.controls.endingNoticeId.hasPrefix(LeaveControlPolicy.endingNoticePrefix))
        h.stage.dismissNotice(id: h.controls.endingNoticeId)
        #expect(h.stage.toast?.kind == NoticeKind.endingForEveryone)

        #expect(h.controls.bar.control(.leave)?.isBlocked == false && h.leave.leavePhase == .idle)

        #expect(h.controls.confirmEndForEveryone(id: id, postRecap: false) == .ignored)
        #expect(h.endCommands == 1 && h.controls.endingNoticeCount == 1)

        let menu = LeaveControlPolicy.menuSections(h.leave, titles: Self.titles, endOnTop: false)

        let endRow = menu.dropFirst().first?.items.first
        #expect(endRow?.isEnabled == false && endRow?.disabledReason == "N")

        let ticket = h.lastTicket(.endForEveryone)
        #expect(ticket != nil)
        if let ticket { #expect(h.shell.finish(ticket, .completed)) }
        #expect(h.leave.endPhase == .idle && h.stage.toast == nil && h.controls.endingNoticeId.isEmpty)
        #expect(h.controls.endFailedNoticeCount == 0)
    }

    @Test func endFailureSwapsTheProgressForRetryAndRetryAsksAgain() throws {
        let h = Harness(Self.joined(isAdmin: true))
        let firstId = h.requestAndConfirmEnd()
        let sequence = h.shell.feedbackState.token.sequence
        let ticket = try #require(h.lastTicket(.endForEveryone))
        #expect(h.shell.finish(ticket, .failed(.rejectedByServer)))
        #expect(h.leave.endPhase == .failed && h.leave.endFailure == "rejectedByServer")

        let toast = try #require(h.stage.toast)
        #expect(toast.kind == NoticeKind.endFailed && toast.severity == .error && toast.hasAction(NoticeAction.retry))
        #expect(h.stage.queuedToasts == 0 && h.controls.endingNoticeId.isEmpty && h.controls.endFailedNoticeCount == 1)

        #expect(h.shell.feedbackState.token.kind == .actionRejected && h.shell.feedbackState.token.sequence == sequence + 1)

        #expect(LeaveControlPolicy.offersEndAction(h.leave) && h.leave.endBlockedReason == .none)
        #expect(h.controls.bar.control(.leave)?.isBlocked == false)

        h.stage.performNoticeAction(noticeId: toast.id, actionId: NoticeAction.retry)
        #expect(h.leave.endPhase == .confirming && h.leave.confirmationId != 0 && h.leave.confirmationId != firstId)
        #expect(h.leave.confirmationInvoker == MeetingConfirmationInvoker.call)
        #expect(h.endCommands == 1 && h.controls.endFailedNoticeCount == 1)
        #expect(LeaveControlPolicy.playsPrompt(previousId: firstId, leave: h.leave, includesMoreInvoker: false))

        h.controls.cancelEnd(id: h.leave.confirmationId)
        #expect(h.leave.confirmationId == 0 && h.leave.endPhase == .failed)

        #expect(h.controls.leave() == .dispatched && h.commands.last == .leave)
    }

    @Test func aSynchronousFailurePostsOnlyTheFailure() {

        let session = ControlsFixtureSession(state: .endFailed)
        #expect(session.controls.leaveState.endPhase == .failed)
        #expect(session.controls.endFailedNoticeCount == 1 && session.controls.endingNoticeCount == 0)
        #expect(session.stage.toast?.kind == NoticeKind.endFailed)
        #expect(session.counters.endConfirmed == 1)
        #expect(session.countersReadout().contains("endRequested=1 endConfirmed=1"))
        #expect(session.noticesReadout().contains("toast=endFailed"))

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

        h.push(Self.joined(isAdmin: true, isNetworkOffline: true))
        #expect(h.controls.confirmEndForEveryone(id: id, postRecap: false) == .ignored)
        #expect(h.endCommands == 0 && h.leave.confirmationId == 0 && h.leave.endPhase == .idle)
        #expect(h.controls.endingNoticeCount == 0 && h.controls.endFailedNoticeCount == 0 && h.stage.toast == nil)

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

    @Test func losingHostWhileConfirmingClosesTheDialog() {
        let h = Harness(Self.joined(isAdmin: true))
        _ = h.controls.selectLeaveMenuItem(LeaveControlPolicy.endItemId)
        #expect(h.leave.confirmationId != 0 && h.stage.transientChromeSummary.contains(ChromeAutoHidePolicy.endDialog))
        h.push(Self.joined(isAdmin: false))

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

        if let old { #expect(!h.shell.finish(old, .failed(.rejectedByServer))) }
        #expect(h.controls.endFailedNoticeCount == 0)
    }

    @Test func ticketResultsReachTheControlsThroughThePublishHook() {
        let h = Harness(Self.joined(isAdmin: true), publishHook: false)

        #expect(h.controls.selectLeaveMenuItem(LeaveControlPolicy.endItemId) == .dispatched && h.leave.confirmationId == 1)
        #expect(h.controls.confirmEndForEveryone(id: 1, postRecap: false) == .dispatched && h.leave.endPhase == .ending)

        if let ticket = h.lastTicket(.endForEveryone) { _ = h.shell.finish(ticket, .failed(.rejectedByServer)) }
        #expect(h.leave.endPhase == .ending)
        h.refresh()
        #expect(h.leave.endPhase == .failed && h.stage.toast?.kind == NoticeKind.endFailed)
    }

    @Test func dialogsBelongToTheirInvokerAndThePromptPlaysOncePerConfirmation() {
        let call = Self.snapshot(id: 3, invoker: MeetingConfirmationInvoker.call)
        let more = Self.snapshot(id: 4, invoker: MeetingConfirmationInvoker.more)
        let hostControls = Self.snapshot(id: 5, invoker: MeetingConfirmationInvoker.hostControls)
        #expect(LeaveControlPolicy.presentsDialog(call, includesMoreInvoker: false))
        #expect(LeaveControlPolicy.presentsDialog(call, includesMoreInvoker: true))

        #expect(!LeaveControlPolicy.presentsDialog(more, includesMoreInvoker: false))
        #expect(LeaveControlPolicy.presentsDialog(more, includesMoreInvoker: true))

        #expect(!LeaveControlPolicy.presentsDialog(hostControls, includesMoreInvoker: true))
        #expect(!LeaveControlPolicy.presentsDialog(Self.snapshot(), includesMoreInvoker: true))

        #expect(LeaveControlPolicy.playsPrompt(previousId: 0, leave: call, includesMoreInvoker: false))
        #expect(!LeaveControlPolicy.playsPrompt(previousId: 3, leave: call, includesMoreInvoker: false))
        #expect(!LeaveControlPolicy.playsPrompt(previousId: 3, leave: Self.snapshot(), includesMoreInvoker: false))
        #expect(!LeaveControlPolicy.playsPrompt(previousId: 0, leave: hostControls, includesMoreInvoker: true))

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

        let end = LeaveControlPolicy.menuSections(leave, titles: Self.titles, endOnTop: true).first?.items.first
        #expect(end?.id == LeaveControlPolicy.endItemId && end?.isEnabled == false && end?.disabledReason == "R")
        #expect(session.leaveReadout().contains("endReason=reconnecting"))
    }

}

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
