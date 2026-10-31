#if !SKIP
import Foundation
import Observation
import Testing
@testable import Conclave

@MainActor
struct NativeHostingTests {
    @Test
    func rowActionReplacesOnlyItsRowAndKeepsTheOldSnapshot() async {
        let presenter = NativeHostingPresenter()
        let before = presenter.rowsState
        await confirmation(expectedCount: 1) { changed in
            withObservationTracking { _ = presenter.rowsState } onChange: { changed() }
            presenter.setRowSelected(id: "robin", selected: true)
        }
        let after = presenter.rowsState
        #expect(after.revision == before.revision + 1)
        #expect(after.selectedCount == 1)
        #expect(after.rows.map { $0.id } == before.rows.map { $0.id })
        #expect(after.rows[0] == before.rows[0])
        #expect(after.rows[2] == before.rows[2])
        #expect(after.rows[1].isSelected)
        #expect(!before.rows[1].isSelected)
        #expect(presenter.showsDetails)
    }

    @Test
    func duplicateAndUnknownRowActionsDoNotPublish() async {
        let presenter = NativeHostingPresenter()
        presenter.setRowSelected(id: "avery", selected: true)
        let before = presenter.rowsState
        await confirmation(expectedCount: 0) { changed in
            withObservationTracking { _ = presenter.rowsState } onChange: { changed() }
            presenter.setRowSelected(id: "avery", selected: true)
            presenter.setRowSelected(id: "missing", selected: true)
        }
        #expect(presenter.rowsState == before)
    }

    @Test
    func scalarChangesDoNotPublishRowsAndDuplicateScalarActionsAreQuiet() async {
        let presenter = NativeHostingPresenter()
        let before = presenter.rowsState
        await confirmation(expectedCount: 0) { rowsChanged in
            withObservationTracking { _ = presenter.rowsState } onChange: { rowsChanged() }
            await confirmation(expectedCount: 1) { scalarChanged in
                withObservationTracking { _ = presenter.showsDetails } onChange: { scalarChanged() }
                presenter.setDetailsVisible(false)
            }
        }
        #expect(!presenter.showsDetails)
        #expect(presenter.rowsState == before)
        await confirmation(expectedCount: 0) { changed in
            withObservationTracking { _ = presenter.showsDetails } onChange: { changed() }
            presenter.setDetailsVisible(false)
        }
    }

    @Test
    func resetPublishesOneCoherentSnapshotAndThenBecomesANoOp() async {
        let presenter = NativeHostingPresenter()
        presenter.setRowSelected(id: "avery", selected: true)
        presenter.setRowSelected(id: "taylor", selected: true)
        let before = presenter.rowsState
        #expect(before.selectedCount == 2)
        await confirmation(expectedCount: 1) { changed in
            withObservationTracking { _ = presenter.rowsState } onChange: { changed() }
            presenter.resetSelection()
        }
        #expect(presenter.rowsState.revision == before.revision + 1)
        #expect(presenter.rowsState.selectedCount == 0)
        #expect(presenter.rowsState.rows.allSatisfy { !$0.isSelected })
        #expect(before.rows[0].isSelected)
        await confirmation(expectedCount: 0) { changed in
            withObservationTracking { _ = presenter.rowsState } onChange: { changed() }
            presenter.resetSelection()
        }
    }

    @Test
    func previewOwnersAreIndependent() {
        let first = NativeHostingPresenter()
        let second = NativeHostingPresenter()
        first.setRowSelected(id: "robin", selected: true)
        first.setDetailsVisible(false)
        #expect(second.rowsState.revision == 0)
        #expect(second.rowsState.selectedCount == 0)
        #expect(second.showsDetails)
    }

    @Test
    func presenterOwnsIndependentRendererLedger() {
        let first = NativeHostingPresenter()
        let second = NativeHostingPresenter()
        #expect(first.renderers !== second.renderers)
        #expect(first.openTimer !== second.openTimer)
        for key in ["avery", "robin", "taylor"] { _ = first.renderers.created(key: key, slot: .stage) }
        let mini = first.renderers.created(key: "mini:1:1", slot: .miniTile)
        first.renderers.released(key: "mini:1:1", serial: mini, slot: .miniTile)
        first.presentPanel(.participants, from: .call, at: 1)
        #expect(first.openTimer.firstFrame(presentationID: 1, at: 1.5) == 500)
        #expect(second.renderers.summary() == "stage c=0 r=0 l=0 lost=0 back=0 | mini c=0 r=0 l=0 lost=0 back=0")
        #expect(second.renderers.serial(for: "avery") == nil)
        #expect(second.openTimer.summary() == "none")

        #expect(second.renderers.created(key: "avery", slot: .stage) == 1)
        #expect(first.renderers.serial(for: "avery") == 1)
    }

    @Test
    func stageTilesDeriveFromRowsWithoutNewObservableState() async throws {
        let presenter = NativeHostingPresenter()

        let stored = Set(Mirror(reflecting: presenter).children.compactMap { $0.label })
        #expect(stored == ["panels", "renderers", "openTimer", "_feedbackState", "_completedActions", "_nextActionID",
                           "_lastCompletion", "_showsDetails", "_rowsState", "_$observationRegistrar"], "\(stored.sorted())")

        await confirmation(expectedCount: 0) { changed in
            withObservationTracking {
                _ = presenter.rowsState; _ = presenter.feedbackState; _ = presenter.panels.snapshot; _ = presenter.showsDetails
            } onChange: { changed() }
            for key in ["avery", "robin", "taylor"] {
                let serial = presenter.renderers.created(key: key, slot: .stage)
                presenter.renderers.composed(key: key)
                presenter.renderers.surfaceLost(key: key, serial: serial, slot: .stage)
                presenter.renderers.surfaceRestored(key: key, serial: serial, slot: .stage)
            }
            presenter.openTimer.openRequested(presentationID: 9, at: 1)
            _ = presenter.openTimer.firstFrame(presentationID: 9, at: 2)
        }
        #expect(presenter.renderers.serial(for: "taylor") == 3)
    }

    @Test
    func panelOpenTimerKeysByPresentationAndConsumesOnce() throws {
        let presenter = NativeHostingPresenter()
        #expect(presenter.openTimer.summary() == "none")
        presenter.presentPanel(.participants, from: .call, at: 10)
        let first = try #require(presenter.panels.snapshot.current).presentationID

        presenter.presentPanel(.participants, from: .more, at: 11)
        #expect(presenter.openTimer.firstFrame(presentationID: first, at: 10.25) == 250)
        #expect(presenter.openTimer.firstFrame(presentationID: first, at: 12) == -1)
        #expect(presenter.openTimer.summary() == "presentation \(first) 250 ms")

        presenter.presentPanel(.participants, from: .call, at: 12.5)
        #expect(presenter.openTimer.firstFrame(presentationID: first, at: 13) == -1)
        #expect(presenter.openTimer.summary() == "presentation \(first) 250 ms")

        presenter.presentPanel(.settings, from: .settings, at: 20)
        let pending = try #require(presenter.panels.snapshot.pending).presentationID
        #expect(pending > first)
        #expect(presenter.openTimer.firstFrame(presentationID: pending, at: 20.0004) == 0)

        presenter.openTimer.openRequested(presentationID: 99, at: 5)
        #expect(presenter.openTimer.firstFrame(presentationID: 99, at: 4) == 0)
    }

    @Test
    func panelOpenTimerDropsStartsTheCoordinatorNoLongerHolds() throws {

        let presenter = NativeHostingPresenter()
        presenter.presentPanel(.participants, from: .call, at: 1)
        presenter.presentPanel(.settings, from: .settings, at: 1)
        presenter.presentPanel(.participants, from: .more, at: 1)
        let shown = try #require(presenter.panels.snapshot.current).presentationID
        let pending = try #require(presenter.panels.snapshot.pending).presentationID
        #expect(pending == shown + 2)
        #expect(presenter.openTimer.startCount == 2)
        #expect(presenter.openTimer.firstFrame(presentationID: shown + 1, at: 2) == -1)
        #expect(presenter.openTimer.firstFrame(presentationID: shown, at: 1.1) == 100)
        presenter.panels.didDismiss(session: 1, presentationID: shown)
        #expect(presenter.openTimer.firstFrame(presentationID: pending, at: 1.3) == 300)

        presenter.presentPanel(.settings, from: .more, at: 5)
        let cancelled = try #require(presenter.panels.snapshot.pending).presentationID
        presenter.panels.dismiss(cancelPending: true)
        presenter.panels.didDismiss(session: 1, presentationID: pending)
        presenter.presentPanel(.layout, from: .call, at: 6)
        let layout = try #require(presenter.panels.snapshot.current).presentationID
        #expect(presenter.openTimer.firstFrame(presentationID: cancelled, at: 7) == -1)
        #expect(presenter.openTimer.firstFrame(presentationID: layout, at: 6.05) == 50)

        presenter.presentPanel(.settings, from: .more, at: 8)
        let reset = try #require(presenter.panels.snapshot.pending).presentationID
        presenter.resetFixtureSession()
        presenter.presentPanel(.participants, from: .call, at: 9)
        #expect(presenter.openTimer.firstFrame(presentationID: reset, at: 10) == -1)
        #expect(presenter.openTimer.startCount == 1)

        let timer = PanelOpenTimer()
        timer.openRequested(presentationID: 1, at: 0)
        timer.openRequested(presentationID: 2, at: 0)
        timer.discardStarts(keeping: [2, 7])
        #expect(timer.startCount == 1)
        #expect(timer.firstFrame(presentationID: 1, at: 1) == -1 && timer.firstFrame(presentationID: 2, at: 1) == 1000)
    }

    @Test
    func sessionReadoutStringsAreInTheCatalogs() throws {
        let catalog = try hostingSource("Sources/Conclave/Resources/Localizable.xcstrings")
        for key in ["Session Readout", "Identity", "Phase", "Outcome", "Controls", "Ledger", "Feedback", "Feedback Records"] {
            #expect(catalog.contains("\"\(key)\" : {"), "catalog misses \(key)")
        }
        let resources = try hostingSource("Android/app/src/main/res/values/strings.xml")
        #expect(resources.contains("<string name=\"sys_session_readout_title\">Session readout</string>"))
    }
}

private func hostingSource(_ packageRelativePath: String) throws -> String {
    let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
    return try String(contentsOf: root.appendingPathComponent(packageRelativePath), encoding: .utf8)
}

private func hostingFlat(_ text: String) -> String {
    text.split(whereSeparator: { $0.isWhitespace }).joined(separator: " ")
}

private func hostingSection(_ text: String, from start: String, to end: String) -> String? {
    guard let lower = text.range(of: start) else { return nil }
    let rest = text[lower.lowerBound...]
    guard let upper = rest.range(of: end, range: rest.index(lower.lowerBound, offsetBy: start.count)..<rest.endIndex) else { return nil }
    return String(text[lower.lowerBound..<upper.lowerBound])
}
#endif
