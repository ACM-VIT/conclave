#if !SKIP
import Foundation
import Testing
@testable import Conclave

@MainActor
struct ENT6OutcomeTests {
    private static let room = "lily-zoro-iris"
    private static let now: Double = 1793102400000.0

    private final class Recorder {
        var commands: [PremeetingCommand] = []
    }

    private func presenter(recorder: Recorder? = nil) -> PremeetingPresenter {
        let presenter = PremeetingPresenter()
        presenter.nowMillis = { Self.now }
        presenter.slowNoticeDelayMillis = 60_000
        if let recorder {
            presenter.onCommand = { command in recorder.commands.append(command) }
        }
        return presenter
    }

    private func inCall(rejoin: String = "") -> PremeetingInputs {
        PremeetingInputs.make(callSession: 1, phase: .inCall, roomLabel: Self.room, hasBeenAdmittedThisSession: true,
                              currentRoomId: Self.room, rejoinRoomId: rejoin)
    }

    private func outcome(_ kind: MeetingTerminalOutcomeKind, id: Int = 7, origin: MeetingEntryOrigin = .initial,
                         rejoin: String = "", serverText: String = "", category: String = "") -> PremeetingInputs {
        PremeetingInputs.make(callSession: 1, phase: .outcome, outcomeId: id, outcomeKind: kind, outcomeServerText: serverText,
                              roomLabel: Self.room, hasBeenAdmittedThisSession: true, entryOrigin: origin,
                              currentRoomId: Self.room, rejoinRoomId: rejoin, joinFailureCategory: category)
    }

    @Test func theRejoinContextFollowsTheC3Table() {
        for kind in [MeetingTerminalOutcomeKind.connectionLost, .serverDisconnected] {
            #expect(RejoinContextPolicy.decision(kind: kind, entryOrigin: .initial, hasBeenAdmittedThisSession: false) == .capture)
        }
        #expect(RejoinContextPolicy.decision(kind: .left, entryOrigin: .initial, hasBeenAdmittedThisSession: true) == .capture)
        #expect(RejoinContextPolicy.decision(kind: .left, entryOrigin: .initial, hasBeenAdmittedThisSession: false) == .keep,
                "a cancelled join never replaces an earlier call's context")
        #expect(RejoinContextPolicy.decision(kind: .joinFailed, entryOrigin: .recovery, hasBeenAdmittedThisSession: true) == .capture)
        #expect(RejoinContextPolicy.decision(kind: .joinFailed, entryOrigin: .initial, hasBeenAdmittedThisSession: false) == .keep)
        for kind in [MeetingTerminalOutcomeKind.removed, .denied, .endedByHost, .endedByYou, .roomClosed] {
            #expect(RejoinContextPolicy.decision(kind: kind, entryOrigin: .recovery, hasBeenAdmittedThisSession: true) == .clear, "\(kind)")
        }
        #expect(RejoinContextPolicy.matches(rejoinRoomId: " Lily-Zoro-Iris ", roomId: "lily-zoro-iris"))
        #expect(!RejoinContextPolicy.matches(rejoinRoomId: "", roomId: ""))
        #expect(!RejoinContextPolicy.matches(rejoinRoomId: "lily-zoro-iris", roomId: "rose-sora-luffy"))
    }

    @Test func theOutcomeModelOffersRejoinOnlyWithAContext() {
        let lost = OutcomeModelPolicy.model(id: 1, variant: .connectionLost, hasRejoinContext: true, serverText: "", failure: .none)
        #expect(lost.primary == .rejoin && lost.secondary == .backHome)
        let lostBare = OutcomeModelPolicy.model(id: 1, variant: .connectionLost, hasRejoinContext: false, serverText: "", failure: .none)
        #expect(lostBare.primary == .backHome && lostBare.secondary == OutcomeAction.none, "one coral: Back to Home alone")
        let disconnected = OutcomeModelPolicy.model(id: 2, variant: .serverDisconnected, hasRejoinContext: true, serverText: "", failure: .none)
        #expect(disconnected.primary == .rejoin && disconnected.secondary == .backHome)
        let failed = OutcomeModelPolicy.model(id: 3, variant: .rejoinFailed, hasRejoinContext: true, serverText: "", failure: .failedNetwork)
        #expect(failed.primary == .tryAgain && failed.secondary == .backHome && failed.failure == .failedNetwork)
        for variant in [OutcomeVariant.removed, .denied] {
            let model = OutcomeModelPolicy.model(id: 4, variant: variant, hasRejoinContext: true, serverText: "", failure: .none)
            #expect(model.primary == .backHome && model.secondary == OutcomeAction.none, "\(variant)")
        }
        #expect(OutcomeModelPolicy.rejoins(.rejoin) && OutcomeModelPolicy.rejoins(.tryAgain) && !OutcomeModelPolicy.rejoins(.backHome))
    }

    @Test func theSecondParagraphIsOnlyAHostReasonOrACleanServerSentence() {
        #expect(OutcomeModelPolicy.serverDetail(variant: .removed, serverText: "Please rejoin from a laptop.", failure: .none)
                == "Please rejoin from a laptop.")
        #expect(OutcomeModelPolicy.serverDetail(variant: .removed, serverText: OutcomeModelPolicy.removedFallbackText, failure: .none) == "",
                "the legacy fallback is not a host reason")
        #expect(OutcomeModelPolicy.serverDetail(variant: .denied, serverText: "The host has denied your request to join.", failure: .none) == "")
        #expect(OutcomeModelPolicy.serverDetail(variant: .connectionLost, serverText: "Couldn't reconnect", failure: .none) == "")
        #expect(OutcomeModelPolicy.serverDetail(variant: .rejoinFailed, serverText: "Webinar is full.", failure: .failedServerText) == "Webinar is full.")
        #expect(OutcomeModelPolicy.serverDetail(variant: .rejoinFailed, serverText: "Webinar is full.", failure: .failedNetwork) == "")
        #expect(OutcomeModelPolicy.serverDetail(variant: .removed, serverText: "xhr poll error", failure: .none) == "", "noise is never shown")
    }

    @Test func outcomesMapToTheScreenOrAHomeNotice() {
        for kind in [MeetingTerminalOutcomeKind.denied, .removed, .connectionLost, .serverDisconnected] {
            let presenter = presenter()
            presenter.apply(inCall())
            presenter.apply(outcome(kind))
            #expect(presenter.root.showsOutcome, "\(kind)")
            #expect(presenter.outcome != nil && presenter.path.isEmpty, "\(kind)")
        }

        let rejoinFailed = presenter()
        rejoinFailed.apply(inCall())
        rejoinFailed.apply(outcome(.joinFailed, origin: .recovery))
        #expect(rejoinFailed.outcome?.variant == .rejoinFailed)
        for kind in [MeetingTerminalOutcomeKind.left, .endedByYou, .endedByHost, .roomClosed] {
            let presenter = presenter()
            presenter.apply(inCall())
            presenter.apply(PremeetingInputs.make(callSession: 1, phase: .home, notice: PremeetingRootPolicyHelpers.notice(for: kind),
                                                  outcomeId: 5, outcomeKind: kind, roomLabel: Self.room,
                                                  hasBeenAdmittedThisSession: true, currentRoomId: Self.room))
            #expect(presenter.outcome == nil && !presenter.root.showsOutcome, "\(kind): no outcome screen")
        }
        let closed = presenter()
        closed.apply(inCall())
        closed.apply(PremeetingInputs.make(callSession: 1, phase: .home, notice: .roomClosed, outcomeId: 6, outcomeKind: .roomClosed,
                                           roomLabel: Self.room, hasBeenAdmittedThisSession: true, currentRoomId: Self.room))
        #expect(closed.home.noticeKind == .roomClosed)
    }

    @Test func rejoinOnTheOutcomeScreenOpensTheRejoinLobbyAndAsksOnce() {
        let recorder = Recorder()
        let presenter = presenter(recorder: recorder)
        presenter.apply(inCall(rejoin: Self.room))
        presenter.apply(outcome(.connectionLost, rejoin: Self.room))
        #expect(presenter.outcome?.primary == .rejoin)
        presenter.performOutcomeAction(.rejoin)
        #expect(recorder.commands == [.rejoinLastMeeting], "exactly one rejoin, never a dismiss")
        #expect(presenter.rejoinCommandCount == 1)
        #expect(presenter.outcome == nil)
        #expect(presenter.path.count == 1 && presenter.path.first?.kind == .lobby)
        #expect(presenter.lobbyStatus?.intent == .rejoin)

        let routeId = presenter.path.first?.id
        presenter.apply(PremeetingInputs.make(callSession: 2, phase: .entering, roomLabel: Self.room, currentRoomId: Self.room,
                                              rejoinRoomId: Self.room))
        #expect(presenter.path.first?.id == routeId)
        #expect(presenter.lobbyStatus?.mode == .connecting)

        let other = self.presenter(recorder: Recorder())
        other.apply(inCall(rejoin: Self.room))
        other.apply(outcome(.serverDisconnected, id: 9, rejoin: Self.room))
        other.performOutcomeAction(.rejoin)
        other.apply(outcome(.serverDisconnected, id: 9, rejoin: Self.room).withIdentity(isSignedIn: false, accountName: "x", accountSeed: ""))
        #expect(other.outcome == nil)
    }

    @Test func tryAgainAfterAFailedRejoinAsksTheContextAgain() {
        let recorder = Recorder()
        let presenter = presenter(recorder: recorder)
        presenter.apply(inCall(rejoin: Self.room))
        presenter.apply(outcome(.joinFailed, origin: .recovery, rejoin: Self.room, category: MeetingErrorCategory.offline.rawValue))
        #expect(presenter.outcome?.primary == .tryAgain)
        #expect(presenter.outcome?.failure == .failedNetwork)
        presenter.performOutcomeAction(.tryAgain)
        #expect(recorder.commands == [.rejoinLastMeeting])

        presenter.apply(PremeetingInputs.make(callSession: 2, phase: .entering, roomLabel: Self.room, currentRoomId: Self.room,
                                              rejoinRoomId: Self.room))
        presenter.apply(PremeetingInputs.make(callSession: 2, phase: .outcome, outcomeId: 11, outcomeKind: .joinFailed,
                                              roomLabel: Self.room, currentRoomId: Self.room, rejoinRoomId: Self.room,
                                              joinFailureCategory: MeetingErrorCategory.serverUnreachable.rawValue))
        #expect(presenter.lobbyStatus?.mode == .failed && presenter.lobbyStatus?.intent == .rejoin)
        presenter.retryJoin()
        #expect(recorder.commands == [.rejoinLastMeeting, .rejoinLastMeeting])
    }

    @Test func withoutAContextTheActionsFallBackToHome() {
        let recorder = Recorder()
        let presenter = presenter(recorder: recorder)
        presenter.apply(inCall())
        presenter.apply(outcome(.connectionLost))
        #expect(presenter.outcome?.primary == .backHome)
        presenter.performOutcomeAction(.rejoin)
        #expect(recorder.commands == [.dismissOutcome])
        #expect(presenter.rejoinCommandCount == 0)
    }

    @Test func theRejoinCardConnectsWithTheContextAndOpensEditableWithout() {
        let recorder = Recorder()
        let presenter = presenter(recorder: recorder)
        presenter.bootstrap(user: nil, recents: PremeetingFixtureScript.recents(for: .home, nowMillis: Self.now))
        #expect(presenter.home.rejoin != nil)

        presenter.rejoin()
        #expect(recorder.commands.isEmpty)
        #expect(presenter.lobbyStatus?.intent == .rejoin && presenter.lobbyStatus?.mode == .editing)
        presenter.setPath([])

        presenter.apply(PremeetingInputs.make(rejoinRoomId: "rose-sora-luffy"))
        presenter.rejoin()
        #expect(recorder.commands == [.rejoinLastMeeting])
        #expect(presenter.path.last?.roomId == "rose-sora-luffy")

        presenter.setPath([])
        presenter.apply(PremeetingInputs.make(rejoinRoomId: "maple-goku-tulip"))
        presenter.rejoin()
        #expect(recorder.commands == [.rejoinLastMeeting])
    }

    @Test func aRejoinLobbyJoinsThroughTheContextWithoutANameGate() {
        let recorder = Recorder()
        let hooks = LobbyCoreHooks()
        var joins = 0
        hooks.join = { _ in joins += 1 }
        let presenter = presenter(recorder: recorder)
        presenter.lobbyHooks = hooks
        presenter.bootstrap(user: nil, recents: PremeetingFixtureScript.recents(for: .home, nowMillis: Self.now))
        presenter.apply(PremeetingInputs.make(rejoinRoomId: "maple-goku-tulip"))
        presenter.rejoin()
        presenter.apply(PremeetingInputs.make(rejoinRoomId: "rose-sora-luffy"))
        #expect(presenter.lobbyStatus?.intent == .rejoin)
        #expect(presenter.lobbyStatus?.isPrimaryEnabled == true, "the call's own name joins; no guest name gate")
        presenter.startOrJoin()
        #expect(recorder.commands == [.rejoinLastMeeting])
        #expect(joins == 0, "never the record's bare room without invite codes")
    }

    @Test func aRejoinBehindASheetConnectsAfterTheSheetIsGone() {
        let recorder = Recorder()
        let presenter = presenter(recorder: recorder)
        presenter.bootstrap(user: nil, recents: PremeetingFixtureScript.recents(for: .home, nowMillis: Self.now))
        presenter.apply(PremeetingInputs.make(rejoinRoomId: "rose-sora-luffy"))
        presenter.openJoinSheet()
        presenter.rejoin()
        #expect(recorder.commands.isEmpty, "never while the sheet is still up")
        presenter.joinSheetDidDismiss()
        #expect(recorder.commands == [.rejoinLastMeeting])
        #expect(presenter.path.last?.roomId == "rose-sora-luffy")
    }

    @Test func theOutcomeFixturesReachTheirRows() {
        let expectations: [PremeetingFixtureState: (PremeetingPresenter) -> Bool] = [
            .outcomeDenied: { $0.outcome?.variant == .denied && $0.outcome?.primary == .backHome },
            .outcomeConnectionLost: { $0.outcome?.variant == .connectionLost && $0.outcome?.primary == .rejoin },
            .outcomeServerDisconnected: { $0.outcome?.variant == .serverDisconnected && $0.outcome?.secondary == .backHome },
            .outcomeRejoinFailed: { $0.outcome?.variant == .rejoinFailed && $0.outcome?.primary == .tryAgain },
            .outcomeRemoved: { $0.outcome?.variant == .removed && $0.outcome?.secondary == OutcomeAction.none },
            .noticeRoomClosed: { $0.outcome == nil && $0.home.noticeKind == .roomClosed },
            .homeRejoin: { $0.home.rejoin != nil && $0.currentInputs.rejoinRoomId == PremeetingFixtureScript.roomLabel }
        ]
        for (state, check) in expectations {
            let session = PremeetingFixtureSession(state: state)
            session.start()
            defer { session.stop() }
            #expect(check(session.premeeting), "\(state)")
        }

        let session = PremeetingFixtureSession(state: .homeRejoin)
        session.start()
        defer { session.stop() }
        session.premeeting.rejoin()
        #expect(session.premeeting.lobbyStatus?.mode == .connecting)
        #expect(session.premeeting.lobbyMedia?.micIntentOn == PremeetingFixtureScript.rejoinMicOn)
        #expect(session.premeeting.lobbyMedia?.cameraIntentOn == PremeetingFixtureScript.rejoinCameraOn)
    }

    @Test func theOutcomeViewsFollowTheSpec() throws {
        let ios = try ent6Source("Sources/Conclave/Features/Outcome/OutcomeView+iOS.swift")
        let flat = ent6Flat(ios)
        #expect(ios.hasPrefix("#if os(iOS) && !SKIP\n"))
        #expect(flat.contains("ContentUnavailableView { Label(OutcomeCopy.title(outcome.variant), systemImage: OutcomeCopy.symbol(outcome.variant))"))
        #expect(flat.contains(".toolbar(.hidden, for: .navigationBar)"))
        #expect(flat.contains("ConclaveButton(OutcomeCopy.action(outcome.primary), role: .primary, identifier: \"outcome.primary\")"))
        #expect(flat.contains("ConclaveButton(OutcomeCopy.action(outcome.secondary), role: .text, identifier: \"outcome.secondary\")"))
        #expect(ios.contains("AccessibilityNotification.ScreenChanged().post()"))
        let root = ent6Flat(try ent6Source("Sources/Conclave/Features/Home/PremeetingRoot+iOS.swift"))
        #expect(root.contains("if let outcome = premeeting.outcome { OutcomeView(outcome: outcome, premeeting: premeeting) } else { HomeView(premeeting: premeeting) }"))
        #expect(!root.contains("PremeetingOutcomeStandIn") && !root.contains("PremeetingOutcomeCopy"))
        let android = try ent6Source("Sources/Conclave/Skip/ui/outcome/OutcomeScreen.kt")
        #expect(!android.contains("BackHandler"), "S10 10 d: NavDisplay's pop keeps the predictive preview of Home")
        #expect(android.contains("paneTitle = title"))
        #expect(android.contains("Modifier.semantics { heading() }"))
        #expect(ent6Flat(android).contains("ButtonDefaults.buttonColors(containerColor = scheme.primaryContainer, contentColor = scheme.onPrimaryContainer)"))
        let host = ent6Flat(try ent6Source("Sources/Conclave/Skip/ui/home/PremeetingHost.kt"))
        #expect(host.contains("is PremeetingKey.OutcomeKey -> OutcomeScreen(premeeting)"))
        #expect(!host.contains("OutcomeStandInPage"))
        #expect(host.contains("if (premeeting.outcome != null) { premeeting.performOutcomeAction(OutcomeAction.backHome) return }"))
        let backStack = ent6Flat(try ent6Source("Sources/Conclave/Skip/ui/home/PremeetingBackStack.kt"))
        #expect(backStack.contains("keys.add(PremeetingKey.OutcomeKey(outcome.id))"))
        for file in ["Sources/Conclave/Features/Outcome/OutcomePolicies.swift", "Sources/Conclave/Features/Outcome/OutcomeView+iOS.swift",
                     "Sources/Conclave/Skip/ui/outcome/OutcomeScreen.kt"] {
            let text = try ent6Source(file)
            #expect(!text.contains("\u{2013}") && !text.contains("\u{2014}"), "\(file) has an en or em dash")
            #expect(!text.lowercased().contains("gradient"), "\(file)")
            #expect(!text.contains("MeetingState") && !text.contains("@Stable") && !text.contains("@Immutable"), "\(file)")
            #expect(ent6Matches(#"(?:Text|Button|Label)\(\s*""#, in: text).isEmpty, "\(file) has a literal label")
            #expect(!text.contains("Image(systemName: \""), "\(file)")
        }
        let policies = try ent6Source("Sources/Conclave/Features/Outcome/OutcomePolicies.swift")
        #expect(!policies.contains("import SwiftUI") && !policies.contains("ConclaveStrings"), "10 l7: no user-visible English in the model")
    }

    @Test func removedAndDeniedShowNoBodyAndNeverTheServerDetailAsOne() throws {
        let ios = try ent6Source("Sources/Conclave/Features/Outcome/OutcomeView+iOS.swift")
        let flat = ent6Flat(ios)
        #expect(flat.contains("} description: { if OutcomeCopy.hasBody(outcome.variant) { Text(OutcomeCopy.body(outcome)) } else if outcome.variant == .removed && !outcome.serverDetail.isEmpty { Text(OutcomeCopy.quoted(outcome.serverDetail)) .accessibilityIdentifier(\"outcome.detail\") } } actions: {"),
                "S1b-T7: denied emits no description view; removed emits only the quoted host reason")
        #expect(flat.contains("static func hasBody(_ variant: OutcomeVariant) -> Bool { switch variant { case .removed, .denied: return false case .connectionLost, .serverDisconnected, .rejoinFailed: return true } }"))
        #expect(flat.contains("switch outcome.variant { case .removed, .denied: return \"\" case .connectionLost:"))
        #expect(flat.contains("case .serverDisconnected: return ConclaveStrings.text(\"You can rejoin.\")"))
        let description = try #require(ent6Between(flat, from: "} description: {", to: "} actions: {"))
        #expect(ent6Count("Text(", in: description) == 2 && !description.contains("VStack"), "one line at most, never a blank body line")
        #expect(!description.contains("Text(outcome.serverDetail)"))
        for sentence in ["The host removed you from this meeting.", "Someone in the meeting declined your request to join.",
                         "The meeting server ended your connection."] {
            #expect(!ios.contains(sentence), "S1b-T7 cut: \(sentence)")
        }
        #expect(flat.contains("return EntryStatusCopy.failureBody(outcome.failure)"), "S1b-T8 keeps the issue overload for rejoinFailed")

        let android = try ent6Source("Sources/Conclave/Skip/ui/outcome/OutcomeScreen.kt")
        let kotlin = ent6Flat(android)
        #expect(kotlin.contains("val hasBody = OutcomeUi.hasBody(outcome.variant)"))
        #expect(kotlin.contains("val body = if (!hasBody) \"\" else if (bodyName.isEmpty()) outcome.serverDetail else conclaveString(bodyName)"),
                "an empty body name falls back to the server text only where a body exists (F-15)")
        #expect(kotlin.contains("if (hasBody) { Spacer(Modifier.height(8.dp)) Text(body, style = MaterialTheme.typography.bodyLarge, color = scheme.onSurfaceVariant, textAlign = TextAlign.Center) }"))
        #expect(kotlin.contains("fun hasBody(variant: OutcomeVariant): Boolean = when (variant) { OutcomeVariant.removed, OutcomeVariant.denied -> false OutcomeVariant.connectionLost, OutcomeVariant.serverDisconnected, OutcomeVariant.rejoinFailed -> true }"))
        #expect(kotlin.contains("fun bodyName(outcome: OutcomeModel): String = when (outcome.variant) { OutcomeVariant.removed, OutcomeVariant.denied -> \"\" OutcomeVariant.connectionLost -> \"pm_lost_body\" OutcomeVariant.serverDisconnected -> \"pm_disconnected_body\""))
        #expect(kotlin.contains("val detail = if (outcome.variant == OutcomeVariant.removed && outcome.serverDetail.isNotEmpty()) { OutcomeUi.quoted(outcome.serverDetail) } else { \"\" }"),
                "removed keeps its quoted host reason")
        #expect(kotlin.contains("if (detail.isNotEmpty()) { Spacer(Modifier.height(8.dp)) Text(detail,") && kotlin.contains("Modifier.testTag(\"outcome.detail\")"))
        #expect(ent6Count("Text(body,", in: kotlin) == 1)
        for name in ["pm_removed_body", "pm_denied_body"] {
            #expect(!android.contains(name), "S1b-T7 cut: \(name)")
        }
    }

    @Test func theViewModelKeepsTheRejoinContext() throws {
        let viewModel = ent6Flat(try ent6Source("Sources/Conclave/Features/Meeting/MeetingViewModel.swift"))
        #expect(viewModel.contains("captureRejoinContext(kind, joinContext: joinContext ?? lastJoinContext)"))
        #expect(viewModel.contains("recordTerminalOutcome(outcome, serverText: classification.serverText, joinContext: preservedJoinContext)"))
        #expect(viewModel.contains("case .rejoinLastMeeting: rejoinLastMeeting()"))
        #expect(viewModel.contains("rejoinRoomId: rejoinContext?.roomId ?? \"\","))
        #expect(viewModel.contains("serverRestartText: state.serverRestartNotice ?? \"\","))
        #expect(viewModel.contains("rejoinJoinCount += 1 if let override = rejoinJoinOverride { override(context) return } joinRoom( roomId: context.roomId, displayName: context.displayName, socketDisplayName: context.socketDisplayName, user: context.user, isHost: context.isHost, joinMode: context.joinMode, meetingInviteCode: context.meetingInviteCode, webinarInviteCode: context.webinarInviteCode, clientId: context.clientId, allowRoomCreation: context.allowRoomCreation )"))
    }

    @Test func outcomeStringsAreInBothCatalogs() throws {
        let catalog = try #require(try JSONSerialization.jsonObject(with: Data(ent6Source("Sources/Conclave/Resources/Localizable.xcstrings").utf8)) as? [String: Any])
        let strings = try #require(catalog["strings"] as? [String: Any])
        for key in ["Removed From Meeting", "Request Declined", "Connection Lost", "You Were Disconnected", "Couldn\u{2019}t Rejoin",
                    "Check your connection, then rejoin.", "You can rejoin.",
                    "Rejoin", "Try Again", "Back to Home", "We couldn\u{2019}t reach Conclave. Check your connection and try again."] {
            #expect(strings[key] != nil, "missing iOS key \(key)")
        }
        for key in ["The host removed you from this meeting.", "Someone in the meeting declined your request to join.",
                    "The meeting server ended your connection. You can rejoin."] {
            #expect(strings[key] == nil, "S1b-T7 removed or renamed iOS key \(key)")
        }
        let xml = try ent6Source("Android/app/src/main/res/values/strings.xml")
        for name in ["pm_removed_title", "pm_denied_title", "pm_lost_title", "pm_lost_body",
                     "pm_disconnected_title", "pm_disconnected_body", "pm_couldnt_rejoin", "pm_rejoin", "pm_back_home",
                     "ds_try_again", "pm_fail_network", "pm_fail_unknown"] {
            #expect(xml.contains("<string name=\"\(name)\""), "missing \(name)")
        }
        #expect(xml.contains("<string name=\"pm_disconnected_body\">You can rejoin.</string>"))
        for name in ["pm_removed_body", "pm_denied_body"] {
            #expect(!xml.contains("<string name=\"\(name)\""), "S1b-T7 removed \(name)")
        }
    }

    @Test func theS1bT7CopyCutsReachTheLandingAndSettings() throws {
        let landing = try ent6Source("Sources/Conclave/Features/Join/WebinarLandingView+iOS.swift")
        #expect(landing.contains("Text(ConclaveStrings.text(\"Hang tight.\"))"))
        #expect(!landing.contains("This page updates on its own when the host opens the room."))
        #expect(try ent6Source("Sources/Conclave/Skip/ui/join/WebinarLandingScreen.kt").contains("conclaveString(\"pm_waiting_host_body\")"),
                "Android keeps the name; only its value changes")

        let settingsIOS = ent6Flat(try ent6Source("Sources/Conclave/Features/Meeting/Settings/SettingsPanel+iOS.swift"))
        #expect(settingsIOS.contains("} footer: { if rows.contains(SettingsRowID.messageNotifications) { MessageNotificationsFooter(notifications: SystemNotifications.shared) } }"),
                "the general footer drops the Always Show Controls line and is empty only when General has no Message Notifications row")
        #expect(!settingsIOS.contains("Keeps call controls on screen"))
        let rows = try ent6Source("Sources/Conclave/Skip/ui/settings/SettingsRows.kt")
        #expect(rows.contains("SettingsSwitchItem(conclaveString(SettingsCopy.rowName(row)), general.alwaysShowControls, tag) { settings.setAlwaysShowControls(it) }"),
                "no supporting text, so the stock ListItem gets supportingContent = null")
        for file in ["Sources/Conclave/Skip/ui/settings/SettingsRows.kt", "Sources/Conclave/Skip/ui/copy/SettingsCopy.kt"] {
            #expect(!(try ent6Source(file)).contains("set_always_show_controls_detail"), "\(file)")
        }

        let catalog = try #require(try JSONSerialization.jsonObject(with: Data(ent6Source("Sources/Conclave/Resources/Localizable.xcstrings").utf8)) as? [String: Any])
        let strings = try #require(catalog["strings"] as? [String: Any])
        #expect(strings["Hang tight."] != nil)
        #expect(strings["This page updates on its own when the host opens the room."] == nil)
        #expect(strings["Keeps call controls on screen instead of hiding them after a few seconds."] == nil)
        let xml = try ent6Source("Android/app/src/main/res/values/strings.xml")
        #expect(xml.contains("<string name=\"pm_waiting_host_body\">Hang tight.</string>"))
        #expect(!xml.contains("<string name=\"set_always_show_controls_detail\""))
    }
}

private enum PremeetingRootPolicyHelpers {
    static func notice(for kind: MeetingTerminalOutcomeKind) -> MeetingNoticeKind {
        switch kind {
        case .endedByHost:
            return .endedByHost
        case .roomClosed:
            return .roomClosed
        default:
            return MeetingNoticeKind.none
        }
    }
}

private func ent6Source(_ packageRelativePath: String) throws -> String {
    let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
    return try String(contentsOf: root.appendingPathComponent(packageRelativePath), encoding: .utf8)
}

private func ent6Flat(_ text: String) -> String {
    text.split(whereSeparator: { $0.isWhitespace }).joined(separator: " ")
}

private func ent6Between(_ text: String, from start: String, to end: String) -> String? {
    guard let lower = text.range(of: start), let upper = text.range(of: end, range: lower.upperBound..<text.endIndex) else {
        return nil
    }
    return String(text[lower.upperBound..<upper.lowerBound])
}

private func ent6Count(_ needle: String, in text: String) -> Int {
    text.components(separatedBy: needle).count - 1
}

private func ent6Matches(_ pattern: String, in text: String) -> [String] {
    guard let regex = try? NSRegularExpression(pattern: pattern) else { return [] }
    let range = NSRange(text.startIndex..<text.endIndex, in: text)
    return regex.matches(in: text, range: range).compactMap { match in
        Range(match.range, in: text).map { String(text[$0]) }
    }
}

#if os(macOS)

@MainActor
@Suite(.serialized)
struct ENT6RejoinCoreDeltaTests {
    private func joinedViewModel() -> MeetingViewModel {
        let viewModel = MeetingViewModel()
        viewModel.state = MeetingState(userId: "local@example.com#local-session", sessionId: "local-session")
        viewModel.state.sfuUserId = "local@example.com"
        viewModel.state.roomId = "room-a"
        viewModel.state.connectionState = ConnectionState.joined
        viewModel.lastJoinContext = MeetingViewModel.JoinContext(
            roomId: "room-a",
            displayName: "Avery",
            socketDisplayName: nil,
            isHost: false,
            joinMode: .meeting,
            meetingInviteCode: "invite-123",
            webinarInviteCode: nil,
            clientId: "acme",
            allowRoomCreation: false,
            user: nil
        )
        return viewModel
    }

    @Test func aServerDisconnectKeepsTheTargetAndRejoinUsesItOnce() async {
        let viewModel = joinedViewModel()
        viewModel.state.isMuted = false
        viewModel.state.isCameraOff = true
        var rejoined: [MeetingViewModel.JoinContext] = []
        viewModel.rejoinJoinOverride = { context in rejoined.append(context) }
        viewModel.socketManager.onDisconnected?("io server disconnect")
        #expect(await ent6Settle { viewModel.shell.session.outcome?.kind == .serverDisconnected })
        #expect(viewModel.rejoinContext?.roomId == "room-a")
        #expect(viewModel.makePremeetingInputs().rejoinRoomId == "room-a")
        #expect(viewModel.premeeting.outcome?.primary == .rejoin)

        #expect(await ent6Settle { viewModel.lastJoinContext == nil })
        #expect(viewModel.rejoinContext?.meetingInviteCode == "invite-123")

        viewModel.state.isMuted = true
        viewModel.rejoinLastMeeting()
        #expect(viewModel.rejoinJoinCount == 1)
        #expect(rejoined.count == 1)
        #expect(rejoined.first?.roomId == "room-a")
        #expect(rejoined.first?.meetingInviteCode == "invite-123")
        #expect(rejoined.first?.clientId == "acme")
        #expect(!viewModel.state.isMuted && viewModel.state.isCameraOff)
    }

    @Test func aRemovalLeavesNothingToRejoin() async {

        let viewModel = joinedViewModel()
        viewModel.socketManager.onKicked?(KickedNotification(reason: nil, roomId: "room-a"))
        #expect(await ent6Settle { viewModel.shell.session.outcome?.kind == .removed })
        #expect(viewModel.rejoinContext == nil)
        #expect(viewModel.makePremeetingInputs().rejoinRoomId == "")
        #expect(viewModel.premeeting.outcome?.primary == .backHome)
        var rejoined = 0
        viewModel.rejoinJoinOverride = { _ in rejoined += 1 }
        viewModel.rejoinLastMeeting()
        #expect(rejoined == 0 && viewModel.rejoinJoinCount == 0)
    }

    @Test func theRestartNoticeReachesThePremeetingInputs() {
        let viewModel = MeetingViewModel()
        viewModel.state = MeetingState(userId: "local@example.com#local-session", sessionId: "local-session")
        viewModel.state.serverRestartNotice = "Conclave is updating."
        #expect(viewModel.makePremeetingInputs().serverRestartText == "Conclave is updating.")
    }
}

@MainActor
private func ent6Settle(_ condition: () -> Bool) async -> Bool {
    for _ in 0..<1000 {
        if condition() { return true }
        try? await Task.sleep(nanoseconds: 5_000_000)
    }
    return condition()
}
#endif
#endif
