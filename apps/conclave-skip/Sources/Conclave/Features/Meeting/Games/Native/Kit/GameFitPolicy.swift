import Foundation

struct GameFitSpace: Equatable {
    let width: Double
    let height: Double

    static let unbounded = GameFitSpace(width: 0.0, height: 0.0)

    var isBounded: Bool { width.isFinite && height.isFinite && width > 0 && height > 0 }
}

struct GameFitRange: Equatable {
    let minimum: Double
    let maximum: Double
}

struct GameFitMetrics: Equatable {
    let keyHeight: Double
    let keyRowSpacing: Double
    let bannerHeight: Double
    let hintHeight: Double

    static let iOS = GameFitMetrics(keyHeight: 44.0, keyRowSpacing: 6.0, bannerHeight: 64.0, hintHeight: 36.0)
    static let android = GameFitMetrics(keyHeight: 48.0, keyRowSpacing: 6.0, bannerHeight: 68.0, hintHeight: 32.0)

    var keyboardHeight: Double { 3.0 * keyHeight + 2.0 * keyRowSpacing }
}

enum GameFitPolicy {
    static let contentPadding = 16.0
    static let noticeSpacing = 14.0

    static func sceneSpace(viewportWidth: Double, viewportHeight: Double, hiddenBottom: Double, noticesHeight: Double) -> GameFitSpace {
        guard viewportWidth.isFinite, viewportHeight.isFinite, hiddenBottom.isFinite, noticesHeight.isFinite else { return .unbounded }
        let notices = noticesHeight > 0 ? noticesHeight + noticeSpacing : 0.0
        let width = viewportWidth - 2.0 * contentPadding
        let height = viewportHeight - max(0.0, hiddenBottom) - 2.0 * contentPadding - notices
        if width <= 0 || height <= 0 { return .unbounded }
        return GameFitSpace(width: width, height: height)
    }

    static func flexHeight(space: GameFitSpace, fixed: Double, range: GameFitRange) -> Double {
        guard space.isBounded, fixed.isFinite else { return range.maximum }
        return min(range.maximum, max(range.minimum, space.height - max(0.0, fixed)))
    }
}

struct WordleFitLayout: Equatable {
    let cellSide: Double
    let boardHeight: Double
    let fits: Bool
}

enum WordleFitPolicy {
    static let maximumCell = WordleBoardPolicy.cellSize
    static let minimumCell = 28.0
    static let sectionSpacing = 12.0

    static func boardHeight(cell: Double, rows: Int) -> Double {
        if rows <= 0 { return 0.0 }
        return Double(rows) * cell + Double(rows - 1) * WordleBoardPolicy.gap
    }

    static func boardWidth(cell: Double, columns: Int) -> Double {
        if columns <= 0 { return 0.0 }
        return Double(columns) * cell + Double(columns - 1) * WordleBoardPolicy.gap
    }

    static func boardRange(rows: Int) -> GameFitRange {
        GameFitRange(minimum: boardHeight(cell: minimumCell, rows: rows), maximum: boardHeight(cell: maximumCell, rows: rows))
    }

    static func cellSide(height: Double, width: Double, rows: Int, columns: Int) -> Double {
        var side = maximumCell
        if rows > 0 && height.isFinite && height > 0 {
            side = min(side, (height - Double(rows - 1) * WordleBoardPolicy.gap) / Double(rows))
        }
        if columns > 0 && width.isFinite && width > 0 {
            side = min(side, (width - Double(columns - 1) * WordleBoardPolicy.gap) / Double(columns))
        }
        return max(minimumCell, side.rounded(.down))
    }

    static func layout(space: GameFitSpace, lead: Double, input: Double, rows: Int, columns: Int) -> WordleFitLayout {
        let fixed = max(0.0, lead) + sectionSpacing + (input > 0 ? input + sectionSpacing : 0.0)
        let height = GameFitPolicy.flexHeight(space: space, fixed: fixed, range: boardRange(rows: rows))
        let cell = cellSide(height: height, width: space.isBounded ? space.width : 0.0, rows: rows, columns: columns)
        let board = boardHeight(cell: cell, rows: rows)
        return WordleFitLayout(cellSide: cell, boardHeight: board, fits: !space.isBounded || fixed + board <= space.height + 0.5)
    }

    static func showsHint(space: GameFitSpace, metrics: GameFitMetrics, rows: Int, columns: Int, hasKeyboard: Bool) -> Bool {
        if !space.isBounded { return true }
        let roomy = layout(space: space, lead: metrics.bannerHeight + metrics.hintHeight,
                           input: hasKeyboard ? metrics.keyboardHeight : 0.0, rows: rows, columns: columns)
        return roomy.fits && roomy.cellSide >= maximumCell
    }
}

enum WordleClock: String, Equatable {
    case none, round, turn
}

struct WordleClockPlan: Equatable {
    let chip: WordleClock
    let showsRoundInMeta: Bool
}

enum WordleClockPolicy {
    static let sameDeadlineMillis = 1000.0

    static func plan(roundDeadlineMillis: Double, turnDeadlineMillis: Double) -> WordleClockPlan {
        let hasRound = roundDeadlineMillis.isFinite && roundDeadlineMillis > 0
        let hasTurn = turnDeadlineMillis.isFinite && turnDeadlineMillis > 0
        if !hasTurn { return WordleClockPlan(chip: hasRound ? WordleClock.round : WordleClock.none, showsRoundInMeta: false) }
        if !hasRound { return WordleClockPlan(chip: WordleClock.turn, showsRoundInMeta: false) }
        if roundDeadlineMillis < turnDeadlineMillis - sameDeadlineMillis {
            return WordleClockPlan(chip: WordleClock.round, showsRoundInMeta: false)
        }
        return WordleClockPlan(chip: WordleClock.turn, showsRoundInMeta: roundDeadlineMillis > turnDeadlineMillis + sameDeadlineMillis)
    }
}

enum LongShotFitPolicy {
    static let maximumRung = 40.0
    static let minimumRung = 30.0
    static let rungSpacing = 4.0

    static func ladderHeight(rung: Double, count: Int) -> Double {
        if count <= 0 { return 0.0 }
        return Double(count) * rung + Double(count - 1) * rungSpacing
    }

    static func ladderRange(count: Int) -> GameFitRange {
        GameFitRange(minimum: ladderHeight(rung: minimumRung, count: count), maximum: ladderHeight(rung: maximumRung, count: count))
    }

    static func rungHeight(height: Double, count: Int) -> Double {
        guard count > 0, height.isFinite, height > 0 else { return maximumRung }
        let side = (height - Double(count - 1) * rungSpacing) / Double(count)
        return min(maximumRung, max(minimumRung, side.rounded(.down)))
    }
}
