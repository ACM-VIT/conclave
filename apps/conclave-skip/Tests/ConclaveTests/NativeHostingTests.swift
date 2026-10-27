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

    // MARK: WP1-3b1 (PS 6.5, 14.1)

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
        // Serials are per ledger, so a second preview starts at 1 again.
        #expect(second.renderers.created(key: "avery", slot: .stage) == 1)
        #expect(first.renderers.serial(for: "avery") == 1)
    }

    @Test
    func stageTilesDeriveFromRowsWithoutNewObservableState() async throws {
        let presenter = NativeHostingPresenter()
        // The presenter gained only two constants: no stage tile, renderer or timer state is observable.
        let stored = Set(Mirror(reflecting: presenter).children.compactMap { $0.label })
        #expect(stored == ["panels", "renderers", "openTimer", "_feedbackState", "_completedActions", "_nextActionID",
                           "_lastCompletion", "_showsDetails", "_rowsState", "_$observationRegistrar"], "\(stored.sorted())")
        // Renderer, composition and timer events publish nothing anywhere.
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
        // Reviews n3 and ISSUE 8: neither stage tile view is compiled by macOS `swift test`, so the binding is pinned
        // in source. Each tile is built from the presenter's rows, one per row and keyed by it, and takes its name,
        // value and identifier from that row only, with no state of its own.
        let ios = hostingFlat(try hostingSource("Sources/Conclave/App/PlatformRoot+iOS.swift"))
        #expect(ios.contains("ForEach(presenter.rowsState.rows) { row in HostingStageTile(row: row, ledger: presenter.renderers) }"))
        let iosTile = try #require(hostingSection(ios, from: "private struct HostingStageTile: View {", to: "/// `style=<s>"))
        #expect(iosTile.contains("let row: NativeHostingRow let ledger: RendererIdentityLedger var body: some View { Text(row.name)"))
        #expect(iosTile.contains("if row.isSelected { Image(systemName: ConclaveSymbols.checkmark)"))
        #expect(iosTile.contains(".accessibilityLabel(row.name) .accessibilityValue(row.isSelected ? \"Selected\" : \"Not selected\")"))
        #expect(iosTile.contains(".accessibilityIdentifier(\"stage.tile.\\(row.id)\")"))
        #expect(!iosTile.contains("@State") && !iosTile.contains("@Environment") && !iosTile.contains("presenter"))
        let android = hostingFlat(try hostingSource("Sources/Conclave/Skip/ui/AppRoot.kt"))
        #expect(android.contains("val rows = cache.current()"))
        #expect(android.contains("NativeHostingStageStrip(rows, lifetime)"))
        #expect(android.contains("for (index in 0 until rows.size) { val row = rows[index] key(row.id) { NativeHostingStageTile(row, Modifier.weight(1f)) } }"))
        let androidTile = try #require(hostingSection(android, from: "private fun NativeHostingStageTile(", to: "/**"))
        #expect(androidTile.contains("row: NativeHostingPerson, modifier: Modifier = Modifier) {"))
        #expect(androidTile.contains(".testTag(\"stage.tile.${row.id}\")"))
        #expect(androidTile.contains("stateDescription = if (row.isSelected) \"Selected\" else \"Not selected\""))
        #expect(androidTile.contains("Text(row.name,") && androidTile.contains("if (row.isSelected) {"))
        #expect(!androidTile.contains("remember") && !androidTile.contains("presenter"))
    }

    @Test
    func panelOpenTimerKeysByPresentationAndConsumesOnce() throws {
        let presenter = NativeHostingPresenter()
        #expect(presenter.openTimer.summary() == "none")
        presenter.presentPanel(.participants, from: .call, at: 10)
        let first = try #require(presenter.panels.snapshot.current).presentationID
        // A quiet same-panel request keeps the original start.
        presenter.presentPanel(.participants, from: .more, at: 11)
        #expect(presenter.openTimer.firstFrame(presentationID: first, at: 10.25) == 250)
        #expect(presenter.openTimer.firstFrame(presentationID: first, at: 12) == -1)
        #expect(presenter.openTimer.summary() == "presentation \(first) 250 ms")
        // Review n1: a quiet request after the first frame starts nothing either, so a later first frame of the
        // shown presentation (content recreated) can never report a bogus latency.
        presenter.presentPanel(.participants, from: .call, at: 12.5)
        #expect(presenter.openTimer.firstFrame(presentationID: first, at: 13) == -1)
        #expect(presenter.openTimer.summary() == "presentation \(first) 250 ms")
        // A replacement is keyed by the pending presentation it creates.
        presenter.presentPanel(.settings, from: .settings, at: 20)
        let pending = try #require(presenter.panels.snapshot.pending).presentationID
        #expect(pending > first)
        #expect(presenter.openTimer.firstFrame(presentationID: pending, at: 20.0004) == 0)
        // A clock that steps back never reports a negative latency.
        presenter.openTimer.openRequested(presentationID: 99, at: 5)
        #expect(presenter.openTimer.firstFrame(presentationID: 99, at: 4) == 0)
    }

    @Test
    func panelOpenTimerDropsStartsTheCoordinatorNoLongerHolds() throws {
        // Review ISSUE 6: Rapid Replacement goes through the timed path on both fixtures; the presentation it
        // supersedes, a pending request cancelled before its first frame, and a reset request keep no start.
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
        // Replace Then Close: the pending start is dropped by the next timed request.
        presenter.presentPanel(.settings, from: .more, at: 5)
        let cancelled = try #require(presenter.panels.snapshot.pending).presentationID
        presenter.panels.dismiss(cancelPending: true)
        presenter.panels.didDismiss(session: 1, presentationID: pending)
        presenter.presentPanel(.layout, from: .call, at: 6)
        let layout = try #require(presenter.panels.snapshot.current).presentationID
        #expect(presenter.openTimer.firstFrame(presentationID: cancelled, at: 7) == -1)
        #expect(presenter.openTimer.firstFrame(presentationID: layout, at: 6.05) == 50)
        // Reset During Replacement: the reset request never shows, so its start goes too.
        presenter.presentPanel(.settings, from: .more, at: 8)
        let reset = try #require(presenter.panels.snapshot.pending).presentationID
        presenter.resetFixtureSession()
        presenter.presentPanel(.participants, from: .call, at: 9)
        #expect(presenter.openTimer.firstFrame(presentationID: reset, at: 10) == -1)
        #expect(presenter.openTimer.startCount == 1)
        // The pure pruning step keeps only the named presentations' starts.
        let timer = PanelOpenTimer()
        timer.openRequested(presentationID: 1, at: 0)
        timer.openRequested(presentationID: 2, at: 0)
        timer.discardStarts(keeping: [2, 7])
        #expect(timer.startCount == 1)
        #expect(timer.firstFrame(presentationID: 1, at: 1) == -1 && timer.firstFrame(presentationID: 2, at: 1) == 1000)
    }
}

private func hostingSource(_ packageRelativePath: String) throws -> String {
    let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
    return try String(contentsOf: root.appendingPathComponent(packageRelativePath), encoding: .utf8)
}

/// Whitespace collapsed to single spaces, so a pin fails only when the code changes.
private func hostingFlat(_ text: String) -> String {
    text.split(whereSeparator: { $0.isWhitespace }).joined(separator: " ")
}

/// The text from `start` up to the next `end` after it.
private func hostingSection(_ text: String, from start: String, to end: String) -> String? {
    guard let lower = text.range(of: start) else { return nil }
    let rest = text[lower.lowerBound...]
    guard let upper = rest.range(of: end, range: rest.index(lower.lowerBound, offsetBy: start.count)..<rest.endIndex) else { return nil }
    return String(text[lower.lowerBound..<upper.lowerBound])
}
#endif
