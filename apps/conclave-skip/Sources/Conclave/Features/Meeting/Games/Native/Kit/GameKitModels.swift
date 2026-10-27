import Foundation

// S60 L6-5 (ACT-2): the shared value models of the game kit K1 to K13. The kit views are per platform (SwiftUI in
// `Kit/*+iOS.swift`, Compose in `K/ui/games/kit/`); scenes (ACT-3 to ACT-6) build these values from their scene
// models so both platforms draw the same states. Correctness always has a text or glyph twin (D4): a state is never
// shown by color alone.

/// K3 and K4: one option. `count` is -1 while counts are hidden (before the reveal).
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

    /// The marker the row shows beside its text (glyph plus word, never color alone).
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

/// K5: a two-sided split result (Would You Rather reveal). Bars are flat paper at 100% and 32% on the strong border.
struct GameKitSplit: Equatable {
    let labelA: String
    let labelB: String
    let countA: Int
    let countB: Int
    let namesA: [String]
    let namesB: [String]

    var total: Int { countA + countB }

    /// The share of side A from 0 to 1 (0.5 with no votes, so the bar never collapses).
    var fractionA: Double {
        if total <= 0 { return 0.5 }
        return Double(countA) / Double(total)
    }
}

/// K9: one ranked round row ("312 ms", "too soon", "no tap"); `value` is resolved by the scene's copy.
struct GameKitRoundRow: Equatable, Identifiable {
    let id: String
    let rank: Int
    let name: String
    let value: String
    let isYou: Bool
    let isWinner: Bool
    let isMuted: Bool
}

/// K13 notice kinds (S60 L6-5: error, spectator, unsupported; plus private view and reconnecting).
enum GameKitNoticeKind: String, CaseIterable, Equatable {
    case failure, spectator, privateView, unsupported, reconnecting, info
}

/// K7 host bar layout: two buttons side by side, stacked when they do not fit (Dynamic Type, font scale 2.0).
enum GameKitBarPolicy {
    /// Above this many characters across both titles, the iOS bar stacks at accessibility sizes.
    static let stackCharacterBudget = 28

    static func stacks(primaryTitle: String, secondaryTitle: String, isAccessibilitySize: Bool) -> Bool {
        isAccessibilitySize || primaryTitle.count + secondaryTitle.count > stackCharacterBudget
    }
}
