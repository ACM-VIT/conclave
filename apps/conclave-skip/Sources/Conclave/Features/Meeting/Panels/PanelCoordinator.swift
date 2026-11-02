import Observation

@MainActor
@Observable
final class PanelCoordinator {
    private(set) var snapshot: PanelSnapshot

    private(set) var destinationRequest: PanelDestinationRequest? = nil

    @ObservationIgnored var onSnapshotChanged: (() -> Void)? = nil
    private var nextID = 0
    private var nextDestinationSequence = 0

    init(session: Int) {
        snapshot = PanelSnapshot(session: session, current: nil, pending: nil, isDismissing: false)
    }

    func present(_ panel: MeetingPanel, from invoker: PanelInvoker,
                 destination: PanelDestination = PanelDestination.none, targetId: String = "") {
        if snapshot.isDismissing {
            if let pending = snapshot.pending, pending.panel == panel {
                if destination != PanelDestination.none && (pending.destination != destination || pending.targetId != targetId) {
                    let updated = PanelRequest(presentationID: pending.presentationID, panel: panel, invoker: invoker,
                                               destination: destination, targetId: targetId)
                    publish(PanelSnapshot(session: snapshot.session, current: snapshot.current, pending: updated, isDismissing: true))
                }
                return
            }
        } else if let current = snapshot.current, current.panel == panel {
            if destination != PanelDestination.none {
                nextDestinationSequence += 1
                destinationRequest = PanelDestinationRequest(sequence: nextDestinationSequence, session: snapshot.session,
                                                             presentationID: current.presentationID, panel: panel,
                                                             invoker: invoker, destination: destination, targetId: targetId)
            }
            return
        }
        nextID += 1
        let request = PanelRequest(presentationID: nextID, panel: panel, invoker: invoker,
                                   destination: destination, targetId: targetId)
        if let current = snapshot.current {
            publish(PanelSnapshot(session: snapshot.session, current: current, pending: request, isDismissing: true))
        } else {
            publish(PanelSnapshot(session: snapshot.session, current: request, pending: nil, isDismissing: false))
        }
    }

    @discardableResult
    func presentFromMore(_ panel: MeetingPanel, destination: PanelDestination = PanelDestination.none,
                         targetId: String = "") -> Bool {
        let before = snapshot
        let beforeDestination = destinationRequest
        present(panel, from: PanelInvoker.more, destination: destination, targetId: targetId)
        return snapshot != before || destinationRequest != beforeDestination
    }

    func toggle(_ panel: MeetingPanel, from invoker: PanelInvoker) {
        if let current = snapshot.current, current.panel == panel, !snapshot.isDismissing {
            dismiss(cancelPending: true)
        } else {
            present(panel, from: invoker)
        }
    }

    var currentPanelName: String {
        snapshot.current?.panel.rawValue ?? ""
    }

    func isShowingOrQueued(_ panel: MeetingPanel) -> Bool {
        snapshot.current?.panel == panel || snapshot.pending?.panel == panel
    }

    func latestDestination(for presentationID: Int) -> PanelDestinationRequest? {
        guard let request = destinationRequest, request.session == snapshot.session,
              request.presentationID == presentationID else { return nil }
        return request
    }

    func dismiss(cancelPending: Bool) {
        guard let current = snapshot.current else { return }
        publish(PanelSnapshot(session: snapshot.session, current: current,
            pending: cancelPending ? nil : snapshot.pending, isDismissing: true))
    }

    func didDismiss(session: Int, presentationID: Int) {
        guard snapshot.session == session, snapshot.isDismissing,
              snapshot.current?.presentationID == presentationID else { return }
        publish(PanelSnapshot(session: session, current: snapshot.pending, pending: nil, isDismissing: false))
    }

    func reset(session: Int) {

        if destinationRequest != nil { destinationRequest = nil }
        publish(PanelSnapshot(session: session, current: nil, pending: nil, isDismissing: false))
    }

    private func publish(_ next: PanelSnapshot) {
        guard next != snapshot else { return }
        snapshot = next
        onSnapshotChanged?()
    }
}
