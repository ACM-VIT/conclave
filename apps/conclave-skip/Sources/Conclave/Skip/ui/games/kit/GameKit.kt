package conclave.module

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.unit.dp

/*
 * S60 L6-5 (ACT-2) on Android: K1 Prompt, K6 PlayerChips, K7 HostBar, K8 Scoreboard, K9 RoundResults, K12 SeatControl,
 * K13 GameNotice and the shared neutral tag, handwritten Compose Material 3 inside the always-dark activity card
 * (HostingTheme(inCall = true) from the call root). Correctness carries a text or glyph twin, never color alone.
 */

/** K1: kicker, title and subtitle; the title is the scene's heading. */
@Composable
internal fun GameKitPrompt(kicker: String, title: String, subtitle: String = "", modifier: Modifier = Modifier) {
    val scheme = MaterialTheme.colorScheme
    Column(modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        if (kicker.isNotEmpty()) {
            Text(kicker, style = MaterialTheme.typography.labelLarge, color = scheme.onSurfaceVariant)
        }
        if (title.isNotEmpty()) {
            Text(title, style = MaterialTheme.typography.titleLarge, color = scheme.onSurface, maxLines = 5,
                modifier = Modifier.semantics { heading() })
        }
        if (subtitle.isNotEmpty()) {
            Text(subtitle, style = MaterialTheme.typography.bodyMedium, color = scheme.onSurfaceVariant)
        }
    }
}

/** A neutral status tag (C06 shape): surfaceContainerHighest with onSurface text, never coral, never emoji. */
@Composable
internal fun GameKitTag(title: String, modifier: Modifier = Modifier) {
    val ext = LocalConclaveExtendedColors.current
    Surface(
        modifier = modifier,
        shape = CircleShape,
        color = MaterialTheme.colorScheme.surfaceContainerHighest,
        border = BorderStroke(1.dp, ext.border),
    ) {
        Text(title, style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurface,
            modifier = Modifier.padding(horizontal = 8.dp, vertical = 3.dp))
    }
}

/** K12: Join (primaryContainer), or a tag for a queued or watching person; nothing for a seated player. */
@Composable
internal fun GameKitSeatControl(seat: SeatState, onJoin: () -> Unit) {
    val scheme = MaterialTheme.colorScheme
    when (seat) {
        SeatState.canJoin -> {
            val label = conclaveString("gm_join_game")
            Button(
                onClick = onJoin,
                colors = ButtonDefaults.buttonColors(containerColor = scheme.primaryContainer, contentColor = scheme.onPrimaryContainer),
                modifier = Modifier.heightIn(min = 48.dp).testTag("game.seat.join").semantics { contentDescription = label },
            ) { Text(conclaveString("gm_join")) }
        }
        SeatState.joiningNextRound, SeatState.watching -> {
            val name = gameSeatTagResource(seat)
            if (name != null) GameKitTag(conclaveString(name), Modifier.testTag("game.seat.tag"))
        }
        SeatState.player -> {}
    }
}

/**
 * K13: one notice (failure, spectator, private view, unsupported, reconnecting): glyph, optional title, body and an
 * optional button, in a polite live region so it is announced once.
 */
@Composable
internal fun GameKitNotice(kind: GameKitNoticeKind, message: String, buttonTitle: String = "", onButton: (() -> Unit)? = null) {
    val scheme = MaterialTheme.colorScheme
    val ext = LocalConclaveExtendedColors.current
    val titleName = gameNoticeTitleResource(kind)
    val title = if (titleName != null) conclaveString(titleName) else ""
    Surface(
        modifier = Modifier.fillMaxWidth().testTag("game.notice.${kind.rawValue}").semantics { liveRegion = LiveRegionMode.Polite },
        shape = RoundedCornerShape(12.dp),
        color = scheme.surfaceContainerHigh,
        border = BorderStroke(1.dp, ext.border),
    ) {
        Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.Top) {
                when (kind) {
                    GameKitNoticeKind.privateView, GameKitNoticeKind.reconnecting ->
                        CircularProgressIndicator(Modifier.size(18.dp), color = scheme.onSurface, strokeWidth = 2.dp)
                    GameKitNoticeKind.failure -> Icon(ConclaveIcons.WarningFill1, contentDescription = null, tint = ext.warning)
                    GameKitNoticeKind.unsupported -> Icon(ConclaveIcons.ErrorFill1, contentDescription = null, tint = scheme.onSurface)
                    GameKitNoticeKind.spectator, GameKitNoticeKind.info ->
                        Icon(ConclaveIcons.InfoFill0, contentDescription = null, tint = scheme.onSurfaceVariant)
                }
                Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    if (title.isNotEmpty()) Text(title, style = MaterialTheme.typography.titleSmall, color = scheme.onSurface)
                    if (message.isNotEmpty()) Text(message, style = MaterialTheme.typography.bodyMedium, color = scheme.onSurfaceVariant)
                }
            }
            if (onButton != null && buttonTitle.isNotEmpty()) {
                OutlinedButton(onClick = onButton, modifier = Modifier.heightIn(min = 48.dp).testTag("game.notice.action")) {
                    Text(buttonTitle)
                }
            }
        }
    }
}

/** K6: non-clickable chips (24 dp avatar plus name) in a FlowRow with merged semantics; "next round" for queued. */
@OptIn(ExperimentalLayoutApi::class)
@Composable
internal fun GameKitPlayerChips(players: Iterable<GamePlayerModel>, pending: Iterable<GamePlayerModel>, count: Int) {
    val label = activitiesPlayers(count)
    FlowRow(
        Modifier.fillMaxWidth().testTag("game.players").semantics { contentDescription = label },
        horizontalArrangement = Arrangement.spacedBy(8.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        for (player in players) GameKitPlayerChip(player)
        for (player in pending) GameKitPlayerChip(player)
    }
}

@Composable
private fun GameKitPlayerChip(player: GamePlayerModel) {
    val scheme = MaterialTheme.colorScheme
    val ext = LocalConclaveExtendedColors.current
    val name = if (player.isYou) conclaveString("ds_you") else player.name
    Surface(shape = MaterialTheme.shapes.small, color = scheme.surfaceContainerHigh, modifier = Modifier.semantics(mergeDescendants = true) {}) {
        Row(Modifier.padding(horizontal = 8.dp, vertical = 4.dp), verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            ConclaveAvatar(name = player.name, id = player.id, size = ConclaveAvatarSize.mention)
            Text(name, style = MaterialTheme.typography.bodyMedium, maxLines = 1,
                color = if (player.isPending) scheme.onSurfaceVariant else scheme.onSurface)
            if (player.isPending) {
                Text(conclaveString("gm_next_round_suffix"), style = MaterialTheme.typography.labelSmall, color = scheme.onSurfaceVariant)
            } else if (player.hasActed) {
                Icon(ConclaveIcons.CheckFill0, contentDescription = null, tint = ext.success, modifier = Modifier.size(16.dp))
            }
        }
    }
}

/**
 * K7: a secondary (outlined, neutral or error) and a primary (primaryContainer) side by side, stacked vertically when
 * the two do not fit (measured with BoxWithConstraints; font scale 2.0 stacks).
 */
@Composable
internal fun GameKitHostBar(
    primaryTitle: String,
    onPrimary: () -> Unit,
    primaryEnabled: Boolean = true,
    primaryPending: Boolean = false,
    secondaryTitle: String = "",
    secondaryDestructive: Boolean = false,
    onSecondary: (() -> Unit)? = null,
) {
    val scheme = MaterialTheme.colorScheme
    val inProgress = conclaveString("ds_in_progress")
    val primary: @Composable (Modifier) -> Unit = { modifier ->
        Button(
            onClick = onPrimary,
            enabled = primaryEnabled && !primaryPending,
            colors = ButtonDefaults.buttonColors(containerColor = scheme.primaryContainer, contentColor = scheme.onPrimaryContainer),
            modifier = modifier.heightIn(min = 48.dp).testTag("game.bar.primary").semantics { if (primaryPending) stateDescription = inProgress },
        ) {
            if (primaryPending) {
                CircularProgressIndicator(Modifier.size(18.dp), color = scheme.onPrimaryContainer, strokeWidth = 2.dp)
                Spacer(Modifier.size(8.dp))
            }
            Text(primaryTitle)
        }
    }
    val secondary: @Composable (Modifier) -> Unit = { modifier ->
        if (onSecondary != null && secondaryTitle.isNotEmpty()) {
            OutlinedButton(
                onClick = onSecondary,
                colors = ButtonDefaults.outlinedButtonColors(contentColor = if (secondaryDestructive) scheme.error else scheme.onSurface),
                modifier = modifier.heightIn(min = 48.dp).testTag("game.bar.secondary"),
            ) { Text(secondaryTitle) }
        }
    }
    BoxWithConstraints(Modifier.fillMaxWidth()) {
        val stacked = maxWidth < 320.dp || (secondaryTitle.length + primaryTitle.length) > 28
        if (stacked) {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                secondary(Modifier.fillMaxWidth())
                if (primaryTitle.isNotEmpty()) primary(Modifier.fillMaxWidth())
            }
        } else {
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                secondary(Modifier.weight(1f))
                if (primaryTitle.isNotEmpty()) primary(Modifier.weight(1f))
            }
        }
    }
}

/** K8: ranked rows; the leader row on surfaceContainerHighest with a text twin (never coral text on a raised fill). */
@Composable
internal fun GameKitScoreboard(rows: Iterable<GameScoreboardRow>) {
    val scheme = MaterialTheme.colorScheme
    val tabular = rememberTabular(MaterialTheme.typography.bodyLarge)
    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        for (row in rows) {
            val label = gameScoreRowLabel(row)
            Row(
                Modifier.fillMaxWidth()
                    .background(if (row.isLeader) scheme.surfaceContainerHighest else scheme.surfaceContainer, RoundedCornerShape(8.dp))
                    .padding(horizontal = 10.dp, vertical = 6.dp)
                    .testTag("game.score.${row.id}")
                    .semantics(mergeDescendants = true) { contentDescription = label },
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                Text(row.rank.toString(), style = tabular, color = scheme.onSurface, modifier = Modifier.widthIn(min = 22.dp))
                Text(if (row.isYou) conclaveString("ds_you") else row.name, style = MaterialTheme.typography.bodyLarge,
                    color = scheme.onSurface, maxLines = 2, modifier = Modifier.weight(1f))
                if (row.isLeader) {
                    Icon(ConclaveIcons.EmojiEventsFill1, contentDescription = null, tint = scheme.onSurface, modifier = Modifier.size(16.dp))
                    GameKitTag(conclaveString("act_leading"))
                }
                Text(gameScore(row.score), style = tabular, color = scheme.onSurface)
            }
        }
    }
}

/** K9: one ranked round ("312 ms", "too soon", "no tap"); muted rows read onSurfaceVariant. */
@Composable
internal fun GameKitRoundResults(rows: Iterable<GameKitRoundRow>) {
    val scheme = MaterialTheme.colorScheme
    val tabular = rememberTabular(MaterialTheme.typography.bodyLarge)
    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        for (row in rows) {
            val color = if (row.isMuted) scheme.onSurfaceVariant else scheme.onSurface
            Row(
                Modifier.fillMaxWidth()
                    .background(if (row.isWinner) scheme.surfaceContainerHighest else scheme.surfaceContainer, RoundedCornerShape(8.dp))
                    .padding(horizontal = 10.dp, vertical = 6.dp)
                    .semantics(mergeDescendants = true) {},
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                Text(row.rank.toString(), style = tabular, color = color, modifier = Modifier.widthIn(min = 22.dp))
                Text(if (row.isYou) conclaveString("ds_you") else row.name, style = MaterialTheme.typography.bodyLarge, color = color,
                    maxLines = 2, modifier = Modifier.weight(1f))
                Text(row.value, style = tabular, color = color)
            }
        }
    }
}
