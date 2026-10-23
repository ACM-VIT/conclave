#if !SKIP
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
}
#endif
