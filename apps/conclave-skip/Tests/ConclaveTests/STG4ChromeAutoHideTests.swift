#if !SKIP
import Foundation
import Testing
@testable import Conclave

/// STG-4 (OUT/PLAN-screens.md section 5): top chrome, chrome auto-hide and the reactions overlay. The pure
/// `ChromeAutoHidePolicy` (S20 SL8), the presenter's `AutoHideBlocker` and `setTransientChrome` (S30 CC16), the
/// `alwaysShowControls` input (S60 C6-14), Magic Tap, the reaction rules (S20 9) and source scans of the iOS and
/// Compose chrome. The Kotlin half is in T/Skip/StageBridgeTests.kt.
@MainActor
struct STG4ChromeAutoHideTests {
    private func stage(_ inputs: StageInputs) -> StagePresenter {
        let presenter = StagePresenter(shell: MeetingShellPresenter())
        presenter.setViewport(StagePoliciesTests.iphoneSE)
        presenter.apply(inputs)
        return presenter
    }

    // MARK: ChromeAutoHidePolicy (S20 8)

    @Test func reduceTogglesRevealsAndNeverHidesWhileBlocked() {
        let visible = ChromeVisibilityState.initial
        #expect(!visible.isHidden)
        // A tap hides when hiding is allowed and shows again; a blocked tap keeps chrome and re-arms.
        let hidden = ChromeAutoHidePolicy.reduce(visible, event: .tap, canAutoHide: true)
        #expect(hidden.isHidden)
        #expect(!ChromeAutoHidePolicy.reduce(hidden, event: .tap, canAutoHide: true).isHidden)
        #expect(!ChromeAutoHidePolicy.reduce(hidden, event: .tap, canAutoHide: false).isHidden)
        let blockedTap = ChromeAutoHidePolicy.reduce(visible, event: .tap, canAutoHide: false)
        #expect(!blockedTap.isHidden && blockedTap.armSerial == visible.armSerial + 1)
        // The timer hides only visible, eligible chrome and never re-arms itself.
        let fired = ChromeAutoHidePolicy.reduce(visible, event: .timerFired, canAutoHide: true)
        #expect(fired.isHidden && fired.armSerial == visible.armSerial)
        #expect(!ChromeAutoHidePolicy.reduce(visible, event: .timerFired, canAutoHide: false).isHidden)
        #expect(ChromeAutoHidePolicy.reduce(hidden, event: .timerFired, canAutoHide: true) == hidden)
        // Interaction re-arms visible chrome only.
        #expect(ChromeAutoHidePolicy.reduce(visible, event: .interaction, canAutoHide: true).armSerial == visible.armSerial + 1)
        #expect(ChromeAutoHidePolicy.reduce(hidden, event: .interaction, canAutoHide: true) == hidden)
        // Every reveal trigger shows chrome and re-arms (S20 8 f).
        for event in [ChromeVisibilityEvent.muteChanged, .rotation, .pipRestore, .panelClosed, .actionBanner, .screenReaderOn] {
            #expect(ChromeAutoHidePolicy.isRevealTrigger(event))
            let next = ChromeAutoHidePolicy.reduce(hidden, event: event, canAutoHide: true)
            #expect(!next.isHidden && next.armSerial == hidden.armSerial + 1, "\(event.rawValue)")
        }
        for event in [ChromeVisibilityEvent.tap, .interaction, .timerFired, .blockerChanged] {
            #expect(!ChromeAutoHidePolicy.isRevealTrigger(event))
        }
        // A blocker appearing reveals hidden chrome; clearing it re-arms without hiding.
        #expect(!ChromeAutoHidePolicy.reduce(hidden, event: .blockerChanged, canAutoHide: false).isHidden)
        let cleared = ChromeAutoHidePolicy.reduce(visible, event: .blockerChanged, canAutoHide: true)
        #expect(!cleared.isHidden && cleared.armSerial == visible.armSerial + 1)
        // The one-shot arms only while visible and eligible: nothing ticks while hidden or blocked (RR8).
        #expect(ChromeAutoHidePolicy.shouldArm(visible, canAutoHide: true))
        #expect(!ChromeAutoHidePolicy.shouldArm(visible, canAutoHide: false))
        #expect(!ChromeAutoHidePolicy.shouldArm(hidden, canAutoHide: true))
        #expect(ChromeAutoHidePolicy.chromeOpacity(hidden) == 0 && ChromeAutoHidePolicy.chromeOpacity(visible) == 1)
    }

    @Test func assistiveTechnologyAndFocusAlwaysKeepChrome() {
        // Time-boxed UI is disabled for assistive technology (S20 8 i): VoiceOver (or the fixture override),
        // Switch Control, TalkBack touch exploration and keyboard focus in chrome each block.
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
        // The Android reader maps touch exploration to the same flag (S70 13 d).
        let talkBack = SystemAccessibilityMapping.androidState(touchExploration: true, anyServiceEnabled: false,
                                                               animatorDurationScale: 1, recommendedTimeoutMillis: 7_500)
        #expect(talkBack.isScreenReaderRunning && talkBack.blocksAutoHide)
    }

    @Test func hideDelayUsesThePlatformTimeoutAndTheRecentJoinHold() {
        #expect(ChromeAutoHidePolicy.baseTimeoutMillis == 5_000)
        #expect(ChromeAutoHidePolicy.hideDelayMillis(timeoutMillis: 5_000, holdUntilMillis: 0, nowMillis: 100_000) == 5_000)
        // Android API 29+ stretches it (getRecommendedTimeoutMillis).
        #expect(ChromeAutoHidePolicy.hideDelayMillis(timeoutMillis: 7_500, holdUntilMillis: 0, nowMillis: 100_000) == 7_500)
        #expect(ChromeAutoHidePolicy.hideDelayMillis(timeoutMillis: 0, holdUntilMillis: 0, nowMillis: 100_000) == 5_000)
        // Within 8 s of joining chrome stays: the delay runs to the end of the hold.
        let joinedAt = 100_000.0
        let hold = joinedAt + ChromeAutoHidePolicy.recentJoinHoldMillis
        #expect(ChromeAutoHidePolicy.hideDelayMillis(timeoutMillis: 5_000, holdUntilMillis: hold, nowMillis: joinedAt + 1_000) == 7_000)
        let presenter = stage(StageFixtureScript.copy(StageFixtureScript.base(count: 4)))
        #expect(presenter.recentJoinHoldUntilMillis == StageFixtureScript.joinedAtMillis + 8_000)
        #expect(stage(StageInputs.make()).recentJoinHoldUntilMillis == 0)
    }

    // MARK: Presenter blocker (S20 8 f, j; S30 CC16; S60 C6-14)

    @Test func presenterBlockerFollowsTheFactsInPriorityOrder() {
        let base = StageFixtureScript.base(count: 4)
        #expect(stage(base).autoHideBlocker == .none)
        // Audio-only grids (no remote video and no share) never hide.
        #expect(stage(StageFixtureScript.inputs(for: .audioOnly)).autoHideBlocker == .noRemoteVideo)
        #expect(stage(StageFixtureScript.inputs(for: .recovering)).autoHideBlocker == .reconnecting)
        let pending = StageInputs.make(callSession: 1, isInCall: true, localUserId: "you", participants: StageFixtureScript.roster(count: 4),
                                       isMediaPending: true)
        #expect(stage(pending).autoHideBlocker == .mediaPending)
        let presenting = StageInputs.make(callSession: 1, isInCall: true, localUserId: "you", participants: StageFixtureScript.roster(count: 4),
                                          screenShareUserId: "you", isLocalScreenSharing: true)
        #expect(stage(presenting).autoHideBlocker == .presenting)
        // S60 C6-14: Always Show Controls wins over everything the presenter knows.
        let always = StageInputs.make(callSession: 1, isInCall: true, localUserId: "you", participants: StageFixtureScript.roster(count: 4),
                                      isRecovering: true, alwaysShowControls: true)
        #expect(stage(always).autoHideBlocker == .alwaysShow)
        // The presenter never sets the view facts.
        for kind in [AutoHideBlocker.screenReader, .focusInChrome, .recentlyJoined] {
            #expect(stage(base).autoHideBlocker != kind)
        }
    }

    @Test func panelsAndTransientChromeHoldChrome() {
        let presenter = stage(StageFixtureScript.base(count: 4))
        #expect(presenter.autoHideBlocker == .none)
        presenter.shell.panels.present(.participants, from: .call)
        presenter.panelSnapshotChanged()
        #expect(presenter.autoHideBlocker == .panelOpen)
        let current = presenter.shell.panels.snapshot.current!
        presenter.shell.panels.dismiss(cancelPending: true)
        presenter.shell.panels.didDismiss(session: presenter.shell.panels.snapshot.session, presentationID: current.presentationID)
        presenter.panelSnapshotChanged()
        #expect(presenter.autoHideBlocker == .none)
        // S30 CC16: an equality-guarded set of open ids.
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
        // bar.hold clears on a stage tap, on the next control action and when a panel opens.
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
        // Cleared on reset.
        presenter.setTransientChrome(id: ChromeAutoHidePolicy.cameraMenu, open: true)
        presenter.reset()
        #expect(presenter.transientChromeSummary == "none")
        #expect(ChromeAutoHidePolicy.transientIds == ["more.sheet", "route.sheet", "route.picker", "camera.menu", "leave.menu",
                                                      "end.dialog", "reactions.tray", "bar.hold"])
    }

    @Test func capsuleAndChipActionsReachTheirOwners() {
        let session = StageFixtureSession(state: .handRaised)
        #expect(session.stage.localHand == .raised)
        // Lower delegates to the S1 hand ticket; the scripted core lowers the hand.
        session.stage.lowerHand()
        #expect(session.stage.localHand == .lowered)
        // Lower does nothing while the hand is not up.
        session.stage.lowerHand()
        #expect(session.stage.localHand == .lowered)
        session.stage.openMeetingInfo()
        #expect(session.panelReadout() == "panel=meetingInfo invoker=call destination=none")
        // Magic Tap is the microphone toggle: one tap, one dispatch.
        session.magicTap()
        session.magicTap()
        #expect(session.counters.toggleMicrophone == 2)
    }

    // MARK: Reactions (S20 9)

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
        // The newest 20; older ones beyond the limit are not drawn.
        #expect(visible.count == 20 && visible.first?.id == 6 && visible.last?.id == 25)
        #expect(StageReactionPolicy.visibleEvents(StageReactionsSnapshot(revision: 1, events: events, renderLimit: 8)).count == 8)
    }

    // MARK: Source scans

    @Test func iosChromeOwnsOverlaysTimerAndHidesFromHitTestingAndAccessibilityTogether() throws {
        let chrome = stageNormalized(try stageSource("Sources/Conclave/Features/Meeting/Stage/StageChrome+iOS.swift"))
        #expect(chrome.contains(".persistentSystemOverlays(hidden ? .hidden : .automatic)"))
        #expect(chrome.contains(".statusBarHidden(hidden && compactHeight)"))
        #expect(chrome.contains(".allowsHitTesting(!hidden) .accessibilityHidden(hidden)"))
        #expect(chrome.contains(".task(id: StageChromeArmKey(serial: state.armSerial, armed: ChromeAutoHidePolicy.shouldArm(state, canAutoHide: canAutoHide)))"))
        #expect(chrome.contains("guard ChromeAutoHidePolicy.shouldArm(chrome.state, canAutoHide: chrome.canAutoHide) else { return }"))
        #expect(chrome.contains("ConclaveMotion.fade(ConclaveMotion.chromeFade, reduceMotion: reduceMotion, instantWhenReduced: true)"))
        #expect(chrome.contains("AccessibilityNotification.Announcement(StageAnnouncementText.text(announcement)).post()"))
        // Capsule and route share the one glass cluster; chips stay outside it and are never glass (S20 SR3).
        #expect(chrome.contains("ConclaveTopChromeCluster(spacing: CGFloat(DesignTokens.space12)) { StageCapsuleButton(stage: stage, maxWidth: capsuleMaxWidth)"))
        #expect(chrome.contains("ConclaveRoutePickerButton(identifier: \"stage.route\", onPresentingChange: { open in stage.setTransientChrome(id: ChromeAutoHidePolicy.routePicker, open: open) })"))
        let cluster = try #require(chrome.range(of: "struct StageTopRow: View {"))
        let clusterEnd = try #require(chrome.range(of: "struct StageCapsuleButton: View {", range: cluster.upperBound..<chrome.endIndex))
        #expect(!String(chrome[cluster.upperBound..<clusterEnd.lowerBound]).contains("ConclaveStageChip"))
        #expect(chrome.contains("actionAccessibilityLabel: ConclaveStrings.text(\"Lower Hand\")"))
        #expect(chrome.contains(".conclaveGestureFeedback(.handLowered, trigger: lowers)"))
        // Hidden chrome never hides the self view, chips, banners, toasts or reactions: only the top row and the bar.
        #expect(chrome.components(separatedBy: ".accessibilityHidden(hidden)").count - 1 == 2)
    }

    @Test func androidChromeUsesOneKeyedEffectAndNoImmersiveMode() throws {
        let chrome = stageNormalized(try stageSource("Sources/Conclave/Skip/ui/call/stage/StageChrome.kt"))
        #expect(chrome.contains("LaunchedEffect(state.armSerial, armed) { if (!armed) return@LaunchedEffect"))
        #expect(chrome.contains("val timeout = accessState.recommendedTimeoutMillis"))
        #expect(chrome.contains("fadeIn(animationSpec = ConclaveMotion.chromeFade())"))
        #expect(chrome.contains("Box(Modifier.heightIn(min = ConclaveChromeMetrics.HEIGHT_DP.dp)) { AnimatedVisibility(visible = visible, enter = enter, exit = exit) { StageTopRow("))
        #expect(chrome.contains("haptics.gesture(FeedbackKind.selectionChanged)"))
        #expect(chrome.contains("actionDescription = conclaveString(\"stg_lower_hand\")"))
        for pattern in ["WindowInsetsControllerCompat", "systemBars())", "SYSTEM_UI_FLAG", "while (true)", "repeatOnLifecycle"] {
            #expect(!chrome.contains(pattern), "chrome uses \(pattern)")
        }
        let reactions = stageNormalized(try stageSource("Sources/Conclave/Skip/ui/call/stage/Reactions.kt"))
        #expect(reactions.contains("clearAndSetSemantics { }"))
        for pattern in ["clickable", "pointerInput", "while (true)", "infiniteRepeatable"] {
            #expect(!reactions.contains(pattern), "reactions use \(pattern)")
        }
        let ios = stageNormalized(try stageSource("Sources/Conclave/Features/Meeting/Stage/Reactions+iOS.swift"))
        #expect(ios.contains(".allowsHitTesting(false) .accessibilityHidden(true)"))
        #expect(ios.contains("guard !box.started else { return } box.started = true"))
        #expect(!ios.contains("repeatForever") && !ios.contains("TimelineView"))
    }

    @Test func magicTapAndTheFixtureButtonShareOneClosure() throws {
        let root = stageNormalized(try stageSource("Sources/Conclave/Features/Meeting/Stage/CallRoot+iOS.swift"))
        #expect(root.contains(".accessibilityAction(.magicTap) { shell.toggleMicrophone() }"))
        let fixtures = stageNormalized(try stageSource("Sources/Conclave/Features/Meeting/Stage/StageFixtures.swift"))
        #expect(fixtures.contains("func magicTap() { shell.toggleMicrophone() }"))
        let iosFixture = stageNormalized(try stageSource("Sources/Conclave/Features/Meeting/Stage/StageFixtureView+iOS.swift"))
        #expect(iosFixture.contains("fixtureButton(\"Magic Tap\", identifier: \"stage.fixture.magicTap\") { session.magicTap(); refresh += 1 }"))
        #expect(iosFixture.contains("environment[\"CONCLAVE_STAGE_FORCE_SCREEN_READER\"] == \"1\""))
        let androidFixture = stageNormalized(try stageSource("Sources/Conclave/Skip/ui/call/stage/StageFixtureRoot.kt"))
        #expect(androidFixture.contains("FixtureButton(\"Magic Tap\", \"stage.fixture.magicTap\") { session.magicTap(); refresh++ }"))
    }
}
#endif
