import Foundation

// S60 12 B4 (ACT-6): the Zip scene models, built once per push from `ZipProjection` (GameProjections.swift; G/zip.ts
// publicView 529-593 and playerView 595-604) and published inside `GameScene.zip`, so both platforms' boards read ready
// values and never parse JSON. Your path, outcome, hints and hint cooldown come only from your own player view while you
// hold a seat and the module counts you in the round; everyone else (no seat, or a seat granted after the round began)
// watches the public progress only. The path rules mirror packages/sfu/server/games/zipSolver.ts `validateMove`
// (orthogonal step, no dead cell, no revisit, no barrier, checkpoints in order), all of which the public view carries, so
// a blocked step is unambiguous and never invented. The draft path is view-local until sent (S60 12 j, k); the policies
// here are pure, so a drag publishes nothing per cell. Shared (transpiled): String raw-value enums, scalar structs and
// arrays of structs only.

/// G/zip.ts phases (the shell draws the lobby).
enum ZipPhase: String, CaseIterable, Equatable {
    case lobby, playing, results
}

/// Your part in this round: a player with a board, or watching the public progress (no seat, or a seat granted after the
/// round began, which the module does not count: "You are not in this round").
enum ZipRole: String, CaseIterable, Equatable {
    case player, spectator
}

/// Your board's end (G/zip.ts `PlayerOutcome`: "win", "timeout").
enum ZipOutcome: String, CaseIterable, Equatable {
    case none, solved, timedOut
}

/// A player's state in the public standings (`standings[].outcome`).
enum ZipStandingStatus: String, CaseIterable, Equatable {
    case playing, solved, timedOut
}

/// Arrow keys and the D-pad (S60 12 c, d).
enum ZipDirection: String, CaseIterable, Equatable {
    case up, down, left, right
}

/// One numbered checkpoint (`anchors`: cell index to its number), visited in order.
struct ZipCheckpointModel: Equatable, Identifiable {
    let id: String
    let cell: Int
    let number: Int
}

/// One barrier between two orthogonal neighbors (`barriers`), stored with the lower cell first.
struct ZipWallModel: Equatable, Identifiable {
    let id: String
    let from: Int
    let to: Int

    /// Side by side in one row: the wall is a vertical line between them; otherwise a horizontal line.
    var isBetweenColumns: Bool { to == from + 1 }
}

/// One cell as screen readers meet it (the synthetic board children, S60 12 c, d, i), built once per push from the
/// confirmed path, so the overlay reads one immutable array and never observes per cell.
struct ZipCellModel: Equatable, Identifiable {
    /// "cell-<index>".
    let id: String
    let index: Int
    /// 0-based; read 1-based ("Row %lld, column %lld").
    let row: Int
    let column: Int
    /// The checkpoint number, 0 when the cell has none.
    let checkpoint: Int
    /// Not part of this puzzle (`deadCells`).
    let isDead: Bool
    let isVisited: Bool
    /// The end of your confirmed path.
    let isHead: Bool
    /// One of the cells your path may take next (the step chooser lists exactly these).
    let isNext: Bool
}

struct ZipStandingModel: Equatable, Identifiable {
    let id: String
    let name: String
    let status: ZipStandingStatus
    let cellsFilled: Int
    let totalCells: Int
    let hintsUsed: Int
    /// The solve time from the round start; 0 unless solved.
    let solvedMillis: Double
    let isYou: Bool
}

/// S60 12 j. `confirmedPath` is the server's path for you; the board adds a view-local draft while a finger, a key run or
/// a sent move is in flight (`ZipPathPolicy.displayPath`). `hintReadyAtMillis` is on the client clock (the server's
/// `hintAvailableAt` plus the push's clock offset), so the cooldown leaf never trusts the device clock alone.
struct ZipScene: Equatable {
    let phase: ZipPhase
    /// 1-based; 0 in the lobby.
    let round: Int
    let roundTotal: Int
    /// Cells per side (6 to 9).
    let size: Int
    let checkpoints: [ZipCheckpointModel]
    let walls: [ZipWallModel]
    let deadCells: [Int]
    let cells: [ZipCellModel]
    let confirmedPath: [Int]
    let visitedCount: Int
    let totalCells: Int
    let hintsUsed: Int
    /// 0 when no cooldown applies.
    let hintReadyAtMillis: Double
    /// What the next hint costs in points at the module's scoring (100 minus 15 per hint, at least 10); 0 when free.
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
    /// Set at the results only (G/zip.ts `result.solutionPath`).
    let solutionPath: [Int]
    let winnerName: String
    let isFinalRound: Bool
    let finishedCount: Int
    let totalPlayers: Int
    /// Reconnecting: the board is read-only (S60 12 f).
    let isReconnecting: Bool
    /// Next Round for a seated host at a round's results before the final round (G/zip.ts `nextRound`; the engine takes
    /// moves only from seated players).
    let canAdvanceRound: Bool

    /// Undo sends the path minus its last cell, so it needs a step beyond checkpoint 1 (as Reset does).
    var canUndo: Bool { canReset }

    /// The cell every path starts from (checkpoint 1), or -1 before the puzzle exists.
    var startCell: Int {
        for checkpoint in checkpoints where checkpoint.number == 1 {
            return checkpoint.cell
        }
        return confirmedPath.isEmpty ? -1 : confirmedPath[0]
    }

    /// Milliseconds until Hint is available again at `nowMillis` (client clock); 0 when it is.
    func hintCooldownMillis(nowMillis: Double) -> Double {
        if hintReadyAtMillis <= 0 { return 0 }
        return max(0.0, hintReadyAtMillis - nowMillis)
    }

    /// Whole seconds for "Hint (%lld s)", rounded up so "1 s" shows until it ends.
    func hintCooldownSeconds(nowMillis: Double) -> Int {
        let remaining = hintCooldownMillis(nowMillis: nowMillis)
        if remaining <= 0 { return 0 }
        return Int((remaining / 1000.0).rounded(.up))
    }

    /// One-shot announcement keys (S60 12 i); "" when nothing is due.
    var outcomeKey: String {
        myOutcome == ZipOutcome.none ? "" : "zip-outcome-" + String(round) + "-" + myOutcome.rawValue
    }

    var resultKey: String {
        phase == ZipPhase.results ? "zip-result-" + String(round) : ""
    }
}

enum ZipSceneBuilder {
    static let defaultSize = 6
    /// G/zip.ts scoring and hint constants (SOLVE_BASE, HINT_PENALTY, MIN_SOLVE_SCORE, HINT_COOLDOWN_MS).
    static let solveBase = 100
    static let hintPenalty = 15
    static let minSolveScore = 10
    static let hintCooldownTotalMillis = 3000.0

    /// One push. `serverNowMillis` and `receivedAtMillis` give the clock offset the hint cooldown uses (the countdown's
    /// rule: the server clock plus the client minus server offset at the push).
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

    /// The points the next hint costs: the module's round score drops from max(10, 100 - 15h) to max(10, 100 - 15(h+1)).
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

/// The board's geometry and path rules both platforms share (S60 12 c, d, f). Every rule here is one the server enforces
/// with data the public view carries, so a blocked step never contradicts the server.
enum ZipPathPolicy {
    /// The board's largest side in pt/dp; it shrinks to the card's content width (9 x 9 on a 343 pt card is 38 pt cells).
    static let maxBoardSide = 360.0
    /// The coral path line (S60 12 c): 6 pt/dp, dashed 6 on 6 while pending.
    static let pathWidth = 6.0
    static let dashLength = 6.0
    /// The head marker: a coral dot twice the line width, so a one-cell path still shows where it ends.
    static let headDiameter = 12.0
    /// Barriers: 4 pt/dp paper lines on the shared edge.
    static let wallWidth = 4.0
    /// Each cell is inset 1 pt/dp, so the card shows a 2 pt/dp seam between cells; corners 4 pt/dp.
    static let cellInset = 1.0
    static let cellCorner = 4.0
    /// The checkpoint disc's radius as a share of the cell side.
    static let checkpointRadiusFactor = 0.32
    /// Below this cell side the checkpoint numbers use the smaller text style.
    static let compactCellSide = 44.0

    /// The server's path-rule rejections (zipSolver.ts `validateMove` and zip.ts `move`), shown as "That path isn't
    /// allowed. Try again." beside the shell's verbatim notice. Time and phase rejections are not path rules.
    static let pathRuleReasons: [String] = [
        "Cell is out of bounds", "Path is empty", "Cell is not orthogonally adjacent", "Cell is a dead cell",
        "Cell already visited", "A barrier blocks this move", "Anchor visited out of order", "Path must start at anchor 1",
        "Path must contain valid cell IDs", "No cells provided", "Path is longer than this puzzle allows", "Invalid move payload",
    ]

    static func isPathRejection(_ serverText: String) -> Bool {
        pathRuleReasons.contains(serverText.trimmingCharacters(in: .whitespacesAndNewlines))
    }

    // MARK: Geometry

    static func boardSide(available: Double) -> Double {
        max(0.0, min(maxBoardSide, available))
    }

    static func cellSide(boardSide: Double, size: Int) -> Double {
        size > 0 ? boardSide / Double(size) : 0
    }

    static func row(_ cell: Int, size: Int) -> Int {
        size > 0 ? cell / size : 0
    }

    static func column(_ cell: Int, size: Int) -> Int {
        size > 0 ? cell % size : 0
    }

    /// The cell index at a row and column, or -1 off the board.
    static func cellIndex(row: Int, column: Int, size: Int) -> Int {
        if row < 0 || column < 0 || row >= size || column >= size { return -1 }
        return row * size + column
    }

    /// The cell under a point in the board's own coordinates, or -1 outside it.
    static func cellAt(x: Double, y: Double, boardSide: Double, size: Int) -> Int {
        if size <= 0 || boardSide <= 0 || x < 0 || y < 0 || x >= boardSide || y >= boardSide { return -1 }
        let side = boardSide / Double(size)
        let columnIndex = min(size - 1, Int(x / side))
        let rowIndex = min(size - 1, Int(y / side))
        return cellIndex(row: rowIndex, column: columnIndex, size: size)
    }

    /// The center of a cell in the board's coordinates (the path runs through centers).
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

    // MARK: Rules (zipSolver.ts validateMove)

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

    /// The checkpoint the path must reach next (the module's `nextExpectedAnchor` loop).
    static func nextCheckpoint(_ path: [Int], checkpoints: [ZipCheckpointModel]) -> Int {
        var expected = 1
        for cell in path where checkpointNumber(cell, checkpoints: checkpoints) == expected {
            expected += 1
        }
        return expected
    }

    /// Whether `cell` may come next after `path`: one orthogonal step from the end, not removed, not visited, no barrier,
    /// and a checkpoint only when it is the next one.
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

    /// The cells the path may take next, in reading order (up, left, right, down) so the chooser lists them stably.
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

    // MARK: Drafts (view-local; one send per finger lift, key run or step)

    /// One finger or key step onto `cell`: back onto the previous cell trims one step; an eligible cell extends; anything
    /// else leaves the path as it is (no invented rule, no partial jump).
    static func afterStep(_ path: [Int], to cell: Int, scene: ZipScene) -> [Int] {
        if path.count >= 2 && path[path.count - 2] == cell { return withoutLast(path) }
        if canExtend(path, to: cell, scene: scene) { return appending(path, cell) }
        return path
    }

    /// Whether a touch on `cell` starts drawing: on your path (the end resumes, an earlier cell rewinds to it, as the web
    /// board does) or on a cell the path may take next (a single tap extends).
    static func startsDrawing(_ path: [Int], at cell: Int, scene: ZipScene) -> Bool {
        if !scene.canMove || cell < 0 { return false }
        if path.contains(cell) { return true }
        return canExtend(path, to: cell, scene: scene)
    }

    /// The draft after a touch lands on `cell` (see `startsDrawing`).
    static func touchDown(_ path: [Int], at cell: Int, scene: ZipScene) -> [Int] {
        var index = 0
        while index < path.count {
            if path[index] == cell { return leading(path, count: index + 1) }
            index += 1
        }
        if canExtend(path, to: cell, scene: scene) { return appending(path, cell) }
        return path
    }

    /// The cells a fast finger crossed from `from` to `to` (rows first when the move is mostly vertical), excluding `from`
    /// and including `to`, so no step is skipped (the web board's walk).
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

    /// The draft after the finger moved from `from` to `to`: each crossed cell is one step.
    static func dragged(_ path: [Int], from: Int, to: Int, scene: ZipScene) -> [Int] {
        var result = path
        for cell in cellsBetween(from, to, size: scene.size) {
            result = afterStep(result, to: cell, scene: scene)
        }
        return result
    }

    /// An arrow key: one step from the end of the path in that direction (back onto the previous cell trims one).
    static func keyStep(_ path: [Int], direction: ZipDirection, scene: ZipScene) -> [Int] {
        if path.isEmpty { return path }
        let cell = neighbor(path[path.count - 1], direction: direction, size: scene.size)
        if cell < 0 { return path }
        return afterStep(path, to: cell, scene: scene)
    }

    /// Undo: the path minus its last cell (never below checkpoint 1).
    static func undone(_ path: [Int]) -> [Int] {
        path.count > 1 ? withoutLast(path) : path
    }

    /// The step chooser and the arrow keys send the confirmed path plus one cell.
    static func stepped(_ path: [Int], to cell: Int) -> [Int] {
        appending(path, cell)
    }

    /// A finger lift or Return sends the draft only when it differs from the confirmed path.
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

    /// How many leading cells two paths share: the board draws that much of the display path solid and the rest dashed
    /// (the pending extension, S60 12 c).
    static func sharedPrefixCount(_ a: [Int], _ b: [Int]) -> Int {
        var count = 0
        while count < a.count && count < b.count && a[count] == b[count] {
            count += 1
        }
        return count
    }

    /// What the board draws: the draft while a finger or key run is active, the sent path while its move is pending,
    /// otherwise the confirmed path.
    static func displayPath(confirmed: [Int], draft: [Int], isDrafting: Bool, sent: [Int]) -> [Int] {
        if isDrafting { return draft }
        if !sent.isEmpty { return sent }
        return confirmed
    }

    /// The display path's cell count for the progress line while drafting (S60 12 b "18 of 36 cells").
    static func progressCount(confirmed: [Int], display: [Int]) -> Int {
        display.isEmpty ? confirmed.count : display.count
    }

    // MARK: Cells (built once per push)

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

    /// The cells the step chooser lists (the cells marked next).
    static func chooserCells(_ scene: ZipScene) -> [ZipCellModel] {
        var result: [ZipCellModel] = []
        for cell in scene.cells where cell.isNext {
            result.append(cell)
        }
        return result
    }

    // MARK: Small array helpers (explicit loops keep the transpiled code on plain arrays)

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

/// S60 12 time copy inputs: whole seconds for "Solved in %@" and the timer (both platforms format them).
enum ZipTimePolicy {
    static func wholeSeconds(_ millis: Double) -> Int {
        if millis <= 0 { return 0 }
        return Int(millis / 1000.0)
    }

    /// The round timer turns the warning color at 10 s or less and is announced at 60 s and 10 s (the Wordle timer rule).
    static let warningSeconds = 10
    static let announcedSeconds: [Int] = [60, 10]
}

/// S60 12 e, h: the outcome tokens this scene adds to the presenter's registry (`moveRejected` is published on the ack).
enum ZipOutcomePolicy {
    /// `gameCorrect` once, on the push where your own board turns solved in the same round.
    static func solved(previous: ZipScene?, next: ZipScene?) -> FeedbackKind {
        guard let before = previous, let after = next else { return FeedbackKind.none }
        if after.role != ZipRole.player || before.round != after.round { return FeedbackKind.none }
        if before.myOutcome != ZipOutcome.solved && after.myOutcome == ZipOutcome.solved { return FeedbackKind.gameCorrect }
        return FeedbackKind.none
    }
}

/// G/zip.ts moves (C6-17): `move {cells}` (the full path), `hint`, `reset`, `nextRound` (host). The payloads come from
/// `GameMoveAdapter` (`{"cells":[...]}`; the others carry none) and travel over the generic `game:move` path.
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
