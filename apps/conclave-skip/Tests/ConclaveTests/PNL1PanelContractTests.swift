#if !SKIP
import Foundation
import Observation
import Testing
@testable import Conclave

/// PNL-1, panel contract v2 (OUT/PLAN-screens.md section 5): destinations and target ids (S20 0.6 SR7, 0.7 SC19,
/// RECONCILE R11), same-panel destination requests (S40 R40-2), the snapshot callback (S30 CC18), the short detent
/// and the accessibility-size input (RECONCILE R9, S60 R6-10), Layout and Effects in call for every invoker, one
/// compact-height sheet rule (RECONCILE R10), the PanelShell path binding (S40 R40-9, S50 R50-2), the InCallPage
/// target signature (RECONCILE R33) and the side-pane local back stack (S40 R40-12). The Kotlin half is
/// T/Skip/PNL1PanelContractBridgeTests.kt.
@MainActor
struct PNL1PanelContractTests {
    private static let phonePortrait = PanelWindow(width: 390, height: 844, horizontalRegular: false, verticalRegular: true)
    private static let padFullScreen = PanelWindow(width: 1180, height: 820, horizontalRegular: true, verticalRegular: true)

    private func request(_ panel: MeetingPanel, _ invoker: PanelInvoker = .call, id: Int = 1) -> PanelRequest {
        PanelRequest(presentationID: id, panel: panel, invoker: invoker)
    }

    // MARK: Destinations and target ids (SR7, R11)

    @Test func destinationIsTheSingleSixteenCaseEnum() {
        let expected = ["none", "peopleWaiting", "peopleRaisedHands", "hostControlsAccess",
                        "chatPrivate", "chatMessage", "chatReply", "chatAskAssistant",
                        "transcriptLive", "transcriptMinutes", "transcriptAsk",
                        "settingsAudio", "settingsVoice",
                        "activitiesVote", "activitiesApp",
                        "qaQuestion"]
        #expect(PanelDestination.allCases.count == 16)
        #expect(PanelDestination.allCases.map { $0.rawValue } == expected)
        for raw in expected {
            #expect(PanelDestination(rawValue: raw)?.rawValue == raw)
        }
    }

    @Test func requestDefaultsToTheRootWithNoTarget() {
        let plain = PanelRequest(presentationID: 3, panel: .chat, invoker: .call)
        #expect(plain.destination == PanelDestination.none && plain.targetId.isEmpty)
        let targeted = PanelRequest(presentationID: 3, panel: .chat, invoker: .call, destination: .chatPrivate, targetId: "robin")
        #expect(targeted != plain)
        #expect(targeted == PanelRequest(presentationID: 3, panel: .chat, invoker: .call, destination: .chatPrivate, targetId: "robin"))
    }

    @Test func presentCarriesTheDestinationAndTargetId() throws {
        let panels = PanelCoordinator(session: 1)
        panels.present(.chat, from: .call, destination: .chatPrivate, targetId: "robin")
        let shown = try #require(panels.snapshot.current)
        #expect(shown.panel == .chat && shown.invoker == .call)
        #expect(shown.destination == .chatPrivate && shown.targetId == "robin")
        #expect(panels.destinationRequest == nil)
        // The two-argument form still opens the root.
        let plain = PanelCoordinator(session: 1)
        plain.present(.settings, from: .more)
        #expect(plain.snapshot.current?.destination == PanelDestination.none && plain.snapshot.current?.targetId == "")
    }

    @Test func replacementKeepsItsOwnDestination() throws {
        // SC19: the knock toast's View opens People at Waiting over an open Chat; the replacement keeps its own
        // destination, and Chat's destination stays with Chat.
        let panels = PanelCoordinator(session: 1)
        panels.present(.chat, from: .call, destination: .chatReply, targetId: "m1")
        let chat = try #require(panels.snapshot.current)
        panels.present(.participants, from: .call, destination: .peopleWaiting)
        let people = try #require(panels.snapshot.pending)
        #expect(panels.snapshot.current == chat && panels.snapshot.isDismissing)
        #expect(people.destination == .peopleWaiting && people.targetId.isEmpty)
        #expect(chat.destination == .chatReply && chat.targetId == "m1")
        #expect(panels.destinationRequest == nil)
        panels.didDismiss(session: 1, presentationID: chat.presentationID)
        #expect(panels.snapshot.current == people)
        #expect(panels.snapshot.current?.destination == .peopleWaiting)
    }

    @Test func queuedSamePanelTakesTheNewestDestination() throws {
        let panels = PanelCoordinator(session: 1)
        panels.present(.chat, from: .call)
        let chat = try #require(panels.snapshot.current)
        panels.present(.participants, from: .more)
        let queued = try #require(panels.snapshot.pending)
        // A plain request for the queued panel changes nothing.
        panels.present(.participants, from: .call)
        #expect(panels.snapshot.pending == queued)
        // A destination for it updates the queued request in place; it reads the destination when it opens.
        panels.present(.participants, from: .call, destination: .peopleRaisedHands)
        let updated = try #require(panels.snapshot.pending)
        #expect(updated.presentationID == queued.presentationID)
        #expect(updated.destination == .peopleRaisedHands && updated.invoker == .call)
        #expect(panels.destinationRequest == nil)
        // The same destination again is quiet.
        panels.present(.participants, from: .call, destination: .peopleRaisedHands)
        #expect(panels.snapshot.pending == updated)
        panels.didDismiss(session: 1, presentationID: chat.presentationID)
        #expect(panels.snapshot.current == updated)
    }

    @Test func samePanelDestinationPublishesARequestWithoutPresenting() async throws {
        let panels = PanelCoordinator(session: 4)
        panels.present(.chat, from: .call)
        let state = panels.snapshot
        let shown = try #require(state.current)
        let counter = SnapshotCallbackCounter()
        panels.onSnapshotChanged = { counter.count += 1 }
        await confirmation(expectedCount: 0) { snapshotChanged in
            withObservationTracking { _ = panels.snapshot } onChange: { snapshotChanged() }
            panels.present(.chat, from: .call, destination: .chatPrivate, targetId: "robin")
        }
        #expect(panels.snapshot == state && counter.count == 0)
        #expect(panels.destinationRequest == PanelDestinationRequest(
            sequence: 1, session: 4, presentationID: shown.presentationID, panel: .chat, invoker: .call,
            destination: .chatPrivate, targetId: "robin"))
        // The same destination again still reads as a change (the counter grows), with its own invoker.
        await confirmation(expectedCount: 1) { requested in
            withObservationTracking { _ = panels.destinationRequest } onChange: { requested() }
            panels.present(.chat, from: .more, destination: .chatPrivate, targetId: "robin")
        }
        #expect(panels.destinationRequest?.sequence == 2 && panels.destinationRequest?.invoker == .more)
        // A plain request for the current panel is quiet.
        await confirmation(expectedCount: 0) { quiet in
            withObservationTracking { _ = panels.destinationRequest; _ = panels.snapshot } onChange: { quiet() }
            panels.present(.chat, from: .call)
        }
        #expect(panels.destinationRequest?.sequence == 2 && counter.count == 0)
        // A panel acts only on its own presentation in its own session.
        #expect(panels.latestDestination(for: shown.presentationID)?.sequence == 2)
        #expect(panels.latestDestination(for: shown.presentationID + 1) == nil)
        // For every panel, not only Chat (R11).
        for panel in MeetingPanel.allCases {
            let fresh = PanelCoordinator(session: 1)
            fresh.present(panel, from: .call)
            let current = try #require(fresh.snapshot.current)
            fresh.present(panel, from: .call, destination: .settingsAudio, targetId: "x")
            #expect(fresh.snapshot.current == current, "\(panel)")
            #expect(fresh.destinationRequest?.panel == panel && fresh.destinationRequest?.presentationID == current.presentationID, "\(panel)")
        }
    }

    @Test func resetClearsTheDestinationRequestAndSequencesNeverReset() throws {
        let panels = PanelCoordinator(session: 1)
        panels.present(.transcript, from: .call)
        let first = try #require(panels.snapshot.current)
        panels.present(.transcript, from: .call, destination: .transcriptAsk)
        #expect(panels.destinationRequest?.sequence == 1)
        panels.reset(session: 1)
        #expect(panels.destinationRequest == nil)
        #expect(panels.latestDestination(for: first.presentationID) == nil)
        panels.present(.transcript, from: .call)
        let second = try #require(panels.snapshot.current)
        #expect(second.presentationID > first.presentationID)
        panels.present(.transcript, from: .call, destination: .transcriptMinutes)
        #expect(panels.destinationRequest?.sequence == 2 && panels.destinationRequest?.presentationID == second.presentationID)
        // After a reset nothing from the earlier session matches, and the next request continues the sequence.
        panels.reset(session: 2)
        panels.present(.transcript, from: .call)
        let third = try #require(panels.snapshot.current)
        #expect(panels.latestDestination(for: second.presentationID) == nil)
        panels.present(.transcript, from: .call, destination: .transcriptLive)
        #expect(panels.latestDestination(for: third.presentationID)?.sequence == 3)
        #expect(panels.latestDestination(for: third.presentationID)?.session == 2)
    }

    // MARK: onSnapshotChanged (S30 CC18)

    @Test func snapshotCallbackFiresOncePerChange() throws {
        let panels = PanelCoordinator(session: 1)
        let counter = SnapshotCallbackCounter()
        panels.onSnapshotChanged = { counter.count += 1 }
        panels.present(.participants, from: .call)           // open: one refresh, Participants Engaged
        #expect(counter.count == 1)
        let shown = try #require(panels.snapshot.current)
        panels.present(.participants, from: .more)           // same panel, no destination
        panels.present(.participants, from: .call, destination: .peopleWaiting) // destination request only
        #expect(counter.count == 1)
        panels.didDismiss(session: 1, presentationID: shown.presentationID) // premature: nothing changes
        #expect(counter.count == 1)
        panels.present(.settings, from: .settings)           // replacement queued
        #expect(counter.count == 2)
        panels.present(.settings, from: .settings)           // already queued
        #expect(counter.count == 2)
        panels.dismiss(cancelPending: true)                  // pending cancelled
        #expect(counter.count == 3)
        panels.dismiss(cancelPending: true)                  // equal snapshot
        #expect(counter.count == 3)
        panels.didDismiss(session: 1, presentationID: shown.presentationID)
        #expect(counter.count == 4 && panels.snapshot.current == nil)
        panels.reset(session: 1)                             // already empty in the same session: equal
        #expect(counter.count == 4)
        panels.reset(session: 2)                             // a new session is a change
        #expect(counter.count == 5)
        // The callback sees the published snapshot.
        let seen = SnapshotCallbackCounter()
        panels.onSnapshotChanged = { seen.panel = panels.snapshot.current?.panel }
        panels.present(.chat, from: .call)
        #expect(seen.panel == .chat)
    }

    // MARK: Detents, accessibility sizes and appearance (R9, S60 R6-10)

    @Test func policyRowsForShortDetentAndAccessibilitySizes() {
        // panel, detents, initial at default sizes, initial at accessibility sizes
        let table: [(MeetingPanel, [PanelDetent], PanelDetent, PanelDetent)] = [
            (.chat, [.large], .large, .large),
            (.participants, [.medium, .large], .medium, .medium),
            (.transcript, [.large], .large, .large),
            (.activities, [.medium, .large], .medium, .medium),
            (.effects, [.short, .large], .short, .large),
            (.hostControls, [.medium, .large], .large, .large),
            (.settings, [.medium, .large], .large, .large),
            (.webinarQA, [.large], .large, .large),
            (.meetingInfo, [.medium, .large], .medium, .medium),
            (.layout, [.medium, .large], .medium, .large),
        ]
        #expect(table.map { $0.0 } == MeetingPanel.allCases)
        for (panel, detents, initial, accessible) in table {
            #expect(PanelPresentationPolicy.sheetDetents(panel) == detents, "\(panel)")
            #expect(PanelPresentationPolicy.initialSheetDetent(panel) == initial, "\(panel)")
            #expect(PanelPresentationPolicy.initialSheetDetent(panel, isAccessibilitySize: false) == initial, "\(panel)")
            #expect(PanelPresentationPolicy.initialSheetDetent(panel, isAccessibilitySize: true) == accessible, "\(panel)")
            for isAccessibilitySize in [false, true] {
                let sheet = PanelPresentationPolicy.resolve(request(panel), window: Self.phonePortrait, platform: .iOS,
                                                            isAccessibilitySize: isAccessibilitySize)
                #expect(sheet.detents == detents, "\(panel)")
                #expect(sheet.initialDetent == (isAccessibilitySize ? accessible : initial), "\(panel)")
                #expect(sheet.detents.contains(sheet.initialDetent ?? .large), "\(panel)")
                // Only sheets carry detents: the inspector and the Android hosts ignore the input.
                let inspector = PanelPresentationPolicy.resolve(request(panel), window: Self.padFullScreen, platform: .iOS,
                                                                isAccessibilitySize: isAccessibilitySize)
                #expect(inspector.detents.isEmpty && inspector.initialDetent == nil, "\(panel)")
                let android = PanelPresentationPolicy.resolve(request(panel), window: PanelPresentationPolicy.androidWindow(width: 411, height: 891),
                                                              platform: .android, isAccessibilitySize: isAccessibilitySize)
                #expect(android.detents.isEmpty && android.initialDetent == nil && android.style == .overlay, "\(panel)")
            }
        }
        // Android reads accessibility sizes from the font scale.
        #expect(PanelPresentationPolicy.androidAccessibilityFontScale == 1.5)
        #expect(!PanelPresentationPolicy.androidIsAccessibilitySize(fontScale: 1.0))
        #expect(!PanelPresentationPolicy.androidIsAccessibilitySize(fontScale: 1.49))
        #expect(PanelPresentationPolicy.androidIsAccessibilitySize(fontScale: 1.5))
        #expect(PanelPresentationPolicy.androidIsAccessibilitySize(fontScale: 2.0))
        #expect(PanelPresentationPolicy.defaultShortDetentHeight == 222)
    }

    @Test func layoutAndEffectsAreInCallForEveryInvokerOnBothPlatforms() {
        let invokers: [PanelInvoker] = [.call, .more, .settings]
        for panel in MeetingPanel.allCases {
            for invoker in invokers {
                let expected: PanelAppearance = (panel == .layout || panel == .effects) ? .inCall : .system
                #expect(PanelPresentationPolicy.appearance(panel, invoker: invoker) == expected, "\(panel) from \(invoker)")
                let windows: [(PanelWindow, PanelPlatform)] = [
                    (Self.phonePortrait, .iOS), (Self.padFullScreen, .iOS),
                    (PanelPresentationPolicy.androidWindow(width: 411, height: 891), .android),
                    (PanelPresentationPolicy.androidWindow(width: 1280, height: 800), .android),
                ]
                for (window, platform) in windows {
                    #expect(PanelPresentationPolicy.resolve(request(panel, invoker), window: window, platform: platform).appearance == expected,
                            "\(panel) from \(invoker) on \(platform)")
                }
            }
        }
    }

    @Test func shortDetentCoverageStageInteractionAndCompactHeightRule() {
        let effects = PanelPresentationPolicy.resolve(request(.effects), window: Self.phonePortrait, platform: .iOS)
        #expect(PanelPresentationPolicy.coverage(effects, detent: .short) == .partial)
        #expect(PanelPresentationPolicy.coverage(effects, detent: nil) == .partial)
        #expect(PanelPresentationPolicy.coverage(effects, detent: .large) == .full)
        // A detent the sheet does not offer is full, whatever is passed.
        #expect(PanelPresentationPolicy.coverage(effects, detent: .medium) == .full)
        let effectsLarge = PanelPresentationPolicy.resolve(request(.effects), window: Self.phonePortrait, platform: .iOS, isAccessibilitySize: true)
        #expect(PanelPresentationPolicy.coverage(effectsLarge, detent: nil) == .full)
        let participants = PanelPresentationPolicy.resolve(request(.participants), window: Self.phonePortrait, platform: .iOS)
        #expect(PanelPresentationPolicy.coverage(participants, detent: .short) == .full)
        #expect(PanelPresentationPolicy.stageInteractiveDetent(effects) == .short)
        #expect(PanelPresentationPolicy.stageInteractiveDetent(participants) == .medium)
        for panel in MeetingPanel.allCases {
            let sheet = PanelPresentationPolicy.resolve(request(panel), window: Self.phonePortrait, platform: .iOS)
            let inspector = PanelPresentationPolicy.resolve(request(panel), window: Self.padFullScreen, platform: .iOS)
            let overlay = PanelPresentationPolicy.resolve(request(panel), window: PanelPresentationPolicy.androidWindow(width: 411, height: 891), platform: .android)
            // R10: one rule for every in-call panel sheet; side styles and the overlay have no compact adaptation.
            #expect(PanelPresentationPolicy.keepsSheetInCompactHeight(sheet), "\(panel)")
            #expect(!PanelPresentationPolicy.keepsSheetInCompactHeight(inspector), "\(panel)")
            #expect(!PanelPresentationPolicy.keepsSheetInCompactHeight(overlay), "\(panel)")
            #expect(PanelPresentationPolicy.stageInteractiveDetent(inspector) == nil, "\(panel)")
            #expect(PanelPresentationPolicy.stageInteractiveDetent(overlay) == nil, "\(panel)")
            #expect((PanelPresentationPolicy.stageInteractiveDetent(sheet) == nil) == PanelPresentationPolicy.hasBottomComposer(panel), "\(panel)")
        }
    }

    // MARK: iOS host adapter: accessibility input and the short detent

    @Test func adapterOpensLayoutAndEffectsLargeAtAccessibilitySizes() throws {
        let rows: [(MeetingPanel, PanelDetent, PanelDetent)] = [
            (.effects, .short, .large), (.layout, .medium, .large), (.participants, .medium, .medium), (.settings, .large, .large),
        ]
        for (panel, regular, accessible) in rows {
            let panels = PanelCoordinator(session: 1)
            let adapter = NativePanelHostAdapter()
            panels.present(panel, from: .call)
            adapter.synchronize(panels, style: .sheet, isAccessibilitySize: false)
            #expect(adapter.detent == regular, "\(panel)")
            let large = PanelCoordinator(session: 1)
            let host = NativePanelHostAdapter()
            large.present(panel, from: .more)
            host.synchronize(large, style: .sheet, isAccessibilitySize: true)
            #expect(host.isAccessibilitySize && host.detent == accessible, "\(panel)")
        }
        // The input is read once per presentation: a text-size change never moves a shown sheet.
        let panels = PanelCoordinator(session: 1)
        let adapter = NativePanelHostAdapter()
        panels.present(.effects, from: .call)
        adapter.synchronize(panels, style: .sheet, isAccessibilitySize: false)
        #expect(adapter.detent == .short)
        adapter.synchronize(panels, style: .sheet, isAccessibilitySize: true)
        #expect(adapter.detent == .short && adapter.isAccessibilitySize)
        // The next presentation reads the new value; the two-argument synchronize keeps it.
        panels.present(.layout, from: .call)
        adapter.synchronize(panels, style: .sheet)
        adapter.sheetDidDismiss(adapter.sheetClosing, coordinator: panels)
        #expect(adapter.sheetItem?.request.panel == .layout && adapter.detent == .large)
    }

    @Test func adapterShortDetentSelectionAndMeasuredHeight() async throws {
        let panels = PanelCoordinator(session: 1)
        let adapter = NativePanelHostAdapter()
        panels.present(.effects, from: .call)
        adapter.synchronize(panels, style: .sheet, isAccessibilitySize: false)
        #expect(adapter.detent == .short)
        adapter.selectDetent(.medium) // Effects offers no medium detent.
        #expect(adapter.detent == .short)
        adapter.promoteToLarge()
        #expect(adapter.detent == .large)
        adapter.selectDetent(.short)
        #expect(adapter.detent == .short)
        // A panel without the short detent never takes it.
        let other = PanelCoordinator(session: 1)
        let host = NativePanelHostAdapter()
        other.present(.participants, from: .call)
        host.synchronize(other, style: .sheet, isAccessibilitySize: false)
        host.selectDetent(.short)
        #expect(host.detent == .medium)
        // The measured height: the policy default until reported, then the latest real value.
        #expect(adapter.shortDetentHeight == PanelPresentationPolicy.defaultShortDetentHeight)
        adapter.setShortDetentHeight(260)
        #expect(adapter.shortDetentHeight == 260)
        for invalid in [0.0, -10.0, Double.nan, Double.infinity] {
            adapter.setShortDetentHeight(invalid)
            #expect(adapter.shortDetentHeight == 260)
        }
        await confirmation(expectedCount: 0) { changed in
            withObservationTracking { _ = adapter.shortDetentHeight } onChange: { changed() }
            adapter.setShortDetentHeight(260.2) // within half a point: a repeated layout pass is quiet
        }
        #expect(adapter.shortDetentHeight == 260)
    }

    // MARK: Source scans (macOS `swift test` compiles neither `+iOS` views nor Compose)

    @Test func coordinatorFilesStaySelfContainedAndFlat() throws {
        let model = try pnl1Source("Sources/Conclave/Features/Meeting/Panels/MeetingPanel.swift")
        let coordinator = try pnl1Source("Sources/Conclave/Features/Meeting/Panels/PanelCoordinator.swift")
        // Tests/IOSFeedbackAdapter/run.py compiles these two files with four others, so the coordinator may use only
        // types MeetingPanel.swift declares.
        for name in ["PanelPresentationPolicy", "PanelPresentation", "PanelHostStyle", "PanelDetent", "StagePresenter"] {
            #expect(!pnl1Code(coordinator).contains(name), "PanelCoordinator.swift uses \(name)")
        }
        #expect(pnl1Normalized(model).contains("enum PanelDestination: String, CaseIterable, Equatable {"))
        #expect(pnl1Normalized(coordinator).contains("@ObservationIgnored var onSnapshotChanged: (() -> Void)? = nil"))
        #expect(pnl1Normalized(coordinator).contains("guard next != snapshot else { return } snapshot = next onSnapshotChanged?()"))
        #expect(pnl1Normalized(coordinator).contains("func present(_ panel: MeetingPanel, from invoker: PanelInvoker, destination: PanelDestination = PanelDestination.none, targetId: String = \"\")"))
        // Skip Lite: String raw-value enums, scalar structs, no associated values or tuples in the shared files.
        let policy = try pnl1Source("Sources/Conclave/Features/Meeting/Panels/PanelPresentationPolicy.swift")
        for text in [model, coordinator, policy] {
            let code = pnl1Code(text)
            #expect(!code.contains("\u{2013}") && !code.contains("\u{2014}") && !code.lowercased().contains("gradient"))
            #expect(pnl1Matches(#"case\s+\w+\("#, in: code).isEmpty, "associated value")
        }
    }

    @Test func panelShellTakesOneGenericPathBinding() throws {
        let shell = pnl1Normalized(pnl1Code(try pnl1Source("Sources/Conclave/Features/Meeting/Panels/PanelShell+iOS.swift")))
        // R40-9, R50-2: one generic Binding<[Page]> into the shell's single NavigationStack.
        #expect(shell.contains("struct PanelShell<Content: View, Page: Hashable>: View {"))
        #expect(shell.contains("let path: Binding<[Page]>?"))
        #expect(shell.contains("path: Binding<[Page]>, onClose: @escaping () -> Void, onPromoteToLarge: @escaping () -> Void, @ViewBuilder content: @escaping () -> Content) {"))
        #expect(shell.contains("if let path { NavigationStack(path: path) { root } } else { NavigationStack { root } }"))
        #expect(shell.contains("extension PanelShell where Page == Never {"))
        #expect(shell.components(separatedBy: "NavigationStack").count - 1 == 2)
        // The short-detent height action the sheet host maps to `.height`.
        #expect(shell.contains("var panelReportShortDetentHeight: PanelShortDetentHeightAction {"))
        #expect(shell.contains("static let defaultValue = PanelShortDetentHeightAction(action: { _ in })"))
    }

    @Test func inCallPageCarriesTheOneTargetSignature() throws {
        let page = pnl1Normalized(try pnl1Source("Sources/Conclave/Skip/ui/call/panels/InCallPage.kt"))
        // F00 C15 d, RECONCILE R33: PS 8.4, S40 R40-3, S50 R50-1 and S60 R6-2, in order.
        #expect(page.contains("internal fun InCallPage( title: String, variant: InCallPageVariant, appearance: PanelAppearance = PanelAppearance.system, hasComposer: Boolean, miniTile: CallMiniTileModel?, onClose: () -> Unit, onMounted: () -> Unit, onDisposed: () -> Unit, miniTileVideo: (@Composable () -> Unit)? = null, composer: @Composable () -> Unit = {}, contentMode: InCallPageContent = InCallPageContent.scroll, snackbarHost: @Composable () -> Unit = {}, hideMiniTileWithIme: Boolean = false, isNested: Boolean = false, onBack: (() -> Unit)? = null, actions: @Composable RowScope.() -> Unit = {}, content: @Composable ColumnScope.(reservation: PaddingValues) -> Unit, )"))
        #expect(page.contains("internal enum class InCallPageContent { scroll, lazyList }"))
        // lazyList passes the body unscrolled with the reservation; scroll keeps the one verticalScroll.
        #expect(page.contains("if (lazyList) { Column(Modifier.fillMaxSize().testTag(\"panel.body\")) { content(PaddingValues(top = reservation.top, bottom = reservation.bottom)) } } else {"))
        #expect(page.components(separatedBy: "verticalScroll(").count - 1 == 1)
        #expect(page.contains("content(PaddingValues(0.dp))"))
        // The snackbar slot, the IME rule for the tile, app bar actions and the nested Back.
        #expect(page.contains("snackbarHost = { if (!hasComposer) snackbarHost() },"))
        #expect(page.contains("if (hasComposer) Box(Modifier.align(Alignment.BottomCenter)) { snackbarHost() }"))
        #expect(page.contains("hasTile && variant == InCallPageVariant.Overlay && !((hasComposer || hideMiniTileWithIme) && imeVisible)"))
        #expect(page.contains("actions = actions,"))
        #expect(page.contains("Icon(ConclaveIcons.ArrowBackFill0, contentDescription = conclaveString(\"native_panel_back\"))"))
        #expect(page.contains("val navigate: () -> Unit = if (navigation == InCallPageNavigation.Back && onBack != null) onBack else onClose"))
        // The mini tile always returns to the call, never pops a page.
        #expect(page.contains("onReturnToCall = onClose,"))
        #expect(pnl1Matches(#"Text\(\s*""#, in: page).isEmpty)
    }

    @Test func androidHostOwnsTheSidePaneLocalBackStack() throws {
        let host = pnl1Normalized(try pnl1Source("Sources/Conclave/Skip/ui/call/panels/NativePanelHost.kt"))
        #expect(host.contains("internal class PanelPageStack {"))
        #expect(host.contains("internal val LocalPanelPageStack = staticCompositionLocalOf<PanelPageStack?> { null }"))
        #expect(host.contains("internal fun panelBackAction(pages: PanelPageStack): PanelBackAction = if (pages.isNested) PanelBackAction.PopPage else PanelBackAction.ClosePanel"))
        #expect(host.contains("PredictiveBackHandler(enabled = request != null && !state.isDismissing) { events -> val action = panelBackAction(pages)"))
        // The page moves during a pop; the pane slides only for a close.
        #expect(host.contains("translationX = pages.backProgress.pageTranslationDp * 1.dp.toPx()"))
        #expect(host.contains(".graphicsLayer { translationX = back.paneTranslationDp(rightToLeft) * 1.dp.toPx() }"))
        // The Android accessibility-size input reaches the shared policy.
        #expect(host.contains("PanelPresentationPolicy.androidIsAccessibilitySize(fontScale = LocalDensity.current.fontScale.toDouble())"))
        #expect(host.contains("panelHostDecision(request, window, isAccessibilitySize = accessibilitySize)"))
    }
}

/// A reference box, so a callback can count without capturing a mutable local.
@MainActor
private final class SnapshotCallbackCounter {
    var count = 0
    var panel: MeetingPanel? = nil
}

// MARK: PNL-1 source helpers

private func pnl1PackageRoot() -> URL {
    URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
}

private func pnl1Source(_ packageRelativePath: String) throws -> String {
    try String(contentsOf: pnl1PackageRoot().appendingPathComponent(packageRelativePath), encoding: .utf8)
}

/// Source text with `//` comments removed, so a scan reads code only.
private func pnl1Code(_ text: String) -> String {
    text.replacingOccurrences(of: #"//[^\n]*"#, with: "", options: .regularExpression)
}

/// Collapses every run of whitespace to one space, so pins fail only when the code changes.
private func pnl1Normalized(_ text: String) -> String {
    text.split(whereSeparator: { $0.isWhitespace }).joined(separator: " ")
}

private func pnl1Matches(_ pattern: String, in text: String) -> [[String]] {
    guard let regex = try? NSRegularExpression(pattern: pattern) else { return [["invalid pattern"]] }
    let ns = text as NSString
    return regex.matches(in: text, range: NSRange(location: 0, length: ns.length)).map { match in
        (1..<max(match.numberOfRanges, 1)).map { index in
            let range = match.range(at: index)
            return range.location == NSNotFound ? "" : ns.substring(with: range)
        }
    }
}
#endif
