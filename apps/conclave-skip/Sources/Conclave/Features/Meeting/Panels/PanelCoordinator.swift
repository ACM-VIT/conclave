import Observation

@MainActor
@Observable
final class PanelCoordinator {
    private(set) var snapshot: PanelSnapshot
    private var nextID = 0

    init(session: Int) {
        snapshot = PanelSnapshot(session: session, current: nil, pending: nil, isDismissing: false)
    }

    func present(_ panel: MeetingPanel, from invoker: PanelInvoker) {
        if snapshot.isDismissing {
            guard snapshot.pending?.panel != panel else { return }
        } else {
            guard snapshot.current?.panel != panel else { return }
        }
        nextID += 1
        let request = PanelRequest(presentationID: nextID, panel: panel, invoker: invoker)
        if let current = snapshot.current {
            publish(PanelSnapshot(session: snapshot.session, current: current, pending: request, isDismissing: true))
        } else {
            publish(PanelSnapshot(session: snapshot.session, current: request, pending: nil, isDismissing: false))
        }
    }

    /// Binding loss keeps replacement intent; explicit Close and Back cancel it.
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
        // Presentation IDs never reset, including when the owner reuses a session number.
        publish(PanelSnapshot(session: session, current: nil, pending: nil, isDismissing: false))
    }

    private func publish(_ next: PanelSnapshot) {
        guard next != snapshot else { return }
        snapshot = next
    }
}
