import Foundation

/// S50 PL8 (shared, pure): case-insensitive substring search over `PeopleSection.searchKeys` (lowercased display
/// names) with `lowercased()` on the query. It returns filtered sections and never reads row entries, so a query adds
/// no subscriptions and a mute still re-evaluates one row while searching (S50 1 k). No locale folding in transpiled
/// code (PL8 [Unverified] Skip support for `folding(options:locale:)`). Runs in the view on the cached snapshot: no
/// presenter write and no network per keystroke (F00 C20 k).
enum PeopleSearchPolicy {
    /// Trimmed and lowercased.
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

    /// The sections with only matching rows; a section with no match is dropped. Counts become the matched counts, so
    /// a header reads what the list shows. An empty query returns the sections unchanged.
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

    /// Rows shown across the filtered sections, for the "%lld Results" announcement (F00 C20 i). A person in two
    /// sections counts twice, as they show twice.
    static func resultCount(_ sections: [PeopleSection]) -> Int {
        var total = 0
        for section in sections {
            total += section.rowIds.count
        }
        return total
    }
}
