package conclave.module

import android.icu.text.MeasureFormat
import android.icu.util.Measure
import android.icu.util.MeasureUnit
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.focusable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.wrapContentSize
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableDoubleStateOf
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.input.key.KeyEventType
import androidx.compose.ui.input.key.isAltPressed
import androidx.compose.ui.input.key.isCtrlPressed
import androidx.compose.ui.input.key.isMetaPressed
import androidx.compose.ui.input.key.key
import androidx.compose.ui.input.key.onPreviewKeyEvent
import androidx.compose.ui.input.key.type
import androidx.compose.ui.input.key.utf16CodePoint
import androidx.compose.ui.platform.LocalLayoutDirection
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.LayoutDirection
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.repeatOnLifecycle
import java.util.Locale
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive

private val WordleKeyHeight = 48.dp

@Composable
internal fun WordleSceneBody(games: GameStagePresenter) {
    val scene = games.scene.wordle ?: return
    WordleSceneView(scene, games, games.chrome.phase == GameChromePhase.results)
}

@Composable
private fun WordleSceneView(scene: WordleScene, games: GameStagePresenter, isFinished: Boolean) {
    Column(Modifier.fillMaxWidth().testTag("game.scene.wordle"), verticalArrangement = Arrangement.spacedBy(14.dp)) {
        WordleHeader(scene, games, isFinished)
        when (scene.phase) {
            WordlePhase.lobby -> {}
            WordlePhase.setWord -> WordleSetWordView(scene, games)
            WordlePhase.playing -> WordlePlayingView(scene, games)
            WordlePhase.results -> WordleResultsView(scene, games, isFinished)
        }
    }
}

@Composable
private fun WordleHeader(scene: WordleScene, games: GameStagePresenter, isFinished: Boolean) {
    val scheme = MaterialTheme.colorScheme
    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.Top, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Text(wordleTitle(scene, isFinished), style = MaterialTheme.typography.titleMedium, color = scheme.onSurface,
                modifier = Modifier.semantics { heading() })
            if (scene.phase == WordlePhase.setWord || scene.phase == WordlePhase.playing) {
                Text(conclaveString("gm_wordle_meta", scene.wordLength, scene.maxTries),
                    style = rememberTabular(MaterialTheme.typography.bodySmall), color = scheme.onSurfaceVariant)
            }
        }
        if (scene.phase == WordlePhase.playing) WordleTimerSlot(games)
    }
}

@Composable
private fun WordleTimerSlot(games: GameStagePresenter) {
    val countdown = games.countdown ?: return
    WordleTimerChip(countdown)
}

@Composable
private fun WordleTimerChip(model: CountdownModel) {
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
    val warning = seconds <= WordleBoardPolicy.warningSeconds
    val scheme = MaterialTheme.colorScheme
    val ext = LocalConclaveExtendedColors.current
    val clock = wordleClock(seconds)
    val spoken = conclaveString("gm_wordle_time_left", wordleSpokenDuration(seconds))
    val shown = if (warning) conclaveString("gm_wordle_time_left", clock) else clock
    val announcedText = if (WordleBoardPolicy.announcedSeconds.contains(seconds)) spoken else ""
    LaunchedEffect(announcedText) {
        if (announcedText.isNotEmpty()) announcement = announcedText
    }
    Box {
        Surface(
            shape = CircleShape,
            color = scheme.surfaceContainer,
            border = BorderStroke(1.dp, ext.border),
            modifier = Modifier.testTag("game.wordle.timer").clearAndSetSemantics { contentDescription = spoken },
        ) {
            Row(modifier = Modifier.padding(horizontal = 8.dp, vertical = 2.dp),
                horizontalArrangement = Arrangement.spacedBy(4.dp), verticalAlignment = Alignment.CenterVertically) {
                Icon(ConclaveIcons.TimerFill0, contentDescription = null, tint = if (warning) ext.warning else scheme.onSurface,
                    modifier = Modifier.size(16.dp))
                Text(shown, style = rememberTabular(MaterialTheme.typography.labelLarge), color = if (warning) ext.warning else scheme.onSurface)
            }
        }

        Box(Modifier.size(1.dp).semantics {
            liveRegion = LiveRegionMode.Polite
            contentDescription = announcement
        })
    }
}

@Composable
private fun WordleSetWordView(scene: WordleScene, games: GameStagePresenter) {
    Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {

        if (scene.isSetter) {
            PromptLine(conclaveString("gm_wordle_you_pick", scene.wordLength))
            WordleSecretEntry(scene, games)
        } else {
            PromptHeadline(wordleChoosing(scene.setterName), Modifier.testTag("game.wordle.choosing"))
            if (scene.role == WordleRole.spectator) PromptSpectatorNotice(games)
        }
    }
}

@Composable
private fun WordlePlayingView(scene: WordleScene, games: GameStagePresenter) {
    val access = rememberSystemAccessibility()

    var entryMode by rememberSaveable(scene.round) { mutableIntStateOf(0) }
    val textEntry = if (entryMode == 0) access.touchExploration else entryMode == 1
    Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
        when (scene.role) {
            WordleRole.setter -> {
                PromptHeadline(conclaveString("gm_wordle_setter_watching"), Modifier.testTag("game.wordle.setterWatching"))
                WordleLiveBoards(scene)
                WordleStandingsList(scene)
            }
            WordleRole.spectator -> {
                PromptSpectatorNotice(games)
                WordleStandingsList(scene)
            }
            WordleRole.guesser -> {
                WordleBoard(scene, games, readOnly = false)
                WordleOutcomeLine(scene, games)
                if (scene.myOutcome == WordleOutcome.none) {
                    if (textEntry) {
                        WordleTextEntry(scene, games, autoFocus = entryMode == 1)
                        OutlinedButton(onClick = { entryMode = 2 },
                            modifier = Modifier.heightIn(min = 48.dp).testTag("game.wordle.useLetterKeys")) {
                            Text(conclaveString("gm_wordle_use_letter_keys"))
                        }
                    } else {
                        WordleLetterKeyboard(scene, games)
                        OutlinedButton(onClick = { entryMode = 1 },
                            modifier = Modifier.heightIn(min = 48.dp).testTag("game.wordle.typeGuess")) {
                            Icon(ConclaveIcons.KeyboardFill0, contentDescription = null, modifier = Modifier.padding(end = 8.dp).size(18.dp))
                            Text(conclaveString("gm_wordle_type_guess"))
                        }
                    }
                }
                WordleStandingsList(scene)
            }
        }
    }
}

@Composable
private fun WordleResultsView(scene: WordleScene, games: GameStagePresenter, isFinished: Boolean) {
    val isHost = games.chrome.isHost
    val isFinal = isFinished || scene.isFinalRound
    val wordWas = conclaveString("gm_wordle_word_was", scene.solution)
    Column(Modifier.testTag("game.wordle.results"), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        if (scene.solution.isNotEmpty()) {
            val solution = remember(scene) { WordleBoardPolicy.solutionRow(scene) }
            CompositionLocalProvider(LocalLayoutDirection provides LayoutDirection.Ltr) {
                Box(Modifier.fillMaxWidth().testTag("game.wordle.solution"), contentAlignment = Alignment.Center) {
                    WordleRow(solution, wordWas)
                }
            }
        }
        PromptHeadline(wordleWinner(scene))
        WordleOutcomeLine(scene, games)
        if (scene.role == WordleRole.guesser && scene.myRows.count > 0) WordleBoard(scene, games, readOnly = true)
        if (isFinished && scene.roundTotal > 1 && games.results.scoreboard.count > 0) GameKitScoreboard(games.results.scoreboard)
        WordleStandingsList(scene)
        if (!isHost) PromptLine(conclaveString(if (isFinal) "gm_waiting_host" else "gm_wordle_waiting_next"))
        PromptAnnouncement(games, scene.resultKey, wordWas)
    }
}

@Composable
private fun WordleOutcomeLine(scene: WordleScene, games: GameStagePresenter) {
    val name = wordleOutcomeResource(scene.myOutcome) ?: return
    val text = conclaveString(name)
    PromptHeadline(text, Modifier.testTag("game.wordle.outcome"))
    PromptAnnouncement(games, scene.outcomeKey, text)
}

@Composable
internal fun WordleHostBar(games: GameStagePresenter) {
    val scene = games.scene.wordle ?: return
    if (!scene.canAdvanceRound) return
    val interaction = games.interaction
    val pending = interaction.isPending && interaction.pendingType == WordleIntent.nextRoundType
    Box(Modifier.testTag("game.host.nextRound")) {
        GameKitHostBar(
            primaryTitle = conclaveString("gm_next_round"),
            onPrimary = { games.send(WordleIntent.nextRound()) },
            primaryEnabled = !interaction.isPending || pending,
            primaryPending = pending,
        )
    }
}

@Composable
private fun WordleBoard(scene: WordleScene, games: GameStagePresenter, readOnly: Boolean) {
    val draft = if (readOnly) "" else games.wordleDraft
    val rows = remember(scene, draft, readOnly) {
        if (readOnly) scene.myRows.toList() else WordleBoardPolicy.displayRows(scene, draft).toList()
    }
    val guessCount = scene.myRows.count
    var lastCount by remember { mutableIntStateOf(guessCount) }
    var announcement by remember { mutableStateOf("") }
    val newest = if (!readOnly && guessCount > 0) wordleRowSummary(scene.myRows[guessCount - 1]) else ""
    LaunchedEffect(guessCount) {
        if (guessCount > lastCount && newest.isNotEmpty()) announcement = newest
        lastCount = guessCount
    }
    CompositionLocalProvider(LocalLayoutDirection provides LayoutDirection.Ltr) {
        Column(
            Modifier.fillMaxWidth().testTag("game.wordle.board"),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(WordleBoardPolicy.gap.dp),
        ) {
            for (row in rows) WordleRow(row, wordleRowSummary(row))
        }
    }
    Box(Modifier.size(1.dp).semantics {
        liveRegion = LiveRegionMode.Polite
        contentDescription = announcement
    })
}

@Composable
private fun WordleRow(row: WordleRowModel, label: String) {
    Row(
        Modifier.clearAndSetSemantics { contentDescription = label }.testTag("game.wordle.row.${row.index}"),
        horizontalArrangement = Arrangement.spacedBy(WordleBoardPolicy.gap.dp),
    ) {
        for (cell in row.cells) WordleCell(cell)
    }
}

@Composable
private fun WordleCell(cell: WordleCellModel) {
    val colors = wordleCellColors(cell.state)
    val shape = RoundedCornerShape(6.dp)
    Box(
        Modifier.size(WordleBoardPolicy.cellSize.dp).background(colors.fill, shape).border(colors.borderWidth, colors.border, shape),
        contentAlignment = Alignment.Center,
    ) {
        if (cell.letter.isNotEmpty()) {
            Text(cell.letter, style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.Bold, color = colors.ink,
                maxLines = 1, softWrap = false, modifier = Modifier.wrapContentSize(unbounded = true))
        }
        WordleMarkGlyph(cell.state, colors.ink, Modifier.align(Alignment.TopEnd).padding(3.dp))
    }
}

@Composable
private fun WordleMarkGlyph(mark: WordleCellState, ink: Color, modifier: Modifier = Modifier) {
    when (mark) {
        WordleCellState.correct -> Icon(ConclaveIcons.CheckFill0, contentDescription = null, tint = ink, modifier = modifier.size(10.dp))
        WordleCellState.present -> Box(modifier.padding(2.dp).size(5.dp).background(ink, CircleShape))
        WordleCellState.empty, WordleCellState.typed, WordleCellState.absent -> {}
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun WordleLiveBoards(scene: WordleScene) {
    if (scene.liveBoards.count == 0) return
    val scheme = MaterialTheme.colorScheme
    FlowRow(horizontalArrangement = Arrangement.spacedBy(12.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        for (board in scene.liveBoards) {
            val status = wordleStatus(board.status, board.tries)
            val label = promptTwoFacts(board.name, status)
            CompositionLocalProvider(LocalLayoutDirection provides LayoutDirection.Ltr) {
                Column(
                    Modifier.clearAndSetSemantics { contentDescription = label }.testTag("game.wordle.live.${board.id}"),
                    verticalArrangement = Arrangement.spacedBy(4.dp),
                ) {
                    Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
                        for (row in board.rows) {
                            Row(horizontalArrangement = Arrangement.spacedBy(2.dp)) {
                                for (cell in row.cells) {
                                    Box(Modifier.size(10.dp).background(wordleCellColors(cell.state).fill, RoundedCornerShape(2.dp)))
                                }
                            }
                        }
                    }
                    Text(board.name, style = MaterialTheme.typography.labelMedium, color = scheme.onSurface, maxLines = 1)
                    Text(status, style = MaterialTheme.typography.labelSmall, color = scheme.onSurfaceVariant)
                }
            }
        }
    }
}

@Composable
private fun WordleStandingsList(scene: WordleScene) {
    if (scene.standings.count == 0) return
    val scheme = MaterialTheme.colorScheme
    val you = conclaveString("ds_you")
    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Text(conclaveString("gm_wordle_standings"), style = MaterialTheme.typography.labelLarge, color = scheme.onSurfaceVariant,
            modifier = Modifier.semantics { heading() })
        for (row in scene.standings) {
            Row(
                Modifier.fillMaxWidth()
                    .background(if (row.isYou) scheme.surfaceContainerHigh else Color.Transparent, RoundedCornerShape(8.dp))
                    .padding(horizontal = 10.dp, vertical = 6.dp)
                    .semantics(mergeDescendants = true) {}
                    .testTag("game.wordle.standing.${row.id}"),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                Text(if (row.isYou) you else row.name, style = MaterialTheme.typography.bodyLarge, color = scheme.onSurface, maxLines = 2,
                    modifier = Modifier.weight(1f))
                Text(wordleStatus(row.status, row.tries), style = rememberTabular(MaterialTheme.typography.bodyMedium),
                    color = scheme.onSurface)
            }
        }
    }
}

@Composable
private fun WordleLetterKeyboard(scene: WordleScene, games: GameStagePresenter) {
    val interaction = games.interaction
    val draft = games.wordleDraft
    val canType = scene.canGuess && !interaction.isPending
    val pending = interaction.isPending && interaction.pendingType == WordleIntent.guessType
    val canEnter = !interaction.isPending && WordleBoardPolicy.canSubmit(scene, draft)
    val focus = remember { FocusRequester() }
    val submit: () -> Unit = {
        if (!games.interaction.isPending && WordleBoardPolicy.canSubmit(scene, games.wordleDraft)) games.submitWordle()
    }
    val latestCanType by rememberUpdatedState(canType)
    val latestSubmit by rememberUpdatedState(submit)
    val enterLabel = conclaveString("gm_wordle_enter")
    val deleteLabel = conclaveString("gm_wordle_delete")
    CompositionLocalProvider(LocalLayoutDirection provides LayoutDirection.Ltr) {
        BoxWithConstraints(
            Modifier
                .fillMaxWidth()
                .onPreviewKeyEvent { event ->
                    if (event.type != KeyEventType.KeyDown || event.isCtrlPressed || event.isMetaPressed || event.isAltPressed) {
                        false
                    } else if (event.key == Key.Backspace) {
                        if (latestCanType) games.deleteWordleLetter()
                        true
                    } else if (event.key == Key.Enter || event.key == Key.NumPadEnter) {
                        latestSubmit()
                        true
                    } else {
                        val letter = wordleHardwareLetter(event.utf16CodePoint)
                        if (letter.isNotEmpty() && latestCanType) {
                            games.typeWordleLetter(letter)
                            true
                        } else {
                            false
                        }
                    }
                }
                .focusRequester(focus)
                .focusable(enabled = canType)
                .testTag("game.wordle.keyboard"),
        ) {
            val unit = WordleBoardPolicy.keyWidth(maxWidth.value.toDouble())
            val keyWidth = unit.dp
            val wideWidth = (unit * WordleBoardPolicy.wideKeyFactor).dp
            Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                for (rowIndex in 0..1) {
                    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(WordleBoardPolicy.gap.dp, Alignment.CenterHorizontally)) {
                        for (letterKey in scene.keys(rowIndex)) {
                            WordleLetterKey(letterKey, keyWidth, canType) { games.typeWordleLetter(letterKey.letter) }
                        }
                    }
                }
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(WordleBoardPolicy.gap.dp, Alignment.CenterHorizontally)) {
                    WordleWideKey(text = enterLabel, icon = null, label = enterLabel, width = wideWidth, enabled = canEnter, pending = pending,
                        tag = "game.wordle.enter", onTap = submit)
                    for (letterKey in scene.keys(2)) {
                        WordleLetterKey(letterKey, keyWidth, canType) { games.typeWordleLetter(letterKey.letter) }
                    }
                    WordleWideKey(text = "", icon = WordleIcons.backspace, label = deleteLabel, width = wideWidth, enabled = canType,
                        pending = false, tag = "game.wordle.delete", onTap = { games.deleteWordleLetter() })
                }
            }
        }
    }
    LaunchedEffect(canType) {
        if (canType) runCatching { focus.requestFocus() }
    }
}

@Composable
private fun WordleLetterKey(letterKey: WordleKeyModel, width: Dp, enabled: Boolean, onTap: () -> Unit) {
    val colors = wordleKeyColors(letterKey.state)
    val label = wordleKeyLabel(letterKey)
    val shape = RoundedCornerShape(6.dp)
    Box(
        Modifier
            .size(width = width, height = WordleKeyHeight)
            .alpha(if (enabled) 1f else ConclaveDisabledOpacity.android.toFloat())
            .clip(shape)
            .background(colors.fill)
            .border(colors.borderWidth, colors.border, shape)
            .clickable(enabled = enabled, role = Role.Button, onClick = onTap)
            .semantics { contentDescription = label }
            .testTag("game.wordle.key.${letterKey.letter}"),
        contentAlignment = Alignment.Center,
    ) {
        Text(letterKey.letter, style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold, color = colors.ink,
            maxLines = 1, softWrap = false, modifier = Modifier.wrapContentSize(unbounded = true).clearAndSetSemantics {})
        WordleMarkGlyph(wordleKeyMark(letterKey.state), colors.ink, Modifier.align(Alignment.TopEnd).padding(2.dp))
    }
}

@Composable
private fun WordleWideKey(text: String, icon: ImageVector?, label: String, width: Dp, enabled: Boolean, pending: Boolean, tag: String,
                          onTap: () -> Unit) {
    val scheme = MaterialTheme.colorScheme
    val shape = RoundedCornerShape(6.dp)
    val inProgress = conclaveString("ds_in_progress")
    Box(
        Modifier
            .size(width = width, height = WordleKeyHeight)
            .alpha(if (enabled || pending) 1f else ConclaveDisabledOpacity.android.toFloat())
            .clip(shape)
            .background(scheme.surfaceContainerHigh)
            .border(1.dp, scheme.outline, shape)
            .clickable(enabled = enabled && !pending, role = Role.Button, onClick = onTap)
            .semantics {
                contentDescription = label
                if (pending) stateDescription = inProgress
            }
            .testTag(tag),
        contentAlignment = Alignment.Center,
    ) {
        if (pending) {
            CircularProgressIndicator(Modifier.size(18.dp), color = scheme.onSurface, strokeWidth = 2.dp)
        } else if (icon != null) {
            Icon(icon, contentDescription = null, tint = scheme.onSurface, modifier = Modifier.size(20.dp))
        } else {
            Text(text, style = MaterialTheme.typography.labelMedium, color = scheme.onSurface, maxLines = 1, softWrap = false,
                modifier = Modifier.wrapContentSize(unbounded = true).clearAndSetSemantics {})
        }
    }
}

@Composable
private fun WordleTextEntry(scene: WordleScene, games: GameStagePresenter, autoFocus: Boolean) {
    val interaction = games.interaction
    val draft = games.wordleDraft
    val pending = interaction.isPending && interaction.pendingType == WordleIntent.guessType
    val focus = remember { FocusRequester() }
    val submit: () -> Unit = {
        if (!games.interaction.isPending && WordleBoardPolicy.canSubmit(scene, games.wordleDraft)) games.submitWordle()
    }
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        OutlinedTextField(
            value = draft,
            onValueChange = { games.setWordleDraft(it) },
            label = { Text(conclaveString("gm_wordle_field")) },
            enabled = scene.canGuess && !interaction.isPending,
            singleLine = true,
            textStyle = MaterialTheme.typography.titleMedium,
            keyboardOptions = KeyboardOptions(
                capitalization = KeyboardCapitalization.Characters,
                autoCorrectEnabled = false,
                keyboardType = KeyboardType.Ascii,
                imeAction = ImeAction.Go,
            ),
            keyboardActions = KeyboardActions(onGo = { submit() }),
            modifier = Modifier.fillMaxWidth().focusRequester(focus).testTag("game.wordle.field"),
        )
        Box(Modifier.testTag("game.wordle.enterGuess")) {
            GameKitHostBar(
                primaryTitle = conclaveString("gm_wordle_enter_guess"),
                onPrimary = submit,
                primaryEnabled = !interaction.isPending && WordleBoardPolicy.canSubmit(scene, draft),
                primaryPending = pending,
            )
        }
    }
    LaunchedEffect(autoFocus) {
        if (autoFocus && scene.canGuess) runCatching { focus.requestFocus() }
    }
}

@Composable
private fun WordleSecretEntry(scene: WordleScene, games: GameStagePresenter) {
    val interaction = games.interaction
    val draft = games.wordleDraft
    val pending = interaction.isPending && interaction.pendingType == WordleIntent.setWordType
    val submit: () -> Unit = {
        if (!games.interaction.isPending && WordleBoardPolicy.canSubmit(scene, games.wordleDraft)) games.submitWordle()
    }
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        OutlinedTextField(
            value = draft,
            onValueChange = { games.setWordleDraft(it) },
            label = { Text(conclaveString("gm_wordle_secret")) },
            enabled = scene.canSetWord && !interaction.isPending,
            singleLine = true,
            textStyle = MaterialTheme.typography.titleMedium,
            visualTransformation = PasswordVisualTransformation(),
            keyboardOptions = KeyboardOptions(
                capitalization = KeyboardCapitalization.Characters,
                autoCorrectEnabled = false,
                keyboardType = KeyboardType.Password,
                imeAction = ImeAction.Done,
            ),
            keyboardActions = KeyboardActions(onDone = { submit() }),
            modifier = Modifier.fillMaxWidth().testTag("game.wordle.secret"),
        )
        Box(Modifier.testTag("game.wordle.setWord")) {
            GameKitHostBar(
                primaryTitle = conclaveString("gm_wordle_set_word"),
                onPrimary = submit,
                primaryEnabled = !interaction.isPending && WordleBoardPolicy.canSubmit(scene, draft),
                primaryPending = pending,
            )
        }
    }
}

internal object WordleIcons {
    val backspace: ImageVector get() = ConclaveIcons.BackspaceFill0
}

private data class WordleColors(val fill: Color, val ink: Color, val border: Color, val borderWidth: Dp)

@Composable
private fun wordleCellColors(state: WordleCellState): WordleColors {
    val scheme = MaterialTheme.colorScheme
    val ext = LocalConclaveExtendedColors.current
    return when (state) {
        WordleCellState.empty -> WordleColors(Color.Transparent, scheme.onSurface, scheme.outline, 1.dp)
        WordleCellState.typed -> WordleColors(Color.Transparent, scheme.onSurface, scheme.outline, 2.dp)
        WordleCellState.correct -> WordleColors(ext.success, ext.onWarning, ext.success, 1.dp)
        WordleCellState.present -> WordleColors(ext.warning, ext.onWarning, ext.warning, 1.dp)
        WordleCellState.absent -> WordleColors(scheme.surfaceContainerHighest, scheme.onSurface, scheme.surfaceContainerHighest, 1.dp)
    }
}

@Composable
private fun wordleKeyColors(state: WordleKeyState): WordleColors {
    val scheme = MaterialTheme.colorScheme
    val ext = LocalConclaveExtendedColors.current
    return when (state) {
        WordleKeyState.unused -> WordleColors(scheme.surfaceContainerHigh, scheme.onSurface, ext.border, 1.dp)
        WordleKeyState.correct -> wordleCellColors(WordleCellState.correct)
        WordleKeyState.present -> wordleCellColors(WordleCellState.present)
        WordleKeyState.absent -> WordleColors(scheme.surfaceContainerHighest, scheme.onSurfaceVariant, scheme.surfaceContainerHighest, 1.dp)
    }
}

internal fun wordleKeyMark(state: WordleKeyState): WordleCellState = when (state) {
    WordleKeyState.unused -> WordleCellState.empty
    WordleKeyState.correct -> WordleCellState.correct
    WordleKeyState.present -> WordleCellState.present
    WordleKeyState.absent -> WordleCellState.absent
}

internal fun wordleHardwareLetter(codePoint: Int): String =
    if (codePoint in 1..0xFFFF) WordleBoardPolicy.normalized(Char(codePoint).toString(), 1) else ""

internal fun wordleClock(seconds: Int, locale: Locale = Locale.getDefault()): String {
    val value = maxOf(0, seconds)
    return String.format(locale, "%d:%02d", value / 60, value % 60)
}

internal fun wordleSpokenDuration(seconds: Int, locale: Locale = Locale.getDefault()): String {
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

internal fun wordleCellStateResource(state: WordleCellState): String? = when (state) {
    WordleCellState.empty, WordleCellState.typed -> null
    WordleCellState.correct -> "gm_wordle_letter_correct"
    WordleCellState.present -> "gm_wordle_letter_present"
    WordleCellState.absent -> "gm_wordle_letter_absent"
}

internal fun wordleKeyStateResource(state: WordleKeyState): String? = when (state) {
    WordleKeyState.unused -> null
    WordleKeyState.correct -> "gm_wordle_letter_correct"
    WordleKeyState.present -> "gm_wordle_letter_present"
    WordleKeyState.absent -> "gm_wordle_letter_absent"
}

internal fun wordleOutcomeResource(outcome: WordleOutcome): String? = when (outcome) {
    WordleOutcome.none -> null
    WordleOutcome.solved -> "gm_wordle_solved"
    WordleOutcome.outOfTries -> "gm_wordle_out_of_tries"
    WordleOutcome.timedOut -> "gm_wordle_time_ran_out"
}

internal fun wordleStatusResource(status: WordleStandingStatus, tries: Int): String = when (status) {
    WordleStandingStatus.solved -> "gm_wordle_solved_in"
    WordleStandingStatus.outOfTries -> "gm_wordle_out_of_tries"
    WordleStandingStatus.timedOut -> "gm_wordle_timed_out"
    WordleStandingStatus.playing -> if (tries > 0) "gm_wordle_tries" else "gm_wordle_playing"
}

internal fun wordleTitleResource(phase: WordlePhase, hasRounds: Boolean, isFinal: Boolean): String = when (phase) {
    WordlePhase.lobby -> ""
    WordlePhase.setWord -> if (hasRounds) "gm_wordle_set_round" else "gm_wordle_set"
    WordlePhase.playing -> if (hasRounds) "gm_wordle_guess_round" else "gm_wordle_guess"
    WordlePhase.results -> if (isFinal) "gm_wordle_final" else "gm_wordle_round_results"
}

internal fun wordleRoleNoteResource(role: WordleRole): String? = when (role) {
    WordleRole.guesser -> null
    WordleRole.setter -> "gm_wordle_setter_watching"
    WordleRole.spectator -> "gm_err_not_seated"
}

@Composable
private fun wordleTitle(scene: WordleScene, isFinished: Boolean): String {
    val hasRounds = scene.roundTotal > 1 && scene.round > 0
    val name = wordleTitleResource(scene.phase, hasRounds, isFinished || scene.isFinalRound)
    return when {
        name.isEmpty() -> ""
        name == "gm_wordle_set_round" || name == "gm_wordle_guess_round" -> conclaveString(name, scene.round, scene.roundTotal)
        name == "gm_wordle_round_results" -> conclaveString(name, scene.round)
        else -> conclaveString(name)
    }
}

@Composable
private fun wordleChoosing(setterName: String): String =
    if (setterName.isEmpty()) conclaveString("gm_wordle_waiting_word") else conclaveString("gm_wordle_choosing", setterName)

@Composable
private fun wordleWinner(scene: WordleScene): String =
    if (scene.winnerName.isEmpty()) conclaveString("gm_wordle_nobody") else conclaveString("gm_wordle_winner", scene.winnerName)

@Composable
private fun wordleStatus(status: WordleStandingStatus, tries: Int): String {
    val name = wordleStatusResource(status, tries)
    return when (name) {
        "gm_wordle_solved_in" -> conclaveString(name, conclavePlural("gm_wordle_tries", tries, tries))
        "gm_wordle_tries" -> conclavePlural(name, tries, tries)
        else -> conclaveString(name)
    }
}

@Composable
private fun wordleKeyLabel(letterKey: WordleKeyModel): String {
    val name = wordleKeyStateResource(letterKey.state) ?: return letterKey.letter
    return conclaveString(name, letterKey.letter)
}

@Composable
private fun wordleCellLabel(cell: WordleCellModel): String {
    if (cell.letter.isEmpty()) return ""
    val name = wordleCellStateResource(cell.state) ?: return cell.letter
    return conclaveString(name, cell.letter)
}

@Composable
private fun wordleRowSummary(row: WordleRowModel): String {
    val parts = mutableListOf<String>()
    for (cell in row.cells) {
        val label = wordleCellLabel(cell)
        if (label.isNotEmpty()) parts.add(label)
    }
    if (parts.isEmpty()) return conclaveString("gm_wordle_row_empty", row.index + 1)
    return conclaveString("gm_wordle_row", row.index + 1, parts.joinToString(", "))
}
