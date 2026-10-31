#if os(iOS) && !SKIP
import Accessibility
import Observation
import SwiftUI

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

struct ZipTimerSlot: View {
    let games: GameStagePresenter

    var body: some View {
        if let countdown = games.countdown {
            ZipTimerChip(model: countdown)
        }
    }
}

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

struct ZipPlayingView: View {
    let scene: ZipScene
    let games: GameStagePresenter
    @Environment(\.accessibilityVoiceOverEnabled) private var voiceOver
    @State private var interaction = ZipBoardInteraction()

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

@MainActor
@Observable
final class ZipBoardInteraction {
    private(set) var draft: [Int] = []
    private(set) var isDrafting = false
    private(set) var sent: [Int] = []

    private(set) var addedCells = 0
    @ObservationIgnored private var keyRun = false
    @ObservationIgnored private var touchActive = false
    @ObservationIgnored private var lastCell = -1

    func display(confirmed: [Int], showsSent: Bool) -> [Int] {
        ZipPathPolicy.displayPath(confirmed: confirmed, draft: draft, isDrafting: isDrafting, sent: showsSent ? sent : [])
    }

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

    func lift(scene: ZipScene, games: GameStagePresenter) {
        let drew = isDrafting
        touchActive = false
        lastCell = -1
        if !drew { return }
        commit(scene: scene, games: games)
    }

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

    func commitKeys(scene: ZipScene, games: GameStagePresenter) {
        if !keyRun || touchActive { return }
        commit(scene: scene, games: games)
    }

    func step(to cell: Int, scene: ZipScene, games: GameStagePresenter) {
        discardDraft()
        if !ZipPathPolicy.canExtend(scene.confirmedPath, to: cell, scene: scene) { return }
        let path = ZipPathPolicy.stepped(scene.confirmedPath, to: cell)
        if games.send(ZipIntent.move(path)) == ActivityTapResult.dispatched {
            sent = path
            addedCells += 1
        }
    }

    func undo(scene: ZipScene, games: GameStagePresenter) {
        discardDraft()
        if !scene.canUndo { return }
        let path = ZipPathPolicy.undone(scene.confirmedPath)
        if games.send(ZipIntent.move(path)) == ActivityTapResult.dispatched { sent = path }
    }

    func reset(scene: ZipScene, games: GameStagePresenter) {
        discardDraft()
        if !scene.canReset { return }
        if games.send(ZipIntent.reset()) == ActivityTapResult.dispatched && scene.startCell >= 0 { sent = [scene.startCell] }
    }

    func hint(scene: ZipScene, games: GameStagePresenter) {
        discardDraft()
        if !scene.canHint { return }
        _ = games.send(ZipIntent.hint())
    }

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

enum ZipCanvasGeometry {
    static func center(_ cell: Int, cellSide: Double, size: Int) -> CGPoint {
        CGPoint(x: (Double(ZipPathPolicy.column(cell, size: size)) + 0.5) * cellSide,
                y: (Double(ZipPathPolicy.row(cell, size: size)) + 0.5) * cellSide)
    }

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

    static func hintsUsed(_ count: Int) -> String { ConclaveStrings.format("%lld hints used", count) }

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

    static func cellName(_ cell: ZipCellModel) -> String {
        var text = ConclaveStrings.format("Row %lld, column %lld", cell.row + 1, cell.column + 1)
        if cell.checkpoint > 0 { text += ConclaveStrings.format(", checkpoint %lld", cell.checkpoint) }
        return text
    }

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

    static func clock(_ seconds: Int) -> String {
        Duration.seconds(max(0, seconds)).formatted(.time(pattern: .minuteSecond))
    }

    static func spokenDuration(_ seconds: Int) -> String {
        Duration.seconds(max(0, seconds)).formatted(.units(allowed: [.minutes, .seconds], width: .wide))
    }

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
