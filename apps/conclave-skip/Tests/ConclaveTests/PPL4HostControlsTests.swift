#if !SKIP
import Foundation
import Testing
@testable import Conclave

/// PPL-4 (OUT/PLAN-screens.md section 5): Host Controls, the meeting access pages and the notice composer. The shared
/// HostControlsPresenter (PL4 pending intent, bulk rules, HostDrafts kept until the acknowledgement PH15, the R34
/// single-flight webinar link), HostControlsPolicy validation, the PH5 and PH6 socket surface on every platform file,
/// the PH1 host path in MeetingState and the view model, and source pins for the iOS-only and Kotlin views (S60 R6-3:
/// one HostControlsContent for every container). The Kotlin half is T/Skip/PPL2PPL4BridgeTests.kt.
@MainActor
struct PPL4HostControlsTests {
    private let me = "u-ishaan"

    private final class CommandLog {
        var commands: [PeopleCommand] = []
        var tickets: [HostActionTicket] = []
    }

    private func makeHost(sharing: Bool = false, hand: Bool = false, phase: String = MeetingPhaseKind.inCall.rawValue,
                          host: HostControlsInputs = HostControlsInputs.make(callSession: 1)) -> (PeoplePresenter, CommandLog) {
        let shell = MeetingShellPresenter()
        let people = PeoplePresenter(shell: shell, stage: StagePresenter(shell: shell))
        let log = CommandLog()
        people.onCommand = { command, ticket in
            log.commands.append(command)
            log.tickets.append(ticket)
        }
        people.platform = NoticePlatform.ios
        people.apply(PeopleInputs.make(
            callSession: 1, attempt: 1, phase: phase, localUserId: me,
            participants: [
                PeopleParticipantInput.make(userId: me, displayName: "Ishaan", isLocal: true),
                PeopleParticipantInput.make(userId: "u-lee", displayName: "Lee Park", isMuted: false, isHandRaised: hand,
                                            isScreenSharing: sharing, joinSerial: 1),
            ],
            isRosterLoaded: true, isAdmin: true, hostUserId: me, hostUserIds: [me]))
        people.host.apply(host)
        return (people, log)
    }

    // MARK: PL4: one knob transition per tap, server state only on the acknowledgement

    @Test func aPendingPolicyShowsItsIntentAndReturnsOnceOnFailure() {
        let (people, log) = makeHost()
        let host = people.host
        #expect(host.snapshot.isAvailable)
        #expect(host.snapshot.policy(.lockMeeting)?.shownOn == false)
        #expect(host.setPolicy(.lockMeeting, on: true) == .dispatched)
        let pending = host.snapshot.policy(.lockMeeting)
        #expect(pending?.isPending == true)
        #expect(pending?.shownOn == true)
        #expect(pending?.isOn == false)
        #expect(pending?.isEnabled == false)
        #expect(log.commands.first?.kind == .setPolicy)
        #expect(log.commands.first?.text == HostPolicyID.lockMeeting.rawValue)
        #expect(log.commands.first?.flag == true)
        // A second tap while pending emits nothing; the same value never dispatches.
        #expect(host.setPolicy(.lockMeeting, on: false) == .ignored)
        #expect(host.setPolicy(.allowGuests, on: true) == .ignored)
        people.finish(log.tickets[0], HostActionResult.failed(.rejectedByServer))
        let failed = host.snapshot.policy(.lockMeeting)
        #expect(failed?.isPending == false)
        #expect(failed?.shownOn == false)
        #expect(people.lastFailure?.sourceKey == HostPolicyID.lockMeeting.rawValue)
        #expect(people.lastFailure?.placement == HostFailurePlacement.panelInline.rawValue)
        // RECONCILE R17: the lock failure uses the S30 lock sentence.
        #expect(PeopleFailureCopy.kind(action: people.lastFailure?.action ?? "", failure: people.lastFailure?.failure ?? "",
                                       sourceKey: people.lastFailure?.sourceKey ?? "") == PeopleFailureCopy.lockMeeting)
    }

    @Test func theAcknowledgedServerStateIsWhatTheSwitchShowsAfterwards() {
        let (people, log) = makeHost()
        let host = people.host
        host.setPolicy(.photos, on: false)
        people.finish(log.tickets[0], HostActionResult.completed)
        // Still on until the core's inputs say otherwise (no optimistic write).
        #expect(host.snapshot.policy(.photos)?.shownOn == true)
        host.apply(HostControlsInputs.make(callSession: 1, isImageAttachmentsEnabled: false))
        #expect(host.snapshot.policy(.photos)?.shownOn == false)
    }

    @Test func recoveringDisablesEveryRowWithTheReason() {
        let (people, _) = makeHost(phase: MeetingPhaseKind.recovering.rawValue)
        let host = people.host
        #expect(host.snapshot.policy(.allowChat)?.isEnabled == false)
        #expect(host.snapshot.policy(.allowChat)?.reason == MeetingBlockedReason.reconnecting.rawValue)
        #expect(host.snapshot.bulkRow(.muteAll)?.isEnabled == false)
        #expect(host.setPolicy(.allowChat, on: false) == .ignored)
    }

    @Test func policyIdsAndPositivePhrasingStayStable() {
        // RECONCILE R16 renamed the titles, never the ids.
        #expect(HostPolicyID.directMessages.rawValue == "directMessages")
        #expect(HostPolicyID.readAloud.rawValue == "readAloud")
        let inputs = HostControlsInputs.make(isChatLocked: true, isTtsDisabled: true, isReactionsDisabled: false)
        #expect(!HostControlsPolicy.isOn(.allowChat, inputs: inputs))
        #expect(!HostControlsPolicy.isOn(.readAloud, inputs: inputs))
        #expect(HostControlsPolicy.isOn(.reactions, inputs: inputs))
        #expect(HostPolicyID.chatRows == [.allowChat, .directMessages, .photos, .readAloud, .reactions])
    }

    // MARK: Bulk (S50 6 f, Q9)

    @Test func bulkRowsFollowSharesAndHandsAndMediaBulkConfirms() {
        let (quiet, _) = makeHost()
        #expect(quiet.host.snapshot.visibleBulk().map { $0.bulk } == [.muteAll, .camerasOff])
        let (people, log) = makeHost(sharing: true, hand: true)
        let host = people.host
        #expect(host.snapshot.visibleBulk().map { $0.bulk } == [.muteAll, .camerasOff, .stopAllShares, .lowerAllHands])
        host.requestBulk(.muteAll)
        #expect(people.confirmation?.kind == .muteAll)
        #expect(people.confirmation?.source == PeopleActionSource.hostControls)
        #expect(log.commands.isEmpty)
        people.confirm(id: people.confirmation?.id ?? 0, block: false)
        #expect(log.commands.last?.kind == .bulk)
        #expect(log.commands.last?.text == HostBulkID.muteAll.rawValue)
        #expect(host.snapshot.bulkRow(.muteAll)?.isPending == true)
        // Lower All Hands acts at once.
        host.requestBulk(.lowerAllHands)
        #expect(log.commands.last?.text == HostBulkID.lowerAllHands.rawValue)
        #expect(people.confirmation == nil)
    }

    // MARK: PH15 drafts kept until the acknowledgement

    @Test func theInviteCodeDraftClearsOnlyAfterTheAcknowledgement() {
        let (people, log) = makeHost()
        let host = people.host
        host.drafts.meetingCode = "4821"
        host.setMeetingInviteCode("4821")
        #expect(host.snapshot.inviteCodePhase == HostFieldPhase.sending)
        people.finish(log.tickets[0], HostActionResult.failed(.ackTimedOut))
        #expect(host.drafts.meetingCode == "4821")
        #expect(host.snapshot.inviteCodePhase == HostFieldPhase.failed)
        #expect(people.lastFailure?.sourceKey == HostFieldID.inviteCode)
        host.setMeetingInviteCode("4821")
        people.finish(log.tickets[1], HostActionResult.completed)
        #expect(host.drafts.meetingCode.isEmpty)
        #expect(host.snapshot.inviteCodeSavedSerial == 1)
    }

    @Test func theNoticeCarriesItsLevelAndClearsItsDraftOnSuccess() {
        let (people, log) = makeHost()
        let host = people.host
        host.drafts.noticeText = "We start the Q&A in five minutes."
        host.drafts.noticeLevel = HostNoticeLevel.warning
        #expect(host.sendNotice("   ", level: HostNoticeLevel.info) == .ignored)
        #expect(host.sendNotice(host.drafts.noticeText, level: host.drafts.noticeLevel) == .dispatched)
        #expect(log.commands.last?.kind == .sendNotice)
        #expect(log.commands.last?.targetId == HostNoticeLevel.warning)
        #expect(host.snapshot.noticePhase == HostFieldPhase.sending)
        people.finish(log.tickets[0], HostActionResult.completed)
        #expect(host.drafts.noticeText.isEmpty)
        #expect(host.snapshot.noticeSentSerial == 1)
        #expect(host.snapshot.noticePhase == HostFieldPhase.sent)
    }

    @Test func noticeAndAccessRulesMatchTheServerLimits() {
        #expect(!HostControlsPolicy.showsNoticeCounter(1799))
        #expect(HostControlsPolicy.showsNoticeCounter(1800))
        #expect(HostControlsPolicy.isNoticeTooLong(2001))
        #expect(!HostControlsPolicy.canSendNotice(String(repeating: "a", count: 2001), isPending: false, isBlocked: false))
        #expect(HostControlsPolicy.canSendNotice("Hi", isPending: false, isBlocked: false))
        #expect(!HostControlsPolicy.canSendNotice("Hi", isPending: true, isBlocked: false))
        #expect(HostControlsPolicy.normalizedLevel("loud") == HostNoticeLevel.info)
        #expect(HostControlsPolicy.normalizedAccessKey("  ana@example.org ") == "ana@example.org")
        #expect(HostControlsPolicy.normalizedAccessKey("bad\tkey") == nil)
        #expect(HostControlsPolicy.normalizedAccessKey(String(repeating: "k", count: 257)) == nil)
        #expect(HostControlsPolicy.showsInvalidAccessKey("bad\nkey"))
        #expect(!HostControlsPolicy.showsInvalidAccessKey("   "))
        #expect(HostControlsPolicy.isValidSlug("team-sync"))
        #expect(!HostControlsPolicy.isValidSlug("ab"))
        #expect(HostControlsPolicy.capacity("5000") == 5000)
        #expect(HostControlsPolicy.capacity("5001") == nil)
    }

    @Test func accessListsSortAtApplyTimeAndKeysShowTheirOwnPending() {
        let (people, log) = makeHost(host: HostControlsInputs.make(callSession: 1, allowedKeys: ["zoe@x.org", "ana@x.org"],
                                                                    lockedAllowedKeys: ["ana@x.org"], blockedKeys: ["spam@x.org"]))
        let host = people.host
        #expect(host.snapshot.access.allowed == ["ana@x.org", "zoe@x.org"])
        #expect(host.snapshot.access.allowedCount == 2)
        #expect(host.snapshot.access.blockedCount == 1)
        host.revoke("zoe@x.org")
        #expect(host.snapshot.pendingAccessKeys == ["zoe@x.org"])
        #expect(log.commands.last?.kind == .revokeKey)
        host.requestBlock("new@x.org")
        #expect(people.confirmation?.kind == .block)
        people.confirm(id: people.confirmation?.id ?? 0, block: false)
        #expect(log.commands.last?.kind == .blockKey)
        #expect(log.commands.last?.targetId == "new@x.org")
    }

    // MARK: R34: ensureWebinarLink is single flight

    @MainActor
    private final class LinkGate {
        var calls = 0
        var continuation: CheckedContinuation<Void, Never>? = nil
    }

    @Test func concurrentLinkRequestsShareOneGeneration() async {
        let (people, _) = makeHost()
        let host = people.host
        let gate = LinkGate()
        host.linkProvider = { @MainActor in
            gate.calls += 1
            await withCheckedContinuation { continuation in gate.continuation = continuation }
            return "https://conclave.example/w/abc"
        }
        let first = Task { await host.ensureWebinarLink() }
        var spins = 0
        while gate.continuation == nil && spins < 1000 {
            await Task.yield()
            spins += 1
        }
        #expect(host.snapshot.webinar.linkPhase == WebinarLinkPhase.generating)
        let second = Task { await host.ensureWebinarLink() }
        for _ in 0..<20 { await Task.yield() }
        gate.continuation?.resume()
        let a = await first.value
        let b = await second.value
        #expect(gate.calls == 1)
        #expect(a == "https://conclave.example/w/abc")
        #expect(b == "https://conclave.example/w/abc")
        // A link that exists returns at once, with no generation.
        host.apply(HostControlsInputs.make(callSession: 1, isWebinarEnabled: true, webinarLinkURL: "https://conclave.example/w/abc"))
        #expect(await host.ensureWebinarLink() == "https://conclave.example/w/abc")
        #expect(gate.calls == 1)
    }

    // MARK: Lost host and reset

    @Test func losingHostMakesHostControlsUnavailableAndResetClearsDrafts() {
        let (people, _) = makeHost()
        let host = people.host
        host.drafts.noticeText = "draft"
        people.apply(PeopleInputs.make(callSession: 1, attempt: 1, phase: MeetingPhaseKind.inCall.rawValue, localUserId: me,
                                       participants: [PeopleParticipantInput.make(userId: me, displayName: "Ishaan", isLocal: true)],
                                       isRosterLoaded: true, isAdmin: false, hostUserId: "u-lee", hostUserIds: ["u-lee"]))
        #expect(!host.snapshot.isAvailable)
        #expect(host.setPolicy(.lockMeeting, on: true) == .ignored)
        // Drafts survive a role change (R40-7) and clear with the session reset.
        #expect(host.drafts.noticeText == "draft")
        people.reset()
        #expect(host.drafts.noticeText.isEmpty)
        #expect(host.snapshot == HostControlsSnapshot.empty.withRevision(host.snapshot.revision))
    }

    // MARK: Source pins: PH5, PH6 on every socket file; the PH1 host path; one content for every container

    @Test func participantMediaPermissionsAndPhotosReachEverySocketFile() throws {
        let events = try ppl4Source("Sources/Conclave/Core/Networking/SfuEvents.swift")
        #expect(events.contains("case setParticipantMediaPermissions = \"setParticipantMediaPermissions\""))
        #expect(events.contains("case participantMediaPermissionsChanged = \"participantMediaPermissionsChanged\""))
        for path in ["Sources/Conclave/Core/Networking/SocketIOManager.swift",
                     "Sources/Conclave/Core/Networking/SocketIOManager+Android.swift",
                     "Sources/Conclave/Core/Networking/SocketIOManager+macOS.swift"] {
            let source = try ppl4Source(path)
            #expect(source.contains("func setParticipantMediaPermissions(unmuteAllowed: Bool?, videoAllowed: Bool?)"), "\(path)")
            #expect(source.contains("func setImageAttachmentsEnabled(_ enabled: Bool)"), "\(path)")
            #expect(source.contains("var onParticipantMediaPermissionsChanged"), "\(path)")
        }
        let kotlin = try ppl4Source("Sources/Conclave/Skip/SocketIOManager+Android.kt")
        #expect(kotlin.contains("suspend fun setParticipantMediaPermissions(unmuteAllowed: Boolean?, videoAllowed: Boolean?)"))
        #expect(kotlin.contains("suspend fun setImageAttachmentsEnabled(enabled: Boolean)"))
        #expect(kotlin.contains("SocketEvent.participantMediaPermissionsChanged"))
        #expect(kotlin.contains("participantUnmuteAllowed = boolField(obj, \"participantUnmuteAllowed\")"))
    }

    @Test func theHostPathIsSeparateFromPeopleRows() throws {
        let state = try ppl4Source("Sources/Conclave/Core/State/MeetingState.swift")
        #expect(state.contains("@ObservationIgnored var onHostInputChanged: (() -> Void)? = nil"))
        #expect(state.contains("var isParticipantUnmuteAllowed: Bool = true {"))
        let vm = try ppl4Source("Sources/Conclave/Features/Meeting/MeetingViewModel.swift")
        #expect(vm.contains("private func bindHostControlsInputs()"))
        #expect(vm.contains("func makeHostControlsInputs() -> HostControlsInputs"))
        #expect(vm.contains("func toggleImageAttachmentsEnabled(onResult:"))
        // PH14: becoming host refreshes both configs once.
        #expect(vm.contains("private func beginHostConfigRefresh()"))
        #expect(vm.contains("await self.refreshMeetingConfigNow()"))
        #expect(vm.contains("await self.refreshWebinarConfigNow()"))
        // R34: the presenter's link provider is the core's generator.
        #expect(vm.contains("people.host.linkProvider = { [weak self] in"))
    }

    @Test func everyContainerRendersTheSameHostControlsContent() throws {
        let ios = try ppl4Source("Sources/Conclave/Features/Meeting/Host/HostControlsContent+iOS.swift")
        #expect(ios.contains("struct HostControlsContent<Route: Hashable>: View"))
        #expect(ios.contains("struct HostPageView<Route: Hashable>: View"))
        #expect(ios.contains(".confirmationDialog(ConclaveStrings.text(\"End Call for Everyone?\")"))
        #expect(!ios.contains(".tint("))
        let rows = try ppl4Source("Sources/Conclave/Features/Meeting/Host/HostRows+iOS.swift")
        #expect(rows.contains("row.isPending ? row.requestedOn : row.isOn") || rows.contains("row.shownOn"))
        let participants = try ppl4Source("Sources/Conclave/Features/Meeting/People/ParticipantsPanel+iOS.swift")
        #expect(participants.contains("HostPageView(people: people, page: page, link: { $0 })"))
        let kotlinRows = try ppl4Source("Sources/Conclave/Skip/ui/host/HostRows.kt")
        #expect(kotlinRows.contains("role = Role.Switch"))
        #expect(kotlinRows.contains("Switch(checked = shown, onCheckedChange = null"))
        let kotlinContent = try ppl4Source("Sources/Conclave/Skip/ui/host/HostControlsContent.kt")
        #expect(kotlinContent.contains("internal fun HostControlsContent(people: PeoplePresenter, reservation: PaddingValues"))
        let page = try ppl4Source("Sources/Conclave/Skip/ui/people/ParticipantsPage.kt")
        #expect(page.contains("HostPageContent(people, top, reservation, snackbar"))
        for path in ["Sources/Conclave/Features/Meeting/Host/AccessPages+iOS.swift",
                     "Sources/Conclave/Features/Meeting/Host/NoticeComposer+iOS.swift",
                     "Sources/Conclave/Features/Meeting/Host/HostControlsContent+iOS.swift",
                     "Sources/Conclave/Features/Meeting/Host/HostRows+iOS.swift",
                     "Sources/Conclave/Features/Meeting/Host/HostControlsPresenter.swift",
                     "Sources/Conclave/Features/Meeting/Host/HostControlsModels.swift",
                     "Sources/Conclave/Features/Meeting/Host/HostControlsPolicy.swift",
                     "Sources/Conclave/Skip/ui/host/AccessPages.kt",
                     "Sources/Conclave/Skip/ui/host/NoticeComposer.kt",
                     "Sources/Conclave/Skip/ui/host/HostRows.kt",
                     "Sources/Conclave/Skip/ui/host/HostControlsContent.kt"] {
            let source = try ppl4Source(path)
            #expect(!source.contains("Gradient"), "\(path) draws a gradient")
            #expect(!source.contains("\u{2014}") && !source.contains("\u{2013}"), "\(path) has a long dash")
            #expect(!source.contains("Color(red:") && !source.contains("Color(0x"), "\(path) has a color literal")
        }
    }
}

private func ppl4Source(_ packageRelativePath: String) throws -> String {
    let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
    return try String(contentsOf: root.appendingPathComponent(packageRelativePath).standardizedFileURL, encoding: .utf8)
}
#endif
