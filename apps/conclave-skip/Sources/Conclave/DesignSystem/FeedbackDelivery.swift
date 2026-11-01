import Foundation
import Observation

struct FeedbackDelivery: Equatable {
    let session: Int
    let epoch: Int
    let id: Int
    let kind: FeedbackKind
}

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

        sequence = token.sequence
        pending = nil
        guard self.eligible && eligible else { return nil }
        return prepare(kind: token.kind)
    }

    func gesture(kind: FeedbackKind, session: Int, eligible: Bool) -> FeedbackDelivery? {
        guard self.session == session, self.eligible && eligible else { return nil }
        return prepare(kind: kind)
    }

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

struct FeedbackSourceState: Equatable {
    let session: Int
    let token: FeedbackToken
}

@MainActor
@Observable
final class FeedbackDeliveryRecords {
    static let shared = FeedbackDeliveryRecords()

    private(set) var count = 0
    private(set) var lastKind = "none"

    func record(_ kind: FeedbackKind) {
        count += 1
        lastKind = kind.rawValue
    }

    func reset() {
        count = 0
        lastKind = "none"
    }
}
