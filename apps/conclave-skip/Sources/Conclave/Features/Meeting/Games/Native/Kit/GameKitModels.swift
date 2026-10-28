import Foundation

struct GameKitChoice: Equatable, Identifiable {
    let id: String
    let text: String
    let detail: String
    let count: Int
    let isSelected: Bool
    let isCorrect: Bool
    let isWrongPick: Bool
    let isDisabled: Bool

    static func make(id: String, text: String, detail: String = "", count: Int = -1, isSelected: Bool = false,
                     isCorrect: Bool = false, isWrongPick: Bool = false, isDisabled: Bool = false) -> GameKitChoice {
        GameKitChoice(id: id, text: text, detail: detail, count: count, isSelected: isSelected, isCorrect: isCorrect,
                      isWrongPick: isWrongPick, isDisabled: isDisabled)
    }

    var mark: GameKitMark {
        if isCorrect { return GameKitMark.correct }
        if isWrongPick { return GameKitMark.wrongPick }
        if isSelected { return GameKitMark.selected }
        return GameKitMark.none
    }
}

enum GameKitMark: String, CaseIterable, Equatable {
    case none, selected, correct, wrongPick
}

struct GameKitSplit: Equatable {
    let labelA: String
    let labelB: String
    let countA: Int
    let countB: Int
    let namesA: [String]
    let namesB: [String]

    var total: Int { countA + countB }

    var fractionA: Double {
        if total <= 0 { return 0.5 }
        return Double(countA) / Double(total)
    }
}

struct GameKitRoundRow: Equatable, Identifiable {
    let id: String
    let rank: Int
    let name: String
    let value: String
    let isYou: Bool
    let isWinner: Bool
    let isMuted: Bool
}

enum GameKitNoticeKind: String, CaseIterable, Equatable {
    case failure, spectator, privateView, unsupported, reconnecting, info
}

enum GameKitBarPolicy {

    static let stackCharacterBudget = 28

    static func stacks(primaryTitle: String, secondaryTitle: String, isAccessibilitySize: Bool) -> Bool {
        isAccessibilitySize || primaryTitle.count + secondaryTitle.count > stackCharacterBudget
    }
}
