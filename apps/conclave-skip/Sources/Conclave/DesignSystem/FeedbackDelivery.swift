/// An ephemeral native effect, never persisted or acknowledged back to the outcome owner.
struct FeedbackDelivery: Equatable {
    let session: Int
    let epoch: Int
    let id: Int
    let kind: FeedbackKind
}

/// Plain UI-owned state. Lifecycle callbacks update it synchronously, even between renders.
final class FeedbackDeliveryCursor {
    private(set) var session: Int? = nil
    private(set) var sequence = 0
    private(set) var epoch = 0
    private(set) var eligible = false
    private var nextID = 0
    private var pending: FeedbackDelivery? = nil

    func attach(session: Int, current: FeedbackToken, eligible: Bool) {
        rebaseline(session: session, current: current, eligible: eligible)
    }

    func rebaseline(session: Int, current: FeedbackToken, eligible: Bool) {
        sequence = self.session == session ? max(sequence, current.sequence) : current.sequence
        self.session = session
        self.eligible = eligible
        epoch += 1
        pending = nil
    }

    func setEligibility(session: Int, current: FeedbackToken, eligible: Bool) {
        guard self.session != session || self.eligible != eligible else { return }
        rebaseline(session: session, current: current, eligible: eligible)
    }

    func observe(session: Int, token: FeedbackToken, epoch: Int, eligible: Bool) -> FeedbackDelivery? {
        guard self.session == session, self.epoch == epoch, token.sequence > sequence else { return nil }
        // Suppression consumes this UI observation, never the domain completion.
        sequence = token.sequence
        pending = nil
        guard self.eligible && eligible else { return nil }
        return prepare(kind: token.kind)
    }

    func gesture(kind: FeedbackKind, session: Int, eligible: Bool) -> FeedbackDelivery? {
        guard self.session == session, self.eligible && eligible else { return nil }
        return prepare(kind: kind)
    }

    /// Recheck immediately before the platform effect. A ticket can be taken only once.
    func take(_ delivery: FeedbackDelivery, session: Int, eligible: Bool) -> FeedbackKind? {
        guard pending == delivery else { return nil }
        pending = nil
        guard self.session == session, delivery.session == session,
              delivery.epoch == epoch, self.eligible && eligible else { return nil }
        return delivery.kind
    }

    private func prepare(kind: FeedbackKind) -> FeedbackDelivery? {
        guard kind != .none else { return nil }
        nextID += 1
        let delivery = FeedbackDelivery(session: session ?? 0, epoch: epoch, id: nextID, kind: kind)
        pending = delivery
        return delivery
    }
}
