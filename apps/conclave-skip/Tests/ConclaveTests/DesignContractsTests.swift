#if !SKIP
import Foundation
import Observation
import Testing
@testable import Conclave

@MainActor
struct DesignContractsTests {
    @Test func vocabularyAndInitialState() {
        #expect(FeedbackKind.allCases.count == 66)
        #expect(Set(FeedbackKind.allCases.map { $0.rawValue }).count == 66)
        #expect(MeetingPanel.allCases.map { $0.rawValue } == ["chat", "participants", "transcript", "activities", "effects", "hostControls", "settings", "webinarQA", "meetingInfo", "layout"])
        #expect(NativeHostingPresenter().feedbackState.token == FeedbackToken(sequence: 0, kind: .none))
    }

    @Test func outcomeAcceptanceWithoutConsumerRejectsDuplicatesAndStaleSessions() {
        let owner = NativeHostingPresenter()
        #expect(owner.completeFixtureAction(actionID: 8, expectedSession: 1, kind: .joined))
        #expect(!owner.completeFixtureAction(actionID: 8, expectedSession: 1, kind: .actionRejected))
        #expect(owner.feedbackState.acceptedCount == 1)
        #expect(owner.feedbackState.token == FeedbackToken(sequence: 1, kind: .joined))
        #expect(owner.completeFixtureAction(actionID: 9, expectedSession: 1, kind: .joined))
        #expect(owner.feedbackState.token.sequence == 2)
        owner.resetFixtureSession()
        #expect(!owner.completeFixtureAction(actionID: 10, expectedSession: 1, kind: .joined))
        #expect(owner.completeFixtureAction(actionID: 8, expectedSession: 2, kind: .joined))
        #expect(owner.feedbackState.token.sequence == 1)
        #expect(owner.feedbackState.acceptedCount == 1)
    }

    @Test func systemAndGestureCompletionsAreAcceptedWithoutOutcomeFeedback() {
        let owner = NativeHostingPresenter()
        #expect(owner.completeFixtureAction(actionID: 1, expectedSession: 1, kind: .micOn, source: .system))
        #expect(owner.completeFixtureAction(actionID: 2, expectedSession: 1, kind: .selectionChanged, source: .gesture))
        #expect(owner.completeFixtureAction(actionID: 3, expectedSession: 1, kind: .selectionChanged))
        #expect(owner.feedbackState.acceptedCount == 3)
        #expect(owner.feedbackState.token == .baseline)
        let cursor = FeedbackDeliveryCursor()
        cursor.attach(session: 1, current: owner.feedbackState.token, eligible: true)
        let gesture = cursor.gesture(kind: .selectionChanged, session: 1, eligible: true)
        #expect(gesture != nil)
        #expect(cursor.sequence == 0)
        #expect(owner.feedbackState.token.sequence == 0)
    }

    @Test func publicCompletionReplayKeepsItsOriginalSessionAndKind() {
        let owner = NativeHostingPresenter()
        let cursor = FeedbackDeliveryCursor()
        var received: [FeedbackKind] = []
        func collect() {
            let state = owner.feedbackState
            if let pending = cursor.observe(session: state.session, token: state.token, epoch: cursor.epoch, eligible: true),
               let kind = cursor.take(pending, session: state.session, eligible: true) {
                received.append(kind)
            }
        }
        cursor.attach(session: 1, current: .baseline, eligible: true)
        owner.repeatLastFixtureCompletion()
        #expect(owner.feedbackState.acceptedCount == 0)
        // Exact public fixture sequence: Complete Outcome -> Reset Session -> Repeat Completion.
        owner.completeNextFixtureAction()
        collect()
        #expect(received == [.joined])
        #expect(owner.feedbackState.token == FeedbackToken(sequence: 1, kind: .joined))
        owner.resetFixtureSession()
        cursor.attach(session: 2, current: owner.feedbackState.token, eligible: true)
        owner.repeatLastFixtureCompletion()
        collect()
        #expect(received == [.joined])
        #expect(owner.feedbackState.session == 2)
        #expect(owner.feedbackState.acceptedCount == 0)
        #expect(owner.feedbackState.token == .baseline)

        // A fresh action still succeeds, and repeating its nondefault kind is a quiet duplicate.
        owner.completeNextFixtureAction(kind: .actionRejected)
        collect()
        #expect(received == [.joined, .actionRejected])
        let fresh = owner.feedbackState
        #expect(fresh.acceptedCount == 1)
        #expect(fresh.token == FeedbackToken(sequence: 1, kind: .actionRejected))
        owner.repeatLastFixtureCompletion()
        collect()
        #expect(received == [.joined, .actionRejected])
        #expect(owner.feedbackState == fresh)
        owner.resetFixtureSession()
        owner.repeatLastFixtureCompletion()
        #expect(owner.feedbackState.acceptedCount == 0)
        #expect(owner.feedbackState.token == .baseline)
        owner.completeNextFixtureAction(kind: .questionSent)
        let latest = owner.feedbackState
        owner.repeatLastFixtureCompletion()
        #expect(owner.feedbackState == latest)
        #expect(latest.token == FeedbackToken(sequence: 1, kind: .questionSent))
    }

    @Test(arguments: [0, 7]) func attachAndRemountBaselineCurrentSequence(_ initial: Int) throws {
        let cursor = FeedbackDeliveryCursor()
        let current = FeedbackToken(sequence: initial, kind: initial == 0 ? .none : .joined)
        cursor.attach(session: 1, current: current, eligible: true)
        #expect(cursor.observe(session: 1, token: current, epoch: cursor.epoch, eligible: true) == nil)
        for sequence in [initial + 1, initial + 2] {
            let token = FeedbackToken(sequence: sequence, kind: .joined)
            let delivery = try #require(cursor.observe(session: 1, token: token, epoch: cursor.epoch, eligible: true))
            #expect(cursor.take(delivery, session: 1, eligible: true) == .joined)
            #expect(cursor.take(delivery, session: 1, eligible: true) == nil)
            #expect(cursor.observe(session: 1, token: token, epoch: cursor.epoch, eligible: true) == nil)
        }
        #expect(cursor.observe(session: 1, token: FeedbackToken(sequence: initial + 2, kind: .gameWrong), epoch: cursor.epoch, eligible: true) == nil)
        #expect(cursor.observe(session: 1, token: current, epoch: cursor.epoch, eligible: true) == nil)
        let remount = FeedbackDeliveryCursor()
        let latest = FeedbackToken(sequence: initial + 2, kind: .joined)
        remount.attach(session: 1, current: latest, eligible: true)
        #expect(remount.observe(session: 1, token: latest, epoch: remount.epoch, eligible: true) == nil)
        #expect(remount.observe(session: 1, token: FeedbackToken(sequence: initial + 3, kind: .joined), epoch: remount.epoch, eligible: true) != nil)
    }

    @Test func sessionCollisionsAndPendingEffectsStayIsolated() throws {
        let cursor = FeedbackDeliveryCursor()
        cursor.attach(session: 1, current: .baseline, eligible: true)
        let old = try #require(cursor.observe(session: 1, token: FeedbackToken(sequence: 1, kind: .joined), epoch: cursor.epoch, eligible: true))
        cursor.attach(session: 2, current: .baseline, eligible: true)
        #expect(cursor.take(old, session: 2, eligible: true) == nil)
        #expect(cursor.observe(session: 1, token: FeedbackToken(sequence: 2, kind: .joined), epoch: cursor.epoch, eligible: true) == nil)
        let new = try #require(cursor.observe(session: 2, token: FeedbackToken(sequence: 1, kind: .joined), epoch: cursor.epoch, eligible: true))
        #expect(cursor.take(new, session: 2, eligible: true) == .joined)
    }

    @Test func suppressedAndSilentObservationsAdvanceWithoutReplay() {
        let cursor = FeedbackDeliveryCursor()
        cursor.attach(session: 1, current: .baseline, eligible: false)
        let token = FeedbackToken(sequence: 1, kind: .joined)
        #expect(cursor.observe(session: 1, token: token, epoch: cursor.epoch, eligible: false) == nil)
        #expect(cursor.sequence == 1)
        cursor.setEligibility(session: 1, current: token, eligible: true)
        #expect(cursor.observe(session: 1, token: token, epoch: cursor.epoch, eligible: true) == nil)
        #expect(cursor.observe(session: 1, token: FeedbackToken(sequence: 2, kind: .none), epoch: cursor.epoch, eligible: true) == nil)
        #expect(cursor.sequence == 2)
        #expect(cursor.observe(session: 1, token: FeedbackToken(sequence: 3, kind: .joined), epoch: cursor.epoch, eligible: true) != nil)
    }

    @Test func coalescedPauseEventResumeAndPreferenceRestorationDoNotReplay() throws {
        let owner = NativeHostingPresenter()
        let cursor = FeedbackDeliveryCursor()
        cursor.attach(session: 1, current: .baseline, eligible: true)
        owner.completeNextFixtureAction()
        let pending = try #require(cursor.observe(session: 1, token: owner.feedbackState.token, epoch: cursor.epoch, eligible: true))
        let oldEpoch = cursor.epoch
        cursor.setEligibility(session: 1, current: owner.feedbackState.token, eligible: false)
        owner.completeNextFixtureAction()
        // No observation occurs between pause and resume.
        cursor.setEligibility(session: 1, current: owner.feedbackState.token, eligible: true)
        #expect(cursor.take(pending, session: 1, eligible: true) == nil)
        #expect(cursor.observe(session: 1, token: owner.feedbackState.token, epoch: oldEpoch, eligible: true) == nil)
        #expect(cursor.observe(session: 1, token: owner.feedbackState.token, epoch: cursor.epoch, eligible: true) == nil)
        owner.completeNextFixtureAction()
        #expect(cursor.observe(session: 1, token: owner.feedbackState.token, epoch: cursor.epoch, eligible: true) != nil)
    }

    @Test func eligibilityIsRecheckedWhenDeliveryRuns() throws {
        let cursor = FeedbackDeliveryCursor()
        cursor.attach(session: 1, current: .baseline, eligible: true)
        let pending = try #require(cursor.observe(session: 1, token: FeedbackToken(sequence: 1, kind: .joined), epoch: cursor.epoch, eligible: true))
        #expect(cursor.take(pending, session: 1, eligible: false) == nil)
        #expect(cursor.take(pending, session: 1, eligible: true) == nil)
    }

    @Test func unrelatedRowsAndSamePanelRequestsAreQuiet() async {
        let owner = NativeHostingPresenter()
        owner.panels.present(.participants, from: .call)
        let state = owner.panels.snapshot
        await confirmation(expectedCount: 0) { changed in
            withObservationTracking { _ = owner.feedbackState; _ = owner.panels.snapshot } onChange: { changed() }
            owner.setRowSelected(id: "avery", selected: true)
            owner.setDetailsVisible(false)
            owner.panels.present(.participants, from: .settings)
        }
        #expect(owner.panels.snapshot == state)
        #expect(owner.panels.snapshot.current?.invoker == .call)
    }

    @Test func replacementWaitsForMatchingDismissalAndLatestPendingWins() throws {
        let owner = NativeHostingPresenter()
        owner.setRowSelected(id: "robin", selected: true)
        let panels = owner.panels
        panels.present(.participants, from: .call)
        let first = try #require(panels.snapshot.current)
        panels.didDismiss(session: 1, presentationID: first.presentationID) // Premature.
        #expect(panels.snapshot.current == first)
        panels.present(.settings, from: .settings)
        let middle = panels.snapshot.pending
        #expect(panels.snapshot.current == first)
        #expect(panels.snapshot.isDismissing)
        panels.present(.participants, from: .more) // A -> B -> A is a fresh A.
        let latest = try #require(panels.snapshot.pending)
        #expect(latest.presentationID > (middle?.presentationID ?? 0))
        panels.dismiss(cancelPending: false)
        panels.didDismiss(session: 0, presentationID: first.presentationID)
        panels.didDismiss(session: 1, presentationID: latest.presentationID)
        #expect(panels.snapshot.current == first)
        panels.didDismiss(session: 1, presentationID: first.presentationID)
        #expect(panels.snapshot.current == latest)
        #expect(panels.snapshot.current?.invoker == .more)
        #expect(panels.snapshot.pending == nil)
        #expect(!panels.snapshot.isDismissing)
        panels.didDismiss(session: 1, presentationID: first.presentationID)
        #expect(panels.snapshot.current == latest)
        #expect(owner.rowsState.selectedCount == 1)
    }

    @Test func explicitCloseCancelsPendingAndBindingLossCannotRestoreIt() throws {
        let panels = PanelCoordinator(session: 1)
        panels.present(.participants, from: .call)
        let first = try #require(panels.snapshot.current)
        panels.present(.settings, from: .settings)
        panels.dismiss(cancelPending: true)
        panels.dismiss(cancelPending: false)
        #expect(panels.snapshot.pending == nil)
        #expect(panels.snapshot.current?.invoker == .call)
        panels.didDismiss(session: 1, presentationID: first.presentationID)
        #expect(panels.snapshot.current == nil)
    }

    @Test func resetInvalidatesOldAcknowledgmentsAndKeepsSelection() throws {
        let owner = NativeHostingPresenter()
        owner.setRowSelected(id: "avery", selected: true)
        owner.panels.present(.participants, from: .call)
        let first = try #require(owner.panels.snapshot.current)
        owner.panels.present(.settings, from: .settings)
        owner.resetFixtureSession()
        owner.panels.present(.participants, from: .more)
        let new = owner.panels.snapshot.current
        owner.panels.didDismiss(session: 1, presentationID: first.presentationID)
        #expect(owner.panels.snapshot.current == new)
        #expect((new?.presentationID ?? 0) > first.presentationID)
        #expect(owner.rowsState.selectedCount == 1)
    }

    // MARK: WP1-3b1 adapter characterization (PS 6.4, C2): written against the moved NativePanelSheetAdapter and
    // kept with unchanged expectations through the single rename to NativePanelHostAdapter.

    @Test func adapterPresentsTheCurrentRequest() throws {
        let panels = PanelCoordinator(session: 1)
        let adapter = NativePanelHostAdapter()
        adapter.synchronize(panels)
        #expect(adapter.sheetItem == nil && adapter.sheetClosing == nil)
        panels.present(.participants, from: .call)
        adapter.synchronize(panels)
        let request = try #require(panels.snapshot.current)
        #expect(adapter.sheetItem == NativePanelPresentation(session: 1, request: request))
        #expect(adapter.sheetItem?.id == "1:\(request.presentationID)")
        #expect(adapter.capturedSheet == adapter.sheetItem)
        adapter.synchronize(panels)
        #expect(adapter.sheetItem == NativePanelPresentation(session: 1, request: request))
    }

    @Test func adapterDismissingMovesTheShownItemToClosing() throws {
        let panels = PanelCoordinator(session: 1)
        let adapter = NativePanelHostAdapter()
        panels.present(.participants, from: .call)
        adapter.synchronize(panels)
        let shown = try #require(adapter.sheetItem)
        panels.dismiss(cancelPending: true)
        adapter.synchronize(panels)
        #expect(adapter.sheetItem == nil)
        #expect(adapter.sheetClosing == shown)
        #expect(adapter.capturedSheet == shown)
        // The coordinator still waits for the native dismissal.
        #expect(panels.snapshot.isDismissing && panels.snapshot.current == shown.request)
    }

    @Test func adapterBindingLossKeepsThePendingReplacement() throws {
        let panels = PanelCoordinator(session: 1)
        let adapter = NativePanelHostAdapter()
        panels.present(.participants, from: .call)
        adapter.synchronize(panels)
        let shown = try #require(adapter.sheetItem)
        // A replacement request lands, then the user swipes the sheet down before the adapter synchronizes.
        panels.present(.settings, from: .settings)
        let pending = try #require(panels.snapshot.pending)
        adapter.sheetBindingLost(shown, coordinator: panels)
        #expect(panels.snapshot.pending == pending)
        #expect(adapter.sheetClosing == shown && adapter.sheetItem == nil)
        // A swipe on a sheet with no replacement keeps nothing pending and still waits for onDismiss.
        let solo = PanelCoordinator(session: 1)
        let soloAdapter = NativePanelHostAdapter()
        solo.present(.participants, from: .call)
        soloAdapter.synchronize(solo)
        soloAdapter.sheetBindingLost(soloAdapter.sheetItem, coordinator: solo)
        #expect(solo.snapshot.isDismissing && solo.snapshot.pending == nil && solo.snapshot.current != nil)
    }

    @Test func adapterMatchingDismissAcknowledgesAndPresentsThePending() throws {
        let panels = PanelCoordinator(session: 1)
        let adapter = NativePanelHostAdapter()
        panels.present(.participants, from: .call)
        adapter.synchronize(panels)
        panels.present(.settings, from: .settings)
        adapter.synchronize(panels)
        let closing = try #require(adapter.sheetClosing)
        let pending = try #require(panels.snapshot.pending)
        // Snapshot changes while closing never present anything early.
        adapter.synchronize(panels)
        #expect(adapter.sheetItem == nil)
        adapter.sheetDidDismiss(closing, coordinator: panels)
        #expect(panels.snapshot.current == pending && !panels.snapshot.isDismissing)
        #expect(adapter.sheetClosing == nil)
        #expect(adapter.sheetItem == NativePanelPresentation(session: 1, request: pending))
    }

    @Test func adapterCoalescedUnshownRequestAcknowledgesImmediately() throws {
        let panels = PanelCoordinator(session: 1)
        let adapter = NativePanelHostAdapter()
        panels.present(.participants, from: .call)
        panels.present(.settings, from: .settings)
        panels.present(.participants, from: .more)
        let latest = try #require(panels.snapshot.pending)
        // The first request was never shown, so the adapter acknowledges it at once and shows the latest.
        adapter.synchronize(panels)
        #expect(panels.snapshot.current == latest && !panels.snapshot.isDismissing)
        #expect(adapter.sheetItem == NativePanelPresentation(session: 1, request: latest))
        #expect(adapter.sheetClosing == nil)
        // A close of an unshown request leaves nothing behind.
        let other = PanelCoordinator(session: 1)
        let otherAdapter = NativePanelHostAdapter()
        other.present(.participants, from: .call)
        other.dismiss(cancelPending: true)
        otherAdapter.synchronize(other)
        #expect(other.snapshot.current == nil && otherAdapter.sheetItem == nil && otherAdapter.sheetClosing == nil)
    }

    @Test func adapterStaleCapturesAreIgnored() throws {
        let panels = PanelCoordinator(session: 1)
        let adapter = NativePanelHostAdapter()
        panels.present(.participants, from: .call)
        adapter.synchronize(panels)
        let first = try #require(adapter.sheetItem)
        panels.present(.settings, from: .settings)
        adapter.synchronize(panels)
        adapter.sheetDidDismiss(first, coordinator: panels)
        let second = try #require(adapter.sheetItem)
        // Callbacks captured for the first presentation can no longer close or acknowledge anything.
        adapter.sheetBindingLost(first, coordinator: panels)
        adapter.sheetDidDismiss(first, coordinator: panels)
        adapter.sheetBindingLost(nil, coordinator: panels)
        adapter.sheetDidDismiss(nil, coordinator: panels)
        #expect(adapter.sheetItem == second && adapter.sheetClosing == nil)
        #expect(panels.snapshot.current == second.request && !panels.snapshot.isDismissing)
        // A reset retires the shown item; its late onDismiss acknowledges nothing in the new session.
        panels.reset(session: 2)
        adapter.synchronize(panels)
        #expect(adapter.sheetClosing == second && adapter.sheetItem == nil)
        panels.present(.participants, from: .more)
        let fresh = try #require(panels.snapshot.current)
        adapter.sheetDidDismiss(second, coordinator: panels)
        #expect(panels.snapshot.current == fresh)
        #expect(adapter.sheetItem == NativePanelPresentation(session: 2, request: fresh))
    }

    // MARK: WP1-3b1 adapter extensions (PS 6.4, 7.3)

    @Test func detentResetsPerPresentationAndPromotesOnFocus() throws {
        let panels = PanelCoordinator(session: 1)
        let adapter = NativePanelHostAdapter()
        panels.present(.participants, from: .call)
        adapter.synchronize(panels)
        #expect(adapter.detent == .medium)
        adapter.selectDetent(.large)
        #expect(adapter.detent == .large)
        adapter.selectDetent(.medium)
        #expect(adapter.detent == .medium)
        // A focused text field promotes a medium sheet to large; promoting again changes nothing.
        adapter.promoteToLarge()
        #expect(adapter.detent == .large)
        adapter.promoteToLarge()
        #expect(adapter.detent == .large)
        adapter.selectDetent(.medium)
        // A replacement opens at its own initial detent, not the selection the user left behind.
        panels.present(.settings, from: .settings)
        adapter.synchronize(panels)
        adapter.sheetDidDismiss(adapter.sheetClosing, coordinator: panels)
        #expect(adapter.sheetItem?.request.panel == .settings)
        #expect(adapter.detent == .large)
        panels.present(.participants, from: .more)
        adapter.synchronize(panels)
        adapter.sheetDidDismiss(adapter.sheetClosing, coordinator: panels)
        #expect(adapter.sheetItem?.request.panel == .participants)
        #expect(adapter.detent == .medium)
        // A large-only composer panel never takes a medium selection.
        panels.present(.chat, from: .call)
        adapter.synchronize(panels)
        adapter.sheetDidDismiss(adapter.sheetClosing, coordinator: panels)
        #expect(adapter.sheetItem?.request.panel == .chat)
        #expect(adapter.detent == .large)
        adapter.selectDetent(.medium)
        #expect(adapter.detent == .large)
        // With no shown sheet, selection and promotion are ignored.
        panels.dismiss(cancelPending: true)
        adapter.synchronize(panels)
        adapter.sheetDidDismiss(adapter.sheetClosing, coordinator: panels)
        #expect(adapter.sheetItem == nil)
        adapter.selectDetent(.medium)
        adapter.promoteToLarge()
        #expect(adapter.detent == .large)
        // Layout and the detent table agree for every panel the adapter can show.
        for panel in MeetingPanel.allCases {
            let fresh = PanelCoordinator(session: 1)
            let host = NativePanelHostAdapter()
            fresh.present(panel, from: .call)
            host.synchronize(fresh)
            #expect(host.detent == PanelPresentationPolicy.initialSheetDetent(panel), "\(panel)")
        }
    }

    @Test func draftsKeyedByPresentationAndDroppedOnAcknowledgment() async throws {
        let panels = PanelCoordinator(session: 1)
        let adapter = NativePanelHostAdapter()
        panels.present(.settings, from: .settings)
        adapter.synchronize(panels)
        let first = try #require(adapter.sheetItem).request.presentationID
        adapter.setDraft("Sample", for: first)
        #expect(adapter.draft(for: first) == "Sample")
        // Drafts for presentations that are not shown are refused.
        adapter.setDraft("Other", for: first + 100)
        #expect(adapter.draft(for: first + 100) == "")
        // A replacement keeps the closing draft until its dismissal is acknowledged.
        panels.present(.participants, from: .more)
        adapter.synchronize(panels)
        #expect(adapter.draft(for: first) == "Sample")
        adapter.sheetDidDismiss(adapter.sheetClosing, coordinator: panels)
        #expect(adapter.drafts[first] == nil)
        let second = try #require(adapter.sheetItem).request.presentationID
        #expect(second > first && adapter.draft(for: second) == "")
        adapter.setDraft("Kept", for: second)
        // A swipe without replacement keeps the draft until onDismiss, then drops it.
        adapter.sheetBindingLost(adapter.sheetItem, coordinator: panels)
        adapter.synchronize(panels)
        #expect(adapter.draft(for: second) == "Kept")
        adapter.sheetDidDismiss(adapter.sheetClosing, coordinator: panels)
        #expect(adapter.drafts.isEmpty)
        // A session reset drops every draft of the old session at once.
        panels.present(.settings, from: .settings)
        adapter.synchronize(panels)
        let third = try #require(adapter.sheetItem).request.presentationID
        adapter.setDraft("Gone", for: third)
        panels.reset(session: 2)
        adapter.synchronize(panels)
        #expect(adapter.drafts.isEmpty)
        // Equal text is a quiet no-op.
        panels.present(.settings, from: .settings)
        adapter.synchronize(panels)
        adapter.sheetDidDismiss(adapter.sheetClosing, coordinator: panels)
        let fourth = try #require(adapter.sheetItem).request.presentationID
        adapter.setDraft("Same", for: fourth)
        await confirmation(expectedCount: 0) { changed in
            withObservationTracking { _ = adapter.drafts } onChange: { changed() }
            adapter.setDraft("Same", for: fourth)
            adapter.synchronize(panels)
        }
    }

    // MARK: WP1-3b1 panel presentation policy (PS 6.2, amendment A2)

    private static let phonePortrait = PanelWindow(width: 390, height: 844, horizontalRegular: false, verticalRegular: true)
    private static let phoneLandscape = PanelWindow(width: 932, height: 430, horizontalRegular: true, verticalRegular: false)
    private static let padFullScreen = PanelWindow(width: 1180, height: 820, horizontalRegular: true, verticalRegular: true)

    private func request(_ panel: MeetingPanel, _ invoker: PanelInvoker = .call, id: Int = 1) -> PanelRequest {
        PanelRequest(presentationID: id, panel: panel, invoker: invoker)
    }

    @Test func panelPolicyCompactUsesSheetOrOverlay() {
        let androidPhone = PanelPresentationPolicy.androidWindow(width: 411, height: 891)
        #expect(!androidPhone.horizontalRegular && androidPhone.verticalRegular)
        for panel in MeetingPanel.allCases {
            let ios = PanelPresentationPolicy.resolve(request(panel), window: Self.phonePortrait, platform: .iOS)
            #expect(ios.style == .sheet, "\(panel)")
            #expect(ios.detents == PanelPresentationPolicy.sheetDetents(panel), "\(panel)")
            #expect(ios.initialDetent == PanelPresentationPolicy.initialSheetDetent(panel), "\(panel)")
            #expect(!ios.showsMiniTile && ios.paneWidth == 0, "\(panel)")
            let android = PanelPresentationPolicy.resolve(request(panel), window: androidPhone, platform: .android)
            #expect(android.style == .overlay, "\(panel)")
            #expect(android.showsMiniTile, "\(panel)")
            #expect(android.detents.isEmpty && android.initialDetent == nil && android.paneWidth == 0, "\(panel)")
            #expect(PanelPresentationPolicy.coverage(android, detent: nil) == .full, "\(panel)")
            #expect(android.hasBottomComposer == ios.hasBottomComposer, "\(panel)")
        }
    }

    @Test func panelPolicyBoundaries() {
        #expect(!PanelPresentationPolicy.androidWindow(width: 839.9, height: 800).horizontalRegular)
        #expect(PanelPresentationPolicy.androidWindow(width: 840.0, height: 800).horizontalRegular)
        #expect(!PanelPresentationPolicy.androidWindow(width: 1280, height: 479.9).verticalRegular)
        #expect(PanelPresentationPolicy.androidWindow(width: 1280, height: 480.0).verticalRegular)
        let cases: [(width: Double, height: Double, style: PanelHostStyle)] = [
            (839.9, 480.0, .overlay), (840.0, 480.0, .sidePane), (840.0, 479.9, .overlay), (839.9, 479.9, .overlay),
        ]
        for item in cases {
            let window = PanelPresentationPolicy.androidWindow(width: item.width, height: item.height)
            #expect(PanelPresentationPolicy.style(window: window, platform: .android, panel: .participants,
                                                  sideStylesEnabled: true) == item.style, "\(item.width) x \(item.height)")
            #expect(PanelPresentationPolicy.style(window: window, platform: .android, panel: .participants,
                                                  sideStylesEnabled: false) == .overlay)
        }
        #expect(PanelPresentationPolicy.regularMinWidth == 840 && PanelPresentationPolicy.regularMinHeight == 480)
    }

    @Test func panelPolicyDetentTable() {
        // PS 6.2 panel table: bottom composer, iOS sheet detents, initial detent, appearance from the call.
        let table: [(MeetingPanel, Bool, [PanelDetent], PanelDetent, PanelAppearance)] = [
            (.chat, true, [.large], .large, .system),
            (.participants, false, [.medium, .large], .medium, .system),
            (.transcript, true, [.large], .large, .system),
            (.activities, false, [.medium, .large], .medium, .system),
            (.effects, false, [.medium, .large], .medium, .inCall),
            (.hostControls, false, [.medium, .large], .large, .system),
            (.settings, false, [.medium, .large], .large, .system),
            (.webinarQA, true, [.large], .large, .system),
            (.meetingInfo, false, [.medium, .large], .medium, .system),
            (.layout, false, [.medium, .large], .medium, .inCall),
        ]
        #expect(table.map { $0.0 } == MeetingPanel.allCases)
        for (panel, composer, detents, initial, appearance) in table {
            let resolved = PanelPresentationPolicy.resolve(request(panel), window: Self.phonePortrait, platform: .iOS)
            #expect(resolved.hasBottomComposer == composer, "\(panel)")
            #expect(PanelPresentationPolicy.hasBottomComposer(panel) == composer, "\(panel)")
            #expect(resolved.detents == detents, "\(panel)")
            #expect(resolved.initialDetent == initial, "\(panel)")
            #expect(resolved.appearance == appearance, "\(panel)")
            // The keyboard never meets a medium sheet.
            #expect(!composer || !resolved.detents.contains(.medium), "\(panel)")
        }
    }

    @Test func panelPolicyLayoutAppearanceIsInvokerScoped() {
        let invokers: [PanelInvoker] = [.call, .more, .settings]
        for panel in MeetingPanel.allCases {
            for invoker in invokers {
                // Owner default Q8.6 extends the contract's Layout rule to Effects.
                let dark = invoker == .call && (panel == .layout || panel == .effects)
                #expect(PanelPresentationPolicy.appearance(panel, invoker: invoker) == (dark ? .inCall : .system), "\(panel) from \(invoker)")
                let android = PanelPresentationPolicy.resolve(request(panel, invoker), window: PanelPresentationPolicy.androidWindow(width: 411, height: 891), platform: .android)
                #expect(android.appearance == (dark ? .inCall : .system), "\(panel) from \(invoker)")
            }
        }
    }

    @Test func panelPolicyCoverage() {
        let participants = PanelPresentationPolicy.resolve(request(.participants), window: Self.phonePortrait, platform: .iOS)
        #expect(PanelPresentationPolicy.coverage(participants, detent: .medium) == .partial)
        #expect(PanelPresentationPolicy.coverage(participants, detent: .large) == .full)
        #expect(PanelPresentationPolicy.coverage(participants, detent: nil) == .partial)
        let settings = PanelPresentationPolicy.resolve(request(.settings), window: Self.phonePortrait, platform: .iOS)
        #expect(PanelPresentationPolicy.coverage(settings, detent: nil) == .full)
        // A large-only sheet is never partial, whatever detent is passed.
        let chat = PanelPresentationPolicy.resolve(request(.chat), window: Self.phonePortrait, platform: .iOS)
        #expect(PanelPresentationPolicy.coverage(chat, detent: .medium) == .full)
        let inspector = PanelPresentationPolicy.resolve(request(.participants), window: Self.padFullScreen, platform: .iOS, sideStylesEnabled: true)
        #expect(inspector.style == .inspector && PanelPresentationPolicy.coverage(inspector, detent: .medium) == PanelStageCoverage.none)
        let overlay = PanelPresentationPolicy.resolve(request(.participants), window: Self.phonePortrait, platform: .android)
        #expect(PanelPresentationPolicy.coverage(overlay, detent: nil) == .full)
        let side = PanelPresentationPolicy.resolve(request(.participants), window: PanelPresentationPolicy.androidWindow(width: 1280, height: 800), platform: .android, sideStylesEnabled: true)
        #expect(side.style == .sidePane && PanelPresentationPolicy.coverage(side, detent: nil) == PanelStageCoverage.none)
        // The policy returns no bottom sheet until WP1-3c; the rule still holds for the style.
        let bottom = PanelPresentation(style: .bottomSheet, detents: [], initialDetent: nil, appearance: .inCall,
                                       showsMiniTile: false, paneWidth: 0, hasBottomComposer: false)
        #expect(PanelPresentationPolicy.coverage(bottom, detent: nil) == .partial)
    }

    @Test func panelPolicySideStylesFlagCoversBothBranches() {
        // Amendment A2: every assertion passes the flag explicitly, so this test holds before and after WP1-3b2
        // flips the default (review ISSUE 4).
        let tablet = PanelPresentationPolicy.androidWindow(width: 1280, height: 800)
        let landscapePhone = PanelPresentationPolicy.androidWindow(width: 891, height: 411)
        let portraitPhone = PanelPresentationPolicy.androidWindow(width: 411, height: 891)
        let windows: [(PanelWindow, PanelPlatform, PanelHostStyle, PanelHostStyle)] = [
            // window, platform, style with side styles off, style with side styles on
            (Self.padFullScreen, .iOS, .sheet, .inspector),
            (Self.phoneLandscape, .iOS, .sheet, .sheet),
            (Self.phonePortrait, .iOS, .sheet, .sheet),
            (tablet, .android, .overlay, .sidePane),
            (landscapePhone, .android, .overlay, .overlay),
            (portraitPhone, .android, .overlay, .overlay),
        ]
        for (window, platform, off, on) in windows {
            for panel in MeetingPanel.allCases {
                #expect(PanelPresentationPolicy.style(window: window, platform: platform, panel: panel, sideStylesEnabled: false) == off)
                #expect(PanelPresentationPolicy.style(window: window, platform: platform, panel: panel, sideStylesEnabled: true) == on)
                #expect(PanelPresentationPolicy.resolve(request(panel), window: window, platform: platform, sideStylesEnabled: false).style == off)
                #expect(PanelPresentationPolicy.resolve(request(panel), window: window, platform: platform, sideStylesEnabled: true).style == on)
            }
        }
        let inspector = PanelPresentationPolicy.resolve(request(.settings), window: Self.padFullScreen, platform: .iOS, sideStylesEnabled: true)
        #expect(inspector.paneWidth == 360 && inspector.detents.isEmpty && inspector.initialDetent == nil && !inspector.showsMiniTile)
        let pane = PanelPresentationPolicy.resolve(request(.settings), window: tablet, platform: .android, sideStylesEnabled: true)
        #expect(pane.paneWidth == 360 && !pane.showsMiniTile)
        let fallback = PanelPresentationPolicy.resolve(request(.settings), window: Self.padFullScreen, platform: .iOS, sideStylesEnabled: false)
        #expect(fallback.style == .sheet && fallback.paneWidth == 0 && fallback.detents == [.medium, .large])
    }

    @Test func panelPolicySideStylesDefaultStaysOffInWP13b1() {
        // The one assertion WP1-3b2 changes together with the constant (amendment A2): until then an expanded
        // window falls back to the sheet or the overlay. Omitting the flag always means the shared default.
        #expect(!PanelPresentationPolicy.sideStylesEnabled)
        let tablet = PanelPresentationPolicy.androidWindow(width: 1280, height: 800)
        for (window, platform) in [(Self.padFullScreen, PanelPlatform.iOS), (tablet, PanelPlatform.android)] {
            for panel in MeetingPanel.allCases {
                let explicit = PanelPresentationPolicy.resolve(request(panel), window: window, platform: platform,
                                                               sideStylesEnabled: PanelPresentationPolicy.sideStylesEnabled)
                #expect(PanelPresentationPolicy.resolve(request(panel), window: window, platform: platform) == explicit)
                #expect(PanelPresentationPolicy.style(window: window, platform: platform, panel: panel) == explicit.style)
            }
        }
    }

    @Test func panelPolicyStageInteractionAndTextFocus() throws {
        // Owner default Q8.1: sheets that can sit at medium keep the stage usable up through medium.
        for panel in MeetingPanel.allCases {
            let sheet = PanelPresentationPolicy.resolve(request(panel), window: Self.phonePortrait, platform: .iOS)
            #expect(PanelPresentationPolicy.stageInteractiveUpThroughMedium(sheet) == !PanelPresentationPolicy.hasBottomComposer(panel), "\(panel)")
            let overlay = PanelPresentationPolicy.resolve(request(panel), window: Self.phonePortrait, platform: .android)
            #expect(!PanelPresentationPolicy.stageInteractiveUpThroughMedium(overlay), "\(panel)")
            // Review n4: text focus promotion is tested on the path that ships, the adapter, for every panel.
            let panels = PanelCoordinator(session: 1)
            let adapter = NativePanelHostAdapter()
            panels.present(panel, from: .call)
            adapter.synchronize(panels)
            adapter.selectDetent(.medium)
            #expect(adapter.detent == (sheet.detents.contains(.medium) ? .medium : .large), "\(panel)")
            adapter.promoteToLarge()
            #expect(adapter.detent == .large, "\(panel)")
        }
        // One implementation of the rule: the policy carries no second copy.
        let policy = try panelSource("Sources/Conclave/Features/Meeting/Panels/PanelPresentationPolicy.swift")
        #expect(!policy.contains("func detentAfterTextFocus"))
    }

    // MARK: WP1-3b1 renderer identity ledger (PS 6.3, P2)

    @Test func rendererLedgerSerialsAndStaleRelease() {
        let ledger = RendererIdentityLedger()
        #expect(ledger.summary() == "stage c=0 r=0 l=0 lost=0 back=0 | mini c=0 r=0 l=0 lost=0 back=0")
        let avery = ledger.created(key: "avery", slot: .stage)
        #expect(avery == 1 && ledger.serial(for: "avery") == 1)
        ledger.released(key: "avery", serial: 0, slot: .stage)            // stale serial
        ledger.released(key: "avery", serial: avery, slot: .miniTile)     // wrong slot
        ledger.released(key: "robin", serial: avery, slot: .stage)        // unknown key
        #expect(ledger.serial(for: "avery") == 1)
        #expect(ledger.counts(.stage) == RendererIdentityCounts(created: 1, released: 0, live: 1, surfaceLost: 0, surfaceRestored: 0))
        ledger.released(key: "avery", serial: avery, slot: .stage)
        ledger.released(key: "avery", serial: avery, slot: .stage)        // double release
        #expect(ledger.serial(for: "avery") == nil)
        #expect(ledger.counts(.stage) == RendererIdentityCounts(created: 1, released: 1, live: 0, surfaceLost: 0, surfaceRestored: 0))
        let again = ledger.created(key: "avery", slot: .stage)
        #expect(again == 2 && ledger.serial(for: "avery") == 2)
        // A late release of the first host cannot remove the newer live serial.
        ledger.released(key: "avery", serial: avery, slot: .stage)
        #expect(ledger.serial(for: "avery") == 2)
        let mini = ledger.created(key: "mini:1:7", slot: .miniTile)
        #expect(mini == 3)
        #expect(ledger.counts(.miniTile) == RendererIdentityCounts(created: 1, released: 0, live: 1, surfaceLost: 0, surfaceRestored: 0))
        #expect(ledger.counts(.stage).live == 1 && ledger.counts(.pip) == RendererIdentityCounts(created: 0, released: 0, live: 0, surfaceLost: 0, surfaceRestored: 0))
        #expect(ledger.summary() == "stage c=2 r=1 l=1 lost=0 back=0 | mini c=1 r=0 l=1 lost=0 back=0 | avery#2 mini:1:7#3")
        _ = ledger.created(key: "pip:1", slot: .pip)
        #expect(ledger.summary().contains(" | pip c=1 r=0 l=1 lost=0 back=0 | "))
    }

    @Test func rendererLedgerSurfaceEventsDoNotChangeIdentity() {
        let ledger = RendererIdentityLedger()
        let serials = ["avery", "robin", "taylor"].map { ledger.created(key: $0, slot: .stage) }
        #expect(serials == [1, 2, 3])
        ledger.surfaceLost(key: "robin", serial: 2, slot: .stage)
        ledger.surfaceRestored(key: "robin", serial: 2, slot: .stage)
        ledger.surfaceLost(key: "robin", serial: 1, slot: .stage)         // stale
        ledger.surfaceRestored(key: "taylor", serial: 3, slot: .miniTile) // wrong slot
        ledger.surfaceLost(key: "missing", serial: 4, slot: .stage)
        #expect(ledger.serial(for: "robin") == 2)
        #expect(ledger.counts(.stage) == RendererIdentityCounts(created: 3, released: 0, live: 3, surfaceLost: 1, surfaceRestored: 1))
        #expect(ledger.summary() == "stage c=3 r=0 l=3 lost=1 back=1 | mini c=0 r=0 l=0 lost=0 back=0 | avery#1 robin#2 taylor#3")
        // Composition counts are diagnostics only.
        ledger.composed(key: "robin")
        ledger.composed(key: "robin")
        #expect(ledger.compositions(for: "robin") == 2 && ledger.compositions(for: "avery") == 0)
        ledger.composed(key: "avery")
        #expect(ledger.compositionSummary() == "compositions avery=1 robin=2")
        #expect(RendererIdentityLedger().compositionSummary() == "compositions none")
        #expect(ledger.counts(.stage) == RendererIdentityCounts(created: 3, released: 0, live: 3, surfaceLost: 1, surfaceRestored: 1))
        // A released host takes no more surface events.
        ledger.released(key: "robin", serial: 2, slot: .stage)
        ledger.surfaceLost(key: "robin", serial: 2, slot: .stage)
        #expect(ledger.counts(.stage).surfaceLost == 1)
    }

    @Test func rendererLedgerOverlappingHostsBalanceInEitherReleaseOrder() {
        // Review ISSUE 2: a second host for a key can be created before the first one releases (a SwiftUI identity
        // change or a Compose move creates before it releases). Each host is its own instance: both releases count,
        // in either order, a newer instance is never removed by an older release, and created minus released is live.
        for newerReleasesFirst in [false, true] {
            let ledger = RendererIdentityLedger()
            let older = ledger.created(key: "avery", slot: .stage)
            let newer = ledger.created(key: "avery", slot: .stage)
            #expect(ledger.counts(.stage) == RendererIdentityCounts(created: 2, released: 0, live: 2, surfaceLost: 0, surfaceRestored: 0))
            #expect(ledger.serial(for: "avery") == newer)
            #expect(ledger.summary() == "stage c=2 r=0 l=2 lost=0 back=0 | mini c=0 r=0 l=0 lost=0 back=0 | avery#1 avery#2")
            let first = newerReleasesFirst ? newer : older
            let second = newerReleasesFirst ? older : newer
            ledger.released(key: "avery", serial: first, slot: .stage)
            #expect(ledger.counts(.stage) == RendererIdentityCounts(created: 2, released: 1, live: 1, surfaceLost: 0, surfaceRestored: 0))
            #expect(ledger.serial(for: "avery") == second)
            // Surface events reach only the instance that is still live.
            ledger.surfaceLost(key: "avery", serial: first, slot: .stage)
            ledger.surfaceLost(key: "avery", serial: second, slot: .stage)
            #expect(ledger.counts(.stage).surfaceLost == 1)
            ledger.released(key: "avery", serial: second, slot: .stage)
            ledger.released(key: "avery", serial: second, slot: .stage)   // double release
            ledger.released(key: "avery", serial: first, slot: .stage)    // late release of a released host
            #expect(ledger.counts(.stage) == RendererIdentityCounts(created: 2, released: 2, live: 0, surfaceLost: 1, surfaceRestored: 0))
            #expect(ledger.serial(for: "avery") == nil)
        }
        // One key in two slots: each instance counts in its own slot, and a release names its slot.
        let ledger = RendererIdentityLedger()
        let stage = ledger.created(key: "robin", slot: .stage)
        let mini = ledger.created(key: "robin", slot: .miniTile)
        ledger.released(key: "robin", serial: stage, slot: .miniTile)
        #expect(ledger.counts(.stage).live == 1 && ledger.counts(.miniTile).live == 1)
        ledger.released(key: "robin", serial: stage, slot: .stage)
        #expect(ledger.counts(.stage) == RendererIdentityCounts(created: 1, released: 1, live: 0, surfaceLost: 0, surfaceRestored: 0))
        #expect(ledger.counts(.miniTile) == RendererIdentityCounts(created: 1, released: 0, live: 1, surfaceLost: 0, surfaceRestored: 0))
        #expect(ledger.serial(for: "robin") == mini)
        #expect(ledger.summary() == "stage c=1 r=1 l=0 lost=0 back=0 | mini c=1 r=0 l=1 lost=0 back=0 | robin#2")
    }

    @Test func rendererLedgerTwentyCyclesBalance() {
        let ledger = RendererIdentityLedger()
        for key in ["avery", "robin", "taylor"] { _ = ledger.created(key: key, slot: .stage) }
        let launch = "stage c=3 r=0 l=3 lost=0 back=0 | mini c=0 r=0 l=0 lost=0 back=0 | avery#1 robin#2 taylor#3"
        #expect(ledger.summary() == launch)
        for cycle in 1...20 {
            let key = "mini:1:\(cycle)"
            let serial = ledger.created(key: key, slot: .miniTile)
            #expect(ledger.counts(.miniTile).live == 1)
            ledger.released(key: key, serial: serial, slot: .miniTile)
        }
        #expect(ledger.counts(.stage) == RendererIdentityCounts(created: 3, released: 0, live: 3, surfaceLost: 0, surfaceRestored: 0))
        #expect(ledger.counts(.miniTile) == RendererIdentityCounts(created: 20, released: 20, live: 0, surfaceLost: 0, surfaceRestored: 0))
        #expect(ledger.summary() == "stage c=3 r=0 l=3 lost=0 back=0 | mini c=20 r=20 l=0 lost=0 back=0 | avery#1 robin#2 taylor#3")
        #expect(ledger.serial(for: "avery") == 1 && ledger.serial(for: "robin") == 2 && ledger.serial(for: "taylor") == 3)
    }

    // MARK: WP1-3b1 P1 source proof

    @Test func rowMutationPublishesOnceWhilePanelsAndFeedbackStayQuiet() async {
        let owner = NativeHostingPresenter()
        owner.completeNextFixtureAction()
        owner.presentPanel(.participants, from: .call, at: 1)
        for key in ["avery", "robin", "taylor"] { _ = owner.renderers.created(key: key, slot: .stage) }
        let rows = owner.rowsState
        let panels = owner.panels.snapshot
        let feedback = owner.feedbackState
        await confirmation(expectedCount: 1) { rowsChanged in
            withObservationTracking { _ = owner.rowsState } onChange: { rowsChanged() }
            await confirmation(expectedCount: 0) { quiet in
                withObservationTracking { _ = owner.panels.snapshot; _ = owner.feedbackState } onChange: { quiet() }
                owner.setRowSelected(id: "robin", selected: true)
            }
        }
        #expect(owner.rowsState.revision == rows.revision + 1)
        #expect(owner.rowsState.selectedCount == 1)
        #expect(owner.panels.snapshot == panels && owner.feedbackState == feedback)
        #expect(owner.renderers.summary() == "stage c=3 r=0 l=3 lost=0 back=0 | mini c=0 r=0 l=0 lost=0 back=0 | avery#1 robin#2 taylor#3")
    }

    // MARK: WP1-3b1 source scans. macOS `swift test` does not compile `+iOS` views or Compose, so these pin the
    // wiring the runtime cells then exercise. They compare whitespace-collapsed text, so formatting never fails them.

    @Test func panelShellKeepsCloseTrailingAndScopesItsAppearance() throws {
        let shell = try panelSource("Sources/Conclave/Features/Meeting/Panels/PanelShell+iOS.swift")
        let flat = panelNormalized(panelCode(shell))
        #expect(shell.hasPrefix("#if os(iOS) && !SKIP\n"))
        // A17 and Q12: Close at .topBarTrailing with hardware Escape, never a confirmation action.
        #expect(flat.contains("ToolbarItem(placement: .topBarTrailing) { PanelCloseButton(title: title, action: onClose) }"))
        #expect(!panelCode(shell).contains(".confirmationAction"))
        #expect(flat.components(separatedBy: ".keyboardShortcut(.cancelAction)").count - 1 == 2)
        #expect(flat.components(separatedBy: ".accessibilityIdentifier(\"panel.close\")").count - 1 == 2)
        // The system close role only inside its iOS 26 branch; before it a labeled xmark with a hidden image.
        #expect(flat.contains("if #available(iOS 26.0, *) { Button(role: .close, action: action)"))
        #expect(flat.contains("Image(systemName: ConclaveSymbols.xmark) .accessibilityHidden(true)"))
        // Review n2: both branches say "Close <title>" (PS 12); the iOS 26 role keeps its system glyph.
        #expect(flat.components(separatedBy: ".accessibilityLabel(ConclaveStrings.format(\"Close %@\", title))").count - 1 == 2)
        #expect(flat.contains("Button(role: .close, action: action) .keyboardShortcut(.cancelAction) .accessibilityLabel(ConclaveStrings.format(\"Close %@\", title))"))
        // Inline title, the L2 modifier moved verbatim, and the focus promotion action for content fields.
        #expect(flat.contains(".navigationTitle(title) .navigationBarTitleDisplayMode(.inline) .modifier(PanelBarMinimization())"))
        #expect(flat.contains("if #available(iOS 27.0, *) { content.toolbarMinimizationBehavior(.never, for: .navigationBar) } else { content }"))
        #expect(flat.contains(".environment(\\.panelPromoteToLargeDetent, PanelPromoteToLargeDetentAction(action: onPromoteToLarge))"))
        // Appearance: a sheet scopes with preferredColorScheme; an inspector only sets the environment.
        #expect(flat.contains("if hostStyle == .inspector { content.environment(\\.colorScheme, scheme) } else { content.preferredColorScheme(scheme) }"))
        #expect(flat.contains("presentation.appearance == .inCall ? .dark : systemScheme"))
        // The L2 struct left the fixture root.
        let root = panelCode(try panelSource("Sources/Conclave/App/PlatformRoot+iOS.swift"))
        #expect(!root.contains("toolbarMinimizationBehavior") && !root.contains("HostingSamplePanelBarMinimization"))
    }

    @Test func iosSheetHostFollowsThePolicyAndNeverCoversTheWindow() throws {
        let host = try panelSource("Sources/Conclave/Features/Meeting/Panels/NativePanelSheet+iOS.swift")
        let flat = panelNormalized(host)
        #expect(host.hasPrefix("#if os(iOS) && !SKIP\n"))
        #expect(flat.contains(".onChange(of: coordinator.snapshot, initial: true) { _, _ in adapter.synchronize(coordinator) }"))
        #expect(flat.contains("if value == nil { adapter.sheetBindingLost(captured, coordinator: coordinator) }"))
        #expect(flat.contains("adapter.sheetDidDismiss(captured, coordinator: coordinator)"))
        #expect(flat.contains("PanelPresentationPolicy.resolve(presentation.request, window: window, platform: .iOS)"))
        #expect(flat.contains(".presentationDetents(Set(resolved.detents.map { Self.systemDetent($0) }), selection: Binding("))
        #expect(flat.contains("set: { adapter.selectDetent($0 == .medium ? .medium : .large) }"))
        // Owner default Q8.1, through the shared policy.
        #expect(flat.contains("PanelStageInteraction(enabled: PanelPresentationPolicy.stageInteractiveUpThroughMedium(resolved))"))
        #expect(flat.contains("content.presentationBackgroundInteraction(.enabled(upThrough: .medium))"))
        // No panel path ever covers the window or customizes the system sheet chrome.
        var files = try panelSourceFiles(under: "Sources/Conclave/Features/Meeting/Panels")
        files.append("Sources/Conclave/App/PlatformRoot+iOS.swift")
        for file in files {
            let text = panelCode(try panelSource(file))
            for pattern in [".fullScreenCover", "presentationCornerRadius", "presentationBackground(", "UIScreen.main"] {
                #expect(!text.contains(pattern), "\(file) uses \(pattern)")
            }
        }
        // The adapter is host-testable: no SwiftUI in it, and the frozen coordinator files stay as they were.
        let adapter = try panelSource("Sources/Conclave/Features/Meeting/Panels/PanelHostAdapter.swift")
        #expect(adapter.hasPrefix("#if !SKIP\n") && !adapter.contains("import SwiftUI"))
        #expect(!host.contains("final class"))
    }

    @Test func rendererProbeIsDebugOnlyInertAndNeverInverted() throws {
        let probe = try panelSource("Sources/Conclave/App/Hosting/RendererProbe+iOS.swift")
        let flat = panelNormalized(probe)
        #expect(probe.hasPrefix("#if DEBUG && os(iOS) && !SKIP\n"))
        #expect(flat.contains("serial = ledger.created(key: key, slot: slot)"))
        #expect(flat.contains("static func dismantleUIView(_ uiView: RendererProbeView, coordinator: ()) { uiView.release() }"))
        #expect(flat.contains("func updateUIView(_ uiView: RendererProbeView, context: Context) {}"))
        #expect(flat.contains("ledger.surfaceLost(key: key, serial: serial, slot: slot)"))
        #expect(flat.contains("ledger.surfaceRestored(key: key, serial: serial, slot: slot)"))
        #expect(flat.contains("#if canImport(WebRTC) let surface = RTCMTLVideoView(frame: .zero)"))
        #expect(flat.contains(".accessibilityHidden(true) .accessibilityIgnoresInvertColors()"))
        for pattern in ["RTCVideoTrack", "AVCapture", "AVAudioSession", "addRenderer", "MeetingViewModel", "Timer", "URLSession"] {
            #expect(!probe.contains(pattern), "probe uses \(pattern)")
        }
    }

    @Test func iosFixtureRootKeepsTheStageSiblingIdentifiersAndReadouts() throws {
        let root = try panelSource("Sources/Conclave/App/PlatformRoot+iOS.swift")
        let flat = panelNormalized(root)
        // L1, amended by review M1: the stage strip is a sibling above the List with a fixed vertical size, so a
        // medium sheet never hides it, and it never overlays the List.
        #expect(flat.contains("VStack(spacing: 0) { // L1, as amended by the WP1-3b1 review (M1): the stage is a layout sibling above the List, so a // medium sheet never hides it (P1.3, IOS-1); it reserves its height in the same layout and never // overlays the List. HostingStageStrip(lifetime: stageLifetime, presenter: presenter) .fixedSize(horizontal: false, vertical: true) List {"))
        #expect(flat.contains(".listStyle(.insetGrouped) } .navigationTitle(\"Hosting Preview\")"))
        for pattern in ["safeAreaInset", ".overlay(alignment: .bottom", "ZStack {"] {
            #expect(!panelCode(root).contains(pattern), "the stage must stay a sibling: \(pattern)")
        }
        // The strip background stays out of the top safe area (the navigation bar keeps the system background),
        // and the whole stage keeps its dark look under Smart Invert (review m3, IOS-12).
        #expect(flat.contains(".background(HostingTheme.token(DesignTokens.iosInCallStage), ignoresSafeAreaEdges: .horizontal) // The whole stage keeps its dark look under Smart Invert, like the video it stands for (IOS-12). .accessibilityIgnoresInvertColors() .environment(\\.colorScheme, .dark)"))
        // Review m4: the tile name is never in a fixed-height container; it is capped like a video label, with
        // the large content viewer, and the badge has its own corner.
        #expect(flat.contains("Text(row.name) .font(.subheadline.weight(.semibold)) .dynamicTypeSize(...DynamicTypeSize.accessibility1) .padding(8) .frame(maxWidth: .infinity, minHeight: 96, alignment: .bottomLeading) .overlay(alignment: .topTrailing) { if row.isSelected {"))
        #expect(flat.contains(".background { RendererProbe(key: row.id, slot: .stage, ledger: ledger) }"))
        #expect(flat.contains(".accessibilityShowsLargeContentViewer()"))
        #expect(!flat.contains(".frame(height: 96)"))
        // Review m1: the panel shows its own style, renderer and feedback readouts at every detent.
        #expect(flat.contains("let coverage = PanelPresentationPolicy.coverage(resolved, detent: adapter.detent)"))
        #expect(flat.components(separatedBy: "HostingPanelReadouts(presenter: presenter, feedback: feedback, adapter: adapter, resolved: resolved)").count - 1 == 2)
        for id in ["panel.readout.style", "panel.readout.renderers", "panel.readout.feedback", "panel.readout.refresh"] {
            #expect(root.contains(".accessibilityIdentifier(\"\(id)\")"), "missing panel readout \(id)")
        }
        // Review ISSUE 5: labels new in WP1-3b1 resolve through the String Catalog.
        for key in ["Layout Panel", "Stage Readouts", "Refresh Readouts"] {
            #expect(root.contains("ConclaveStrings.text(\"\(key)\")"), "\(key)")
            #expect(!root.contains("Button(\"\(key)\")") && !root.contains("Section(\"\(key)\")"), "\(key)")
        }
        // Review ISSUE 6: Rapid Replacement goes through the timed path.
        #expect(flat.contains("private func rapidPanels(_ presenter: NativeHostingPresenter) { let now = hostingUptime() presenter.presentPanel(.participants, from: .call, at: now) presenter.presentPanel(.settings, from: .settings, at: now) presenter.presentPanel(.participants, from: .more, at: now) }"))
        // Tiles keyed by row over renderer probes, dark by environment and tokens, opted out of Smart Invert.
        #expect(flat.contains("ForEach(presenter.rowsState.rows) { row in HostingStageTile(row: row, ledger: presenter.renderers) }"))
        #expect(flat.contains("RendererProbe(key: row.id, slot: .stage, ledger: ledger)"))
        #expect(flat.contains(".accessibilityIdentifier(\"stage.tile.\\(row.id)\") .accessibilityIgnoresInvertColors()"))
        #expect(flat.contains(".environment(\\.colorScheme, .dark)"))
        #expect(!root.contains("preferredColorScheme(.dark)"))
        #expect(flat.contains("Text(\"Inert stage \\(identity ?? \"attaching\"); instances \\(lifetime.creations)\") .accessibilityIdentifier(\"fixture.stage\")"))
        // Readouts refresh only on appear and on request; the sheet host and shell replace the old modifier.
        #expect(flat.contains("Text(verbatim: presenter.renderers.summary())"))
        #expect(flat.contains("Button(ConclaveStrings.text(\"Refresh Readouts\")) { refresh += 1 } .accessibilityIdentifier(\"stage.renderers.refresh\")"))
        #expect(flat.contains("NativePanelSheetHost(coordinator: presenter.panels, adapter: panelHost, window: window)"))
        #expect(flat.contains("presenter.openTimer.firstFrame(presentationID: presentation.request.presentationID, at: hostingUptime())"))
        #expect(flat.contains("Button(ConclaveStrings.text(\"Layout Panel\")) { presenter.presentPanel(.layout, from: .call, at: hostingUptime()) }"))
        #expect(flat.contains(".pickerStyle(.inline)"))
        #expect(flat.contains("get: { adapter.draft(for: presentationID) }, set: { adapter.setDraft($0, for: presentationID) }"))
        #expect(flat.contains(".onChange(of: focused) { _, isFocused in if isFocused { promoteToLarge() } }"))
        // Every accepted identifier keeps its name, and the new ones are present.
        for id in ["panel.open.participants", "panel.open.settings", "panel.rapid", "panel.replace", "panel.cancelPending",
                   "panel.resetDuringDismissal", "panel.identity", "panel.selectedCount", "panel.input", "feedback.status",
                   "feedback.complete", "feedback.duplicate", "feedback.gesture", "feedback.preference", "feedback.suspend",
                   "feedback.coalesced", "feedback.remount", "fixture.resetSession", "hosting.details", "hosting.selectedCount",
                   "hosting.reset", "hosting.close", "fixture.stage", "panel.open.layout", "stage.renderers",
                   "stage.renderers.refresh", "panel.style", "panel.openLatency"] {
            #expect(root.contains("\"\(id)\""), "missing identifier \(id)")
        }
        // The fixture Done keeps Q12's trailing placement, and the feedback consumer stays at the root background.
        #expect(flat.contains("ToolbarItem(placement: .topBarTrailing) { Button(\"Done\", action: onClose)"))
        #expect(flat.contains(".modifier(ConclaveFeedbackConsumer(delivery: feedback, mount: consumerMount))"))
        #expect(!panelCode(root).contains(".confirmationAction"))
    }

    @Test func componentGalleryRefilesMeasurementsAfterALongTextSwitch() throws {
        // WP1-2a r3 residual R1: rows whose layout ignores Long Text never report again after the switch.
        let flat = panelNormalized(try panelSource("Sources/Conclave/DesignSystem/iOS/NativeComponentGallery.swift"))
        #expect(flat.contains(".onChange(of: key) { _, newKey in ledger.refile(id: id, to: newKey) }"))
        #expect(flat.contains("func refile(id: String, to key: String) { if shown[key] == nil, let height = latestShown[id] { shown[key] = height } if ideal[key] == nil, let height = latestIdeal[id] { ideal[key] = height } update(key) }"))
        #expect(flat.contains("action: { ledger.reportShown(key, id: id, $0) }"))
        #expect(flat.contains("action: { ledger.reportIdeal(key, id: id, $0) }"))
        #expect(flat.contains("latestShown[id] = height") && flat.contains("latestIdeal[id] = height"))
    }

    @Test func androidStageIsAFixedSiblingAndTheHostOwnsPanels() throws {
        let root = try panelSource("Sources/Conclave/Skip/ui/AppRoot.kt")
        let flat = panelNormalized(root)
        // The stage is never a lazy-list item; it follows the controls Scaffold inside one Column.
        #expect(!root.contains("item(key = \"stage\")"))
        #expect(flat.contains("NativeHostingStageStrip(rows, lifetime) // A system-surface strip behind the navigation bar"))
        #expect(flat.contains("Spacer(Modifier.fillMaxWidth().background(MaterialTheme.colorScheme.surface) .windowInsetsBottomHeight(WindowInsets.navigationBars))"))
        #expect(flat.contains("contentWindowInsets = WindowInsets.safeDrawing.only(WindowInsetsSides.Top + WindowInsetsSides.Horizontal)"))
        #expect(flat.contains("Box(Modifier.fillMaxSize().semantics { testTagsAsResourceId = true }) { NativePanelHost("))
        #expect(flat.contains("CompositionLocalProvider(LocalRendererLedger provides presenter.renderers)"))
        #expect(flat.contains("BackHandler(enabled = panelState.current == null)"))
        #expect(flat.contains("NativeIconRasterBinding(icons, fixtureEligible && panelState.current == null)"))
        #expect(flat.contains("bottomStripInCall = NATIVE_HOSTING_STRIP_REACHES_BOTTOM_EDGE"))
        #expect(flat.contains("private const val NATIVE_HOSTING_STRIP_REACHES_BOTTOM_EDGE = false"))
        // Tiles take only their row; the probe is keyed by row, and the mini tile probe by presentation.
        #expect(flat.contains("key(row.id) { NativeHostingStageTile(row, Modifier.weight(1f)) }"))
        #expect(flat.contains("RendererProbe(key = row.id, slot = RendererSlot.stage, modifier = Modifier.fillMaxSize())"))
        #expect(flat.contains("RendererProbe(key = \"mini:$session:${request.presentationID}\", slot = RendererSlot.miniTile,"))
        // Review ISSUE 3: every root invoker may take focus back in touch mode.
        for tag in ["panel.open.participants", "panel.open.settings", "panel.open.layout", "panel.rapid"] {
            #expect(flat.contains("focus.invoked(\"\(tag)\")") && flat.contains(".panelInvoker(focus, \"\(tag)\"))"), "\(tag)")
        }
        #expect(!root.contains("focusRequester(focus.requester("))
        for tag in ["panel.style", "stage.renderers", "stage.compositions", "panel.mounts", "panel.openLatency", "stage.renderers.refresh",
                    "stage.tile.${row.id}", "fixture.stage", "panel.layout.$option", "panel.readout.style", "panel.readout.renderers",
                    "panel.readout.compositions", "panel.readout.feedback", "panel.readout.refresh"] {
            #expect(root.contains("testTag(\"\(tag)\")"), "missing tag \(tag)")
        }
        // Review m2: the system surface fills the horizontal insets; the dark strip itself is never inset-padded.
        #expect(flat.contains("Box( Modifier.fillMaxWidth().background(MaterialTheme.colorScheme.surface) .windowInsetsPadding(WindowInsets.safeDrawing.only(WindowInsetsSides.Horizontal)) ) { HostingTheme(inCall = true) { Column( Modifier.fillMaxWidth().background(Color(DesignTokens.androidExtendedStage)) .padding(horizontal = 16.dp, vertical = 12.dp),"))
        #expect(root.components(separatedBy: ".windowInsetsPadding(").count - 1 == 1)
        // Review m1 and ISSUE 7: the panel shows its own readouts, and both readout groups show tile compositions.
        #expect(flat.contains("NativeHostingPanelReadouts(presenter, delivery, readout) } }"))
        #expect(root.components(separatedBy: "presenter.renderers.compositionSummary()").count - 1 == 2)
        // Review ISSUE 5: labels new in WP1-3b1 are resources.
        #expect(flat.contains("Text(conclaveString(\"native_panel_open_layout\"))"))
        #expect(root.components(separatedBy: "Text(conclaveString(\"native_panel_refresh_readouts\"))").count - 1 == 2)
        #expect(!root.contains("Text(\"Layout panel\")") && !root.contains("Text(\"Refresh readouts\")"))
        // Review ISSUE 6: Rapid Replacement goes through the timed path.
        #expect(flat.contains("private fun rapidPanels(presenter: NativeHostingPresenter) { val now = hostingUptime() presenter.presentPanel(MeetingPanel.participants, from = PanelInvoker.call, at = now) presenter.presentPanel(MeetingPanel.settings, from = PanelInvoker.settings, at = now) presenter.presentPanel(MeetingPanel.participants, from = PanelInvoker.more, at = now) }"))
        let host = panelNormalized(try panelSource("Sources/Conclave/Skip/ui/call/panels/NativePanelHost.kt"))
        // The stage is the first child of one Row, and the coverage reaches only its container.
        #expect(host.contains("Row(Modifier.fillMaxSize()) {"))
        #expect(host.contains(".semantics { if (covered) hideFromAccessibility() } .focusProperties { onEnter = { if (covered) cancelFocusChange() } } .focusGroup() ) { stage(coverage) }"))
        #expect(host.contains("if (!state.isDismissing) { key(state.session, request.presentationID) { panel(state.session, request, decision, InCallPageVariant.Overlay) } }"))
        #expect(host.contains("SideEffect { lifetime.acknowledgeAbsent() }"))
        #expect(host.contains("PredictiveBackHandler(enabled = request != null && !state.isDismissing)"))
        #expect(host.contains("if (back.commit()) panels.dismiss(cancelPending = true)"))
        #expect(host.contains("back.cancel() throw cancelled"))
        #expect(host.contains(".focusProperties { onExit = { cancelFocusChange() } }"))
        // Review ISSUE 3: focus requests report their real outcome and retry until they land.
        #expect(host.contains("fun restore(tag: String): Boolean = requesters[tag]?.requestFocusOrFalse() ?: false"))
        #expect(host.contains("internal fun FocusRequester.requestFocusOrFalse(): Boolean = runCatching { requestFocus() }.getOrDefault(false)"))
        #expect(host.contains("requestPanelFocus(PANEL_FOCUS_ATTEMPTS, awaitFrame = { withFrameNanos { } }) { focus.restore(target) }"))
        #expect(host.contains("this.focusRequester(focus.requester(tag)).focusProperties { canFocus = true }"))
        #expect(!host.contains(".isSuccess"))
        let page = panelNormalized(try panelSource("Sources/Conclave/Skip/ui/call/panels/InCallPage.kt"))
        #expect(page.contains(".semantics { paneTitle = title; isTraversalGroup = true }"))
        #expect(page.contains("Modifier.testTag(\"panel.title\").focusRequester(titleFocus).focusable()"))
        #expect(page.contains("requestPanelFocus(PANEL_FOCUS_ATTEMPTS, awaitFrame = { withFrameNanos { } }) { titleFocus.requestFocusOrFalse() }"))
        #expect(!page.contains("runCatching"))
        #expect(page.contains("Icon(ConclaveIcons.ArrowBackFill0, contentDescription = conclaveString(\"native_panel_back_to_call\"))"))
        #expect(page.contains("Icon(ConclaveIcons.CloseFill0, contentDescription = conclaveString(\"native_panel_close\", title))"))
        #expect(page.contains("HostingTheme(inCall = appearance == PanelAppearance.inCall)"))
        #expect(!page.contains("160.dp"))
        let tile = panelNormalized(try panelSource("Sources/Conclave/Skip/ui/call/panels/CallMiniTile.kt"))
        #expect(tile.contains(".border(callMiniTileBorderWidthDp(model.speaking).dp, borderColor, shape)"))
        #expect(tile.contains("if (model.speaking) stateDescription = speakingLabel"))
        #expect(tile.contains(".clickable(onClickLabel = returnLabel, role = Role.Button, onClick = onReturnToCall)"))
        #expect(tile.contains(".testTag(\"call.miniTile\")"))
        let rows = panelNormalized(try panelSource("Sources/Conclave/Skip/ui/hosting/NativeHostingRows.kt"))
        #expect(rows.contains("return NativeHostingRows(state, previous).also { cached = it }"))
        #expect(rows.contains("No Skip collection is // declared stable"))
        let probe = panelNormalized(try panelSource("Sources/Conclave/Skip/ui/hosting/RendererProbe.kt"))
        #expect(probe.contains("isOpaque = true setLayerType(LAYER_TYPE_HARDWARE, null)"))
        #expect(probe.contains("staticCompositionLocalOf<RendererIdentityLedger?> { null }"))
        #expect(probe.contains("check(Looper.myLooper() == Looper.getMainLooper())"))
    }

    @Test func wp1PanelSourcesStayFlatDashFreeAndLocalized() throws {
        let touched = [
            "Sources/Conclave/Features/Meeting/Panels/PanelPresentationPolicy.swift",
            "Sources/Conclave/Features/Meeting/Panels/RendererIdentityLedger.swift",
            "Sources/Conclave/Features/Meeting/Panels/PanelHostAdapter.swift",
            "Sources/Conclave/Features/Meeting/Panels/PanelShell+iOS.swift",
            "Sources/Conclave/Features/Meeting/Panels/NativePanelSheet+iOS.swift",
            "Sources/Conclave/App/Hosting/NativeHostingPresenter.swift",
            "Sources/Conclave/App/Hosting/RendererProbe+iOS.swift",
            "Sources/Conclave/App/PlatformRoot+iOS.swift",
            "Sources/Conclave/DesignSystem/iOS/NativeComponentGallery.swift",
            "Sources/Conclave/Skip/ui/AppRoot.kt",
            "Sources/Conclave/Skip/ui/call/panels/NativePanelHost.kt",
            "Sources/Conclave/Skip/ui/call/panels/PanelBackProgress.kt",
            "Sources/Conclave/Skip/ui/call/panels/InCallPage.kt",
            "Sources/Conclave/Skip/ui/call/panels/CallMiniTile.kt",
            "Sources/Conclave/Skip/ui/hosting/NativeHostingRows.kt",
            "Sources/Conclave/Skip/ui/hosting/RendererProbe.kt",
            "Tests/ConclaveTests/Skip/PanelStageBridgeTests.kt",
            "Android/app/src/main/res/values/strings.xml",
        ]
        for file in touched {
            let text = try panelSource(file)
            #expect(!text.contains("\u{2013}") && !text.contains("\u{2014}"), "\(file) contains an en or em dash")
            #expect(!text.lowercased().contains("gradient"), "\(file) mentions a gradient")
            for pattern in ["FloatingToolbar", "ButtonGroup", "dynamicLightColorScheme", "dynamicDarkColorScheme", "@Stable", "@Immutable"] {
                #expect(!text.contains(pattern), "\(file) uses \(pattern)")
            }
            // The gallery's iOS 26 system-prominent specimens are the sanctioned glass entry (2a scan covers them).
            if !file.hasSuffix("NativeComponentGallery.swift") {
                for pattern in ["glassEffect", "GlassEffectContainer", "GlassStyle", "glassProminent", "ultraThinMaterial", "thinMaterial",
                                "regularMaterial", "thickMaterial", "ultraThickMaterial"] {
                    #expect(!text.contains(pattern), "\(file) uses \(pattern)")
                }
            }
            #expect(panelMatches(#"(UIColor|Color)\(\s*(red:|\.sRGB|0x)"#, in: text).isEmpty, "\(file) builds a color from a literal")
        }
        // iOS: every new catalog key exists with a comment and manual extraction.
        let catalog = try #require(try JSONSerialization.jsonObject(with: Data(panelSource("Sources/Conclave/Resources/Localizable.xcstrings").utf8)) as? [String: Any])
        let strings = try #require(catalog["strings"] as? [String: Any])
        var keys = Set<String>()
        for file in ["Sources/Conclave/Features/Meeting/Panels/PanelShell+iOS.swift", "Sources/Conclave/App/PlatformRoot+iOS.swift"] {
            keys.formUnion(panelMatches(#"ConclaveStrings\.(?:text|format|machineReadable)\(\s*"((?:[^"\\]|\\.)*)""#, in: try panelSource(file)).map { $0[0] })
        }
        #expect(keys.isSuperset(of: ["Close %@", "Participants", "Settings", "Layout", "Grid", "Spotlight", "Sidebar",
                                     "Layout Panel", "Stage Readouts", "Refresh Readouts"]))
        for key in keys {
            let entry = strings[key] as? [String: Any]
            #expect((entry?["comment"] as? String)?.isEmpty == false, "uncommented or missing key: \(key)")
            #expect(entry?["extractionState"] as? String == "manual", "\(key)")
        }
        // Android: every panel string the Compose files name exists in the app module, in sentence case.
        let xml = try panelSource("Android/app/src/main/res/values/strings.xml")
        var used = Set<String>()
        for file in ["Sources/Conclave/Skip/ui/AppRoot.kt", "Sources/Conclave/Skip/ui/call/panels/InCallPage.kt",
                     "Sources/Conclave/Skip/ui/call/panels/CallMiniTile.kt", "Sources/Conclave/Skip/ui/call/panels/NativePanelHost.kt"] {
            used.formUnion(panelMatches(#""(native_panel_[a-z0-9_]+)""#, in: try panelSource(file)).map { $0[0] })
        }
        let defined = Set(panelMatches(#"<string name="(native_panel_[a-z0-9_]+)""#, in: xml).map { $0[0] })
        #expect(used.count == 13 && used == defined, "\(used.symmetricDifference(defined).sorted())")
        for file in ["Sources/Conclave/Skip/ui/call/panels/InCallPage.kt", "Sources/Conclave/Skip/ui/call/panels/CallMiniTile.kt",
                     "Sources/Conclave/Skip/ui/call/panels/NativePanelHost.kt"] {
            #expect(panelMatches(#"Text\(\s*""#, in: try panelSource(file)).isEmpty, "\(file) has a literal Text")
        }
    }

    @Test func pseudolocalesAreEnabledOnTheDebugBuildTypeOnly() throws {
        let gradle = panelNormalized(try panelSource("Android/app/build.gradle.kts"))
        #expect(gradle.contains("buildTypes { debug { isPseudoLocalesEnabled = true } release {"))
        #expect(gradle.components(separatedBy: "isPseudoLocalesEnabled").count - 1 == 1)
    }
}

// MARK: WP1-3b1 source helpers

private func panelPackageRoot() -> URL {
    URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
}

private func panelSource(_ packageRelativePath: String) throws -> String {
    try String(contentsOf: panelPackageRoot().appendingPathComponent(packageRelativePath), encoding: .utf8)
}

/// Source text with `//` comments removed, so a scan for an API name reads code only.
private func panelCode(_ text: String) -> String {
    text.replacingOccurrences(of: #"//[^\n]*"#, with: "", options: .regularExpression)
}

/// Collapses every run of whitespace to one space, so pins fail only when the code changes.
private func panelNormalized(_ text: String) -> String {
    text.split(whereSeparator: { $0.isWhitespace }).joined(separator: " ")
}

/// Package-relative Swift paths under a directory, sorted.
private func panelSourceFiles(under directory: String) throws -> [String] {
    let root = panelPackageRoot()
    let prefix = root.path + "/"
    return try FileManager.default.contentsOfDirectory(at: root.appendingPathComponent(directory), includingPropertiesForKeys: nil)
        .filter { $0.pathExtension == "swift" }
        .map { $0.path.hasPrefix(prefix) ? String($0.path.dropFirst(prefix.count)) : $0.path }
        .sorted()
}

private func panelMatches(_ pattern: String, in text: String) -> [[String]] {
    guard let regex = try? NSRegularExpression(pattern: pattern) else { return [["invalid pattern"]] }
    let ns = text as NSString
    return regex.matches(in: text, range: NSRange(location: 0, length: ns.length)).map { match in
        (1..<match.numberOfRanges).map { index in
            let range = match.range(at: index)
            return range.location == NSNotFound ? "" : ns.substring(with: range)
        }
    }
}
#endif
