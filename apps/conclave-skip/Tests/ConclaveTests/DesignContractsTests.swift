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
        panels.didDismiss(session: 1, presentationID: first.presentationID)
        #expect(panels.snapshot.current == first)
        panels.present(.settings, from: .settings)
        let middle = panels.snapshot.pending
        #expect(panels.snapshot.current == first)
        #expect(panels.snapshot.isDismissing)
        panels.present(.participants, from: .more)
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

        #expect(panels.snapshot.isDismissing && panels.snapshot.current == shown.request)
    }

    @Test func adapterBindingLossKeepsThePendingReplacement() throws {
        let panels = PanelCoordinator(session: 1)
        let adapter = NativePanelHostAdapter()
        panels.present(.participants, from: .call)
        adapter.synchronize(panels)
        let shown = try #require(adapter.sheetItem)

        panels.present(.settings, from: .settings)
        let pending = try #require(panels.snapshot.pending)
        adapter.sheetBindingLost(shown, coordinator: panels)
        #expect(panels.snapshot.pending == pending)
        #expect(adapter.sheetClosing == shown && adapter.sheetItem == nil)

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

        adapter.synchronize(panels)
        #expect(panels.snapshot.current == latest && !panels.snapshot.isDismissing)
        #expect(adapter.sheetItem == NativePanelPresentation(session: 1, request: latest))
        #expect(adapter.sheetClosing == nil)

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

        adapter.sheetBindingLost(first, coordinator: panels)
        adapter.sheetDidDismiss(first, coordinator: panels)
        adapter.sheetBindingLost(nil, coordinator: panels)
        adapter.sheetDidDismiss(nil, coordinator: panels)
        #expect(adapter.sheetItem == second && adapter.sheetClosing == nil)
        #expect(panels.snapshot.current == second.request && !panels.snapshot.isDismissing)

        panels.reset(session: 2)
        adapter.synchronize(panels)
        #expect(adapter.sheetClosing == second && adapter.sheetItem == nil)
        panels.present(.participants, from: .more)
        let fresh = try #require(panels.snapshot.current)
        adapter.sheetDidDismiss(second, coordinator: panels)
        #expect(panels.snapshot.current == fresh)
        #expect(adapter.sheetItem == NativePanelPresentation(session: 2, request: fresh))
    }

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

        adapter.promoteToLarge()
        #expect(adapter.detent == .large)
        adapter.promoteToLarge()
        #expect(adapter.detent == .large)
        adapter.selectDetent(.medium)

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

        panels.present(.chat, from: .call)
        adapter.synchronize(panels)
        adapter.sheetDidDismiss(adapter.sheetClosing, coordinator: panels)
        #expect(adapter.sheetItem?.request.panel == .chat)
        #expect(adapter.detent == .large)
        adapter.selectDetent(.medium)
        #expect(adapter.detent == .large)

        panels.dismiss(cancelPending: true)
        adapter.synchronize(panels)
        adapter.sheetDidDismiss(adapter.sheetClosing, coordinator: panels)
        #expect(adapter.sheetItem == nil)
        adapter.selectDetent(.medium)
        adapter.promoteToLarge()
        #expect(adapter.detent == .large)

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

        adapter.setDraft("Other", for: first + 100)
        #expect(adapter.draft(for: first + 100) == "")

        panels.present(.participants, from: .more)
        adapter.synchronize(panels)
        #expect(adapter.draft(for: first) == "Sample")
        adapter.sheetDidDismiss(adapter.sheetClosing, coordinator: panels)
        #expect(adapter.drafts[first] == nil)
        let second = try #require(adapter.sheetItem).request.presentationID
        #expect(second > first && adapter.draft(for: second) == "")
        adapter.setDraft("Kept", for: second)

        adapter.sheetBindingLost(adapter.sheetItem, coordinator: panels)
        adapter.synchronize(panels)
        #expect(adapter.draft(for: second) == "Kept")
        adapter.sheetDidDismiss(adapter.sheetClosing, coordinator: panels)
        #expect(adapter.drafts.isEmpty)

        panels.present(.settings, from: .settings)
        adapter.synchronize(panels)
        let third = try #require(adapter.sheetItem).request.presentationID
        adapter.setDraft("Gone", for: third)
        panels.reset(session: 2)
        adapter.synchronize(panels)
        #expect(adapter.drafts.isEmpty)

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

    @Test func inspectorReplacementAcknowledgesImmediatelyAndKeepsColumn() async throws {
        let panels = PanelCoordinator(session: 1)
        let adapter = NativePanelHostAdapter()
        panels.present(.participants, from: .call)
        adapter.synchronize(panels, style: .inspector)
        let first = try #require(panels.snapshot.current)
        #expect(adapter.style == .inspector)
        #expect(adapter.inspectorItem == NativePanelPresentation(session: 1, request: first))
        #expect(adapter.sheetItem == nil && adapter.sheetClosing == nil)

        panels.present(.settings, from: .settings)
        adapter.synchronize(panels, style: .inspector)
        let second = try #require(panels.snapshot.current)
        #expect(second.panel == .settings && second.presentationID > first.presentationID)
        #expect(!panels.snapshot.isDismissing && panels.snapshot.pending == nil)
        #expect(adapter.inspectorItem == NativePanelPresentation(session: 1, request: second))

        panels.present(.participants, from: .more)
        panels.present(.layout, from: .call)
        adapter.synchronize(panels, style: .inspector)
        #expect(panels.snapshot.current?.panel == .layout && !panels.snapshot.isDismissing)
        #expect(adapter.inspectorItem?.request == panels.snapshot.current && adapter.sheetItem == nil)

        await confirmation(expectedCount: 0) { changed in
            withObservationTracking { _ = adapter.inspectorItem; _ = adapter.sheetItem; _ = adapter.style; _ = adapter.drafts } onChange: { changed() }
            adapter.synchronize(panels, style: .inspector)
            adapter.synchronize(panels)
        }
    }

    @Test func inspectorCloseAcknowledgesAndCloses() throws {
        let panels = PanelCoordinator(session: 1)
        let adapter = NativePanelHostAdapter()
        panels.present(.settings, from: .settings)
        adapter.synchronize(panels, style: .inspector)
        let shown = try #require(adapter.inspectorItem)
        adapter.setDraft("Sample", for: shown.request.presentationID)
        #expect(adapter.draft(for: shown.request.presentationID) == "Sample")

        panels.dismiss(cancelPending: true)
        adapter.synchronize(panels, style: .inspector)
        #expect(panels.snapshot.current == nil && !panels.snapshot.isDismissing)
        #expect(adapter.inspectorItem == nil && adapter.drafts.isEmpty)

        panels.present(.participants, from: .call)
        adapter.synchronize(panels, style: .inspector)
        adapter.inspectorClosedByUser(panels)
        #expect(panels.snapshot.current == nil && adapter.inspectorItem == nil)

        panels.present(.participants, from: .call)
        adapter.synchronize(panels, style: .sheet)
        adapter.inspectorClosedByUser(panels)
        #expect(panels.snapshot.current != nil && !panels.snapshot.isDismissing && adapter.sheetItem != nil)
    }

    @Test func sheetToInspectorMigrationKeepsRequestWithoutAcknowledging() throws {
        let panels = PanelCoordinator(session: 1)
        let adapter = NativePanelHostAdapter()
        panels.present(.settings, from: .settings)
        adapter.synchronize(panels, style: .sheet)
        let sheet = try #require(adapter.sheetItem)
        adapter.setDraft("Draft", for: sheet.request.presentationID)
        let before = panels.snapshot

        adapter.synchronize(panels, style: .inspector)
        #expect(panels.snapshot == before)
        #expect(adapter.sheetItem == nil && adapter.sheetClosing == sheet && adapter.sheetClosingIsMigration)
        #expect(adapter.inspectorItem == sheet)
        #expect(adapter.draft(for: sheet.request.presentationID) == "Draft")

        adapter.sheetBindingLost(sheet, coordinator: panels)
        #expect(panels.snapshot == before)
        adapter.sheetDidDismiss(sheet, coordinator: panels)
        #expect(panels.snapshot == before)
        #expect(adapter.sheetClosing == nil && !adapter.sheetClosingIsMigration)
        #expect(adapter.inspectorItem == sheet && adapter.sheetItem == nil)
        #expect(adapter.draft(for: sheet.request.presentationID) == "Draft")
    }

    @Test func inspectorToSheetMigration() throws {
        let panels = PanelCoordinator(session: 1)
        let adapter = NativePanelHostAdapter()
        panels.present(.participants, from: .call)
        adapter.synchronize(panels, style: .inspector)
        let shown = try #require(adapter.inspectorItem)
        let id = shown.request.presentationID
        adapter.setDraft("Kept", for: id)
        let before = panels.snapshot

        adapter.synchronize(panels, style: .sheet)
        #expect(panels.snapshot == before)
        #expect(adapter.inspectorItem == nil && adapter.sheetItem == shown && adapter.sheetClosing == nil)
        #expect(adapter.detent == .medium && adapter.draft(for: id) == "Kept")

        adapter.synchronize(panels, style: .inspector)
        #expect(adapter.sheetClosingIsMigration && adapter.inspectorItem == shown)
        adapter.synchronize(panels, style: .sheet)
        #expect(adapter.inspectorItem == nil && adapter.sheetItem == nil)
        adapter.sheetDidDismiss(adapter.sheetClosing, coordinator: panels)
        #expect(adapter.sheetItem == shown && panels.snapshot == before && adapter.draft(for: id) == "Kept")
    }

    @Test func migrationDuringRealDismissalWaitsForAcknowledgment() throws {
        let panels = PanelCoordinator(session: 1)
        let adapter = NativePanelHostAdapter()
        panels.present(.participants, from: .call)
        adapter.synchronize(panels, style: .sheet)
        let first = try #require(adapter.sheetItem)
        panels.present(.settings, from: .settings)
        adapter.synchronize(panels, style: .sheet)
        #expect(adapter.sheetClosing == first && !adapter.sheetClosingIsMigration)

        adapter.synchronize(panels, style: .inspector)
        #expect(adapter.inspectorItem == nil && adapter.sheetClosing == first && panels.snapshot.isDismissing)

        adapter.sheetDidDismiss(first, coordinator: panels)
        let second = try #require(panels.snapshot.current)
        #expect(second.panel == .settings && !panels.snapshot.isDismissing)
        #expect(adapter.inspectorItem == NativePanelPresentation(session: 1, request: second) && adapter.sheetItem == nil)

        let other = PanelCoordinator(session: 1)
        let host = NativePanelHostAdapter()
        other.present(.participants, from: .call)
        host.synchronize(other, style: .sheet)
        let shown = try #require(host.sheetItem)
        other.dismiss(cancelPending: true)
        host.synchronize(other, style: .inspector)
        #expect(host.sheetClosing == shown && !host.sheetClosingIsMigration && other.snapshot.isDismissing)
        host.sheetBindingLost(shown, coordinator: other)
        #expect(other.snapshot.isDismissing && host.inspectorItem == nil)
        host.sheetDidDismiss(shown, coordinator: other)
        #expect(other.snapshot.current == nil && host.inspectorItem == nil && host.sheetClosing == nil)
    }

    @Test func resetDuringMigrationIgnoresStaleCallbacks() throws {
        let panels = PanelCoordinator(session: 1)
        let adapter = NativePanelHostAdapter()
        panels.present(.settings, from: .settings)
        adapter.synchronize(panels, style: .sheet)
        let sheet = try #require(adapter.sheetItem)
        adapter.setDraft("Old", for: sheet.request.presentationID)
        adapter.synchronize(panels, style: .inspector)
        #expect(adapter.sheetClosingIsMigration)
        panels.reset(session: 2)
        adapter.synchronize(panels, style: .inspector)
        #expect(adapter.inspectorItem == nil && adapter.drafts.isEmpty)
        panels.present(.participants, from: .more)
        adapter.synchronize(panels, style: .inspector)
        let fresh = try #require(panels.snapshot.current)
        #expect(adapter.inspectorItem == NativePanelPresentation(session: 2, request: fresh))

        adapter.sheetBindingLost(sheet, coordinator: panels)
        adapter.sheetDidDismiss(sheet, coordinator: panels)
        #expect(panels.snapshot.current == fresh && !panels.snapshot.isDismissing)
        #expect(adapter.inspectorItem == NativePanelPresentation(session: 2, request: fresh))
        #expect(adapter.sheetClosing == nil && !adapter.sheetClosingIsMigration)
        adapter.sheetDidDismiss(sheet, coordinator: panels)
        adapter.sheetBindingLost(sheet, coordinator: panels)
        #expect(panels.snapshot.current == fresh && !panels.snapshot.isDismissing)
    }

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

            let sheet = panel == .layout || panel == .effects
            let android = PanelPresentationPolicy.resolve(request(panel), window: androidPhone, platform: .android)
            #expect(android.style == (sheet ? .bottomSheet : .overlay), "\(panel)")
            #expect(android.showsMiniTile == !sheet, "\(panel)")
            #expect(android.detents.isEmpty && android.initialDetent == nil && android.paneWidth == 0, "\(panel)")
            #expect(PanelPresentationPolicy.coverage(android, detent: nil) == (sheet ? .partial : .full), "\(panel)")
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

        let table: [(MeetingPanel, Bool, [PanelDetent], PanelDetent, PanelAppearance)] = [
            (.chat, true, [.large], .large, .inCall),
            (.participants, false, [.medium, .large], .medium, .system),
            (.transcript, true, [.large], .large, .system),
            (.activities, false, [.medium, .large], .medium, .system),
            (.effects, false, [.short, .large], .short, .inCall),
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

            #expect(!composer || !resolved.detents.contains(.medium), "\(panel)")
        }
    }

    @Test func panelPolicyLayoutAndEffectsAreInCall() {

        let invokers: [PanelInvoker] = [.call, .more, .settings]
        for panel in MeetingPanel.allCases {
            for invoker in invokers {
                let dark = panel == .chat || panel == .layout || panel == .effects
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

        let chat = PanelPresentationPolicy.resolve(request(.chat), window: Self.phonePortrait, platform: .iOS)
        #expect(PanelPresentationPolicy.coverage(chat, detent: .medium) == .full)
        let inspector = PanelPresentationPolicy.resolve(request(.participants), window: Self.padFullScreen, platform: .iOS, sideStylesEnabled: true)
        #expect(inspector.style == .inspector && PanelPresentationPolicy.coverage(inspector, detent: .medium) == PanelStageCoverage.none)
        let overlay = PanelPresentationPolicy.resolve(request(.participants), window: Self.phonePortrait, platform: .android)
        #expect(PanelPresentationPolicy.coverage(overlay, detent: nil) == .full)
        let side = PanelPresentationPolicy.resolve(request(.participants), window: PanelPresentationPolicy.androidWindow(width: 1280, height: 800), platform: .android, sideStylesEnabled: true)
        #expect(side.style == .sidePane && PanelPresentationPolicy.coverage(side, detent: nil) == PanelStageCoverage.none)

        let bottom = PanelPresentation(style: .bottomSheet, detents: [], initialDetent: nil, appearance: .inCall,
                                       showsMiniTile: false, paneWidth: 0, hasBottomComposer: false)
        #expect(PanelPresentationPolicy.coverage(bottom, detent: nil) == .partial)
        let layoutSheet = PanelPresentationPolicy.resolve(request(.layout), window: PanelPresentationPolicy.androidWindow(width: 360, height: 800),
                                                          platform: .android)
        #expect(layoutSheet == bottom)
        #expect(PanelPresentationPolicy.coverage(layoutSheet, detent: .large) == .partial)
    }

    @Test func panelPolicySideStylesFlagCoversBothBranches() {

        let tablet = PanelPresentationPolicy.androidWindow(width: 1280, height: 800)
        let landscapePhone = PanelPresentationPolicy.androidWindow(width: 891, height: 411)
        let portraitPhone = PanelPresentationPolicy.androidWindow(width: 411, height: 891)
        let windows: [(PanelWindow, PanelPlatform, PanelHostStyle, PanelHostStyle)] = [

            (Self.padFullScreen, .iOS, .sheet, .inspector),
            (Self.phoneLandscape, .iOS, .sheet, .sheet),
            (Self.phonePortrait, .iOS, .sheet, .sheet),
            (tablet, .android, .overlay, .sidePane),
            (landscapePhone, .android, .overlay, .overlay),
            (portraitPhone, .android, .overlay, .overlay),
        ]
        for (window, platform, off, on) in windows {
            for panel in MeetingPanel.allCases {

                let sheet = platform == .android && (panel == .layout || panel == .effects)
                let expectedOff: PanelHostStyle = sheet && off == .overlay ? .bottomSheet : off
                let expectedOn: PanelHostStyle = sheet && on == .overlay ? .bottomSheet : on
                #expect(PanelPresentationPolicy.style(window: window, platform: platform, panel: panel, sideStylesEnabled: false) == expectedOff)
                #expect(PanelPresentationPolicy.style(window: window, platform: platform, panel: panel, sideStylesEnabled: true) == expectedOn)
                #expect(PanelPresentationPolicy.resolve(request(panel), window: window, platform: platform, sideStylesEnabled: false).style == expectedOff)
                #expect(PanelPresentationPolicy.resolve(request(panel), window: window, platform: platform, sideStylesEnabled: true).style == expectedOn)
            }
        }
        let inspector = PanelPresentationPolicy.resolve(request(.settings), window: Self.padFullScreen, platform: .iOS, sideStylesEnabled: true)
        #expect(inspector.paneWidth == 360 && inspector.detents.isEmpty && inspector.initialDetent == nil && !inspector.showsMiniTile)
        let pane = PanelPresentationPolicy.resolve(request(.settings), window: tablet, platform: .android, sideStylesEnabled: true)
        #expect(pane.paneWidth == 360 && !pane.showsMiniTile)
        let fallback = PanelPresentationPolicy.resolve(request(.settings), window: Self.padFullScreen, platform: .iOS, sideStylesEnabled: false)
        #expect(fallback.style == .sheet && fallback.paneWidth == 0 && fallback.detents == [.medium, .large])
    }

    @Test func panelPolicyRegularRegularUsesInspectorOrSidePane() {

        #expect(PanelPresentationPolicy.sideStylesEnabled)
        let inspector = PanelPresentationPolicy.resolve(request(.participants), window: Self.padFullScreen, platform: .iOS)
        #expect(inspector.style == .inspector && inspector.paneWidth == 360 && inspector.detents.isEmpty && inspector.initialDetent == nil)
        #expect(PanelPresentationPolicy.coverage(inspector, detent: nil) == PanelStageCoverage.none)
        let tablet = PanelPresentationPolicy.androidWindow(width: 1280, height: 800)
        let side = PanelPresentationPolicy.resolve(request(.participants), window: tablet, platform: .android)
        #expect(side.style == .sidePane && side.paneWidth == 360 && !side.showsMiniTile)
        #expect(PanelPresentationPolicy.coverage(side, detent: nil) == PanelStageCoverage.none)

        #expect(PanelPresentationPolicy.resolve(request(.participants), window: PanelPresentationPolicy.androidWindow(width: 891, height: 411),
                                                platform: .android).style == .overlay)
        #expect(PanelPresentationPolicy.resolve(request(.participants), window: Self.phoneLandscape, platform: .iOS).style == .sheet)
        #expect(PanelPresentationPolicy.resolve(request(.participants), window: Self.phonePortrait, platform: .iOS).style == .sheet)

        for width in [600.0, 720.0, 839.9] {
            let medium = PanelPresentationPolicy.androidWindow(width: width, height: 1000)
            #expect(PanelPresentationPolicy.style(window: medium, platform: .android, panel: .participants) == .overlay, "\(width)")
            #expect(PanelPresentationPolicy.style(window: medium, platform: .android, panel: .layout) == .bottomSheet, "\(width)")
            #expect(PanelPresentationPolicy.style(window: medium, platform: .android, panel: .effects) == .bottomSheet, "\(width)")
        }

        for (window, platform) in [(Self.padFullScreen, PanelPlatform.iOS), (tablet, PanelPlatform.android)] {
            for panel in MeetingPanel.allCases {
                let explicit = PanelPresentationPolicy.resolve(request(panel), window: window, platform: platform,
                                                               sideStylesEnabled: PanelPresentationPolicy.sideStylesEnabled)
                #expect(PanelPresentationPolicy.resolve(request(panel), window: window, platform: platform) == explicit)
                #expect(PanelPresentationPolicy.style(window: window, platform: platform, panel: panel) == explicit.style)
                #expect(explicit.style == (platform == .iOS ? .inspector : .sidePane), "\(panel)")
            }
        }
    }

    @Test func panelPolicyStageInteractionAndTextFocus() throws {
        for panel in MeetingPanel.allCases {
            let sheet = PanelPresentationPolicy.resolve(request(panel), window: Self.phonePortrait, platform: .iOS)
            let composer = PanelPresentationPolicy.hasBottomComposer(panel)
            let interactive: PanelDetent? = composer ? nil : (panel == .effects ? .short : .medium)
            #expect(PanelPresentationPolicy.stageInteractiveDetent(sheet) == interactive, "\(panel)")
            let overlay = PanelPresentationPolicy.resolve(request(panel), window: Self.phonePortrait, platform: .android)
            #expect(PanelPresentationPolicy.stageInteractiveDetent(overlay) == nil, "\(panel)")

            let panels = PanelCoordinator(session: 1)
            let adapter = NativePanelHostAdapter()
            panels.present(panel, from: .call)
            adapter.synchronize(panels)
            adapter.selectDetent(.medium)
            #expect(adapter.detent == (sheet.detents.contains(.medium) ? PanelDetent.medium : sheet.initialDetent), "\(panel)")
            adapter.promoteToLarge()
            #expect(adapter.detent == .large, "\(panel)")
        }
    }

    @Test func wp13cBottomSheetRowsForLayoutAndEffects() {
        let compact = PanelPresentationPolicy.androidWindow(width: 360, height: 800)
        let tablet = PanelPresentationPolicy.androidWindow(width: 1280, height: 800)
        for panel in [MeetingPanel.layout, MeetingPanel.effects] {
            for invoker in [PanelInvoker.call, PanelInvoker.more, PanelInvoker.settings] {
                for isAccessibilitySize in [false, true] {
                    let sheet = PanelPresentationPolicy.resolve(request(panel, invoker), window: compact, platform: .android,
                                                                isAccessibilitySize: isAccessibilitySize)

                    #expect(sheet.style == .bottomSheet && sheet.appearance == .inCall && !sheet.showsMiniTile, "\(panel)")
                    #expect(PanelPresentationPolicy.coverage(sheet, detent: nil) == .partial, "\(panel)")
                    #expect(sheet.detents.isEmpty && sheet.initialDetent == nil && sheet.paneWidth == 0 && !sheet.hasBottomComposer)

                    #expect(PanelPresentationPolicy.bottomSheetSkipsPartialState(panel, isAccessibilitySize: isAccessibilitySize)
                            == (panel == .effects || isAccessibilitySize), "\(panel)")
                }
            }
            #expect(PanelPresentationPolicy.resolve(request(panel), window: tablet, platform: .android).style == .sidePane)

            let ios = PanelPresentationPolicy.resolve(request(panel), window: Self.phonePortrait, platform: .iOS)
            #expect(ios.style == .sheet && ios.detents == (panel == .effects ? [.short, .large] : [.medium, .large]))
        }
        #expect(PanelPresentationPolicy.bottomSheetMaxWidth == 640)
        for panel in MeetingPanel.allCases where panel != .layout && panel != .effects {
            #expect(!PanelPresentationPolicy.usesAndroidBottomSheet(panel), "\(panel)")
            #expect(PanelPresentationPolicy.resolve(request(panel), window: compact, platform: .android).style == .overlay, "\(panel)")
        }
    }

    @Test func rendererLedgerSerialsAndStaleRelease() {
        let ledger = RendererIdentityLedger()
        #expect(ledger.summary() == "stage c=0 r=0 l=0 lost=0 back=0 | mini c=0 r=0 l=0 lost=0 back=0")
        let avery = ledger.created(key: "avery", slot: .stage)
        #expect(avery == 1 && ledger.serial(for: "avery") == 1)
        ledger.released(key: "avery", serial: 0, slot: .stage)
        ledger.released(key: "avery", serial: avery, slot: .miniTile)
        ledger.released(key: "robin", serial: avery, slot: .stage)
        #expect(ledger.serial(for: "avery") == 1)
        #expect(ledger.counts(.stage) == RendererIdentityCounts(created: 1, released: 0, live: 1, surfaceLost: 0, surfaceRestored: 0))
        ledger.released(key: "avery", serial: avery, slot: .stage)
        ledger.released(key: "avery", serial: avery, slot: .stage)
        #expect(ledger.serial(for: "avery") == nil)
        #expect(ledger.counts(.stage) == RendererIdentityCounts(created: 1, released: 1, live: 0, surfaceLost: 0, surfaceRestored: 0))
        let again = ledger.created(key: "avery", slot: .stage)
        #expect(again == 2 && ledger.serial(for: "avery") == 2)

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
        ledger.surfaceLost(key: "robin", serial: 1, slot: .stage)
        ledger.surfaceRestored(key: "taylor", serial: 3, slot: .miniTile)
        ledger.surfaceLost(key: "missing", serial: 4, slot: .stage)
        #expect(ledger.serial(for: "robin") == 2)
        #expect(ledger.counts(.stage) == RendererIdentityCounts(created: 3, released: 0, live: 3, surfaceLost: 1, surfaceRestored: 1))
        #expect(ledger.summary() == "stage c=3 r=0 l=3 lost=1 back=1 | mini c=0 r=0 l=0 lost=0 back=0 | avery#1 robin#2 taylor#3")

        ledger.composed(key: "robin")
        ledger.composed(key: "robin")
        #expect(ledger.compositions(for: "robin") == 2 && ledger.compositions(for: "avery") == 0)
        ledger.composed(key: "avery")
        #expect(ledger.compositionSummary() == "compositions avery=1 robin=2")
        #expect(RendererIdentityLedger().compositionSummary() == "compositions none")
        #expect(ledger.counts(.stage) == RendererIdentityCounts(created: 3, released: 0, live: 3, surfaceLost: 1, surfaceRestored: 1))

        ledger.released(key: "robin", serial: 2, slot: .stage)
        ledger.surfaceLost(key: "robin", serial: 2, slot: .stage)
        #expect(ledger.counts(.stage).surfaceLost == 1)
    }

    @Test func rendererLedgerOverlappingHostsBalanceInEitherReleaseOrder() {

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

            ledger.surfaceLost(key: "avery", serial: first, slot: .stage)
            ledger.surfaceLost(key: "avery", serial: second, slot: .stage)
            #expect(ledger.counts(.stage).surfaceLost == 1)
            ledger.released(key: "avery", serial: second, slot: .stage)
            ledger.released(key: "avery", serial: second, slot: .stage)
            ledger.released(key: "avery", serial: first, slot: .stage)
            #expect(ledger.counts(.stage) == RendererIdentityCounts(created: 2, released: 2, live: 0, surfaceLost: 1, surfaceRestored: 0))
            #expect(ledger.serial(for: "avery") == nil)
        }

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

    @Test func wp1PanelSourcesStayFlatDashFreeAndLocalized() throws {
        let touched = [
            "Sources/Conclave/Features/Meeting/Panels/MeetingPanel.swift",
            "Sources/Conclave/Features/Meeting/Panels/PanelCoordinator.swift",
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
            "Sources/Conclave/Skip/ui/call/panels/LayoutSheetHost.kt",
            "Sources/Conclave/Features/Meeting/Panels/LayoutPanelPresenter.swift",
            "Sources/Conclave/Skip/ui/hosting/NativeHostingRows.kt",
            "Sources/Conclave/Skip/ui/hosting/RendererProbe.kt",
            "Tests/ConclaveTests/Skip/PanelStageBridgeTests.kt",
            "Android/app/src/main/res/values/strings.xml",
        ]
        for file in touched {
            let text = try panelSource(file)

            #expect(panelMatches(#"(UIColor|Color)\(\s*(red:|\.sRGB|0x)"#, in: text).isEmpty, "\(file) builds a color from a literal")
        }

        let catalog = try #require(try JSONSerialization.jsonObject(with: Data(panelSource("Sources/Conclave/Resources/Localizable.xcstrings").utf8)) as? [String: Any])
        let strings = try #require(catalog["strings"] as? [String: Any])
        var keys = Set<String>()
        for file in ["Sources/Conclave/Features/Meeting/Panels/PanelShell+iOS.swift", "Sources/Conclave/App/PlatformRoot+iOS.swift"] {
            keys.formUnion(panelMatches(#"ConclaveStrings\.(?:text|format|machineReadable)\(\s*"((?:[^"\\]|\\.)*)""#, in: try panelSource(file)).map { $0[0] })
        }
        #expect(keys.isSuperset(of: ["Close %@", "Participants", "Settings", "Layout", "Grid", "Spotlight", "Sidebar",
                                     "Layout Panel", "Stage Readouts", "Refresh Readouts", "Compact Width Override"]))
        for key in keys {
            let entry = strings[key] as? [String: Any]
            #expect(entry != nil, "missing String Catalog key: \(key)")
            #expect(entry?["comment"] == nil, "unexpected translator prose: \(key)")
            #expect(entry?["extractionState"] as? String == "manual", "\(key)")
        }

        let xml = try panelSource("Android/app/src/main/res/values/strings.xml")
        var used = Set<String>()
        for file in ["Sources/Conclave/Skip/ui/AppRoot.kt", "Sources/Conclave/Skip/ui/call/panels/InCallPage.kt",
                     "Sources/Conclave/Skip/ui/call/panels/CallMiniTile.kt", "Sources/Conclave/Skip/ui/call/panels/NativePanelHost.kt"] {
            used.formUnion(panelMatches(#""(native_panel_[a-z0-9_]+)""#, in: try panelSource(file)).map { $0[0] })
        }
        let defined = Set(panelMatches(#"<string name="(native_panel_[a-z0-9_]+)""#, in: xml).map { $0[0] })

        #expect(used.count == 14 && used == defined, "\(used.symmetricDifference(defined).sorted())")
    }

    @Test func pseudolocalesAreEnabledOnTheDebugBuildTypeOnly() throws {
        let gradle = panelNormalized(try panelSource("Android/app/build.gradle.kts"))
        #expect(gradle.contains("buildTypes { debug { isPseudoLocalesEnabled = true"))
        #expect(gradle.components(separatedBy: "isPseudoLocalesEnabled").count - 1 == 1)
    }
}

private func panelPackageRoot() -> URL {
    URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
}

private func panelSource(_ packageRelativePath: String) throws -> String {
    try String(contentsOf: panelPackageRoot().appendingPathComponent(packageRelativePath), encoding: .utf8)
}

private func panelCode(_ text: String) -> String {
    text.replacingOccurrences(of: #"//[^\n]*"#, with: "", options: .regularExpression)
}

private func panelNormalized(_ text: String) -> String {
    text.split(whereSeparator: { $0.isWhitespace }).joined(separator: " ")
}

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
