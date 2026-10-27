import Observation

@MainActor
@Observable
final class PanelCoordinator {
    private(set) var snapshot: PanelSnapshot
    /// The latest destination for the panel that was already current (SR7, S40 R40-2), published for every panel
    /// without a new presentation; nil until the first one and after a reset. A separate property, so the hosts
    /// and the controls that read `snapshot` never invalidate for it.
    private(set) var destinationRequest: PanelDestinationRequest? = nil
    /// Called after every snapshot change, exactly once per change, never for an equal snapshot or for a
    /// destination request (S30 CC18: the controls refresh path derives Engaged invokers from `snapshot`).
    @ObservationIgnored var onSnapshotChanged: (() -> Void)? = nil
    private var nextID = 0
    private var nextDestinationSequence = 0

    init(session: Int) {
        snapshot = PanelSnapshot(session: session, current: nil, pending: nil, isDismissing: false)
    }

    /// Opens `panel` at `destination` (SR7). A replacement keeps its own destination. A request for the panel
    /// that is already current opens nothing new: a non-`none` destination publishes `destinationRequest`, and
    /// `none` is quiet. A request for the panel that is already queued behind a dismissal updates the queued
    /// request's destination, which it reads when it opens.
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

    /// S30 1 a, CC18: a bar invoker (Chat, Participants, Q&A) closes its panel while it is current and shown, and
    /// opens it otherwise (a fresh request, a replacement of another panel, or a re-request while it is closing).
    /// Close cancels a queued replacement, like the explicit Close and Back.
    func toggle(_ panel: MeetingPanel, from invoker: PanelInvoker) {
        if let current = snapshot.current, current.panel == panel, !snapshot.isDismissing {
            dismiss(cancelPending: true)
        } else {
            present(panel, from: invoker)
        }
    }

    /// `snapshot.current?.panel.rawValue`, or "" with no panel: the controls' `currentPanel` input (S30 CC18).
    /// Reads `snapshot`, so an observing caller invalidates with it.
    var currentPanelName: String {
        snapshot.current?.panel.rawValue ?? ""
    }

    /// The latest destination request when it names `presentationID` in the current session, else nil, so a
    /// panel never acts on a request meant for an earlier presentation of the same panel.
    func latestDestination(for presentationID: Int) -> PanelDestinationRequest? {
        guard let request = destinationRequest, request.session == snapshot.session,
              request.presentationID == presentationID else { return nil }
        return request
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
        // Presentation IDs and destination sequences never reset, including when the owner reuses a session number.
        if destinationRequest != nil { destinationRequest = nil }
        publish(PanelSnapshot(session: session, current: nil, pending: nil, isDismissing: false))
    }

    private func publish(_ next: PanelSnapshot) {
        guard next != snapshot else { return }
        snapshot = next
        onSnapshotChanged?()
    }
}
