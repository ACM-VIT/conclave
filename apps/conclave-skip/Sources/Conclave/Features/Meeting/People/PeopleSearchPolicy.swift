import Foundation

enum PeopleSearchPolicy {

    static func normalized(_ query: String) -> String {
        query.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    }

    static func isSearching(_ query: String) -> Bool {
        !normalized(query).isEmpty
    }

    static func matches(_ searchKey: String, query: String) -> Bool {
        let needle = normalized(query)
        if needle.isEmpty { return true }
        return searchKey.contains(needle)
    }

    static func filter(_ sections: [PeopleSection], query: String) -> [PeopleSection] {
        let needle = normalized(query)
        if needle.isEmpty { return sections }
        var result: [PeopleSection] = []
        for section in sections {
            var rowIds: [String] = []
            var keys: [String] = []
            var names: [String] = []
            var index = 0
            for key in section.searchKeys {
                if index < section.rowIds.count && key.contains(needle) {
                    rowIds.append(section.rowIds[index])
                    keys.append(key)
                    names.append(index < section.names.count ? section.names[index] : "")
                }
                index += 1
            }
            if !rowIds.isEmpty {
                result.append(PeopleSection(id: section.id, count: rowIds.count, rowIds: rowIds, searchKeys: keys, names: names))
            }
        }
        return result
    }

    static func resultCount(_ sections: [PeopleSection]) -> Int {
        var total = 0
        for section in sections {
            total += section.rowIds.count
        }
        return total
    }
}
