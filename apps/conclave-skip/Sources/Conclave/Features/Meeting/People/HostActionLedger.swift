import Foundation

struct HostLedgerEntry: Equatable {
    let ticket: HostActionTicket
    let command: PeopleCommand

    let source: String

    let sourceKey: String
    let targetName: String
}

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

    @discardableResult
    func interruptAll() -> Int {
        let count = pending.count
        pending = []
        interruptedCount += count
        return count
    }

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
