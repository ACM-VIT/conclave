#if !SKIP
import Observation

struct NativePanelPresentation: Identifiable, Equatable {
    let session: Int
    let request: PanelRequest
    var id: String { "\(session):\(request.presentationID)" }
}

@MainActor
@Observable
final class NativePanelHostAdapter {

    private(set) var style: PanelHostStyle = .sheet
    private(set) var sheetItem: NativePanelPresentation? = nil
    private(set) var sheetClosing: NativePanelPresentation? = nil

    private(set) var sheetClosingIsMigration = false
    private(set) var inspectorItem: NativePanelPresentation? = nil

    private(set) var detent: PanelDetent = .large

    private(set) var isAccessibilitySize = false

    private(set) var shortDetentHeight: Double = PanelPresentationPolicy.defaultShortDetentHeight

    private(set) var drafts: [Int: String] = [:]

    var capturedSheet: NativePanelPresentation? { sheetClosing ?? sheetItem }

    func synchronize(_ coordinator: PanelCoordinator) {
        synchronize(coordinator, style: style)
    }

    func synchronize(_ coordinator: PanelCoordinator, style: PanelHostStyle, isAccessibilitySize: Bool) {
        if self.isAccessibilitySize != isAccessibilitySize { self.isAccessibilitySize = isAccessibilitySize }
        synchronize(coordinator, style: style)
    }

    func synchronize(_ coordinator: PanelCoordinator, style: PanelHostStyle) {
        if self.style != style { self.style = style }
        if style == .inspector {
            synchronizeInspector(coordinator)
        } else {
            synchronizeSheet(coordinator)
        }

        dropDrafts(keeping: coordinator.snapshot)
    }

    private func synchronizeSheet(_ coordinator: PanelCoordinator) {

        if inspectorItem != nil { inspectorItem = nil }
        let state = coordinator.snapshot
        guard sheetClosing == nil else { return }
        if let item = sheetItem {
            if state.session != item.session || state.current?.presentationID != item.request.presentationID || state.isDismissing {
                sheetClosing = item
                sheetItem = nil
            }
        } else if let request = state.current {
            if state.isDismissing {

                coordinator.didDismiss(session: state.session, presentationID: request.presentationID)
                synchronizeSheet(coordinator)
            } else {
                sheetItem = NativePanelPresentation(session: state.session, request: request)
                let initial = PanelPresentationPolicy.initialSheetDetent(request.panel, isAccessibilitySize: isAccessibilitySize)
                if detent != initial { detent = initial }
            }
        }
    }

    private func synchronizeInspector(_ coordinator: PanelCoordinator) {
        if let item = sheetItem {
            let state = coordinator.snapshot
            sheetClosing = item
            sheetItem = nil

            if state.session == item.session && state.current?.presentationID == item.request.presentationID && !state.isDismissing {
                sheetClosingIsMigration = true
            }
        }

        if sheetClosing != nil && !sheetClosingIsMigration { return }
        var state = coordinator.snapshot
        if state.isDismissing, let current = state.current {
            coordinator.didDismiss(session: state.session, presentationID: current.presentationID)
            state = coordinator.snapshot
        }
        var next: NativePanelPresentation? = nil
        if let current = state.current, !state.isDismissing {
            next = NativePanelPresentation(session: state.session, request: current)
        }
        if inspectorItem != next { inspectorItem = next }
    }

    func sheetBindingLost(_ captured: NativePanelPresentation?, coordinator: PanelCoordinator) {
        guard let captured, captured == capturedSheet else { return }

        if sheetClosingIsMigration && sheetClosing == captured { return }
        if coordinator.snapshot.session == captured.session &&
            coordinator.snapshot.current?.presentationID == captured.request.presentationID {
            coordinator.dismiss(cancelPending: false)
        }
        sheetClosing = captured
        sheetItem = nil
    }

    func sheetDidDismiss(_ captured: NativePanelPresentation?, coordinator: PanelCoordinator) {
        guard let captured, sheetClosing == captured else { return }
        let migration = sheetClosingIsMigration
        sheetClosing = nil
        if sheetClosingIsMigration { sheetClosingIsMigration = false }
        if !migration {
            coordinator.didDismiss(session: captured.session, presentationID: captured.request.presentationID)
        }
        synchronize(coordinator, style: style)
    }

    func inspectorClosedByUser(_ coordinator: PanelCoordinator) {
        guard style == .inspector, let item = inspectorItem else { return }
        let state = coordinator.snapshot
        guard state.session == item.session, state.current?.presentationID == item.request.presentationID else { return }
        coordinator.dismiss(cancelPending: false)
        synchronizeInspector(coordinator)
    }

    func selectDetent(_ detent: PanelDetent) {
        guard let item = sheetItem, self.detent != detent,
              PanelPresentationPolicy.sheetDetents(item.request.panel).contains(detent) else { return }
        self.detent = detent
    }

    func setShortDetentHeight(_ height: Double) {
        guard height.isFinite, height > 0, abs(height - shortDetentHeight) >= 0.5 else { return }
        shortDetentHeight = height
    }

    func promoteToLarge() {
        selectDetent(.large)
    }

    func draft(for presentationID: Int) -> String {
        drafts[presentationID] ?? ""
    }

    func setDraft(_ text: String, for presentationID: Int) {
        let shown = capturedSheet?.request.presentationID == presentationID || inspectorItem?.request.presentationID == presentationID
        guard shown, drafts[presentationID] != text else { return }
        drafts[presentationID] = text
    }

    private func dropDrafts(keeping state: PanelSnapshot) {
        guard !drafts.isEmpty else { return }
        let kept = drafts.filter { key, _ in
            key == state.current?.presentationID || key == state.pending?.presentationID
        }
        if kept.count != drafts.count { drafts = kept }
    }
}
#endif
