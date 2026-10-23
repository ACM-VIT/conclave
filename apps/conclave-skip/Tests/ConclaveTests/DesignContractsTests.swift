#if !SKIP
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
}
#endif
