package conclave.module

import android.icu.text.ListFormatter
import android.icu.text.MeasureFormat
import android.icu.util.Measure
import android.icu.util.MeasureUnit
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableDoubleStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ColorFilter
import androidx.compose.ui.graphics.PathEffect
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.drawscope.translate
import androidx.compose.ui.graphics.painter.Painter
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.Layout
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalLayoutDirection
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.onClick
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.TextLayoutResult
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.drawText
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.rememberTextMeasurer
import androidx.compose.ui.unit.Constraints
import androidx.compose.ui.unit.LayoutDirection
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.repeatOnLifecycle
import java.util.Locale
import kotlin.math.roundToInt
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive

private val ChessChooserRowHeight = 48.dp

@Composable
internal fun ChessSceneBody(games: GameStagePresenter, cardHeader: (@Composable (Boolean) -> Unit)? = null) {
    val scene = games.scene.chess ?: return
    ChessSceneView(scene, games, games.chrome.phase == GameChromePhase.results, cardHeader)
}

@Composable
private fun ChessSceneView(scene: ChessScene, games: GameStagePresenter, isFinished: Boolean,
                           cardHeader: (@Composable (Boolean) -> Unit)? = null) {
    val access = rememberSystemAccessibility()
    val haptics = rememberConclaveHaptics()

    var selected by remember(scene.fen) { mutableStateOf("") }
    var flipped by rememberSaveable { mutableStateOf(false) }
    var chooserOpen by rememberSaveable(scene.fen) { mutableStateOf(false) }
    var promotionFrom by remember(scene.fen) { mutableStateOf("") }
    var promotionTo by remember(scene.fen) { mutableStateOf("") }
    val canMove = scene.canMove
    LaunchedEffect(canMove) {
        if (!canMove) {
            selected = ""
            chooserOpen = false
            promotionFrom = ""
            promotionTo = ""
        }
    }
    val orientation = ChessBoardPolicy.orientation(scene, flipped)
    val send: (String, String, String) -> Unit = { from, to, piece ->
        selected = ""
        promotionFrom = ""
        promotionTo = ""
        if (games.sendChessMove(from, to, piece) == ActivityTapResult.dispatched) {

            haptics.gesture(FeedbackKind.pieceMoved)
            chooserOpen = false
        }
    }
    val tap: (String) -> Unit = { square ->
        if (!games.chessPendingMove.isPending) {
            val outcome = ChessBoardPolicy.tap(scene, selected, square)
            when (outcome.action) {
                ChessTapAction.none, ChessTapAction.select, ChessTapAction.deselect -> selected = outcome.selected
                ChessTapAction.move -> send(outcome.from, outcome.to, "")
                ChessTapAction.promote -> {
                    selected = ""
                    promotionFrom = outcome.from
                    promotionTo = outcome.to
                }
            }
        }
    }
    val stackedScene: @Composable () -> Unit = {
        Column(Modifier.fillMaxWidth().testTag("game.scene.chess"), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            ChessHeader(scene, onFlip = { flipped = !flipped })
            ChessClocksRow(scene, orientation)

            if (canMove && access.touchExploration && !chooserOpen) ChessChooserButton(onOpen = { selected = ""; chooserOpen = true })
            if (chooserOpen && canMove) {
                ChessMoveChooser(scene, onSend = send, onClose = { chooserOpen = false })
            } else {
                ChessBoardSurface(scene, games, orientation, selected, tap)
            }
            ChessStatusLines(scene, games)
            if (canMove && !access.touchExploration && !chooserOpen) ChessChooserButton(onOpen = { selected = ""; chooserOpen = true })
            ChessActionsBar(scene, games)
            ChessTeamsList(scene)
            ChessMovesList(scene)
            if (isFinished && !games.chrome.isHost) PromptLine(conclaveString("gm_waiting_host"))

            if (games.chrome.seat == SeatState.canJoin) PromptSpectatorNotice(games)
        }
    }
    Box(Modifier.fillMaxWidth()) {
        if (cardHeader == null) {
            stackedScene()
        } else {
            val fontScale = LocalDensity.current.fontScale.toDouble()
            val bounds = rememberGameShellBounds()
            BoxWithConstraints(Modifier.fillMaxSize().gameShellBounds(bounds) { probe, rect -> probe.body = rect }.testTag("game.body")) {
                val plan = ChessCardLayoutPolicy.resolve(width = maxWidth.value.toDouble(), height = maxHeight.value.toDouble(),
                    detailsWidth = ChessCardLayoutPolicy.minimumDetailsWidth * fontScale)
                if (plan.usesColumns && !chooserOpen) {
                    SideEffect { bounds?.bar = Rect.Zero }
                    Row(Modifier.fillMaxSize().padding(ChessCardLayoutPolicy.compactPadding.dp).testTag("game.scene.chess"),
                        horizontalArrangement = Arrangement.spacedBy(ChessCardLayoutPolicy.columnGap.dp)) {
                        CompositionLocalProvider(LocalLayoutDirection provides LayoutDirection.Ltr) {
                            Box(Modifier.size(plan.boardSide.dp).testTag("game.chess.board")) {
                                ChessBoardLayer(scene, games, orientation, selected, tap, plan.boardSide.toFloat())
                            }
                        }
                        Column(Modifier.weight(1f).fillMaxHeight(), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                            if (canMove) ChessChooserButton(onOpen = { selected = ""; chooserOpen = true })
                            Column(Modifier.weight(1f).fillMaxWidth().gameShellBounds(bounds) { probe, rect -> probe.viewport = rect }
                                .verticalScroll(rememberScrollState()).gameShellBounds(bounds) { probe, rect -> probe.content = rect }
                                .testTag("game.chess.details"),
                                verticalArrangement = Arrangement.spacedBy(12.dp)) {
                                cardHeader(true)
                                GameShellNotices(games)
                                ChessHeader(scene, onFlip = { flipped = !flipped })
                                ChessClocksRow(scene, orientation)
                                ChessStatusLines(scene, games)
                                ChessActionsBar(scene, games)
                                ChessTeamsList(scene)
                                ChessMovesList(scene)
                                if (isFinished && !games.chrome.isHost) PromptLine(conclaveString("gm_waiting_host"))
                                if (games.chrome.seat == SeatState.canJoin) PromptSpectatorNotice(games)
                                GameShellBottomBar(games)
                            }
                        }
                    }
                } else {
                    Column(Modifier.fillMaxSize()) {
                        cardHeader(false)
                        HorizontalDivider(color = LocalConclaveExtendedColors.current.border)
                        GameShellScrollColumn(games, Modifier.weight(1f).fillMaxWidth(), bounds) {
                            stackedScene()
                        }
                        GameShellBottomBar(games, Modifier.gameShellBounds(bounds) { probe, rect -> probe.bar = rect })
                    }
                }
                if (bounds != null) GameShellBoundsReadout(bounds, Modifier.align(Alignment.TopStart))
            }
        }
        PromptAnnouncement(games, scene.turnKey, conclaveString("gm_chess_your_move"))
        PromptAnnouncement(games, scene.checkKey, conclaveString("gm_chess_check"))
        PromptAnnouncement(games, scene.resultKey, chessResultText(scene.result))
    }
    if (promotionFrom.isNotEmpty() && promotionTo.isNotEmpty()) {
        ChessPromotionDialog(
            onChoose = { piece -> send(promotionFrom, promotionTo, piece.rawValue) },

            onDismiss = { promotionFrom = ""; promotionTo = "" },
        )
    }
}

@Composable
private fun ChessHeader(scene: ChessScene, onFlip: () -> Unit) {
    val scheme = MaterialTheme.colorScheme
    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Row(Modifier.weight(1f), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Text(chessStatusText(scene), style = MaterialTheme.typography.titleMedium, color = scheme.onSurface,
                    modifier = Modifier.semantics { heading() }.testTag("game.chess.status"))
                if (scene.isCheck) {

                    Text(conclaveString("gm_chess_check"), style = MaterialTheme.typography.labelLarge, fontWeight = FontWeight.SemiBold,
                        color = scheme.error, modifier = Modifier.testTag("game.chess.check"))
                }
            }
            if (scene.canFlip) {

                OutlinedButton(onClick = onFlip, modifier = Modifier.heightIn(min = 48.dp).testTag("game.chess.flip")) {
                    Text(conclaveString("gm_chess_flip"))
                }
            }
        }
        Text(conclaveString("act_two_facts", chessModeText(scene), conclaveString(chessRoleResource(scene.role))),
            style = MaterialTheme.typography.bodySmall, color = scheme.onSurfaceVariant, modifier = Modifier.testTag("game.chess.role"))
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun ChessClocksRow(scene: ChessScene, orientation: ChessSide) {
    val clocks = scene.clocks
    val scheme = MaterialTheme.colorScheme
    if (!clocks.hasClock && !clocks.hasMoveTimer) {
        Text(conclaveString("gm_chess_no_clock"), style = MaterialTheme.typography.bodySmall, color = scheme.onSurfaceVariant,
            modifier = Modifier.testTag("game.chess.noClock"))
        return
    }
    var nowMillis by remember(clocks) { mutableDoubleStateOf(System.currentTimeMillis().toDouble()) }
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    LaunchedEffect(clocks, lifecycle) {
        if (clocks.runningSide == ChessSide.none) return@LaunchedEffect
        lifecycle.repeatOnLifecycle(Lifecycle.State.STARTED) {
            while (isActive) {
                nowMillis = System.currentTimeMillis().toDouble()
                delay(1000L)
            }
        }
    }
    val top = ChessBoardPolicy.opposite(orientation)
    FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        if (clocks.hasClock) {
            ChessClockChip(clocks, top, nowMillis)
            ChessClockChip(clocks, orientation, nowMillis)
        }
        if (clocks.moveLimitMillis > 0.0) ChessMoveTimerChip(clocks, nowMillis)
    }
}

@Composable
private fun ChessClockChip(clocks: ChessClockModel, side: ChessSide, nowMillis: Double) {
    val scheme = MaterialTheme.colorScheme
    val ext = LocalConclaveExtendedColors.current
    val seconds = ChessClockModel.wholeSeconds(clocks.remainingMillis(side, nowMillis))
    val low = clocks.isLow(side, nowMillis)
    val running = clocks.runningSide == side
    val ink = if (low) ext.warning else scheme.onSurface
    val sideName = conclaveString(chessSideResource(side))
    val lowText = conclaveString("gm_chess_low_time")
    val spokenBase = conclaveString("gm_chess_clock_spoken", sideName, chessSpokenDuration(seconds))
    val spoken = if (low) conclaveString("act_two_facts", spokenBase, lowText) else spokenBase
    val runningText = conclaveString("gm_chess_running")
    Surface(
        shape = CircleShape,
        color = scheme.surfaceContainer,
        border = BorderStroke(if (running) 2.dp else 1.dp, if (running) scheme.onSurface else ext.border),
        modifier = Modifier.testTag("game.chess.clock.${side.rawValue}").clearAndSetSemantics {
            contentDescription = spoken
            if (running) stateDescription = runningText
        },
    ) {
        Row(Modifier.padding(horizontal = 10.dp, vertical = 4.dp), verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            Text(sideName, style = MaterialTheme.typography.labelLarge, color = ink)
            Text(chessClock(seconds), style = rememberTabular(MaterialTheme.typography.labelLarge), color = ink,
                fontWeight = if (running) FontWeight.SemiBold else FontWeight.Normal)
            if (low) Text(lowText, style = MaterialTheme.typography.labelSmall, fontWeight = FontWeight.SemiBold, color = ink)
        }
    }
}

@Composable
private fun ChessMoveTimerChip(clocks: ChessClockModel, nowMillis: Double) {
    val scheme = MaterialTheme.colorScheme
    val ext = LocalConclaveExtendedColors.current
    val limit = (clocks.moveLimitMillis / 1000.0).roundToInt()
    val left = ChessClockModel.wholeSeconds(clocks.moveRemainingMillis(nowMillis))
    val perMove = conclaveString("gm_chess_per_move", limit)
    val spoken = if (clocks.hasMoveTimer) {
        conclaveString("act_two_facts", perMove, conclaveString("gm_chess_move_left", chessSpokenDuration(left)))
    } else {
        perMove
    }
    Surface(
        shape = CircleShape,
        color = scheme.surfaceContainer,
        border = BorderStroke(1.dp, ext.border),
        modifier = Modifier.testTag("game.chess.moveTimer").clearAndSetSemantics { contentDescription = spoken },
    ) {
        Row(Modifier.padding(horizontal = 10.dp, vertical = 4.dp), verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            Text(perMove, style = MaterialTheme.typography.labelLarge, color = scheme.onSurface)
            if (clocks.hasMoveTimer) {
                Text(chessClock(left), style = rememberTabular(MaterialTheme.typography.labelLarge), fontWeight = FontWeight.SemiBold,
                    color = scheme.onSurface)
            }
        }
    }
}

private class ChessBoardText(
    val pieces: Map<String, Painter>,
    val ranks: Map<Int, TextLayoutResult>,
    val files: Map<Int, TextLayoutResult>,
)

@Composable
private fun ChessBoardSurface(scene: ChessScene, games: GameStagePresenter, orientation: ChessSide, selected: String,
                              onTap: (String) -> Unit) {
    val compactHeight = LocalConfiguration.current.screenHeightDp < 480
    val cap = if (compactHeight) ChessBoardPolicy.compactMaxSide else ChessBoardPolicy.maxSide
    CompositionLocalProvider(LocalLayoutDirection provides LayoutDirection.Ltr) {
        BoxWithConstraints(Modifier.fillMaxWidth().testTag("game.chess.board"), contentAlignment = Alignment.Center) {
            val side = if (maxWidth.value.toDouble() < cap) maxWidth else cap.dp
            ChessBoardLayer(scene, games, orientation, selected, onTap, side.value)
        }
    }
}

@Composable
private fun ChessBoardLayer(scene: ChessScene, games: GameStagePresenter, orientation: ChessSide, selected: String,
                            onTap: (String) -> Unit, sideDp: Float) {
    val pending = games.chessPendingMove
    val density = LocalDensity.current
    val sidePx = with(density) { sideDp.dp.toPx() }
    val squares = remember(scene, orientation) { ChessBoardPolicy.displayedSquares(scene, orientation).toList() }
    val targets = remember(scene, selected) {
        if (selected.isEmpty()) emptyList<ChessLegalMoveModel>() else scene.destinations(selected).toList()
    }
    val interactive = scene.canMove && !pending.isPending
    val latestTap by rememberUpdatedState(onTap)
    val latestInteractive by rememberUpdatedState(interactive)
    val text = rememberChessBoardText(sidePx)
    val scheme = MaterialTheme.colorScheme
    val ext = LocalConclaveExtendedColors.current
    val colors = ChessBoardColors(light = ext.gameBoardLight, dark = ext.gameBoardDark, paper = scheme.onSurface, ink = ext.stage,
        red = scheme.error)
    val boardLabel = conclaveString("gm_chess_board")
    Box(Modifier.size(sideDp.dp).semantics { contentDescription = boardLabel }) {
        Canvas(
            Modifier
                .size(sideDp.dp)
                .pointerInput(orientation, sidePx) {
                    detectTapGestures { offset ->
                        if (latestInteractive) {
                            latestTap(ChessBoardPolicy.square(offset.x.toDouble(), offset.y.toDouble(), size.width.toDouble(), orientation))
                        }
                    }
                },
        ) {
            drawChessBoard(scene, squares, pending, selected, targets, text, colors)
        }
        ChessSemanticsOverlay(scene, squares, pending, selected, targets, interactive, sideDp, latestTap)
    }
}

private data class ChessBoardColors(val light: Color, val dark: Color, val paper: Color, val ink: Color, val red: Color)

@Composable
private fun rememberChessBoardText(sidePx: Float): ChessBoardText {
    val measurer = rememberTextMeasurer()
    val density = LocalDensity.current
    val pieces = rememberChessPiecePainters()
    val labelSize = MaterialTheme.typography.labelSmall.fontSize
    return remember(sidePx, pieces, measurer, density, labelSize) {
        val cell = sidePx / 8f
        val coordinatePx = with(density) { minOf(labelSize.toPx(), cell * 0.28f) }
        val coordinateStyle = with(density) { TextStyle(fontSize = coordinatePx.toSp()) }
        val ranks = HashMap<Int, TextLayoutResult>()
        val files = HashMap<Int, TextLayoutResult>()
        for (index in 0..7) {
            ranks[index + 1] = measurer.measure((index + 1).toString(), style = coordinateStyle)
            files[index] = measurer.measure(chessFileLetter(index), style = coordinateStyle)
        }
        ChessBoardText(pieces, ranks, files)
    }
}

@Composable
private fun rememberChessPiecePainters(): Map<String, Painter> {
    val context = LocalContext.current
    val painters = LinkedHashMap<String, Painter>()
    for (code in ChessPieceCodes) {
        val name = chessPieceAssetName(code) ?: continue
        if (name !in painters) {
            val id = remember(context, name) { conclaveDrawableId(context, name) }
            check(id != 0) { "Missing bundled chess artwork: $name" }
            painters[name] = painterResource(id)
        }
    }
    return painters
}

private fun DrawScope.drawChessBoard(scene: ChessScene, squares: List<ChessSquareModel>, pending: ChessPendingMoveModel, selected: String,
                                     targets: List<ChessLegalMoveModel>, text: ChessBoardText, colors: ChessBoardColors) {
    val cell = size.width / 8f
    val line = 2.dp.toPx()
    val outline = 1.dp.toPx()
    var index = 0
    for (square in squares) {
        val left = (index % 8) * cell
        val top = (index / 8) * cell
        drawRect(if (square.isLight) colors.light else colors.dark, topLeft = Offset(left, top), size = Size(cell, cell))
        if (index % 8 == 0) {
            text.ranks[square.rank]?.let { drawText(it, color = colors.paper, topLeft = Offset(left + outline * 2, top + outline)) }
        }
        if (index / 8 == 7) {
            text.files[square.file]?.let {
                drawText(it, color = colors.paper,
                    topLeft = Offset(left + cell - it.size.width - outline * 2, top + cell - it.size.height - outline))
            }
        }
        if (square.isLastMove) drawSquareOutline(left, top, cell, 1f, colors.paper, line)
        if (square.isCheck) {
            drawSquareOutline(left, top, cell, 1f, colors.paper, line)
            drawSquareOutline(left, top, cell, 3f, colors.red, line)
        }
        val piece = ChessBoardPolicy.shownPiece(scene, pending, square.id)
        if (piece.isNotEmpty()) drawChessPiece(piece, Offset(left + cell / 2f, top + cell / 2f), cell, text, colors, outline)
        if (square.id == selected) {
            drawSquareOutline(left, top, cell, 1f, colors.paper, line)
            drawSquareOutline(left, top, cell, 3f, colors.ink, line)
        }
        for (move in targets) {
            if (move.to != square.id) continue
            val center = Offset(left + cell / 2f, top + cell / 2f)
            if (move.isCapture || square.piece.isNotEmpty()) {
                drawCircle(colors.paper, radius = cell * 0.42f, center = center, style = Stroke(width = line))
            } else {
                drawCircle(colors.paper, radius = cell * 0.14f, center = center)
            }
        }
        if (pending.isPending && square.id == pending.to) {
            drawRect(colors.paper, topLeft = Offset(left + line / 2f, top + line / 2f), size = Size(cell - line, cell - line),
                style = Stroke(width = line, pathEffect = PathEffect.dashPathEffect(floatArrayOf(4.dp.toPx(), 3.dp.toPx()))))
        }
        index += 1
    }
}

private fun DrawScope.drawSquareOutline(left: Float, top: Float, cell: Float, insetDp: Float, color: Color, width: Float) {
    val inset = insetDp.dp.toPx()
    drawRect(color, topLeft = Offset(left + inset, top + inset), size = Size(cell - inset * 2f, cell - inset * 2f), style = Stroke(width = width))
}

private val ChessPieceOutlineOffsets = listOf(
    Offset(-1f, 0f), Offset(1f, 0f), Offset(0f, -1f), Offset(0f, 1f),
    Offset(-0.70710678f, -0.70710678f), Offset(0.70710678f, -0.70710678f),
    Offset(-0.70710678f, 0.70710678f), Offset(0.70710678f, 0.70710678f),
)

private fun DrawScope.drawChessPiece(code: String, center: Offset, cell: Float, text: ChessBoardText, colors: ChessBoardColors,
                                     outline: Float) {
    val name = chessPieceAssetName(code) ?: return
    val painter = text.pieces[name] ?: return
    val isWhite = ChessBoardPolicy.side(code) == ChessSide.white
    val fill = if (isWhite) colors.paper else colors.ink
    val edge = if (isWhite) colors.ink else colors.paper
    val side = cell * 0.96f
    val artSize = Size(side, side)
    val left = center.x - side / 2f
    val top = center.y - side / 2f
    for (offset in ChessPieceOutlineOffsets) {
        translate(left + offset.x * outline, top + offset.y * outline) {
            with(painter) { draw(artSize, colorFilter = ColorFilter.tint(edge)) }
        }
    }
    translate(left, top) {
        with(painter) { draw(artSize, colorFilter = ColorFilter.tint(fill)) }
    }
}

@Composable
private fun ChessSemanticsOverlay(scene: ChessScene, squares: List<ChessSquareModel>, pending: ChessPendingMoveModel, selected: String,
                                  targets: List<ChessLegalMoveModel>, interactive: Boolean, sideDp: Float, onTap: (String) -> Unit) {
    val labels = chessSquareLabels(scene, squares, pending, targets)
    val selectLabel = conclaveString("gm_chess_select")
    val moveLabel = conclaveString("gm_chess_move_here")
    Layout(
        content = {
            for ((index, square) in squares.withIndex()) {
                val action = if (interactive) ChessBoardPolicy.tap(scene, selected, square.id).action else ChessTapAction.none
                val actionLabel = if (action == ChessTapAction.move || action == ChessTapAction.promote) moveLabel else selectLabel
                val label = labels.getOrElse(index) { square.id }
                Box(
                    Modifier
                        .clearAndSetSemantics {
                            contentDescription = label
                            this.selected = square.id == selected
                            if (action != ChessTapAction.none) {
                                onClick(label = actionLabel) {
                                    onTap(square.id)
                                    true
                                }
                            }
                        }
                        .testTag("game.chess.square.${square.id}"),
                )
            }
        },
        modifier = Modifier.size(sideDp.dp),
    ) { measurables, constraints ->
        val cell = constraints.maxWidth / 8f
        val placeables = measurables.mapIndexed { index, measurable ->
            val column = index % 8
            val row = index / 8
            val width = ((column + 1) * cell).roundToInt() - (column * cell).roundToInt()
            val height = ((row + 1) * cell).roundToInt() - (row * cell).roundToInt()
            measurable.measure(Constraints.fixed(maxOf(0, width), maxOf(0, height)))
        }
        layout(constraints.maxWidth, constraints.maxHeight) {
            placeables.forEachIndexed { index, placeable ->
                placeable.place(((index % 8) * cell).roundToInt(), ((index / 8) * cell).roundToInt())
            }
        }
    }
}

@Composable
private fun ChessPromotionDialog(onChoose: (ChessPromotion) -> Unit, onDismiss: () -> Unit) {
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(conclaveString("gm_chess_promote")) },
        text = {
            Column(Modifier.testTag("game.chess.promotion")) {
                for (piece in ChessPromotion.allCases) {
                    Row(
                        Modifier
                            .fillMaxWidth()
                            .heightIn(min = 48.dp)
                            .selectable(selected = false, role = Role.RadioButton, onClick = { onChoose(piece) })
                            .testTag("game.chess.promotion.${piece.rawValue}"),
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(12.dp),
                    ) {
                        RadioButton(selected = false, onClick = null)
                        Text(conclaveString(chessPromotionResource(piece)), style = MaterialTheme.typography.bodyLarge)
                    }
                }
            }
        },
        confirmButton = {},
        dismissButton = { TextButton(onClick = onDismiss) { Text(conclaveString("ds_cancel")) } },
    )
}

@Composable
private fun ChessChooserButton(onOpen: () -> Unit) {
    OutlinedButton(onClick = onOpen, modifier = Modifier.heightIn(min = 48.dp).testTag("game.chess.choose")) {
        Text(conclaveString("gm_chess_choose"))
    }
}

@Composable
private fun ChessMoveChooser(scene: ChessScene, onSend: (String, String, String) -> Unit, onClose: () -> Unit) {
    var pieceId by rememberSaveable(scene.fen) { mutableStateOf("") }
    var promotionTarget by rememberSaveable(scene.fen) { mutableStateOf("") }
    val scheme = MaterialTheme.colorScheme
    val pieceSquare = if (pieceId.isEmpty()) null else scene.square(pieceId)
    val pieceTitle = if (pieceSquare == null) "" else chessPieceOn(pieceSquare)
    val heading = when {
        pieceSquare == null -> conclaveString("gm_chess_choose_piece")
        promotionTarget.isEmpty() -> conclaveString("gm_chess_choose_square", pieceTitle)
        else -> conclaveString("gm_chess_promote")
    }
    Column(Modifier.fillMaxWidth().testTag("game.chess.chooser"), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text(heading, style = MaterialTheme.typography.titleMedium, color = scheme.onSurface, modifier = Modifier.semantics { heading() })
        when {
            pieceSquare == null -> {
                for (square in scene.movablePieces()) {
                    ChessChooserRow(chessPieceOn(square), "game.chess.chooser.piece.${square.id}") { pieceId = square.id }
                }
            }
            promotionTarget.isEmpty() -> {
                for (move in scene.destinations(pieceId)) {
                    ChessChooserRow(chessDestinationText(move), "game.chess.chooser.to.${move.to}") {
                        if (move.needsPromotion) promotionTarget = move.to else onSend(pieceId, move.to, "")
                    }
                }
            }
            else -> {
                for (piece in ChessPromotion.allCases) {
                    ChessChooserRow(conclaveString(chessPromotionResource(piece)), "game.chess.chooser.promote.${piece.rawValue}") {
                        onSend(pieceId, promotionTarget, piece.rawValue)
                    }
                }
            }
        }
        OutlinedButton(
            onClick = {
                when {
                    promotionTarget.isNotEmpty() -> promotionTarget = ""
                    pieceId.isNotEmpty() -> pieceId = ""
                    else -> onClose()
                }
            },
            modifier = Modifier.heightIn(min = 48.dp).testTag("game.chess.chooser.back"),
        ) {
            Text(conclaveString("ds_back"))
        }
    }
}

@Composable
private fun ChessChooserRow(title: String, tag: String, onClick: () -> Unit) {
    val scheme = MaterialTheme.colorScheme
    val ext = LocalConclaveExtendedColors.current
    val shape = RoundedCornerShape(10.dp)
    Box(
        Modifier
            .fillMaxWidth()
            .heightIn(min = ChessChooserRowHeight)
            .background(scheme.surfaceContainerHigh, shape)
            .border(1.dp, ext.border, shape)
            .clickable(role = Role.Button, onClick = onClick)
            .padding(horizontal = 12.dp)
            .testTag(tag),
        contentAlignment = Alignment.CenterStart,
    ) {
        Text(title, style = MaterialTheme.typography.bodyLarge, color = scheme.onSurface)
    }
}

@Composable
private fun ChessStatusLines(scene: ChessScene, games: GameStagePresenter) {
    val rejected = games.chessPendingMove.isRejected
    val draw = chessOfferText(scene.drawOffer, isDraw = true)
    val takeback = chessOfferText(scene.takebackRequest, isDraw = false)
    if (!rejected && draw.isEmpty() && takeback.isEmpty()) return
    val ext = LocalConclaveExtendedColors.current
    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
        if (rejected) {
            Text(conclaveString("gm_chess_rejected"), style = MaterialTheme.typography.labelLarge, fontWeight = FontWeight.SemiBold,
                color = ext.warning, modifier = Modifier.testTag("game.chess.rejected"))
        }
        if (draw.isNotEmpty()) Box(Modifier.testTag("game.chess.drawOffer")) { PromptLine(draw) }
        if (takeback.isNotEmpty()) Box(Modifier.testTag("game.chess.takeback")) { PromptLine(takeback) }
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun ChessActionsBar(scene: ChessScene, games: GameStagePresenter) {
    val hasActions = scene.canOfferDraw || scene.drawOffer.canRespond || scene.showsTakeback || scene.takebackRequest.canRespond ||
        scene.canResign
    if (!hasActions) return
    val interaction = games.interaction
    val scheme = MaterialTheme.colorScheme
    var resignPrompt by remember { mutableStateOf(false) }
    FlowRow(Modifier.testTag("game.chess.actions"), horizontalArrangement = Arrangement.spacedBy(8.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp)) {
        if (scene.canOfferDraw) ChessActionButton(ChessAction.offerDraw, games, enabled = true)
        if (scene.drawOffer.canRespond) {
            ChessActionButton(ChessAction.acceptDraw, games, enabled = true)
            ChessActionButton(ChessAction.declineDraw, games, enabled = true)
        }
        if (scene.showsTakeback) {

            ChessActionButton(ChessAction.requestTakeback, games, enabled = scene.canRequestTakeback,
                reason = chessTakebackReasonResource(scene.takebackReason))
        }
        if (scene.takebackRequest.canRespond) {
            ChessActionButton(ChessAction.acceptTakeback, games, enabled = true)
            ChessActionButton(ChessAction.declineTakeback, games, enabled = true)
        }
        if (scene.canResign) {
            val pending = interaction.pendingType == ChessAction.resign.rawValue
            OutlinedButton(
                onClick = { resignPrompt = true },
                enabled = !interaction.isPending,
                colors = ButtonDefaults.outlinedButtonColors(contentColor = scheme.error),
                border = BorderStroke(1.dp, scheme.error),
                modifier = Modifier.heightIn(min = 48.dp).testTag("game.chess.resign"),
            ) {
                if (pending) {
                    CircularProgressIndicator(Modifier.size(18.dp), color = scheme.error, strokeWidth = 2.dp)
                } else {
                    Text(conclaveString("gm_chess_resign"))
                }
            }
        }
    }
    if (resignPrompt) {
        AlertDialog(
            onDismissRequest = { resignPrompt = false },
            title = { Text(conclaveString("gm_chess_resign_title")) },
            text = { Text(conclaveString("gm_chess_resign_message")) },
            confirmButton = {
                TextButton(
                    onClick = {
                        resignPrompt = false
                        games.sendChessAction(ChessAction.resign)
                    },
                    colors = ButtonDefaults.textButtonColors(contentColor = scheme.error),
                    modifier = Modifier.testTag("game.chess.resign.confirm"),
                ) { Text(conclaveString("gm_chess_resign")) }
            },
            dismissButton = { TextButton(onClick = { resignPrompt = false }) { Text(conclaveString("ds_cancel")) } },
        )
    }
}

@Composable
private fun ChessActionButton(action: ChessAction, games: GameStagePresenter, enabled: Boolean, reason: String? = null) {
    val interaction = games.interaction
    val scheme = MaterialTheme.colorScheme
    val pending = interaction.pendingType == action.rawValue
    val reasonText = if (reason != null && !enabled) conclaveString(reason) else ""
    val inProgress = conclaveString("ds_in_progress")
    OutlinedButton(
        onClick = { games.sendChessAction(action) },
        enabled = enabled && !interaction.isPending,
        modifier = Modifier
            .heightIn(min = 48.dp)
            .semantics {
                if (reasonText.isNotEmpty()) stateDescription = reasonText
                if (pending) stateDescription = inProgress
            }
            .testTag("game.chess.action.${action.rawValue}"),
    ) {
        if (pending) {
            CircularProgressIndicator(Modifier.size(18.dp), color = scheme.onSurface, strokeWidth = 2.dp)
        } else {
            Text(conclaveString(chessActionResource(action)))
        }
    }
}

@Composable
private fun ChessTeamsList(scene: ChessScene) {
    if (scene.teamWhite.count == 0 && scene.teamBlack.count == 0) return
    val white = chessTeamText(scene.teamWhite.toList(), ChessSide.white, scene.mode == ChessMode.teams)
    val black = chessTeamText(scene.teamBlack.toList(), ChessSide.black, scene.mode == ChessMode.teams)
    Column(Modifier.semantics(mergeDescendants = true) {}.testTag("game.chess.teams"), verticalArrangement = Arrangement.spacedBy(2.dp)) {
        PromptLine(white)
        PromptLine(black)
    }
}

@Composable
private fun ChessMovesList(scene: ChessScene) {
    var expanded by rememberSaveable { mutableStateOf(false) }
    val scheme = MaterialTheme.colorScheme
    val rows = remember(scene.moves) { scene.moves.toList() }
    Column(Modifier.fillMaxWidth().testTag("game.chess.moves"), verticalArrangement = Arrangement.spacedBy(4.dp)) {
        TextButton(onClick = { expanded = !expanded }, modifier = Modifier.heightIn(min = 48.dp)) {
            Text(conclaveString("gm_chess_moves"), style = MaterialTheme.typography.labelLarge, color = scheme.onSurface)
        }
        if (expanded) {
            if (rows.isEmpty()) {
                PromptLine(conclaveString("gm_chess_no_moves"))
            } else {
                LazyColumn(Modifier.fillMaxWidth().heightIn(max = 240.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    items(rows, key = { it.id }) { row -> ChessMoveRow(row) }
                }
            }
        }
    }
}

@Composable
private fun ChessMoveRow(row: ChessMoveRowModel) {
    val scheme = MaterialTheme.colorScheme
    Column(Modifier.fillMaxWidth().semantics(mergeDescendants = true) {}.testTag("game.chess.move.${row.number}")) {
        Text(chessMoveRowText(row), style = rememberTabular(MaterialTheme.typography.bodyMedium), color = scheme.onSurface)
        if (row.whiteAutoName.isNotEmpty()) PromptLine(conclaveString("gm_chess_auto", row.whiteAutoName))
        if (row.blackAutoName.isNotEmpty()) PromptLine(conclaveString("gm_chess_auto", row.blackAutoName))
    }
}

internal val ChessPieceCodes = listOf("wK", "wQ", "wR", "wB", "wN", "wP", "bK", "bQ", "bR", "bB", "bN", "bP")

internal fun chessPieceAssetName(code: String): String? = when (ChessBoardPolicy.kind(code)) {
    ChessPieceKind.king -> "chess_piece_king"
    ChessPieceKind.queen -> "chess_piece_queen"
    ChessPieceKind.rook -> "chess_piece_rook"
    ChessPieceKind.bishop -> "chess_piece_bishop"
    ChessPieceKind.knight -> "chess_piece_knight"
    ChessPieceKind.pawn -> "chess_piece_pawn"
    null -> null
}

internal fun chessFileLetter(file: Int): String = ChessBoardPolicy.squareId(file, 1).take(1)

internal fun chessClock(seconds: Int, locale: Locale = Locale.getDefault()): String {
    val value = maxOf(0, seconds)
    return String.format(locale, "%d:%02d", value / 60, value % 60)
}

internal fun chessSpokenDuration(seconds: Int, locale: Locale = Locale.getDefault()): String {
    val value = maxOf(0, seconds)
    val minutes = value / 60
    val rest = value % 60
    val format = MeasureFormat.getInstance(locale, MeasureFormat.FormatWidth.WIDE)
    return when {
        minutes > 0 && rest > 0 -> format.formatMeasures(Measure(minutes, MeasureUnit.MINUTE), Measure(rest, MeasureUnit.SECOND))
        minutes > 0 -> format.formatMeasures(Measure(minutes, MeasureUnit.MINUTE))
        else -> format.formatMeasures(Measure(rest, MeasureUnit.SECOND))
    }
}

internal fun chessRoleResource(role: ChessRole): String = when (role) {
    ChessRole.white -> "gm_chess_you_white"
    ChessRole.black -> "gm_chess_you_black"
    ChessRole.whiteCaptain -> "gm_chess_white_captain"
    ChessRole.blackCaptain -> "gm_chess_black_captain"
    ChessRole.whiteTeam -> "gm_chess_white_team"
    ChessRole.blackTeam -> "gm_chess_black_team"
    ChessRole.watching -> "gm_chess_watching"
}

internal fun chessModeResource(mode: ChessMode, roomVsComputer: Boolean): String = when (mode) {
    ChessMode.duel -> "gm_chess_duel"
    ChessMode.teams -> "gm_chess_teams"
    ChessMode.computer -> if (roomVsComputer) "gm_chess_room_cpu" else "gm_chess_you_cpu"
}

internal fun chessSideResource(side: ChessSide): String = when (side) {
    ChessSide.white -> "gm_chess_white"
    ChessSide.black -> "gm_chess_black"
    ChessSide.none -> "gm_chess_white"
}

internal fun chessResultResource(reason: ChessResultReason, winner: ChessSide, isDraw: Boolean): String = when (reason) {
    ChessResultReason.none -> ""
    ChessResultReason.checkmate -> if (winner == ChessSide.white) "gm_chess_white_mate" else "gm_chess_black_mate"
    ChessResultReason.timeout -> when {
        isDraw -> "gm_chess_draw_time"
        winner == ChessSide.white -> "gm_chess_white_time"
        else -> "gm_chess_black_time"
    }
    ChessResultReason.resignation -> if (winner == ChessSide.white) "gm_chess_white_resign" else "gm_chess_black_resign"
    ChessResultReason.stalemate -> "gm_chess_draw_stalemate"
    ChessResultReason.threefold -> "gm_chess_draw_threefold"
    ChessResultReason.insufficient -> "gm_chess_draw_insufficient"
    ChessResultReason.fiftyMove -> "gm_chess_draw_fifty"
    ChessResultReason.agreement -> "gm_chess_draw_agreement"
}

internal fun chessPromotionResource(piece: ChessPromotion): String = when (piece) {
    ChessPromotion.queen -> "gm_chess_queen"
    ChessPromotion.rook -> "gm_chess_rook"
    ChessPromotion.bishop -> "gm_chess_bishop"
    ChessPromotion.knight -> "gm_chess_knight"
}

internal fun chessKindResource(kind: ChessPieceKind): String = when (kind) {
    ChessPieceKind.king -> "gm_chess_king"
    ChessPieceKind.queen -> "gm_chess_queen"
    ChessPieceKind.rook -> "gm_chess_rook"
    ChessPieceKind.bishop -> "gm_chess_bishop"
    ChessPieceKind.knight -> "gm_chess_knight"
    ChessPieceKind.pawn -> "gm_chess_pawn"
}

internal fun chessPieceNameResource(code: String): String? {
    val kind = ChessBoardPolicy.kind(code) ?: return null
    val white = ChessBoardPolicy.side(code) == ChessSide.white
    return when (kind) {
        ChessPieceKind.king -> if (white) "gm_chess_w_k" else "gm_chess_b_k"
        ChessPieceKind.queen -> if (white) "gm_chess_w_q" else "gm_chess_b_q"
        ChessPieceKind.rook -> if (white) "gm_chess_w_r" else "gm_chess_b_r"
        ChessPieceKind.bishop -> if (white) "gm_chess_w_b" else "gm_chess_b_b"
        ChessPieceKind.knight -> if (white) "gm_chess_w_n" else "gm_chess_b_n"
        ChessPieceKind.pawn -> if (white) "gm_chess_w_p" else "gm_chess_b_p"
    }
}

internal fun chessDestinationResource(kind: ChessDestinationKind): String? = when (kind) {
    ChessDestinationKind.quiet -> null
    ChessDestinationKind.capture -> "gm_chess_takes_on"
    ChessDestinationKind.enPassant -> "gm_chess_takes_en_passant"
    ChessDestinationKind.castle -> "gm_chess_castles_to"
}

internal fun chessTakebackReasonResource(reason: ChessTakebackReason): String? = when (reason) {
    ChessTakebackReason.none -> null
    ChessTakebackReason.notMoved -> "gm_chess_takeback_not_moved"
    ChessTakebackReason.pending -> "gm_chess_takeback_pending"
}

internal fun chessActionResource(action: ChessAction): String = when (action) {
    ChessAction.offerDraw -> "gm_chess_offer_draw"
    ChessAction.acceptDraw -> "gm_chess_accept_draw"
    ChessAction.declineDraw -> "gm_chess_decline"
    ChessAction.requestTakeback -> "gm_chess_request_takeback"
    ChessAction.acceptTakeback -> "gm_chess_accept_takeback"
    ChessAction.declineTakeback -> "gm_chess_decline"
    ChessAction.resign -> "gm_chess_resign"
}

internal fun chessStatusResource(status: ChessStatus): String = when (status) {
    ChessStatus.waiting -> ""
    ChessStatus.yourMove -> "gm_chess_your_move"
    ChessStatus.toMove -> "gm_chess_to_move"
    ChessStatus.finished -> ""
}

@Composable
private fun chessStatusText(scene: ChessScene): String = when (scene.status) {
    ChessStatus.finished -> chessResultText(scene.result)
    ChessStatus.toMove -> conclaveString("gm_chess_to_move", conclaveString(chessSideResource(scene.turnSide)))
    ChessStatus.yourMove -> conclaveString("gm_chess_your_move")
    ChessStatus.waiting -> ""
}

@Composable
private fun chessModeText(scene: ChessScene): String =
    conclaveString(chessModeResource(scene.mode, scene.isRoomVsComputer || !scene.isPlayer))

@Composable
private fun chessResultText(result: ChessResultModel): String {
    val name = chessResultResource(result.reason, result.winner, result.isDraw)
    return if (name.isEmpty()) "" else conclaveString(name)
}

@Composable
private fun chessOfferText(offer: ChessOfferModel, isDraw: Boolean): String = when {
    !offer.isActive -> ""
    offer.isYourSide -> conclaveString(if (isDraw) "gm_chess_draw_offered" else "gm_chess_takeback_requested")
    else -> conclaveString(if (isDraw) "gm_chess_draw_offered_by" else "gm_chess_takeback_by", offer.byName)
}

@Composable
private fun chessPieceOn(square: ChessSquareModel): String {
    val kind = ChessBoardPolicy.kind(square.piece) ?: return square.id
    return conclaveString("gm_chess_piece_on", conclaveString(chessKindResource(kind)), square.id)
}

@Composable
private fun chessDestinationText(move: ChessLegalMoveModel): String {
    val name = chessDestinationResource(ChessBoardPolicy.destinationKind(move))
    val text = if (name == null) move.to else conclaveString(name, move.to)
    return if (move.needsPromotion) conclaveString("gm_chess_promotes", text) else text
}

@Composable
private fun chessMoveRowText(row: ChessMoveRowModel): String = when {
    row.black.isEmpty() -> conclaveString("gm_chess_move_row_white", row.number, row.white)
    row.white.isEmpty() -> conclaveString("gm_chess_move_row", row.number, "…", row.black)
    else -> conclaveString("gm_chess_move_row", row.number, row.white, row.black)
}

@Composable
private fun chessTeamText(members: List<ChessTeamMemberModel>, side: ChessSide, showsCaptain: Boolean): String {
    if (members.isEmpty()) return ""
    val you = conclaveString("ds_you")
    val names = ArrayList<String>()
    for (member in members) {
        val name = if (member.isYou) you else member.name
        names.add(if (showsCaptain && member.isCaptain) conclaveString("gm_chess_captain_name", name) else name)
    }
    val list = ListFormatter.getInstance(Locale.getDefault()).format(names)
    return conclaveString(if (side == ChessSide.black) "gm_chess_team_black" else "gm_chess_team_white", list)
}

@Composable
private fun chessSquareLabels(scene: ChessScene, squares: List<ChessSquareModel>, pending: ChessPendingMoveModel,
                              targets: List<ChessLegalMoveModel>): List<String> {
    val context = LocalContext.current
    return remember(scene, squares, pending, targets, context) {
        val empty = conclaveStringOf(context, "gm_chess_empty")
        val inCheck = conclaveStringOf(context, "gm_chess_in_check")
        val legal = conclaveStringOf(context, "gm_chess_legal")
        val last = conclaveStringOf(context, "gm_chess_last")
        val pendingText = conclaveStringOf(context, "gm_chess_pending")
        val fact = { first: String, second: String -> conclaveStringOf(context, "gm_chess_square_fact", first, second) }
        squares.map { square ->
            val piece = ChessBoardPolicy.shownPiece(scene, pending, square.id)
            val pieceName = chessPieceNameResource(piece)
            var label = fact(square.id, if (pieceName == null) empty else conclaveStringOf(context, pieceName))
            if (square.isCheck) label = fact(label, inCheck)
            if (targets.any { it.to == square.id }) label = fact(label, legal)
            if (square.isLastMove) label = fact(label, last)
            if (pending.isPending && pending.to == square.id) label = fact(label, pendingText)
            label
        }
    }
}
