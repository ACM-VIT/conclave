import Foundation

enum EmojiShortcodes {
    static let maxNameLength = 40

    private static let nameUnits: Set<String> = unitSet("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_+-")
    private static let whitespaceUnits: Set<String> = unitSet(
        "\t\n\u{000B}\u{000C}\r \u{00A0}\u{1680}\u{2000}\u{2001}\u{2002}\u{2003}\u{2004}\u{2005}\u{2006}\u{2007}\u{2008}\u{2009}\u{200A}"
            + "\u{2028}\u{2029}\u{202F}\u{205F}\u{3000}\u{FEFF}")

    static func emoji(forShortcode name: String) -> String? {
        EmojiShortcodeTable.emoji[name.lowercased()]
    }

    static func outgoing(_ content: String, hasGif: Bool) -> String {
        if hasGif || isTts(content) { return content }
        return replaceInMessage(content)
    }

    static func replaceInMessage(_ content: String) -> String {
        let units = codeUnits(content)
        let prefixEnd = directMessagePrefixEnd(units)
        if prefixEnd == 0 { return replace(content) }
        return join(units, from: 0, to: prefixEnd) + replace(join(units, from: prefixEnd, to: units.count))
    }

    static func replace(_ content: String) -> String {
        if !content.contains(":") { return content }
        var result = ""
        for span in ChatLinkifyPolicy.spans(content) {
            result += span.kind == ChatSpanKind.link ? span.text : replaceInText(span.text)
        }
        return result
    }

    static func replaceInText(_ text: String) -> String {
        if !text.contains(":") { return text }
        let units = codeUnits(text)
        var result = ""
        var cursor = 0
        var searchFrom = 0
        while searchFrom < units.count {
            let start = nextShortcodeStart(units, from: searchFrom)
            if start < 0 { break }
            let nameEnd = start + 1 + nameRunLength(units, at: start + 1)
            let matchEnd = nameEnd + 1
            let found = emoji(forShortcode: join(units, from: start + 1, to: nameEnd)) ?? ""
            if found.isEmpty {
                searchFrom = nameEnd
            } else {
                result += join(units, from: cursor, to: start) + found
                cursor = matchEnd
                searchFrom = matchEnd
            }
        }
        return cursor == 0 ? text : result + join(units, from: cursor, to: units.count)
    }

    static func isTts(_ content: String) -> Bool {
        let units = codeUnits(content)
        if units.count < 4 || units[0] != "/" { return false }
        if units[1].lowercased() != "t" || units[2].lowercased() != "t" || units[3].lowercased() != "s" { return false }
        return units.count == 4 || whitespaceUnits.contains(units[4])
    }

    private static func nextShortcodeStart(_ units: [String], from: Int) -> Int {
        var index = from
        while index < units.count {
            if units[index] == ":" {
                let length = nameRunLength(units, at: index + 1)
                let close = index + 1 + length
                if length >= 1 && length <= maxNameLength && close < units.count && units[close] == ":" { return index }
            }
            index += 1
        }
        return -1
    }

    private static func nameRunLength(_ units: [String], at start: Int) -> Int {
        var end = start
        while end < units.count && nameUnits.contains(units[end]) {
            end += 1
        }
        return end - start
    }

    private static func directMessagePrefixEnd(_ units: [String]) -> Int {
        var index = 0
        while index < units.count && whitespaceUnits.contains(units[index]) {
            index += 1
        }
        if index < units.count && units[index] == "@" {
            let end = nonWhitespaceEnd(units, from: index + 1)
            return end > index + 1 ? end : 0
        }
        if index + 3 > units.count || units[index] != "/" || units[index + 1].lowercased() != "d"
            || units[index + 2].lowercased() != "m" {
            return 0
        }
        var recipientStart = index + 3
        while recipientStart < units.count && whitespaceUnits.contains(units[recipientStart]) {
            recipientStart += 1
        }
        if recipientStart == index + 3 { return 0 }
        let end = nonWhitespaceEnd(units, from: recipientStart)
        return end > recipientStart ? end : 0
    }

    private static func nonWhitespaceEnd(_ units: [String], from start: Int) -> Int {
        var end = start
        while end < units.count && !whitespaceUnits.contains(units[end]) {
            end += 1
        }
        return end
    }

    private static func codeUnits(_ text: String) -> [String] {
        var result: [String] = []
        #if SKIP
        for unit in text {
            result.append(String(unit))
        }
        #else
        for scalar in text.unicodeScalars {
            result.append(String(scalar))
        }
        #endif
        return result
    }

    private static func unitSet(_ text: String) -> Set<String> {
        var result = Set<String>()
        for unit in codeUnits(text) {
            result.insert(unit)
        }
        return result
    }

    private static func join(_ units: [String], from: Int, to: Int) -> String {
        var result = ""
        var index = from
        while index < to {
            result += units[index]
            index += 1
        }
        return result
    }
}
