package conclave.module

import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
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
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.Abc
import androidx.compose.material.icons.rounded.Bolt
import androidx.compose.material.icons.rounded.GridOn
import androidx.compose.material.icons.rounded.Groups
import androidx.compose.material.icons.rounded.Lightbulb
import androidx.compose.material.icons.rounded.PersonSearch
import androidx.compose.material.icons.rounded.Schedule
import androidx.compose.material.icons.rounded.SwapHoriz
import androidx.compose.material.icons.rounded.TheaterComedy
import androidx.compose.material.icons.rounded.Timeline
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp

internal fun gameGlyphIcon(glyph: GameGlyph): ImageVector = when (glyph) {
    GameGlyph.trivia -> Icons.Rounded.Lightbulb
    GameGlyph.bluff -> Icons.Rounded.TheaterComedy
    GameGlyph.wouldYouRather -> Icons.Rounded.SwapHoriz
    GameGlyph.mostLikelyTo -> Icons.Rounded.Groups
    GameGlyph.reaction -> Icons.Rounded.Bolt
    GameGlyph.imposter -> Icons.Rounded.PersonSearch
    GameGlyph.wordle -> Icons.Rounded.Abc
    GameGlyph.chess -> Icons.Rounded.GridOn
    GameGlyph.zip -> Icons.Rounded.Timeline
    GameGlyph.generic -> ConclaveIcons.SportsEsportsFill0
}

internal fun gameGlyphIcon(gameId: String): ImageVector = gameGlyphIcon(GameGlyphPolicy.glyph(gameId = gameId))

@Composable
internal fun GameKitGlyphTile(gameId: String, side: Dp = 64.dp) {
    val scheme = MaterialTheme.colorScheme
    Box(
        Modifier.size(side).background(scheme.surfaceContainerHigh, RoundedCornerShape(side * 0.28f)).clearAndSetSemantics {},
        contentAlignment = Alignment.Center,
    ) {
        Icon(gameGlyphIcon(gameId), contentDescription = null, tint = scheme.onSurface, modifier = Modifier.size(side * 0.46f))
    }
}

@Composable
internal fun GameKitAvatar(player: GamePlayerModel, size: ConclaveAvatarSize = ConclaveAvatarSize.tile) {
    val ext = LocalConclaveExtendedColors.current
    Box {
        ConclaveAvatar(name = player.name, id = player.id, size = size, modifier = Modifier.alpha(if (player.isPending) 0.45f else 1f))
        if (player.isPending) {
            GameKitAvatarBadge(Icons.Rounded.Schedule, MaterialTheme.colorScheme.surfaceContainerHighest, Modifier.align(Alignment.BottomEnd))
        } else if (player.hasActed) {
            GameKitAvatarBadge(ConclaveIcons.CheckFill0, ext.success, Modifier.align(Alignment.BottomEnd))
        }
    }
}

@Composable
private fun GameKitAvatarBadge(icon: ImageVector, fill: Color, modifier: Modifier) {
    val ext = LocalConclaveExtendedColors.current
    Box(
        modifier.offset(x = 3.dp, y = 3.dp).size(18.dp).background(fill, CircleShape).border(2.dp, ext.tile, CircleShape),
        contentAlignment = Alignment.Center,
    ) {
        Icon(icon, contentDescription = null, tint = MaterialTheme.colorScheme.onSurface, modifier = Modifier.size(11.dp))
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
internal fun GameKitPlayerChips(players: Iterable<GamePlayerModel>, pending: Iterable<GamePlayerModel>, count: Int) {
    val label = activitiesPlayers(count)
    FlowRow(
        Modifier.fillMaxWidth().testTag("game.players").semantics { contentDescription = label },
        horizontalArrangement = Arrangement.spacedBy(8.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        for (player in players) GameKitPlayerCell(player)
        for (player in pending) GameKitPlayerCell(player)
    }
}

@Composable
private fun GameKitPlayerCell(player: GamePlayerModel) {
    val scheme = MaterialTheme.colorScheme
    val name = if (player.isYou) conclaveString("ds_you") else player.name
    val pendingText = conclaveString("gm_next_round_suffix")
    Column(
        Modifier.width(72.dp).semantics(mergeDescendants = true) { if (player.isPending) stateDescription = pendingText },
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        GameKitAvatar(player)
        Text(name, style = MaterialTheme.typography.labelMedium, maxLines = 1, overflow = TextOverflow.Ellipsis,
            color = if (player.isPending) scheme.onSurfaceVariant else scheme.onSurface)
    }
}

@Composable
internal fun GameKitStatusRow(acted: Int, total: Int, countdown: CountdownModel?) {
    val progress = GameKitProgressPolicy.text(acted = acted, total = total)
    if (progress.isEmpty() && countdown == null) return
    val scheme = MaterialTheme.colorScheme
    val ext = LocalConclaveExtendedColors.current
    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
        if (progress.isNotEmpty()) {
            val done = GameKitProgressPolicy.isComplete(acted = acted, total = total)
            val ink = if (done) ext.success else scheme.onSurfaceVariant
            val label = gameProgress(acted, total)
            Row(
                Modifier.heightIn(min = 28.dp).background(scheme.surfaceContainerHigh, CircleShape).padding(horizontal = 10.dp)
                    .testTag("game.progress").clearAndSetSemantics { contentDescription = label },
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(4.dp),
            ) {
                Icon(if (done) ConclaveIcons.CheckCircleFill1 else ConclaveIcons.GroupFill1, contentDescription = null, tint = ink,
                    modifier = Modifier.size(16.dp))
                Text(progress, style = rememberTabular(MaterialTheme.typography.labelLarge), color = ink)
            }
        }
        Spacer(Modifier.weight(1f))
        if (countdown != null) GameKitCountdown(countdown)
    }
}

@Composable
internal fun GameKitSeatChip(seat: SeatState) {
    val scheme = MaterialTheme.colorScheme
    val queued = seat == SeatState.joiningNextRound
    val tag = gameSeatTagResource(seat)
    val label = if (tag != null) conclaveString(tag) else ""
    Row(
        Modifier.heightIn(min = 36.dp).background(scheme.surfaceContainerHigh, CircleShape).padding(horizontal = 12.dp)
            .testTag("game.seat.tag").clearAndSetSemantics { contentDescription = label },
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        Icon(if (queued) Icons.Rounded.Schedule else ConclaveIcons.VisibilityFill0, contentDescription = null,
            tint = scheme.onSurfaceVariant, modifier = Modifier.size(16.dp))
        Text(if (queued) conclaveString("gm_next_round") else conclaveString("gm_watching"), style = MaterialTheme.typography.labelLarge,
            color = scheme.onSurfaceVariant, maxLines = 1)
    }
}

@Composable
internal fun GameKitWaitingBar(text: String) {
    val scheme = MaterialTheme.colorScheme
    Row(
        Modifier.fillMaxWidth().heightIn(min = 50.dp).background(scheme.surfaceContainerHigh, CircleShape).padding(horizontal = 16.dp)
            .testTag("game.bar.waiting").clearAndSetSemantics { contentDescription = text },
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(10.dp, Alignment.CenterHorizontally),
    ) {
        GameKitWaitingDots()
        Text(text, style = MaterialTheme.typography.labelLarge, color = scheme.onSurfaceVariant, maxLines = 1,
            overflow = TextOverflow.Ellipsis)
    }
}

@Composable
private fun GameKitWaitingDots() {
    val scheme = MaterialTheme.colorScheme
    val reduceMotion = rememberReduceMotion()
    val transition = rememberInfiniteTransition(label = "waitingDots")
    val phase by transition.animateFloat(
        initialValue = 0f,
        targetValue = 3f,
        animationSpec = infiniteRepeatable(tween(durationMillis = 1050, easing = LinearEasing)),
        label = "waitingDotsPhase",
    )
    val active = if (reduceMotion) -1 else phase.toInt().coerceIn(0, 2)
    Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
        for (index in 0 until 3) {
            Box(Modifier.size(6.dp).background(if (index == active) scheme.primaryContainer else scheme.onSurfaceVariant.copy(alpha = 0.5f),
                CircleShape))
        }
    }
}

@Composable
internal fun GameKitWatching(canJoin: Boolean, onJoin: () -> Unit, title: String = conclaveString("gm_watching"), isQueued: Boolean = false) {
    val scheme = MaterialTheme.colorScheme
    Surface(
        shape = RoundedCornerShape(12.dp),
        color = scheme.surfaceContainerHigh,
        modifier = Modifier.fillMaxWidth().heightIn(min = 52.dp).testTag("game.notice.spectator"),
    ) {
        Row(Modifier.padding(start = 14.dp, end = 6.dp), verticalAlignment = Alignment.CenterVertically) {
            Icon(if (isQueued) Icons.Rounded.Schedule else ConclaveIcons.VisibilityFill0, contentDescription = null,
                tint = if (isQueued) scheme.primaryContainer else scheme.onSurfaceVariant, modifier = Modifier.size(18.dp))
            Spacer(Modifier.width(6.dp))
            Text(title, style = MaterialTheme.typography.labelLarge, color = if (isQueued) scheme.onSurface else scheme.onSurfaceVariant,
                modifier = Modifier.weight(1f))
            if (canJoin) {
                val label = conclaveString("gm_join_game")
                Button(
                    onClick = onJoin,
                    colors = ButtonDefaults.buttonColors(containerColor = scheme.primaryContainer, contentColor = scheme.onPrimaryContainer),
                    modifier = Modifier.heightIn(min = 40.dp).testTag("game.watching.join").semantics { contentDescription = label },
                ) { Text(conclaveString("gm_join")) }
            }
        }
    }
}

@Composable
internal fun GameKitPodium(rows: Iterable<GameScoreboardRow>) {
    val list = rows.toList()
    val all = skip.lib.Array(list)
    val winner = GameKitPodiumPolicy.winner(all)
    val scheme = MaterialTheme.colorScheme
    val ext = LocalConclaveExtendedColors.current
    Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(16.dp)) {
        if (winner != null) {
            val label = gameScoreRowLabel(winner)
            Column(
                Modifier.fillMaxWidth().testTag("game.podium.winner").clearAndSetSemantics { contentDescription = label; heading() },
                horizontalAlignment = Alignment.CenterHorizontally,
                verticalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                Box {
                    ConclaveAvatar(name = winner.name, id = winner.id, size = ConclaveAvatarSize.lobby)
                    Box(
                        Modifier.align(Alignment.BottomEnd).offset(x = 4.dp, y = 4.dp).size(30.dp).background(scheme.primaryContainer, CircleShape)
                            .border(3.dp, ext.tile, CircleShape),
                        contentAlignment = Alignment.Center,
                    ) {
                        Icon(ConclaveIcons.EmojiEventsFill1, contentDescription = null, tint = scheme.onPrimaryContainer, modifier = Modifier.size(16.dp))
                    }
                }
                Text(if (winner.isYou) conclaveString("ds_you") else winner.name, style = MaterialTheme.typography.titleLarge,
                    color = scheme.onSurface, maxLines = 1, overflow = TextOverflow.Ellipsis)
                Text(gameScore(winner.score), style = rememberTabular(MaterialTheme.typography.titleSmall), color = scheme.onSurfaceVariant)
            }
        }
        GameKitScoreboard(GameKitPodiumPolicy.rest(all))
    }
}

@Composable
internal fun GameKitWaitingLine(text: String, showsSpinner: Boolean = true, modifier: Modifier = Modifier) {
    val scheme = MaterialTheme.colorScheme
    Row(
        modifier.fillMaxWidth().semantics(mergeDescendants = true) {},
        horizontalArrangement = Arrangement.spacedBy(8.dp, Alignment.CenterHorizontally),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (showsSpinner) CircularProgressIndicator(Modifier.size(16.dp), color = scheme.onSurfaceVariant, strokeWidth = 2.dp)
        Text(text, style = MaterialTheme.typography.bodyMedium, color = scheme.onSurfaceVariant)
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
internal fun GameKitOptionPills(options: Iterable<GameOptionSummaryModel>) {
    val scheme = MaterialTheme.colorScheme
    FlowRow(
        Modifier.testTag("game.lobby.options"),
        horizontalArrangement = Arrangement.spacedBy(6.dp, Alignment.CenterHorizontally),
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        for (option in options) {
            Row(
                Modifier.heightIn(min = 26.dp).background(scheme.surfaceContainerHigh, CircleShape).padding(horizontal = 10.dp)
                    .semantics(mergeDescendants = true) {},
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(4.dp),
            ) {
                Text(option.value, style = MaterialTheme.typography.labelLarge, color = scheme.onSurface, maxLines = 1)
                Text(option.label, style = MaterialTheme.typography.labelLarge, color = scheme.onSurfaceVariant, maxLines = 1)
            }
        }
    }
}

@Composable
internal fun GameKitNameStack(voters: Iterable<GameNamedPlayer>) {
    val list = voters.toList()
    val shown = list.take(GameKitNameStackPolicy.visible)
    val extra = GameKitNameStackPolicy.overflow(list.size)
    val label = list.joinToString(", ") { it.name }
    val ext = LocalConclaveExtendedColors.current
    Row(Modifier.clearAndSetSemantics { contentDescription = label }, verticalAlignment = Alignment.CenterVertically) {
        shown.forEachIndexed { index, voter ->
            Box(Modifier.offset(x = (-6 * index).dp).border(2.dp, ext.tile, CircleShape)) {
                ConclaveAvatar(name = voter.name, id = voter.id, size = ConclaveAvatarSize.mention)
            }
        }
        if (extra > 0) {
            Text("+" + extra, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.offset(x = (-6 * shown.size + 10).dp))
        }
    }
}
