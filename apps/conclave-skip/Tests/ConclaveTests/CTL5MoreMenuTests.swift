#if !SKIP
import Foundation
import Testing
@testable import Conclave

@MainActor
struct CTL5MoreMenuTests {

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

    static let guestIds = ["reactions", "hand", "screenShare", "captions", "flipCamera", "participants", "activities", "transcript",
                           "layout", "settings",
                           "invite", "copyLink", "meetingDetails"]
    static let hostIds = guestIds + ["hostControls", "lockMeeting", "endForEveryone"]

    @Test func guestAndHostRowsFollowThePriorityOrder() {
        let guest = ControlsFixtureSession(state: .guest)
        #expect(guest.controls.more.itemIds == Self.guestIds)
        #expect(guest.controls.more.sections.map { $0.id } == ["reactions", "you", "panels", "share"])
        #expect(!guest.controls.more.hasHostSection)
        let host = ControlsFixtureSession(state: .host)
        #expect(host.controls.more.itemIds == Self.hostIds)

        #expect(host.controls.more.sections.last?.id == MoreSectionID.host)
        #expect(MoreMenuPolicy.hostItems(host.controls.more).map { $0.id } == ["hostControls", "lockMeeting", "endForEveryone"])
        #expect(host.controls.more.meetingLink == ControlsFixtureScript.meetingLink && host.controls.more.roomLabel == ControlsFixtureScript.roomLabel)
        #expect(host.controls.more.layoutModes == ["auto", "tiled", "spotlight", "sidebar"])
    }

    @Test func rowsWhosePanelHasNotLandedStayHiddenAndThereIsNoVoiceAgent() {

        #expect(MoreMenuPolicy.isLanded(.transcript) && MoreMenuPolicy.isLanded(.layout) && MoreMenuPolicy.isLanded(.effects))
        for panel in [MeetingPanel.chat, .participants, .activities, .settings, .webinarQA, .meetingInfo, .hostControls,
                      .transcript, .layout, .effects] {
            #expect(MoreMenuPolicy.isLanded(panel), "\(panel.rawValue)")
        }
        let host = ControlsFixtureSession(state: .webinarHost)
        #expect(host.controls.more.itemIds.contains("transcript") && host.controls.more.itemIds.contains("layout"))
        for hidden in ["effects", "systemVideoEffects"] {
            #expect(!host.controls.more.itemIds.contains(hidden), "\(hidden) shows")
        }

        let hidden = CallControlsInputs.make(rows: host.shell.controls.rows, phase: .inCall, isLocalHost: true,
                                             meetingLink: "https://conclave.acmvit.in/abc", liveNotes: .live, effectsPanelAvailable: false)
        let hiddenSections = MoreMenuPolicy.sections(inputs: hidden, composition: .compact, overflowIds: [], reactions: ReactionPaletteSnapshot.empty)
        #expect(!hiddenSections.flatMap { $0.items }.contains { $0.kind == .effects })
        #expect(hiddenSections.flatMap { $0.items }.contains { $0.kind == .transcript })
        let inputs = CallControlsInputs.make(rows: host.shell.controls.rows, phase: .inCall, isLocalHost: true,
                                             meetingLink: "https://conclave.acmvit.in/abc", liveNotes: .live, effectsPanelAvailable: true)
        let sections = MoreMenuPolicy.sections(inputs: inputs, composition: .compact, overflowIds: [], reactions: ReactionPaletteSnapshot.empty)
        #expect(sections.flatMap { $0.items }.contains { $0.kind == .effects })
        #expect(sections.flatMap { $0.items }.contains { $0.kind == .transcript })

        #expect(!MoreItemID.allCases.map { $0.rawValue }.contains { $0.lowercased().contains("voice") })
    }

    @Test func webinarHostsGetQuestionsWithTheUnseenCountAndTheMoreDot() {
        let session = ControlsFixtureSession(state: .webinarHost)
        let qa = session.controls.more.item(.qa)
        #expect(qa?.count == 2 && qa?.status == .unseen)

        #expect(ControlsFixtureSession(state: .guest).controls.more.item(.qa) == nil)

        let activities = session.controls.more.item(.activities)
        #expect(activities?.status == .running && activities?.statusName == "Trivia")

        #expect(session.controls.bar.control(.more)?.showsDot == true)
        #expect(ControlsFixtureSession(state: .guest).controls.bar.control(.more)?.showsDot == false)

        #expect(session.controls.select(.qa) == .dispatched)
        #expect(session.panelReadout() == "panel=webinarQA invoker=more")
    }

    @Test func noRoomLinkHidesInviteAndCopyLink() {

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

        let guest = CTL5Harness(Self.joined(unreadChatCount: 4))
        #expect(guest.controls.more.item(.chat) == nil)
        guest.controls.setOverflow(ids: ["chat"])

        #expect(guest.controls.more.item(.chat)?.count == 4 && guest.controls.more.itemIds.dropFirst().first == "hand")
        #expect(guest.controls.more.section(MoreSectionID.panels)?.items.first?.kind == .chat)
    }

    @Test func aMovedChatWithUnreadMessagesPutsTheDotOnMore() {

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

    @Test func recoveryAndOfflineKeepEveryRowWithItsReason() {
        #expect(Self.ids(.recovering) == Self.ids(.guest) && Self.ids(.offline) == Self.ids(.guest))
        #expect(Self.ids(.hostRecovering) == Self.ids(.host) && Self.ids(.hostOffline) == Self.ids(.host))
        let recovering = ControlsFixtureSession(state: .hostRecovering).controls.more
        #expect(recovering.isRecovering)
        for blocked in [MoreItemID.reactions, .hand, .screenShare, .flipCamera, .lockMeeting, .endForEveryone] {
            let item = recovering.item(blocked)
            #expect(item?.isEnabled == false && item?.reason == .reconnecting, "\(blocked.rawValue)")
        }

        for live in [MoreItemID.participants, .activities, .settings, .captions, .invite, .copyLink, .meetingDetails, .hostControls] {
            #expect(recovering.item(live)?.isEnabled == true, "\(live.rawValue)")
        }
        let offline = ControlsFixtureSession(state: .hostOffline).controls.more
        #expect(offline.isRecovering && offline.item(.lockMeeting)?.reason == .offline && offline.item(.hand)?.reason == .offline)
        #expect(offline.item(.endForEveryone)?.reason == .offline && offline.item(.flipCamera)?.reason == .offline)

        let session = ControlsFixtureSession(state: .hostRecovering)
        #expect(session.controls.select(.hand) == .ignored && session.counters.toggleHand == 0 && session.controls.explainCount == 0)
        #expect(session.controls.select(.participants) == .dispatched)
        #expect(session.panelReadout() == "panel=participants invoker=more")
        #expect(ControlsFixtureSession(state: .guest).controls.more.isRecovering == false)
    }

    @Test func aRemotePresenterNamesTheShareReason() {

        let session = ControlsFixtureSession(state: .remoteShare)
        session.controls.setCompositionOverride(.compact)
        let share = session.controls.more.item(.screenShare)
        #expect(share?.reason == .remoteShareActive && share?.reasonName == "Avery" && share?.isEnabled == false)
        #expect(session.controls.select(.screenShare) == .ignored && session.counters.toggleShare == 0)
    }

    @Test func panelRowsPresentFromMoreOnceAndOnlyOnce() {
        let session = ControlsFixtureSession(state: .guest)
        #expect(session.controls.select(.participants) == .dispatched)
        #expect(session.panelReadout() == "panel=participants invoker=more" && session.counters.panelPresent == 1)

        #expect(session.controls.select(.participants) == .ignored)
        #expect(session.controls.select(.settings) == .dispatched)
        #expect(session.shell.panels.snapshot.pending?.panel == .settings && session.shell.panels.snapshot.pending?.invoker == .more)
        #expect(session.controls.select(.meetingDetails) == .dispatched)

        #expect(session.controls.panelRequestCount == 4)
    }

    @Test func presentFromMoreReportsWhetherAnythingChanged() {
        let coordinator = PanelCoordinator(session: 4)
        #expect(coordinator.presentFromMore(.participants))
        #expect(coordinator.snapshot.current?.invoker == .more && coordinator.snapshot.current?.panel == .participants)
        #expect(!coordinator.presentFromMore(.participants))

        #expect(coordinator.presentFromMore(.participants, destination: .peopleWaiting))
        #expect(coordinator.destinationRequest?.destination == .peopleWaiting && coordinator.destinationRequest?.invoker == .more)

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

        #expect(MoreMenuPolicy.handState(MoreItem(id: "hand", kind: .hand, isOn: false, isEnabled: false, isPending: true, reason: .none,
                                                  reasonName: "", status: .pending, statusName: "", count: 0)) == .raising)
    }

    @Test func copyLinkPostsTheToastOnlyWhereThePlatformAsks() {
        let session = ControlsFixtureSession(state: .guest)
        let queuedBefore = session.stage.queuedToasts
        #expect(session.controls.select(.copyLink) == .dispatched && session.controls.copyLinkCount == 1)
        #expect(session.stage.toast?.kind == NoticeKind.linkCopied || session.stage.queuedToasts > queuedBefore)

        let quiet = ControlsFixtureSession(state: .guest)
        let toastBefore = quiet.stage.toast?.id
        let queuedQuiet = quiet.stage.queuedToasts
        #expect(quiet.controls.copyLink(postsToast: false) == .dispatched)
        #expect(quiet.stage.toast?.id == toastBefore && quiet.stage.queuedToasts == queuedQuiet)
        #expect(session.countersReadout().contains("copyLink=1"))
    }

    @Test func endFromMoreBelongsToMoreAndOnlyToMore() {

        let session = ControlsFixtureSession(state: .host)
        #expect(session.controls.select(.endForEveryone) == .dispatched)
        let leave = session.controls.leaveState
        #expect(leave.confirmationInvoker == MeetingConfirmationInvoker.more && leave.confirmationId != 0)
        #expect(MoreMenuPolicy.presentsEndDialog(leave) && MoreMenuPolicy.playsEndPrompt(previousId: 0, leave: leave))
        #expect(!MoreMenuPolicy.playsEndPrompt(previousId: leave.confirmationId, leave: leave))
        #expect(!LeaveControlPolicy.presentsDialog(leave, includesMoreInvoker: false))
        #expect(LeaveControlPolicy.presentsDialog(leave, includesMoreInvoker: true))

        let recovering = ControlsFixtureSession(state: .hostRecovering)
        #expect(recovering.controls.select(.endForEveryone) == .ignored && recovering.controls.leaveState.confirmationId == 0)
    }

    @Test func rowsThatOpenSomethingWaitForTheSheetToGo() {

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
        #expect(MoreMenuPolicy.tiles(host).map { $0.id } == ["screenShare", "captions", "participants", "activities", "transcript",
                                                              "layout", "invite", "copyLink", "meetingDetails", "settings"])
        let webinar = ControlsFixtureSession(state: .webinarHost).controls.more
        #expect(MoreMenuPolicy.tiles(webinar).map { $0.id }.suffix(3) == ["meetingDetails", "qa", "settings"])

        #expect(!MoreMenuPolicy.androidTileOrder.contains(.flipCamera) && !MoreMenuPolicy.androidTileOrder.contains(.systemVideoEffects))
    }

    @Test func theMenuBudgetChoosesTheMenuOrTheSheet() {
        let guest = ControlsFixtureSession(state: .guest).controls
        #expect(guest.more.sections.flatMap { $0.items }.filter { MoreMenuPolicy.hasSubtitle($0) }.map { $0.id } == ["captions", "layout"])

        #expect(guest.moreMetrics == MoreMenuMetrics(rows: 7, twoLineRows: 2, hasPalette: true, mediumRows: 1, separators: 3))
        #expect(MoreMenuPolicy.estimatedHeight(guest.moreMetrics, textScale: 1) == 588)
        let host = ControlsFixtureSession(state: .host).controls
        #expect(host.moreMetrics == MoreMenuMetrics(rows: 8, twoLineRows: 2, hasPalette: true, mediumRows: 1, separators: 4))
        #expect(MoreMenuPolicy.estimatedHeight(host.moreMetrics, textScale: 1) == 640)
        #expect(MoreMenuPolicy.estimatedHeight(host.moreMetrics, textScale: 23.0 / 17.0) > 700)

        #expect(!MoreMenuPolicy.usesSheet(estimate: 538, menuSpace: 575, isAccessibilitySize: false, isVerticalBar: false))
        #expect(MoreMenuPolicy.usesSheet(estimate: 538, menuSpace: 500, isAccessibilitySize: false, isVerticalBar: false))
        #expect(MoreMenuPolicy.usesSheet(estimate: 300, menuSpace: 900, isAccessibilitySize: true, isVerticalBar: false))
        #expect(MoreMenuPolicy.usesSheet(estimate: 300, menuSpace: 900, isAccessibilitySize: false, isVerticalBar: true))
        #expect(MoreMenuPolicy.menuHeightReadout(estimate: 537.6, space: 575, usesSheet: false) == "estimate 538 of space 575 form menu")

        let recovering = ControlsFixtureSession(state: .recovering).controls.moreMetrics
        #expect(!recovering.hasPalette && recovering.twoLineRows > guest.moreMetrics.twoLineRows)

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

    @Test func keyboardCommandsFollowTheControlsAndTheRole() {
        let guest = ControlsFixtureSession(state: .guest)
        let visible = guest.controls.commands.items.filter { $0.isVisible }.map { $0.id }
        #expect(visible == ["microphone", "camera", "hand", "chat", "participants", "screenShare"])
        #expect(guest.controls.perform(.lockMeeting) == .ignored)
        #expect(guest.controls.perform(.microphone) == .dispatched && guest.counters.toggleMicrophone == 1)
        #expect(guest.controls.perform(.participants) == .dispatched && guest.panelReadout() == "panel=participants invoker=call")
        let host = ControlsFixtureSession(state: .host)
        #expect(host.controls.commands.item(.lockMeeting)?.isVisible == true && host.controls.perform(.lockMeeting) == .dispatched)

        let recovering = ControlsFixtureSession(state: .wideRecovering)
        #expect(recovering.controls.commands.item(.screenShare)?.isEnabled == false)
        #expect(recovering.controls.perform(.screenShare) == .ignored && recovering.controls.explainCount == 0)

        let attendee = ControlsFixtureSession(state: .attendee)
        #expect(attendee.controls.commands.items.filter { $0.isVisible }.map { $0.id } == ["hand"])
    }

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

    @Test func iosMoreIsTheNativeMenuWithTheDarkFallbackSheet() throws {
        let menu = ctl5Normalized(try ctl5Source("Sources/Conclave/Features/Meeting/Controls/MoreMenu+iOS.swift"))
        let sheet = ctl5Normalized(try ctl5Source("Sources/Conclave/Features/Meeting/Controls/MoreSheet+iOS.swift"))
        let cell = ctl5Normalized(try ctl5Source("Sources/Conclave/Features/Meeting/Controls/CallControlCell+iOS.swift"))
        let bar = ctl5Normalized(try ctl5Source("Sources/Conclave/Features/Meeting/Controls/CallControlBar+iOS.swift"))
        for text in [menu, sheet] { #expect(text.hasPrefix("#if os(iOS) && !SKIP")) }

        #expect(menu.contains(".menuOrder(.priority)"))
        #expect(menu.contains("MoreMenuPolicy.usesSheet(estimate: estimate, menuSpace: Double(menuSpace),"))
        #expect(menu.contains(".presentationDetents([.medium, .large])") && menu.contains(".preferredColorScheme(.dark)"))
        #expect(menu.contains(".sheet(isPresented: $showsSheet, onDismiss: performDeferred)"))
        #expect(menu.contains("controls.stage.setTransientChrome(id: ChromeAutoHidePolicy.moreSheet, open: open)"))

        #expect(menu.contains("Label(ConclaveStrings.text(\"Host\"), systemImage: ConclaveSymbols.crownFill)"))
        #expect(menu.contains("Button(role: .destructive)"))
        #expect(menu.contains("ConclaveReactionPalette(options: MoreCopy.paletteOptions(reactions)"))
        #expect(menu.contains("ShareLink(item: url, subject: Text(ConclaveStrings.text(\"Join My Conclave Meeting\")), message: Text(ConclaveStrings.text(\"Join me in this Conclave meeting.\")), preview: SharePreview(Text(more.roomLabel)))"))
        #expect(menu.contains(".accessibilityLabel(ConclaveStrings.text(\"Share Invite\"))"))

        for kind in [".reactionSent, trigger: reactionCounter", "handKind, trigger: handCounter", ".linkCopied, trigger: copyCounter",
                     ".selectionChanged, trigger: flipCounter", ".endForEveryonePrompted, trigger: endPromptCounter"] {
            #expect(menu.contains(".conclaveGestureFeedback(" + kind + ")"), "\(kind)")
        }
        #expect(menu.contains("if controls.select(MoreItemID.hand) == ControlTapResult.dispatched { onHand(raising) }"))
        #expect(menu.contains("if inSheet && MoreMenuPolicy.actsAfterDismiss(item) {"))
        #expect(menu.contains("MoreMenuPolicy.presentsEndDialog(controls.leaveState)"))

        #expect(sheet.contains("NavigationStack {") && sheet.contains(".navigationTitle(ConclaveStrings.text(\"More\"))"))
        #expect(sheet.contains(".accessibilityLabel(ConclaveStrings.text(\"Close\"))"))

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

        #expect(component.components(separatedBy: "scope.launch { sheetState.hide() }.invokeOnCompletion {").count - 1 == 2)
        #expect(component.contains("if (host.kind == ConclaveActionRowKind.Destructive) HorizontalDivider()"))
        #expect(component.contains("ModalBottomSheetProperties(isAppearanceLightStatusBars = false, isAppearanceLightNavigationBars = false)"))
        #expect(component.contains("ConclaveBanner(kind = ConclaveBannerKind.Warning, text = notice, identifier = \"$identifier.notice\", inCall = true)"))

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

        let coordinator = ctl5Normalized(try ctl5Source("Sources/Conclave/Features/Meeting/Panels/PanelCoordinator.swift"))
        #expect(coordinator.contains("func presentFromMore(_ panel: MeetingPanel, destination: PanelDestination = PanelDestination.none, targetId: String = \"\") -> Bool {"))
        #expect(!coordinator.contains("StagePresenter") && !coordinator.contains("CallControls"))
    }
}

@MainActor
private final class CTL5Harness {
    let shell = MeetingShellPresenter()
    let stage: StagePresenter
    let controls: CallControlsPresenter
    private let make: @MainActor (MeetingShellPresenter) -> CallControlsInputs

    init(_ inputs: MeetingShellInputs, make: @escaping @MainActor (MeetingShellPresenter) -> CallControlsInputs = { CallControlsInputs.fromShell($0) }) {
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
