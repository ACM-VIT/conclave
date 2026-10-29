#if !SKIP
import Foundation
import Observation
import Testing
@testable import Conclave

@MainActor
struct PNL1PanelContractTests {
    private static let phonePortrait = PanelWindow(width: 390, height: 844, horizontalRegular: false, verticalRegular: true)
    private static let padFullScreen = PanelWindow(width: 1180, height: 820, horizontalRegular: true, verticalRegular: true)

    private func request(_ panel: MeetingPanel, _ invoker: PanelInvoker = .call, id: Int = 1) -> PanelRequest {
        PanelRequest(presentationID: id, panel: panel, invoker: invoker)
    }

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

        let plain = PanelCoordinator(session: 1)
        plain.present(.settings, from: .more)
        #expect(plain.snapshot.current?.destination == PanelDestination.none && plain.snapshot.current?.targetId == "")
    }

    @Test func replacementKeepsItsOwnDestination() throws {

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

        panels.present(.participants, from: .call)
        #expect(panels.snapshot.pending == queued)

        panels.present(.participants, from: .call, destination: .peopleRaisedHands)
        let updated = try #require(panels.snapshot.pending)
        #expect(updated.presentationID == queued.presentationID)
        #expect(updated.destination == .peopleRaisedHands && updated.invoker == .call)
        #expect(panels.destinationRequest == nil)

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

        await confirmation(expectedCount: 1) { requested in
            withObservationTracking { _ = panels.destinationRequest } onChange: { requested() }
            panels.present(.chat, from: .more, destination: .chatPrivate, targetId: "robin")
        }
        #expect(panels.destinationRequest?.sequence == 2 && panels.destinationRequest?.invoker == .more)

        await confirmation(expectedCount: 0) { quiet in
            withObservationTracking { _ = panels.destinationRequest; _ = panels.snapshot } onChange: { quiet() }
            panels.present(.chat, from: .call)
        }
        #expect(panels.destinationRequest?.sequence == 2 && counter.count == 0)

        #expect(panels.latestDestination(for: shown.presentationID)?.sequence == 2)
        #expect(panels.latestDestination(for: shown.presentationID + 1) == nil)

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

        panels.reset(session: 2)
        panels.present(.transcript, from: .call)
        let third = try #require(panels.snapshot.current)
        #expect(panels.latestDestination(for: second.presentationID) == nil)
        panels.present(.transcript, from: .call, destination: .transcriptLive)
        #expect(panels.latestDestination(for: third.presentationID)?.sequence == 3)
        #expect(panels.latestDestination(for: third.presentationID)?.session == 2)
    }

    @Test func snapshotCallbackFiresOncePerChange() throws {
        let panels = PanelCoordinator(session: 1)
        let counter = SnapshotCallbackCounter()
        panels.onSnapshotChanged = { counter.count += 1 }
        panels.present(.participants, from: .call)
        #expect(counter.count == 1)
        let shown = try #require(panels.snapshot.current)
        panels.present(.participants, from: .more)
        panels.present(.participants, from: .call, destination: .peopleWaiting)
        #expect(counter.count == 1)
        panels.didDismiss(session: 1, presentationID: shown.presentationID)
        #expect(counter.count == 1)
        panels.present(.settings, from: .settings)
        #expect(counter.count == 2)
        panels.present(.settings, from: .settings)
        #expect(counter.count == 2)
        panels.dismiss(cancelPending: true)
        #expect(counter.count == 3)
        panels.dismiss(cancelPending: true)
        #expect(counter.count == 3)
        panels.didDismiss(session: 1, presentationID: shown.presentationID)
        #expect(counter.count == 4 && panels.snapshot.current == nil)
        panels.reset(session: 1)
        #expect(counter.count == 4)
        panels.reset(session: 2)
        #expect(counter.count == 5)

        let seen = SnapshotCallbackCounter()
        panels.onSnapshotChanged = { seen.panel = panels.snapshot.current?.panel }
        panels.present(.chat, from: .call)
        #expect(seen.panel == .chat)
    }

    @Test func policyRowsForShortDetentAndAccessibilitySizes() {

        let table: [(MeetingPanel, [PanelDetent], PanelDetent, PanelDetent)] = [
            (.chat, [.large], .large, .large),
            (.participants, [.medium, .large], .medium, .medium),
            (.transcript, [.large], .large, .large),
            (.activities, [.medium, .large], .medium, .large),
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
                let expectedDetents: [PanelDetent] = panel == .activities && isAccessibilitySize ? [.large] : detents
                #expect(sheet.detents == expectedDetents, "\(panel)")
                #expect(sheet.initialDetent == (isAccessibilitySize ? accessible : initial), "\(panel)")
                #expect(sheet.detents.contains(sheet.initialDetent ?? .large), "\(panel)")

                let inspector = PanelPresentationPolicy.resolve(request(panel), window: Self.padFullScreen, platform: .iOS,
                                                                isAccessibilitySize: isAccessibilitySize)
                #expect(inspector.detents.isEmpty && inspector.initialDetent == nil, "\(panel)")
                let android = PanelPresentationPolicy.resolve(request(panel), window: PanelPresentationPolicy.androidWindow(width: 411, height: 891),
                                                              platform: .android, isAccessibilitySize: isAccessibilitySize)

                let isBottomSheet = panel == .layout || panel == .effects
                #expect(android.detents.isEmpty && android.initialDetent == nil
                        && android.style == (isBottomSheet ? PanelHostStyle.bottomSheet : PanelHostStyle.overlay), "\(panel)")
            }
        }

        #expect(PanelPresentationPolicy.androidAccessibilityFontScale == 1.5)
        #expect(!PanelPresentationPolicy.androidIsAccessibilitySize(fontScale: 1.0))
        #expect(!PanelPresentationPolicy.androidIsAccessibilitySize(fontScale: 1.49))
        #expect(PanelPresentationPolicy.androidIsAccessibilitySize(fontScale: 1.5))
        #expect(PanelPresentationPolicy.androidIsAccessibilitySize(fontScale: 2.0))
        #expect(PanelPresentationPolicy.defaultShortDetentHeight == 222)
    }

    @Test func activitiesSheetReservesLargeDetentForAccessibilityAndShortWindows() {
        for height in [390.0, 599.0, 600.0, 844.0] {
            let window = PanelWindow(width: 390, height: height, horizontalRegular: false, verticalRegular: height >= 480)
            for accessible in [false, true] {
                let sheet = PanelPresentationPolicy.resolve(request(.activities), window: window, platform: .iOS,
                                                            isAccessibilitySize: accessible)
                let needsLarge = accessible || height < 600
                #expect(sheet.style == .sheet && sheet.appearance == .system && !sheet.hasBottomComposer)
                #expect(sheet.detents == (needsLarge ? [.large] : [.medium, .large]))
                #expect(sheet.initialDetent == (needsLarge ? .large : .medium))
                #expect(PanelPresentationPolicy.coverage(sheet, detent: nil) == (needsLarge ? .full : .partial))
                #expect(PanelPresentationPolicy.coverage(sheet, detent: .medium) == (needsLarge ? .full : .partial))
                #expect(PanelPresentationPolicy.stageInteractiveDetent(sheet) == (needsLarge ? nil : .medium))

                let people = PanelPresentationPolicy.resolve(request(.participants), window: window, platform: .iOS,
                                                             isAccessibilitySize: accessible)
                #expect(people.detents == [.medium, .large] && people.initialDetent == .medium)
                let android = PanelPresentationPolicy.resolve(request(.activities), window: window, platform: .android,
                                                              isAccessibilitySize: accessible)
                #expect(android.style == .overlay && android.detents.isEmpty && android.initialDetent == nil)
            }
        }
    }

    @Test func activitiesLargeDetentRuleDoesNotReplaceRegularPanes() {
        let window = PanelWindow(width: 1180, height: 550, horizontalRegular: true, verticalRegular: true)
        for accessible in [false, true] {
            for platform in [PanelPlatform.iOS, .android] {
                let pane = PanelPresentationPolicy.resolve(request(.activities), window: window, platform: platform,
                                                           isAccessibilitySize: accessible)
                #expect(pane.style == (platform == .iOS ? .inspector : .sidePane))
                #expect(pane.detents.isEmpty && pane.initialDetent == nil && pane.paneWidth == 360)
                #expect(PanelPresentationPolicy.coverage(pane, detent: nil) == .none)
            }
            let sheet = PanelPresentationPolicy.resolve(request(.activities), window: window, platform: .iOS,
                                                        isAccessibilitySize: accessible, sideStylesEnabled: false)
            #expect(sheet.style == .sheet && sheet.detents == [.large] && sheet.initialDetent == .large)
        }
    }

    @Test func activitiesAccessibilityChangesReclassifyAnUnchangedMediumDetent() {
        let adapterDetent = PanelDetent.medium
        let changes: [(Bool, PanelStageCoverage)] = [(false, .partial), (true, .full), (false, .partial)]
        for (accessible, expectedCoverage) in changes {
            let sheet = PanelPresentationPolicy.resolve(request(.activities), window: Self.phonePortrait, platform: .iOS,
                                                        isAccessibilitySize: accessible)
            #expect(sheet.detents == (accessible ? [.large] : [.medium, .large]))
            #expect(PanelPresentationPolicy.coverage(sheet, detent: adapterDetent) == expectedCoverage)
        }
    }

    @Test func layoutAndEffectsAreInCallForEveryInvokerOnBothPlatforms() {
        let invokers: [PanelInvoker] = [.call, .more, .settings]
        for panel in MeetingPanel.allCases {
            for invoker in invokers {
                let expected: PanelAppearance = (panel == .chat || panel == .layout || panel == .effects) ? .inCall : .system
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

            #expect(PanelPresentationPolicy.keepsSheetInCompactHeight(sheet), "\(panel)")
            #expect(!PanelPresentationPolicy.keepsSheetInCompactHeight(inspector), "\(panel)")
            #expect(!PanelPresentationPolicy.keepsSheetInCompactHeight(overlay), "\(panel)")
            #expect(PanelPresentationPolicy.stageInteractiveDetent(inspector) == nil, "\(panel)")
            #expect(PanelPresentationPolicy.stageInteractiveDetent(overlay) == nil, "\(panel)")
            #expect((PanelPresentationPolicy.stageInteractiveDetent(sheet) == nil) == PanelPresentationPolicy.hasBottomComposer(panel), "\(panel)")
        }
    }

    @Test func adapterOpensLayoutEffectsAndActivitiesLargeAtAccessibilitySizes() throws {
        let rows: [(MeetingPanel, PanelDetent, PanelDetent)] = [
            (.effects, .short, .large), (.layout, .medium, .large), (.activities, .medium, .large),
            (.participants, .medium, .medium), (.settings, .large, .large),
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

        let panels = PanelCoordinator(session: 1)
        let adapter = NativePanelHostAdapter()
        panels.present(.effects, from: .call)
        adapter.synchronize(panels, style: .sheet, isAccessibilitySize: false)
        #expect(adapter.detent == .short)
        adapter.synchronize(panels, style: .sheet, isAccessibilitySize: true)
        #expect(adapter.detent == .short && adapter.isAccessibilitySize)

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
        adapter.selectDetent(.medium)
        #expect(adapter.detent == .short)
        adapter.promoteToLarge()
        #expect(adapter.detent == .large)
        adapter.selectDetent(.short)
        #expect(adapter.detent == .short)

        let other = PanelCoordinator(session: 1)
        let host = NativePanelHostAdapter()
        other.present(.participants, from: .call)
        host.synchronize(other, style: .sheet, isAccessibilitySize: false)
        host.selectDetent(.short)
        #expect(host.detent == .medium)

        #expect(adapter.shortDetentHeight == PanelPresentationPolicy.defaultShortDetentHeight)
        adapter.setShortDetentHeight(260)
        #expect(adapter.shortDetentHeight == 260)
        for invalid in [0.0, -10.0, Double.nan, Double.infinity] {
            adapter.setShortDetentHeight(invalid)
            #expect(adapter.shortDetentHeight == 260)
        }
        await confirmation(expectedCount: 0) { changed in
            withObservationTracking { _ = adapter.shortDetentHeight } onChange: { changed() }
            adapter.setShortDetentHeight(260.2)
        }
        #expect(adapter.shortDetentHeight == 260)
    }

    @Test func coordinatorFilesStaySelfContainedAndFlat() throws {
        let model = try pnl1Source("Sources/Conclave/Features/Meeting/Panels/MeetingPanel.swift")
        let coordinator = try pnl1Source("Sources/Conclave/Features/Meeting/Panels/PanelCoordinator.swift")

        for name in ["PanelPresentationPolicy", "PanelPresentation", "PanelHostStyle", "PanelDetent", "StagePresenter"] {
            #expect(!pnl1Code(coordinator).contains(name), "PanelCoordinator.swift uses \(name)")
        }
        #expect(pnl1Normalized(model).contains("enum PanelDestination: String, CaseIterable, Equatable {"))
        #expect(pnl1Normalized(coordinator).contains("@ObservationIgnored var onSnapshotChanged: (() -> Void)? = nil"))
        #expect(pnl1Normalized(coordinator).contains("guard next != snapshot else { return } snapshot = next onSnapshotChanged?()"))
        #expect(pnl1Normalized(coordinator).contains("func present(_ panel: MeetingPanel, from invoker: PanelInvoker, destination: PanelDestination = PanelDestination.none, targetId: String = \"\")"))

        let policy = try pnl1Source("Sources/Conclave/Features/Meeting/Panels/PanelPresentationPolicy.swift")
        for text in [model, coordinator, policy] {
            let code = pnl1Code(text)
            #expect(!code.contains("\u{2013}") && !code.contains("\u{2014}") && !code.lowercased().contains("gradient"))
            #expect(pnl1Matches(#"case\s+\w+\("#, in: code).isEmpty, "associated value")
        }
    }

    @Test func panelShellTakesOneGenericPathBinding() throws {
        let shell = pnl1Normalized(pnl1Code(try pnl1Source("Sources/Conclave/Features/Meeting/Panels/PanelShell+iOS.swift")))

        #expect(shell.contains("struct PanelShell<Content: View, Page: Hashable>: View {"))
        #expect(shell.contains("let path: Binding<[Page]>?"))
        #expect(shell.contains("path: Binding<[Page]>, onClose: @escaping () -> Void, onPromoteToLarge: @escaping () -> Void, @ViewBuilder content: @escaping () -> Content) {"))
        #expect(shell.contains("if let path { NavigationStack(path: path) { root } } else { NavigationStack { root } }"))
        #expect(shell.contains("extension PanelShell where Page == Never {"))
        #expect(shell.components(separatedBy: "NavigationStack").count - 1 == 2)

        #expect(shell.contains("var panelReportShortDetentHeight: PanelShortDetentHeightAction {"))
        #expect(shell.contains("static let defaultValue = PanelShortDetentHeightAction(action: { _ in })"))
    }

    @Test func inCallPageCarriesTheOneTargetSignature() throws {
        let page = pnl1Normalized(try pnl1Source("Sources/Conclave/Skip/ui/call/panels/InCallPage.kt"))

        #expect(page.contains("internal fun InCallPage( title: String, variant: InCallPageVariant, appearance: PanelAppearance = PanelAppearance.system, hasComposer: Boolean, miniTile: CallMiniTileModel?, onClose: () -> Unit, onMounted: () -> Unit, onDisposed: () -> Unit, miniTileVideo: (@Composable () -> Unit)? = null, composer: @Composable () -> Unit = {}, composerOverlaysContent: Boolean = false, contentMode: InCallPageContent = InCallPageContent.scroll, snackbarHost: @Composable () -> Unit = {}, hideMiniTileWithIme: Boolean = false, isNested: Boolean = false, onBack: (() -> Unit)? = null, actions: @Composable RowScope.() -> Unit = {}, content: @Composable ColumnScope.(reservation: PaddingValues) -> Unit, )"))
        #expect(page.contains("internal enum class InCallPageContent { scroll, lazyList }"))

        #expect(page.contains("if (lazyList) { Column(Modifier.fillMaxSize().testTag(\"panel.body\")) { content(PaddingValues(top = reservation.top, bottom = reservation.bottom + composerClearance)) } } else {"))
        #expect(page.components(separatedBy: "verticalScroll(").count - 1 == 1)
        #expect(page.contains("content(PaddingValues(0.dp))"))

        #expect(page.contains("snackbarHost = { if (!hasComposer) snackbarHost() },"))
        #expect(page.contains("if (hasComposer) Box(Modifier.align(Alignment.BottomCenter)) { snackbarHost() }"))
        #expect(page.contains("hasTile && variant == InCallPageVariant.Overlay && !((hasComposer || hideMiniTileWithIme) && imeVisible)"))
        #expect(page.contains("actions = actions,"))
        #expect(page.contains("Icon(ConclaveIcons.ArrowBackFill0, contentDescription = conclaveString(\"native_panel_back\"))"))
        #expect(page.contains("val navigate: () -> Unit = if (navigation == InCallPageNavigation.Back && onBack != null) onBack else onClose"))

        #expect(page.contains("onReturnToCall = onClose,"))
        #expect(pnl1Matches(#"Text\(\s*""#, in: page).isEmpty)
    }

    @Test func androidHostOwnsTheSidePaneLocalBackStack() throws {
        let host = pnl1Normalized(try pnl1Source("Sources/Conclave/Skip/ui/call/panels/NativePanelHost.kt"))
        #expect(host.contains("internal class PanelPageStack {"))
        #expect(host.contains("internal val LocalPanelPageStack = staticCompositionLocalOf<PanelPageStack?> { null }"))
        #expect(host.contains("internal fun panelBackAction(pages: PanelPageStack): PanelBackAction = if (pages.isNested) PanelBackAction.PopPage else PanelBackAction.ClosePanel"))
        #expect(host.contains("PredictiveBackHandler(enabled = request != null && !state.isDismissing) { events -> val action = panelBackAction(pages)"))

        #expect(host.contains("translationX = pages.backProgress.pageTranslationDp * 1.dp.toPx()"))
        #expect(host.contains(".graphicsLayer { translationX = back.paneTranslationDp(rightToLeft) * 1.dp.toPx() }"))

        #expect(host.contains("PanelPresentationPolicy.androidIsAccessibilitySize(fontScale = LocalDensity.current.fontScale.toDouble())"))
        #expect(host.contains("panelHostDecision(request, window, isAccessibilitySize = accessibilitySize)"))
    }
}

@MainActor
private final class SnapshotCallbackCounter {
    var count = 0
    var panel: MeetingPanel? = nil
}

private func pnl1PackageRoot() -> URL {
    URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
}

private func pnl1Source(_ packageRelativePath: String) throws -> String {
    try String(contentsOf: pnl1PackageRoot().appendingPathComponent(packageRelativePath), encoding: .utf8)
}

private func pnl1Code(_ text: String) -> String {
    text.replacingOccurrences(of: #"//[^\n]*"#, with: "", options: .regularExpression)
}

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
