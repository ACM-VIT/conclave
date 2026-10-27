#if !SKIP
import Observation

struct NativePanelPresentation: Identifiable, Equatable {
    let session: Int
    let request: PanelRequest
    var id: String { "\(session):\(request.presentationID)" }
}

/// iOS panel host state (PS 6.4), host-testable on macOS; the SwiftUI modifiers stay in the `+iOS` files.
/// Sheet: the closing native identity outlives binding loss and is released only by its onDismiss. Inspector: a
/// column is not a modal presentation, so a dismissal is acknowledged at once and a replacement swaps the content
/// while the column stays open. A window-class change moves the shown request between the two without any
/// coordinator call (WP1-3b2): the sheet leaves as a migration whose late callbacks acknowledge nothing, and drafts
/// keyed by presentation ID carry over. Every transition is value-guarded, so `onChange`-driven re-entry is
/// idempotent.
@MainActor
@Observable
final class NativePanelHostAdapter {
    /// The last style passed to `synchronize`.
    private(set) var style: PanelHostStyle = .sheet
    private(set) var sheetItem: NativePanelPresentation? = nil
    private(set) var sheetClosing: NativePanelPresentation? = nil
    /// The closing sheet left because the panel moved to the inspector, not because it was dismissed.
    private(set) var sheetClosingIsMigration = false
    private(set) var inspectorItem: NativePanelPresentation? = nil
    /// The detent selection for the current sheet item; reset to its initial detent per presentation.
    private(set) var detent: PanelDetent = .large
    /// presentationID -> fixture draft text. Presentation IDs never reset, so a key is never reused.
    private(set) var drafts: [Int: String] = [:]

    var capturedSheet: NativePanelPresentation? { sheetClosing ?? sheetItem }

    /// Follows the coordinator in the current style.
    func synchronize(_ coordinator: PanelCoordinator) {
        synchronize(coordinator, style: style)
    }

    /// Follows the coordinator in `style`, migrating a shown request when the style changed.
    func synchronize(_ coordinator: PanelCoordinator, style: PanelHostStyle) {
        if self.style != style { self.style = style }
        if style == .inspector {
            synchronizeInspector(coordinator)
        } else {
            synchronizeSheet(coordinator)
        }
        // After any acknowledgment above, so an acknowledged presentation's draft leaves at once.
        dropDrafts(keeping: coordinator.snapshot)
    }

    private func synchronizeSheet(_ coordinator: PanelCoordinator) {
        // Inspector to sheet while shown: the column closes with no coordinator call, and the same request shows
        // in a sheet below, once no earlier sheet is still leaving.
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
                // Coalesced requests can close before native presentation ever started.
                coordinator.didDismiss(session: state.session, presentationID: request.presentationID)
                synchronizeSheet(coordinator)
            } else {
                sheetItem = NativePanelPresentation(session: state.session, request: request)
                let initial = PanelPresentationPolicy.initialSheetDetent(request.panel)
                if detent != initial { detent = initial }
            }
        }
    }

    private func synchronizeInspector(_ coordinator: PanelCoordinator) {
        if let item = sheetItem {
            let state = coordinator.snapshot
            sheetClosing = item
            sheetItem = nil
            // Sheet to inspector while shown: a migration, never a dismissal. A sheet the coordinator is already
            // closing stays a real dismissal and is acknowledged by its own onDismiss.
            if state.session == item.session && state.current?.presentationID == item.request.presentationID && !state.isDismissing {
                sheetClosingIsMigration = true
            }
        }
        // A real sheet dismissal in flight: follow the coordinator after its onDismiss.
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
        // A sheet that leaves because its panel moved to the inspector was not dismissed by anyone.
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

    /// The person closed the inspector (Escape, or the compact adaptation's own dismissal): dismiss, keeping a
    /// pending replacement, and acknowledge at once.
    func inspectorClosedByUser(_ coordinator: PanelCoordinator) {
        guard style == .inspector, let item = inspectorItem else { return }
        let state = coordinator.snapshot
        guard state.session == item.session, state.current?.presentationID == item.request.presentationID else { return }
        coordinator.dismiss(cancelPending: false)
        synchronizeInspector(coordinator)
    }

    /// The sheet's selection binding. Only a detent the shown panel offers is accepted.
    func selectDetent(_ detent: PanelDetent) {
        guard let item = sheetItem, self.detent != detent,
              PanelPresentationPolicy.sheetDetents(item.request.panel).contains(detent) else { return }
        self.detent = detent
    }

    /// A text field gained focus in a medium sheet (PS 7.3); a large-only or already large sheet is unchanged.
    /// The only implementation of the promotion rule: `selectDetent` accepts large only when the shown panel's
    /// policy detents offer it.
    func promoteToLarge() {
        selectDetent(.large)
    }

    func draft(for presentationID: Int) -> String {
        drafts[presentationID] ?? ""
    }

    /// Only the shown or closing presentation keeps a draft, in a sheet or in the inspector.
    func setDraft(_ text: String, for presentationID: Int) {
        let shown = capturedSheet?.request.presentationID == presentationID || inspectorItem?.request.presentationID == presentationID
        guard shown, drafts[presentationID] != text else { return }
        drafts[presentationID] = text
    }

    /// Acknowledged and reset presentations drop their drafts: only the coordinator's current and pending
    /// requests keep one.
    private func dropDrafts(keeping state: PanelSnapshot) {
        guard !drafts.isEmpty else { return }
        let kept = drafts.filter { key, _ in
            key == state.current?.presentationID || key == state.pending?.presentationID
        }
        if kept.count != drafts.count { drafts = kept }
    }
}
#endif
