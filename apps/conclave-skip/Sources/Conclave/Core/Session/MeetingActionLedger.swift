import Foundation

/// One resolved ticket, kept for diagnostics and tests (the Debug session readout lands in WP2-S2b).
struct MeetingActionLedgerEntry: Equatable {
    let ticket: MeetingActionTicket
    let result: MeetingActionResult
}

/// S1C LED: typed pending state for the actions that have an acknowledgement (hand, leave, end for everyone). A plain,
/// non-observable class owned by `MeetingShellPresenter`; the presenter publishes what matters as row state.
///
/// - `begin` returns nil while a ticket of that kind is pending (duplicates are quiet).
/// - `finish` accepts only a pending ticket whose identity equals the current identity, and only once.
/// - `interrupt` and `cancelAll` resolve pending tickets on a recovery or a new call session; their late completions
///   are then dropped.
/// - Ticket ids never reset, as `PanelCoordinator` presentation ids never do.
final class MeetingActionLedger {
    private(set) var pending: [MeetingActionTicket] = []
    private(set) var resolved: [MeetingActionLedgerEntry] = []
    private var nextID = 0
    private let resolvedLimit = 16

    func isPending(_ kind: MeetingActionKind) -> Bool {
        pendingTicket(kind) != nil
    }

    func pendingTicket(_ kind: MeetingActionKind) -> MeetingActionTicket? {
        for ticket in pending {
            if ticket.kind == kind { return ticket }
        }
        return nil
    }

    func begin(_ kind: MeetingActionKind, identity: MeetingSessionIdentity) -> MeetingActionTicket? {
        guard !isPending(kind) else { return nil }
        nextID += 1
        let ticket = MeetingActionTicket(id: nextID, kind: kind, identity: identity)
        pending.append(ticket)
        return ticket
    }

    /// True when the ticket was pending for this identity and is now resolved with `result`.
    func finish(_ ticket: MeetingActionTicket, result: MeetingActionResult, currentIdentity: MeetingSessionIdentity) -> Bool {
        guard ticket.identity == currentIdentity,
              let index = pending.firstIndex(where: { $0.id == ticket.id }) else { return false }
        pending.remove(at: index)
        record(MeetingActionLedgerEntry(ticket: ticket, result: result))
        return true
    }

    /// Resolves the pending tickets of these kinds as interrupted; returns how many were pending.
    @discardableResult
    func interrupt(kinds: [MeetingActionKind]) -> Int {
        resolveAll(MeetingActionResult.interrupted, kinds: kinds)
    }

    @discardableResult
    func interruptAll() -> Int {
        resolveAll(MeetingActionResult.interrupted, kinds: MeetingActionKind.allCases)
    }

    @discardableResult
    func cancelAll() -> Int {
        resolveAll(MeetingActionResult.cancelled, kinds: MeetingActionKind.allCases)
    }

    /// The result a ticket resolved with, while it is still in the bounded history.
    func result(of ticketID: Int) -> MeetingActionResult? {
        for entry in resolved {
            if entry.ticket.id == ticketID { return entry.result }
        }
        return nil
    }

    private func resolveAll(_ result: MeetingActionResult, kinds: [MeetingActionKind]) -> Int {
        var kept: [MeetingActionTicket] = []
        var count = 0
        for ticket in pending {
            if kinds.contains(ticket.kind) {
                record(MeetingActionLedgerEntry(ticket: ticket, result: result))
                count += 1
            } else {
                kept.append(ticket)
            }
        }
        pending = kept
        return count
    }

    private func record(_ entry: MeetingActionLedgerEntry) {
        resolved.append(entry)
        while resolved.count > resolvedLimit {
            resolved.removeFirst()
        }
    }
}
