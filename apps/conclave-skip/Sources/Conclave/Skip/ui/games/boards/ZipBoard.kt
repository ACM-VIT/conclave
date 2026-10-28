package conclave.module

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.focusable
import androidx.compose.foundation.gestures.detectDragGestures
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.absoluteOffset
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableDoubleStateOf
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.PathEffect
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.input.key.KeyEventType
import androidx.compose.ui.input.key.isAltPressed
import androidx.compose.ui.input.key.isCtrlPressed
import androidx.compose.ui.input.key.isMetaPressed
import androidx.compose.ui.input.key.key
import androidx.compose.ui.input.key.onPreviewKeyEvent
import androidx.compose.ui.input.key.type
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalLayoutDirection
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.onClick
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.drawText
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.rememberTextMeasurer
import androidx.compose.ui.unit.LayoutDirection
import androidx.compose.ui.unit.TextUnit
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.repeatOnLifecycle
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive

private const val ZipMaxFontScale = 1.3f

private val ZipNoPath: skip.lib.Array<Int> get() = skip.lib.Array()

@Composable
internal fun ZipSceneBody(games: GameStagePresenter) {
    val scene = games.scene.zip ?: return
    ZipSceneView(scene, games, games.chrome.phase == GameChromePhase.results)
}

@Composable
private fun ZipSceneView(scene: ZipScene, games: GameStagePresenter, isFinished: Boolean) {
    Column(Modifier.fillMaxWidth().testTag("game.scene.zip"), verticalArrangement = Arrangement.spacedBy(14.dp)) {
        ZipHeader(scene, games, isFinished)
        when (scene.phase) {
            ZipPhase.lobby -> {}
            ZipPhase.playing -> ZipPlayingView(scene, games)
            ZipPhase.results -> ZipResultsView(scene, games, isFinished)
        }
    }
}

@Composable
private fun ZipHeader(scene: ZipScene, games: GameStagePresenter, isFinished: Boolean) {
    val scheme = MaterialTheme.colorScheme
    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.Top, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Text(zipTitle(scene, isFinished), style = MaterialTheme.typography.titleMedium, color = scheme.onSurface,
                modifier = Modifier.semantics { heading() })
            if (scene.phase == ZipPhase.playing) {
                val meta = zipMeta(scene)
                if (meta.isNotEmpty()) {
                    Text(meta, style = rememberTabular(MaterialTheme.typography.bodySmall), color = scheme.onSurfaceVariant,
                        modifier = Modifier.testTag("game.zip.progress"))
                }
            }
        }
        if (scene.phase == ZipPhase.playing) ZipTimerSlot(games)
    }
}

@Composable
private fun ZipTimerSlot(games: GameStagePresenter) {
    val countdown = games.countdown ?: return
    ZipTimerChip(countdown)
}

@Composable
private fun ZipTimerChip(model: CountdownModel) {
    var nowMillis by remember(model) { mutableDoubleStateOf(System.currentTimeMillis().toDouble()) }
    var announcement by remember(model) { mutableStateOf("") }
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    LaunchedEffect(model, lifecycle) {
        lifecycle.repeatOnLifecycle(Lifecycle.State.STARTED) {
            while (isActive) {
                nowMillis = System.currentTimeMillis().toDouble()
                if (model.secondsLeft(nowMillis = nowMillis) == 0) break
                delay(1000L)
            }
        }
    }
    val seconds = model.secondsLeft(nowMillis = nowMillis)
    val warning = seconds <= ZipTimePolicy.warningSeconds
    val scheme = MaterialTheme.colorScheme
    val ext = LocalConclaveExtendedColors.current
    val shown = conclaveString("gm_zip_remaining", wordleClock(seconds))
    val spoken = conclaveString("gm_zip_remaining", wordleSpokenDuration(seconds))
    val announcedText = if (ZipTimePolicy.announcedSeconds.contains(seconds)) spoken else ""
    LaunchedEffect(announcedText) {
        if (announcedText.isNotEmpty()) announcement = announcedText
    }
    Box {
        Surface(
            shape = CircleShape,
            color = scheme.surfaceContainer,
            border = BorderStroke(1.dp, ext.border),
            modifier = Modifier.testTag("game.zip.timer").clearAndSetSemantics { contentDescription = spoken },
        ) {
            Text(shown, style = rememberTabular(MaterialTheme.typography.labelLarge), color = if (warning) ext.warning else scheme.onSurface,
                modifier = Modifier.padding(horizontal = 8.dp, vertical = 2.dp))
        }

        Box(Modifier.size(1.dp).semantics {
            liveRegion = LiveRegionMode.Polite
            contentDescription = announcement
        })
    }
}

@Composable
private fun ZipPlayingView(scene: ZipScene, games: GameStagePresenter) {
    val access = rememberSystemAccessibility()

    var chooserMode by rememberSaveable(scene.round) { mutableIntStateOf(0) }
    val showsChooser = if (chooserMode == 0) access.touchExploration else chooserMode == 1
    val draft = remember(scene.round) { ZipDraftState() }
    Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
        when (scene.role) {
            ZipRole.spectator -> {
                PromptSpectatorNotice(games)
                ZipBoardSurface(scene, games, null, ZipNoPath)
                ZipStandingsList(scene)
            }
            ZipRole.player -> {
                ZipBoardSurface(scene, games, draft, ZipNoPath)
                ZipRejectedLine(games)
                ZipOutcomeLine(scene, games)
                if (scene.myOutcome == ZipOutcome.none) {
                    ZipControls(scene, games, draft, showsChooser, onToggleChooser = { chooserMode = if (showsChooser) 2 else 1 })
                    if (showsChooser) ZipStepChooser(scene, games, draft)
                }
                ZipStandingsList(scene)
            }
        }
    }
}

@Composable
private fun ZipResultsView(scene: ZipScene, games: GameStagePresenter, isFinished: Boolean) {
    val isFinal = isFinished || scene.isFinalRound
    val shown = if (scene.solutionPath.count == 0) scene.confirmedPath else scene.solutionPath
    val winner = zipWinner(scene)
    Column(Modifier.testTag("game.zip.results"), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        PromptHeadline(winner, Modifier.testTag("game.zip.winner"))
        ZipOutcomeLine(scene, games)
        ZipBoardSurface(scene, games, null, shown)
        if (isFinished && scene.roundTotal > 1 && games.results.scoreboard.count > 0) GameKitScoreboard(games.results.scoreboard)
        ZipStandingsList(scene)
        if (!games.chrome.isHost) PromptLine(conclaveString(if (isFinal) "gm_waiting_host" else "gm_zip_waiting_next"))
        PromptAnnouncement(games, scene.resultKey, winner)
    }
}

@Composable
private fun ZipOutcomeLine(scene: ZipScene, games: GameStagePresenter) {
    val name = zipOutcomeResource(scene.myOutcome) ?: return
    val shown = if (name == "gm_zip_solved_in") conclaveString(name, wordleClock(ZipTimePolicy.wholeSeconds(scene.solvedMillis))) else conclaveString(name)
    val spoken = if (name == "gm_zip_solved_in") conclaveString(name, wordleSpokenDuration(ZipTimePolicy.wholeSeconds(scene.solvedMillis))) else shown
    PromptHeadline(shown, Modifier.testTag("game.zip.outcome").clearAndSetSemantics { contentDescription = spoken })
    PromptAnnouncement(games, scene.outcomeKey, spoken)
}

@Composable
private fun ZipRejectedLine(games: GameStagePresenter) {
    val state = games.interaction
    if (state.isPending || state.failure != GameFailure.server || !ZipPathPolicy.isPathRejection(state.failureServerText)) return
    Box(Modifier.testTag("game.zip.rejected")) {
        PromptLine(conclaveString("gm_zip_rejected"))
    }
}

@Composable
internal fun ZipHostBar(games: GameStagePresenter) {
    val scene = games.scene.zip ?: return
    if (!scene.canAdvanceRound) return
    val interaction = games.interaction
    val pending = interaction.isPending && interaction.pendingType == ZipIntent.nextRoundType
    Box(Modifier.testTag("game.host.nextRound")) {
        GameKitHostBar(
            primaryTitle = conclaveString("gm_next_round"),
            onPrimary = { games.send(ZipIntent.nextRound()) },
            primaryEnabled = !interaction.isPending || pending,
            primaryPending = pending,
        )
    }
}

internal class ZipDraftState {
    var draft: skip.lib.Array<Int> by mutableStateOf(ZipNoPath)
        private set
    var isDrafting: Boolean by mutableStateOf(false)
        private set
    var sent: skip.lib.Array<Int> by mutableStateOf(ZipNoPath)
        private set
    private var keyRun = false
    private var touchActive = false
    private var lastCell = -1
    private var pressCell = -1

    fun display(confirmed: skip.lib.Array<Int>, showsSent: Boolean): skip.lib.Array<Int> =
        ZipPathPolicy.displayPath(confirmed, draft, isDrafting, if (showsSent) sent else ZipNoPath)

    fun press(cell: Int) {
        pressCell = cell
    }

    fun dragOrigin(fallback: Int): Int = if (pressCell >= 0) pressCell else fallback

    fun touch(cell: Int, scene: ZipScene): Boolean {
        if (!touchActive) {
            touchActive = true
            val base = if (keyRun) draft else scene.confirmedPath
            if (!ZipPathPolicy.startsDrawing(base, cell, scene)) return false
            val next = ZipPathPolicy.touchDown(base, cell, scene)
            draft = next
            isDrafting = true
            lastCell = cell
            return next.count > base.count
        }
        if (!isDrafting || cell < 0 || cell == lastCell) return false
        val before = draft
        val next = ZipPathPolicy.dragged(before, lastCell, cell, scene)
        lastCell = cell
        if (ZipPathPolicy.samePath(next, before)) return false
        draft = next
        return next.count > before.count
    }

    fun lift(scene: ZipScene, games: GameStagePresenter) {
        val drew = isDrafting
        touchActive = false
        lastCell = -1
        pressCell = -1
        if (!drew) return
        commit(scene, games)
    }

    fun cancelTouch() {
        if (!touchActive) return
        discardDraft()
    }

    fun key(direction: ZipDirection, scene: ZipScene): Boolean {
        if (!scene.canMove) return false
        val base = if (keyRun) draft else scene.confirmedPath
        val next = ZipPathPolicy.keyStep(base, direction, scene)
        if (ZipPathPolicy.samePath(next, base)) return false
        val added = next.count > base.count
        if (ZipPathPolicy.samePath(next, scene.confirmedPath)) {
            discardDraft()
            return added
        }
        draft = next
        keyRun = true
        isDrafting = true
        return added
    }

    fun commitKeys(scene: ZipScene, games: GameStagePresenter) {
        if (!keyRun || touchActive) return
        commit(scene, games)
    }

    fun step(cell: Int, scene: ZipScene, games: GameStagePresenter): Boolean {
        discardDraft()
        if (!ZipPathPolicy.canExtend(scene.confirmedPath, cell, scene)) return false
        val path = ZipPathPolicy.stepped(scene.confirmedPath, cell)
        if (games.send(ZipIntent.move(path)) != ActivityTapResult.dispatched) return false
        sent = path
        return true
    }

    fun undo(scene: ZipScene, games: GameStagePresenter) {
        discardDraft()
        if (!scene.canUndo) return
        val path = ZipPathPolicy.undone(scene.confirmedPath)
        if (games.send(ZipIntent.move(path)) == ActivityTapResult.dispatched) sent = path
    }

    fun reset(scene: ZipScene, games: GameStagePresenter) {
        discardDraft()
        if (!scene.canReset) return
        if (games.send(ZipIntent.reset()) == ActivityTapResult.dispatched && scene.startCell >= 0) {
            sent = skip.lib.Array(listOf(scene.startCell))
        }
    }

    fun hint(scene: ZipScene, games: GameStagePresenter) {
        discardDraft()
        if (!scene.canHint) return
        games.send(ZipIntent.hint())
    }

    fun discardDraft() {
        if (isDrafting) isDrafting = false
        if (draft.count > 0) draft = ZipNoPath
        keyRun = false
        touchActive = false
        lastCell = -1
        pressCell = -1
    }

    private fun commit(scene: ZipScene, games: GameStagePresenter) {
        val path = draft
        discardDraft()
        if (!ZipPathPolicy.shouldSend(path, scene.confirmedPath)) return
        if (games.send(ZipIntent.move(path)) == ActivityTapResult.dispatched) sent = path
    }
}

@Composable
private fun ZipBoardSurface(scene: ZipScene, games: GameStagePresenter, draft: ZipDraftState?, readOnlyPath: skip.lib.Array<Int>) {
    CompositionLocalProvider(LocalLayoutDirection provides LayoutDirection.Ltr) {
        BoxWithConstraints(Modifier.fillMaxWidth().testTag("game.zip.board"), contentAlignment = Alignment.Center) {
            val side = ZipPathPolicy.boardSide(maxWidth.value.toDouble())
            ZipBoardLayer(scene, games, draft, readOnlyPath, side)
        }
    }
}

@Composable
private fun ZipBoardLayer(scene: ZipScene, games: GameStagePresenter, draft: ZipDraftState?, readOnlyPath: skip.lib.Array<Int>, side: Double) {
    val state = games.interaction
    val interactive = draft != null && scene.canMove
    val canDraw = interactive && !state.isPending
    val showsSent = state.isPending && (state.pendingType == ZipIntent.moveType || state.pendingType == ZipIntent.resetType)
    val haptics = rememberConclaveHaptics()
    val latestScene by rememberUpdatedState(scene)
    val latestCanDraw by rememberUpdatedState(canDraw)
    val focus = remember { FocusRequester() }
    val onStep: (Int) -> Unit = { cell ->
        if (draft != null && draft.step(cell, latestScene, games)) haptics.gesture(FeedbackKind.selectionChanged)
    }
    Box(
        Modifier
            .size(side.dp)
            .pointerInput(scene.size, scene.round) {
                detectTapGestures(
                    onPress = { offset ->
                        draft?.press(ZipPathPolicy.cellAt(offset.x.toDouble(), offset.y.toDouble(), size.width.toDouble(), latestScene.size))
                    },
                    onTap = { offset ->
                        if (draft != null && latestCanDraw) {
                            val cell = ZipPathPolicy.cellAt(offset.x.toDouble(), offset.y.toDouble(), size.width.toDouble(), latestScene.size)
                            if (draft.touch(cell, latestScene)) haptics.gesture(FeedbackKind.selectionChanged)
                            draft.lift(latestScene, games)
                        }
                    },
                )
            }
            .pointerInput(scene.size, scene.round) {
                detectDragGestures(
                    onDragStart = { offset ->
                        if (draft != null && latestCanDraw) {
                            val here = ZipPathPolicy.cellAt(offset.x.toDouble(), offset.y.toDouble(), size.width.toDouble(), latestScene.size)
                            var added = draft.touch(draft.dragOrigin(here), latestScene)
                            if (draft.touch(here, latestScene)) added = true
                            if (added) haptics.gesture(FeedbackKind.selectionChanged)
                        }
                    },
                    onDragEnd = { draft?.lift(latestScene, games) },
                    onDragCancel = { draft?.cancelTouch() },
                    onDrag = { change, _ ->
                        if (draft != null && latestCanDraw) {
                            change.consume()
                            val cell = ZipPathPolicy.cellAt(change.position.x.toDouble(), change.position.y.toDouble(), size.width.toDouble(),
                                latestScene.size)
                            if (draft.touch(cell, latestScene)) haptics.gesture(FeedbackKind.selectionChanged)
                        }
                    },
                )
            }
            .onPreviewKeyEvent { event ->
                val direction = zipKeyDirection(event.key)
                val isEnter = event.key == Key.Enter || event.key == Key.NumPadEnter || event.key == Key.DirectionCenter
                if (event.type != KeyEventType.KeyDown || event.isCtrlPressed || event.isMetaPressed || event.isAltPressed) {
                    false
                } else if (draft == null || !latestCanDraw || (direction == null && !isEnter)) {
                    false
                } else if (direction != null) {
                    if (draft.key(direction, latestScene)) haptics.gesture(FeedbackKind.selectionChanged)
                    true
                } else {
                    draft.commitKeys(latestScene, games)
                    true
                }
            }
            .focusRequester(focus)
            .focusable(enabled = interactive),
    ) {
        ZipCanvas(scene, draft, readOnlyPath, showsSent, side)
        ZipCellOverlay(scene, side, interactive, canDraw, onStep)
    }
    LaunchedEffect(scene.canMove) {
        if (!scene.canMove) draft?.discardDraft()
    }
    LaunchedEffect(interactive) {
        if (interactive) runCatching { focus.requestFocus() }
    }
}

@Composable
private fun ZipCanvas(scene: ZipScene, draft: ZipDraftState?, readOnlyPath: skip.lib.Array<Int>, showsSent: Boolean, side: Double) {
    val scheme = MaterialTheme.colorScheme
    val ext = LocalConclaveExtendedColors.current
    val light = ext.gameBoardLight
    val dark = ext.gameBoardDark
    val paper = scheme.onSurface
    val coral = scheme.primaryContainer
    val seam = scheme.outline
    val measurer = rememberTextMeasurer()
    val fontScale = LocalDensity.current.fontScale
    val cellSideDp = ZipPathPolicy.cellSide(side, scene.size)
    val base = if (cellSideDp >= ZipPathPolicy.compactCellSide) MaterialTheme.typography.titleMedium else MaterialTheme.typography.titleSmall
    val numberStyle = rememberTabular(base.copy(fontWeight = FontWeight.SemiBold, fontSize = zipCappedFontSize(base.fontSize, fontScale), color = paper))
    Canvas(Modifier.size(side.dp)) {
        val grid = scene.size
        if (grid <= 0) return@Canvas
        val path = draft?.display(scene.confirmedPath, showsSent) ?: readOnlyPath
        val solid = if (draft == null) path.count else ZipPathPolicy.sharedPrefixCount(path, scene.confirmedPath)
        val cell = size.width / grid
        val inset = ZipPathPolicy.cellInset.dp.toPx()
        val corner = CornerRadius(ZipPathPolicy.cellCorner.dp.toPx())
        val count = grid * grid
        val visited = BooleanArray(count)
        for (index in 0 until path.count) {
            val visitedCell = path[index]
            if (visitedCell in 0 until count) visited[visitedCell] = true
        }
        for (model in scene.cells) {
            val topLeft = Offset(model.column * cell + inset, model.row * cell + inset)
            val box = Size(cell - 2 * inset, cell - 2 * inset)
            if (model.isDead) {
                drawRoundRect(seam, topLeft, box, corner, style = Stroke(width = 1.dp.toPx()))
                drawLine(seam, Offset(topLeft.x + box.width * 0.25f, topLeft.y + box.height * 0.25f),
                    Offset(topLeft.x + box.width * 0.75f, topLeft.y + box.height * 0.75f), strokeWidth = 1.dp.toPx())
            } else {
                drawRoundRect(if (model.index in 0 until count && visited[model.index]) dark else light, topLeft, box, corner)
            }
        }
        val margin = 4.dp.toPx()
        for (wall in scene.walls) {
            if (wall.isBetweenColumns) {
                val x = ZipPathPolicy.column(wall.to, grid) * cell
                val top = ZipPathPolicy.row(wall.from, grid) * cell
                drawLine(paper, Offset(x, top + margin), Offset(x, top + cell - margin), strokeWidth = ZipPathPolicy.wallWidth.dp.toPx(),
                    cap = StrokeCap.Round)
            } else {
                val y = ZipPathPolicy.row(wall.to, grid) * cell
                val left = ZipPathPolicy.column(wall.from, grid) * cell
                drawLine(paper, Offset(left + margin, y), Offset(left + cell - margin, y), strokeWidth = ZipPathPolicy.wallWidth.dp.toPx(),
                    cap = StrokeCap.Round)
            }
        }
        val lineWidth = ZipPathPolicy.pathWidth.dp.toPx()
        val clampedSolid = minOf(maxOf(0, solid), path.count)
        if (clampedSolid >= 2) {
            drawPath(zipLine(path, 0, clampedSolid, cell, grid), coral,
                style = Stroke(width = lineWidth, cap = StrokeCap.Round, join = StrokeJoin.Round))
        }
        if (path.count >= 2 && path.count > clampedSolid) {
            val dash = ZipPathPolicy.dashLength.dp.toPx()
            drawPath(zipLine(path, maxOf(0, clampedSolid - 1), path.count, cell, grid), coral,
                style = Stroke(width = lineWidth, cap = StrokeCap.Butt, join = StrokeJoin.Round,
                    pathEffect = PathEffect.dashPathEffect(floatArrayOf(dash, dash), 0f)))
        }
        if (path.count > 0) {
            val head = path[path.count - 1]
            drawCircle(coral, radius = ZipPathPolicy.headDiameter.dp.toPx() / 2f, center = zipCenter(head, cell, grid))
        }
        for (checkpoint in scene.checkpoints) {
            if (checkpoint.cell < 0 || checkpoint.cell >= count) continue
            val center = zipCenter(checkpoint.cell, cell, grid)
            val radius = cell * ZipPathPolicy.checkpointRadiusFactor.toFloat()
            drawCircle(if (visited[checkpoint.cell]) dark else light, radius = radius, center = center)
            drawCircle(paper, radius = radius, center = center, style = Stroke(width = 1.5.dp.toPx()))
            val layout = measurer.measure(checkpoint.number.toString(), numberStyle)
            drawText(layout, topLeft = Offset(center.x - layout.size.width / 2f, center.y - layout.size.height / 2f))
        }
    }
}

private fun zipCenter(cell: Int, cellSide: Float, grid: Int): Offset =
    Offset((ZipPathPolicy.column(cell, grid) + 0.5f) * cellSide, (ZipPathPolicy.row(cell, grid) + 0.5f) * cellSide)

private fun zipLine(path: skip.lib.Array<Int>, from: Int, to: Int, cellSide: Float, grid: Int): Path {
    val line = Path()
    var index = from
    while (index < to && index < path.count) {
        val point = zipCenter(path[index], cellSide, grid)
        if (index == from) line.moveTo(point.x, point.y) else line.lineTo(point.x, point.y)
        index += 1
    }
    return line
}

@Composable
private fun ZipCellOverlay(scene: ZipScene, side: Double, interactive: Boolean, canStep: Boolean, onStep: (Int) -> Unit) {
    val cellSide = ZipPathPolicy.cellSide(side, scene.size)
    val latestOnStep by rememberUpdatedState(onStep)
    Box(Modifier.size(side.dp)) {
        for (cell in scene.cells) {
            key(cell.id) {
                val label = zipCellLabel(cell, interactive)
                val steps = interactive && canStep && cell.isNext
                val index = cell.index
                Box(
                    Modifier
                        .absoluteOffset(x = (cell.column * cellSide).dp, y = (cell.row * cellSide).dp)
                        .size(cellSide.dp)
                        .testTag("game.zip.cell.$index")
                        .clearAndSetSemantics {
                            contentDescription = label
                            if (steps) {
                                role = Role.Button
                                onClick {
                                    latestOnStep(index)
                                    true
                                }
                            }
                        },
                )
            }
        }
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun ZipControls(scene: ZipScene, games: GameStagePresenter, draft: ZipDraftState, chooserShown: Boolean, onToggleChooser: () -> Unit) {
    val state = games.interaction
    val busy = state.isPending || scene.isReconnecting
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            ZipControlButton(conclaveString("gm_zip_undo"), enabled = scene.canUndo && !busy, tag = "game.zip.undo") {
                draft.undo(scene, games)
            }
            ZipControlButton(conclaveString("gm_zip_reset"), enabled = scene.canReset && !busy,
                pending = state.isPending && state.pendingType == ZipIntent.resetType, tag = "game.zip.reset") {
                draft.reset(scene, games)
            }
            ZipHintButton(scene, games, draft)
            ZipControlButton(conclaveString("gm_zip_choose_next"), selected = chooserShown, tag = "game.zip.chooseNext",
                onClick = onToggleChooser)
        }
        if (scene.hintsUsed > 0) {
            Box(Modifier.testTag("game.zip.hintsUsed")) {
                PromptLine(conclavePlural("gm_zip_hints_used", scene.hintsUsed, scene.hintsUsed))
            }
        }
    }
}

@Composable
private fun ZipHintButton(scene: ZipScene, games: GameStagePresenter, draft: ZipDraftState) {
    var nowMillis by remember(scene.hintReadyAtMillis) { mutableDoubleStateOf(System.currentTimeMillis().toDouble()) }
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    LaunchedEffect(scene.hintReadyAtMillis, lifecycle) {
        lifecycle.repeatOnLifecycle(Lifecycle.State.STARTED) {
            while (isActive) {
                nowMillis = System.currentTimeMillis().toDouble()
                val left = scene.hintCooldownMillis(nowMillis = nowMillis)
                if (left <= 0.0) break
                val shownSeconds = scene.hintCooldownSeconds(nowMillis = nowMillis)
                delay(maxOf(16L, (left - (shownSeconds - 1) * 1000.0).toLong()))
            }
        }
    }
    val state = games.interaction
    val seconds = scene.hintCooldownSeconds(nowMillis = nowMillis)
    val title = if (seconds > 0) conclaveString("gm_zip_hint_cooldown", seconds) else conclaveString("gm_zip_hint")
    val cost = if (scene.hintCostPoints > 0) conclavePlural("gm_zip_hint_cost", scene.hintCostPoints, scene.hintCostPoints) else ""
    ZipControlButton(title, enabled = scene.canHint && seconds == 0 && !state.isPending && !scene.isReconnecting,
        pending = state.isPending && state.pendingType == ZipIntent.hintType, tag = "game.zip.hint",
        description = promptTwoFacts(title, cost)) {
        draft.hint(scene, games)
    }
}

@Composable
private fun ZipControlButton(
    title: String,
    enabled: Boolean = true,
    pending: Boolean = false,
    selected: Boolean? = null,
    tag: String,
    description: String = "",
    onClick: () -> Unit,
) {
    val scheme = MaterialTheme.colorScheme
    val inProgress = conclaveString("ds_in_progress")
    OutlinedButton(
        onClick = onClick,
        enabled = enabled && !pending,
        colors = ButtonDefaults.outlinedButtonColors(contentColor = scheme.onSurface),
        border = BorderStroke(if (selected == true) 2.dp else 1.dp, if (selected == true) scheme.onSurface else scheme.outline),
        modifier = Modifier
            .heightIn(min = 48.dp)
            .testTag(tag)
            .semantics {
                if (description.isNotEmpty()) contentDescription = description
                if (pending) stateDescription = inProgress
                if (selected != null) this.selected = selected
            },
    ) {
        if (pending) {
            CircularProgressIndicator(Modifier.size(18.dp), color = scheme.onSurface, strokeWidth = 2.dp)
            Spacer(Modifier.size(8.dp))
        }
        Text(title, style = rememberTabular(MaterialTheme.typography.labelLarge),
            modifier = if (description.isNotEmpty()) Modifier.clearAndSetSemantics {} else Modifier)
    }
}

@Composable
private fun ZipStepChooser(scene: ZipScene, games: GameStagePresenter, draft: ZipDraftState) {
    val scheme = MaterialTheme.colorScheme
    val haptics = rememberConclaveHaptics()
    val cells = ZipPathPolicy.chooserCells(scene)
    val busy = games.interaction.isPending || !scene.canMove
    Column(Modifier.fillMaxWidth().testTag("game.zip.chooser"), verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Text(conclaveString("gm_zip_choose_next"), style = MaterialTheme.typography.labelLarge, color = scheme.onSurfaceVariant,
            modifier = Modifier.semantics { heading() })
        if (cells.count == 0) {
            Box(Modifier.testTag("game.zip.noNext")) {
                PromptLine(conclaveString("gm_zip_no_next"))
            }
        } else {
            for (cell in cells) {
                key(cell.id) {
                    TextButton(
                        onClick = { if (draft.step(cell.index, scene, games)) haptics.gesture(FeedbackKind.selectionChanged) },
                        enabled = !busy,
                        colors = ButtonDefaults.textButtonColors(contentColor = scheme.onSurface),
                        modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp).testTag("game.zip.step.${cell.index}"),
                    ) {
                        Text(zipCellName(cell), modifier = Modifier.fillMaxWidth())
                    }
                }
            }
        }
    }
}

@Composable
private fun ZipStandingsList(scene: ZipScene) {
    if (scene.standings.count == 0) return
    val scheme = MaterialTheme.colorScheme
    val you = conclaveString("ds_you")
    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Text(conclaveString("gm_zip_standings"), style = MaterialTheme.typography.labelLarge, color = scheme.onSurfaceVariant,
            modifier = Modifier.semantics { heading() })
        for (row in scene.standings) {
            key(row.id) {
                val name = if (row.isYou) you else row.name
                val shown = zipStatus(row, spoken = false)
                val spoken = promptTwoFacts(name, zipStatus(row, spoken = true))
                Row(
                    Modifier.fillMaxWidth()
                        .background(if (row.isYou) scheme.surfaceContainerHigh else Color.Transparent, RoundedCornerShape(8.dp))
                        .padding(horizontal = 10.dp, vertical = 6.dp)
                        .testTag("game.zip.standing.${row.id}")
                        .clearAndSetSemantics { contentDescription = spoken },
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(10.dp),
                ) {
                    Text(name, style = MaterialTheme.typography.bodyLarge, color = scheme.onSurface, maxLines = 2, modifier = Modifier.weight(1f))
                    Text(shown, style = rememberTabular(MaterialTheme.typography.bodyMedium), color = scheme.onSurface)
                }
            }
        }
    }
}

internal fun zipKeyDirection(key: Key): ZipDirection? = when (key) {
    Key.DirectionUp -> ZipDirection.up
    Key.DirectionDown -> ZipDirection.down
    Key.DirectionLeft -> ZipDirection.left
    Key.DirectionRight -> ZipDirection.right
    else -> null
}

internal fun zipCappedFontSize(size: TextUnit, fontScale: Float): TextUnit =
    if (fontScale <= ZipMaxFontScale || fontScale <= 0f) size else (size.value * ZipMaxFontScale / fontScale).sp

internal fun zipTitleResource(phase: ZipPhase, isFinal: Boolean): String = when (phase) {
    ZipPhase.lobby, ZipPhase.playing -> "gm_zip_title"
    ZipPhase.results -> if (isFinal) "gm_zip_final" else "gm_zip_round_results"
}

internal fun zipOutcomeResource(outcome: ZipOutcome): String? = when (outcome) {
    ZipOutcome.none -> null
    ZipOutcome.solved -> "gm_zip_solved_in"
    ZipOutcome.timedOut -> "gm_zip_time_up"
}

internal fun zipStatusResource(status: ZipStandingStatus): String = when (status) {
    ZipStandingStatus.playing -> "gm_zip_cells"
    ZipStandingStatus.solved -> "gm_zip_solved_in"
    ZipStandingStatus.timedOut -> "gm_zip_time_up"
}

internal fun zipRoleNoteResource(role: ZipRole): String? = when (role) {
    ZipRole.player -> null
    ZipRole.spectator -> "gm_err_not_seated"
}

@Composable
private fun zipTitle(scene: ZipScene, isFinished: Boolean): String {
    val name = zipTitleResource(scene.phase, isFinished || scene.isFinalRound)
    return if (name == "gm_zip_round_results") conclaveString(name, scene.round) else conclaveString(name)
}

@Composable
private fun zipMeta(scene: ZipScene): String {
    val round = if (scene.roundTotal > 1 && scene.round > 0) conclaveString("act_round_of", scene.round, scene.roundTotal) else ""
    if (scene.role == ZipRole.spectator) return round
    return promptTwoFacts(round, zipCells(scene.visitedCount, scene.totalCells))
}

@Composable
private fun zipCells(filled: Int, total: Int): String = conclavePlural("gm_zip_cells", total, filled, total)

@Composable
private fun zipWinner(scene: ZipScene): String =
    if (scene.winnerName.isEmpty()) conclaveString("gm_zip_nobody") else conclaveString("gm_zip_winner", scene.winnerName)

@Composable
private fun zipHintsLine(count: Int): String =
    if (count > 0) conclavePlural("gm_zip_hints_used", count, count) else conclaveString("gm_zip_no_hints")

@Composable
private fun zipStatus(row: ZipStandingModel, spoken: Boolean): String {
    val name = zipStatusResource(row.status)
    return when (name) {
        "gm_zip_solved_in" -> {
            val seconds = ZipTimePolicy.wholeSeconds(row.solvedMillis)
            promptTwoFacts(conclaveString(name, if (spoken) wordleSpokenDuration(seconds) else wordleClock(seconds)), zipHintsLine(row.hintsUsed))
        }
        "gm_zip_cells" -> zipCells(row.cellsFilled, row.totalCells)
        else -> conclaveString(name)
    }
}

@Composable
private fun zipCellName(cell: ZipCellModel): String {
    val position = conclaveString("gm_zip_cell", cell.row + 1, cell.column + 1)
    return if (cell.checkpoint > 0) position + conclaveString("gm_zip_cell_checkpoint", cell.checkpoint) else position
}

@Composable
private fun zipCellLabel(cell: ZipCellModel, showsProgress: Boolean): String {
    val name = zipCellName(cell)
    if (cell.isDead) return name + conclaveString("gm_zip_cell_dead")
    val visited = if (showsProgress && cell.isVisited) conclaveString("gm_zip_cell_visited") else ""
    val head = if (showsProgress && cell.isHead) conclaveString("gm_zip_cell_head") else ""
    val next = if (showsProgress && cell.isNext) conclaveString("gm_zip_cell_next") else ""
    return name + visited + head + next
}
