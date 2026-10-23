#if os(iOS) && !SKIP
import Observation
import SwiftUI

struct NativePanelPresentation: Identifiable, Equatable {
    let session: Int
    let request: PanelRequest
    var id: String { "\(session):\(request.presentationID)" }
}

/// The closing native identity outlives binding loss and is released only by its onDismiss.
@MainActor
@Observable
final class NativePanelSheetAdapter {
    private(set) var item: NativePanelPresentation? = nil
    private(set) var closing: NativePanelPresentation? = nil

    var capturedPresentation: NativePanelPresentation? { closing ?? item }

    func synchronize(_ coordinator: PanelCoordinator) {
        let state = coordinator.snapshot
        guard closing == nil else { return }
        if let item {
            if state.session != item.session || state.current?.presentationID != item.request.presentationID || state.isDismissing {
                closing = item
                self.item = nil
            }
        } else if let request = state.current {
            if state.isDismissing {
                // Coalesced requests can close before native presentation ever started.
                coordinator.didDismiss(session: state.session, presentationID: request.presentationID)
                synchronize(coordinator)
            } else {
                item = NativePanelPresentation(session: state.session, request: request)
            }
        }
    }

    func bindingLost(_ captured: NativePanelPresentation?, coordinator: PanelCoordinator) {
        guard let captured, captured == capturedPresentation else { return }
        if coordinator.snapshot.session == captured.session &&
            coordinator.snapshot.current?.presentationID == captured.request.presentationID {
            coordinator.dismiss(cancelPending: false)
        }
        closing = captured
        item = nil
    }

    func didDismiss(_ captured: NativePanelPresentation?, coordinator: PanelCoordinator) {
        guard let captured, closing == captured else { return }
        closing = nil
        coordinator.didDismiss(session: captured.session, presentationID: captured.request.presentationID)
        synchronize(coordinator)
    }
}

struct NativePanelSheet<PanelContent: View>: ViewModifier {
    let coordinator: PanelCoordinator
    let adapter: NativePanelSheetAdapter
    @ViewBuilder let panelContent: (NativePanelPresentation) -> PanelContent

    func body(content: Content) -> some View {
        let captured = adapter.capturedPresentation
        content
            .onChange(of: coordinator.snapshot, initial: true) { _, _ in adapter.synchronize(coordinator) }
            .sheet(item: Binding(get: { adapter.item }, set: { [captured] value in
                if value == nil { adapter.bindingLost(captured, coordinator: coordinator) }
            }), onDismiss: { [captured] in
                adapter.didDismiss(captured, coordinator: coordinator)
            }, content: panelContent)
    }
}
#endif
