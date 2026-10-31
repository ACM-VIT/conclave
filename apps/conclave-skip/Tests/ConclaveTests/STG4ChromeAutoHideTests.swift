#if !SKIP
import Foundation
import Testing
@testable import Conclave

@MainActor
struct STG4ChromeAutoHideTests {
    private func stage(_ inputs: StageInputs) -> StagePresenter {
        let presenter = StagePresenter(shell: MeetingShellPresenter())
        presenter.setViewport(StagePoliciesTests.iphoneSE)
        presenter.apply(inputs)
        return presenter
    }

    @Test func reduceTogglesRevealsAndNeverHidesWhileBlocked() {
        let visible = ChromeVisibilityState.initial
        #expect(!visible.isHidden)

        let hidden = ChromeAutoHidePolicy.reduce(visible, event: .tap, canAutoHide: true)
        #expect(hidden.isHidden)
        #expect(!ChromeAutoHidePolicy.reduce(hidden, event: .tap, canAutoHide: true).isHidden)
        #expect(!ChromeAutoHidePolicy.reduce(hidden, event: .tap, canAutoHide: false).isHidden)
        let blockedTap = ChromeAutoHidePolicy.reduce(visible, event: .tap, canAutoHide: false)
        #expect(!blockedTap.isHidden && blockedTap.armSerial == visible.armSerial + 1)

        let fired = ChromeAutoHidePolicy.reduce(visible, event: .timerFired, canAutoHide: true)
        #expect(fired.isHidden && fired.armSerial == visible.armSerial)
        #expect(!ChromeAutoHidePolicy.reduce(visible, event: .timerFired, canAutoHide: false).isHidden)
        #expect(ChromeAutoHidePolicy.reduce(hidden, event: .timerFired, canAutoHide: true) == hidden)

        #expect(ChromeAutoHidePolicy.reduce(visible, event: .interaction, canAutoHide: true).armSerial == visible.armSerial + 1)
        #expect(ChromeAutoHidePolicy.reduce(hidden, event: .interaction, canAutoHide: true) == hidden)

        for event in [ChromeVisibilityEvent.muteChanged, .rotation, .pipRestore, .panelClosed, .actionBanner, .screenReaderOn] {
            #expect(ChromeAutoHidePolicy.isRevealTrigger(event))
            let next = ChromeAutoHidePolicy.reduce(hidden, event: event, canAutoHide: true)
            #expect(!next.isHidden && next.armSerial == hidden.armSerial + 1, "\(event.rawValue)")
        }
        for event in [ChromeVisibilityEvent.tap, .interaction, .timerFired, .blockerChanged] {
            #expect(!ChromeAutoHidePolicy.isRevealTrigger(event))
        }

        #expect(!ChromeAutoHidePolicy.reduce(hidden, event: .blockerChanged, canAutoHide: false).isHidden)
        let cleared = ChromeAutoHidePolicy.reduce(visible, event: .blockerChanged, canAutoHide: true)
        #expect(!cleared.isHidden && cleared.armSerial == visible.armSerial + 1)

        #expect(ChromeAutoHidePolicy.shouldArm(visible, canAutoHide: true))
        #expect(!ChromeAutoHidePolicy.shouldArm(visible, canAutoHide: false))
        #expect(!ChromeAutoHidePolicy.shouldArm(hidden, canAutoHide: true))
        #expect(ChromeAutoHidePolicy.chromeOpacity(hidden) == 0 && ChromeAutoHidePolicy.chromeOpacity(visible) == 1)
    }

    @Test func assistiveTechnologyAndFocusAlwaysKeepChrome() {

        #expect(ChromeAutoHidePolicy.canAutoHide(blocker: .none, voiceOver: false, switchControl: false, focusInChrome: false))
        #expect(!ChromeAutoHidePolicy.canAutoHide(blocker: .none, voiceOver: true, switchControl: false, focusInChrome: false))
        #expect(!ChromeAutoHidePolicy.canAutoHide(blocker: .none, voiceOver: false, switchControl: true, focusInChrome: false))
        #expect(!ChromeAutoHidePolicy.canAutoHide(blocker: .none, voiceOver: false, switchControl: false, focusInChrome: true))
        for blocker in AutoHideBlocker.allCases where blocker != .none {
            #expect(!ChromeAutoHidePolicy.canAutoHide(blocker: blocker, voiceOver: false, switchControl: false, focusInChrome: false))
        }
        #expect(ChromeAutoHidePolicy.effectiveBlocker(presenter: .panelOpen, screenReader: true, focusInChrome: true) == .screenReader)
        #expect(ChromeAutoHidePolicy.effectiveBlocker(presenter: .panelOpen, screenReader: false, focusInChrome: true) == .focusInChrome)
        #expect(ChromeAutoHidePolicy.effectiveBlocker(presenter: .reconnecting, screenReader: false, focusInChrome: false) == .reconnecting)

        let talkBack = SystemAccessibilityMapping.androidState(touchExploration: true, anyServiceEnabled: false,
                                                               animatorDurationScale: 1, recommendedTimeoutMillis: 7_500)
        #expect(talkBack.isScreenReaderRunning && talkBack.blocksAutoHide)
    }

    @Test func hideDelayUsesThePlatformTimeoutAndTheRecentJoinHold() {
        #expect(ChromeAutoHidePolicy.baseTimeoutMillis == 5_000)
        #expect(ChromeAutoHidePolicy.hideDelayMillis(timeoutMillis: 5_000, holdUntilMillis: 0, nowMillis: 100_000) == 5_000)

        #expect(ChromeAutoHidePolicy.hideDelayMillis(timeoutMillis: 7_500, holdUntilMillis: 0, nowMillis: 100_000) == 7_500)
        #expect(ChromeAutoHidePolicy.hideDelayMillis(timeoutMillis: 0, holdUntilMillis: 0, nowMillis: 100_000) == 5_000)

        let joinedAt = 100_000.0
        let hold = joinedAt + ChromeAutoHidePolicy.recentJoinHoldMillis
        #expect(ChromeAutoHidePolicy.hideDelayMillis(timeoutMillis: 5_000, holdUntilMillis: hold, nowMillis: joinedAt + 1_000) == 7_000)
        let presenter = stage(StageFixtureScript.copy(StageFixtureScript.base(count: 4)))
        #expect(presenter.recentJoinHoldUntilMillis == StageFixtureScript.joinedAtMillis + 8_000)
        #expect(stage(StageInputs.make()).recentJoinHoldUntilMillis == 0)
    }

    @Test func presenterBlockerFollowsTheFactsInPriorityOrder() {
        let base = StageFixtureScript.base(count: 4)
        #expect(stage(base).autoHideBlocker == .none)

        #expect(stage(StageFixtureScript.inputs(for: .audioOnly)).autoHideBlocker == .noRemoteVideo)
        #expect(stage(StageFixtureScript.inputs(for: .recovering)).autoHideBlocker == .reconnecting)
        let pending = StageInputs.make(callSession: 1, isInCall: true, localUserId: "you", participants: StageFixtureScript.roster(count: 4),
                                       isMediaPending: true)
        #expect(stage(pending).autoHideBlocker == .mediaPending)
        let presenting = StageInputs.make(callSession: 1, isInCall: true, localUserId: "you", participants: StageFixtureScript.roster(count: 4),
                                          screenShareUserId: "you", isLocalScreenSharing: true)
        #expect(stage(presenting).autoHideBlocker == .presenting)

        let always = StageInputs.make(callSession: 1, isInCall: true, localUserId: "you", participants: StageFixtureScript.roster(count: 4),
                                      isRecovering: true, alwaysShowControls: true)
        #expect(stage(always).autoHideBlocker == .alwaysShow)

        for kind in [AutoHideBlocker.screenReader, .focusInChrome, .recentlyJoined] {
            #expect(stage(base).autoHideBlocker != kind)
        }
    }

    @Test func panelsAndTransientChromeHoldChrome() throws {
        let presenter = stage(StageFixtureScript.base(count: 4))
        #expect(presenter.autoHideBlocker == .none)
        presenter.shell.panels.present(.participants, from: .call)
        presenter.panelSnapshotChanged()
        #expect(presenter.autoHideBlocker == .panelOpen)
        let current = try #require(presenter.shell.panels.snapshot.current)
        presenter.shell.panels.dismiss(cancelPending: true)
        presenter.shell.panels.didDismiss(session: presenter.shell.panels.snapshot.session, presentationID: current.presentationID)
        presenter.panelSnapshotChanged()
        #expect(presenter.autoHideBlocker == .none)

        presenter.setTransientChrome(id: ChromeAutoHidePolicy.moreSheet, open: true)
        presenter.setTransientChrome(id: ChromeAutoHidePolicy.moreSheet, open: true)
        presenter.setTransientChrome(id: ChromeAutoHidePolicy.routeSheet, open: true)
        #expect(presenter.autoHideBlocker == .panelOpen)
        #expect(presenter.transientChromeSummary == "more.sheet route.sheet")
        presenter.setTransientChrome(id: ChromeAutoHidePolicy.moreSheet, open: false)
        presenter.setTransientChrome(id: ChromeAutoHidePolicy.moreSheet, open: false)
        #expect(presenter.transientChromeSummary == "route.sheet")
        presenter.setTransientChrome(id: ChromeAutoHidePolicy.routeSheet, open: false)
        #expect(presenter.autoHideBlocker == .none && presenter.transientChromeSummary == "none")

        presenter.setTransientChrome(id: ChromeAutoHidePolicy.barHold, open: true)
        #expect(presenter.autoHideBlocker == .panelOpen)
        presenter.stageTapped()
        #expect(presenter.autoHideBlocker == .none)
        presenter.setTransientChrome(id: ChromeAutoHidePolicy.barHold, open: true)
        presenter.noteControlAction()
        #expect(presenter.transientChromeSummary == "none")
        presenter.setTransientChrome(id: ChromeAutoHidePolicy.barHold, open: true)
        presenter.openMeetingInfo()
        presenter.panelSnapshotChanged()
        #expect(presenter.transientChromeSummary == "none" && presenter.autoHideBlocker == .panelOpen)

        presenter.setTransientChrome(id: ChromeAutoHidePolicy.cameraMenu, open: true)
        presenter.reset()
        #expect(presenter.transientChromeSummary == "none")
        #expect(ChromeAutoHidePolicy.transientIds == ["more.sheet", "route.sheet", "route.picker", "camera.menu", "leave.menu",
                                                      "end.dialog", "reactions.tray", "bar.hold"])
    }

    @Test func capsuleAndChipActionsReachTheirOwners() {
        let session = StageFixtureSession(state: .handRaised)
        #expect(session.stage.localHand == .raised)

        session.stage.lowerHand()
        #expect(session.stage.localHand == .lowered)

        session.stage.lowerHand()
        #expect(session.stage.localHand == .lowered)
        session.stage.openMeetingInfo()
        #expect(session.panelReadout() == "panel=meetingInfo invoker=call destination=none")

        session.magicTap()
        session.magicTap()
        #expect(session.counters.toggleMicrophone == 2)
    }

    @Test func reactionBurstRules() {
        #expect(StageReactionPolicy.lifetimeMillis == 3_800)
        #expect(StageReactionPolicy.riseDistance == 160 && StageReactionPolicy.riseMillis == 3_450)
        #expect(StageReactionPolicy.opacity(progress: 0) == 1 && StageReactionPolicy.opacity(progress: 0.6) == 1)
        #expect(abs(StageReactionPolicy.opacity(progress: 0.8) - 0.5) < 0.0001)
        #expect(StageReactionPolicy.opacity(progress: 1) == 0)
        #expect(StageReactionPolicy.lane(for: 0) == 0 && StageReactionPolicy.lane(for: 4) == 1 && StageReactionPolicy.lane(for: -1) == 2)
        var events: [ReactionEvent] = []
        for index in 1...25 {
            events.append(ReactionEvent(id: index, senderName: "", isLocal: false, kind: "emoji", value: "x", label: "x"))
        }
        let visible = StageReactionPolicy.visibleEvents(StageReactionsSnapshot(revision: 1, events: events, renderLimit: 20))

        #expect(visible.count == 20 && visible.first?.id == 6 && visible.last?.id == 25)
        #expect(StageReactionPolicy.visibleEvents(StageReactionsSnapshot(revision: 1, events: events, renderLimit: 8)).count == 8)
    }

}
#endif
