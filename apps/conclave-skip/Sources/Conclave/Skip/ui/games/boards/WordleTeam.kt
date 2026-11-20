package conclave.module

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableDoubleStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.repeatOnLifecycle
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive

internal val WordleRowLabelWidth = 56.dp
internal val WordleRowLabelGap = 6.dp

@Composable
internal fun WordleTeamBanner(scene: WordleScene, team: WordleTeamScene, games: GameStagePresenter, showsHint: Boolean) {
    val scheme = MaterialTheme.colorScheme
    val ext = LocalConclaveExtendedColors.current
    val mine = team.turn == WordleTurn.yours
    val clocks = WordleClockPolicy.plan(roundDeadlineMillis = games.countdown?.deadlineMillis ?: 0.0,
        turnDeadlineMillis = if (team.isTurnTimed) team.turnDeadlineMillis else 0.0)
    val title = wordleTeamTitle(scene, team)
    val detail = wordleTeamDetailResource(scene, team)
    val hint = if (showsHint && detail != null && detail != WordleUpNextResource) conclaveString(detail) else ""
    Box {
        Surface(
            shape = MaterialTheme.shapes.medium,
            color = scheme.surfaceContainerHigh,
            border = BorderStroke(1.dp, if (mine) scheme.primary else ext.border),
            modifier = Modifier.fillMaxWidth().testTag("game.wordle.team.banner"),
        ) {
            Row(
                Modifier.padding(horizontal = 12.dp, vertical = 10.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                Column(
                    Modifier.weight(1f).semantics(mergeDescendants = true) { heading() },
                    verticalArrangement = Arrangement.spacedBy(2.dp),
                ) {
                    Text(title, style = MaterialTheme.typography.titleMedium, color = scheme.onSurface, maxLines = if (showsHint) 2 else 1,
                        overflow = TextOverflow.Ellipsis)
                    WordleTeamMetaLine(scene, team, upNext = detail == WordleUpNextResource,
                        countdown = if (clocks.showsRoundInMeta) games.countdown else null)
                    if (hint.isNotEmpty()) Text(hint, style = MaterialTheme.typography.bodySmall, color = scheme.onSurfaceVariant)
                }
                when (clocks.chip) {
                    WordleClock.turn -> WordleTurnTimerSlot(team, games)
                    WordleClock.round -> WordleTimerSlot(games)
                    else -> {}
                }
                if (team.canPass) WordlePassButton(games)
            }
        }
        PromptAnnouncement(games, team.turnKey, conclaveString("gm_wordle_team_your_turn"), assertive = true)
    }
}

private const val WordleUpNextResource = "gm_wordle_team_up_next"

@Composable
private fun WordleTeamMetaLine(scene: WordleScene, team: WordleTeamScene, upNext: Boolean, countdown: CountdownModel?) {
    val scheme = MaterialTheme.colorScheme
    var nowMillis by remember(countdown) { mutableDoubleStateOf(System.currentTimeMillis().toDouble()) }
    if (countdown != null) {
        val lifecycle = LocalLifecycleOwner.current.lifecycle
        LaunchedEffect(countdown, lifecycle) {
            lifecycle.repeatOnLifecycle(Lifecycle.State.STARTED) {
                while (isActive) {
                    nowMillis = System.currentTimeMillis().toDouble()
                    if (countdown.secondsLeft(nowMillis = nowMillis) == 0) break
                    delay(1000L)
                }
            }
        }
    }
    val meta = wordleTeamMeta(scene, team)
    val status = if (upNext) conclaveString("act_two_facts", conclaveString(WordleUpNextResource), meta) else meta
    val seconds = countdown?.secondsLeft(nowMillis = nowMillis)
    val text = if (seconds == null) status else conclaveString("act_two_facts", status, conclaveString("gm_wordle_time_left", wordleClock(seconds)))
    val spoken = if (seconds == null) status
        else conclaveString("act_two_facts", status, conclaveString("gm_wordle_time_left", wordleSpokenDuration(seconds)))
    Text(text, style = rememberTabular(MaterialTheme.typography.bodySmall), color = scheme.onSurfaceVariant, maxLines = 1,
        overflow = TextOverflow.Ellipsis, modifier = Modifier.testTag("game.wordle.team.meta").semantics { contentDescription = spoken })
}

@Composable
private fun WordlePassButton(games: GameStagePresenter) {
    val interaction = games.interaction
    val pending = interaction.isPending && interaction.pendingType == WordleIntent.passTurnType
    val inProgress = conclaveString("ds_in_progress")
    OutlinedButton(
        onClick = { games.passWordleTurn() },
        enabled = !interaction.isPending,
        modifier = Modifier.heightIn(min = 48.dp).semantics { if (pending) stateDescription = inProgress }.testTag("game.wordle.pass"),
    ) {
        Box(contentAlignment = Alignment.Center) {
            Text(conclaveString("gm_wordle_team_pass"), modifier = Modifier.alpha(if (pending) 0f else 1f))
            if (pending) CircularProgressIndicator(Modifier.size(18.dp), color = MaterialTheme.colorScheme.onSurface, strokeWidth = 2.dp)
        }
    }
}

@Composable
private fun WordleTurnTimerSlot(team: WordleTeamScene, games: GameStagePresenter) {
    val model = team.turnCountdown(serverOffsetMillis = games.countdown?.serverOffsetMillis ?: 0.0) ?: return
    WordleTurnTimerChip(model, team.turn == WordleTurn.yours)
}

@Composable
private fun WordleTurnTimerChip(model: CountdownModel, isMine: Boolean) {
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
    val spoken = conclaveString("gm_wordle_team_turn_left", wordleSpokenDuration(seconds))
    val announcedText = if (isMine && CountdownModel.announcedSeconds.contains(seconds)) spoken else ""
    LaunchedEffect(announcedText) {
        if (announcedText.isNotEmpty()) announcement = announcedText
    }
    Box {
        GameKitTimerCapsule(wordleClock(seconds), seconds <= CountdownModel.warningSeconds,
            Modifier.testTag("game.wordle.turnTimer").clearAndSetSemantics { contentDescription = spoken })
        Box(Modifier.size(1.dp).semantics {
            liveRegion = LiveRegionMode.Polite
            contentDescription = announcement
        })
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
internal fun WordleTeamMembers(team: WordleTeamScene) {
    val you = conclaveString("ds_you")
    FlowRow(
        Modifier.fillMaxWidth().testTag("game.wordle.team.members"),
        horizontalArrangement = Arrangement.spacedBy(6.dp),
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        for (member in team.members) WordleTeamMemberChip(member, team.showsSeats, if (member.isYou) you else member.name)
    }
}

@Composable
private fun WordleTeamMemberChip(member: WordleTeamMemberModel, showsSeat: Boolean, name: String) {
    val scheme = MaterialTheme.colorScheme
    val ext = LocalConclaveExtendedColors.current
    val resource = wordleTeamMemberResource(member)
    val label = if (resource == null) name else conclaveString(resource, name)
    Surface(
        shape = CircleShape,
        color = Color.Transparent,
        border = BorderStroke(1.dp, if (member.isGuessing) scheme.primary else ext.border),
        modifier = Modifier
            .alpha(if (member.isAway) ConclaveDisabledOpacity.android.toFloat() else 1f)
            .clearAndSetSemantics { contentDescription = label }
            .testTag("game.wordle.team.member.${member.id}"),
    ) {
        Row(
            Modifier.heightIn(min = 32.dp).padding(horizontal = 10.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(5.dp),
        ) {
            if (showsSeat) {
                Text(member.seat.toString(), style = rememberTabular(MaterialTheme.typography.labelMedium),
                    color = if (member.isGuessing) scheme.primary else scheme.onSurfaceVariant)
            }
            Text(name, style = MaterialTheme.typography.labelLarge, color = if (member.isGuessing) scheme.onSurface else scheme.onSurfaceVariant,
                fontWeight = if (member.isGuessing) FontWeight.SemiBold else FontWeight.Normal, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
    }
}

internal enum class WordleLabelLayout { balanced, trailing, hidden }

internal fun wordleLabelLayout(availableDp: Float, boardDp: Float): WordleLabelLayout {
    val column = WordleRowLabelWidth.value + WordleRowLabelGap.value
    return when {
        availableDp >= boardDp + 2f * column -> WordleLabelLayout.balanced
        availableDp >= boardDp + column -> WordleLabelLayout.trailing
        else -> WordleLabelLayout.hidden
    }
}

@Composable
internal fun WordleLabeledRow(row: WordleRowModel, label: WordleRowLabel?, layout: WordleLabelLayout,
                              side: Dp = WordleFitPolicy.maximumCell.dp) {
    val summary = wordleTeamRowSummary(row, label)
    if (layout == WordleLabelLayout.hidden) {
        WordleRow(row, summary, side)
        return
    }
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(WordleRowLabelGap)) {
        if (layout == WordleLabelLayout.balanced) Spacer(Modifier.width(WordleRowLabelWidth))
        WordleRow(row, summary, side)
        WordleRowGuesser(label)
    }
}

@Composable
private fun WordleRowGuesser(label: WordleRowLabel?) {
    val scheme = MaterialTheme.colorScheme
    val text = when {
        label == null -> ""
        label.isYou -> conclaveString("ds_you")
        else -> label.name
    }
    val isTurn = label?.isTurn == true
    Text(text, style = MaterialTheme.typography.labelMedium, color = if (isTurn) scheme.primary else scheme.onSurfaceVariant,
        fontWeight = if (isTurn) FontWeight.SemiBold else FontWeight.Normal, maxLines = 1, overflow = TextOverflow.Ellipsis,
        modifier = Modifier.width(WordleRowLabelWidth).clearAndSetSemantics {})
}

@Composable
internal fun WordleTeamResults(scene: WordleScene, team: WordleTeamScene, games: GameStagePresenter) {
    Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
        PromptHeadline(conclaveString(wordleTeamOutcomeResource(team.outcome)), Modifier.testTag("game.wordle.team.outcome"))
        PromptLine(wordleTeamSolvedDetail(team, scene.maxTries))
        if (scene.myRows.count > 0) WordleBoard(scene, games, readOnly = true)
    }
}

internal fun wordleTeamTitleResource(scene: WordleScene, team: WordleTeamScene): String = when {
    scene.role == WordleRole.setter -> "gm_wordle_team_you_set"
    team.turn == WordleTurn.yours -> "gm_wordle_team_your_turn"
    team.turn == WordleTurn.anyone -> "gm_wordle_team_huddle_title"
    team.turn == WordleTurn.teammate && team.guesserName.isEmpty() -> "gm_wordle_team_teammate_guessing"
    team.turn == WordleTurn.teammate -> "gm_wordle_team_guessing"
    else -> "gm_wordle_team_board"
}

internal fun wordleTeamDetailResource(scene: WordleScene, team: WordleTeamScene): String? = when {
    scene.role == WordleRole.setter -> "gm_wordle_team_watch"
    team.turn == WordleTurn.anyone -> "gm_wordle_team_huddle_detail"
    team.turn == WordleTurn.yours -> "gm_wordle_team_your_turn_detail"
    team.turn == WordleTurn.teammate && team.isUpNext -> WordleUpNextResource
    else -> null
}

internal fun wordleTeamMemberResource(member: WordleTeamMemberModel): String? = when {
    member.isAway -> "gm_wordle_team_member_away"
    member.isGuessing -> "gm_wordle_team_member_guessing"
    member.isUpNext -> "gm_wordle_team_member_next"
    else -> null
}

internal fun wordleTeamOutcomeResource(outcome: WordleOutcome): String = when (outcome) {
    WordleOutcome.solved -> "gm_wordle_team_cracked"
    WordleOutcome.outOfTries -> "gm_wordle_out_of_tries"
    WordleOutcome.timedOut -> "gm_wordle_time_ran_out"
    WordleOutcome.none -> "gm_wordle_team_round_complete"
}

internal fun wordleTeamMetaResource(team: WordleTeamScene): String =
    if (team.mode == WordleMode.relay) "gm_wordle_team_meta_relay" else "gm_wordle_team_meta_huddle"

@Composable
private fun wordleTeamTitle(scene: WordleScene, team: WordleTeamScene): String {
    val name = wordleTeamTitleResource(scene, team)
    return if (name == "gm_wordle_team_guessing") conclaveString(name, team.guesserName) else conclaveString(name)
}

@Composable
internal fun wordleTeamMeta(scene: WordleScene, team: WordleTeamScene): String =
    conclaveString(wordleTeamMetaResource(team), team.triesUsed, scene.maxTries)

@Composable
private fun wordleTeamSolvedDetail(team: WordleTeamScene, maxTries: Int): String = when {
    team.outcome != WordleOutcome.solved -> ""
    team.solvedByName.isEmpty() -> conclaveString("gm_wordle_team_solved_in", team.triesUsed, maxTries)
    else -> conclaveString("gm_wordle_team_solved_by", team.triesUsed, maxTries, team.solvedByName)
}

@Composable
private fun wordleTeamRowSummary(row: WordleRowModel, label: WordleRowLabel?): String {
    val summary = wordleRowSummary(row)
    if (label == null || label.isTurn || (label.name.isEmpty() && !label.isYou)) return summary
    return conclaveString("gm_wordle_team_row_by", summary, if (label.isYou) conclaveString("ds_you") else label.name)
}
