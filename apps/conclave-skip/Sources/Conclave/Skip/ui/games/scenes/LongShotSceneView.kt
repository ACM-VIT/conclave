package conclave.module

import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.tween
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.Favorite
import androidx.compose.material.icons.rounded.HighlightOff
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.dp
import java.text.NumberFormat
import kotlinx.coroutines.delay

private const val LONG_SHOT_STEP_MILLIS = 110L

@Composable
internal fun LongShotSceneBody(games: GameStagePresenter) {
    val scene = games.scene.longShot
    if (scene == null) {
        GameKitNotice(GameKitNoticeKind.unsupported, "")
        return
    }
    Column(Modifier.fillMaxWidth().testTag("game.scene.longShot"), verticalArrangement = Arrangement.spacedBy(14.dp)) {
        when (scene.stage) {
            LongShotStage.lobby -> {}
            LongShotStage.dive -> scene.board.dive?.let { LongShotDiveView(it, scene, games) }
            LongShotStage.reveal -> scene.board.reveal?.let { LongShotRevealView(it) }
            LongShotStage.fuse -> scene.board.fuse?.let { LongShotFuseView(it, scene, games) }
            LongShotStage.popped -> scene.board.popped?.let { LongShotPopView(it) }
            LongShotStage.results -> scene.board.results?.let { LongShotResultsView(it) }
        }
        if (!scene.isPlayer && scene.stage != LongShotStage.results) {
            PromptSpectatorNotice(games, allowsJoin = scene.mode == LongShotMode.classic)
        }
        PromptAnnouncement(games, scene.announcementKey, longShotAnnouncement(scene))
    }
}

@Composable
private fun LongShotDiveView(board: LongShotDiveBoard, scene: LongShotScene, games: GameStagePresenter) {
    val countdown = games.countdown
    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
        LongShotDepthReadout(board.depth, board.gain)
        Spacer(Modifier.weight(1f))
        if (countdown != null) GameKitCountdown(countdown)
    }
    GameKitPrompt(
        kicker = longShotPromptKicker(board.prompt, LongShotMode.classic, 0),
        title = board.prompt.text,
        subtitle = if (board.isReady || board.totalPlayers <= 0) "" else conclaveString("gm_ls_locked_count", board.lockedCount, board.totalPlayers),
    )
    val landing = board.landing
    val miss = board.miss
    if (landing != null) {
        LongShotLockedRow(landing)
    } else if (scene.entry.isShown) {
        LongShotEntry(scene.entry, games, miss?.atMillis ?: 0.0)
        if (miss != null) LongShotNoteLine(longShotMiss(miss), Icons.Rounded.HighlightOff)
    }
    LongShotLadder(board.rungs, board.landedIndex)
}

@Composable
private fun LongShotDepthReadout(depth: Int, gain: Int) {
    val scheme = MaterialTheme.colorScheme
    Column(Modifier.testTag("game.longShot.depth").semantics(mergeDescendants = true) {}, verticalArrangement = Arrangement.spacedBy(2.dp)) {
        Text(conclaveString("gm_ls_depth"), style = MaterialTheme.typography.labelLarge, color = scheme.onSurfaceVariant)
        Row(verticalAlignment = Alignment.Bottom, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Text(longShotMeters(depth), style = rememberTabular(MaterialTheme.typography.headlineSmall), color = scheme.onSurface)
            if (gain > 0) {
                Text(longShotGain(gain), style = rememberTabular(MaterialTheme.typography.titleSmall), color = scheme.primary,
                    modifier = Modifier.padding(bottom = 2.dp))
            }
        }
    }
}

@Composable
private fun LongShotEntry(entry: LongShotEntryModel, games: GameStagePresenter, missKey: Double) {
    val interaction = games.interaction
    val pending = interaction.isPending && interaction.pendingType == LongShotIntent.answerType
    val reduceMotion = rememberReduceMotion()
    val shake = remember { Animatable(0f) }
    var seenMiss by remember { mutableStateOf(missKey) }
    var showsChecking by remember { mutableStateOf(false) }
    LaunchedEffect(missKey) {
        val shakes = LongShotShakePolicy.shakes(previousMissAt = seenMiss, nextMissAt = missKey)
        seenMiss = missKey
        if (!shakes || reduceMotion) {
            shake.snapTo(0f)
            return@LaunchedEffect
        }
        shake.animateTo(-6f, tween(70))
        shake.animateTo(5f, tween(80))
        shake.animateTo(-2f, tween(70))
        shake.animateTo(0f, tween(80))
    }
    LaunchedEffect(pending) {
        showsChecking = false
        if (!pending) return@LaunchedEffect
        delay(350)
        showsChecking = true
    }
    val density = LocalDensity.current
    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Box(Modifier.offset { IntOffset(with(density) { shake.value.dp.roundToPx() }, 0) }) {
            GameKitTextEntry(
                label = conclaveString("gm_ls_answer"),
                placeholder = conclaveString(if (entry.hint == LongShotEntryHint.getReady) "gm_ls_get_ready" else "gm_ls_type_answer"),
                maxLength = LongShotSceneBuilder.maxAnswerLength,
                text = games.longShotDraft,
                onTextChange = { games.setLongShotDraft(it) },
                submitTitle = conclaveString(if (entry.action == LongShotEntryAction.pass) "gm_ls_pass" else "gm_ls_dive"),
                isPending = pending,
                enabled = entry.canSubmit && (!interaction.isPending || pending),
                onSubmit = { games.submitLongShot() },
            )
        }
        if (showsChecking) GameKitWaitingLine(conclaveString("gm_ls_checking"), modifier = Modifier.testTag("game.longShot.checking"))
    }
}

@Composable
private fun LongShotLockedRow(landing: LongShotLanding) {
    val scheme = MaterialTheme.colorScheme
    val ext = LocalConclaveExtendedColors.current
    Surface(
        shape = RoundedCornerShape(12.dp),
        color = scheme.surfaceContainerHigh,
        border = BorderStroke(1.dp, ext.border),
        modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp).testTag("game.longShot.locked").semantics(mergeDescendants = true) {},
    ) {
        Row(Modifier.padding(horizontal = 12.dp, vertical = 12.dp), verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Icon(ConclaveIcons.LockFill1, contentDescription = null, tint = scheme.onSurfaceVariant, modifier = Modifier.size(18.dp))
            Text(landing.text, style = MaterialTheme.typography.bodyLarge, fontWeight = FontWeight.SemiBold, color = scheme.onSurface,
                maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
            Text(conclaveString("gm_ls_locked_in"), style = MaterialTheme.typography.labelLarge, color = scheme.onSurfaceVariant)
        }
    }
}

@Composable
private fun LongShotNoteLine(text: String, icon: ImageVector) {
    val scheme = MaterialTheme.colorScheme
    Row(Modifier.padding(start = 12.dp).testTag("game.longShot.note").semantics(mergeDescendants = true) {},
        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
        Icon(icon, contentDescription = null, tint = scheme.onSurfaceVariant, modifier = Modifier.size(16.dp))
        Text(text, style = MaterialTheme.typography.labelLarge, color = scheme.onSurfaceVariant)
    }
}

@Composable
private fun LongShotLadder(rungs: skip.lib.Array<LongShotRungModel>, landedIndex: Int) {
    val reduceMotion = rememberReduceMotion()
    var marker by remember { mutableIntStateOf(landedIndex) }
    LaunchedEffect(landedIndex) {
        if (landedIndex < 0) {
            marker = -1
            return@LaunchedEffect
        }
        if (marker == landedIndex) return@LaunchedEffect
        if (reduceMotion) {
            marker = landedIndex
            return@LaunchedEffect
        }
        for (step in 0..landedIndex) {
            marker = step
            delay(LONG_SHOT_STEP_MILLIS)
        }
    }
    Column(Modifier.fillMaxWidth().testTag("game.longShot.ladder"), verticalArrangement = Arrangement.spacedBy(4.dp)) {
        var index = 0
        for (rung in rungs) {
            LongShotRungRow(
                rung = rung,
                marked = index == marker,
                passed = marker >= 0 && index < marker && marker < landedIndex,
                dimmed = marker == landedIndex && landedIndex >= 0 && index != landedIndex,
            )
            index += 1
        }
    }
}

@Composable
private fun LongShotRungRow(rung: LongShotRungModel, marked: Boolean, passed: Boolean, dimmed: Boolean) {
    val scheme = MaterialTheme.colorScheme
    val ext = LocalConclaveExtendedColors.current
    val landed = rung.isLanded && marked
    val fill by animateColorAsState(if (passed) scheme.surfaceContainerHighest else scheme.surfaceContainerHigh, tween(140), label = "rung")
    val shape = RoundedCornerShape(8.dp)
    val label = longShotRungLabel(rung)
    Row(
        Modifier.fillMaxWidth().heightIn(min = 40.dp).alpha(if (dimmed) 0.5f else 1f).background(fill, shape)
            .border(1.dp, if (landed) scheme.primaryContainer else ext.border, shape).padding(horizontal = 12.dp)
            .clearAndSetSemantics {
                contentDescription = label
                selected = rung.isLanded
            },
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Box(Modifier.size(8.dp).background(if (marked) scheme.primaryContainer else Color.Transparent, CircleShape))
        Text(longShotTier(rung.tier), style = MaterialTheme.typography.titleSmall, color = scheme.onSurface)
        if (landed && rung.word.isNotEmpty()) {
            Text(rung.word, style = MaterialTheme.typography.labelLarge, color = scheme.onSurface, maxLines = 1, overflow = TextOverflow.Ellipsis,
                modifier = Modifier.weight(1f, fill = false).background(scheme.surfaceContainerHighest, CircleShape)
                    .padding(horizontal = 8.dp, vertical = 2.dp))
        }
        Spacer(Modifier.weight(1f))
        Text(longShotMeters(rung.points), style = rememberTabular(MaterialTheme.typography.bodyMedium),
            color = if (landed) scheme.primary else scheme.onSurfaceVariant)
    }
}

@Composable
private fun LongShotRevealView(board: LongShotRevealBoard) {
    LongShotDepthReadout(board.depth, board.gain)
    GameKitPrompt(kicker = longShotPromptKicker(board.prompt, LongShotMode.classic, 0), title = board.prompt.text)
    LongShotRows {
        for (row in board.rows) {
            val landing = row.landing
            LongShotAnswerRow(
                answer = landing?.text ?: conclaveString("gm_ls_no_answer"),
                missing = landing == null,
                name = longShotName(row.name, row.isYou),
                judged = landing?.isJudged ?: false,
                trailing = if (landing != null) longShotGain(landing.points) else longShotMeters(0),
                highlighted = landing?.tier == LongShotTier.pearl,
            )
        }
    }
    val pearl = board.pearl
    if (pearl != null) {
        LongShotFactLine(longShotTier(LongShotTier.pearl), pearl.answer,
            if (pearl.foundBy.count > 0) conclaveString("gm_ls_found_by", pearl.foundBy.joinToString(", ")) else "")
    }
    if (board.missedGems.count > 0) LongShotFactLine(conclaveString("gm_ls_missed"), board.missedGems.joinToString(", "), "")
}

@Composable
private fun LongShotRows(content: @Composable () -> Unit) {
    val scheme = MaterialTheme.colorScheme
    val ext = LocalConclaveExtendedColors.current
    Surface(shape = RoundedCornerShape(12.dp), color = scheme.surfaceContainerHigh, border = BorderStroke(1.dp, ext.border),
        modifier = Modifier.fillMaxWidth()) {
        Column { content() }
    }
}

@Composable
private fun LongShotAnswerRow(answer: String, missing: Boolean = false, name: String, judged: Boolean, trailing: String, highlighted: Boolean) {
    val scheme = MaterialTheme.colorScheme
    val ext = LocalConclaveExtendedColors.current
    val owner = if (judged) conclaveString("act_two_facts", name, conclaveString("gm_ls_judged")) else name
    Column(Modifier.fillMaxWidth().semantics(mergeDescendants = true) {}) {
        Row(Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 10.dp), verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Text(answer, style = MaterialTheme.typography.bodyLarge, fontWeight = FontWeight.SemiBold,
                    color = if (missing) scheme.onSurfaceVariant else scheme.onSurface, maxLines = 2, overflow = TextOverflow.Ellipsis)
                Text(owner, style = MaterialTheme.typography.bodySmall, color = scheme.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
            Text(trailing, style = rememberTabular(MaterialTheme.typography.titleSmall), color = if (highlighted) scheme.primary else scheme.onSurface)
        }
        HorizontalDivider(Modifier.padding(start = 12.dp), color = ext.border)
    }
}

@Composable
private fun LongShotFactLine(label: String, value: String, detail: String) {
    val scheme = MaterialTheme.colorScheme
    Column(Modifier.fillMaxWidth().semantics(mergeDescendants = true) {}, verticalArrangement = Arrangement.spacedBy(2.dp)) {
        Text(label, style = MaterialTheme.typography.labelLarge, color = scheme.onSurfaceVariant)
        Text(value, style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.SemiBold, color = scheme.onSurface)
        if (detail.isNotEmpty()) Text(detail, style = MaterialTheme.typography.bodySmall, color = scheme.onSurfaceVariant)
    }
}

@Composable
private fun LongShotFuseView(board: LongShotFuseBoard, scene: LongShotScene, games: GameStagePresenter) {
    val scheme = MaterialTheme.colorScheme
    LongShotSeats(board.seats)
    GameKitPrompt(kicker = longShotPromptKicker(board.prompt, LongShotMode.fuse, board.foundCount), title = board.prompt.text)
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text(longShotStatus(board), style = MaterialTheme.typography.titleMedium,
            color = if (board.status == LongShotFuseStatus.yourTurn) scheme.primary else scheme.onSurface,
            modifier = Modifier.testTag("game.longShot.status"))
        if (board.showsMeter) {
            Column(Modifier.semantics(mergeDescendants = true) {}, verticalArrangement = Arrangement.spacedBy(4.dp)) {
                Text(conclaveString("gm_ls_next_heart"), style = MaterialTheme.typography.bodySmall, color = scheme.onSurfaceVariant)
                LinearProgressIndicator(progress = { board.meterFraction.toFloat() }, modifier = Modifier.fillMaxWidth(),
                    color = scheme.primaryContainer, trackColor = scheme.surfaceContainerHighest)
            }
        }
    }
    val missLine = board.note.missLine
    val heartLine = board.note.heartLine
    if (scene.entry.isShown) {
        LongShotEntry(scene.entry, games, if (missLine != null && missLine.isYou) missLine.miss.atMillis else 0.0)
    }
    if (missLine != null) {
        LongShotNoteLine(conclaveString("gm_ls_miss_by", longShotName(missLine.name, missLine.isYou), longShotMiss(missLine.miss)),
            Icons.Rounded.HighlightOff)
    } else if (heartLine != null) {
        LongShotNoteLine(if (heartLine.isYou) conclaveString("gm_ls_you_heart") else conclaveString("gm_ls_heart", heartLine.name),
            Icons.Rounded.Favorite)
    }
    if (board.chain.count > 0) {
        LongShotRows {
            for (row in board.chain) {
                LongShotAnswerRow(answer = row.landing.text, name = longShotName(row.name, row.isYou), judged = row.landing.isJudged,
                    trailing = longShotTier(row.landing.tier), highlighted = row.landing.tier == LongShotTier.pearl)
            }
        }
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun LongShotSeats(seats: skip.lib.Array<LongShotSeatModel>) {
    val scheme = MaterialTheme.colorScheme
    val ext = LocalConclaveExtendedColors.current
    FlowRow(Modifier.testTag("game.longShot.seats"), horizontalArrangement = Arrangement.spacedBy(6.dp),
        verticalArrangement = Arrangement.spacedBy(6.dp)) {
        for (seat in seats) {
            val label = longShotSeatLabel(seat)
            val ink = if (seat.isOut) scheme.onSurfaceVariant else scheme.onSurface
            Row(
                Modifier.heightIn(min = 28.dp).alpha(if (seat.isOut) 0.6f else 1f).background(scheme.surfaceContainerHigh, CircleShape)
                    .border(1.dp, if (seat.isHolding || seat.isPopped) scheme.primaryContainer else ext.border, CircleShape)
                    .padding(horizontal = 10.dp).clearAndSetSemantics { contentDescription = label },
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(4.dp),
            ) {
                Text(longShotName(seat.name, seat.isYou), style = MaterialTheme.typography.labelLarge, color = ink, maxLines = 1,
                    textDecoration = if (seat.isOut) TextDecoration.LineThrough else null)
                if (!seat.isOut) {
                    Icon(Icons.Rounded.Favorite, contentDescription = null, tint = ink, modifier = Modifier.size(12.dp))
                    Text(seat.hearts.toString(), style = rememberTabular(MaterialTheme.typography.labelLarge), color = ink)
                }
            }
        }
    }
}

@Composable
private fun LongShotPopView(board: LongShotPopBoard) {
    val scheme = MaterialTheme.colorScheme
    Column(Modifier.fillMaxWidth().padding(vertical = 24.dp).semantics(mergeDescendants = true) {},
        horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Text(conclaveString("gm_ls_out_of_air"), style = MaterialTheme.typography.headlineSmall, color = scheme.onSurface,
            modifier = Modifier.semantics { heading() })
        Text(longShotPopped(board), style = MaterialTheme.typography.bodyMedium, color = scheme.onSurfaceVariant, textAlign = TextAlign.Center)
    }
    LongShotSeats(board.seats)
}

@Composable
private fun LongShotResultsView(board: LongShotResultsBoard) {
    val scheme = MaterialTheme.colorScheme
    Column(Modifier.fillMaxWidth().padding(top = 8.dp).testTag("game.longShot.result").semantics(mergeDescendants = true) {},
        horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Text(longShotResultTitle(board), style = MaterialTheme.typography.headlineSmall, color = scheme.onSurface, textAlign = TextAlign.Center,
            modifier = Modifier.semantics { heading() })
        val winner = board.winner
        if (winner != null) {
            Text(longShotMeters(winner.depth), style = rememberTabular(MaterialTheme.typography.bodyMedium), color = scheme.onSurfaceVariant)
        }
        val band = board.band
        if (band != null) {
            Text(conclaveString("gm_ls_your_dive", longShotBand(band)), style = MaterialTheme.typography.titleSmall, color = scheme.primary,
                modifier = Modifier.padding(top = 4.dp))
        }
    }
    Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
        for (standing in board.standings) LongShotStandingRow(standing)
    }
    if (board.best.count > 0) {
        Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text(conclaveString("gm_ls_deepest"), style = MaterialTheme.typography.labelLarge, color = scheme.onSurfaceVariant)
            LongShotRows {
                for (row in board.best) {
                    LongShotAnswerRow(answer = row.landing.text, name = longShotName(row.name, row.isYou), judged = row.landing.isJudged,
                        trailing = longShotTier(row.landing.tier), highlighted = row.landing.tier == LongShotTier.pearl)
                }
            }
        }
    }
}

@Composable
private fun LongShotStandingRow(standing: LongShotStandingModel) {
    val scheme = MaterialTheme.colorScheme
    Column(Modifier.fillMaxWidth().semantics(mergeDescendants = true) {}, verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            Text(longShotName(standing.name, standing.isYou), style = MaterialTheme.typography.bodyMedium,
                fontWeight = if (standing.isYou) FontWeight.SemiBold else FontWeight.Normal, color = scheme.onSurface, maxLines = 1,
                overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
            Text(longShotMeters(standing.depth), style = rememberTabular(MaterialTheme.typography.titleSmall), color = scheme.onSurface)
        }
        Box(Modifier.fillMaxWidth().heightIn(min = 6.dp).background(scheme.surfaceContainerHigh, CircleShape)) {
            Box(Modifier.fillMaxWidth(maxOf(0.02f, standing.fraction.toFloat())).heightIn(min = 6.dp)
                .background(if (standing.isWinner) scheme.primaryContainer else scheme.surfaceContainerHighest, CircleShape))
        }
    }
}

internal fun longShotNumber(value: Int): String = NumberFormat.getIntegerInstance().format(value)

@Composable
private fun longShotMeters(value: Int): String = conclaveString("gm_ls_meters", longShotNumber(value))

@Composable
private fun longShotGain(value: Int): String = conclaveString("gm_ls_gain", longShotNumber(value))

internal fun longShotTierResource(tier: LongShotTier): String = when (tier) {
    LongShotTier.obvious -> "gm_ls_tier_obvious"
    LongShotTier.cliche -> "gm_ls_tier_cliche"
    LongShotTier.solid -> "gm_ls_tier_solid"
    LongShotTier.rare -> "gm_ls_tier_rare"
    LongShotTier.longShot -> "gm_ls_tier_long_shot"
    LongShotTier.pearl -> "gm_ls_tier_pearl"
}

@Composable
private fun longShotTier(tier: LongShotTier): String = conclaveString(longShotTierResource(tier))

internal fun longShotBandResource(band: LongShotDepthBand): String = when (band) {
    LongShotDepthBand.shallows -> "gm_ls_band_shallows"
    LongShotDepthBand.twilight -> "gm_ls_band_twilight"
    LongShotDepthBand.midnight -> "gm_ls_band_midnight"
    LongShotDepthBand.abyss -> "gm_ls_band_abyss"
    LongShotDepthBand.trench -> "gm_ls_band_trench"
}

@Composable
private fun longShotBand(band: LongShotDepthBand): String = conclaveString(longShotBandResource(band))

@Composable
private fun longShotName(name: String, isYou: Boolean): String = if (isYou) conclaveString("ds_you") else name

@Composable
private fun longShotPromptKicker(prompt: LongShotPromptCard, mode: LongShotMode, foundCount: Int): String {
    val meta = if (mode == LongShotMode.fuse) {
        if (foundCount > 0) conclaveString("gm_ls_found", foundCount) else ""
    } else {
        conclaveString("gm_ls_prompt_count", prompt.number, prompt.total)
    }
    if (meta.isEmpty()) return prompt.category
    if (prompt.category.isEmpty()) return meta
    return conclaveString("act_two_facts", prompt.category, meta)
}

@Composable
private fun longShotMiss(miss: LongShotMissedAnswer): String =
    if (miss.reason == LongShotMissReason.taken && miss.text.isNotEmpty()) conclaveString("gm_ls_taken", miss.text)
    else conclaveString("gm_ls_not_listed")

@Composable
private fun longShotStatus(board: LongShotFuseBoard): String = when (board.status) {
    LongShotFuseStatus.yourTurn -> conclaveString("gm_ls_your_turn")
    LongShotFuseStatus.theirTurn -> conclaveString("gm_ls_turn", board.holderName)
    LongShotFuseStatus.paused, LongShotFuseStatus.nobody -> conclaveString("gm_ls_waiting_players")
}

@Composable
private fun longShotPopped(board: LongShotPopBoard): String = when {
    board.isYou && board.isEliminated -> conclaveString("gm_ls_you_out")
    board.isYou -> conclaveString("gm_ls_you_lost_heart")
    board.isEliminated -> conclaveString("gm_ls_out", board.name)
    else -> conclaveString("gm_ls_lost_heart", board.name)
}

@Composable
private fun longShotResultTitle(board: LongShotResultsBoard): String {
    val winner = board.winner
    if (winner != null) return if (winner.isYou) conclaveString("gm_ls_you_win") else conclaveString("gm_ls_wins", winner.name)
    return if (board.isTie) conclaveString("gm_ls_tie") else conclaveString("gm_ls_everyone_surfaced")
}

@Composable
private fun longShotRungLabel(rung: LongShotRungModel): String {
    val base = conclaveString("act_two_facts", longShotTier(rung.tier), longShotMeters(rung.points))
    return if (rung.isLanded) conclaveString("gm_ls_your_answer", base, rung.word) else base
}

@Composable
private fun longShotSeatLabel(seat: LongShotSeatModel): String {
    val name = longShotName(seat.name, seat.isYou)
    if (seat.isOut) return conclaveString("act_two_facts", name, conclaveString("gm_ls_surfaced"))
    return conclaveString("act_two_facts", name, conclaveString("gm_ls_hearts", seat.hearts))
}

@Composable
private fun longShotAnnouncement(scene: LongShotScene): String {
    val dive = scene.board.dive
    val fuse = scene.board.fuse
    val pop = scene.board.popped
    return when {
        dive != null -> {
            val landing = dive.landing ?: return ""
            conclaveString("gm_ls_landed", landing.text, conclaveString("act_two_facts", longShotTier(landing.tier), longShotMeters(landing.points)))
        }
        fuse != null -> if (fuse.status == LongShotFuseStatus.yourTurn) conclaveString("gm_ls_your_turn") else ""
        pop != null -> conclaveString("act_two_facts", conclaveString("gm_ls_out_of_air"), longShotPopped(pop))
        else -> ""
    }
}
