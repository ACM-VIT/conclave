import Foundation

enum ZipPhase: String, CaseIterable, Equatable {
    case lobby, playing, results
}

enum ZipRole: String, CaseIterable, Equatable {
    case player, spectator
}

enum ZipOutcome: String, CaseIterable, Equatable {
    case none, solved, timedOut
}

enum ZipStandingStatus: String, CaseIterable, Equatable {
    case playing, solved, timedOut
}

enum ZipDirection: String, CaseIterable, Equatable {
    case up, down, left, right
}

struct ZipCheckpointModel: Equatable, Identifiable {
    let id: String
    let cell: Int
    let number: Int
}

struct ZipWallModel: Equatable, Identifiable {
    let id: String
    let from: Int
    let to: Int

    var isBetweenColumns: Bool { to == from + 1 }
}

struct ZipCellModel: Equatable, Identifiable {

    let id: String
    let index: Int

    let row: Int
    let column: Int

    let checkpoint: Int

    let isDead: Bool
    let isVisited: Bool

    let isHead: Bool

    let isNext: Bool
}

struct ZipStandingModel: Equatable, Identifiable {
    let id: String
    let name: String
    let status: ZipStandingStatus
    let cellsFilled: Int
    let totalCells: Int
    let hintsUsed: Int

    let solvedMillis: Double
    let isYou: Bool
}

struct ZipScene: Equatable {
    let phase: ZipPhase

    let round: Int
    let roundTotal: Int

    let size: Int
    let checkpoints: [ZipCheckpointModel]
    let walls: [ZipWallModel]
    let deadCells: [Int]
    let cells: [ZipCellModel]
    let confirmedPath: [Int]
    let visitedCount: Int
    let totalCells: Int
    let hintsUsed: Int

    let hintReadyAtMillis: Double

    let hintCostPoints: Int
    let canMove: Bool
    let canHint: Bool
    let canReset: Bool
    let isSolved: Bool
    let solvedMillis: Double
    let myOutcome: ZipOutcome
    let role: ZipRole
    let isPlayer: Bool
    let standings: [ZipStandingModel]

    let solutionPath: [Int]
    let winnerName: String
    let isFinalRound: Bool
    let finishedCount: Int
    let totalPlayers: Int

    let isReconnecting: Bool

    let canAdvanceRound: Bool

    var canUndo: Bool { canReset }

    var startCell: Int {
        for checkpoint in checkpoints where checkpoint.number == 1 {
            return checkpoint.cell
        }
        return confirmedPath.isEmpty ? -1 : confirmedPath[0]
    }

    func hintCooldownMillis(nowMillis: Double) -> Double {
        if hintReadyAtMillis <= 0 { return 0 }
        return max(0.0, hintReadyAtMillis - nowMillis)
    }

    func hintCooldownSeconds(nowMillis: Double) -> Int {
        let remaining = hintCooldownMillis(nowMillis: nowMillis)
        if remaining <= 0 { return 0 }
        return Int((remaining / 1000.0).rounded(.up))
    }

    var outcomeKey: String {
        myOutcome == ZipOutcome.none ? "" : "zip-outcome-" + String(round) + "-" + myOutcome.rawValue
    }

    var resultKey: String {
        phase == ZipPhase.results ? "zip-result-" + String(round) : ""
    }
}

enum ZipSceneBuilder {
    static let defaultSize = 6

    static let solveBase = 100
    static let hintPenalty = 15
    static let minSolveScore = 10
    static let hintCooldownTotalMillis = 3000.0

    static func scene(_ projection: ZipProjection, context: PromptSceneContext, serverNowMillis: Double,
                      receivedAtMillis: Double) -> ZipScene {
        let phase = parsePhase(projection.phase)
        let size = projection.gridSize >= 2 ? projection.gridSize : defaultSize
        let cellCount = size * size
        var checkpoints: [ZipCheckpointModel] = []
        for entry in projection.anchors {
            let cell = Int(entry.key) ?? -1
            if cell < 0 || cell >= cellCount || entry.count <= 0 { continue }
            checkpoints.append(ZipCheckpointModel(id: "checkpoint-" + String(cell), cell: cell, number: entry.count))
        }
        checkpoints = checkpoints.sorted { $0.number < $1.number }
        var walls: [ZipWallModel] = []
        for barrier in projection.barriers {
            let low = min(barrier.from, barrier.to)
            let high = max(barrier.from, barrier.to)
            if low < 0 || high >= cellCount || !ZipPathPolicy.isAdjacent(low, high, size: size) { continue }
            walls.append(ZipWallModel(id: "wall-" + String(low) + "-" + String(high), from: low, to: high))
        }
        var deadCells: [Int] = []
        for cell in projection.deadCells where cell >= 0 && cell < cellCount && !deadCells.contains(cell) {
            deadCells.append(cell)
        }
        deadCells = deadCells.sorted()
        let localId = context.localId
        var isContestant = false
        var standings: [ZipStandingModel] = []
        for entry in projection.standings {
            let isYou = !localId.isEmpty && entry.id == localId
            if isYou { isContestant = true }
            let status = parseStatus(entry.outcome)
            standings.append(ZipStandingModel(id: entry.id, name: entry.name, status: status, cellsFilled: entry.cellsFilled,
                                              totalCells: entry.totalCells,
                                              hintsUsed: entry.hintsUsed,
                                              solvedMillis: status == ZipStandingStatus.solved
                                                  ? elapsed(entry.solvedAtMillis, since: projection.roundStartedAtMillis) : 0.0,
                                              isYou: isYou))
        }
        let isPlayer = context.isPlayer
        let role = isPlayer && isContestant ? ZipRole.player : ZipRole.spectator
        var path: [Int] = []
        var outcome = ZipOutcome.none
        var hintsUsed = 0
        var hintReadyAt = 0.0
        var solvedMillis = 0.0
        if role == ZipRole.player {
            for cell in projection.path where cell >= 0 && cell < cellCount {
                path.append(cell)
            }
            outcome = parseOutcome(projection.outcome)
            hintsUsed = max(0, projection.hintsUsed)
            if projection.hintAvailableAtMillis > 0 && serverNowMillis > 0 && receivedAtMillis > 0 {
                hintReadyAt = projection.hintAvailableAtMillis + (receivedAtMillis - serverNowMillis)
            } else if projection.hintAvailableAtMillis > serverNowMillis && serverNowMillis > 0 {
                hintReadyAt = projection.hintAvailableAtMillis
            }
            if outcome == ZipOutcome.solved { solvedMillis = elapsed(projection.solvedAtMillis, since: projection.roundStartedAtMillis) }
        }
        let totalCells = max(0, cellCount - deadCells.count)
        let recovering = context.isRecovering
        let canMove = role == ZipRole.player && phase == ZipPhase.playing && outcome == ZipOutcome.none && !recovering && !path.isEmpty
        let isResults = phase == ZipPhase.results
        var winner = isResults ? projection.winnerName : ""
        if isResults && winner.isEmpty && !projection.winnerId.isEmpty {
            for entry in standings where entry.id == projection.winnerId {
                winner = entry.name
            }
            if winner.isEmpty { winner = context.knownName(projection.winnerId) }
        }
        var solution: [Int] = []
        if isResults {
            for cell in projection.solutionPath where cell >= 0 && cell < cellCount {
                solution.append(cell)
            }
        }
        let partial = ZipScene(phase: phase, round: projection.currentRound, roundTotal: projection.totalRounds, size: size,
                               checkpoints: checkpoints, walls: walls, deadCells: deadCells, cells: [], confirmedPath: path,
                               visitedCount: path.count, totalCells: totalCells, hintsUsed: hintsUsed, hintReadyAtMillis: hintReadyAt,
                               hintCostPoints: hintCost(hintsUsed: hintsUsed), canMove: canMove,
                               canHint: canMove && path.count < totalCells, canReset: canMove && path.count > 1,
                               isSolved: outcome == ZipOutcome.solved, solvedMillis: solvedMillis, myOutcome: outcome, role: role,
                               isPlayer: isPlayer, standings: standings, solutionPath: solution, winnerName: winner,
                               isFinalRound: projection.isFinalRound, finishedCount: projection.finishedCount,
                               totalPlayers: projection.totalPlayers, isReconnecting: recovering,
                               canAdvanceRound: isResults && !projection.isFinalRound && context.isHost && isPlayer && !recovering)
        return ZipPathPolicy.withCells(partial)
    }

    static func hintCost(hintsUsed: Int) -> Int {
        let now = max(minSolveScore, solveBase - hintsUsed * hintPenalty)
        let next = max(minSolveScore, solveBase - (hintsUsed + 1) * hintPenalty)
        return max(0, now - next)
    }

    static func elapsed(_ atMillis: Double, since startMillis: Double) -> Double {
        if atMillis <= 0 || startMillis <= 0 { return 0 }
        return max(0.0, atMillis - startMillis)
    }

    static func parsePhase(_ raw: String) -> ZipPhase {
        switch raw {
        case "playing": return ZipPhase.playing
        case "results": return ZipPhase.results
        default: return ZipPhase.lobby
        }
    }

    static func parseOutcome(_ raw: String) -> ZipOutcome {
        switch raw {
        case "win": return ZipOutcome.solved
        case "timeout": return ZipOutcome.timedOut
        default: return ZipOutcome.none
        }
    }

    static func parseStatus(_ raw: String) -> ZipStandingStatus {
        switch raw {
        case "win": return ZipStandingStatus.solved
        case "timeout": return ZipStandingStatus.timedOut
        default: return ZipStandingStatus.playing
        }
    }
}

enum ZipPathPolicy {

    static let maxBoardSide = 360.0

    static let pathWidth = 6.0
    static let dashLength = 6.0

    static let headDiameter = 12.0

    static let wallWidth = 4.0

    static let cellInset = 1.0
    static let cellCorner = 4.0

    static let checkpointRadiusFactor = 0.32

    static let compactCellSide = 44.0

    static let pathRuleReasons: [String] = [
        "Cell is out of bounds", "Path is empty", "Cell is not orthogonally adjacent", "Cell is a dead cell",
        "Cell already visited", "A barrier blocks this move", "Anchor visited out of order", "Path must start at anchor 1",
        "Path must contain valid cell IDs", "No cells provided", "Path is longer than this puzzle allows", "Invalid move payload",
    ]

    static func isPathRejection(_ serverText: String) -> Bool {
        pathRuleReasons.contains(serverText.trimmingCharacters(in: .whitespacesAndNewlines))
    }

    static func boardSide(available: Double) -> Double {
        max(0.0, min(maxBoardSide, available))
    }

    static func cellSide(boardSide: Double, size: Int) -> Double {
        size > 0 ? boardSide / Double(size) : 0.0
    }

    static func row(_ cell: Int, size: Int) -> Int {
        size > 0 ? cell / size : 0
    }

    static func column(_ cell: Int, size: Int) -> Int {
        size > 0 ? cell % size : 0
    }

    static func cellIndex(row: Int, column: Int, size: Int) -> Int {
        if row < 0 || column < 0 || row >= size || column >= size { return -1 }
        return row * size + column
    }

    static func cellAt(x: Double, y: Double, boardSide: Double, size: Int) -> Int {
        if size <= 0 || boardSide <= 0 || x < 0 || y < 0 || x >= boardSide || y >= boardSide { return -1 }
        let side = boardSide / Double(size)
        let columnIndex = min(size - 1, Int(x / side))
        let rowIndex = min(size - 1, Int(y / side))
        return cellIndex(row: rowIndex, column: columnIndex, size: size)
    }

    static func centerX(_ cell: Int, boardSide: Double, size: Int) -> Double {
        (Double(column(cell, size: size)) + 0.5) * cellSide(boardSide: boardSide, size: size)
    }

    static func centerY(_ cell: Int, boardSide: Double, size: Int) -> Double {
        (Double(row(cell, size: size)) + 0.5) * cellSide(boardSide: boardSide, size: size)
    }

    static func neighbor(_ cell: Int, direction: ZipDirection, size: Int) -> Int {
        if cell < 0 || cell >= size * size { return -1 }
        let r = row(cell, size: size)
        let c = column(cell, size: size)
        switch direction {
        case .up: return cellIndex(row: r - 1, column: c, size: size)
        case .down: return cellIndex(row: r + 1, column: c, size: size)
        case .left: return cellIndex(row: r, column: c - 1, size: size)
        case .right: return cellIndex(row: r, column: c + 1, size: size)
        }
    }

    static func isAdjacent(_ a: Int, _ b: Int, size: Int) -> Bool {
        if size <= 0 || a < 0 || b < 0 || a >= size * size || b >= size * size { return false }
        let rows = row(a, size: size) - row(b, size: size)
        let columns = column(a, size: size) - column(b, size: size)
        let distance = (rows < 0 ? -rows : rows) + (columns < 0 ? -columns : columns)
        return distance == 1
    }

    static func isWall(_ a: Int, _ b: Int, walls: [ZipWallModel]) -> Bool {
        let low = min(a, b)
        let high = max(a, b)
        for wall in walls where wall.from == low && wall.to == high {
            return true
        }
        return false
    }

    static func checkpointNumber(_ cell: Int, checkpoints: [ZipCheckpointModel]) -> Int {
        for checkpoint in checkpoints where checkpoint.cell == cell {
            return checkpoint.number
        }
        return 0
    }

    static func nextCheckpoint(_ path: [Int], checkpoints: [ZipCheckpointModel]) -> Int {
        var expected = 1
        for cell in path where checkpointNumber(cell, checkpoints: checkpoints) == expected {
            expected += 1
        }
        return expected
    }

    static func canExtend(_ path: [Int], to cell: Int, scene: ZipScene) -> Bool {
        if path.isEmpty || cell < 0 || cell >= scene.size * scene.size { return false }
        let head = path[path.count - 1]
        if !isAdjacent(head, cell, size: scene.size) { return false }
        if scene.deadCells.contains(cell) || path.contains(cell) { return false }
        if isWall(head, cell, walls: scene.walls) { return false }
        let number = checkpointNumber(cell, checkpoints: scene.checkpoints)
        if number > 0 && number != nextCheckpoint(path, checkpoints: scene.checkpoints) { return false }
        return true
    }

    static func eligibleNext(_ path: [Int], scene: ZipScene) -> [Int] {
        var result: [Int] = []
        if path.isEmpty { return result }
        let head = path[path.count - 1]
        for direction in [ZipDirection.up, ZipDirection.left, ZipDirection.right, ZipDirection.down] {
            let cell = neighbor(head, direction: direction, size: scene.size)
            if cell >= 0 && canExtend(path, to: cell, scene: scene) { result.append(cell) }
        }
        return result
    }

    static func afterStep(_ path: [Int], to cell: Int, scene: ZipScene) -> [Int] {
        if path.count >= 2 && path[path.count - 2] == cell { return withoutLast(path) }
        if canExtend(path, to: cell, scene: scene) { return appending(path, cell) }
        return path
    }

    static func startsDrawing(_ path: [Int], at cell: Int, scene: ZipScene) -> Bool {
        if !scene.canMove || cell < 0 { return false }
        if path.contains(cell) { return true }
        return canExtend(path, to: cell, scene: scene)
    }

    static func touchDown(_ path: [Int], at cell: Int, scene: ZipScene) -> [Int] {
        var index = 0
        while index < path.count {
            if path[index] == cell { return leading(path, count: index + 1) }
            index += 1
        }
        if canExtend(path, to: cell, scene: scene) { return appending(path, cell) }
        return path
    }

    static func cellsBetween(_ from: Int, _ to: Int, size: Int) -> [Int] {
        var result: [Int] = []
        if from < 0 || to < 0 || from == to || size <= 0 { return result }
        var r = row(from, size: size)
        var c = column(from, size: size)
        let targetRow = row(to, size: size)
        let targetColumn = column(to, size: size)
        let rowDelta = targetRow - r
        let columnDelta = targetColumn - c
        let rowsFirst = (rowDelta < 0 ? -rowDelta : rowDelta) > (columnDelta < 0 ? -columnDelta : columnDelta)
        let rowStep = rowDelta > 0 ? 1 : -1
        let columnStep = columnDelta > 0 ? 1 : -1
        if rowsFirst {
            while r != targetRow {
                r += rowStep
                result.append(cellIndex(row: r, column: c, size: size))
            }
            while c != targetColumn {
                c += columnStep
                result.append(cellIndex(row: r, column: c, size: size))
            }
        } else {
            while c != targetColumn {
                c += columnStep
                result.append(cellIndex(row: r, column: c, size: size))
            }
            while r != targetRow {
                r += rowStep
                result.append(cellIndex(row: r, column: c, size: size))
            }
        }
        return result
    }

    static func dragged(_ path: [Int], from: Int, to: Int, scene: ZipScene) -> [Int] {
        var result = path
        for cell in cellsBetween(from, to, size: scene.size) {
            result = afterStep(result, to: cell, scene: scene)
        }
        return result
    }

    static func keyStep(_ path: [Int], direction: ZipDirection, scene: ZipScene) -> [Int] {
        if path.isEmpty { return path }
        let cell = neighbor(path[path.count - 1], direction: direction, size: scene.size)
        if cell < 0 { return path }
        return afterStep(path, to: cell, scene: scene)
    }

    static func undone(_ path: [Int]) -> [Int] {
        path.count > 1 ? withoutLast(path) : path
    }

    static func stepped(_ path: [Int], to cell: Int) -> [Int] {
        appending(path, cell)
    }

    static func shouldSend(draft: [Int], confirmed: [Int]) -> Bool {
        !draft.isEmpty && !samePath(draft, confirmed)
    }

    static func samePath(_ a: [Int], _ b: [Int]) -> Bool {
        if a.count != b.count { return false }
        var index = 0
        while index < a.count {
            if a[index] != b[index] { return false }
            index += 1
        }
        return true
    }

    static func sharedPrefixCount(_ a: [Int], _ b: [Int]) -> Int {
        var count = 0
        while count < a.count && count < b.count && a[count] == b[count] {
            count += 1
        }
        return count
    }

    static func displayPath(confirmed: [Int], draft: [Int], isDrafting: Bool, sent: [Int]) -> [Int] {
        if isDrafting { return draft }
        if !sent.isEmpty { return sent }
        return confirmed
    }

    static func progressCount(confirmed: [Int], display: [Int]) -> Int {
        display.isEmpty ? confirmed.count : display.count
    }

    static func withCells(_ scene: ZipScene) -> ZipScene {
        let next = scene.canMove ? eligibleNext(scene.confirmedPath, scene: scene) : []
        let head = scene.confirmedPath.isEmpty ? -1 : scene.confirmedPath[scene.confirmedPath.count - 1]
        var cells: [ZipCellModel] = []
        var index = 0
        let count = scene.size * scene.size
        while index < count {
            cells.append(ZipCellModel(id: "cell-" + String(index), index: index, row: row(index, size: scene.size),
                                      column: column(index, size: scene.size),
                                      checkpoint: checkpointNumber(index, checkpoints: scene.checkpoints),
                                      isDead: scene.deadCells.contains(index), isVisited: scene.confirmedPath.contains(index),
                                      isHead: index == head, isNext: next.contains(index)))
            index += 1
        }
        return ZipScene(phase: scene.phase, round: scene.round, roundTotal: scene.roundTotal, size: scene.size,
                        checkpoints: scene.checkpoints, walls: scene.walls, deadCells: scene.deadCells, cells: cells,
                        confirmedPath: scene.confirmedPath, visitedCount: scene.visitedCount, totalCells: scene.totalCells,
                        hintsUsed: scene.hintsUsed, hintReadyAtMillis: scene.hintReadyAtMillis, hintCostPoints: scene.hintCostPoints,
                        canMove: scene.canMove, canHint: scene.canHint, canReset: scene.canReset, isSolved: scene.isSolved,
                        solvedMillis: scene.solvedMillis, myOutcome: scene.myOutcome, role: scene.role, isPlayer: scene.isPlayer,
                        standings: scene.standings, solutionPath: scene.solutionPath, winnerName: scene.winnerName,
                        isFinalRound: scene.isFinalRound, finishedCount: scene.finishedCount, totalPlayers: scene.totalPlayers,
                        isReconnecting: scene.isReconnecting, canAdvanceRound: scene.canAdvanceRound)
    }

    static func chooserCells(_ scene: ZipScene) -> [ZipCellModel] {
        var result: [ZipCellModel] = []
        for cell in scene.cells where cell.isNext {
            result.append(cell)
        }
        return result
    }

    static func withoutLast(_ path: [Int]) -> [Int] {
        leading(path, count: path.count - 1)
    }

    static func leading(_ path: [Int], count: Int) -> [Int] {
        var result: [Int] = []
        var index = 0
        while index < count && index < path.count {
            result.append(path[index])
            index += 1
        }
        return result
    }

    static func appending(_ path: [Int], _ cell: Int) -> [Int] {
        var result: [Int] = []
        for existing in path {
            result.append(existing)
        }
        result.append(cell)
        return result
    }
}

enum ZipTimePolicy {
    static func wholeSeconds(_ millis: Double) -> Int {
        if millis <= 0 { return 0 }
        return Int(millis / 1000.0)
    }

    static let warningSeconds = 10
    static let announcedSeconds: [Int] = [60, 10]
}

enum ZipOutcomePolicy {

    static func solved(previous: ZipScene?, next: ZipScene?) -> FeedbackKind {
        guard let before = previous, let after = next else { return FeedbackKind.none }
        if after.role != ZipRole.player || before.round != after.round { return FeedbackKind.none }
        if before.myOutcome != ZipOutcome.solved && after.myOutcome == ZipOutcome.solved { return FeedbackKind.gameCorrect }
        return FeedbackKind.none
    }
}

enum ZipIntent {
    static let moveType = "move"
    static let hintType = "hint"
    static let resetType = "reset"
    static let nextRoundType = "nextRound"

    static func move(_ cells: [Int]) -> GameMoveIntent { GameMoveIntent.make(type: moveType, cells: cells) }
    static func hint() -> GameMoveIntent { GameMoveIntent.make(type: hintType) }
    static func reset() -> GameMoveIntent { GameMoveIntent.make(type: resetType) }
    static func nextRound() -> GameMoveIntent { GameMoveIntent.make(type: nextRoundType) }
}
