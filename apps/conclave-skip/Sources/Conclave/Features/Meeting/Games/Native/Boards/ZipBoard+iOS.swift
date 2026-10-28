#if os(iOS) && !SKIP
import Accessibility
import Observation
import SwiftUI

// S60 12 B4 (ACT-6) on iOS: Zip inside the game shell's scroll view (GameShell+iOS.swift routes `GameSceneKind.zip` to
// `ZipSceneBody` and pins `ZipHostBar` in its bottom bar, HD request B8-T4 R6). The board is one `Canvas` of N x N flat
// cells in the two board tokens, the confirmed path as a 6 pt coral line through cell centers and a pending extension as
// the same line dashed. A finger (`DragGesture(minimumDistance: 0)`) extends a view-local draft through adjacent cells
// only, moving back onto the previous cell trims one step, a tap on an adjacent cell extends too, and the finger lift
// sends the full path once (`move {cells}`). Arrow keys step the same draft and Return sends it. The step chooser
// (shown under VoiceOver and on demand) lists the eligible next cells as 44 pt buttons; the canvas carries one synthetic
// accessibility child per cell laid out in the board geometry. The board never mirrors (D18). The timer and the hint
// cooldown are their own leaves; a drag publishes nothing to the presenter (S60 12 k).

// MARK: Scene

/// The Zip body for every phase after the lobby: playing (player or watching) and a round's or the game's results.
struct ZipSceneBody: View {
    let games: GameStagePresenter

    var body: some View {
        if let zip = games.scene.zip {
            ZipSceneView(scene: zip, games: games, isFinished: games.chrome.phase == .results)
        }
    }
}

struct ZipSceneView: View {
    let scene: ZipScene
    let games: GameStagePresenter
    let isFinished: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            ZipHeader(scene: scene, games: games, isFinished: isFinished)
            switch scene.phase {
            case .lobby:
                EmptyView()
            case .playing:
                ZipPlayingView(scene: scene, games: games)
            case .results:
                ZipResultsView(scene: scene, games: games, isFinished: isFinished)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityIdentifier("game.scene.zip")
    }
}

/// "Draw One Path, Fill Every Cell", "Round 1 of 3 · 18 of 34 cells" and the timer (S60 12 b, g). The card header already
/// carries the game's identity, so this states the task quietly (no accent bar, AGENTS.md game rules).
struct ZipHeader: View {
    let scene: ZipScene
    let games: GameStagePresenter
    let isFinished: Bool

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            VStack(alignment: .leading, spacing: 4) {
                Text(ZipCopy.title(scene, isFinished: isFinished))
                    .font(.headline)
                    .foregroundStyle(HostingTheme.token(DesignTokens.iosInCallText))
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityAddTraits(.isHeader)
                let meta = ZipCopy.meta(scene)
                if scene.phase == .playing && !meta.isEmpty {
                    Text(meta)
                        .font(.footnote)
                        .monospacedDigit()
                        .foregroundStyle(HostingTheme.inCallTextSecondary)
                        .accessibilityIdentifier("game.zip.progress")
                }
            }
            Spacer(minLength: 8)
            if scene.phase == .playing {
                ZipTimerSlot(games: games)
            }
        }
    }
}

// MARK: Timer

/// Observes only `countdown`, so the per-second leaf never re-evaluates the scene.
struct ZipTimerSlot: View {
    let games: GameStagePresenter

    var body: some View {
        if let countdown = games.countdown {
            ZipTimerChip(model: countdown)
        }
    }
}

/// "Remaining 2:41" with tabular digits, once per second only while the scene is active (stopped in the background,
/// recomputed on resume), from the server deadline plus the push's clock offset. At 10 s or less it turns the warning
/// color; VoiceOver reads "Remaining 2 minutes, 41 seconds" and hears it at 60 s and 10 s only.
struct ZipTimerChip: View {
    let model: CountdownModel
    @Environment(\.scenePhase) private var scenePhase

    var body: some View {
        if scenePhase == .active {
            TimelineView(.periodic(from: .now, by: 1)) { context in
                ZipTimerFace(model: model, nowMillis: context.date.timeIntervalSince1970 * 1000)
            }
        } else {
            ZipTimerFace(model: model, nowMillis: Date().timeIntervalSince1970 * 1000)
        }
    }
}

private struct ZipTimerFace: View {
    let model: CountdownModel
    let nowMillis: Double

    var body: some View {
        let seconds = model.secondsLeft(nowMillis: nowMillis)
        let warning = seconds <= ZipTimePolicy.warningSeconds
        let ink = warning ? HostingTheme.token(DesignTokens.iosInCallWarning) : HostingTheme.token(DesignTokens.iosInCallText)
        Text(ZipCopy.remaining(ZipCopy.clock(seconds)))
            .font(.subheadline.weight(.semibold))
            .monospacedDigit()
            .foregroundStyle(ink)
            .padding(.horizontal, 8)
            .padding(.vertical, 2)
            .overlay { Capsule().strokeBorder(HostingTheme.inCallBorder, lineWidth: 1) }
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(ZipCopy.remaining(ZipCopy.spokenDuration(seconds)))
            .accessibilityIdentifier("game.zip.timer")
            .onChange(of: seconds) { _, value in
                if ZipTimePolicy.announcedSeconds.contains(value) {
                    AccessibilityNotification.Announcement(ZipCopy.remaining(ZipCopy.spokenDuration(value))).post()
                }
            }
    }
}

// MARK: Phases

/// Playing (S60 12 c, f): your board, the rejected line, your outcome, the controls and the step chooser for a player; a
/// person watching sees the puzzle and the public standings only. The draft lives in `ZipBoardInteraction`, owned here,
/// so the board, the controls and the chooser share it while only the canvas observes the per-cell draft.
struct ZipPlayingView: View {
    let scene: ZipScene
    let games: GameStagePresenter
    @Environment(\.accessibilityVoiceOverEnabled) private var voiceOver
    @State private var interaction = ZipBoardInteraction()
    /// nil follows VoiceOver (the chooser shows while it runs); "Choose Next Cell" sets it for this round.
    @State private var prefersChooser: Bool? = nil

    var body: some View {
        let showsChooser = prefersChooser ?? voiceOver
        VStack(alignment: .leading, spacing: 12) {
            switch scene.role {
            case .spectator:
                PromptSpectatorNotice(games: games)
                ZipBoardSurface(scene: scene, games: games, interaction: nil, readOnlyPath: [])
                ZipStandingsList(scene: scene)
            case .player:
                ZipBoardSurface(scene: scene, games: games, interaction: interaction, readOnlyPath: [])
                ZipRejectedLine(games: games)
                ZipOutcomeLine(scene: scene, games: games)
                if scene.myOutcome == .none {
                    ZipControls(scene: scene, games: games, interaction: interaction, chooserShown: showsChooser,
                                onToggleChooser: { prefersChooser = !showsChooser })
                    if showsChooser {
                        ZipStepChooser(scene: scene, games: games, interaction: interaction)
                    }
                }
                ZipStandingsList(scene: scene)
            }
        }
    }
}

/// Results (S60 12 f): who solved it first, your outcome, the solution drawn on the board, the scoreboard at the final
/// results of a multi-round game and the standings ("Solved in 0:12 · No hints"); participants wait for the host. Next
/// Round and Play Again are the pinned bars.
struct ZipResultsView: View {
    let scene: ZipScene
    let games: GameStagePresenter
    let isFinished: Bool

    var body: some View {
        let isFinal = isFinished || scene.isFinalRound
        let shown = scene.solutionPath.isEmpty ? scene.confirmedPath : scene.solutionPath
        VStack(alignment: .leading, spacing: 12) {
            PromptHeadline(text: ZipCopy.winner(scene))
                .accessibilityIdentifier("game.zip.winner")
            ZipOutcomeLine(scene: scene, games: games)
            ZipBoardSurface(scene: scene, games: games, interaction: nil, readOnlyPath: shown)
            if isFinished && scene.roundTotal > 1 && !games.results.scoreboard.isEmpty {
                GameKitScoreboard(rows: games.results.scoreboard)
            }
            ZipStandingsList(scene: scene)
            if !games.chrome.isHost {
                PromptLine(text: isFinal ? ZipCopy.waitingForHost() : ZipCopy.waitingNextRound())
            }
        }
        .modifier(PromptAnnouncement(games: games, key: scene.resultKey, text: ZipCopy.winner(scene)))
        .accessibilityIdentifier("game.zip.results")
    }
}

/// "Solved in 0:15" or "Time’s up", announced once (S60 12 f, i).
struct ZipOutcomeLine: View {
    let scene: ZipScene
    let games: GameStagePresenter

    var body: some View {
        if let text = ZipCopy.outcome(scene) {
            PromptHeadline(text: text)
                .accessibilityLabel(ZipCopy.outcome(scene, spoken: true) ?? text)
                .accessibilityIdentifier("game.zip.outcome")
                .modifier(PromptAnnouncement(games: games, key: scene.outcomeKey, text: ZipCopy.outcome(scene, spoken: true) ?? text))
        }
    }
}

/// S60 12 f: the server refused a path ("That path isn’t allowed. Try again."); the confirmed path is already back on the
/// board and the shell's notice carries the server's own reason. Time and phase refusals are not path rules.
struct ZipRejectedLine: View {
    let games: GameStagePresenter

    var body: some View {
        let state = games.interaction
        if !state.isPending && state.failure == .server && ZipPathPolicy.isPathRejection(state.failureServerText) {
            PromptLine(text: ZipCopy.rejected())
                .accessibilityIdentifier("game.zip.rejected")
        }
    }
}

/// The pinned host bar (S60 12 f): Next Round for a seated host at a round's results, pending until that emit's ack.
struct ZipHostBar: View {
    let games: GameStagePresenter

    var body: some View {
        if let zip = games.scene.zip, zip.canAdvanceRound {
            let interaction = games.interaction
            let pending = interaction.isPending && interaction.pendingType == ZipIntent.nextRoundType
            GameKitHostBar(primaryTitle: ZipCopy.nextRound(), primaryEnabled: !interaction.isPending || pending,
                           primaryPending: pending, onPrimary: { _ = games.send(ZipIntent.nextRound()) })
                .accessibilityIdentifier("game.host.nextRound")
        }
    }
}

// MARK: Draft (view-local)

/// The board's view-local state (S60 12 j, k): the draft while a finger or an arrow-key run is active, and the path a move
/// just sent, drawn dashed beyond the confirmed path until its ack or the push. Only the canvas reads the draft, so a
/// drag re-evaluates nothing else; every intent goes through `GameStagePresenter.send`, one send per finger lift, key
/// run, step, Undo, Reset or Hint.
@MainActor
@Observable
final class ZipBoardInteraction {
    private(set) var draft: [Int] = []
    private(set) var isDrafting = false
    private(set) var sent: [Int] = []
    /// Bumped once per cell added by a drag, key or step (`selectionChanged`, rate-limited to cell changes).
    private(set) var addedCells = 0
    @ObservationIgnored private var keyRun = false
    @ObservationIgnored private var touchActive = false
    @ObservationIgnored private var lastCell = -1

    /// The path the canvas draws; `showsSent` is true while a sent move or reset waits for its ack.
    func display(confirmed: [Int], showsSent: Bool) -> [Int] {
        ZipPathPolicy.displayPath(confirmed: confirmed, draft: draft, isDrafting: isDrafting, sent: showsSent ? sent : [])
    }

    /// A finger at `cell` (-1 off the board). The first event decides whether this touch draws (it starts on your path or
    /// on a cell the path may take next); later events walk every crossed cell.
    func touch(at cell: Int, scene: ZipScene) {
        if !touchActive {
            touchActive = true
            let base = keyRun ? draft : scene.confirmedPath
            if !ZipPathPolicy.startsDrawing(base, at: cell, scene: scene) { return }
            let next = ZipPathPolicy.touchDown(base, at: cell, scene: scene)
            countAdded(from: base, to: next)
            draft = next
            isDrafting = true
            lastCell = cell
            return
        }
        if !isDrafting || cell < 0 || cell == lastCell { return }
        let next = ZipPathPolicy.dragged(draft, from: lastCell, to: cell, scene: scene)
        countAdded(from: draft, to: next)
        if !ZipPathPolicy.samePath(next, draft) { draft = next }
        lastCell = cell
    }

    /// The finger lifted: the full path is sent once when it changed.
    func lift(scene: ZipScene, games: GameStagePresenter) {
        let drew = isDrafting
        touchActive = false
        lastCell = -1
        if !drew { return }
        commit(scene: scene, games: games)
    }

    /// An arrow key: one step from the end of the draft (back onto the previous cell trims one).
    func key(_ direction: ZipDirection, scene: ZipScene) {
        if !scene.canMove { return }
        let base = keyRun ? draft : scene.confirmedPath
        let next = ZipPathPolicy.keyStep(base, direction: direction, scene: scene)
        if ZipPathPolicy.samePath(next, base) { return }
        countAdded(from: base, to: next)
        if ZipPathPolicy.samePath(next, scene.confirmedPath) {
            discardDraft()
            return
        }
        draft = next
        keyRun = true
        isDrafting = true
    }

    /// Return: the key run's path is sent once.
    func commitKeys(scene: ZipScene, games: GameStagePresenter) {
        if !keyRun || touchActive { return }
        commit(scene: scene, games: games)
    }

    /// A chooser button or a cell's accessibility action: the confirmed path plus that cell, sent at once.
    func step(to cell: Int, scene: ZipScene, games: GameStagePresenter) {
        discardDraft()
        if !ZipPathPolicy.canExtend(scene.confirmedPath, to: cell, scene: scene) { return }
        let path = ZipPathPolicy.stepped(scene.confirmedPath, to: cell)
        if games.send(ZipIntent.move(path)) == ActivityTapResult.dispatched {
            sent = path
            addedCells += 1
        }
    }

    /// Undo: the confirmed path minus its last cell.
    func undo(scene: ZipScene, games: GameStagePresenter) {
        discardDraft()
        if !scene.canUndo { return }
        let path = ZipPathPolicy.undone(scene.confirmedPath)
        if games.send(ZipIntent.move(path)) == ActivityTapResult.dispatched { sent = path }
    }

    /// Reset: back to checkpoint 1 (`reset`).
    func reset(scene: ZipScene, games: GameStagePresenter) {
        discardDraft()
        if !scene.canReset { return }
        if games.send(ZipIntent.reset()) == ActivityTapResult.dispatched && scene.startCell >= 0 { sent = [scene.startCell] }
    }

    /// Hint (`hint`): the server extends the path along the solution and starts the 3 s cooldown.
    func hint(scene: ZipScene, games: GameStagePresenter) {
        discardDraft()
        if !scene.canHint { return }
        _ = games.send(ZipIntent.hint())
    }

    /// The board went read-only (reconnecting, time up, results) or the round changed.
    func discardDraft() {
        draft = []
        isDrafting = false
        keyRun = false
        touchActive = false
        lastCell = -1
    }

    private func commit(scene: ZipScene, games: GameStagePresenter) {
        let path = draft
        discardDraft()
        if !ZipPathPolicy.shouldSend(draft: path, confirmed: scene.confirmedPath) { return }
        if games.send(ZipIntent.move(path)) == ActivityTapResult.dispatched { sent = path }
    }

    private func countAdded(from before: [Int], to after: [Int]) {
        if after.count > before.count { addedCells += 1 }
    }
}

// MARK: Board (B4)

/// A square board as wide as the card allows, capped at 360 pt (9 x 9 on a 343 pt card is 38 pt cells). `interaction` is
/// nil for a read-only board (watching, results), which draws `readOnlyPath`.
struct ZipBoardSurface: View {
    let scene: ZipScene
    let games: GameStagePresenter
    let interaction: ZipBoardInteraction?
    let readOnlyPath: [Int]

    var body: some View {
        Color.clear
            .aspectRatio(1, contentMode: .fit)
            .frame(maxWidth: CGFloat(ZipPathPolicy.maxBoardSide))
            .overlay {
                GeometryReader { proxy in
                    ZipBoardLayer(scene: scene, games: games, interaction: interaction, readOnlyPath: readOnlyPath,
                                  side: Double(min(proxy.size.width, proxy.size.height)))
                }
            }
            .frame(maxWidth: .infinity)
            .environment(\.layoutDirection, .leftToRight)
            .accessibilityIdentifier("game.zip.board")
    }
}

/// The canvas, its gestures and keys, and the synthetic accessibility children. Reads the draft (through `interaction`)
/// and `interaction` of the presenter (pending and failures) only.
struct ZipBoardLayer: View {
    let scene: ZipScene
    let games: GameStagePresenter
    let interaction: ZipBoardInteraction?
    let readOnlyPath: [Int]
    let side: Double
    @FocusState private var focused: Bool

    var body: some View {
        let state = games.interaction
        let interactive = interaction != nil && scene.canMove
        let canDraw = interactive && !state.isPending
        let showsSent = state.isPending && (state.pendingType == ZipIntent.moveType || state.pendingType == ZipIntent.resetType)
        let path = interaction?.display(confirmed: scene.confirmedPath, showsSent: showsSent) ?? readOnlyPath
        let solid = interaction == nil ? path.count : ZipPathPolicy.sharedPrefixCount(path, scene.confirmedPath)
        let cellSide = ZipPathPolicy.cellSide(boardSide: side, size: scene.size)
        ZipCanvas(scene: scene, path: path, solidCount: solid, side: side)
            .frame(width: CGFloat(side), height: CGFloat(side))
            .contentShape(Rectangle())
            .gesture(drag, including: canDraw ? .all : .none)
            .accessibilityLabel(ZipCopy.boardLabel())
            .accessibilityChildren {
                ZipAccessibilityGrid(scene: scene, cellSide: CGFloat(cellSide), interactive: interactive, canStep: canDraw,
                                     onStep: { cell in interaction?.step(to: cell, scene: scene, games: games) })
            }
            .focusable(interactive)
            .focusEffectDisabled()
            .focused($focused)
            .onKeyPress(keys: [.upArrow, .downArrow, .leftArrow, .rightArrow], phases: .down) { press in
                guard let interaction = interaction, canDraw else { return .ignored }
                interaction.key(ZipCopy.direction(press.key), scene: scene)
                return .handled
            }
            .onKeyPress(.return) {
                guard let interaction = interaction, canDraw else { return .ignored }
                interaction.commitKeys(scene: scene, games: games)
                return .handled
            }
            .onAppear {
                focused = interactive
            }
            .onChange(of: scene.canMove) { _, canMove in
                if !canMove { interaction?.discardDraft() }
            }
            .conclaveGestureFeedback(.selectionChanged, trigger: interaction?.addedCells ?? 0)
    }

    private var drag: some Gesture {
        DragGesture(minimumDistance: 0, coordinateSpace: .local)
            .onChanged { value in
                let cell = ZipPathPolicy.cellAt(x: Double(value.location.x), y: Double(value.location.y), boardSide: side,
                                                size: scene.size)
                interaction?.touch(at: cell, scene: scene)
            }
            .onEnded { _ in
                interaction?.lift(scene: scene, games: games)
            }
    }
}

/// One canvas (S60 12 c, e): unvisited cells `iosGameBoardLight`, visited and draft cells `iosGameBoardDark`, removed
/// cells outlined and crossed, barriers as 4 pt paper lines, the path as a 6 pt coral line (solid where confirmed, dashed
/// 6 on 6 beyond it) with a coral dot at its end, and checkpoint discs with paper numbers capped for the board.
struct ZipCanvas: View {
    let scene: ZipScene
    let path: [Int]
    let solidCount: Int
    let side: Double

    var body: some View {
        let light = HostingTheme.token(DesignTokens.iosGameBoardLight)
        let dark = HostingTheme.token(DesignTokens.iosGameBoardDark)
        let paper = HostingTheme.token(DesignTokens.iosInCallText)
        let coral = HostingTheme.coralFill
        let seam = HostingTheme.inCallBorderStrong
        let cellSide = ZipPathPolicy.cellSide(boardSide: side, size: scene.size)
        let numberFont = cellSide >= ZipPathPolicy.compactCellSide ? Font.headline.monospacedDigit()
            : Font.subheadline.weight(.semibold).monospacedDigit()
        Canvas { context, _ in
            let size = scene.size
            let count = size * size
            let inset = ZipPathPolicy.cellInset
            var visited = Array(repeating: false, count: count)
            for cell in path where cell >= 0 && cell < count {
                visited[cell] = true
            }
            for model in scene.cells {
                let rect = CGRect(x: Double(model.column) * cellSide + inset, y: Double(model.row) * cellSide + inset,
                                  width: cellSide - 2 * inset, height: cellSide - 2 * inset)
                let shape = Path(roundedRect: rect, cornerRadius: CGFloat(ZipPathPolicy.cellCorner), style: .continuous)
                if model.isDead {
                    context.stroke(shape, with: .color(seam), lineWidth: 1)
                    var cross = Path()
                    cross.move(to: CGPoint(x: rect.minX + rect.width * 0.25, y: rect.minY + rect.height * 0.25))
                    cross.addLine(to: CGPoint(x: rect.maxX - rect.width * 0.25, y: rect.maxY - rect.height * 0.25))
                    context.stroke(cross, with: .color(seam), lineWidth: 1)
                } else {
                    context.fill(shape, with: .color(model.index < visited.count && visited[model.index] ? dark : light))
                }
            }
            for wall in scene.walls {
                context.stroke(ZipCanvasGeometry.wall(wall, cellSide: cellSide, size: size), with: .color(paper),
                               style: StrokeStyle(lineWidth: CGFloat(ZipPathPolicy.wallWidth), lineCap: .round))
            }
            let solid = min(max(0, solidCount), path.count)
            if solid >= 2 {
                context.stroke(ZipCanvasGeometry.line(path, from: 0, to: solid, cellSide: cellSide, size: size), with: .color(coral),
                               style: StrokeStyle(lineWidth: CGFloat(ZipPathPolicy.pathWidth), lineCap: .round, lineJoin: .round))
            }
            if path.count >= 2 && path.count > solid {
                let dash = CGFloat(ZipPathPolicy.dashLength)
                context.stroke(ZipCanvasGeometry.line(path, from: max(0, solid - 1), to: path.count, cellSide: cellSide, size: size),
                               with: .color(coral),
                               style: StrokeStyle(lineWidth: CGFloat(ZipPathPolicy.pathWidth), lineCap: .butt, lineJoin: .round,
                                                  dash: [dash, dash]))
            }
            if let head = path.last {
                let center = ZipCanvasGeometry.center(head, cellSide: cellSide, size: size)
                let radius = ZipPathPolicy.headDiameter / 2
                context.fill(Path(ellipseIn: CGRect(x: center.x - radius, y: center.y - radius, width: radius * 2, height: radius * 2)),
                             with: .color(coral))
            }
            for checkpoint in scene.checkpoints where checkpoint.cell < count {
                let center = ZipCanvasGeometry.center(checkpoint.cell, cellSide: cellSide, size: size)
                let radius = cellSide * ZipPathPolicy.checkpointRadiusFactor
                let disc = Path(ellipseIn: CGRect(x: center.x - radius, y: center.y - radius, width: radius * 2, height: radius * 2))
                context.fill(disc, with: .color(visited[checkpoint.cell] ? dark : light))
                context.stroke(disc, with: .color(paper), lineWidth: 1.5)
                context.draw(Text(checkpoint.number, format: .number).font(numberFont).foregroundStyle(paper), at: center,
                             anchor: .center)
            }
        }
        .dynamicTypeSize(...DynamicTypeSize.xxLarge)
    }
}

/// Canvas paths in board coordinates (centers from `ZipPathPolicy`).
enum ZipCanvasGeometry {
    static func center(_ cell: Int, cellSide: Double, size: Int) -> CGPoint {
        CGPoint(x: (Double(ZipPathPolicy.column(cell, size: size)) + 0.5) * cellSide,
                y: (Double(ZipPathPolicy.row(cell, size: size)) + 0.5) * cellSide)
    }

    /// The cells `from ..< to` of `path` joined through their centers.
    static func line(_ path: [Int], from: Int, to: Int, cellSide: Double, size: Int) -> Path {
        var line = Path()
        var index = from
        while index < to && index < path.count {
            let point = center(path[index], cellSide: cellSide, size: size)
            if index == from { line.move(to: point) } else { line.addLine(to: point) }
            index += 1
        }
        return line
    }

    /// A barrier on the edge two cells share, 4 pt short of each corner.
    static func wall(_ wall: ZipWallModel, cellSide: Double, size: Int) -> Path {
        var line = Path()
        let margin = 4.0
        if wall.isBetweenColumns {
            let x = Double(ZipPathPolicy.column(wall.to, size: size)) * cellSide
            let top = Double(ZipPathPolicy.row(wall.from, size: size)) * cellSide
            line.move(to: CGPoint(x: x, y: top + margin))
            line.addLine(to: CGPoint(x: x, y: top + cellSide - margin))
        } else {
            let y = Double(ZipPathPolicy.row(wall.to, size: size)) * cellSide
            let left = Double(ZipPathPolicy.column(wall.from, size: size)) * cellSide
            line.move(to: CGPoint(x: left + margin, y: y))
            line.addLine(to: CGPoint(x: left + cellSide - margin, y: y))
        }
        return line
    }
}

/// One synthetic accessibility child per cell, laid out in the board geometry (a `Grid` of fixed-size rectangles, as
/// S60 11 c), so touch exploration and the dump find each cell at its drawn frame: "Row 2, column 4, checkpoint 2, next".
/// A cell the path may take next is a button whose action takes that step. A read-only board reads positions,
/// checkpoints and removed cells only.
struct ZipAccessibilityGrid: View {
    let scene: ZipScene
    let cellSide: CGFloat
    let interactive: Bool
    let canStep: Bool
    let onStep: (Int) -> Void

    var body: some View {
        Grid(horizontalSpacing: 0, verticalSpacing: 0) {
            ForEach(0..<scene.size, id: \.self) { row in
                GridRow {
                    ForEach(0..<scene.size, id: \.self) { column in
                        let index = row * scene.size + column
                        if index < scene.cells.count {
                            let cell = scene.cells[index]
                            let steps = interactive && canStep && cell.isNext
                            Rectangle()
                                .frame(width: cellSide, height: cellSide)
                                .accessibilityElement()
                                .accessibilityLabel(ZipCopy.cellLabel(cell, showsProgress: interactive))
                                .accessibilityAddTraits(steps ? .isButton : [])
                                .modifier(ZipCellStepAction(enabled: steps, action: { onStep(cell.index) }))
                                .accessibilityIdentifier("game.zip.cell." + String(cell.index))
                        }
                    }
                }
            }
        }
    }
}

/// The step action only on a cell the path may take next.
struct ZipCellStepAction: ViewModifier {
    let enabled: Bool
    let action: () -> Void

    func body(content: Content) -> some View {
        if enabled {
            content.accessibilityAction(.default) { action() }
        } else {
            content
        }
    }
}

// MARK: Controls and the step chooser

/// Undo, Reset, Hint ("Hint (3 s)" while cooling down, with its projected cost) and Choose Next Cell, then "2 hints used"
/// (S60 12 c). 44 pt targets; the row wraps at large text sizes.
struct ZipControls: View {
    let scene: ZipScene
    let games: GameStagePresenter
    let interaction: ZipBoardInteraction
    let chooserShown: Bool
    let onToggleChooser: () -> Void

    var body: some View {
        let state = games.interaction
        let busy = state.isPending || scene.isReconnecting
        VStack(alignment: .leading, spacing: 8) {
            ConclaveFlowLayout(spacing: 8) {
                ZipControlButton(title: ZipCopy.undo(), enabled: scene.canUndo && !busy, identifier: "game.zip.undo") {
                    interaction.undo(scene: scene, games: games)
                }
                ZipControlButton(title: ZipCopy.reset(), enabled: scene.canReset && !busy,
                                 pending: state.isPending && state.pendingType == ZipIntent.resetType, identifier: "game.zip.reset") {
                    interaction.reset(scene: scene, games: games)
                }
                ZipHintButton(scene: scene, games: games, interaction: interaction)
                ZipControlButton(title: ZipCopy.chooseNext(), selected: chooserShown, identifier: "game.zip.chooseNext",
                                 action: onToggleChooser)
            }
            if scene.hintsUsed > 0 {
                PromptLine(text: ZipCopy.hintsUsed(scene.hintsUsed))
                    .accessibilityIdentifier("game.zip.hintsUsed")
            }
        }
    }
}

/// Hint with its cooldown in the label: an explicit timeline with one date per remaining second, so the leaf stops
/// ticking when the cooldown ends.
struct ZipHintButton: View {
    let scene: ZipScene
    let games: GameStagePresenter
    let interaction: ZipBoardInteraction

    var body: some View {
        let now = Date().timeIntervalSince1970 * 1000
        let seconds = scene.hintCooldownSeconds(nowMillis: now)
        if seconds > 0 {
            TimelineView(.explicit(ZipCopy.cooldownDates(readyAtMillis: scene.hintReadyAtMillis, seconds: seconds))) { context in
                ZipHintFace(scene: scene, games: games, interaction: interaction, nowMillis: context.date.timeIntervalSince1970 * 1000)
            }
        } else {
            ZipHintFace(scene: scene, games: games, interaction: interaction, nowMillis: now)
        }
    }
}

private struct ZipHintFace: View {
    let scene: ZipScene
    let games: GameStagePresenter
    let interaction: ZipBoardInteraction
    let nowMillis: Double

    var body: some View {
        let state = games.interaction
        let seconds = scene.hintCooldownSeconds(nowMillis: nowMillis)
        let pending = state.isPending && state.pendingType == ZipIntent.hintType
        ZipControlButton(title: seconds > 0 ? ZipCopy.hintCooldown(seconds) : ZipCopy.hint(),
                         enabled: scene.canHint && seconds == 0 && !state.isPending && !scene.isReconnecting, pending: pending,
                         identifier: "game.zip.hint", hint: scene.hintCostPoints > 0 ? ZipCopy.hintCost(scene.hintCostPoints) : "") {
            interaction.hint(scene: scene, games: games)
        }
    }
}

/// A neutral bordered control (paper on the dark card, never coral), 44 pt tall, with an "In Progress" value while its
/// move waits for the ack.
struct ZipControlButton: View {
    let title: String
    var enabled: Bool = true
    var pending: Bool = false
    var selected: Bool = false
    let identifier: String
    var hint: String = ""
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 6) {
                if pending {
                    ProgressView()
                        .tint(HostingTheme.token(DesignTokens.iosInCallText))
                }
                Text(title)
                    .monospacedDigit()
            }
            .frame(minHeight: 44)
        }
        .buttonStyle(.bordered)
        .tint(HostingTheme.token(DesignTokens.iosInCallText))
        .disabled(!enabled || pending)
        .accessibilityValue(pending ? ConclaveStrings.text("In Progress") : "")
        .accessibilityHint(hint)
        .accessibilityAddTraits(selected ? .isSelected : [])
        .accessibilityIdentifier(identifier)
    }
}

/// The accessible step chooser (S60 12 c, i): the cells your path may take next as 44 pt buttons ("Row 3, column 3",
/// "Row 3, column 4, checkpoint 4"), so drawing is optional; Undo, Reset and Hint sit in the controls row right above.
struct ZipStepChooser: View {
    let scene: ZipScene
    let games: GameStagePresenter
    let interaction: ZipBoardInteraction

    var body: some View {
        let cells = ZipPathPolicy.chooserCells(scene)
        let busy = games.interaction.isPending || !scene.canMove
        VStack(alignment: .leading, spacing: 8) {
            Text(ZipCopy.chooseNext())
                .font(.footnote.weight(.semibold))
                .foregroundStyle(HostingTheme.inCallTextSecondary)
                .accessibilityAddTraits(.isHeader)
            if cells.isEmpty {
                PromptLine(text: ZipCopy.noNextCell())
                    .accessibilityIdentifier("game.zip.noNext")
            } else {
                ConclaveFlowLayout(spacing: 8) {
                    ForEach(cells) { cell in
                        Button {
                            interaction.step(to: cell.index, scene: scene, games: games)
                        } label: {
                            Text(ZipCopy.cellName(cell))
                                .frame(minWidth: 44, minHeight: 44)
                        }
                        .buttonStyle(.bordered)
                        .tint(HostingTheme.token(DesignTokens.iosInCallText))
                        .disabled(busy)
                        .accessibilityIdentifier("game.zip.step." + String(cell.index))
                    }
                }
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("game.zip.chooser")
    }
}

/// Everyone's progress (S60 12 f, g), keyed by player id: "12 of 34 cells", "Solved in 0:12 · No hints", "Time’s up".
struct ZipStandingsList: View {
    let scene: ZipScene

    var body: some View {
        if !scene.standings.isEmpty {
            VStack(alignment: .leading, spacing: 4) {
                Text(ZipCopy.standings())
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(HostingTheme.inCallTextSecondary)
                    .accessibilityAddTraits(.isHeader)
                ForEach(scene.standings) { row in
                    HStack(spacing: 10) {
                        Text(row.isYou ? ConclaveStrings.text("You") : row.name)
                            .font(.body)
                            .lineLimit(2)
                        Spacer(minLength: 8)
                        Text(ZipCopy.status(row, spoken: false))
                            .font(.subheadline)
                            .monospacedDigit()
                            .multilineTextAlignment(.trailing)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    .foregroundStyle(HostingTheme.token(DesignTokens.iosInCallText))
                    .padding(.horizontal, 10)
                    .padding(.vertical, 6)
                    .background(row.isYou ? HostingTheme.token(DesignTokens.iosInCallSurfaceRaised) : Color.clear,
                                in: RoundedRectangle(cornerRadius: CGFloat(DesignTokens.radiusSmall), style: .continuous))
                    .accessibilityElement(children: .ignore)
                    .accessibilityLabel(ZipCopy.twoFacts(row.isYou ? ConclaveStrings.text("You") : row.name, ZipCopy.status(row, spoken: true)))
                    .accessibilityIdentifier("game.zip.standing." + row.id)
                }
            }
        }
    }
}

// MARK: Copy

/// S60 12 g, exhaustive iOS copy (L6-14): Apple title case for controls and headings, sentence case for lines.
enum ZipCopy {
    static func title(_ scene: ZipScene, isFinished: Bool) -> String {
        switch scene.phase {
        case .lobby, .playing:
            return ConclaveStrings.text("Draw One Path, Fill Every Cell")
        case .results:
            return isFinished || scene.isFinalRound ? ConclaveStrings.text("Final Results")
                : ConclaveStrings.format("Round %lld Results", scene.round)
        }
    }

    /// "Round 1 of 3 · 12 of 34 cells" for a player, the round alone for a person watching.
    static func meta(_ scene: ZipScene) -> String {
        let round = scene.roundTotal > 1 && scene.round > 0 ? ConclaveStrings.format("Round %lld of %lld", scene.round, scene.roundTotal) : ""
        if scene.role == .spectator { return round }
        let cells = ConclaveStrings.format("%lld of %lld cells", scene.visitedCount, scene.totalCells)
        return round.isEmpty ? cells : twoFacts(round, cells)
    }

    static func remaining(_ value: String) -> String { ConclaveStrings.format("Remaining %@", value) }
    static func undo() -> String { ConclaveStrings.text("Undo") }
    static func reset() -> String { ConclaveStrings.text("Reset") }
    static func hint() -> String { ConclaveStrings.text("Hint") }
    static func hintCooldown(_ seconds: Int) -> String { ConclaveStrings.format("Hint (%lld s)", seconds) }
    /// "1 hint used", "2 hints used" (a plural catalog entry).
    static func hintsUsed(_ count: Int) -> String { ConclaveStrings.format("%lld hints used", count) }
    /// "Costs 15 points" (a plural catalog entry), the Hint button's accessibility hint.
    static func hintCost(_ points: Int) -> String { ConclaveStrings.format("Costs %lld points", points) }
    static func chooseNext() -> String { ConclaveStrings.text("Choose Next Cell") }
    static func noNextCell() -> String { ConclaveStrings.text("No cell can come next. Undo or reset.") }
    static func nextRound() -> String { ConclaveStrings.text("Next Round") }
    static func standings() -> String { ConclaveStrings.text("Standings") }
    static func rejected() -> String { ConclaveStrings.text("That path isn’t allowed. Try again.") }
    static func waitingNextRound() -> String { ConclaveStrings.text("Waiting for the host to start the next round") }
    static func waitingForHost() -> String { ConclaveStrings.text("Waiting for the host") }
    static func boardLabel() -> String { ConclaveStrings.text("Draw One Path, Fill Every Cell") }
    static func twoFacts(_ first: String, _ second: String) -> String { ConclaveStrings.format("Two Facts %@ %@", first, second) }

    static func solvedIn(_ millis: Double, spoken: Bool) -> String {
        let seconds = ZipTimePolicy.wholeSeconds(millis)
        return ConclaveStrings.format("Zip Solved In %@", spoken ? spokenDuration(seconds) : clock(seconds))
    }

    static func timeUp() -> String { ConclaveStrings.text("Zip Time Up") }

    /// Your outcome line; nil while your board is open.
    static func outcome(_ scene: ZipScene, spoken: Bool = false) -> String? {
        switch scene.myOutcome {
        case .none: return nil
        case .solved: return solvedIn(scene.solvedMillis, spoken: spoken)
        case .timedOut: return timeUp()
        }
    }

    static func winner(_ scene: ZipScene) -> String {
        scene.winnerName.isEmpty ? ConclaveStrings.text("Nobody solved it") : ConclaveStrings.format("%@ solved it first", scene.winnerName)
    }

    static func hintsLine(_ count: Int) -> String {
        count > 0 ? hintsUsed(count) : ConclaveStrings.text("No hints")
    }

    static func status(_ row: ZipStandingModel, spoken: Bool) -> String {
        switch row.status {
        case .solved: return twoFacts(solvedIn(row.solvedMillis, spoken: spoken), hintsLine(row.hintsUsed))
        case .timedOut: return timeUp()
        case .playing: return ConclaveStrings.format("%lld of %lld cells", row.cellsFilled, row.totalCells)
        }
    }

    /// "Row 3, column 4, checkpoint 4" (the chooser's button title).
    static func cellName(_ cell: ZipCellModel) -> String {
        var text = ConclaveStrings.format("Row %lld, column %lld", cell.row + 1, cell.column + 1)
        if cell.checkpoint > 0 { text += ConclaveStrings.format(", checkpoint %lld", cell.checkpoint) }
        return text
    }

    /// "Row 2, column 4, checkpoint 2, visited", ", end of path", ", next", ", not part of the puzzle" (S60 12 g).
    static func cellLabel(_ cell: ZipCellModel, showsProgress: Bool) -> String {
        var text = cellName(cell)
        if cell.isDead { return text + ConclaveStrings.text(", not part of the puzzle") }
        if showsProgress && cell.isVisited { text += ConclaveStrings.text(", visited") }
        if showsProgress && cell.isHead { text += ConclaveStrings.text(", end of path") }
        if showsProgress && cell.isNext { text += ConclaveStrings.text(", next") }
        return text
    }

    static func direction(_ key: KeyEquivalent) -> ZipDirection {
        if key == .upArrow { return .up }
        if key == .downArrow { return .down }
        if key == .leftArrow { return .left }
        return .right
    }

    /// "2:41" in the current locale's digits.
    static func clock(_ seconds: Int) -> String {
        Duration.seconds(max(0, seconds)).formatted(.time(pattern: .minuteSecond))
    }

    /// "2 minutes, 41 seconds" for VoiceOver.
    static func spokenDuration(_ seconds: Int) -> String {
        Duration.seconds(max(0, seconds)).formatted(.units(allowed: [.minutes, .seconds], width: .wide))
    }

    /// One date per whole second until Hint is ready, the last being the ready time (an explicit, finite timeline).
    static func cooldownDates(readyAtMillis: Double, seconds: Int) -> [Date] {
        var dates: [Date] = []
        var left = seconds
        while left >= 0 {
            dates.append(Date(timeIntervalSince1970: (readyAtMillis - Double(left) * 1000) / 1000))
            left -= 1
        }
        return dates
    }
}
#endif
