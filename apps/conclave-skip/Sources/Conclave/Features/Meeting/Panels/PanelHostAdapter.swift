#if !SKIP
import Observation

struct NativePanelPresentation: Identifiable, Equatable {
    let session: Int
    let request: PanelRequest
    var id: String { "\(session):\(request.presentationID)" }
}

/// iOS panel host state (PS 6.4), host-testable on macOS; the SwiftUI modifiers stay in the `+iOS` files.
/// The sheet logic moved here unchanged from `NativePanelSheet+iOS.swift`: the closing native identity
/// outlives binding loss and is released only by its onDismiss. WP1-3b1 adds the sheet detent selection and
/// fixture drafts keyed by presentation ID; the inspector rows and style migration land in WP1-3b2. Every
/// transition is value-guarded, so `onChange`-driven re-entry is idempotent.
@MainActor
@Observable
final class NativePanelHostAdapter {
    private(set) var sheetItem: NativePanelPresentation? = nil
    private(set) var sheetClosing: NativePanelPresentation? = nil
    /// The detent selection for the current sheet item; reset to its initial detent per presentation.
    private(set) var detent: PanelDetent = .large
    /// presentationID -> fixture draft text. Presentation IDs never reset, so a key is never reused.
    private(set) var drafts: [Int: String] = [:]

    var capturedSheet: NativePanelPresentation? { sheetClosing ?? sheetItem }

    func synchronize(_ coordinator: PanelCoordinator) {
        let state = coordinator.snapshot
        dropDrafts(keeping: state)
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
                synchronize(coordinator)
            } else {
                sheetItem = NativePanelPresentation(session: state.session, request: request)
                let initial = PanelPresentationPolicy.initialSheetDetent(request.panel)
                if detent != initial { detent = initial }
            }
        }
    }

    func sheetBindingLost(_ captured: NativePanelPresentation?, coordinator: PanelCoordinator) {
        guard let captured, captured == capturedSheet else { return }
        if coordinator.snapshot.session == captured.session &&
            coordinator.snapshot.current?.presentationID == captured.request.presentationID {
            coordinator.dismiss(cancelPending: false)
        }
        sheetClosing = captured
        sheetItem = nil
    }

    func sheetDidDismiss(_ captured: NativePanelPresentation?, coordinator: PanelCoordinator) {
        guard let captured, sheetClosing == captured else { return }
        sheetClosing = nil
        coordinator.didDismiss(session: captured.session, presentationID: captured.request.presentationID)
        synchronize(coordinator)
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

    /// Only the shown or closing presentation keeps a draft.
    func setDraft(_ text: String, for presentationID: Int) {
        guard capturedSheet?.request.presentationID == presentationID, drafts[presentationID] != text else { return }
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
