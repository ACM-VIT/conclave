#if !SKIP
import Foundation
import Testing
@testable import Conclave

/// CTL-1 (OUT/PLAN-screens.md section 5): the control bar and the blocked-action matrix. Pure policies and the presenter
/// run here against the real S1 shell (rows from `MeetingControlAvailabilityPolicy`); iOS-only and Kotlin sources are
/// read. The Kotlin half is T/Skip/ControlsBridgeTests.kt. Covers S30 0.5 (presenter API compile test), 0.6, 1 l (unit
/// halves of l1, l2, l5, l6, l7, l10, l11, l13, l15, l17, l19), 7 (matrix and acceptance), CC18, CC21, CL1, CL6, CL13,
/// CL20 and the WP1-2b CompactBarFit arithmetic at the stated sizes. Not run in the heads-down push.
@MainActor
struct ControlsPoliciesTests {
    // MARK: Harness

    static let identity = MeetingSessionIdentity(callSession: 1, attempt: 1, attemptToken: "controls-tests")

    static func joined(isAdmin: Bool = false, isWebinarAttendee: Bool = false, isMuted: Bool = false, isCameraOff: Bool = false,
                       isAudioOnlyMode: Bool = false, hasActiveRemoteScreenShare: Bool = false, isScreenShareSupported: Bool = true,
                       unreadChatCount: Int = 0, pendingUsersCount: Int = 0, isNetworkOffline: Bool = false,
                       micToggleInFlight: Bool = false, cameraToggleInFlight: Bool = false, handToggleInFlight: Bool = false,
                       microphonePermission: MeetingMediaPermissionStatus = .granted,
                       cameraPermission: MeetingMediaPermissionStatus = .granted,
                       audioInterruption: AudioInterruptionKind = .none) -> MeetingShellInputs {
        MeetingShellInputs.make(identity: identity, connectionState: .joined, isNetworkOffline: isNetworkOffline,
                                roomId: "abc-defg-hij", displayName: "You", isAdmin: isAdmin, isWebinarAttendee: isWebinarAttendee,
                                isMuted: isMuted, isCameraOff: isCameraOff, isAudioOnlyMode: isAudioOnlyMode,
                                hasActiveRemoteScreenShare: hasActiveRemoteScreenShare, isScreenShareSupported: isScreenShareSupported,
                                unreadChatCount: unreadChatCount, pendingUsersCount: pendingUsersCount,
                                micToggleInFlight: micToggleInFlight, cameraToggleInFlight: cameraToggleInFlight,
                                handToggleInFlight: handToggleInFlight, microphonePermission: microphonePermission,
                                cameraPermission: cameraPermission, audioInterruption: audioInterruption)
    }

    /// The same inputs in recovery (admitted first, so the phase is `recovering`).
    static func recovering(_ base: MeetingShellInputs) -> MeetingShellInputs {
        MeetingShellInputs.make(identity: base.identity, connectionState: .reconnecting, isRecoveringConnection: true,
                                roomId: base.roomId, displayName: base.displayName, isAdmin: base.isAdmin,
                                isWebinarAttendee: base.isWebinarAttendee, isMuted: base.isMuted, isCameraOff: base.isCameraOff,
                                isScreenShareSupported: base.isScreenShareSupported, unreadChatCount: base.unreadChatCount,
                                pendingUsersCount: base.pendingUsersCount)
    }

    @MainActor
    final class Harness {
        let shell: MeetingShellPresenter
        let stage: StagePresenter
        let controls: CallControlsPresenter
        var commands: [MeetingShellCommand] = []
        var explanations: [ControlExplanation] = []
        var controlCommands: [CallControlsCommand] = []
        var refreshes = 0
        var extras: (MeetingShellPresenter) -> CallControlsInputs = { shell in CallControlsInputs.fromShell(shell) }

        init(_ inputs: MeetingShellInputs, admitFirst: MeetingShellInputs? = nil,
             width: ControlsWindowClass = .compact, height: ControlsWindowClass = .regular, isPhone: Bool = true,
             extras: ((MeetingShellPresenter) -> CallControlsInputs)? = nil) {
            let owner = MeetingShellPresenter()
            let stagePresenter = StagePresenter(shell: owner)
            shell = owner
            stage = stagePresenter
            controls = CallControlsPresenter(shell: owner, stage: stagePresenter)
            if let extras { self.extras = extras }
            shell.onCommand = { [weak self] command, ticket in
                self?.commands.append(command)
                if let ticket, command == .toggleHand { _ = self?.shell.finish(ticket, .completed) }
            }
            shell.panels.onSnapshotChanged = { [weak self] in self?.refresh() }
            controls.onExplain = { [weak self] explanation in self?.explanations.append(explanation) }
            controls.onCommand = { [weak self] command in self?.controlCommands.append(command) }
            controls.setWindow(width: width, height: height, isPhone: isPhone)
            if let admitFirst { shell.apply(admitFirst) }
            shell.apply(inputs)
            refresh()
        }

        func push(_ inputs: MeetingShellInputs) {
            shell.apply(inputs)
            refresh()
        }

        func refresh() {
            refreshes += 1
            controls.apply(extras(shell))
        }

        var ids: [String] { ControlBarPolicy.controlIds(controls.bar) }

        func model(_ kind: CallControlKind) -> CallControlModel? { controls.bar.control(kind) }
    }

    static func models(_ kinds: [CallControlKind]) -> [CallControlModel] {
        kinds.map { kind in
            CallControlModel(id: kind.rawValue, kind: kind, isOn: false, visual: .on, isBlocked: false, isPending: false,
                             reason: .none, reasonName: "", appliesAfterReconnect: false, badgeCount: 0, showsDot: false,
                             hasShortcut: false)
        }
    }

    static func snapshot(_ composition: ControlBarComposition, axis: ControlBarAxis = .horizontal) -> ControlBarSnapshot {
        ControlBarSnapshot(revision: 1, composition: composition, axis: axis, controls: models(ControlBarPolicy.order(composition)))
    }

    // MARK: S30 0.5: presenter API (a name clash such as `leave` versus `leave()` fails here)

    @Test func presenterApiCompilesAndMirrorsS1() {
        let h = Harness(Self.joined(isAdmin: true))
        let controls = h.controls
        let bar: ControlBarSnapshot = controls.bar
        let leaveState: LeaveSnapshot = controls.leaveState
        let explanation: ControlExplanation? = controls.explanation
        let prompt: ControlPermissionPrompt? = controls.permissionPrompt
        let shell: MeetingShellPresenter = controls.shell
        let stage: StagePresenter = controls.stage
        #expect(bar.revision > 0 && leaveState.canEndForEveryone && explanation == nil && prompt == nil)
        #expect(shell === h.shell && stage === h.stage)
        controls.apply(CallControlsInputs.fromShell(h.shell))
        controls.setWindow(width: .compact, height: .regular, isPhone: true)
        controls.setCompositionOverride(nil)
        controls.setOverflow(ids: [])
        controls.reportFit("Bar 0 of 0")
        let layout: ControlBarLayout = controls.layout
        #expect(layout.composition == .compact)
        #expect(controls.model(.hand)?.kind == .hand)
        #expect(controls.tap(.more) == .dispatched)
        controls.requestEndForEveryone(from: MeetingConfirmationInvoker.call)
        h.refresh()
        #expect(controls.leaveState.endPhase == .confirming)
        controls.cancelEnd(id: controls.leaveState.confirmationId)
        h.refresh()
        #expect(controls.leaveState.endPhase == .idle)
        #expect(controls.confirmEndForEveryone(id: 999, postRecap: false) == .ignored)
        controls.dismissPermissionPrompt(id: 0)
        let onExplain: ((ControlExplanation) -> Void)? = controls.onExplain
        let onCommand: ((CallControlsCommand) -> Void)? = controls.onCommand
        #expect(onExplain != nil && onCommand != nil)
        #expect(controls.applyCount > 0 && controls.barPublishCount > 0)
        #expect(controls.explainCount == 0 && controls.promptCount == 0 && controls.commandCount == 0)
        #expect(controls.leave() == .dispatched)
        #expect(h.commands.last == .leave)
        controls.reset()
        #expect(controls.inputs == CallControlsInputs.make() && controls.fitReadout == "none")
    }

    // MARK: S30 0.6: compositions

    @Test func compositionFollowsTheWindowClasses() {
        func layout(_ width: ControlsWindowClass, _ height: ControlsWindowClass, phone: Bool, attendee: Bool = false) -> ControlBarLayout {
            ControlBarPolicy.layout(width: width, height: height, isPhone: phone, isAttendee: attendee)
        }
        // iPhone portrait and iPad compact width: the compact five in a row.
        #expect(layout(.compact, .regular, phone: true) == ControlBarLayout(composition: .compact, axis: .horizontal))
        #expect(layout(.compact, .regular, phone: false) == ControlBarLayout(composition: .compact, axis: .horizontal))
        // iPhone landscape (including the regular-width Max landscape): the trailing column (D27).
        #expect(layout(.compact, .compact, phone: true) == ControlBarLayout(composition: .compact, axis: .vertical))
        #expect(layout(.regular, .compact, phone: true) == ControlBarLayout(composition: .compact, axis: .vertical))
        // iPad regular x regular and Android from 600 dp wide and 480 dp tall: the wide eight (R7, Q13).
        #expect(layout(.regular, .regular, phone: false) == ControlBarLayout(composition: .wide, axis: .horizontal))
        // Android phone landscape (wide but short) keeps the compact five at the bottom; Android is never vertical.
        #expect(layout(.regular, .compact, phone: false) == ControlBarLayout(composition: .compact, axis: .horizontal))
        // Webinar attendees: the attendee three on every window.
        #expect(layout(.regular, .regular, phone: false, attendee: true).composition == .attendee)
        #expect(layout(.compact, .compact, phone: true, attendee: true) == ControlBarLayout(composition: .attendee, axis: .vertical))
    }

    @Test func orderAndHiddenControlsPerComposition() {
        let compact = Harness(Self.joined())
        #expect(compact.ids == ["microphone", "camera", "chat", "more", "leave"])
        let wide = Harness(Self.joined(), width: .regular, height: .regular, isPhone: false)
        #expect(wide.ids == ["microphone", "camera", "screenShare", "hand", "chat", "participants", "more", "leave"])
        // An absent capability hides instead of blocking (S30 7): unsupported share leaves seven on the wide bar.
        let noShare = Harness(Self.joined(isScreenShareSupported: false), width: .regular, height: .regular, isPhone: false)
        #expect(noShare.ids == ["microphone", "camera", "hand", "chat", "participants", "more", "leave"])
        // 1 l13: the attendee bar is Raise Hand (capability), Q&A with its badge, Leave; Q&A and Leave without the hand.
        let attendee = Harness(Self.joined(isWebinarAttendee: true)) { shell in
            CallControlsInputs.fromShell(shell, isWebinarQaEnabled: true, webinarQaUnseen: 2, attendeeCanRaiseHand: true)
        }
        #expect(attendee.ids == ["hand", "qa", "leave"])
        #expect(attendee.model(.qa)?.badgeCount == 2)
        let noHand = Harness(Self.joined(isWebinarAttendee: true)) { shell in
            CallControlsInputs.fromShell(shell, isWebinarQaEnabled: true)
        }
        #expect(noHand.ids == ["qa", "leave"])
        let qaOff = Harness(Self.joined(isWebinarAttendee: true))
        #expect(qaOff.ids == ["leave"])
        // Leave is always last, in every composition.
        for composition in ControlBarComposition.allCases {
            #expect(ControlBarPolicy.order(composition).last == .leave)
        }
    }

    // MARK: CL1, CL20, S30 1 h

    @Test func visualAndGestureMapping() {
        #expect(ControlBarPolicy.visual(kind: .microphone, isOn: true) == .on)
        #expect(ControlBarPolicy.visual(kind: .microphone, isOn: false) == .off)
        #expect(ControlBarPolicy.visual(kind: .camera, isOn: false) == .off)
        // CL20: Raise Hand and Share Screen never draw Off; idle is On, active is Engaged.
        for kind in [CallControlKind.hand, .screenShare, .chat, .participants, .qa] {
            #expect(ControlBarPolicy.visual(kind: kind, isOn: false) == .on, "\(kind)")
            #expect(ControlBarPolicy.visual(kind: kind, isOn: true) == .engaged, "\(kind)")
        }
        #expect(ControlBarPolicy.visual(kind: .more, isOn: true) == .on && ControlBarPolicy.visual(kind: .leave, isOn: false) == .on)
        func gesture(_ kind: CallControlKind, _ isOn: Bool) -> FeedbackKind? {
            ControlBarPolicy.gestureKind(CallControlModel(id: kind.rawValue, kind: kind, isOn: isOn, visual: .on, isBlocked: false,
                                                          isPending: false, reason: .none, reasonName: "", appliesAfterReconnect: false,
                                                          badgeCount: 0, showsDot: false, hasShortcut: false))
        }
        #expect(gesture(.microphone, true) == .micOff && gesture(.microphone, false) == .micOn)
        #expect(gesture(.camera, true) == .cameraOff && gesture(.camera, false) == .cameraOn)
        #expect(gesture(.hand, true) == .handLowered && gesture(.hand, false) == .handRaised)
        // No haptic for Share (outcome tokens), Chat, Participants, Q&A, More and Leave (Q11).
        for kind in [CallControlKind.screenShare, .chat, .participants, .qa, .more, .leave] {
            #expect(gesture(kind, false) == nil && gesture(kind, true) == nil, "\(kind)")
        }
    }

    // MARK: S30 7: the blocked-action matrix on the bar

    @Test func recoveryAndOfflineKeepEveryPositionAndChangeOnlyReasons() {
        for admin in [false, true] {
            let normal = Harness(Self.joined(isAdmin: admin), width: .regular, height: .regular, isPhone: false)
            let base = Self.joined(isAdmin: admin)
            let recovering = Harness(Self.recovering(base), admitFirst: base, width: .regular, height: .regular, isPhone: false)
            let offline = Harness(Self.joined(isAdmin: admin, isNetworkOffline: true), width: .regular, height: .regular, isPhone: false)
            #expect(recovering.ids == normal.ids && offline.ids == normal.ids)
            // Media intent stays live and applies on reconnect; socket mutations are blocked with a reason.
            for h in [recovering, offline] {
                #expect(h.model(.microphone)?.isBlocked == false && h.model(.microphone)?.appliesAfterReconnect == true)
                #expect(h.model(.camera)?.isBlocked == false && h.model(.camera)?.appliesAfterReconnect == true)
                #expect(h.model(.chat)?.isBlocked == false && h.model(.participants)?.isBlocked == false)
                #expect(h.model(.more)?.isBlocked == false && h.model(.leave)?.isBlocked == false)
            }
            #expect(recovering.model(.screenShare)?.reason == .reconnecting && recovering.model(.hand)?.reason == .reconnecting)
            #expect(offline.model(.screenShare)?.reason == .offline && offline.model(.hand)?.reason == .offline)
            #expect(recovering.model(.screenShare)?.isBlocked == true && offline.model(.hand)?.isBlocked == true)
        }
    }

    @Test func blockedBarTapsExplainWithoutDispatching() {
        // 1 l6: on the wide recovering bar a Share tap explains and toggles nothing.
        let base = Self.joined()
        let h = Harness(Self.recovering(base), admitFirst: base, width: .regular, height: .regular, isPhone: false)
        #expect(h.controls.tap(.screenShare) == .explained)
        #expect(h.commands.isEmpty)
        #expect(h.explanations.map { $0.reason } == [.reconnecting])
        #expect(h.controls.explanation?.kind == .screenShare && h.controls.explainCount == 1)
        // A second blocked tap is a new one-shot id.
        #expect(h.controls.tap(.hand) == .explained)
        #expect(h.explanations.map { $0.id } == [1, 2] && h.commands.isEmpty)
        // A Mic tap while recovering records intent: it dispatches (1 l6 toggleMicrophone + 1).
        #expect(h.controls.tap(.microphone) == .dispatched)
        #expect(h.commands == [.toggleMicrophone])
        // Remote presenter: the toast names them (S30 7).
        let share = Harness(Self.joined(hasActiveRemoteScreenShare: true), width: .regular, height: .regular, isPhone: false) { shell in
            CallControlsInputs.fromShell(shell, presenterName: "Avery")
        }
        #expect(share.model(.screenShare)?.reason == .remoteShareActive && share.model(.screenShare)?.reasonName == "Avery")
        #expect(share.controls.tap(.screenShare) == .explained && share.commands.isEmpty)
        #expect(share.explanations.first?.reasonName == "Avery" && share.explanations.first?.actionId == "")
        // Audio-only: the camera explains with the Turn Off action (S20 turnOffAudioOnly).
        let audioOnly = Harness(Self.joined(isCameraOff: true, isAudioOnlyMode: true))
        #expect(audioOnly.model(.camera)?.reason == .audioOnly && audioOnly.model(.camera)?.isBlocked == true)
        #expect(audioOnly.controls.tap(.camera) == .explained && audioOnly.commands.isEmpty)
        #expect(audioOnly.explanations.first?.actionId == "turnOffAudioOnly")
        // CC10: host-disabled media blocks only a tap toward live.
        let hostOff = Harness(Self.joined(isMuted: true, isCameraOff: true)) { shell in
            CallControlsInputs.fromShell(shell, isMicDisabledByHost: true, isCameraDisabledByHost: true)
        }
        #expect(hostOff.model(.microphone)?.reason == .disabledByHost && hostOff.model(.camera)?.reason == .disabledByHost)
        #expect(hostOff.controls.tap(.microphone) == .explained && hostOff.commands.isEmpty)
        let hostOffLive = Harness(Self.joined(isMuted: false)) { shell in
            CallControlsInputs.fromShell(shell, isMicDisabledByHost: true)
        }
        #expect(hostOffLive.model(.microphone)?.isBlocked == false)
        #expect(ControlBarPolicy.explains(.notJoined) == false && ControlBarPolicy.explains(.leaving) == false)
    }

    @Test func explanationsReachTheStageToastLaneAsLocalNotices() throws {
        // S30 CC7: the presenter posts its own toast through STG-5's postLocal; the lanes read the copy back.
        let explanation = ControlExplanation(id: 7, kind: .screenShare, reason: .remoteShareActive, reasonName: "Avery", actionId: "")
        let notice = ControlBarPolicy.explanationNotice(explanation)
        #expect(notice.kind == NoticeKind.blockedExplanation && notice.lane == .toast && notice.expiresAtMillis == 0)
        #expect(notice.userId == "screenShare" && notice.detail == "remoteShareActive" && notice.name == "Avery" && notice.actions.isEmpty)
        let back = try #require(ControlBarPolicy.explanation(fromNotice: notice))
        #expect(back.kind == .screenShare && back.reason == .remoteShareActive && back.reasonName == "Avery" && back.actionId == "")
        let audioOnly = ControlBarPolicy.explanationNotice(ControlExplanation(id: 8, kind: .camera, reason: .audioOnly, reasonName: "",
                                                                              actionId: NoticeAction.turnOffAudioOnly))
        #expect(audioOnly.actions.map { $0.id } == [NoticeAction.turnOffAudioOnly])
        #expect(ControlBarPolicy.explanation(fromNotice: audioOnly)?.actionId == NoticeAction.turnOffAudioOnly)
        #expect(ControlBarPolicy.explanation(fromNotice: MeetingNotice.make(kind: NoticeKind.linkCopied)) == nil)
        let presenter = controlsNormalized(try controlsSource("Sources/Conclave/Features/Meeting/Controls/CallControlsPresenter.swift"))
        #expect(presenter.contains("stage.postLocal(ControlBarPolicy.explanationNotice(next))"))
    }

    @Test func permissionsAndSystemPausedAudio() {
        // 1 l7: a denied camera opens the alert, toggles nothing and plays nothing.
        let denied = Harness(Self.joined(isCameraOff: true, cameraPermission: .denied))
        #expect(denied.model(.camera)?.reason == .permissionDenied && denied.model(.camera)?.isBlocked == true)
        #expect(denied.controls.tap(.camera) == .explained)
        #expect(denied.commands.isEmpty && denied.controls.permissionPrompt?.kind == .camera && denied.controls.promptCount == 1)
        let id = denied.controls.permissionPrompt?.id ?? 0
        denied.controls.dismissPermissionPrompt(id: id + 1)
        #expect(denied.controls.permissionPrompt != nil)
        denied.controls.dismissPermissionPrompt(id: id)
        #expect(denied.controls.permissionPrompt == nil)
        // Not determined: the system prompt in context, through the core.
        let undetermined = Harness(Self.joined(isMuted: true, microphonePermission: .undetermined))
        #expect(undetermined.controls.tap(.microphone) == .explained)
        #expect(undetermined.controlCommands == [.requestMicrophonePermission] && undetermined.commands.isEmpty)
        // R29: audio interrupted blocks a tap toward live without a toast; a live mic still mutes.
        let pausedMuted = Harness(Self.joined(isMuted: true, audioInterruption: .otherAudio))
        #expect(pausedMuted.model(.microphone)?.isBlocked == true && pausedMuted.model(.microphone)?.reason == .audioInterrupted)
        #expect(pausedMuted.controls.tap(.microphone) == .ignored && pausedMuted.explanations.isEmpty && pausedMuted.commands.isEmpty)
        let pausedLive = Harness(Self.joined(isMuted: false, audioInterruption: .otherAudio))
        #expect(pausedLive.model(.microphone)?.isBlocked == false && pausedLive.model(.microphone)?.reason == .audioInterrupted)
        #expect(pausedLive.controls.tap(.microphone) == .dispatched && pausedLive.commands == [.toggleMicrophone])
        let held = Harness(Self.joined(isMuted: true, audioInterruption: .held))
        #expect(held.model(.microphone)?.reason == .onHold && held.controls.tap(.microphone) == .ignored)
    }

    // MARK: CC21 with WP2-S1c (1 l19)

    @Test func micTapTowardMutedWhilePendingStillDispatches() {
        // An unmute is pending (the optimistic mic already reads live): the tap toward muted dispatches once.
        let unmutePending = Harness(Self.joined(isMuted: false, micToggleInFlight: true))
        #expect(unmutePending.model(.microphone)?.isPending == true && unmutePending.model(.microphone)?.isBlocked == false)
        #expect(unmutePending.controls.tap(.microphone) == .dispatched)
        #expect(unmutePending.commands == [.toggleMicrophone])
        // A mute is pending: a tap toward live is a duplicate (fail closed), nothing dispatches.
        let mutePending = Harness(Self.joined(isMuted: true, micToggleInFlight: true))
        #expect(mutePending.controls.tap(.microphone) == .ignored && mutePending.commands.isEmpty)
        // The camera pair.
        let cameraOnPending = Harness(Self.joined(isCameraOff: false, cameraToggleInFlight: true))
        #expect(cameraOnPending.controls.tap(.camera) == .dispatched && cameraOnPending.commands == [.toggleCamera])
        let cameraOffPending = Harness(Self.joined(isCameraOff: true, cameraToggleInFlight: true))
        #expect(cameraOffPending.controls.tap(.camera) == .ignored && cameraOffPending.commands.isEmpty)
        // A pending hand is never optimistic: a second tap is ignored.
        let hand = Harness(Self.joined(handToggleInFlight: true), width: .regular, height: .regular, isPhone: false)
        #expect(hand.model(.hand)?.isPending == true && hand.controls.tap(.hand) == .ignored && hand.commands.isEmpty)
    }

    // MARK: CC18 (1 l17) and the badges (1 l5, 1 f)

    @Test func invokersToggleTheirPanelAndDrawEngagedFromTheSnapshot() {
        let h = Harness(Self.joined(unreadChatCount: 3), width: .regular, height: .regular, isPhone: false)
        #expect(h.model(.chat)?.badgeCount == 3 && h.model(.chat)?.visual == .on)
        let before = h.refreshes
        #expect(h.controls.tap(.participants) == .dispatched)
        // Open Participants from the bar: one refresh through onSnapshotChanged, Participants Engaged.
        #expect(h.refreshes == before + 1)
        #expect(h.shell.panels.snapshot.current?.panel == .participants && h.shell.panels.snapshot.current?.invoker == .call)
        #expect(h.model(.participants)?.isOn == true && h.model(.participants)?.visual == .engaged)
        // A second tap closes it (one refresh), the host's acknowledgment clears Engaged (one refresh).
        #expect(h.controls.tap(.participants) == .dispatched)
        #expect(h.refreshes == before + 2 && h.shell.panels.snapshot.isDismissing)
        if let current = h.shell.panels.snapshot.current {
            h.shell.panels.didDismiss(session: h.shell.panels.snapshot.session, presentationID: current.presentationID)
        }
        #expect(h.refreshes == before + 3 && h.model(.participants)?.visual == .on)
        // Chat open hides its badge (1 f); closing brings it back.
        _ = h.controls.tap(.chat)
        #expect(h.model(.chat)?.visual == .engaged && h.model(.chat)?.badgeCount == 0)
        #expect(h.shell.panels.currentPanelName == MeetingPanel.chat.rawValue)
    }

    @Test func badgesFollowTheRoleAndTheComposition() {
        // 1 l5: the host waiting count rides on More on the compact bar, on Participants on the wide bar.
        let compactHost = Harness(Self.joined(isAdmin: true, unreadChatCount: 120, pendingUsersCount: 3))
        #expect(compactHost.model(.more)?.badgeCount == 3 && compactHost.model(.more)?.showsDot == false)
        #expect(compactHost.model(.chat)?.badgeCount == 120)
        #expect(ConclaveBadgeCount.isCapped(120))
        let wideHost = Harness(Self.joined(isAdmin: true, pendingUsersCount: 3), width: .regular, height: .regular, isPhone: false)
        #expect(wideHost.model(.participants)?.badgeCount == 3 && wideHost.model(.more)?.badgeCount == 0)
        // Guests never see a waiting count.
        let guest = Harness(Self.joined(pendingUsersCount: 3))
        #expect(guest.model(.more)?.badgeCount == 0)
        // More's dot only without a count.
        let attention = Harness(Self.joined()) { shell in CallControlsInputs.fromShell(shell, moreAttention: true) }
        #expect(attention.model(.more)?.showsDot == true)
        let both = Harness(Self.joined(isAdmin: true, pendingUsersCount: 2)) { shell in CallControlsInputs.fromShell(shell, moreAttention: true) }
        #expect(both.model(.more)?.badgeCount == 2 && both.model(.more)?.showsDot == false)
    }

    // MARK: Leave and End (the LeaveSnapshot CTL-2 builds on; R09)

    @Test func leaveSnapshotFollowsS1AndLeaveStaysAvailable() {
        let confirm = ControlsFixtureSession(state: .endConfirm)
        #expect(confirm.controls.leaveState.endPhase == .confirming)
        #expect(confirm.controls.leaveState.confirmationInvoker == MeetingConfirmationInvoker.call)
        #expect(confirm.controls.leaveState.canEndForEveryone)
        let failed = ControlsFixtureSession(state: .endFailed)
        #expect(failed.controls.leaveState.endPhase == .failed && failed.controls.leaveState.endFailure == "rejectedByServer")
        // End failed keeps Leave available (R09).
        #expect(failed.controls.bar.control(.leave)?.isBlocked == false)
        let leaving = ControlsFixtureSession(state: .leaving)
        #expect(leaving.controls.leaveState.leavePhase == .leaving)
        for model in leaving.controls.bar.controls {
            #expect(model.isBlocked, "\(model.id) stays enabled while leaving")
        }
        #expect(leaving.controls.bar.control(.microphone)?.reason == .leaving)
        let guest = ControlsFixtureSession(state: .guest)
        #expect(guest.controls.leaveState.canEndForEveryone == false && guest.controls.bar.control(.leave)?.hasShortcut == false)
        let host = ControlsFixtureSession(state: .host)
        #expect(host.controls.bar.control(.leave)?.hasShortcut == true)
    }

    // MARK: Fit (1 l1, 1 l2, F00 C05 l; PN A1 CompactBarFit)

    @Test func compactBarFitIsArithmeticAtTheStatedSizes() {
        let compact = Self.snapshot(.compact)
        // iOS 375 pt: 52 pt circles with 12 pt gaps; 320 pt (SE Display Zoom): 49; nothing moves.
        let at375 = ControlBarPolicy.iosPlan(bar: compact, width: 375, height: 667, scaledDiameter: 52)
        #expect(at375.targetWidth == 52 && at375.spacing == 12 && at375.moved.isEmpty && at375.requiredWidth <= 375)
        let at320 = ControlBarPolicy.iosPlan(bar: compact, width: 320, height: 568, scaledDiameter: 52)
        #expect(at320.targetWidth == 49 && at320.moved.isEmpty && at320.requiredWidth <= 320)
        // iPhone SE landscape, 375 pt tall, route slot reserved: a 49 pt column.
        let column = ControlBarPolicy.iosPlan(bar: Self.snapshot(.compact, axis: .vertical), width: 667, height: 375, scaledDiameter: 52)
        #expect(column.targetWidth == 49 && column.moved.isEmpty)
        // iPad wide (eight): 52 pt.
        let iPad = ControlBarPolicy.iosPlan(bar: Self.snapshot(.wide), width: 834, height: 1194, scaledDiameter: 52)
        #expect(iPad.targetWidth == 52 && iPad.moved.isEmpty)
        // Android 360 dp: 48 dp toggles, "Bar 321 of 360"; 412 dp: 56 dp toggles, 353; wide at 600 dp: 545.
        let android360 = ControlBarPolicy.androidPlan(bar: compact, availableWidth: 360)
        #expect(android360.targetWidth == 48 && android360.requiredWidth == 321 && android360.moved.isEmpty)
        #expect(ControlBarPolicy.fitReadout(plan: android360, available: 360, composition: .compact).hasPrefix("Bar 321 of 360 compact"))
        let android412 = ControlBarPolicy.androidPlan(bar: compact, availableWidth: 412)
        #expect(android412.targetWidth == 56 && android412.requiredWidth == 353)
        let wide600 = ControlBarPolicy.androidPlan(bar: Self.snapshot(.wide), availableWidth: 600)
        #expect(wide600.targetWidth == 56 && wide600.requiredWidth == 545 && wide600.moved.isEmpty)
        // The toolbar never grows past 560 dp.
        let tablet = ControlBarPolicy.androidPlan(bar: Self.snapshot(.wide), availableWidth: 1200)
        #expect(tablet.requiredWidth <= ControlBarPolicy.androidMaxToolbarWidth)
        // A split screen below the 48 dp composition: Chat moves into More and every target stays 48 dp (F00 C05 f).
        let split = ControlBarPolicy.androidPlan(bar: compact, availableWidth: 320)
        #expect(split.moved == ["chat"] && split.targetWidth == 48 && split.fits)
        #expect(ControlBarPolicy.shownControls(compact, moved: split.moved).map { $0.id } == ["microphone", "camera", "more", "leave"])
        // Leave never moves.
        for composition in ControlBarComposition.allCases {
            #expect(!ControlBarPolicy.moveOrder(composition).contains(CompactBarFit.leaveControlID))
        }
    }

    @Test func iPadWindowMinimumComesFromCompactBarFit() {
        // S20 SC14: 2 x 12 + 5 x 44 + 4 x 8.
        #expect(ConclaveWindowMetrics.minimumWidth == 276)
        #expect(CompactBarFit.fits(targets: [44, 44, 44, 44, 44], spacing: DesignTokens.space8, padding: CompactBarFit.iosPadding,
                                   available: ConclaveWindowMetrics.minimumWidth))
        #expect(ConclaveWindowMetrics.minimumWidth < 320)
    }

    // MARK: CL13 fixtures

    @Test func everyFixtureStateBuildsItsCell() {
        for state in ControlsFixtureState.allCases {
            let session = ControlsFixtureSession(state: state)
            #expect(!session.controls.bar.controls.isEmpty, "\(state.rawValue)")
            #expect(session.controls.bar.controls.last?.kind == .leave, "\(state.rawValue)")
            #expect(ControlsFixtureScript.state(named: " " + state.rawValue + "\n") == state)
        }
        #expect(ControlsFixtureScript.state(named: "grid-6") == nil)
        // 7 acceptance: recovering and offline list the same controls in the same positions as normal.
        func ids(_ state: ControlsFixtureState) -> [String] { ControlBarPolicy.controlIds(ControlsFixtureSession(state: state).controls.bar) }
        #expect(ids(.recovering) == ids(.guest) && ids(.offline) == ids(.guest))
        #expect(ids(.hostRecovering) == ids(.host) && ids(.hostOffline) == ids(.host))
        #expect(ids(.wide) == ["microphone", "camera", "screenShare", "hand", "chat", "participants", "more", "leave"])
        #expect(ids(.wideRecovering) == ids(.wide))
        #expect(ids(.attendee) == ["hand", "qa", "leave"])
        #expect(ControlsFixtureSession(state: .attendeeQa2).controls.bar.control(.qa)?.badgeCount == 2)
        #expect(ControlsFixtureSession(state: .hostWaiting3).controls.bar.control(.more)?.badgeCount == 3)
        #expect(ControlsFixtureSession(state: .handRaising).controls.bar.control(.hand)?.isPending == true)
        #expect(ControlsFixtureSession(state: .cameraDenied).controls.bar.control(.camera)?.reason == .permissionDenied)
        #expect(ControlsFixtureSession(state: .hostDisabledMedia).controls.bar.control(.microphone)?.reason == .disabledByHost)
        #expect(ControlsFixtureSession(state: .remoteShare).controls.bar.control(.screenShare)?.reasonName == "Avery")
    }

    @Test func fixtureCountersFollowTheCells() {
        // 1 l6: a Mic tap while recovering counts once; a Share tap on the wide recovering bar explains.
        let recovering = ControlsFixtureSession(state: .recovering)
        #expect(recovering.controls.tap(.microphone) == .dispatched)
        #expect(recovering.counters.toggleMicrophone == 1)
        let wideRecovering = ControlsFixtureSession(state: .wideRecovering)
        #expect(wideRecovering.controls.tap(.screenShare) == .explained)
        #expect(wideRecovering.counters.toggleShare == 0 && wideRecovering.controls.explainCount == 1)
        #expect(wideRecovering.countersReadout().contains("explain=1"))
        // 1 l19 in the fixture: tap toward live (slow ack), then toward muted while it is pending.
        let slow = ControlsFixtureSession(state: .slowAck)
        slow.sleep = { _ in }
        #expect(slow.controls.tap(.microphone) == .dispatched)
        #expect(slow.controls.bar.control(.microphone)?.isPending == true && slow.controls.bar.control(.microphone)?.isOn == true)
        #expect(slow.controls.tap(.microphone) == .dispatched)
        #expect(slow.counters.toggleMicrophone == 2 && slow.controls.bar.control(.microphone)?.isOn == false)
        // With the mute pending, a tap toward live changes nothing.
        if slow.controls.bar.control(.microphone)?.isPending == true {
            #expect(slow.controls.tap(.microphone) == .ignored && slow.counters.toggleMicrophone == 2)
        }
        // 1 l17: Participants from the wide bar counts one panel present.
        let wide = ControlsFixtureSession(state: .wide)
        _ = wide.controls.tap(.participants)
        #expect(wide.counters.panelPresent == 1 && wide.panelReadout().hasPrefix("panel=participants invoker=call"))
    }

    // MARK: Source scans (iOS views are not compiled by the macOS host; Kotlin is read)

    @Test func iosBarStaysHitTestableUsesTheSingleGlassEntryAndPlaysOnlyOnDispatch() throws {
        let cell = controlsNormalized(try controlsSource("Sources/Conclave/Features/Meeting/Controls/CallControlCell+iOS.swift"))
        let bar = controlsNormalized(try controlsSource("Sources/Conclave/Features/Meeting/Controls/CallControlBar+iOS.swift"))
        let chrome = controlsNormalized(try controlsSource("Sources/Conclave/Features/Meeting/Stage/StageChrome+iOS.swift"))
        for text in [cell, bar] { #expect(text.hasPrefix("#if os(iOS) && !SKIP")) }
        // CL6: blocked stays hit-testable; only leaving disables.
        #expect(cell.contains(".disabled(model.reason == ControlBlockedReason.leaving)"))
        #expect(!cell.contains(".disabled(model.isBlocked)") && !cell.contains(".disabled(!"))
        #expect(cell.contains(".conclaveControlSurface(state, isEnabled: !isBlocked, shape: .circle)"))
        // 1 h: the gesture kind is computed before the tap and plays only on dispatched.
        #expect(cell.contains("let kind = ControlBarPolicy.gestureKind(model) if controls.tap(model.kind) == ControlTapResult.dispatched, let kind {"))
        #expect(cell.contains(".conclaveGestureFeedback(feedbackKind, trigger: feedbackCount)"))
        // Toggle semantics, the Large Content Viewer, pointer help and the 600 ms one-shot.
        #expect(cell.contains(".accessibilityAddTraits(.isToggle)") && cell.contains(".accessibilityShowsLargeContentViewer"))
        #expect(cell.contains(".help(") && cell.contains(".task(id: model.isPending)"))
        #expect(cell.contains("static let spinnerDelayMillis = 600"))
        // The bar reads one presenter property; the alert is a separate leaf; the window report is equality guarded.
        #expect(bar.contains("let bar = controls.bar"))
        #expect(bar.contains("private struct CallControlsAlertHost: View"))
        #expect(bar.contains("isPhone: UIDevice.current.userInterfaceIdiom == .phone"))
        // The stage chrome mounts the bar from the environment; the chrome keeps its two hidden-from-accessibility layers.
        #expect(chrome.contains("@Environment(CallControlsPresenter.self) private var controls: CallControlsPresenter?"))
        #expect(chrome.contains("CallControlBar(controls: controls, available: available)"))
        #expect(chrome.components(separatedBy: ".accessibilityHidden(hidden)").count - 1 == 2)
        for text in [cell, bar] {
            for pattern in ["glassEffect", "GlassEffectContainer", "Material", "HapticManager", "MeetingViewModel", "UIScreen.main"] {
                #expect(!text.contains(pattern), "uses \(pattern)")
            }
        }
    }

    @Test func androidBarUsesCallToggleStaysClickableAndPlaysOnlyOnDispatch() throws {
        let toggle = controlsNormalized(try controlsSource("Sources/Conclave/Skip/ui/call/controls/CallToggle.kt"))
        let bar = controlsNormalized(try controlsSource("Sources/Conclave/Skip/ui/call/controls/CallControlBar.kt"))
        let caches = controlsNormalized(try controlsSource("Sources/Conclave/Skip/ui/call/controls/ControlsCaches.kt"))
        let chrome = controlsNormalized(try controlsSource("Sources/Conclave/Skip/ui/call/stage/StageChrome.kt"))
        // CL3: combinedClickable with the Switch role and no built-in haptic; CL6: clickable while blocked.
        #expect(toggle.contains("enabled = !control.isLeaving, role = Role.Switch,"))
        #expect(toggle.contains("hapticFeedbackEnabled = false,"))
        #expect(toggle.contains("toggleableState = ToggleableState(control.isOn)"))
        #expect(toggle.contains(".alpha(if (control.isBlocked) CONCLAVE_CALL_DISABLED_ALPHA else 1f)"))
        #expect(!toggle.contains("enabled = !control.isBlocked") && !toggle.contains("FilledIconToggleButton"))
        // 1 h on Android: computed first, played only on dispatched.
        #expect(bar.contains("val kind = control.gesture if (controls.tap(control.kind) == ControlTapResult.dispatched && kind != null) haptics.gesture(kind)"))
        #expect(bar.contains("LaunchedEffect(control.isPending) { slowAck = false if (control.isPending) { delay(CALL_CONTROL_SPINNER_DELAY_MS) slowAck = true } }"))
        #expect(bar.contains("internal val LocalCallControls = staticCompositionLocalOf<CallControlsPresenter?> { null }"))
        #expect(bar.contains("Modifier.widthIn(max = ControlBarPolicy.androidMaxToolbarWidth.dp)"))
        // CL14 caches always read the observed property.
        #expect(caches.contains("val state = presenter.bar val previous = cached"))
        // The chrome mounts the bar from the composition local and never pads it for the IME.
        #expect(chrome.contains("val controls = LocalCallControls.current"))
        #expect(chrome.contains("WindowInsets.systemBars.union(WindowInsets.displayCutout) .only(WindowInsetsSides.Bottom + WindowInsetsSides.Horizontal)"))
        for text in [toggle, bar, caches] {
            for pattern in ["@Stable", "@Immutable", "LocalHapticFeedback", "Vibrator", "MeetingViewModel", "FloatingToolbar", "ButtonGroup",
                            "dynamicDarkColorScheme", "Color(0x", "fontFamily ="] {
                #expect(!text.contains(pattern), "uses \(pattern)")
            }
        }
    }

    @Test func controlsSourcesStayFlatDashFreeAndSkipLite() throws {
        var files = try controlsFiles(under: "Sources/Conclave/Features/Meeting/Controls", extensions: ["swift"])
        files += try controlsFiles(under: "Sources/Conclave/Skip/ui/call/controls", extensions: ["kt"])
        #expect(files.count >= 11)
        for file in files {
            let text = try controlsSource(file)
            #expect(!text.contains("\u{2013}") && !text.contains("\u{2014}"), "\(file) has an en or em dash")
            #expect(!text.lowercased().contains("gradient"), "\(file) mentions a gradient")
            #expect(controlsMatches(#"(UIColor|Color)\(\s*(red:|\.sRGB|0x)"#, in: text).isEmpty, "\(file) builds a color from a literal")
            #expect(!text.contains("MeetingViewModel.shared"), "\(file) reads the view model")
        }
        for file in try controlsFiles(under: "Sources/Conclave/Features/Meeting/Controls", extensions: ["swift"]) where !file.contains("+iOS") {
            let text = try controlsSource(file)
            #expect(!text.contains("#if"), "\(file) is shared and must not branch by platform")
            #expect(controlsMatches(#"\bprotocol\s"#, in: text).isEmpty, "\(file) declares a protocol")
            #expect(controlsMatches(#"case\s+\w+\("#, in: text).isEmpty, "\(file) has an associated value")
            #expect(controlsMatches(#"\.(map|compactMap|flatMap)\(\w+(\.init)?\)"#, in: text).isEmpty, "\(file) maps with a function reference")
            #expect(!text.contains("inout ") && !text.contains("isLetter"), "\(file)")
        }
        // The PanelCoordinator additions stay inside MeetingPanel.swift's types (Tests/IOSFeedbackAdapter/run.py).
        let coordinator = controlsNormalized(try controlsSource("Sources/Conclave/Features/Meeting/Panels/PanelCoordinator.swift"))
        #expect(coordinator.contains("func toggle(_ panel: MeetingPanel, from invoker: PanelInvoker) {"))
        #expect(coordinator.contains("var currentPanelName: String { snapshot.current?.panel.rawValue ?? \"\" }"))
    }
}

#if os(macOS)
/// CC1 and CC18 wiring through the view model (macOS host; the socket and media stubs never reach the network). Depends
/// on the core edits in HD/requests/B4-T6.md R1 and R2 (`controls`, `makeCallControlsInputs()`, `controlsRefreshCount`,
/// `MeetingState.onControlsInputChanged`), which the batch integrator applies.
@MainActor
@Suite(.serialized)
struct ControlsViewModelWiringTests {
    private func makeJoinedViewModel() -> MeetingViewModel {
        let viewModel = MeetingViewModel()
        viewModel.state = MeetingState(userId: "local@example.com#local-session", sessionId: "local-session")
        viewModel.state.sfuUserId = "local@example.com"
        viewModel.state.roomId = "room-a"
        viewModel.state.connectionState = ConnectionState.joined
        return viewModel
    }

    @Test func everyControlsFieldRefreshesTheControlsOnceAndHotFieldsNever() {
        let viewModel = makeJoinedViewModel()
        let state = viewModel.state
        func refreshesOnce(_ name: String, _ change: () -> Void) {
            let before = viewModel.controlsRefreshCount
            change()
            #expect(viewModel.controlsRefreshCount == before + 1, "\(name) refreshed \(viewModel.controlsRefreshCount - before) times")
            #expect(viewModel.controls.inputs == viewModel.makeCallControlsInputs(), "\(name) left stale controls inputs")
        }
        func refreshesNever(_ name: String, _ change: () -> Void) {
            let before = viewModel.controlsRefreshCount
            change()
            #expect(viewModel.controlsRefreshCount == before, "\(name) refreshed the controls")
        }
        // CC1 hooks (fields S1 does not hook).
        refreshesOnce("isRoomLocked") { state.isRoomLocked = true }
        refreshesOnce("isWebinarEnabled") { state.isWebinarEnabled = true }
        refreshesOnce("isBrowserActive") { state.isBrowserActive = true }
        refreshesOnce("activeAppId") { state.activeAppId = "wheel" }
        refreshesOnce("viewMode") { state.viewMode = .tiled }
        // S1-hooked fields arrive through the shell refresh, once, after S1 published.
        refreshesOnce("isMuted") { state.isMuted = false }
        refreshesOnce("isCameraOff") { state.isCameraOff = false }
        refreshesOnce("isAdmin") { state.isAdmin = true }
        refreshesOnce("pendingUsers") { state.pendingUsers["p@example.com#p"] = "Pat" }
        refreshesOnce("isReactionsDisabled") { state.isReactionsDisabled = true }
        refreshesOnce("activeScreenShareUserId") { state.activeScreenShareUserId = "r@example.com#r" }
        refreshesOnce("isNetworkOffline") { state.isNetworkOffline = true }
        // CC18: a panel snapshot change refreshes once.
        refreshesOnce("panel open") { viewModel.shell.panels.present(.participants, from: .call) }
        #expect(viewModel.controls.inputs.currentPanel == MeetingPanel.participants.rawValue)
        // Hot values never reach the controls (S30 1 k).
        refreshesNever("activeSpeakerId") { state.activeSpeakerId = "r@example.com#r" }
        refreshesNever("activeReactions") { state.activeReactions = [] }
        refreshesNever("displayNames") { state.displayNames["r@example.com#r"] = "Rae" }
    }
}
#endif

// MARK: Helpers (file-private names so no other suite collides)

private func controlsPackageRoot() -> URL {
    URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
}

func controlsSource(_ packageRelativePath: String) throws -> String {
    try String(contentsOf: controlsPackageRoot().appendingPathComponent(packageRelativePath).standardizedFileURL, encoding: .utf8)
}

func controlsNormalized(_ text: String) -> String {
    text.split(whereSeparator: { $0.isWhitespace }).joined(separator: " ")
}

func controlsFiles(under directory: String, extensions: Set<String>) throws -> [String] {
    let root = controlsPackageRoot()
    var result: [String] = []
    let enumerator = FileManager.default.enumerator(at: root.appendingPathComponent(directory), includingPropertiesForKeys: nil)
    while let url = enumerator?.nextObject() as? URL {
        if extensions.contains(url.pathExtension) { result.append(url.path) }
    }
    let prefix = root.path + "/"
    return result.map { $0.hasPrefix(prefix) ? String($0.dropFirst(prefix.count)) : $0 }.sorted()
}

func controlsMatches(_ pattern: String, in text: String) -> [String] {
    guard let regex = try? NSRegularExpression(pattern: pattern) else { return [] }
    let range = NSRange(text.startIndex..<text.endIndex, in: text)
    return regex.matches(in: text, range: range).compactMap { match in
        Range(match.range, in: text).map { String(text[$0]) }
    }
}
#endif
