import Foundation

/// One dispatched host action (PH2): the ticket, the command it emitted and what the failure path needs (origin,
/// inline slot, target name). Kept so Retry re-dispatches the same command and a result maps to the right copy.
struct HostLedgerEntry: Equatable {
    let ticket: HostActionTicket
    let command: PeopleCommand
    /// A `PeopleActionSource` value.
    let source: String
    /// The inline failure slot (`HostActionFailureModel.sourceKey`).
    let sourceKey: String
    let targetName: String
}

/// S50 PH2: the one ledger for People, Host Controls and Q&A tickets, owned by `PeoplePresenter` (S1C SES
/// and LED rules, `contract-wp2-first-slice.md:325`, `:330`). A plain, non-observable class: the presenter derives
/// row and toggle pending state from it and publishes that.
///
/// - Keys are `kind:target`, scoped to a target user or a field, never a producer id (S50 3 j, 6 j).
/// - `begin` returns nil while the key is pending (a duplicate tap emits no command).
/// - `finish` accepts a pending ticket once; a late or stale ticket (interrupted, reset) returns nil.
/// - `interruptAll` resolves every pending ticket on an attempt change (no feedback); their completions then drop.
/// - Ticket ids never reset, like `PanelCoordinator` presentation ids.
final class HostActionLedger {
    private(set) var pending: [HostLedgerEntry] = []
    private(set) var interruptedCount = 0
    private(set) var finishedCount = 0
    private var nextID = 0

    func isPending(_ key: String) -> Bool {
        entry(forKey: key) != nil
    }

    func entry(forKey key: String) -> HostLedgerEntry? {
        for entry in pending {
            if entry.ticket.key == key { return entry }
        }
        return nil
    }

    /// Every pending key, oldest first (diagnostics and tests).
    func pendingKeys() -> [String] {
        var keys: [String] = []
        for entry in pending {
            keys.append(entry.ticket.key)
        }
        return keys
    }

    func begin(key: String, command: PeopleCommand, source: String, sourceKey: String, targetName: String,
               session: Int, attempt: Int) -> HostActionTicket? {
        if key.isEmpty || isPending(key) { return nil }
        nextID += 1
        let ticket = HostActionTicket(id: nextID, key: key, session: session, attempt: attempt)
        pending.append(HostLedgerEntry(ticket: ticket, command: command, source: source, sourceKey: sourceKey,
                                       targetName: targetName))
        return ticket
    }

    /// The entry when `ticket` was pending (now resolved), else nil.
    func finish(_ ticket: HostActionTicket) -> HostLedgerEntry? {
        var kept: [HostLedgerEntry] = []
        var found: HostLedgerEntry? = nil
        for entry in pending {
            if found == nil && entry.ticket == ticket {
                found = entry
            } else {
                kept.append(entry)
            }
        }
        if found == nil { return nil }
        pending = kept
        finishedCount += 1
        return found
    }

    /// Resolves every pending ticket as interrupted; returns how many were pending.
    @discardableResult
    func interruptAll() -> Int {
        let count = pending.count
        pending = []
        interruptedCount += count
        return count
    }

    /// PPL-7 (S50 12 f): losing host finishes the pending host tickets silently; your rename, Q&A questions and votes
    /// and a stage decline stay. Returns how many were interrupted.
    @discardableResult
    func interruptHostActions() -> Int {
        var kept: [HostLedgerEntry] = []
        var count = 0
        for entry in pending {
            if PeopleRolePolicy.isHostCommand(entry.command.kind) {
                count += 1
            } else {
                kept.append(entry)
            }
        }
        pending = kept
        interruptedCount += count
        return count
    }

    /// The pending action on a row: the `PersonActionID` raw value of the first pending key that targets `rowKey`.
    func pendingAction(forRow rowKey: String) -> String {
        for entry in pending {
            let key = entry.ticket.key
            let parts = key.components(separatedBy: ":")
            if parts.count < 2 { continue }
            let target = key.dropFirst(parts[0].count + 1)
            if String(target) == rowKey { return parts[0] }
        }
        return ""
    }
}
