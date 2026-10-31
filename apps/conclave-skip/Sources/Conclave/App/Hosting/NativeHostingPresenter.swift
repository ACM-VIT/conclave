import Observation

struct NativeHostingRow: Equatable, Identifiable {
    let id: String
    let name: String
    let detail: String
    let isSelected: Bool
}

struct NativeHostingRowsState: Equatable {
    let revision: Int
    let selectedCount: Int
    let rows: [NativeHostingRow]
}

enum NativeHostingActionSource {
    case inAppOutcome, system, gesture
}

struct NativeHostingFeedbackState: Equatable {
    let session: Int
    let token: FeedbackToken
    let acceptedCount: Int
}

private struct NativeHostingCompletion {
    let actionID: Int
    let session: Int
    let kind: FeedbackKind
}

@MainActor
@Observable
final class NativeHostingPresenter {
    let panels = PanelCoordinator(session: 1)

    let renderers = RendererIdentityLedger()

    let openTimer = PanelOpenTimer()
    private(set) var feedbackState = NativeHostingFeedbackState(session: 1, token: .baseline, acceptedCount: 0)
    private var completedActions: Set<Int> = []
    private var nextActionID = 0
    private var lastCompletion: NativeHostingCompletion?
    private(set) var showsDetails = true
    private(set) var rowsState = NativeHostingRowsState(
        revision: 0,
        selectedCount: 0,
        rows: [
            NativeHostingRow(id: "avery", name: "Avery", detail: "Design", isSelected: false),
            NativeHostingRow(id: "robin", name: "Robin", detail: "Engineering", isSelected: false),
            NativeHostingRow(id: "taylor", name: "Taylor", detail: "Research", isSelected: false),
        ]
    )

    func setDetailsVisible(_ visible: Bool) {
        guard showsDetails != visible else { return }
        showsDetails = visible
    }

    func setRowSelected(id: String, selected: Bool) {
        guard let index = rowsState.rows.firstIndex(where: { $0.id == id }),
              rowsState.rows[index].isSelected != selected else { return }
        var rows = rowsState.rows
        let row = rows[index]
        rows[index] = NativeHostingRow(
            id: row.id, name: row.name, detail: row.detail, isSelected: selected
        )
        publishRows(rows)
    }

    func resetSelection() {
        guard rowsState.selectedCount > 0 else { return }
        publishRows(rowsState.rows.map { row in
            NativeHostingRow(id: row.id, name: row.name, detail: row.detail, isSelected: false)
        })
    }

    func presentPanel(_ panel: MeetingPanel, from invoker: PanelInvoker, at seconds: Double) {
        let before = panels.snapshot
        panels.present(panel, from: invoker)
        let state = panels.snapshot
        var held: [Int] = []
        if let current = state.current {
            held.append(current.presentationID)
        }
        if let pending = state.pending {
            held.append(pending.presentationID)
        }
        openTimer.discardStarts(keeping: held)
        guard state != before, let request = state.isDismissing ? state.pending : state.current else { return }
        openTimer.openRequested(presentationID: request.presentationID, at: seconds)
    }

    @discardableResult
    func completeFixtureAction(actionID: Int, expectedSession: Int, kind: FeedbackKind,
                               source: NativeHostingActionSource = .inAppOutcome) -> Bool {
        guard expectedSession == feedbackState.session, !completedActions.contains(actionID) else { return false }
        completedActions.insert(actionID)
        let token: FeedbackToken
        if source == .inAppOutcome && kind.isAsyncOutcome {
            token = FeedbackToken(sequence: feedbackState.token.sequence + 1, kind: kind)
        } else {
            token = feedbackState.token
        }
        feedbackState = NativeHostingFeedbackState(session: expectedSession, token: token,
            acceptedCount: feedbackState.acceptedCount + 1)
        return true
    }

    func completeNextFixtureAction(kind: FeedbackKind = .joined) {
        nextActionID += 1
        lastCompletion = NativeHostingCompletion(actionID: nextActionID, session: feedbackState.session, kind: kind)
        repeatLastFixtureCompletion()
    }

    func repeatLastFixtureCompletion() {
        guard let completion = lastCompletion else { return }
        completeFixtureAction(actionID: completion.actionID, expectedSession: completion.session, kind: completion.kind)
    }

    func resetFixtureSession() {
        let session = feedbackState.session + 1
        completedActions = []
        feedbackState = NativeHostingFeedbackState(session: session, token: .baseline, acceptedCount: 0)
        panels.reset(session: session)
    }

    private func publishRows(_ rows: [NativeHostingRow]) {
        guard rows != rowsState.rows else { return }
        rowsState = NativeHostingRowsState(
            revision: rowsState.revision + 1,
            selectedCount: rows.filter { $0.isSelected }.count,
            rows: rows
        )
    }
}

final class PanelOpenTimer {
    private var requested: [Int: Double] = [:]
    private(set) var lastPresentationID = 0
    private(set) var lastMilliseconds = -1

    var startCount: Int { requested.count }

    func openRequested(presentationID: Int, at seconds: Double) {
        if requested[presentationID] == nil {
            requested[presentationID] = seconds
        }
    }

    func discardStarts(keeping presentationIDs: [Int]) {
        var kept: [Int: Double] = [:]
        for presentationID in presentationIDs {
            if let start = requested[presentationID] {
                kept[presentationID] = start
            }
        }
        if kept.count != requested.count {
            requested = kept
        }
    }

    @discardableResult
    func firstFrame(presentationID: Int, at seconds: Double) -> Int {
        guard let start = requested[presentationID] else { return -1 }
        requested[presentationID] = nil
        var elapsed = (seconds - start) * 1000.0
        if elapsed < 0.0 {
            elapsed = 0.0
        }
        lastPresentationID = presentationID
        lastMilliseconds = Int(elapsed + 0.5)
        return lastMilliseconds
    }

    func summary() -> String {
        if lastMilliseconds < 0 {
            return "none"
        }
        return "presentation " + String(lastPresentationID) + " " + String(lastMilliseconds) + " ms"
    }
}
