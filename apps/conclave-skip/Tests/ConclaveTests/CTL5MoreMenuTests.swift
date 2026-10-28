#if !SKIP
import Foundation
import Testing
@testable import Conclave

/// CTL-5 (OUT/PLAN-screens.md section 5): More, the iOS native menu with its dark fallback sheet and the Android in-call
/// action sheet. The shared `MoreMenuPolicy`, the presenter's More intents, `PanelCoordinator.presentFromMore` and the
/// CL13 More fixtures run here against the real S1 shell and stage; the iOS views (not compiled by the macOS host) and the
/// Kotlin views are read. The Kotlin half is T/Skip/CTL5CTL6BridgeTests.kt. Covers S30 5 l (unit halves of l1 to l3, l5,
/// l7, l10 to l13), S30 7 (rows keep their place while recovering or offline, with reasons), CL16 (the menu budget),
/// CL21 and CC20 (keyboard commands), D17 (panels after the sheet), RECONCILE R8, R14, R18, OQ6 (no Effects row), OQ7
/// (no voice agent). Not run in the heads-down push.
@MainActor
struct CTL5MoreMenuTests {
    // MARK: Harness

    static let identity = MeetingSessionIdentity(callSession: 1, attempt: 1, attemptToken: "ctl5-tests")

    static func joined(isAdmin: Bool = false, isNetworkOffline: Bool = false, isReactionsDisabled: Bool = false,
                       pendingUsersCount: Int = 0, unreadChatCount: Int = 0, isCameraOff: Bool = false) -> MeetingShellInputs {
        MeetingShellInputs.make(identity: identity, connectionState: .joined, isNetworkOffline: isNetworkOffline, roomId: "abc-defg-hij",
                                displayName: "You", isAdmin: isAdmin, isMuted: false, isCameraOff: isCameraOff,
                                unreadChatCount: unreadChatCount, pendingUsersCount: pendingUsersCount,
                                isReactionsDisabled: isReactionsDisabled)
    }

    static func ids(_ state: ControlsFixtureState) -> [String] {
        ControlsFixtureSession(state: state).controls.more.itemIds
    }

    static let guestIds = ["reactions", "hand", "screenShare", "captions", "flipCamera", "participants", "activities", "settings",
                           "invite", "copyLink", "meetingDetails"]
    static let hostIds = guestIds + ["hostControls", "lockMeeting", "endForEveryone"]

    // MARK: Rows and order (S30 5 c, f, l1, l2)

    @Test func guestAndHostRowsFollowThePriorityOrder() {
        let guest = ControlsFixtureSession(state: .guest)
        #expect(guest.controls.more.itemIds == Self.guestIds)
        #expect(guest.controls.more.sections.map { $0.id } == ["reactions", "you", "panels", "share"])
        #expect(!guest.controls.more.hasHostSection)
        let host = ControlsFixtureSession(state: .host)
        #expect(host.controls.more.itemIds == Self.hostIds)
        // The Host section is last (farthest from the control); End is its last row (CL15).
        #expect(host.controls.more.sections.last?.id == MoreSectionID.host)
        #expect(MoreMenuPolicy.hostItems(host.controls.more).map { $0.id } == ["hostControls", "lockMeeting", "endForEveryone"])
        #expect(host.controls.more.meetingLink == ControlsFixtureScript.meetingLink && host.controls.more.roomLabel == ControlsFixtureScript.roomLabel)
        #expect(host.controls.more.layoutModes == ["auto", "tiled", "spotlight", "sidebar"])
    }

    @Test func rowsWhosePanelHasNotLandedStayHiddenAndThereIsNoVoiceAgent() {
        // PLAN-screens 2: under the call flag a row whose native panel has not landed stays hidden.
        #expect(!MoreMenuPolicy.isLanded(.transcript) && !MoreMenuPolicy.isLanded(.layout) && !MoreMenuPolicy.isLanded(.effects))
        for panel in [MeetingPanel.chat, .participants, .activities, .settings, .webinarQA, .meetingInfo, .hostControls] {
            #expect(MoreMenuPolicy.isLanded(panel), "\(panel.rawValue)")
        }
        let host = ControlsFixtureSession(state: .webinarHost)
        for hidden in ["transcript", "layout", "effects", "systemVideoEffects"] {
            #expect(!host.controls.more.itemIds.contains(hidden), "\(hidden) shows")
        }
        // OQ6 default A: even with live notes on, effects published and a running camera, the rows wait for their panels;
        // the system module waits for CC11.
        let inputs = CallControlsInputs.make(rows: host.shell.controls.rows, phase: .inCall, isLocalHost: true,
                                             meetingLink: "https://conclave.acmvit.in/abc", liveNotes: .live, effectsPanelAvailable: true)
        let sections = MoreMenuPolicy.sections(inputs: inputs, composition: .compact, overflowIds: [], reactions: ReactionPaletteSnapshot.empty)
        #expect(!sections.flatMap { $0.items }.contains { $0.kind == .effects || $0.kind == .transcript })
        // Owner OQ7: the AI voice agent is web only.
        #expect(!MoreItemID.allCases.map { $0.rawValue }.contains { $0.lowercased().contains("voice") })
    }

    @Test func webinarHostsGetQuestionsWithTheUnseenCountAndTheMoreDot() {
        let session = ControlsFixtureSession(state: .webinarHost)
        let qa = session.controls.more.item(.qa)
        #expect(qa?.count == 2 && qa?.status == .unseen)
        // RECONCILE R18: hosts and attendees only; a non-host never sees the row.
        #expect(ControlsFixtureSession(state: .guest).controls.more.item(.qa) == nil)
        // Activities names the running game.
        let activities = session.controls.more.item(.activities)
        #expect(activities?.status == .running && activities?.statusName == "Trivia")
        // The More dot marks unseen questions behind More (no waiting count on this host).
        #expect(session.controls.bar.control(.more)?.showsDot == true)
        #expect(ControlsFixtureSession(state: .guest).controls.bar.control(.more)?.showsDot == false)
        // Opening Q&A from More presents with invoker .more.
        #expect(session.controls.select(.qa) == .dispatched)
        #expect(session.panelReadout() == "panel=webinarQA invoker=more")
    }

    @Test func noRoomLinkHidesInviteAndCopyLink() {
        // S30 5 l12.
        let session = ControlsFixtureSession(state: .noLink)
        #expect(session.controls.more.meetingLink.isEmpty)
        #expect(session.controls.more.item(.invite) == nil && session.controls.more.item(.copyLink) == nil)
        #expect(session.controls.more.item(.meetingDetails) != nil)
        #expect(session.controls.copyLink(postsToast: true) == .ignored)
    }

    @Test func theWideBarOmitsItsOwnControlsUnlessTheFitMovedThem() {
        let wide = ControlsFixtureSession(state: .wide)
        for onBar in ["hand", "screenShare", "participants"] {
            #expect(!wide.controls.more.itemIds.contains(onBar), "\(onBar) doubles the bar")
        }
        wide.controls.setOverflow(ids: ["participants", "hand"])
        #expect(wide.controls.more.itemIds.contains("participants") && wide.controls.more.itemIds.contains("hand"))
        // A moved Chat gets its own row with the unread count (F00 C05 f).
        let guest = CTL5Harness(Self.joined(unreadChatCount: 4))
        #expect(guest.controls.more.item(.chat) == nil)
        guest.controls.setOverflow(ids: ["chat"])
        #expect(guest.controls.more.item(.chat)?.count == 4 && guest.controls.more.itemIds[1] == "hand")
        #expect(guest.controls.more.section(MoreSectionID.panels)?.items.first?.kind == .chat)
    }

    @Test func aMovedChatWithUnreadMessagesPutsTheDotOnMore() {
        // CHT-8 (batch 6 integrator, HD request B6-T5 R4; S30 5 m, F00 C05 f): no badge without a matching row, reversed.
        let unread = CTL5Harness(Self.joined(unreadChatCount: 3))
        #expect(unread.controls.bar.control(.more)?.showsDot == false)
        unread.controls.setOverflow(ids: ["chat"])
        #expect(unread.controls.bar.control(.more)?.showsDot == true)
        unread.controls.setOverflow(ids: [])
        #expect(unread.controls.bar.control(.more)?.showsDot == false)
        let read = CTL5Harness(Self.joined())
        read.controls.setOverflow(ids: ["chat"])
        #expect(read.controls.bar.control(.more)?.showsDot == false)
        #expect(ControlBarPolicy.chatMovedWithUnread(inputs: unread.controls.inputs, overflowIds: ["chat"]))
        #expect(!ControlBarPolicy.chatMovedWithUnread(inputs: read.controls.inputs, overflowIds: ["chat"]))
    }

    // MARK: Recovery and offline (S30 7, R10)

    @Test func recoveryAndOfflineKeepEveryRowWithItsReason() {
        #expect(Self.ids(.recovering) == Self.ids(.guest) && Self.ids(.offline) == Self.ids(.guest))
        #expect(Self.ids(.hostRecovering) == Self.ids(.host) && Self.ids(.hostOffline) == Self.ids(.host))
        let recovering = ControlsFixtureSession(state: .hostRecovering).controls.more
        #expect(recovering.isRecovering)
        for blocked in [MoreItemID.reactions, .hand, .screenShare, .flipCamera, .lockMeeting, .endForEveryone] {
            let item = recovering.item(blocked)
            #expect(item?.isEnabled == false && item?.reason == .reconnecting, "\(blocked.rawValue)")
        }
        // Panels, captions and the local link stay live (S30 7 rule: panels, local preferences and Leave stay available).
        for live in [MoreItemID.participants, .activities, .settings, .captions, .invite, .copyLink, .meetingDetails, .hostControls] {
            #expect(recovering.item(live)?.isEnabled == true, "\(live.rawValue)")
        }
        let offline = ControlsFixtureSession(state: .hostOffline).controls.more
        #expect(offline.isRecovering && offline.item(.lockMeeting)?.reason == .offline && offline.item(.hand)?.reason == .offline)
        #expect(offline.item(.endForEveryone)?.reason == .offline && offline.item(.flipCamera)?.reason == .offline)
        // A disabled row is ignored without a toast (it already shows its reason): S30 7 rule 4.
        let session = ControlsFixtureSession(state: .hostRecovering)
        #expect(session.controls.select(.hand) == .ignored && session.counters.toggleHand == 0 && session.controls.explainCount == 0)
        #expect(session.controls.select(.participants) == .dispatched)
        #expect(session.panelReadout() == "panel=participants invoker=more")
        #expect(ControlsFixtureSession(state: .guest).controls.more.isRecovering == false)
    }

    @Test func aRemotePresenterNamesTheShareReason() {
        // S30 5 l6 on the compact composition (the wide fixture carries Share on the bar).
        let session = ControlsFixtureSession(state: .remoteShare)
        session.controls.setCompositionOverride(.compact)
        let share = session.controls.more.item(.screenShare)
        #expect(share?.reason == .remoteShareActive && share?.reasonName == "Avery" && share?.isEnabled == false)
        #expect(session.controls.select(.screenShare) == .ignored && session.counters.toggleShare == 0)
    }

    // MARK: Actions (S30 0.5 mapping)

    @Test func panelRowsPresentFromMoreOnceAndOnlyOnce() {
        let session = ControlsFixtureSession(state: .guest)
        #expect(session.controls.select(.participants) == .dispatched)
        #expect(session.panelReadout() == "panel=participants invoker=more" && session.counters.panelPresent == 1)
        // The panel already current: nothing new, nothing played.
        #expect(session.controls.select(.participants) == .ignored)
        #expect(session.controls.select(.settings) == .dispatched)
        #expect(session.shell.panels.snapshot.pending?.panel == .settings && session.shell.panels.snapshot.pending?.invoker == .more)
        #expect(session.controls.select(.meetingDetails) == .dispatched)
        // Every panel row counts as a request, the ignored repeat included.
        #expect(session.controls.panelRequestCount == 4)
    }

    @Test func presentFromMoreReportsWhetherAnythingChanged() {
        let coordinator = PanelCoordinator(session: 4)
        #expect(coordinator.presentFromMore(.participants))
        #expect(coordinator.snapshot.current?.invoker == .more && coordinator.snapshot.current?.panel == .participants)
        #expect(!coordinator.presentFromMore(.participants))
        // A destination for the current panel is a change (a destination request), never a new presentation.
        #expect(coordinator.presentFromMore(.participants, destination: .peopleWaiting))
        #expect(coordinator.destinationRequest?.destination == .peopleWaiting && coordinator.destinationRequest?.invoker == .more)
        // A replacement queues behind the closing panel with invoker .more.
        #expect(coordinator.presentFromMore(.activities))
        #expect(coordinator.snapshot.isDismissing && coordinator.snapshot.pending?.panel == .activities)
        #expect(!coordinator.presentFromMore(.activities))
    }

    @Test func localActionsGoToTheCoreThroughOneRequestHook() {
        let session = ControlsFixtureSession(state: .host)
        #expect(session.controls.select(.captions) == .dispatched && session.controls.more.item(.captions)?.isOn == true)
        #expect(session.controls.setLayoutMode("tiled") == .dispatched && session.controls.more.layoutMode == "tiled")
        #expect(session.controls.setLayoutMode("tiled") == .ignored && session.controls.setLayoutMode("grid") == .ignored)
        #expect(session.controls.select(.flipCamera) == .dispatched)
        #expect(session.controls.select(.lockMeeting) == .dispatched && session.controls.more.item(.lockMeeting)?.isOn == true)
        #expect(session.countersReadout().contains("flipCamera=1 captions=1 layout=1 lock=1"))
        // Without a core (`onRequest` nil) the same rows answer ignored, so the view plays nothing.
        let bare = CTL5Harness(Self.joined())
        #expect(bare.controls.select(.captions) == .ignored && bare.controls.select(.flipCamera) == .ignored)
    }

    @Test func pendingLockReadsLockingAndIgnoresTaps() {
        let h = CTL5Harness(Self.joined(isAdmin: true)) { shell in
            CallControlsInputs.fromShell(shell, isRoomLocked: false, isRoomLockPending: true, roomLockRequestedOn: true)
        }
        let lock = h.controls.more.item(.lockMeeting)
        #expect(lock?.isPending == true && lock?.isEnabled == false && lock?.status == .pending)
        #expect(h.controls.select(.lockMeeting) == .ignored)
        // A pending hand reads "Raising" and is disabled (S30 6 f).
        #expect(MoreMenuPolicy.handState(MoreItem(id: "hand", kind: .hand, isOn: false, isEnabled: false, isPending: true, reason: .none,
                                                  reasonName: "", status: .pending, statusName: "", count: 0)) == .raising)
    }

    @Test func copyLinkPostsTheToastOnlyWhereThePlatformAsks() {
        let session = ControlsFixtureSession(state: .guest)
        let queuedBefore = session.stage.queuedToasts
        #expect(session.controls.select(.copyLink) == .dispatched && session.controls.copyLinkCount == 1)
        #expect(session.stage.toast?.kind == NoticeKind.linkCopied || session.stage.queuedToasts > queuedBefore)
        // Android API 33 and later: no app snackbar (the system shows its own confirmation).
        let quiet = ControlsFixtureSession(state: .guest)
        let toastBefore = quiet.stage.toast?.id
        let queuedQuiet = quiet.stage.queuedToasts
        #expect(quiet.controls.copyLink(postsToast: false) == .dispatched)
        #expect(quiet.stage.toast?.id == toastBefore && quiet.stage.queuedToasts == queuedQuiet)
        #expect(session.countersReadout().contains("copyLink=1"))
    }

    @Test func endFromMoreBelongsToMoreAndOnlyToMore() {
        // R09, S50 PH17: More's dialog for invoker "more"; the iOS Leave control does not present it.
        let session = ControlsFixtureSession(state: .host)
        #expect(session.controls.select(.endForEveryone) == .dispatched)
        let leave = session.controls.leaveState
        #expect(leave.confirmationInvoker == MeetingConfirmationInvoker.more && leave.confirmationId != 0)
        #expect(MoreMenuPolicy.presentsEndDialog(leave) && MoreMenuPolicy.playsEndPrompt(previousId: 0, leave: leave))
        #expect(!MoreMenuPolicy.playsEndPrompt(previousId: leave.confirmationId, leave: leave))
        #expect(!LeaveControlPolicy.presentsDialog(leave, includesMoreInvoker: false))
        #expect(LeaveControlPolicy.presentsDialog(leave, includesMoreInvoker: true))
        // A recovering host: End stays in place, disabled with its reason; nothing is asked.
        let recovering = ControlsFixtureSession(state: .hostRecovering)
        #expect(recovering.controls.select(.endForEveryone) == .ignored && recovering.controls.leaveState.confirmationId == 0)
    }

    @Test func rowsThatOpenSomethingWaitForTheSheetToGo() {
        // D17 and NF 9.1 (Android sheet and iOS fallback sheet); CC15 for a share start.
        let more = ControlsFixtureSession(state: .host).controls.more
        for id in [MoreItemID.participants, .activities, .settings, .meetingDetails, .hostControls, .endForEveryone, .invite] {
            if let item = more.item(id) { #expect(MoreMenuPolicy.actsAfterDismiss(item), "\(id.rawValue)") }
        }
        for id in [MoreItemID.reactions, .hand, .captions, .copyLink, .lockMeeting, .flipCamera] {
            if let item = more.item(id) { #expect(!MoreMenuPolicy.actsAfterDismiss(item), "\(id.rawValue)") }
        }
        let share = MoreItem(id: "screenShare", kind: .screenShare, isOn: false, isEnabled: true, isPending: false, reason: .none,
                             reasonName: "", status: .none, statusName: "", count: 0)
        #expect(MoreMenuPolicy.actsAfterDismiss(share))
        let stop = MoreItem(id: "screenShare", kind: .screenShare, isOn: true, isEnabled: true, isPending: false, reason: .none,
                            reasonName: "", status: .sharing, statusName: "", count: 0)
        #expect(!MoreMenuPolicy.actsAfterDismiss(stop))
    }

    @Test func androidTilesFollowTheFiveDOrder() {
        let host = ControlsFixtureSession(state: .host).controls.more
        #expect(MoreMenuPolicy.tiles(host).map { $0.id } == ["screenShare", "captions", "participants", "activities", "invite", "copyLink",
                                                              "meetingDetails", "settings"])
        let webinar = ControlsFixtureSession(state: .webinarHost).controls.more
        #expect(MoreMenuPolicy.tiles(webinar).map { $0.id }.suffix(3) == ["meetingDetails", "qa", "settings"])
        // Flip and the iOS system module are never Android tiles (S30 5 f rows 6 and 12).
        #expect(!MoreMenuPolicy.androidTileOrder.contains(.flipCamera) && !MoreMenuPolicy.androidTileOrder.contains(.systemVideoEffects))
    }

    // MARK: Menu budget (CL16)

    @Test func theMenuBudgetChoosesTheMenuOrTheSheet() {
        let guest = ControlsFixtureSession(state: .guest).controls
        #expect(guest.moreMetrics == MoreMenuMetrics(rows: 6, twoLineRows: 1, hasPalette: true, mediumRows: 1, separators: 3))
        #expect(MoreMenuPolicy.estimatedHeight(guest.moreMetrics, textScale: 1) == 486)
        let host = ControlsFixtureSession(state: .host).controls
        #expect(host.moreMetrics == MoreMenuMetrics(rows: 7, twoLineRows: 1, hasPalette: true, mediumRows: 1, separators: 4))
        #expect(MoreMenuPolicy.estimatedHeight(host.moreMetrics, textScale: 1) == 538)
        #expect(MoreMenuPolicy.estimatedHeight(host.moreMetrics, textScale: 23.0 / 17.0) > 700)
        // 375 x 667 leaves about 575 pt above the control; 390 x 844 about 690 pt.
        #expect(!MoreMenuPolicy.usesSheet(estimate: 538, menuSpace: 575, isAccessibilitySize: false, isVerticalBar: false))
        #expect(MoreMenuPolicy.usesSheet(estimate: 538, menuSpace: 500, isAccessibilitySize: false, isVerticalBar: false))
        #expect(MoreMenuPolicy.usesSheet(estimate: 300, menuSpace: 900, isAccessibilitySize: true, isVerticalBar: false))
        #expect(MoreMenuPolicy.usesSheet(estimate: 300, menuSpace: 900, isAccessibilitySize: false, isVerticalBar: true))
        #expect(MoreMenuPolicy.menuHeightReadout(estimate: 537.6, space: 575, usesSheet: false) == "estimate 538 of space 575 form menu")
        // A blocked palette becomes one two-line reason row.
        let recovering = ControlsFixtureSession(state: .recovering).controls.moreMetrics
        #expect(!recovering.hasPalette && recovering.twoLineRows > guest.moreMetrics.twoLineRows)
        // Metrics stay put when only a count changes (S30 5 k).
        let waiting = CTL5Harness(Self.joined(isAdmin: true, pendingUsersCount: 1))
        let before = waiting.controls.moreMetrics
        waiting.shell.apply(Self.joined(isAdmin: true, pendingUsersCount: 2))
        waiting.refresh()
        #expect(waiting.controls.moreMetrics == before && waiting.controls.more.item(.participants)?.count == 2)
    }

    @Test func snapshotsPublishOnlyOnChange() {
        let h = CTL5Harness(Self.joined())
        let more = h.controls.more.revision
        let reactions = h.controls.reactions.revision
        let commands = h.controls.commands.revision
        h.refresh()
        #expect(h.controls.more.revision == more && h.controls.reactions.revision == reactions && h.controls.commands.revision == commands)
        h.shell.apply(Self.joined(isReactionsDisabled: true))
        h.refresh()
        #expect(h.controls.reactions.revision == reactions + 1 && h.controls.more.revision == more + 1)
    }

    // MARK: Keyboard commands (S30 1 g, CL21)

    @Test func keyboardCommandsFollowTheControlsAndTheRole() {
        let guest = ControlsFixtureSession(state: .guest)
        let visible = guest.controls.commands.items.filter { $0.isVisible }.map { $0.id }
        #expect(visible == ["microphone", "camera", "hand", "chat", "participants", "screenShare"])
        #expect(guest.controls.perform(.lockMeeting) == .ignored)
        #expect(guest.controls.perform(.microphone) == .dispatched && guest.counters.toggleMicrophone == 1)
        #expect(guest.controls.perform(.participants) == .dispatched && guest.panelReadout() == "panel=participants invoker=call")
        let host = ControlsFixtureSession(state: .host)
        #expect(host.controls.commands.item(.lockMeeting)?.isVisible == true && host.controls.perform(.lockMeeting) == .dispatched)
        // A blocked command is listed disabled and passes through (keyboard commands explain nothing).
        let recovering = ControlsFixtureSession(state: .wideRecovering)
        #expect(recovering.controls.commands.item(.screenShare)?.isEnabled == false)
        #expect(recovering.controls.perform(.screenShare) == .ignored && recovering.controls.explainCount == 0)
        // Attendees: Raise Hand (with the capability) only.
        let attendee = ControlsFixtureSession(state: .attendee)
        #expect(attendee.controls.commands.items.filter { $0.isVisible }.map { $0.id } == ["hand"])
    }

    // MARK: Fixtures (CL13)

    @Test func moreFixturesBuildAndReadOut() {
        for state in [ControlsFixtureState.webinarHost, .noLink, .reactionsOff, .hostReactionsOff, .moreHandRaising] {
            let session = ControlsFixtureSession(state: state)
            #expect(session.controls.bar.controls.last?.kind == .leave, "\(state.rawValue)")
            #expect(session.moreReadout().hasPrefix("reactions:"), "\(state.rawValue)")
            #expect(ControlsFixtureScript.state(named: state.rawValue) == state)
        }
        #expect(ControlsFixtureSession(state: .hostRecovering).moreReadout().hasPrefix("recovering reactions:reactions(reconnecting)"))
        #expect(ControlsFixtureSession(state: .guest).menuHeightReadout() == "none")
        #expect(ControlsFixtureSession(state: .guest).countersReadout().contains("endRequested=0 endConfirmed=0"))
    }

    // MARK: Source scans (the iOS views are not compiled by the macOS host; Kotlin is read)

    @Test func iosMoreIsTheNativeMenuWithTheDarkFallbackSheet() throws {
        let menu = ctl5Normalized(try ctl5Source("Sources/Conclave/Features/Meeting/Controls/MoreMenu+iOS.swift"))
        let sheet = ctl5Normalized(try ctl5Source("Sources/Conclave/Features/Meeting/Controls/MoreSheet+iOS.swift"))
        let cell = ctl5Normalized(try ctl5Source("Sources/Conclave/Features/Meeting/Controls/CallControlCell+iOS.swift"))
        let bar = ctl5Normalized(try ctl5Source("Sources/Conclave/Features/Meeting/Controls/CallControlBar+iOS.swift"))
        for text in [menu, sheet] { #expect(text.hasPrefix("#if os(iOS) && !SKIP")) }
        // CL5, CL16, RECONCILE R8: the priority order, the budget, the fallback sheet in the in-call dark scheme.
        #expect(menu.contains(".menuOrder(.priority)"))
        #expect(menu.contains("MoreMenuPolicy.usesSheet(estimate: estimate, menuSpace: Double(menuSpace),"))
        #expect(menu.contains(".presentationDetents([.medium, .large])") && menu.contains(".preferredColorScheme(.dark)"))
        #expect(menu.contains(".sheet(isPresented: $showsSheet, onDismiss: performDeferred)"))
        #expect(menu.contains("controls.stage.setTransientChrome(id: ChromeAutoHidePolicy.moreSheet, open: open)"))
        // One Host submenu; End destructive last; the palette nearest the control; the medium share row with the F00 payload.
        #expect(menu.contains("Label(ConclaveStrings.text(\"Host\"), systemImage: ConclaveSymbols.crownFill)"))
        #expect(menu.contains("Button(role: .destructive)"))
        #expect(menu.contains("ConclaveReactionPalette(options: MoreCopy.paletteOptions(reactions)"))
        #expect(menu.contains("ShareLink(item: url, subject: Text(ConclaveStrings.text(\"Join My Conclave Meeting\")), message: Text(ConclaveStrings.text(\"Join me in this Conclave meeting.\")), preview: SharePreview(Text(more.roomLabel)))"))
        #expect(menu.contains(".accessibilityLabel(ConclaveStrings.text(\"Share Invite\"))"))
        // Feedback lives on the control and fires only on dispatched (S30 5 h).
        for kind in [".reactionSent, trigger: reactionCounter", "handKind, trigger: handCounter", ".linkCopied, trigger: copyCounter",
                     ".selectionChanged, trigger: flipCounter", ".endForEveryonePrompted, trigger: endPromptCounter"] {
            #expect(menu.contains(".conclaveGestureFeedback(" + kind + ")"), "\(kind)")
        }
        #expect(menu.contains("if controls.select(MoreItemID.hand) == ControlTapResult.dispatched { onHand(raising) }"))
        #expect(menu.contains("if inSheet && MoreMenuPolicy.actsAfterDismiss(item) {"))
        #expect(menu.contains("MoreMenuPolicy.presentsEndDialog(controls.leaveState)"))
        // The fallback sheet: a List under a "More" heading with Close.
        #expect(sheet.contains("NavigationStack {") && sheet.contains(".navigationTitle(ConclaveStrings.text(\"More\"))"))
        #expect(sheet.contains(".accessibilityLabel(ConclaveStrings.text(\"Close\"))"))
        // The cell routes More here with the bar's uncapped size and room; the bar keeps its CTL-1 and CTL-2 pins.
        #expect(cell.contains("MoreControl(model: model, controls: controls, diameter: diameter, textSize: textSize, menuSpace: menuSpace,"))
        #expect(cell.contains(".disabled(model.reason == ControlBlockedReason.leaving)") && !cell.contains(".disabled(!"))
        #expect(bar.contains(".focusedSceneValue(controls)") && bar.contains("isAccessibilityText: dynamicTypeSize.isAccessibilitySize"))
        for text in [menu, sheet] {
            for pattern in ["glassEffect", "GlassEffectContainer", "HapticManager", "MeetingViewModel", "sensoryFeedback(", "UIScreen.main",
                            "Image(systemName: \""] {
                #expect(!text.contains(pattern), "uses \(pattern)")
            }
        }
    }

    @Test func iosKeyboardCommandsAreOneSceneMenu() throws {
        let commands = ctl5Normalized(try ctl5Source("Sources/Conclave/Features/Meeting/Controls/CallCommands+iOS.swift"))
        let main = ctl5Normalized(try ctl5Source("Darwin/Sources/Main.swift"))
        #expect(commands.hasPrefix("#if os(iOS) && !SKIP"))
        #expect(commands.contains("public struct ConclaveCallCommands: Commands {"))
        #expect(commands.contains("@FocusedValue(CallControlsPresenter.self) private var controls: CallControlsPresenter?"))
        #expect(commands.contains("CommandMenu(Text(CallCommandsCopy.menuTitle)) { if let controls { CallCommandButtons(controls: controls) } }"))
        #expect(commands.contains("_ = controls.perform(item.command)") && commands.contains(".disabled(!item.isEnabled)"))
        #expect(!commands.contains("conclaveGestureFeedback"), "keyboard commands play nothing")
        // CC20: registered once by the Darwin scene, iOS only.
        #expect(main.contains("#if os(iOS)") && main.contains(".commands { ConclaveCallCommands() }"))
        #expect(main.components(separatedBy: "ConclaveCallCommands()").count - 1 == 1)
        #expect(main.contains(".windowResizability(.contentMinSize)"))
    }

    @Test func androidMoreSheetActsAfterTheSheetIsGone() throws {
        let sheet = ctl5Normalized(try ctl5Source("Sources/Conclave/Skip/ui/call/controls/MoreSheet.kt"))
        let component = ctl5Normalized(try ctl5Source("Sources/Conclave/Skip/ui/components/ConclaveActionSheet.kt"))
        let bar = ctl5Normalized(try ctl5Source("Sources/Conclave/Skip/ui/call/controls/CallControlBar.kt"))
        let keys = ctl5Normalized(try ctl5Source("Sources/Conclave/Skip/ui/call/controls/CallKeyboardShortcuts.kt"))
        #expect(sheet.contains("ConclaveActionSheet( identifier = \"sheet.more\","))
        #expect(sheet.contains("controls.noteMoreSheetDismissed() onDismissed()"))
        #expect(sheet.contains("dismissesSheet = MoreMenuPolicy.actsAfterDismiss(item),"))
        #expect(sheet.contains("stage.setTransientChrome(id = ChromeAutoHidePolicy.moreSheet, open = true)"))
        #expect(sheet.contains("NativeMeetingShare.shareMeetingLink(link = more.meetingLink, subject = shareSubject, text = shareText,"))
        #expect(sheet.contains("val postsToast = Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU"))
        #expect(sheet.contains("if (controls.copyLink(postsToast = postsToast) == ControlTapResult.dispatched) { haptics.gesture(FeedbackKind.linkCopied) }"))
        // The component hides first and reports after the hide (D17), for tiles and host rows alike.
        #expect(component.components(separatedBy: "scope.launch { sheetState.hide() }.invokeOnCompletion {").count - 1 == 2)
        #expect(component.contains("if (host.kind == ConclaveActionRowKind.Destructive) HorizontalDivider()"))
        #expect(component.contains("ModalBottomSheetProperties(isAppearanceLightStatusBars = false, isAppearanceLightNavigationBars = false)"))
        #expect(component.contains("ConclaveBanner(kind = ConclaveBannerKind.Warning, text = notice, identifier = \"$identifier.notice\", inCall = true)"))
        // The bar's More opens the sheet and draws Engaged while it shows; More plays nothing.
        #expect(bar.contains("CallControlKind.more -> MoreControlCell(controls, control, width)"))
        #expect(bar.contains("if (sheetOpen) MoreSheet(controls, onDismissed = { sheetOpen = false })"))
        #expect(keys.contains("controls.perform(command) != ControlTapResult.ignored"))
        for text in [sheet, bar, keys] {
            for pattern in ["@Stable", "@Immutable", "MeetingViewModel", "LazyVerticalGrid", "Color(0x", "LocalHapticFeedback", "AlertDialog("] {
                #expect(!text.contains(pattern), "uses \(pattern)")
            }
        }
    }

    @Test func ctl5SourcesStayFlatDashFreeAndSkipLite() throws {
        let files = ["Sources/Conclave/Features/Meeting/Controls/MoreMenuPolicy.swift",
                     "Sources/Conclave/Features/Meeting/Controls/MoreMenu+iOS.swift",
                     "Sources/Conclave/Features/Meeting/Controls/MoreSheet+iOS.swift",
                     "Sources/Conclave/Features/Meeting/Controls/CallCommands+iOS.swift",
                     "Sources/Conclave/Skip/ui/call/controls/MoreSheet.kt",
                     "Sources/Conclave/Skip/ui/call/controls/CallKeyboardShortcuts.kt",
                     "Sources/Conclave/Skip/ui/components/ConclaveActionSheet.kt",
                     "Sources/Conclave/Features/Meeting/Panels/PanelCoordinator.swift",
                     "Darwin/Sources/Main.swift",
                     "Tests/ConclaveTests/CTL5MoreMenuTests.swift"]
        for file in files {
            let text = try ctl5Source(file)
            #expect(!text.contains("\u{2013}") && !text.contains("\u{2014}"), "\(file) has an en or em dash")
            #expect(!text.lowercased().contains("gradi" + "ent"), "\(file) mentions a forbidden fill")
        }
        for file in files where !file.hasPrefix("Tests/") {
            #expect(!(try ctl5Source(file)).contains("voiceAgent"), "\(file) names a voice agent (Owner OQ7)")
        }
        let policy = try ctl5Source("Sources/Conclave/Features/Meeting/Controls/MoreMenuPolicy.swift")
        #expect(!policy.contains("#if") && !policy.contains("protocol ") && !policy.contains("inout "))
        #expect(policy.range(of: #"case\s+\w+\("#, options: .regularExpression) == nil)
        // PanelCoordinator stays inside MeetingPanel.swift's types (Tests/IOSFeedbackAdapter/run.py).
        let coordinator = ctl5Normalized(try ctl5Source("Sources/Conclave/Features/Meeting/Panels/PanelCoordinator.swift"))
        #expect(coordinator.contains("func presentFromMore(_ panel: MeetingPanel, destination: PanelDestination = PanelDestination.none, targetId: String = \"\") -> Bool {"))
        #expect(!coordinator.contains("StagePresenter") && !coordinator.contains("CallControls"))
    }
}

// MARK: Helpers (file-private, so no other suite collides)

/// A standalone shell, stage and controls presenter with the B5-T3 publish hook mirrored; `make` adds controls-only inputs.
@MainActor
private final class CTL5Harness {
    let shell = MeetingShellPresenter()
    let stage: StagePresenter
    let controls: CallControlsPresenter
    private let make: (MeetingShellPresenter) -> CallControlsInputs

    init(_ inputs: MeetingShellInputs, make: @escaping (MeetingShellPresenter) -> CallControlsInputs = { CallControlsInputs.fromShell($0) }) {
        stage = StagePresenter(shell: shell)
        controls = CallControlsPresenter(shell: shell, stage: stage)
        self.make = make
        shell.onPublish = { [weak self] _, _, _ in self?.refresh() }
        shell.apply(inputs)
        refresh()
    }

    func refresh() {
        controls.apply(make(shell))
    }
}

private func ctl5PackageRoot() -> URL {
    URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
}

private func ctl5Source(_ packageRelativePath: String) throws -> String {
    try String(contentsOf: ctl5PackageRoot().appendingPathComponent(packageRelativePath).standardizedFileURL, encoding: .utf8)
}

private func ctl5Normalized(_ text: String) -> String {
    text.split(whereSeparator: { $0.isWhitespace }).joined(separator: " ")
}
#endif
