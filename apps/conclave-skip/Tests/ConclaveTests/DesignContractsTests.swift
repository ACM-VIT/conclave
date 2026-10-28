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

        let policy = try panelSource("Sources/Conclave/Features/Meeting/Panels/PanelPresentationPolicy.swift")
        #expect(!policy.contains("func detentAfterTextFocus"))
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

    @Test func panelShellKeepsCloseTrailingAndScopesItsAppearance() throws {
        let shell = try panelSource("Sources/Conclave/Features/Meeting/Panels/PanelShell+iOS.swift")
        let flat = panelNormalized(panelCode(shell))
        #expect(shell.hasPrefix("#if os(iOS) && !SKIP\n"))

        #expect(flat.contains("ToolbarItem(placement: PanelShellToolbar.closePlacement) { PanelCloseButton(title: title, action: onClose) }"))

        #expect(flat.contains("if #available(iOS 27.0, *) { return .topBarPinnedTrailing } return .topBarTrailing"))
        #expect(!panelCode(shell).contains(".confirmationAction"))
        #expect(flat.components(separatedBy: ".keyboardShortcut(.cancelAction)").count - 1 == 2)
        #expect(flat.components(separatedBy: ".accessibilityIdentifier(\"panel.close\")").count - 1 == 2)

        #expect(flat.contains("if #available(iOS 26.0, *) { Button(role: .close, action: action)"))
        #expect(flat.contains("Image(systemName: ConclaveSymbols.xmark) .accessibilityHidden(true)"))

        #expect(flat.components(separatedBy: ".accessibilityLabel(ConclaveStrings.format(\"Close %@\", title))").count - 1 == 2)
        #expect(flat.contains("Button(role: .close, action: action) .keyboardShortcut(.cancelAction) .accessibilityLabel(ConclaveStrings.format(\"Close %@\", title))"))

        #expect(flat.contains(".navigationTitle(title) .navigationBarTitleDisplayMode(.inline) .modifier(PanelBarMinimization())"))
        #expect(flat.contains("if #available(iOS 27.0, *) { content.toolbarMinimizationBehavior(.never, for: .navigationBar) } else { content }"))
        #expect(flat.contains(".environment(\\.panelPromoteToLargeDetent, PanelPromoteToLargeDetentAction(action: onPromoteToLarge))"))

        #expect(flat.contains("if hostStyle == .inspector { content.environment(\\.colorScheme, scheme) } else { content .environment(\\.colorScheme, scheme) .preferredColorScheme(scheme) }"))
        #expect(flat.contains("presentation.appearance == .inCall ? .dark : AppearancePreference.shared.mode.colorScheme ?? systemScheme"))

        #expect(flat.contains("if hostStyle == .inspector { ToolbarItem(placement: .principal) { Text(title) .font(.headline) .accessibilityAddTraits(.isHeader) .accessibilityFocused($headingFocused) } }"))
        #expect(flat.contains(".accessibilityAction(.escape) { onClose() }"))
        #expect(flat.contains("guard hostStyle == .inspector else { return }"))
        #expect(flat.contains("headingFocused = true"))

        let root = panelCode(try panelSource("Sources/Conclave/App/PlatformRoot+iOS.swift"))
        #expect(!root.contains("toolbarMinimizationBehavior") && !root.contains("HostingSamplePanelBarMinimization"))
    }

    @Test func iosSheetHostFollowsThePolicyAndNeverCoversTheWindow() throws {
        let host = try panelSource("Sources/Conclave/Features/Meeting/Panels/NativePanelSheet+iOS.swift")
        let flat = panelNormalized(host)
        #expect(host.hasPrefix("#if os(iOS) && !SKIP\n"))

        #expect(flat.components(separatedBy: ".onChange(of: coordinator.snapshot, initial: true) { _, _ in adapter.synchronize(coordinator, style: style, isAccessibilitySize: accessibilitySize) }").count - 1 == 2)
        #expect(flat.components(separatedBy: ".onChange(of: style) { _, newStyle in adapter.synchronize(coordinator, style: newStyle, isAccessibilitySize: accessibilitySize) }").count - 1 == 2)
        #expect(flat.components(separatedBy: "let accessibilitySize = dynamicTypeSize.isAccessibilitySize").count - 1 == 2)
        #expect(flat.contains(".sheet(item: Binding(get: { style == .sheet ? adapter.sheetItem : nil }, set: { [captured] value in"))
        #expect(flat.contains("if value == nil { adapter.sheetBindingLost(captured, coordinator: coordinator) }"))
        #expect(flat.contains("adapter.sheetDidDismiss(captured, coordinator: coordinator)"))
        #expect(flat.components(separatedBy: "PanelPresentationPolicy.resolve(presentation.request, window: window, platform: .iOS, isAccessibilitySize: accessibilitySize)").count - 1 == 2)
        #expect(flat.contains(".presentationDetents(Set(resolved.detents.map { Self.systemDetent($0, shortHeight: shortHeight) }), selection: Binding("))
        #expect(flat.contains("set: { adapter.selectDetent(Self.panelDetent($0, shortHeight: shortHeight)) }"))

        #expect(flat.contains("case .short: return .height(CGFloat(shortHeight))"))
        #expect(flat.contains(".environment(\\.panelReportShortDetentHeight, PanelShortDetentHeightAction(action: { adapter.setShortDetentHeight($0) }))"))

        #expect(flat.contains(".modifier(PanelStageInteraction(upThrough: PanelPresentationPolicy.stageInteractiveDetent(resolved) .map { Self.systemDetent($0, shortHeight: shortHeight) }))"))
        #expect(flat.contains("content.presentationBackgroundInteraction(.enabled(upThrough: upThrough))"))

        #expect(flat.contains(".modifier(PanelCompactHeightRule(keepsSheet: PanelPresentationPolicy.keepsSheetInCompactHeight(resolved)))"))
        #expect(flat.contains("content.presentationCompactAdaptation(horizontal: .automatic, vertical: .sheet)"))

        var files = try panelSourceFiles(under: "Sources/Conclave/Features/Meeting/Panels")
        files.append("Sources/Conclave/App/PlatformRoot+iOS.swift")
        for file in files {
            let text = panelCode(try panelSource(file))
            for pattern in [".fullScreenCover", "presentationCornerRadius", "presentationBackground(", "UIScreen.main"] {
                #expect(!text.contains(pattern), "\(file) uses \(pattern)")
            }
        }

        let adapter = try panelSource("Sources/Conclave/Features/Meeting/Panels/PanelHostAdapter.swift")
        #expect(adapter.hasPrefix("#if !SKIP\n") && !adapter.contains("import SwiftUI"))
        #expect(!host.contains("final class"))
    }

    @Test func iosInspectorHostFollowsTheStyleAndNeverRethemesTheWindow() throws {
        let host = try panelSource("Sources/Conclave/Features/Meeting/Panels/NativePanelSheet+iOS.swift")
        let flat = panelNormalized(panelCode(host))

        #expect(flat.contains("PanelPresentationPolicy.style(window: window, platform: .iOS, panel: coordinator.snapshot.current?.panel ?? .participants)"))
        #expect(flat.components(separatedBy: "let style = nativePanelHostStyle(coordinator, window: window)").count - 1 == 2)
        #expect(flat.contains(".inspector(isPresented: Binding(get: { style == .inspector && adapter.inspectorItem != nil }, set: { presented in if !presented { adapter.inspectorClosedByUser(coordinator) } }))"))
        #expect(flat.contains("panelContent(presentation, resolved) .id(presentation.id) .inspectorColumnWidth(min: 320, ideal: CGFloat(PanelPresentationPolicy.paneWidth), max: 440)"))

        #expect(!flat.contains("preferredColorScheme") && !flat.contains(".fullScreenCover"))

        let root = try panelSource("Sources/Conclave/App/PlatformRoot+iOS.swift")
        let rootFlat = panelNormalized(panelCode(root))
        #expect(root.hasPrefix("#if DEBUG && os(iOS) && !SKIP\n"))
        #expect(rootFlat.contains("horizontalRegular: !compactOverride && horizontalSizeClass == .regular,"))
        #expect(rootFlat.contains("compactOverride ? .compact : horizontalSizeClass"))
        #expect(rootFlat.contains(".environment(\\.horizontalSizeClass, contentHorizontalSizeClass)"))
        #expect(rootFlat.contains("Toggle(ConclaveStrings.text(\"Compact Width Override\"), isOn: $compactOverride) .accessibilityIdentifier(\"panel.compactOverride\")"))

        #expect(rootFlat.contains(".onChange(of: panelHost.inspectorItem == nil) { _, closed in guard closed, panelHost.sheetItem == nil, presenter.panels.snapshot.current == nil, let lastInvoker else { return } focusedInvoker = lastInvoker }"))
        for invoker in ["participants", "settings", "layout", "rapid"] {
            #expect(rootFlat.contains("lastInvoker = .\(invoker)"), "\(invoker)")
            #expect(rootFlat.contains(".accessibilityFocused($focusedInvoker, equals: .\(invoker))"), "\(invoker)")
        }

        #expect(rootFlat.contains("guard let item = adapter.inspectorItem ?? adapter.sheetItem else"))
        #expect(rootFlat.contains("let detent = resolved.style == .sheet ? adapter.detent.rawValue : \"none\""))
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

        #expect(flat.contains("VStack(spacing: 0) { HostingStageStrip(lifetime: stageLifetime, presenter: presenter) .fixedSize(horizontal: false, vertical: true) List {"))

        #expect(flat.contains(".listStyle(.insetGrouped) } .modifier(NativePanelInspectorHost"))
        #expect(flat.contains(".modifier(NativePanelInspectorHost(coordinator: presenter.panels, adapter: panelHost, window: window) { presentation, resolved in HostingPanelContent(presenter: presenter, feedback: feedback, adapter: panelHost, presentation: presentation, resolved: resolved, systemScheme: systemScheme) }) .navigationTitle(\"Hosting Preview\")"))
        for pattern in ["safeAreaInset", ".overlay(alignment: .bottom", "ZStack {"] {
            #expect(!panelCode(root).contains(pattern), "the stage must stay a sibling: \(pattern)")
        }

        #expect(flat.contains(".background(HostingTheme.token(DesignTokens.iosInCallStage), ignoresSafeAreaEdges: .horizontal) .accessibilityIgnoresInvertColors() .environment(\\.colorScheme, .dark)"))

        #expect(flat.contains("Text(row.name) .font(.subheadline.weight(.semibold)) .dynamicTypeSize(...DynamicTypeSize.accessibility1) .padding(8) .frame(maxWidth: .infinity, minHeight: 96, alignment: .bottomLeading) .overlay(alignment: .topTrailing) { if row.isSelected {"))
        #expect(flat.contains(".background { RendererProbe(key: row.id, slot: .stage, ledger: ledger) }"))
        #expect(flat.contains(".accessibilityShowsLargeContentViewer()"))
        #expect(!flat.contains(".frame(height: 96)"))

        #expect(flat.contains("let coverage = PanelPresentationPolicy.coverage(resolved, detent: adapter.detent)"))
        #expect(flat.components(separatedBy: "HostingPanelReadouts(presenter: presenter, feedback: feedback, adapter: adapter, resolved: resolved)").count - 1 == 2)
        for id in ["panel.readout.style", "panel.readout.renderers", "panel.readout.feedback", "panel.readout.refresh"] {
            #expect(root.contains(".accessibilityIdentifier(\"\(id)\")"), "missing panel readout \(id)")
        }

        for key in ["Layout Panel", "Stage Readouts", "Refresh Readouts"] {
            #expect(root.contains("ConclaveStrings.text(\"\(key)\")"), "\(key)")
            #expect(!root.contains("Button(\"\(key)\")") && !root.contains("Section(\"\(key)\")"), "\(key)")
        }

        #expect(flat.contains("private func rapidPanels(_ presenter: NativeHostingPresenter) { let now = hostingUptime() presenter.presentPanel(.participants, from: .call, at: now) presenter.presentPanel(.settings, from: .settings, at: now) presenter.presentPanel(.participants, from: .more, at: now) }"))

        #expect(flat.contains("ForEach(presenter.rowsState.rows) { row in HostingStageTile(row: row, ledger: presenter.renderers) }"))
        #expect(flat.contains("RendererProbe(key: row.id, slot: .stage, ledger: ledger)"))
        #expect(flat.contains(".accessibilityIdentifier(\"stage.tile.\\(row.id)\") .accessibilityIgnoresInvertColors()"))
        #expect(flat.contains(".environment(\\.colorScheme, .dark)"))
        #expect(!root.contains("preferredColorScheme(.dark)"))
        #expect(flat.contains("Text(\"Inert stage \\(identity ?? \"attaching\"); instances \\(lifetime.creations)\") .accessibilityIdentifier(\"fixture.stage\")"))

        #expect(flat.contains("Text(verbatim: presenter.renderers.summary())"))
        #expect(flat.contains("Button(ConclaveStrings.text(\"Refresh Readouts\")) { refresh += 1 } .accessibilityIdentifier(\"stage.renderers.refresh\")"))
        #expect(flat.contains("NativePanelSheetHost(coordinator: presenter.panels, adapter: panelHost, window: window)"))
        #expect(flat.contains("presenter.openTimer.firstFrame(presentationID: presentation.request.presentationID, at: hostingUptime())"))
        #expect(flat.contains("Button(ConclaveStrings.text(\"Layout Panel\")) { lastInvoker = .layout presenter.presentPanel(.layout, from: .call, at: hostingUptime()) }"))
        #expect(flat.contains(".pickerStyle(.inline)"))
        #expect(flat.contains("get: { adapter.draft(for: presentationID) }, set: { adapter.setDraft($0, for: presentationID) }"))
        #expect(flat.contains(".onChange(of: focused) { _, isFocused in if isFocused { promoteToLarge() } }"))

        for id in ["panel.open.participants", "panel.open.settings", "panel.rapid", "panel.replace", "panel.cancelPending",
                   "panel.resetDuringDismissal", "panel.identity", "panel.selectedCount", "panel.input", "feedback.status",
                   "feedback.complete", "feedback.duplicate", "feedback.gesture", "feedback.preference", "feedback.suspend",
                   "feedback.coalesced", "feedback.remount", "fixture.resetSession", "hosting.details", "hosting.selectedCount",
                   "hosting.reset", "hosting.close", "fixture.stage", "panel.open.layout", "stage.renderers",
                   "stage.renderers.refresh", "panel.style", "panel.openLatency", "panel.compactOverride"] {
            #expect(root.contains("\"\(id)\""), "missing identifier \(id)")
        }

        #expect(flat.contains("ToolbarItem(placement: .topBarTrailing) { Button(\"Done\", action: onClose)"))
        #expect(flat.contains(".modifier(ConclaveFeedbackConsumer(delivery: feedback, mount: consumerMount))"))
        #expect(!panelCode(root).contains(".confirmationAction"))
    }

    @Test func componentGalleryRefilesMeasurementsAfterALongTextSwitch() throws {

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

        #expect(!root.contains("item(key = \"stage\")"))
        #expect(flat.contains("NativeHostingStageStrip(rows, lifetime) Spacer("))
        #expect(flat.contains("Spacer(Modifier.fillMaxWidth().background(MaterialTheme.colorScheme.surface) .windowInsetsBottomHeight(WindowInsets.navigationBars))"))
        #expect(flat.contains("contentWindowInsets = WindowInsets.safeDrawing.only(WindowInsetsSides.Top + WindowInsetsSides.Horizontal)"))
        #expect(flat.contains("Box(Modifier.fillMaxSize().semantics { testTagsAsResourceId = true }) { NativePanelHost("))
        #expect(flat.contains("CompositionLocalProvider(LocalRendererLedger provides presenter.renderers)"))
        #expect(flat.contains("BackHandler(enabled = panelState.current == null)"))
        #expect(flat.contains("NativeIconRasterBinding(icons, fixtureEligible && panelState.current == null)"))
        #expect(flat.contains("bottomStripInCall = NATIVE_HOSTING_STRIP_REACHES_BOTTOM_EDGE"))
        #expect(flat.contains("private const val NATIVE_HOSTING_STRIP_REACHES_BOTTOM_EDGE = false"))

        #expect(flat.contains("key(row.id) { NativeHostingStageTile(row, Modifier.weight(1f)) }"))
        #expect(flat.contains("RendererProbe(key = row.id, slot = RendererSlot.stage, modifier = Modifier.fillMaxSize())"))
        #expect(flat.contains("RendererProbe(key = \"mini:$session:${request.presentationID}\", slot = RendererSlot.miniTile,"))

        for tag in ["panel.open.participants", "panel.open.settings", "panel.open.layout", "panel.rapid"] {
            #expect(flat.contains("focus.invoked(\"\(tag)\")") && flat.contains(".panelInvoker(focus, \"\(tag)\"))"), "\(tag)")
        }
        #expect(!root.contains("focusRequester(focus.requester("))
        for tag in ["panel.style", "stage.renderers", "stage.compositions", "panel.mounts", "panel.openLatency", "stage.renderers.refresh",
                    "stage.tile.${row.id}", "fixture.stage", "panel.layout.$option", "panel.readout.style", "panel.readout.renderers",
                    "panel.readout.compositions", "panel.readout.feedback", "panel.readout.refresh"] {
            #expect(root.contains("testTag(\"\(tag)\")"), "missing tag \(tag)")
        }

        #expect(flat.contains("Box( Modifier.fillMaxWidth().background(MaterialTheme.colorScheme.surface) .windowInsetsPadding(WindowInsets.safeDrawing.only(WindowInsetsSides.Horizontal)) ) { HostingTheme(inCall = true) { Column( Modifier.fillMaxWidth().background(Color(DesignTokens.androidExtendedStage)) .padding(horizontal = 16.dp, vertical = 12.dp),"))
        #expect(root.components(separatedBy: ".windowInsetsPadding(").count - 1 == 1)

        #expect(flat.contains("NativeHostingPanelReadouts(presenter, delivery, readout) } }"))
        #expect(root.components(separatedBy: "presenter.renderers.compositionSummary()").count - 1 == 2)

        #expect(flat.contains("Text(conclaveString(\"native_panel_open_layout\"))"))
        #expect(root.components(separatedBy: "Text(conclaveString(\"native_panel_refresh_readouts\"))").count - 1 == 2)
        #expect(!root.contains("Text(\"Layout panel\")") && !root.contains("Text(\"Refresh readouts\")"))

        #expect(flat.contains("private fun rapidPanels(presenter: NativeHostingPresenter) { val now = hostingUptime() presenter.presentPanel(MeetingPanel.participants, from = PanelInvoker.call, at = now) presenter.presentPanel(MeetingPanel.settings, from = PanelInvoker.settings, at = now) presenter.presentPanel(MeetingPanel.participants, from = PanelInvoker.more, at = now) }"))
        let host = panelNormalized(try panelSource("Sources/Conclave/Skip/ui/call/panels/NativePanelHost.kt"))

        #expect(host.contains("Row(Modifier.fillMaxSize()) {"))
        #expect(host.contains(".semantics { if (covered) hideFromAccessibility() } .focusProperties { onEnter = { if (covered) cancelFocusChange() } } .focusGroup() ) { stage(coverage) }"))

        #expect(host.contains("if (!state.isDismissing) { key(state.session, request.presentationID) { movablePanel(InCallPageVariant.Overlay, decision) } }"))
        #expect(host.contains("if (!state.isDismissing) { key(state.session, request.presentationID) { movablePanel(InCallPageVariant.SidePane, decision) } }"))

        #expect(host.contains("val movablePanel = remember(state.session, request?.presentationID) { val session = state.session val shown = request if (shown == null) null else movableContentOf { variant: InCallPageVariant, current: PanelHostDecision -> CompositionLocalProvider(LocalPanelPageStack provides pages) {"))
        #expect(host.contains("val pages = remember(state.session, request?.presentationID) { PanelPageStack() }"))
        #expect(host.contains("Box(Modifier.fillMaxSize().graphicsLayer { translationX = pages.backProgress.pageTranslationDp * 1.dp.toPx() }) { latestPanel(session, shown, current, variant) }"))
        #expect(host.contains("val latestPanel by rememberUpdatedState(panel)"))

        #expect(host.contains("stage(coverage) } if (sidePane && request != null && decision != null && movablePanel != null) { PanelSidePane(decision, back, rightToLeft) {"))
        #expect(host.contains("Modifier.width(decision.paneWidthDp.dp).fillMaxHeight().focusGroup()"))
        #expect(host.contains("SideEffect { readout.update(decision, overlay || sidePane || bottomSheet) }"))
        #expect(host.contains("val panelVisible = overlay || sidePane || bottomSheet LaunchedEffect(panelVisible) { val target = focus.tracker.update(panelVisible) ?: return@LaunchedEffect"))

        #expect(host.contains("val bottomSheet = decision != null && decision.style == PanelHostStyle.bottomSheet && request != null"))
        #expect(host.contains("val coverage = if ((overlay || bottomSheet) && decision != null) decision.coverage else PanelStageCoverage.none"))
        #expect(host.contains("key(state.session, request.presentationID) { val session = state.session LayoutSheetHost( dismissing = state.isDismissing, skipPartiallyExpanded = decision.skipsPartialSheet, inCallAppearance = decision.inCallAppearance, onDismissRequest = { panels.dismiss(cancelPending = false) }, ) {"))
        let sheetHost = panelNormalized(try panelSource("Sources/Conclave/Skip/ui/call/panels/LayoutSheetHost.kt"))
        #expect(sheetHost.contains("@OptIn(ExperimentalMaterial3Api::class) @Composable internal fun LayoutSheetHost("))
        #expect(sheetHost.contains("semantics { testTagsAsResourceId = true }"))
        #expect(sheetHost.contains("properties = ModalBottomSheetProperties(isAppearanceLightStatusBars = lightBars, isAppearanceLightNavigationBars = lightBars),"))
        #expect(host.components(separatedBy: "panel(state.session, request, decision,").count - 1 == 0)
        #expect(host.contains("SideEffect { lifetime.acknowledgeAbsent() }"))
        #expect(host.contains("PredictiveBackHandler(enabled = request != null && !state.isDismissing)"))

        #expect(host.contains("val action = panelBackAction(pages) val progress = if (action == PanelBackAction.PopPage) pages.backProgress else back"))
        #expect(host.contains("if (progress.commit()) performPanelBack(action, pages, panels)"))
        #expect(host.contains("progress.cancel() throw cancelled"))
        #expect(host.contains("PanelBackAction.ClosePanel -> panels.dismiss(cancelPending = true)"))
        #expect(host.contains(".focusProperties { onExit = { cancelFocusChange() } }"))

        #expect(host.contains("fun restore(tag: String): Boolean = requesters[tag]?.requestFocusOrFalse() ?: false"))
        #expect(host.contains("internal fun FocusRequester.requestFocusOrFalse(): Boolean = runCatching { requestFocus() }.getOrDefault(false)"))
        #expect(host.contains("requestPanelFocus(PANEL_FOCUS_ATTEMPTS, awaitFrame = { withFrameNanos { } }) { focus.restore(target) }"))
        #expect(host.contains("this.focusRequester(focus.requester(tag)).focusProperties { canFocus = true }"))
        #expect(!host.contains(".isSuccess"))
        let page = panelNormalized(try panelSource("Sources/Conclave/Skip/ui/call/panels/InCallPage.kt"))
        #expect(page.contains(".semantics { paneTitle = title; isTraversalGroup = true }"))
        #expect(page.contains("Modifier.testTag(\"panel.title\").focusRequester(titleFocus).focusable()"))
        #expect(page.contains("requestPanelFocus(PANEL_FOCUS_ATTEMPTS, awaitFrame = { withFrameNanos { } }) { titleFocus.requestFocusOrFalse() }"))

        #expect(page.contains("LaunchedEffect(Unit) { if (variant != InCallPageVariant.Sheet) {"))
        #expect(!page.contains("if (variant == InCallPageVariant.Overlay) { LaunchedEffect(Unit)"))
        #expect(page.contains("contentWindowInsets = if (sidePane) WindowInsets.safeDrawing.only(sidePaneSides) else WindowInsets.safeDrawing,"))
        #expect(page.contains("val sidePaneSides = WindowInsetsSides.Top + WindowInsetsSides.End + WindowInsetsSides.Bottom"))
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
        #expect(rows.contains("private val people: List<NativeHostingPerson> = buildList {"))
        #expect(!rows.contains("@Stable") && !rows.contains("@Immutable"))
        let probe = panelNormalized(try panelSource("Sources/Conclave/Skip/ui/hosting/RendererProbe.kt"))
        #expect(probe.contains("isOpaque = true setLayerType(LAYER_TYPE_HARDWARE, null)"))
        #expect(probe.contains("staticCompositionLocalOf<RendererIdentityLedger?> { null }"))
        #expect(probe.contains("check(Looper.myLooper() == Looper.getMainLooper())"))
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
            #expect(!text.contains("\u{2013}") && !text.contains("\u{2014}"), "\(file) contains an en or em dash")
            #expect(!text.lowercased().contains("gradient"), "\(file) mentions a gradient")
            for pattern in ["FloatingToolbar", "ButtonGroup", "dynamicLightColorScheme", "dynamicDarkColorScheme", "@Stable", "@Immutable"] {
                #expect(!text.contains(pattern), "\(file) uses \(pattern)")
            }

            if !file.hasSuffix("NativeComponentGallery.swift") {
                for pattern in ["glassEffect", "GlassEffectContainer", "GlassStyle", "glassProminent", "ultraThinMaterial", "thinMaterial",
                                "regularMaterial", "thickMaterial", "ultraThickMaterial"] {
                    #expect(!text.contains(pattern), "\(file) uses \(pattern)")
                }
            }
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
        for file in ["Sources/Conclave/Skip/ui/call/panels/InCallPage.kt", "Sources/Conclave/Skip/ui/call/panels/CallMiniTile.kt",
                     "Sources/Conclave/Skip/ui/call/panels/NativePanelHost.kt", "Sources/Conclave/Skip/ui/call/panels/LayoutSheetHost.kt"] {
            #expect(panelMatches(#"Text\(\s*""#, in: try panelSource(file)).isEmpty, "\(file) has a literal Text")
        }
    }

    @Test func pseudolocalesAreEnabledOnTheDebugBuildTypeOnly() throws {
        let gradle = panelNormalized(try panelSource("Android/app/build.gradle.kts"))
        #expect(gradle.contains("buildTypes { debug { isPseudoLocalesEnabled = true } release {"))
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
