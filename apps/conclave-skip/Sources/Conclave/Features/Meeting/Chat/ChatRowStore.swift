import Foundation

/// S40 D25, CH1: one `ChatRowEntry` per row id and one index from every message id (server id and client id) to the
/// row id. Every message-id input (quote jumps, toast destinations, focus, the unread marker, history snapshots)
/// resolves through `rowId(forMessageId:)`. Not observable: the timeline publishes the ids, rows observe entries.
@MainActor
final class ChatRowStore {
    private var entries: [String: ChatRowEntry] = [:]
    private var messageIndex: [String: String] = [:]
    /// A placeholder for ids no longer in the timeline (a lazy list can ask for a removed id for one frame).
    private let missing = ChatRowEntry(row: ChatRowModel(id: "", kind: ChatRowKind.system))

    init() {}

    /// The entry for a row id; a detached placeholder when unknown (never nil, so lazy rows never branch).
    func entry(for rowId: String) -> ChatRowEntry {
        entries[rowId] ?? missing
    }

    func hasEntry(_ rowId: String) -> Bool {
        entries[rowId] != nil
    }

    /// A server id or client id to its row id; "" when unknown.
    func rowId(forMessageId messageId: String) -> String {
        if messageId.isEmpty { return "" }
        if let rowId = messageIndex[messageId] { return rowId }
        if entries[messageId] != nil { return messageId }
        return ""
    }

    var count: Int { entries.count }

    /// Writes one row and its assistant model (CHT-7; nil for other rows), equality-guarded, and indexes its message
    /// ids. Returns true when a visible value changed.
    @discardableResult
    func upsert(_ row: ChatRowModel, messageIds: [String], assistant: AssistantRowModel? = nil) -> Bool {
        for messageId in messageIds {
            if !messageId.isEmpty { messageIndex[messageId] = row.id }
        }
        if let existing = entries[row.id] {
            return existing.update(row, assistant: assistant)
        }
        entries[row.id] = ChatRowEntry(row: row, assistant: assistant)
        return true
    }

    /// Drops entries and index keys for rows no longer in the timeline.
    func retain(rowIds: [String]) {
        var keep: [String: Bool] = [:]
        for id in rowIds {
            keep[id] = true
        }
        var removedEntries: [String] = []
        for key in entries.keys {
            if keep[key] == nil { removedEntries.append(key) }
        }
        for key in removedEntries {
            entries.removeValue(forKey: key)
        }
        var removedIndex: [String] = []
        for messageId in messageIndex.keys {
            let rowId = messageIndex[messageId] ?? ""
            if keep[rowId] == nil { removedIndex.append(messageId) }
        }
        for key in removedIndex {
            messageIndex.removeValue(forKey: key)
        }
    }

    func reset() {
        entries = [:]
        messageIndex = [:]
    }
}
