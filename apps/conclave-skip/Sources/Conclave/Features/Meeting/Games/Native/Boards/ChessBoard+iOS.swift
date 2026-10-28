#if os(iOS) && !SKIP
import SwiftUI

// S60 11 B3 (ACT-5) on iOS: chess inside the game shell's scroll view (GameShell+iOS.swift routes `GameSceneKind.chess`
// to `ChessSceneBody`, HD request B8-T3 R3). The board is one `Canvas` of 64 flat squares in the two board tokens, with
// `.caption2` coordinates, a 2 pt paper outline on the last move, a paper and ink double ring on the selected square,
// paper dots and rings on legal targets, a paper and red double ring on a king in check, and a dashed paper outline on a
// move waiting for its ack. A `SpatialTapGesture` maps a tap to its algebraic square; tap the piece, then the
// destination. The canvas carries one synthetic accessibility child per square, laid out in the board geometry, so
// touch exploration and the dump find "e4" at its drawn frame. The move chooser is the complete non-visual path
// (piece, destination, promotion). The board never mirrors (D18) and is read from one immutable scene per push; the
// move in flight is its own presenter property (`chessPendingMove`), read only by the board and the status lines.
// Pieces: bundled MIT-licensed Tabler vectors in both Debug and Release (S60 Q9), tinted paper or ink with a
// contrasting 1 pt outline. The original geometry and full license are preserved in artwork/chess-tabler.

// MARK: Scene

/// The chess body for playing and results (the shell draws the lobby).
struct ChessSceneBody: View {
    let games: GameStagePresenter

    var body: some View {
        if let chess = games.scene.chess {
            ChessSceneView(scene: chess, games: games, isFinished: games.chrome.phase == .results)
        }
    }
}

/// A board move waiting for the person's promotion choice.
struct ChessMoveRequest: Equatable {
    let from: String
    let to: String
}

struct ChessSceneView: View {
    let scene: ChessScene
    let games: GameStagePresenter
    let isFinished: Bool
    @Environment(\.accessibilityVoiceOverEnabled) private var voiceOver
    /// View-local (S60 11 j): the selected square, a watcher's Flip Board, the chooser and the promotion in progress.
    @State private var selected = ""
    @State private var flipped = false
    @State private var chooserOpen = false
    @State private var promotion: ChessMoveRequest? = nil
    @State private var movedCount = 0

    var body: some View {
        let orientation = ChessBoardPolicy.orientation(scene, flipped: flipped)
        VStack(alignment: .leading, spacing: 12) {
            ChessHeader(scene: scene, onFlip: { flipped.toggle() })
            ChessClocksRow(scene: scene, orientation: orientation)
            if scene.canMove && voiceOver && !chooserOpen {
                ChessChooserButton(onOpen: openChooser)
            }
            Group {
                if chooserOpen && scene.canMove {
                    ChessMoveChooser(scene: scene, onSend: { from, to, piece in send(from: from, to: to, promotion: piece) },
                                     onClose: { chooserOpen = false })
                } else {
                    ChessBoardSurface(scene: scene, games: games, orientation: orientation, selected: selected,
                                      onTap: { square in tap(square) })
                }
            }
            .confirmationDialog(ChessCopy.promoteTo(), isPresented: promotionShown, titleVisibility: .visible,
                                presenting: promotion) { request in
                ForEach(ChessPromotion.allCases, id: \.self) { piece in
                    Button(ChessCopy.promotionName(piece)) {
                        send(from: request.from, to: request.to, promotion: piece.rawValue)
                    }
                }
                // Cancel keeps the position (never an automatic queen, S60 11 c).
                Button(ConclaveStrings.text("Cancel"), role: .cancel) {}
            }
            ChessStatusLines(scene: scene, games: games)
            if scene.canMove && !voiceOver && !chooserOpen {
                ChessChooserButton(onOpen: openChooser)
            }
            ChessActionsBar(scene: scene, games: games)
            ChessTeamsList(scene: scene)
            ChessMovesList(scene: scene)
            if isFinished && !games.chrome.isHost {
                PromptLine(text: ConclaveStrings.text("Waiting for the host"))
            }
            // The kit's spectator notice only when a seat can be asked for (the role line already says "Watching").
            if games.chrome.seat == .canJoin {
                PromptSpectatorNotice(games: games)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .conclaveGestureFeedback(.pieceMoved, trigger: movedCount)
        .modifier(PromptAnnouncement(games: games, key: scene.turnKey, text: ChessCopy.yourMove()))
        .modifier(PromptAnnouncement(games: games, key: scene.checkKey, text: ChessCopy.check()))
        .modifier(PromptAnnouncement(games: games, key: scene.resultKey, text: ChessCopy.result(scene.result)))
        .onChange(of: scene.fen) { _, _ in
            selected = ""
            promotion = nil
        }
        .onChange(of: scene.canMove) { _, canMove in
            if !canMove {
                selected = ""
                promotion = nil
                chooserOpen = false
            }
        }
        .accessibilityIdentifier("game.scene.chess")
    }

    private var promotionShown: Binding<Bool> {
        Binding(get: { promotion != nil }, set: { shown in
            if !shown { promotion = nil }
        })
    }

    private func openChooser() {
        selected = ""
        chooserOpen = true
    }

    /// Tap source, then destination (S60 11 c); ignored while a move waits for its ack.
    private func tap(_ square: String) {
        if games.chessPendingMove.isPending { return }
        let outcome = ChessBoardPolicy.tap(scene, selected: selected, square: square)
        switch outcome.action {
        case .none, .select, .deselect:
            selected = outcome.selected
        case .move:
            selected = ""
            send(from: outcome.from, to: outcome.to, promotion: "")
        case .promote:
            selected = ""
            promotion = ChessMoveRequest(from: outcome.from, to: outcome.to)
        }
    }

    /// One `move {from, to, promotion}`; `pieceMoved` plays only for a dispatched move (S60 11 e, h).
    private func send(from: String, to: String, promotion piece: String) {
        selected = ""
        promotion = nil
        if games.sendChessMove(from: from, to: to, promotion: piece) == .dispatched {
            movedCount += 1
            chooserOpen = false
        }
    }
}

/// "Your Move" (or "White to Move", "Check", the result) with the mode and role line, and Flip Board for watchers.
struct ChessHeader: View {
    let scene: ChessScene
    let onFlip: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Text(ChessCopy.status(scene))
                    .font(.headline)
                    .foregroundStyle(HostingTheme.token(DesignTokens.iosInCallText))
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityAddTraits(.isHeader)
                    .accessibilityIdentifier("game.chess.status")
                if scene.isCheck {
                    // The ring on the board carries the contrast; this text carries the meaning (S60 11 e).
                    Text(ChessCopy.check())
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(HostingTheme.inCallLeave)
                        .accessibilityIdentifier("game.chess.check")
                }
                Spacer(minLength: 8)
                if scene.canFlip {
                    // The R6-1 `flip_board` glyph joins this button when the icon lands (HD request B8-T3 R9).
                    Button(ChessCopy.flipBoard(), action: onFlip)
                        .buttonStyle(.bordered)
                        .tint(HostingTheme.token(DesignTokens.iosInCallText))
                        .frame(minHeight: 44)
                        .accessibilityIdentifier("game.chess.flip")
                }
            }
            Text(ChessCopy.modeAndRole(scene))
                .font(.footnote)
                .foregroundStyle(HostingTheme.inCallTextSecondary)
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityIdentifier("game.chess.role")
        }
    }
}

// MARK: Clocks (one timer leaf)

/// Both clocks and the rapid-fire move chip. Only this leaf ticks (once per second while the scene is active and a
/// clock runs); the remaining time is the server's at the push minus the time since it arrived (S60 11 c, k).
struct ChessClocksRow: View {
    let scene: ChessScene
    let orientation: ChessSide
    @Environment(\.scenePhase) private var scenePhase

    var body: some View {
        let clocks = scene.clocks
        if !clocks.hasClock && !clocks.hasMoveTimer {
            Text(ChessCopy.noClock())
                .font(.footnote)
                .foregroundStyle(HostingTheme.inCallTextSecondary)
                .accessibilityIdentifier("game.chess.noClock")
        } else if clocks.runningSide != .none && scenePhase == .active {
            TimelineView(.periodic(from: .now, by: 1)) { context in
                ChessClocksFace(scene: scene, orientation: orientation, nowMillis: context.date.timeIntervalSince1970 * 1000)
            }
        } else {
            ChessClocksFace(scene: scene, orientation: orientation, nowMillis: Date().timeIntervalSince1970 * 1000)
        }
    }
}

private struct ChessClocksFace: View {
    let scene: ChessScene
    let orientation: ChessSide
    let nowMillis: Double

    var body: some View {
        let clocks = scene.clocks
        let top = ChessBoardPolicy.opposite(orientation)
        ConclaveFlowLayout(spacing: 8) {
            if clocks.hasClock {
                ChessClockChip(clocks: clocks, side: top, nowMillis: nowMillis)
                ChessClockChip(clocks: clocks, side: orientation, nowMillis: nowMillis)
            }
            if clocks.moveLimitMillis > 0 {
                ChessMoveTimerChip(clocks: clocks, nowMillis: nowMillis)
            }
        }
    }
}

/// "White 3:58" with tabular digits; the running side is outlined in paper; under 10 s it turns the warning color and
/// adds "Low time" (no shake). VoiceOver reads one element ("White, 3 minutes, 58 seconds left", value "Running").
private struct ChessClockChip: View {
    let clocks: ChessClockModel
    let side: ChessSide
    let nowMillis: Double

    var body: some View {
        let seconds = ChessClockModel.wholeSeconds(clocks.remainingMillis(side, nowMillis: nowMillis))
        let low = clocks.isLow(side, nowMillis: nowMillis)
        let running = clocks.runningSide == side
        let ink = low ? HostingTheme.token(DesignTokens.iosInCallWarning) : HostingTheme.token(DesignTokens.iosInCallText)
        HStack(spacing: 6) {
            Text(ChessCopy.sideName(side))
                .font(.subheadline)
            Text(ChessCopy.clock(seconds))
                .font(.subheadline.weight(running ? .semibold : .regular))
                .monospacedDigit()
            if low {
                Text(ChessCopy.lowTime())
                    .font(.caption.weight(.semibold))
            }
        }
        .foregroundStyle(ink)
        .padding(.horizontal, 10)
        .padding(.vertical, 4)
        .overlay {
            Capsule().strokeBorder(running ? HostingTheme.token(DesignTokens.iosInCallText) : HostingTheme.inCallBorder,
                                   lineWidth: running ? 2 : 1)
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(ChessCopy.clockSpoken(side, seconds: seconds, low: low))
        .accessibilityValue(running ? ChessCopy.running() : "")
        .accessibilityIdentifier("game.chess.clock." + side.rawValue)
    }
}

/// Rapid fire: "10 s per move" and, while a turn runs, the seconds left for this move.
private struct ChessMoveTimerChip: View {
    let clocks: ChessClockModel
    let nowMillis: Double

    var body: some View {
        let limit = Int((clocks.moveLimitMillis / 1000.0).rounded())
        let left = ChessClockModel.wholeSeconds(clocks.moveRemainingMillis(nowMillis: nowMillis))
        HStack(spacing: 6) {
            Text(ChessCopy.perMove(limit))
                .font(.subheadline)
            if clocks.hasMoveTimer {
                Text(ChessCopy.clock(left))
                    .font(.subheadline.weight(.semibold))
                    .monospacedDigit()
            }
        }
        .foregroundStyle(HostingTheme.token(DesignTokens.iosInCallText))
        .padding(.horizontal, 10)
        .padding(.vertical, 4)
        .overlay { Capsule().strokeBorder(HostingTheme.inCallBorder, lineWidth: 1) }
        .accessibilityElement(children: .combine)
        .accessibilityValue(clocks.hasMoveTimer ? ChessCopy.moveLeft(ChessCopy.spokenDuration(left)) : "")
        .accessibilityIdentifier("game.chess.moveTimer")
    }
}

// MARK: Board (B3)

/// A square board as wide as the card allows, capped at 480 pt (300 pt in compact height); cells are side / 8, about
/// 38 pt on a 375 pt phone. Orientation follows your side (or a watcher's flip); never mirrored by the layout direction.
struct ChessBoardSurface: View {
    let scene: ChessScene
    let games: GameStagePresenter
    let orientation: ChessSide
    let selected: String
    let onTap: (String) -> Void
    @Environment(\.verticalSizeClass) private var verticalSizeClass

    var body: some View {
        let cap = verticalSizeClass == .compact ? ChessBoardPolicy.compactMaxSide : ChessBoardPolicy.maxSide
        Color.clear
            .aspectRatio(1, contentMode: .fit)
            .frame(maxWidth: CGFloat(cap))
            .overlay {
                GeometryReader { proxy in
                    ChessBoardLayer(scene: scene, games: games, orientation: orientation, selected: selected, onTap: onTap,
                                    side: Double(min(proxy.size.width, proxy.size.height)))
                }
            }
            .frame(maxWidth: .infinity)
            .environment(\.layoutDirection, .leftToRight)
            .accessibilityIdentifier("game.chess.board")
    }
}

/// The canvas, its tap gesture and the synthetic accessibility children. Reads `chessPendingMove` (the move in flight)
/// and nothing else from the presenter.
struct ChessBoardLayer: View {
    let scene: ChessScene
    let games: GameStagePresenter
    let orientation: ChessSide
    let selected: String
    let onTap: (String) -> Void
    let side: Double

    var body: some View {
        let pending = games.chessPendingMove
        let squares = ChessBoardPolicy.displayedSquares(scene, orientation: orientation)
        let targets = selected.isEmpty ? [] : scene.destinations(from: selected)
        let interactive = scene.canMove && !pending.isPending
        ChessCanvas(scene: scene, squares: squares, pending: pending, selected: selected, targets: targets, side: side)
            .frame(width: CGFloat(side), height: CGFloat(side))
            .contentShape(Rectangle())
            .gesture(SpatialTapGesture(coordinateSpace: .local).onEnded { value in
                onTap(ChessBoardPolicy.square(atX: Double(value.location.x), y: Double(value.location.y), side: side,
                                              orientation: orientation))
            }, including: interactive ? .all : .none)
            .accessibilityLabel(ChessCopy.boardLabel())
            .accessibilityChildren {
                ChessAccessibilityGrid(scene: scene, squares: squares, pending: pending, selected: selected, targets: targets,
                                       cell: CGFloat(side / 8.0), interactive: interactive, onTap: onTap)
            }
    }
}

/// One canvas (S60 11 c, e): squares `iosGameBoardLight` / `iosGameBoardDark`, coordinates in paper `.caption2`, the
/// last move outlined in paper 2 pt, the selection a paper and ink double ring, legal targets as solid paper dots (a
/// ring for a capture), a king in check a paper 2 pt outline with a 2 pt red inner ring, the pending move dashed. No
/// animation: pieces are placed instantly (S60 11 h).
struct ChessCanvas: View {
    let scene: ChessScene
    let squares: [ChessSquareModel]
    let pending: ChessPendingMoveModel
    let selected: String
    let targets: [ChessLegalMoveModel]
    let side: Double

    var body: some View {
        let light = HostingTheme.token(DesignTokens.iosGameBoardLight)
        let dark = HostingTheme.token(DesignTokens.iosGameBoardDark)
        let paper = HostingTheme.token(DesignTokens.iosInCallText)
        let ink = HostingTheme.token(DesignTokens.ink)
        let red = HostingTheme.inCallLeave
        Canvas { context, _ in
            let cell = side / 8.0
            var index = 0
            for square in squares {
                let rect = CGRect(x: Double(index % 8) * cell, y: Double(index / 8) * cell, width: cell, height: cell)
                context.fill(Path(rect), with: .color(square.isLight ? light : dark))
                if index % 8 == 0 {
                    context.draw(Text(String(square.rank)).font(.caption2).foregroundStyle(paper),
                                 at: CGPoint(x: rect.minX + 2, y: rect.minY + 1), anchor: .topLeading)
                }
                if index / 8 == 7 {
                    context.draw(Text(ChessCopy.fileLetter(square.file)).font(.caption2).foregroundStyle(paper),
                                 at: CGPoint(x: rect.maxX - 2, y: rect.maxY - 1), anchor: .bottomTrailing)
                }
                if square.isLastMove {
                    context.stroke(Path(rect.insetBy(dx: 1, dy: 1)), with: .color(paper), lineWidth: 2)
                }
                if square.isCheck {
                    context.stroke(Path(rect.insetBy(dx: 1, dy: 1)), with: .color(paper), lineWidth: 2)
                    context.stroke(Path(rect.insetBy(dx: 3, dy: 3)), with: .color(red), lineWidth: 2)
                }
                let piece = ChessBoardPolicy.shownPiece(scene, pending: pending, square: square.id)
                if !piece.isEmpty {
                    ChessPieceArt.draw(piece, in: rect, context: context, paper: paper, ink: ink)
                }
                if square.id == selected {
                    context.stroke(Path(rect.insetBy(dx: 1, dy: 1)), with: .color(paper), lineWidth: 2)
                    context.stroke(Path(rect.insetBy(dx: 3, dy: 3)), with: .color(ink), lineWidth: 2)
                }
                for move in targets where move.to == square.id {
                    if move.isCapture || !square.piece.isEmpty {
                        let ring = rect.insetBy(dx: cell * 0.08, dy: cell * 0.08)
                        context.stroke(Path(ellipseIn: ring), with: .color(paper), lineWidth: 2)
                    } else {
                        let radius = cell * 0.14
                        context.fill(Path(ellipseIn: CGRect(x: rect.midX - radius, y: rect.midY - radius, width: radius * 2,
                                                            height: radius * 2)), with: .color(paper))
                    }
                }
                if pending.isPending && square.id == pending.to {
                    context.stroke(Path(rect.insetBy(dx: 1, dy: 1)), with: .color(paper),
                                   style: StrokeStyle(lineWidth: 2, dash: [4, 3]))
                }
                index += 1
            }
        }
        // Coordinates stay legible inside the fixed geometry (F00 5: geometry-bound board).
        .dynamicTypeSize(...DynamicTypeSize.xxLarge)
    }
}

/// Bundled Tabler Icons artwork (MIT), shared geometry for both sides. Darwin/Assets.xcassets belongs to the app,
/// so these template images resolve from Bundle.main, not the Swift package resource bundle.
enum ChessPieceArt {
    static func assetName(_ code: String) -> String? {
        guard let kind = ChessBoardPolicy.kind(ofPiece: code) else { return nil }
        switch kind {
        case .king: return "ChessPieceKing"
        case .queen: return "ChessPieceQueen"
        case .rook: return "ChessPieceRook"
        case .bishop: return "ChessPieceBishop"
        case .knight: return "ChessPieceKnight"
        case .pawn: return "ChessPiecePawn"
        }
    }

    // Eight radial copies under the fill form a 1 pt silhouette outline without changing the licensed paths.
    private static let outlineOffsets: [CGSize] = [
        CGSize(width: -1, height: 0), CGSize(width: 1, height: 0),
        CGSize(width: 0, height: -1), CGSize(width: 0, height: 1),
        CGSize(width: -0.70710678, height: -0.70710678), CGSize(width: 0.70710678, height: -0.70710678),
        CGSize(width: -0.70710678, height: 0.70710678), CGSize(width: 0.70710678, height: 0.70710678),
    ]

    static func draw(_ code: String, in rect: CGRect, context: GraphicsContext, paper: Color, ink: Color) {
        guard let name = assetName(code) else { return }
        let isWhite = ChessBoardPolicy.side(ofPiece: code) == .white
        let fill = isWhite ? paper : ink
        let edge = isWhite ? ink : paper
        // A square viewport preserves the source's 24 x 24 aspect and leaves room for the outline inside the cell.
        let side = min(rect.width, rect.height) * 0.96
        let frame = CGRect(x: rect.midX - side / 2, y: rect.midY - side / 2, width: side, height: side)
        let resolved = context.resolve(Image(name, bundle: .main).renderingMode(.original))
        // Composite through the artwork's alpha. The compiled vector rendition can ignore ResolvedImage.shading;
        // separate layers preserve both side colors and keep source-in blending away from the board underneath.
        context.drawLayer { layer in
            for offset in outlineOffsets {
                layer.draw(resolved, in: frame.offsetBy(dx: offset.width, dy: offset.height))
            }
            layer.blendMode = .sourceIn
            layer.fill(Path(frame.insetBy(dx: -1, dy: -1)), with: .color(edge))
        }
        context.drawLayer { layer in
            layer.draw(resolved, in: frame)
            layer.blendMode = .sourceIn
            layer.fill(Path(frame), with: .color(fill))
        }
    }
}

/// One synthetic accessibility child per square in the board geometry (S60 11 c): "e4, white knight", "e4, empty, legal
/// move", "e8, black king, in check"; the selected square has the Selected trait; a square a tap would act on is a
/// button whose action is that tap. Rank order follows the orientation.
struct ChessAccessibilityGrid: View {
    let scene: ChessScene
    let squares: [ChessSquareModel]
    let pending: ChessPendingMoveModel
    let selected: String
    let targets: [ChessLegalMoveModel]
    let cell: CGFloat
    let interactive: Bool
    let onTap: (String) -> Void

    var body: some View {
        Grid(horizontalSpacing: 0, verticalSpacing: 0) {
            ForEach(0..<8, id: \.self) { row in
                GridRow {
                    ForEach(0..<8, id: \.self) { column in
                        let index = row * 8 + column
                        if index < squares.count {
                            let square = squares[index]
                            let actionable = interactive
                                && ChessBoardPolicy.tap(scene, selected: selected, square: square.id).action != .none
                            Rectangle()
                                .frame(width: cell, height: cell)
                                .accessibilityElement()
                                .accessibilityLabel(ChessCopy.squareLabel(square, scene: scene, pending: pending,
                                                                          isTarget: ChessCopy.isTarget(square.id, targets)))
                                .accessibilityAddTraits(square.id == selected ? .isSelected : [])
                                .accessibilityAddTraits(actionable ? .isButton : [])
                                .modifier(ChessSquareAction(enabled: actionable, action: { onTap(square.id) }))
                                .accessibilityIdentifier("game.chess.square." + square.id)
                        }
                    }
                }
            }
        }
    }
}

/// The tap action only on a square a tap would act on.
struct ChessSquareAction: ViewModifier {
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

// MARK: Move chooser (the complete non-visual path)

struct ChessChooserButton: View {
    let onOpen: () -> Void

    var body: some View {
        Button(ChessCopy.chooseMove(), action: onOpen)
            .buttonStyle(.bordered)
            .tint(HostingTheme.token(DesignTokens.iosInCallText))
            .frame(minHeight: 44)
            .accessibilityIdentifier("game.chess.choose")
    }
}

/// "Choose a Move" (S60 11 c, i): your pieces with a move ("Knight on g1"), then its destinations ("f3", "takes on
/// e5"), then the promotion piece; 44 pt rows; Back steps back. Without projected legal moves it offers every empty or
/// enemy square and the server decides (S60R 23). Instant swap in the card (no transition).
struct ChessMoveChooser: View {
    let scene: ChessScene
    let onSend: (String, String, String) -> Void
    let onClose: () -> Void
    @State private var pieceId = ""
    @State private var promotionTarget = ""

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(heading)
                .font(.headline)
                .foregroundStyle(HostingTheme.token(DesignTokens.iosInCallText))
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityAddTraits(.isHeader)
            if pieceId.isEmpty {
                ForEach(scene.movablePieces()) { square in
                    ChessChooserRow(title: ChessCopy.pieceOn(square), identifier: "game.chess.chooser.piece." + square.id) {
                        pieceId = square.id
                    }
                }
            } else if promotionTarget.isEmpty {
                ForEach(scene.destinations(from: pieceId)) { move in
                    ChessChooserRow(title: ChessCopy.destination(move), identifier: "game.chess.chooser.to." + move.to) {
                        if move.needsPromotion {
                            promotionTarget = move.to
                        } else {
                            onSend(pieceId, move.to, "")
                        }
                    }
                }
            } else {
                ForEach(ChessPromotion.allCases, id: \.self) { piece in
                    ChessChooserRow(title: ChessCopy.promotionName(piece), identifier: "game.chess.chooser.promote." + piece.rawValue) {
                        onSend(pieceId, promotionTarget, piece.rawValue)
                    }
                }
            }
            Button(ChessCopy.back(), action: back)
                .buttonStyle(.bordered)
                .tint(HostingTheme.token(DesignTokens.iosInCallText))
                .frame(minHeight: 44)
                .accessibilityIdentifier("game.chess.chooser.back")
        }
        .accessibilityIdentifier("game.chess.chooser")
        .onChange(of: scene.fen) { _, _ in
            pieceId = ""
            promotionTarget = ""
        }
    }

    private var heading: String {
        if pieceId.isEmpty { return ChessCopy.choosePiece() }
        if promotionTarget.isEmpty {
            guard let square = scene.square(pieceId) else { return ChessCopy.choosePiece() }
            return ChessCopy.chooseSquare(ChessCopy.pieceOn(square))
        }
        return ChessCopy.promoteTo()
    }

    private func back() {
        if !promotionTarget.isEmpty {
            promotionTarget = ""
        } else if !pieceId.isEmpty {
            pieceId = ""
        } else {
            onClose()
        }
    }
}

private struct ChessChooserRow: View {
    let title: String
    let identifier: String
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Text(title)
                .font(.body)
                .foregroundStyle(HostingTheme.token(DesignTokens.iosInCallText))
                .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                .padding(.horizontal, 12)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .background(HostingTheme.token(DesignTokens.iosInCallSurfaceRaised), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
        .overlay { RoundedRectangle(cornerRadius: 10, style: .continuous).strokeBorder(HostingTheme.inCallBorder, lineWidth: 1) }
        .accessibilityIdentifier(identifier)
    }
}

// MARK: Status, actions, teams and moves

/// "Move rejected" after a rejection (position restored), and the draw and takeback lines (S60 11 f). Reads
/// `chessPendingMove` for the rejection, so a dispatch never re-evaluates the header.
struct ChessStatusLines: View {
    let scene: ChessScene
    let games: GameStagePresenter

    var body: some View {
        let rejected = games.chessPendingMove.isRejected
        let draw = ChessCopy.offerLine(scene.drawOffer, isDraw: true)
        let takeback = ChessCopy.offerLine(scene.takebackRequest, isDraw: false)
        if rejected || !draw.isEmpty || !takeback.isEmpty {
            VStack(alignment: .leading, spacing: 6) {
                if rejected {
                    Text(ChessCopy.moveRejected())
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(HostingTheme.token(DesignTokens.iosInCallWarning))
                        .accessibilityIdentifier("game.chess.rejected")
                }
                if !draw.isEmpty {
                    PromptLine(text: draw)
                        .accessibilityIdentifier("game.chess.drawOffer")
                }
                if !takeback.isEmpty {
                    PromptLine(text: takeback)
                        .accessibilityIdentifier("game.chess.takeback")
                }
            }
        }
    }
}

/// The eligibility-gated actions (S60 11 c, C6-17): Offer Draw (never against the computer), Accept Draw and Decline,
/// Request Takeback (disabled with its reason), Accept Takeback and Decline, and Resign… with its attached
/// confirmation (R09). 44 pt bordered buttons that wrap; the pending one shows progress until its ack.
struct ChessActionsBar: View {
    let scene: ChessScene
    let games: GameStagePresenter
    @State private var resignPrompt = false

    var body: some View {
        let interaction = games.interaction
        let busy = interaction.isPending
        if hasActions {
            ConclaveFlowLayout(spacing: 8) {
                if scene.canOfferDraw {
                    actionButton(.offerDraw, title: ChessCopy.offerDraw(), busy: busy, pendingType: interaction.pendingType)
                }
                if scene.drawOffer.canRespond {
                    actionButton(.acceptDraw, title: ChessCopy.acceptDraw(), busy: busy, pendingType: interaction.pendingType)
                    actionButton(.declineDraw, title: ChessCopy.decline(), busy: busy, pendingType: interaction.pendingType)
                }
                if scene.showsTakeback {
                    // The R6-1 `undo` glyph joins this button when the icon lands (HD request B8-T3 R9).
                    actionButton(.requestTakeback, title: ChessCopy.requestTakeback(), busy: busy, pendingType: interaction.pendingType)
                        .disabled(!scene.canRequestTakeback)
                        .accessibilityHint(ChessCopy.takebackReason(scene.takebackReason))
                }
                if scene.takebackRequest.canRespond {
                    actionButton(.acceptTakeback, title: ChessCopy.acceptTakeback(), busy: busy, pendingType: interaction.pendingType)
                    actionButton(.declineTakeback, title: ChessCopy.decline(), busy: busy, pendingType: interaction.pendingType)
                }
                if scene.canResign {
                    Button(role: .destructive) {
                        resignPrompt = true
                    } label: {
                        if interaction.pendingType == ChessAction.resign.rawValue {
                            ProgressView().tint(HostingTheme.inCallLeave)
                        } else {
                            Text(ChessCopy.resignEllipsis())
                        }
                    }
                    .buttonStyle(.bordered)
                    .tint(HostingTheme.inCallLeave)
                    .frame(minHeight: 44)
                    .disabled(busy)
                    .accessibilityIdentifier("game.chess.resign")
                    .confirmationDialog(ChessCopy.resignTitle(), isPresented: $resignPrompt, titleVisibility: .visible) {
                        Button(ChessCopy.resign(), role: .destructive) { _ = games.sendChessAction(.resign) }
                        Button(ConclaveStrings.text("Cancel"), role: .cancel) {}
                    } message: {
                        Text(ChessCopy.resignMessage())
                    }
                }
            }
            .accessibilityIdentifier("game.chess.actions")
        }
    }

    private var hasActions: Bool {
        scene.canOfferDraw || scene.drawOffer.canRespond || scene.showsTakeback || scene.takebackRequest.canRespond || scene.canResign
    }

    private func actionButton(_ action: ChessAction, title: String, busy: Bool, pendingType: String) -> some View {
        Button {
            _ = games.sendChessAction(action)
        } label: {
            if pendingType == action.rawValue {
                ProgressView().tint(HostingTheme.token(DesignTokens.iosInCallText))
            } else {
                Text(title)
            }
        }
        .buttonStyle(.bordered)
        .tint(HostingTheme.token(DesignTokens.iosInCallText))
        .frame(minHeight: 44)
        .disabled(busy)
        .accessibilityIdentifier("game.chess.action." + action.rawValue)
    }
}

/// "White: Avery (captain), You" and "Black: Ben": who plays each side (the computer by its server name).
struct ChessTeamsList: View {
    let scene: ChessScene

    var body: some View {
        if !scene.teamWhite.isEmpty || !scene.teamBlack.isEmpty {
            VStack(alignment: .leading, spacing: 2) {
                PromptLine(text: ChessCopy.team(scene.teamWhite, side: .white, showsCaptain: scene.mode == .teams))
                PromptLine(text: ChessCopy.team(scene.teamBlack, side: .black, showsCaptain: scene.mode == .teams))
            }
            .accessibilityElement(children: .combine)
            .accessibilityIdentifier("game.chess.teams")
        }
    }
}

/// The move list (S60 11 c): a disclosure group "Moves" with rows "1. e4 e5" and "Auto-played for %@" notes.
struct ChessMovesList: View {
    let scene: ChessScene
    @State private var expanded = false

    var body: some View {
        DisclosureGroup(isExpanded: $expanded) {
            VStack(alignment: .leading, spacing: 4) {
                if scene.moves.isEmpty {
                    PromptLine(text: ChessCopy.noMoves())
                }
                ForEach(scene.moves) { row in
                    VStack(alignment: .leading, spacing: 2) {
                        Text(ChessCopy.moveRow(row))
                            .font(.subheadline)
                            .monospacedDigit()
                            .foregroundStyle(HostingTheme.token(DesignTokens.iosInCallText))
                        if !row.whiteAutoName.isEmpty {
                            PromptLine(text: ChessCopy.autoPlayed(row.whiteAutoName))
                        }
                        if !row.blackAutoName.isEmpty {
                            PromptLine(text: ChessCopy.autoPlayed(row.blackAutoName))
                        }
                    }
                    .accessibilityElement(children: .combine)
                    .accessibilityIdentifier("game.chess.move." + String(row.number))
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.top, 6)
        } label: {
            Text(ChessCopy.moves())
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(HostingTheme.token(DesignTokens.iosInCallText))
        }
        .tint(HostingTheme.token(DesignTokens.iosInCallText))
        .accessibilityIdentifier("game.chess.moves")
    }
}

// MARK: Copy

/// S60 11 g, exhaustive iOS copy (L6-14): Apple title case for controls and headings, sentence case for lines and
/// square labels; every enum mapped.
enum ChessCopy {
    static func yourMove() -> String { ConclaveStrings.text("Your Move") }
    static func check() -> String { ConclaveStrings.text("Chess Check") }

    static func status(_ scene: ChessScene) -> String {
        switch scene.status {
        case .waiting: return ""
        case .yourMove: return yourMove()
        case .toMove: return scene.turnSide == .black ? ConclaveStrings.text("Black to Move") : ConclaveStrings.text("White to Move")
        case .finished: return result(scene.result)
        }
    }

    static func mode(_ scene: ChessScene) -> String {
        switch scene.mode {
        case .duel: return ConclaveStrings.text("Live chess duel")
        case .teams: return ConclaveStrings.text("Captain-led team chess")
        case .computer:
            return scene.isRoomVsComputer || !scene.isPlayer ? ConclaveStrings.text("The room vs the computer")
                : ConclaveStrings.text("You vs the computer")
        }
    }

    static func role(_ role: ChessRole) -> String {
        switch role {
        case .white: return ConclaveStrings.text("You play White")
        case .black: return ConclaveStrings.text("You play Black")
        case .whiteCaptain: return ConclaveStrings.text("White captain: you move")
        case .blackCaptain: return ConclaveStrings.text("Black captain: you move")
        case .whiteTeam: return ConclaveStrings.text("White team: call the moves together")
        case .blackTeam: return ConclaveStrings.text("Black team: call the moves together")
        case .watching: return ConclaveStrings.text("Watching")
        }
    }

    static func modeAndRole(_ scene: ChessScene) -> String {
        ConclaveStrings.format("Two Facts %@ %@", mode(scene), role(scene.role))
    }

    static func result(_ result: ChessResultModel) -> String {
        let white = result.winner == .white
        switch result.reason {
        case .none: return ""
        case .checkmate:
            return white ? ConclaveStrings.text("White wins by checkmate") : ConclaveStrings.text("Black wins by checkmate")
        case .timeout:
            if result.isDraw { return ConclaveStrings.text("Draw on time") }
            return white ? ConclaveStrings.text("White wins on time") : ConclaveStrings.text("Black wins on time")
        case .resignation:
            return white ? ConclaveStrings.text("White wins by resignation") : ConclaveStrings.text("Black wins by resignation")
        case .stalemate: return ConclaveStrings.text("Draw by stalemate")
        case .threefold: return ConclaveStrings.text("Draw by threefold repetition")
        case .insufficient: return ConclaveStrings.text("Draw by insufficient material")
        case .fiftyMove: return ConclaveStrings.text("Draw by the fifty-move rule")
        case .agreement: return ConclaveStrings.text("Draw by agreement")
        }
    }

    static func sideName(_ side: ChessSide) -> String {
        switch side {
        case .none: return ""
        case .white: return ConclaveStrings.text("Chess White")
        case .black: return ConclaveStrings.text("Chess Black")
        }
    }

    static func noClock() -> String { ConclaveStrings.text("No clock") }
    static func lowTime() -> String { ConclaveStrings.text("Low time") }
    static func running() -> String { ConclaveStrings.text("Chess Clock Running") }
    static func perMove(_ seconds: Int) -> String { ConclaveStrings.format("%lld s per move", seconds) }
    static func moveLeft(_ value: String) -> String { ConclaveStrings.format("Chess Move Left %@", value) }

    static func clockSpoken(_ side: ChessSide, seconds: Int, low: Bool) -> String {
        let spoken = ConclaveStrings.format("Chess Clock Spoken %@ %@", sideName(side), spokenDuration(seconds))
        return low ? ConclaveStrings.format("Two Facts %@ %@", spoken, lowTime()) : spoken
    }

    /// "3:58" in the current locale's digits.
    static func clock(_ seconds: Int) -> String {
        Duration.seconds(max(0, seconds)).formatted(.time(pattern: .minuteSecond))
    }

    /// "3 minutes, 58 seconds" for VoiceOver.
    static func spokenDuration(_ seconds: Int) -> String {
        Duration.seconds(max(0, seconds)).formatted(.units(allowed: [.minutes, .seconds], width: .wide))
    }

    static func offerDraw() -> String { ConclaveStrings.text("Offer Draw") }
    static func acceptDraw() -> String { ConclaveStrings.text("Accept Draw") }
    static func decline() -> String { ConclaveStrings.text("Chess Decline") }
    static func requestTakeback() -> String { ConclaveStrings.text("Request Takeback") }
    static func acceptTakeback() -> String { ConclaveStrings.text("Accept Takeback") }
    static func resignEllipsis() -> String { ConclaveStrings.text("Resign…") }
    static func resignTitle() -> String { ConclaveStrings.text("Resign This Game?") }
    static func resignMessage() -> String { ConclaveStrings.text("Your side loses.") }
    static func resign() -> String { ConclaveStrings.text("Resign") }

    static func takebackReason(_ reason: ChessTakebackReason) -> String {
        switch reason {
        case .none: return ""
        case .notMoved: return ConclaveStrings.text("Make a move first")
        case .pending: return ConclaveStrings.text("A takeback is pending")
        }
    }

    /// "Avery offered a draw." for everyone but the offering side, which reads "Draw offered"; the same for takebacks.
    static func offerLine(_ offer: ChessOfferModel, isDraw: Bool) -> String {
        if !offer.isActive { return "" }
        if offer.isYourSide {
            return isDraw ? ConclaveStrings.text("Draw offered") : ConclaveStrings.text("Takeback requested")
        }
        return isDraw ? ConclaveStrings.format("%@ offered a draw.", offer.byName)
            : ConclaveStrings.format("%@ asked for a takeback.", offer.byName)
    }

    static func promoteTo() -> String { ConclaveStrings.text("Promote To") }

    static func promotionName(_ piece: ChessPromotion) -> String {
        switch piece {
        case .queen: return ConclaveStrings.text("Queen")
        case .rook: return ConclaveStrings.text("Rook")
        case .bishop: return ConclaveStrings.text("Bishop")
        case .knight: return ConclaveStrings.text("Knight")
        }
    }

    static func kindName(_ kind: ChessPieceKind) -> String {
        switch kind {
        case .king: return ConclaveStrings.text("King")
        case .queen: return ConclaveStrings.text("Queen")
        case .rook: return ConclaveStrings.text("Rook")
        case .bishop: return ConclaveStrings.text("Bishop")
        case .knight: return ConclaveStrings.text("Knight")
        case .pawn: return ConclaveStrings.text("Pawn")
        }
    }

    /// "white knight" for square labels; "" for an empty square.
    static func pieceName(_ code: String) -> String {
        guard let kind = ChessBoardPolicy.kind(ofPiece: code) else { return "" }
        let white = ChessBoardPolicy.side(ofPiece: code) == .white
        switch kind {
        case .king: return white ? ConclaveStrings.text("white king") : ConclaveStrings.text("black king")
        case .queen: return white ? ConclaveStrings.text("white queen") : ConclaveStrings.text("black queen")
        case .rook: return white ? ConclaveStrings.text("white rook") : ConclaveStrings.text("black rook")
        case .bishop: return white ? ConclaveStrings.text("white bishop") : ConclaveStrings.text("black bishop")
        case .knight: return white ? ConclaveStrings.text("white knight") : ConclaveStrings.text("black knight")
        case .pawn: return white ? ConclaveStrings.text("white pawn") : ConclaveStrings.text("black pawn")
        }
    }

    static func flipBoard() -> String { ConclaveStrings.text("Flip Board") }
    static func chooseMove() -> String { ConclaveStrings.text("Choose a Move") }
    static func choosePiece() -> String { ConclaveStrings.text("Choose a Piece") }
    /// Its own key: the catalog's "Back" is the back camera.
    static func back() -> String { ConclaveStrings.text("Chess Chooser Back") }
    static func chooseSquare(_ piece: String) -> String { ConclaveStrings.format("Chess Choose Square %@", piece) }

    /// "Knight on g1".
    static func pieceOn(_ square: ChessSquareModel) -> String {
        guard let kind = ChessBoardPolicy.kind(ofPiece: square.piece) else { return square.id }
        return ConclaveStrings.format("Chess Piece On %@ %@", kindName(kind), square.id)
    }

    /// "f3", "takes on e5", "takes on d6 en passant", "castles to g1"; a promotion adds ", promotes".
    static func destination(_ move: ChessLegalMoveModel) -> String {
        var text = move.to
        switch ChessBoardPolicy.destinationKind(move) {
        case .quiet: text = move.to
        case .capture: text = ConclaveStrings.format("takes on %@", move.to)
        case .enPassant: text = ConclaveStrings.format("takes on %@ en passant", move.to)
        case .castle: text = ConclaveStrings.format("castles to %@", move.to)
        }
        return move.needsPromotion ? ConclaveStrings.format("Chess Promotes %@", text) : text
    }

    static func moves() -> String { ConclaveStrings.text("Moves") }
    static func noMoves() -> String { ConclaveStrings.text("No moves yet") }
    static func autoPlayed(_ name: String) -> String { ConclaveStrings.format("Auto-played for %@", name) }

    /// "1. e4 e5", or "1. e4" while Black has not answered (SAN verbatim).
    static func moveRow(_ row: ChessMoveRowModel) -> String {
        if row.black.isEmpty { return ConclaveStrings.format("Chess Move Row %lld %@", row.number, row.white) }
        if row.white.isEmpty { return ConclaveStrings.format("Chess Move Row %lld %@ %@", row.number, "…", row.black) }
        return ConclaveStrings.format("Chess Move Row %lld %@ %@", row.number, row.white, row.black)
    }

    static func moveRejected() -> String { ConclaveStrings.text("Move rejected") }
    static func boardLabel() -> String { ConclaveStrings.text("Chess Board") }

    static func team(_ members: [ChessTeamMemberModel], side: ChessSide, showsCaptain: Bool) -> String {
        if members.isEmpty { return "" }
        var names: [String] = []
        for member in members {
            let name = member.isYou ? ConclaveStrings.text("You") : member.name
            names.append(showsCaptain && member.isCaptain ? ConclaveStrings.format("Chess Captain %@", name) : name)
        }
        let list = ListFormatter.localizedString(byJoining: names)
        return side == .black ? ConclaveStrings.format("Chess Team Black %@", list) : ConclaveStrings.format("Chess Team White %@", list)
    }

    /// Board coordinate letters stay a to h in every locale (algebraic notation).
    static func fileLetter(_ file: Int) -> String {
        let id = ChessBoardPolicy.squareId(file: file, rank: 1)
        return id.isEmpty ? "" : String(id.prefix(1))
    }

    static func isTarget(_ id: String, _ targets: [ChessLegalMoveModel]) -> Bool {
        for move in targets where move.to == id {
            return true
        }
        return false
    }

    /// "e4, white knight", "e4, empty, legal move", "e8, black king, in check, last move".
    static func squareLabel(_ square: ChessSquareModel, scene: ChessScene, pending: ChessPendingMoveModel, isTarget: Bool) -> String {
        let piece = ChessBoardPolicy.shownPiece(scene, pending: pending, square: square.id)
        var label = fact(square.id, piece.isEmpty ? ConclaveStrings.text("Chess Empty Square") : pieceName(piece))
        if square.isCheck { label = fact(label, ConclaveStrings.text("in check")) }
        if isTarget { label = fact(label, ConclaveStrings.text("legal move")) }
        if square.isLastMove { label = fact(label, ConclaveStrings.text("last move")) }
        if pending.isPending && pending.to == square.id { label = fact(label, ConclaveStrings.text("Chess Pending Square")) }
        return label
    }

    private static func fact(_ first: String, _ second: String) -> String {
        ConclaveStrings.format("Chess Square %@ %@", first, second)
    }
}
#endif
