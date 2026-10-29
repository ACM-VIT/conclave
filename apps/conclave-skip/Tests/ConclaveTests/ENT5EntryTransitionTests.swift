#if !SKIP
import Foundation
import Testing
@testable import Conclave

@MainActor
struct ENT5EntryTransitionTests {
    private static let room = "rose-sora-luffy"

    private final class Recorder {
        var commands: [PremeetingCommand] = []
    }

    private func presenter(recorder: Recorder? = nil) -> PremeetingPresenter {
        let presenter = PremeetingPresenter()
        presenter.nowMillis = { 1793102400000.0 }
        presenter.slowNoticeDelayMillis = 5
        if let recorder {
            presenter.onCommand = { command in recorder.commands.append(command) }
        }
        return presenter
    }

    private func entering(callSession: Int = 1, offline: Bool = false) -> PremeetingInputs {
        PremeetingInputs.make(callSession: callSession, phase: .entering, roomLabel: Self.room, currentRoomId: Self.room,
                              isNetworkOffline: offline)
    }

    private func waiting(message: String = "", offline: Bool = false, restart: String = "") -> PremeetingInputs {
        PremeetingInputs.make(callSession: 1, phase: .waiting, noticeText: message, roomLabel: Self.room,
                              currentRoomId: Self.room, isNetworkOffline: offline, serverRestartText: restart)
    }

    @Test func waitingKindsFollowTheS10Table() {
        #expect(WaitingKindPolicy.classify(waitingMessage: "", isNetworkOffline: false, serverRestartText: "", isReconnecting: false) == .standard)
        #expect(WaitingKindPolicy.classify(waitingMessage: "This meeting is locked. Waiting for the host to let you in.",
                                           isNetworkOffline: false, serverRestartText: "", isReconnecting: false) == .locked)
        #expect(WaitingKindPolicy.classify(waitingMessage: "No one to let you in.", isNetworkOffline: false,
                                           serverRestartText: "", isReconnecting: false) == .noHost)
        #expect(WaitingKindPolicy.classify(waitingMessage: "A host is available to let you in.", isNetworkOffline: false,
                                           serverRestartText: "", isReconnecting: false) == .hostAvailable)
        #expect(WaitingKindPolicy.classify(waitingMessage: "", isNetworkOffline: false, serverRestartText: "",
                                           isReconnecting: true) == .reconnecting)

        #expect(WaitingKindPolicy.classify(waitingMessage: "This meeting is locked.", isNetworkOffline: true,
                                           serverRestartText: "Restarting", isReconnecting: true) == .offline)
        #expect(WaitingKindPolicy.classify(waitingMessage: "This meeting is locked.", isNetworkOffline: false,
                                           serverRestartText: "Restarting", isReconnecting: true) == .serverRestarting)
        #expect(WaitingKindPolicy.classify(waitingMessage: "", isNetworkOffline: false, serverRestartText: "  ",
                                           isReconnecting: false) == .standard)
    }

    @Test func theWaitingLobbyPublishesItsKindAndReturnsWhenOnline() {
        let presenter = presenter()
        presenter.apply(waiting(message: "This meeting is locked. Waiting for the host to let you in."))
        #expect(presenter.lobbyStatus?.mode == .waiting)
        #expect(presenter.lobbyStatus?.waitingKind == .locked)
        presenter.apply(waiting(message: "This meeting is locked. Waiting for the host to let you in.", offline: true))
        #expect(presenter.lobbyStatus?.waitingKind == .offline)

        presenter.apply(waiting(message: "This meeting is locked. Waiting for the host to let you in."))
        #expect(presenter.lobbyStatus?.waitingKind == .locked)
        presenter.apply(waiting(restart: "Conclave is updating. Hang on for a moment."))
        #expect(presenter.lobbyStatus?.waitingKind == .serverRestarting)
        #expect(presenter.lobbyStatus?.waitingText == "Conclave is updating. Hang on for a moment.")

        presenter.apply(waiting(restart: "sfu draining, websocket closing"))
        #expect(presenter.lobbyStatus?.waitingKind == .serverRestarting)
        #expect(presenter.lobbyStatus?.waitingText == "")
    }

    @Test func initialFailuresMapToTheirClasses() {
        #expect(EntryFailurePolicy.issue(category: "offline", diagnosticCode: "url.offline", serverText: "") == .failedNetwork)
        #expect(EntryFailurePolicy.issue(category: "serverUnreachable", diagnosticCode: "url.unreachable", serverText: "") == .failedNetwork)
        #expect(EntryFailurePolicy.issue(category: "timedOut", diagnosticCode: "socket.timeout", serverText: "") == .failedNetwork)
        #expect(EntryFailurePolicy.issue(category: "serverUnreachable", diagnosticCode: "media.transport", serverText: "") == .failedMedia)
        #expect(EntryFailurePolicy.issue(category: "deviceInUse", diagnosticCode: "android.deviceInUse", serverText: "") == .failedMedia)
        #expect(EntryFailurePolicy.issue(category: "serverBusy", diagnosticCode: "http.503", serverText: "Server busy") == .failedServerBusy)
        #expect(EntryFailurePolicy.issue(category: "serverRestarting", diagnosticCode: "http.503", serverText: "") == .failedServerBusy)
        #expect(EntryFailurePolicy.issue(category: "rejectedByServer", diagnosticCode: "message.rejected", serverText: "Webinar is full.") == .failedServerText)
        #expect(EntryFailurePolicy.issue(category: "", diagnosticCode: "", serverText: "xhr poll error") == .failedUnknown)
        #expect(EntryFailurePolicy.issue(category: "", diagnosticCode: "", serverText: "") == .failedUnknown)
        #expect(EntryFailurePolicy.isFailure(.failedMedia) && !EntryFailurePolicy.isFailure(.offline))
    }

    @Test func theFailedLobbyCarriesTheClassAndKeepsTheInput() {
        let presenter = presenter()
        presenter.apply(entering())
        let routeId = presenter.path.last?.id ?? -1
        presenter.apply(PremeetingInputs.make(callSession: 1, phase: .outcome, outcomeId: 3, outcomeKind: .joinFailed,
                                              roomLabel: Self.room, currentRoomId: Self.room,
                                              joinFailureCategory: MeetingErrorCategory.serverUnreachable.rawValue,
                                              joinFailureCode: "url.unreachable"))
        #expect(presenter.outcome == nil, "an initial failure stays in the lobby (S10 R6 b)")
        #expect(presenter.lobbyStatus?.mode == .failed)
        #expect(presenter.lobbyStatus?.issue == .failedNetwork)
        #expect(presenter.lobbyStatus?.issueServerText == "")
        #expect(presenter.path.last?.id == routeId, "8 l4: the same lobby (and its input) stays")
    }

    @Test func offlineWhileConnectingKeepsThePendingPrimaryAndShowsTheRow() {
        let presenter = presenter()
        presenter.apply(entering(offline: true))
        #expect(presenter.lobbyStatus?.mode == .connecting)
        #expect(presenter.lobbyStatus?.issue == .offline)
        #expect(presenter.lobbyStatus?.isPrimaryEnabled == false)
        presenter.apply(entering(offline: false))
        #expect(presenter.lobbyStatus?.issue == LobbyIssue.none)
    }

    @Test func theSlowNoticeAppearsOnceForAVisibleConnectingLobby() async {
        let presenter = presenter()
        presenter.apply(entering())
        #expect(presenter.liveTaskCount == 0, "no timer for a lobby nobody sees")
        let routeId = presenter.path.last?.id ?? -1
        let tokens = presenter.feedbackState.token.sequence
        presenter.lobbyDidAppear(routeId: routeId)
        #expect(presenter.liveTaskCount == 1)
        #expect(await ent5Settle { presenter.lobbyStatus?.showsSlowNotice == true })
        #expect(presenter.feedbackState.token.kind == .stillConnecting)
        #expect(presenter.feedbackState.token.sequence == tokens + 1, "stillConnecting once per attempt")
        #expect(presenter.liveTaskCount == 0)
        try? await Task.sleep(nanoseconds: 30_000_000)
        #expect(presenter.feedbackState.token.sequence == tokens + 1)

        presenter.apply(waiting())
        #expect(presenter.lobbyStatus?.showsSlowNotice == false)
        presenter.apply(entering())
        #expect(presenter.lobbyStatus?.showsSlowNotice == false)
        #expect(presenter.liveTaskCount == 1)
        presenter.lobbyDidDisappear(routeId: routeId)
        #expect(presenter.liveTaskCount == 0)
        #expect(SlowNoticeExpectations.policyRows())
    }

    @Test func cancelAndTheCallEndTheSlowNoticeTask() {
        let presenter = presenter()
        presenter.slowNoticeDelayMillis = 60_000
        presenter.apply(entering())
        presenter.lobbyDidAppear(routeId: presenter.path.last?.id ?? -1)
        #expect(presenter.liveTaskCount == 1)
        presenter.apply(PremeetingInputs.make(callSession: 1, phase: .inCall, roomLabel: Self.room,
                                              hasBeenAdmittedThisSession: true, currentRoomId: Self.room))
        #expect(presenter.liveTaskCount == 0, "S1C 3.3 TEAR: no task outlives the entry")
        let other = self.presenter()
        other.slowNoticeDelayMillis = 60_000
        other.apply(entering())
        other.lobbyDidAppear(routeId: other.path.last?.id ?? -1)
        other.apply(PremeetingInputs.make(callSession: 1, phase: .home, roomLabel: Self.room, currentRoomId: Self.room))
        #expect(other.liveTaskCount == 0, "Cancel returns to editing with no timer")
        #expect(other.lobbyStatus?.mode == .editing)
    }

    @Test func stopAskingIsAConfirmationOnlyWhileWaiting() {
        let recorder = Recorder()
        let presenter = presenter(recorder: recorder)
        presenter.apply(entering())
        presenter.requestStopAsking()
        #expect(!presenter.isStopAskingPresented, "connecting: Back cancels at once, no dialog")
        presenter.apply(waiting())
        presenter.requestStopAsking()
        #expect(presenter.isStopAskingPresented)
        presenter.keepWaiting()
        #expect(!presenter.isStopAskingPresented)
        #expect(recorder.commands.isEmpty, "Keep waiting, Back or the scrim never reach the core")
        presenter.requestStopAsking()
        presenter.stopAsking()
        #expect(recorder.commands == [.leave])
        #expect(!presenter.isStopAskingPresented)

        presenter.requestStopAsking()
        presenter.apply(entering())
        #expect(!presenter.isStopAskingPresented)
        #expect(recorder.commands == [.leave])
    }

    @Test func a503WithRetryAfterRetriesOnceInsideTheAttempt() async throws {
        let transport = ENT5JoinTransport(answers: [.status(503, retryAfter: 2), .success])
        let info = try await transport.run()
        #expect(info?.token == "t")
        #expect(transport.fetches == 2, "8 l7b: exactly two POST /api/sfu/join")
        #expect(transport.waits == [2], "the second after 2 s")
        #expect(transport.scheduled == [2])
    }

    @Test func aSecond503ReachesTheFailedBlock() async throws {
        let transport = ENT5JoinTransport(answers: [.status(503, retryAfter: 5), .status(503, retryAfter: 5)])
        var caught: Error? = nil
        do {
            _ = try await transport.run()
        } catch {
            caught = error
        }
        #expect(transport.fetches == 2)
        let classified = MeetingErrorClassifier.classify(try #require(caught), context: .join)
        #expect(classified.category == .serverBusy)
        #expect(EntryFailurePolicy.issue(category: classified.category.rawValue, diagnosticCode: classified.diagnosticCode,
                                         serverText: classified.serverText) == .failedServerBusy)
    }

    @Test func retryAfterIsCappedAndOnlyBusyAnswersRetry() async {
        let capped = ENT5JoinTransport(answers: [.status(503, retryAfter: 30), .success])
        _ = try? await capped.run()
        #expect(capped.waits == [MeetingJoinRetryPolicy.maxDelaySeconds])
        let notFound = ENT5JoinTransport(answers: [.status(404, retryAfter: 2), .success])
        _ = try? await notFound.run()
        #expect(notFound.fetches == 1 && notFound.waits.isEmpty)
        let noHeader = ENT5JoinTransport(answers: [.status(503, retryAfter: 0), .success])
        _ = try? await noHeader.run()
        #expect(noHeader.fetches == 1 && noHeader.waits.isEmpty)
        let recovery = ENT5JoinTransport(answers: [.status(503, retryAfter: 2), .success])
        _ = try? await recovery.run(allowsRetry: false)
        #expect(recovery.fetches == 1 && recovery.waits.isEmpty, "recovery joins keep their own schedule")
    }

    @Test func aCancelledAttemptNeverFetchesAgain() async throws {
        let transport = ENT5JoinTransport(answers: [.status(503, retryAfter: 2), .success])
        transport.currentAfterWait = false
        let info = try await transport.run()
        #expect(info == nil)
        #expect(transport.fetches == 1)
        #expect(EntryJoinRetry.nanoseconds(forSeconds: 2) == 2_000_000_000)
        #expect(EntryJoinRetry.nanoseconds(forSeconds: -1) == 0)
    }

    @Test func theExpansionRunsOnlyIntoAStageWithACardFrameAndMotion() {
        #expect(EntryTransitionPolicy.style(entersCall: true, expandsIntoCall: true, hasCardFrame: true, prefersCrossFade: false) == .expand)
        #expect(EntryTransitionPolicy.style(entersCall: true, expandsIntoCall: false, hasCardFrame: true, prefersCrossFade: false) == .crossFade,
                "the interim legacy root cross-fades")
        #expect(EntryTransitionPolicy.style(entersCall: true, expandsIntoCall: true, hasCardFrame: false, prefersCrossFade: false) == .crossFade)
        #expect(EntryTransitionPolicy.style(entersCall: true, expandsIntoCall: true, hasCardFrame: true, prefersCrossFade: true) == .crossFade,
                "8 l3: Reduce Motion cross-fades")
        #expect(EntryTransitionPolicy.style(entersCall: false, expandsIntoCall: true, hasCardFrame: true, prefersCrossFade: false) == .crossFade,
                "no reverse expansion when leaving")
        #expect(EntryTransitionPolicy.isUsableCardFrame(recordedRouteId: 3, lobbyRouteId: 3, width: 320, height: 400))
        #expect(!EntryTransitionPolicy.isUsableCardFrame(recordedRouteId: 3, lobbyRouteId: 4, width: 320, height: 400))
        #expect(!EntryTransitionPolicy.isUsableCardFrame(recordedRouteId: 0, lobbyRouteId: 0, width: 320, height: 400))
        #expect(!EntryTransitionPolicy.isUsableCardFrame(recordedRouteId: 3, lobbyRouteId: 3, width: 0, height: 400))
        #expect(abs(EntryTransitionPolicy.iosRevealDelaySeconds - 0.266) < 0.001)
        #expect(EntryTransitionPolicy.revealDurationMillis == 160)
        #expect(EntryTransitionPolicy.androidRevealDelayMillis == 220 && EntryTransitionPolicy.androidPremeetingFadeMillis == 120)
        #expect(EntryPresentation.legacyOverlay.armsLegacyOverlay && !EntryPresentation.native.armsLegacyOverlay)
    }

    @Test func theEntryFixturesReachTheirStates() {
        let expectations: [PremeetingFixtureState: (PremeetingPresenter) -> Bool] = [
            .failedNetwork: { $0.lobbyStatus?.mode == .failed && $0.lobbyStatus?.issue == .failedNetwork },
            .failedServerBusy: { $0.lobbyStatus?.mode == .connecting },
            .retryAfter: { $0.lobbyStatus?.mode == .connecting },
            .recoveringBeforeAdmission: { $0.root.root == .premeeting && $0.root.showsReconnecting && $0.lobbyStatus?.mode == .connecting },
            .waitingLocked: { $0.lobbyStatus?.waitingKind == .locked },
            .waitingNoHost: { $0.lobbyStatus?.waitingKind == .noHost },
            .waitingHostAvailable: { $0.lobbyStatus?.waitingKind == .hostAvailable },
            .waitingReconnecting: { $0.lobbyStatus?.mode == .waiting && $0.lobbyStatus?.waitingKind == .reconnecting },
            .waitingOffline: { $0.lobbyStatus?.waitingKind == .offline },
            .waitingServerRestarting: { $0.lobbyStatus?.waitingKind == .serverRestarting && !($0.lobbyStatus?.waitingText ?? "").isEmpty },
            .waitingToAdmitted: { $0.lobbyStatus?.mode == .waiting },
            .waitingDenied: { $0.lobbyStatus?.mode == .waiting }
        ]
        for (state, check) in expectations {
            let session = PremeetingFixtureSession(state: state)
            session.start()
            defer { session.stop() }
            #expect(check(session.premeeting), "\(state)")
            #expect(session.premeeting.lobbyMedia != nil, "\(state): the card stays with live toggles")
        }
    }

    @Test func theIOSEntryFilesFollowTheSpec() throws {
        let block = try ent5Source("Sources/Conclave/Features/Lobby/EntryStatusBlock+iOS.swift")
        let flatBlock = ent5Flat(block)
        #expect(flatBlock.contains("ConclaveButton(EntryStatusCopy.pendingTitle(status.intent), role: .primary, isEnabled: false, isPending: true, identifier: \"lobby.primary\") {}"))
        #expect(flatBlock.contains("ConclaveButton(ConclaveStrings.text(\"Cancel\"), role: .tonal, identifier: \"lobby.waiting.cancel\") { premeeting.cancelJoin() }"),
                "9 c: no coral action while waiting")
        #expect(block.contains(".accessibilityFocused($isRetryFocused)"), "8 i: Try Again is focused")
        #expect(block.contains("AccessibilityNotification.Announcement(ConclaveStrings.format(\"Joining %@\", label)).post()"))
        #expect(!block.contains("Notify Me When"), "RECONCILE R5: the Notify row stays hidden until SYS-3")
        let transition = try ent5Source("Sources/Conclave/Features/Lobby/EntryTransition+iOS.swift")
        #expect(transition.contains("withAnimation(ConclaveMotion.entryExpand) {"))
        #expect(transition.contains(".fill(HostingTheme.token(DesignTokens.iosInCallStage))"))
        #expect(transition.contains("onGeometryChange(for: CGRect.self)"))
        #expect(!transition.contains("anchorPreference") && !transition.contains("matchedGeometryEffect"),
                "S10 8 c: a non-observed store, never an anchor preference")
        #expect(!transition.contains(".onAppear"), "appearance callbacks never write the transition state (AGENTS)")
        let root = ent5Flat(try ent5Source("Sources/Conclave/Features/Home/PremeetingRoot+iOS.swift"))
        #expect(root.contains("if premeeting.root.root == .call { interimCall() .entryExpansion(start: interimStart, onCovered: onCovered)"))
        #expect(root.contains(".animation(ConclaveMotion.crossFade, value: premeeting.root.root)"))
        #expect(root.contains("if showsPremeeting { PremeetingRoot(shell: shell, premeeting: premeeting) .environment(\\.entryTransitionAnchors, anchors) }"))
        #expect(root.contains("NativeAppRoot(shell: session.shell, premeeting: session.premeeting, usesNativeCallRoot: false, interimIsStage: true, anchors: anchors)"))
        let card = try ent5Source("Sources/Conclave/Features/Lobby/LobbyPreviewCard+iOS.swift")
        #expect(card.contains(".entryTransitionAnchor(routeId: media.routeId)"))
        let lobby = try ent5Source("Sources/Conclave/Features/Lobby/LobbyView+iOS.swift")

        #expect(lobby.components(separatedBy: "EntryStatusBlock(premeeting: premeeting, routeId: routeId)").count - 1 == 1)
        #expect(!lobby.contains("LobbyEntryStatusBlock"))
    }

    @Test func theAndroidEntryFilesFollowTheSpec() throws {
        let host = try ent5Source("Sources/Conclave/Skip/ui/home/PremeetingHost.kt")
        let flatHost = ent5Flat(host)
        #expect(host.components(separatedBy: "ConclaveSystemBars(").count - 1 == 1)
        #expect(flatHost.contains("if (!callComposed) { ConclaveSystemBars("), "one bar writer: ours waits for the call content to leave")
        #expect(flatHost.contains("rootTransition.AnimatedContent("))
        #expect(flatHost.contains("EntryExpansionLayer(start = start, hostOrigin = anchors.hostOrigin"))
        #expect(flatHost.contains("if (status.mode == LobbyMode.waiting) { premeeting.requestStopAsking() return }"))
        #expect(flatHost.contains("PremeetingHost(session.shell, session.premeeting, usesNativeCallRoot = false, interimIsStage = true)"))
        let transition = try ent5Source("Sources/Conclave/Skip/ui/lobby/EntryTransition.kt")
        #expect(!transition.contains("sharedBounds") && !transition.contains("sharedElement"),
                "D1: the card's AndroidView is never drawn in a shared-transition overlay")
        #expect(transition.contains("Modifier.fillMaxSize().drawBehind {"))
        #expect(transition.contains("Color(DesignTokens.androidExtendedStage)"))
        #expect(transition.contains("progress.animateTo(1f, ConclaveMotion.spatialDefault())"))
        let block = try ent5Source("Sources/Conclave/Skip/ui/lobby/EntryStatusBlock.kt")
        #expect(block.contains("BackHandler(enabled = busy) { onBack() }"))
        #expect(block.contains("onDismissRequest = { premeeting.keepWaiting() },"))
        #expect(block.contains("liveRegion = LiveRegionMode.Polite"))
        let lobby = try ent5Source("Sources/Conclave/Skip/ui/lobby/LobbyScreen.kt")
        #expect(lobby.contains("LobbyBusyBackHandler(premeeting, routeId, onBack)"))
        #expect(lobby.contains("modifier = modifier.entryTransitionAnchor(anchors, routeId),"))
        #expect(lobby.contains("EntryStatusBlock(premeeting, status)"))
    }

    @Test func newEntryFilesStayFlatDashFreeLiteralFreeAndOffTheCore() throws {
        let swiftFiles = ["Sources/Conclave/Features/Lobby/EntryStatusPolicy.swift", "Sources/Conclave/Features/Lobby/EntryJoinRetry.swift",
                          "Sources/Conclave/Features/Lobby/EntryStatusBlock+iOS.swift", "Sources/Conclave/Features/Lobby/EntryTransition+iOS.swift"]
        let kotlinFiles = ["Sources/Conclave/Skip/ui/lobby/EntryStatusBlock.kt", "Sources/Conclave/Skip/ui/lobby/EntryTransition.kt"]
        for file in swiftFiles + kotlinFiles {
            let text = try ent5Source(file)
            #expect(!text.contains("\u{2013}") && !text.contains("\u{2014}"), "\(file) has an en or em dash")
            #expect(!text.lowercased().contains("gradient"), "\(file)")
            #expect(ent5Matches(#"(UIColor|Color)\(\s*(red:|\.sRGB|0x|hue:|white:)"#, in: text).isEmpty, "\(file) builds a color from a literal")
            #expect(!text.contains("Color.white") && !text.contains("Color.black"), "\(file)")
            #expect(!text.contains("@Stable") && !text.contains("@Immutable"), "\(file)")
            #expect(!text.contains("MeetingState"), "\(file) reads MeetingState")
            #expect(!text.contains("beginMeetingEntry"), "\(file): the native entry never arms the legacy overlay")
        }
        for file in swiftFiles where file.hasSuffix("+iOS.swift") {
            let text = try ent5Source(file)
            #expect(text.hasPrefix("#if os(iOS) && !SKIP\n"), "\(file)")
            for pattern in ["glassEffect", "GlassEffectContainer", "glassProminent", "Material", "acmGlass", ".preferredColorScheme("] {
                #expect(!text.contains(pattern), "\(file) uses \(pattern)")
            }
            #expect(!text.contains("Image(systemName: \""), "\(file) names a raw symbol")
            #expect(ent5Matches(#"(?:Text|Button|Label|navigationTitle|Section|LabeledContent)\(\s*""#, in: text).isEmpty, "\(file) has a literal label")
        }
        for file in kotlinFiles {
            let text = try ent5Source(file)
            #expect(ent5Matches(#"Text\(\s*""#, in: text).isEmpty, "\(file) has a literal Text")
            #expect(!text.contains("performHapticFeedback") && !text.contains("LocalHapticFeedback") && !text.contains("Vibrator"), "\(file)")
            #expect(!text.contains("fontFamily") && !text.contains("enableEdgeToEdge") && !text.contains("ConclaveSystemBars("), "\(file)")
        }
        for file in swiftFiles where !file.hasSuffix("+iOS.swift") {
            let text = try ent5Source(file)
            #expect(!text.contains("import SwiftUI") && !text.contains("import UIKit"), "\(file)")
            #expect(ent5Matches(#"\.(?:map|compactMap|flatMap)\(\s*[A-Za-z_][A-Za-z0-9_.]*\s*\)"#, in: text).isEmpty, "\(file)")
            #expect(!text.contains(".isLetter"), "\(file)")
        }
    }

    @Test func theViewModelHooksAreInPlace() throws {
        let viewModel = ent5Flat(try ent5Source("Sources/Conclave/Features/Meeting/MeetingViewModel.swift"))
        #expect(viewModel.contains("var entryPresentation: EntryPresentation = EntryPresentation.legacyOverlay"))
        #expect(viewModel.contains("guard entryPresentation.armsLegacyOverlay else { return } PerformanceDiagnostics.event(\"meeting_entry_begin\""))
        #expect(viewModel.contains("guard entryPresentation.armsLegacyOverlay, state.isEnteringMeeting else { return }"))
        #expect(viewModel.contains("let fetchedJoinInfo = try await EntryJoinRetry.fetchJoinInfo( allowsRetry: !isRecoveryJoin,"))
        #expect(viewModel.contains("guard let joinInfo = fetchedJoinInfo, self.activeJoinAttemptId == joinAttemptId else {"))
        let wiring = ent5Flat(try ent5Source("Sources/Conclave/Features/Home/PremeetingAppWiring.swift"))
        #expect(wiring.contains("viewModel.entryPresentation = EntryPresentation.native"))
    }

    @Test func entryStringsAreInBothCatalogs() throws {
        let catalog = try #require(try JSONSerialization.jsonObject(with: Data(ent5Source("Sources/Conclave/Resources/Localizable.xcstrings").utf8)) as? [String: Any])
        let strings = try #require(catalog["strings"] as? [String: Any])
        for key in ["Joining\u{2026}", "Starting\u{2026}", "Still connecting. Check your connection.",
                    "You\u{2019}re offline. Waiting for a connection.", "Joining %@", "Couldn\u{2019}t join",
                    "You\u{2019}ll join as soon as someone lets you in.", "You\u{2019}re in. Joining now.",
                    "The meeting server is restarting. Try again in a moment."] {
            #expect(strings[key] != nil, "missing iOS key \(key)")
        }
        let xml = try ent5Source("Android/app/src/main/res/values/strings.xml")
        for name in ["pm_joining", "pm_starting", "pm_still_connecting", "pm_offline_waiting", "pm_fail_network", "pm_fail_media",
                     "pm_fail_server_busy", "pm_fail_unknown", "pm_announce_joining", "pm_announce_couldnt_join", "pm_wait_standard",
                     "pm_wait_locked", "pm_wait_no_host", "pm_wait_host_available", "pm_wait_reconnecting", "pm_wait_offline",
                     "pm_wait_server_restart", "pm_admitted", "pm_stop_asking_title", "pm_stop_asking_body",
                     "pm_stop_asking_confirm", "pm_keep_waiting"] {
            #expect(xml.contains("<string name=\"\(name)\""), "missing \(name)")
        }
    }
}

private enum SlowNoticeExpectations {
    static func policyRows() -> Bool {
        EntrySlowNoticePolicy.runs(mode: .connecting, isLobbyVisible: true, alreadyShown: false)
            && !EntrySlowNoticePolicy.runs(mode: .connecting, isLobbyVisible: false, alreadyShown: false)
            && !EntrySlowNoticePolicy.runs(mode: .connecting, isLobbyVisible: true, alreadyShown: true)
            && !EntrySlowNoticePolicy.runs(mode: .waiting, isLobbyVisible: true, alreadyShown: false)
            && EntrySlowNoticePolicy.delayMillis == 8000
    }
}

@MainActor
private final class ENT5JoinTransport {
    enum Answer {
        case status(Int, retryAfter: Int)
        case success
    }

    private var answers: [Answer]
    var fetches = 0
    var waits: [Int] = []
    var scheduled: [Int] = []
    var currentAfterWait = true

    init(answers: [Answer]) {
        self.answers = answers
    }

    func run(allowsRetry: Bool = true) async throws -> SfuJoinInfo? {
        try await EntryJoinRetry.fetchJoinInfo(
            allowsRetry: allowsRetry,
            isNetworkOffline: { false },
            isCurrent: { self.currentAfterWait },
            wait: { seconds in self.waits.append(seconds) },
            onRetryScheduled: { seconds in self.scheduled.append(seconds) },
            fetch: { try self.next() }
        )
    }

    private func next() throws -> SfuJoinInfo {
        fetches += 1
        let answer = answers.isEmpty ? Answer.success : answers.removeFirst()
        switch answer {
        case .status(let code, let retryAfter):
            throw MeetingHTTPStatusError(statusCode: code, retryAfterSeconds: retryAfter, message: "")
        case .success:
            return SfuJoinInfo(token: "t", sfuUrl: "wss://sfu.example", iceServers: nil)
        }
    }
}

@MainActor
private func ent5Settle(_ condition: () -> Bool) async -> Bool {
    for _ in 0..<1000 {
        if condition() { return true }
        try? await Task.sleep(nanoseconds: 2_000_000)
    }
    return condition()
}

private func ent5Source(_ packageRelativePath: String) throws -> String {
    let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
    return try String(contentsOf: root.appendingPathComponent(packageRelativePath), encoding: .utf8)
}

private func ent5Flat(_ text: String) -> String {
    text.split(whereSeparator: { $0.isWhitespace }).joined(separator: " ")
}

private func ent5Matches(_ pattern: String, in text: String) -> [String] {
    guard let regex = try? NSRegularExpression(pattern: pattern) else { return [] }
    let range = NSRange(text.startIndex..<text.endIndex, in: text)
    return regex.matches(in: text, range: range).compactMap { match in
        Range(match.range, in: text).map { String(text[$0]) }
    }
}

#if os(macOS)

@MainActor
@Suite(.serialized)
struct ENT5EntryCoreDeltaTests {
    private func viewModel() -> MeetingViewModel {
        let viewModel = MeetingViewModel()
        viewModel.state = MeetingState(userId: "local@example.com#local-session", sessionId: "local-session")
        return viewModel
    }

    @Test func theNativeRouteNeverArmsTheLegacyEntryOverlay() {
        let native = viewModel()
        native.entryPresentation = EntryPresentation.native
        native.beginMeetingEntry(action: .join)
        #expect(!native.state.isEnteringMeeting, "8 l7: isEnteringMeeting stays false on the native route")
        #expect(!native.isMeetingEntrySafetyTaskArmed, "no 12 s safety task")
        let legacy = viewModel()
        legacy.beginMeetingEntry(action: .join)
        #expect(legacy.state.isEnteringMeeting, "the legacy route keeps its overlay")
        #expect(legacy.isMeetingEntrySafetyTaskArmed)
        legacy.clearMeetingEntry()
        #expect(!legacy.isMeetingEntrySafetyTaskArmed)
    }
}
#endif
#endif
