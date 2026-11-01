import Foundation

@MainActor
final class ChatRowStore {
    private var entries: [String: ChatRowEntry] = [:]
    private var messageIndex: [String: String] = [:]

    private let missing = ChatRowEntry(row: ChatRowModel(id: "", kind: ChatRowKind.system))

    init() {}

    func entry(for rowId: String) -> ChatRowEntry {
        entries[rowId] ?? missing
    }

    func hasEntry(_ rowId: String) -> Bool {
        entries[rowId] != nil
    }

    func rowId(forMessageId messageId: String) -> String {
        if messageId.isEmpty { return "" }
        if let rowId = messageIndex[messageId] { return rowId }
        if entries[messageId] != nil { return messageId }
        return ""
    }

    var count: Int { entries.count }

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
