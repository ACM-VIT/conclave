#if !SKIP
import Foundation
import Testing
@testable import Conclave

/// PPL-2 (OUT/PLAN-screens.md section 5): row actions, confirmations and the tile-menu people items. The shared policy
/// (PL7 table and group order, RECONCILE R19 tile items), the PH2 ledger and command seam, PH16 failure mapping, PL14
/// placement by origin (RECONCILE R2), the S50 3 j confirmation flow (Remove and Block, Make Host with no optimistic
/// role write), the rename flow (Q14, RECONCILE R38) on the shared S60 C6-10 DisplayNameEditor, and source pins for the
/// iOS-only and Kotlin views. The Kotlin half is T/Skip/PPL2PPL4BridgeTests.kt.
@MainActor
struct PPL2PeopleActionTests {
    private let me = "u-ishaan"
    private let priya = "u-priya"
    private let avery = "u-avery"

    private func makePeople() -> PeoplePresenter {
        let shell = MeetingShellPresenter()
        return PeoplePresenter(shell: shell, stage: StagePresenter(shell: shell))
    }

    /// Ishaan hosts; Avery is a co-host; Priya is an unmuted participant with a known user key.
    private func hostRoster(attempt: Int = 1, phase: String = MeetingPhaseKind.inCall.rawValue, isAdmin: Bool = true,
                            hostUserId: String = "u-ishaan", local: String = "u-ishaan") -> PeopleInputs {
        PeopleInputs.make(
            callSession: 1, attempt: attempt, phase: phase, localUserId: local,
            participants: [
                PeopleParticipantInput.make(userId: me, displayName: "Ishaan", isLocal: local == me, isMuted: false),
                PeopleParticipantInput.make(userId: avery, displayName: "Avery Lee", isLocal: local == avery, isMuted: false,
                                            joinSerial: 1),
                PeopleParticipantInput.make(userId: priya, displayName: "Priya N.", isMuted: false, joinSerial: 2,
                                            userKey: "k-priya"),
            ],
            isRosterLoaded: true, isAdmin: isAdmin, hostUserId: hostUserId, hostUserIds: [me, avery])
    }

    private func actionIds(_ people: PeoplePresenter, _ rowId: String) -> [PersonActionID] {
        people.rows.entry(for: rowId).model.actions.map { $0.action }
    }

    /// Installs a recording command seam and returns the log.
    private final class CommandLog {
        var commands: [PeopleCommand] = []
        var tickets: [HostActionTicket] = []
    }

    private func record(_ people: PeoplePresenter) -> CommandLog {
        let log = CommandLog()
        people.onCommand = { command, ticket in
            log.commands.append(command)
            log.tickets.append(ticket)
        }
        return log
    }

    // MARK: PL7 table and order (S50 3 f, 3 l1)

    @Test func hostViewerSeesHostMediaFirstOnAnUnmutedParticipant() {
        let people = makePeople()
        people.apply(hostRoster())
        let actions = people.rows.entry(for: priya).model.actions
        #expect(actions.first?.action == .mute)
        #expect(PeopleActionPolicy.groupOrder(actions) == [1, 0, 2, 3])
        #expect(actions.last?.action == .remove)
        #expect(actionIds(people, priya).contains(.makeCoHost))
        #expect(actionIds(people, priya).contains(.makeHost))
        // Swipe: Mute then Remove, and Mute equals the top menu item (IOS 9.2).
        #expect(PeopleActionPolicy.swipeActions(actions).map { $0.action } == [.mute, .remove])
    }

    @Test func ownRowStartsWithEveryoneItemsAndOffersChangeName() {
        let people = makePeople()
        people.apply(hostRoster())
        let own = people.rows.entry(for: me).model.actions
        #expect(PeopleActionPolicy.groupOrder(own).first == 0)
        #expect(own.contains { $0.action == .changeName })
        #expect(!own.contains { $0.action == .mute || $0.action == .remove })
    }

    @Test func coHostsNeverSeeRemoveOrMakeHostOnTheHost() {
        let people = makePeople()
        people.apply(hostRoster(isAdmin: true, hostUserId: me, local: avery))
        let onHost = actionIds(people, me)
        #expect(!onHost.contains(.remove))
        #expect(!onHost.contains(.makeHost))
        #expect(onHost.contains(.mute))
        // Q1: only the primary host transfers the role.
        #expect(!actionIds(people, priya).contains(.makeHost))
        #expect(actionIds(people, priya).contains(.remove))
    }

    @Test func participantViewerSeesOnlyEveryoneItems() {
        let people = makePeople()
        people.apply(hostRoster(isAdmin: false, hostUserId: me, local: priya))
        let onHost = people.rows.entry(for: me).model.actions
        #expect(PeopleActionPolicy.groupOrder(onHost) == [0])
        #expect(onHost.map { $0.action } == [.pin, .sendPrivateMessage, .hideMessages])
    }

    @Test func recoveringDisablesHostItemsWithTheReason() {
        let people = makePeople()
        people.apply(hostRoster(phase: MeetingPhaseKind.recovering.rawValue))
        let mute = people.rows.entry(for: priya).model.actions.first { $0.action == .mute }
        #expect(mute?.isEnabled == false)
        #expect(mute?.reason == MeetingBlockedReason.reconnecting.rawValue)
        // Pin stays available (local, never blocked).
        #expect(people.rows.entry(for: priya).model.actions.first { $0.action == .pin }?.isEnabled == true)
    }

    // MARK: RECONCILE R19: tile items equal the row items minus Admit and Deny

    @Test func tileItemsEqualTheRowItemsMinusAdmitAndDeny() {
        let people = makePeople()
        people.apply(hostRoster())
        let actions = people.rows.entry(for: priya).model.actions
        let extra = [PersonActionModel(action: .admit, group: 0, isEnabled: true, reason: PeopleActionReason.none,
                                       isDestructive: false, needsConfirmation: false, isSwipe: false)]
        #expect(PeopleActionPolicy.tileActions(actions + extra) == actions)
        let titles = PeopleActionTitles(pin: "Pin", unpin: "Unpin", sendPrivateMessage: "DM", hideMessages: "Hide",
                                        showMessages: "Show", changeName: "Name", lowerHand: "Lower", mute: "Mute",
                                        turnOffCamera: "Cam", stopScreenShare: "Share", stopScreenAudio: "Audio",
                                        makeCoHost: "Co", makeHost: "Host", moveToAudience: "Aud", remove: "Remove",
                                        reasonReconnecting: "r", reasonOffline: "o", reasonNotJoined: "n", reasonPending: "p",
                                        reasonRenameDisabled: "d")
        let sections = PeopleActionPolicy.menuSections(PeopleActionPolicy.tileActions(actions), titles: titles)
        // The stage drops the people Pin (S20 keeps Pin), everything else keeps the People order.
        let context = TileMenuContext(slotId: "p:" + priya, userId: priya, role: StageSlotRole.grid, kind: StageKind.grid,
                                      fit: StageVideoFit.fill, isLocal: false, isPinned: false, isCameraOff: true,
                                      canFlipCamera: false, offersFlipItem: false)
        let tile = TileMenuPolicy.sections(context, titles: TileMenuTitles(pin: "Pin", unpin: "Unpin", flipCamera: "Flip",
                                                                            minimizeSelfView: "Min", showSelfView: "Show",
                                                                            showFullVideo: "Full", cropToFill: "Crop"),
                                           people: sections)
        var ids: [String] = []
        for section in tile { for item in section.items { ids.append(item.id) } }
        #expect(ids.filter { $0 == TileMenuItemId.pin.rawValue }.count == 1)
        #expect(ids.contains(PersonActionID.mute.rawValue))
        #expect(ids.last == PersonActionID.remove.rawValue)
    }

    // MARK: PH2 ledger and dispatch (S50 3 l6)

    @Test func oneTapEmitsOneCommandAndADuplicateIsIgnored() {
        let people = makePeople()
        people.apply(hostRoster())
        let log = record(people)
        #expect(people.perform(.mute, rowId: priya, source: PeopleActionSource.rowMenu) == .dispatched)
        #expect(people.perform(.mute, rowId: priya, source: PeopleActionSource.rowMenu) == .ignored)
        #expect(log.commands.count == 1)
        #expect(log.commands.first?.kind == .mute)
        #expect(log.commands.first?.targetId == priya)
        #expect(people.rows.entry(for: priya).model.pendingAction == PersonActionID.mute.rawValue)
        #expect(people.pendingKeys() == ["mute:" + priya])
        // A pending row disables its host items with "In Progress".
        let remove = people.rows.entry(for: priya).model.actions.first { $0.action == .remove }
        #expect(remove?.reason == PeopleActionReason.pending)
        #expect(people.finish(log.tickets[0], HostActionResult.completed))
        #expect(people.rows.entry(for: priya).model.pendingAction.isEmpty)
        // A finished ticket never finishes twice.
        #expect(!people.finish(log.tickets[0], HostActionResult.completed))
    }

    @Test func anAttemptChangeInterruptsPendingActionsSilently() {
        let people = makePeople()
        people.apply(hostRoster(attempt: 1))
        let log = record(people)
        people.perform(.mute, rowId: priya, source: PeopleActionSource.rowMenu)
        people.apply(hostRoster(attempt: 2))
        #expect(people.pendingKeys().isEmpty)
        #expect(!people.finish(log.tickets[0], HostActionResult.failed(.rejectedByServer)))
        #expect(people.lastFailure == nil)
    }

    @Test func ledgerKeysAreTargetScopedAndSingleFlight() {
        let ledger = HostActionLedger()
        let command = PeopleCommand.make(.mute, targetId: "u-a")
        let first = ledger.begin(key: "mute:u-a", command: command, source: PeopleActionSource.rowMenu, sourceKey: "u-a",
                                 targetName: "A", session: 1, attempt: 1)
        #expect(first != nil)
        #expect(ledger.begin(key: "mute:u-a", command: command, source: PeopleActionSource.rowMenu, sourceKey: "u-a",
                             targetName: "A", session: 1, attempt: 1) == nil)
        #expect(ledger.pendingAction(forRow: "u-a") == "mute")
        #expect(ledger.interruptAll() == 1)
        if let first {
            #expect(ledger.finish(first) == nil)
        }
        #expect(PeopleActionPolicy.ledgerKey(.changeName, target: PeopleActionPolicy.selfTarget) == "changeName:self")
        #expect(PeopleActionPolicy.rowPendingAction(PeopleCommandKind.block.rawValue) == PersonActionID.remove.rawValue)
    }

    // MARK: Confirmations (S50 3 j, 3 l5)

    @Test func removeAndBlockDispatchesOneBlockAndNoKick() {
        let people = makePeople()
        people.apply(hostRoster())
        let log = record(people)
        people.perform(.remove, rowId: priya, source: PeopleActionSource.rowMenu)
        let confirmation = people.confirmation
        #expect(confirmation?.kind == .remove)
        #expect(confirmation?.canBlock == true)
        // Row sources anchor the dialog to the target row's entry only.
        #expect(people.rows.entry(for: priya).confirmation == confirmation)
        #expect(people.rows.entry(for: avery).confirmation == nil)
        #expect(log.commands.isEmpty)
        people.confirm(id: confirmation?.id ?? 0, block: true)
        #expect(log.commands.map { $0.kind } == [.block])
        #expect(log.commands.first?.text == "k-priya")
        #expect(people.confirmation == nil)
        #expect(people.rows.entry(for: priya).confirmation == nil)
        #expect(people.countersReadout().contains("command:block"))
        #expect(!people.countersReadout().contains("command:remove"))
    }

    @Test func guestTargetsCarryTheBlockNoteAndUnknownKeysHideBlock() {
        #expect(PeopleActionPolicy.isGuestUserId("guest-71a2#2"))
        #expect(!PeopleActionPolicy.isGuestUserId("u-priya"))
        let people = makePeople()
        let inputs = PeopleInputs.make(callSession: 1, attempt: 1, phase: MeetingPhaseKind.inCall.rawValue, localUserId: me,
                                   participants: [
                                       PeopleParticipantInput.make(userId: me, displayName: "Ishaan", isLocal: true),
                                       PeopleParticipantInput.make(userId: "guest-71a2", displayName: "Guest", isMuted: false,
                                                                   joinSerial: 1),
                                   ],
                                   isRosterLoaded: true, isAdmin: true, hostUserId: me, hostUserIds: [me])
        people.apply(inputs)
        people.perform(.remove, rowId: "guest-71a2", source: PeopleActionSource.rowMenu)
        #expect(people.confirmation?.isGuest == true)
        #expect(people.confirmation?.canBlock == false)
    }

    @Test func makeHostTransfersWithNoOptimisticRoleWrite() {
        let people = makePeople()
        people.apply(hostRoster())
        let log = record(people)
        people.perform(.makeHost, rowId: priya, source: PeopleActionSource.rowMenu)
        people.confirm(id: people.confirmation?.id ?? 0, block: false)
        #expect(log.commands.map { $0.kind } == [.makeHost])
        #expect(people.finish(log.tickets[0], HostActionResult.completed))
        // Roles change only when the core's host inputs change (D10).
        #expect(people.rows.entry(for: priya).model.role == .participant)
        #expect(people.snapshot.viewerRole == .host)
    }

    @Test func aConfirmationClosesWhenItsTargetLeaves() {
        let people = makePeople()
        people.apply(hostRoster())
        people.perform(.makeCoHost, rowId: priya, source: PeopleActionSource.tileMenu)
        #expect(people.confirmation?.source == PeopleActionSource.tileMenu)
        // Tile-menu confirmations belong to the stage host, never to a row.
        #expect(people.rows.entry(for: priya).confirmation == nil)
        people.apply(PeopleInputs.make(callSession: 1, attempt: 1, phase: MeetingPhaseKind.inCall.rawValue, localUserId: me,
                                       participants: [PeopleParticipantInput.make(userId: me, displayName: "Ishaan", isLocal: true)],
                                       isRosterLoaded: true, isAdmin: true, hostUserId: me, hostUserIds: [me]))
        #expect(people.confirmation == nil)
    }

    // MARK: PL14 placement by origin (RECONCILE R2) and PH16 copy

    @Test func panelOriginFailuresStayInThePanelAndStageOriginFailuresToast() {
        let people = makePeople()
        people.apply(hostRoster())
        let log = record(people)
        people.platform = NoticePlatform.ios
        people.perform(.mute, rowId: priya, source: PeopleActionSource.rowMenu)
        people.finish(log.tickets[0], HostActionResult.failed(.rejectedByServer))
        #expect(people.lastFailure?.placement == HostFailurePlacement.panelInline.rawValue)
        #expect(people.lastFailure?.sourceKey == priya)
        // Retry re-dispatches the same command with a new ticket.
        people.retry(failureId: people.lastFailure?.id ?? 0)
        #expect(log.commands.count == 2)
        #expect(people.lastFailure == nil)
        people.finish(log.tickets[1], HostActionResult.completed)

        people.platform = NoticePlatform.android
        people.perform(.mute, rowId: avery, source: PeopleActionSource.rowMenu)
        people.finish(log.tickets[2], HostActionResult.failed(.ackTimedOut))
        #expect(people.lastFailure?.placement == HostFailurePlacement.panelSnackbar.rawValue)
        people.dismissFailure(id: people.lastFailure?.id ?? 0)

        // Tile menu (stage origin): the S20 toast lane, nothing stored in the panel.
        people.perform(.mute, rowId: priya, source: PeopleActionSource.tileMenu)
        people.finish(log.tickets[3], HostActionResult.failed(.superAdmin))
        #expect(people.lastFailure == nil)
        #expect(people.stage.noticesReadout().contains("toast=" + PeopleFailurePlacementPolicy.stageNoticeKind))
    }

    @Test func placementPolicyIsByOriginNotCoverage() {
        #expect(PeopleFailurePlacementPolicy.placement(origin: PeopleActionOrigin.stage, platform: NoticePlatform.ios) == .stage)
        #expect(PeopleFailurePlacementPolicy.placement(origin: PeopleActionOrigin.panel, platform: NoticePlatform.ios) == .panelInline)
        #expect(PeopleFailurePlacementPolicy.placement(origin: PeopleActionOrigin.panel, platform: NoticePlatform.android)
            == .panelSnackbar)
        #expect(PeopleActionSource.origin(PeopleActionSource.tileMenu) == PeopleActionOrigin.stage)
        #expect(PeopleActionSource.origin(PeopleActionSource.swipe) == PeopleActionOrigin.panel)
        let detail = PeopleFailurePlacementPolicy.stageDetail(failureId: 7, action: "mute", failure: "rateLimited")
        #expect(PeopleFailurePlacementPolicy.stageFailureId(detail) == 7)
        #expect(PeopleFailurePlacementPolicy.stageAction(detail) == "mute")
        #expect(PeopleFailurePlacementPolicy.stageFailure(detail) == "rateLimited")
    }

    @Test func serverAndTransportTextMapsToTypedFailures() {
        #expect(HostActionFailurePolicy.failure(message: "You are changing your display name too quickly.") == .renameRateLimited)
        #expect(HostActionFailurePolicy.failure(message: "Display name updates are disabled") == .renameDisabled)
        #expect(HostActionFailurePolicy.failure(message: "Display name too long") == .renameTooLong)
        #expect(HostActionFailurePolicy.failure(message: "Cannot kick a super admin") == .superAdmin)
        #expect(HostActionFailurePolicy.failure(message: "Too many admin requests. Retry shortly.") == .rateLimited)
        #expect(HostActionFailurePolicy.failure(message: "User not found") == .notFound)
        #expect(HostActionFailurePolicy.failure(message: "Admin privileges required") == .notAllowed)
        #expect(HostActionFailurePolicy.failure(message: "Ack timed out") == .ackTimedOut)
        #expect(HostActionFailurePolicy.failure(message: "") == .unknown)
        #expect(HostActionFailurePolicy.failure(message: "Something odd") == .rejectedByServer)
        #expect(PeopleFailureCopy.kind(action: "mute", failure: "notFound", sourceKey: priya) == PeopleFailureCopy.alreadyLeft)
        #expect(PeopleFailureCopy.kind(action: "remove", failure: "superAdmin", sourceKey: priya) == PeopleFailureCopy.cantRemove)
        #expect(PeopleFailureCopy.kind(action: "setPolicy", failure: "rejectedByServer", sourceKey: "lockMeeting")
            == PeopleFailureCopy.lockMeeting)
        #expect(PeopleFailureCopy.kind(action: "setPolicy", failure: "rejectedByServer", sourceKey: "photos") == PeopleFailureCopy.policy)
        #expect(PeopleFailureCopy.kind(action: "mute", failure: "rejectedByServer", sourceKey: priya) == PeopleFailureCopy.mute)
    }

    // MARK: Rename (S50 3 c, 3 d; Q14; RECONCILE R38; S60 C6-10)

    @Test func aRenameRefusalKeepsTheDraftAndDisabledLastsTheSession() {
        let people = makePeople()
        people.apply(hostRoster())
        let log = record(people)
        people.perform(.changeName, rowId: me, source: PeopleActionSource.rowMenu)
        #expect(people.rename.phase == .editing)
        #expect(people.rename.draft == "Ishaan")
        #expect(people.submitRename("Ishaan K") == .dispatched)
        #expect(people.rename.phase == .pending)
        #expect(log.commands.last?.kind == .changeName)
        #expect(log.commands.last?.text == "Ishaan K")
        people.finish(log.tickets[0], HostActionResult.failed(.renameDisabled))
        #expect(people.rename.phase == .refused)
        #expect(people.rename.draft == "Ishaan K")
        #expect(people.rename.refusal == HostActionFailure.renameDisabled.rawValue)
        let change = people.rows.entry(for: me).model.actions.first { $0.action == .changeName }
        #expect(change?.isEnabled == false)
        #expect(change?.reason == PeopleActionReason.renameDisabled)
    }

    @Test func theEditorMapsRefusalsAndKeepsOneSessionFlag() async {
        let editor = DisplayNameEditor()
        editor.context = { DisplayNameEditorContext(displayName: "Ishaan", connectionState: .joined, isWebinarAttendee: false,
                                                    roomId: "room") }
        var flagChanges = 0
        editor.onSessionFlagChanged = { flagChanges += 1 }
        editor.save = { _ in HostActionResult.failed(.renameDisabled) }
        let first = await editor.rename("New Name")
        #expect(first.typedFailure == .renameDisabled)
        #expect(editor.isDisabledForSession)
        #expect(editor.refusal == HostActionFailure.renameDisabled.rawValue)
        #expect(flagChanges == 1)
        // The flag refuses later saves without calling the core.
        editor.save = { _ in HostActionResult.completed }
        let second = await editor.rename("Other")
        #expect(second.typedFailure == .renameDisabled)
        #expect(!editor.canEditName)
        editor.resetSession()
        #expect(!editor.isDisabledForSession)
        #expect(editor.refusal.isEmpty)
        let third = await editor.rename("Other")
        #expect(third.kind == .completed)
    }

    // MARK: Source pins (iOS-only and Kotlin views, the core seam)

    @Test func confirmationsAreSystemDialogsOnBothPlatforms() throws {
        let ios = try ppl2Source("Sources/Conclave/Features/Meeting/People/PeopleActions+iOS.swift")
        #expect(ios.contains(".confirmationDialog("))
        #expect(ios.contains("PeopleRowAccessibilityActions"))
        #expect(ios.contains("swipeActions(edge: .trailing, allowsFullSwipe: false)"))
        let kotlin = try ppl2Source("Sources/Conclave/Skip/ui/people/PeopleActions.kt")
        #expect(kotlin.contains("AlertDialog("))
        #expect(kotlin.contains("role = Role.Checkbox"))
        #expect(kotlin.contains("HostingTheme(inCall = true)"))
        let tile = try ppl2Source("Sources/Conclave/Skip/ui/call/stage/TileMenu.kt")
        #expect(tile.contains("PeopleActionPolicy.tileActions"))
        #expect(tile.contains("PeopleActionSource.tileMenu"))
        let tileIOS = try ppl2Source("Sources/Conclave/Features/Meeting/Stage/TileMenu+iOS.swift")
        #expect(tileIOS.contains("PeopleActionPolicy.tileActions"))
    }

    @Test func transferHostWritesNoRoleBeforeTheServer() throws {
        let vm = try ppl2Source("Sources/Conclave/Features/Meeting/MeetingViewModel.swift")
        let start = try #require(vm.range(of: "func transferHost(userId: String, onResult:"))
        let end = try #require(vm.range(of: "func setParticipantMediaPermissions(", range: start.upperBound..<vm.endIndex))
        let body = String(vm[start.lowerBound..<end.lowerBound])
        #expect(body.contains("socketManager.transferHost(userId: userId)"))
        #expect(!body.contains("hostUserId ="))
        #expect(!body.contains("applyHostSnapshot("))
        // PH2: the one command switch reports every exit through people.finish.
        #expect(vm.contains("func performPeopleCommand(_ command: PeopleCommand, _ ticket: HostActionTicket)"))
        #expect(vm.contains("_ = self?.people.finish(ticket, result)"))
    }

    @Test func newPeopleSourcesStayFlatAndDashFree() throws {
        let paths = ["Sources/Conclave/Features/Meeting/People/PeopleActions+iOS.swift",
                     "Sources/Conclave/Features/Meeting/People/PeopleActionPolicy.swift",
                     "Sources/Conclave/Features/Meeting/People/PeopleActionModels.swift",
                     "Sources/Conclave/Features/Meeting/People/PeopleFailurePlacementPolicy.swift",
                     "Sources/Conclave/Features/Meeting/People/HostActionLedger.swift",
                     "Sources/Conclave/Core/Session/HostActionFailurePolicy.swift",
                     "Sources/Conclave/Core/Session/DisplayNameEditor.swift",
                     "Sources/Conclave/Skip/ui/people/PeopleActions.kt"]
        for path in paths {
            let source = try ppl2Source(path)
            #expect(!source.contains("Gradient"), "\(path) draws a gradient")
            #expect(!source.contains("\u{2014}") && !source.contains("\u{2013}"), "\(path) has a long dash")
            #expect(!source.contains("Color(red:") && !source.contains("Color(0x"), "\(path) has a color literal")
        }
    }
}
#endif

private func ppl2Source(_ packageRelativePath: String) throws -> String {
    let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
    return try String(contentsOf: root.appendingPathComponent(packageRelativePath).standardizedFileURL, encoding: .utf8)
}
